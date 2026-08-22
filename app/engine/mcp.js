'use strict';
// Minimal streamable-HTTP MCP endpoint (JSON-RPC 2.0 over POST /mcp).
// Single client (Antigravity) on localhost — no auth, no sessions.
// stdio clients use stdio-bridge.js to reach this endpoint.

const TOOLS = [
  {
    name: 'ask_council',
    description: 'Start a multi-model AI debate in the user\'s Chrome chat tabs ' +
      '(Qwen/GLM/Gemini/...). Returns immediately with a session_id — poll ' +
      'get_session until status is done/failed. Requires the AI Council ' +
      'extension to be armed in Chrome.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The idea or problem to debate' },
        context: { type: 'string', description: 'Optional extra context' },
        kind: { type: 'string', enum: ['framework', 'question'],
                description: 'framework = new project idea; question = bug/error diagnosis' }
      },
      required: ['question']
    }
  },
  {
    name: 'get_session',
    description: 'Poll a debate session started by ask_council. Returns status ' +
      '(running/done/failed), rounds used, and the verdict markdown when done.',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'number' } },
      required: ['session_id']
    }
  },
  {
    name: 'get_project_state',
    description: 'Read the Project Brain: durable decisions (with reasons and ' +
      'rejected alternatives), open questions, and recent verdicts.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'record_issue',
    description: 'Record a problem/error hit while building. Optionally run a ' +
      'council debate on it immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        error: { type: 'string', description: 'Error text / stack / logs' },
        context: { type: 'string' },
        debate: { type: 'boolean', description: 'Run ask_council on this issue now' }
      },
      required: ['title']
    }
  },
  {
    name: 'submit_feedback',
    description: 'Rate a past session verdict (accepted true/false). Trains ' +
      'judge reliability weights used by weighted-panel mode.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'number' },
        accepted: { type: 'boolean' }
      },
      required: ['session_id', 'accepted']
    }
  }
];

async function handleMcp(msg, ctx) {
  const { id, method, params } = msg || {};

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ai-council', version: '1.0.0' }
      }
    };
  }
  if (method === 'notifications/initialized') return null; // notification: no body
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const text = await dispatch(name, args, ctx);
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } };
    } catch (e) {
      return {
        jsonrpc: '2.0', id,
        error: { code: -32000, message: String(e && e.message || e), data: { tool: name } }
      };
    }
  }

  if (id !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } };
  }
  return null; // unknown notification
}

async function dispatch(name, args, ctx) {
  const { brain, askCouncil, startDebateJob, activeProject } = ctx;

  if (name === 'ask_council') {
    if (!args.question) throw new Error('question is required');
    if (!startDebateJob) throw new Error('async jobs not supported by this server');
    const r = await startDebateJob(args);
    return `debate started — session_id: ${r.sessionId}\n` +
      `poll get_session with session_id ${r.sessionId} until status is done or failed.`;
  }

  if (name === 'get_session') {
    const s = brain.getSession(args.session_id);
    if (!s) throw new Error(`session ${args.session_id} not found`);
    if (s.status === 'done') {
      return JSON.stringify({
        session_id: s.id, status: s.status, rounds_used: s.rounds_used,
        kind: s.kind, verdict: s.verdict
      }, null, 2);
    }
    return JSON.stringify({
      session_id: s.id, status: s.status, kind: s.kind,
      error: s.error || undefined
    }, null, 2);
  }

  if (name === 'get_project_state') {
    const project = activeProject();
    const state = {
      project: project.name,
      decisions: brain.decisionsForProject(project.id),
      open_questions: brain.openQuestionsForProject(project.id),
      recent_sessions: brain.listSessions(5)
    };
    return JSON.stringify(state, null, 2);
  }

  if (name === 'record_issue') {
    if (!args.title) throw new Error('title is required');
    const project = activeProject();
    const issueId = brain.createIssue(project.id, args.title, args.error, args.context);
    if (!args.debate) return `issue #${issueId} recorded (open)`;
    const r = await askCouncil({
      question: args.title,
      context: [args.error, args.context].filter(Boolean).join('\n\n') || undefined,
      kind: 'question'
    });
    const conf = (r.verdict.match(/CONFIDENCE:\s*(\d{1,3})\s*%/i) || [])[1];
    brain.resolveIssue(issueId, r.verdict.slice(0, 2000), conf ? conf / 100 : null);
    return `issue #${issueId} resolved by session ${r.sessionId}\n\n${r.verdict}`;
  }

  if (name === 'submit_feedback') {
    const s = brain.getSession(args.session_id);
    if (!s) throw new Error(`session ${args.session_id} not found`);
    const judgeModels = brain.messagesForSession(s.id)
      .filter(m => m.role === 'judge' || m.role === 'meta')
      .map(m => m.model);
    brain.rateJudges([...new Set(judgeModels)], !!args.accepted);
    return `feedback recorded for session ${s.id} (${judgeModels.join(', ') || 'no judges'})`;
  }

  throw new Error(`unknown tool: ${name}`);
}

module.exports = { handleMcp, TOOLS };
