'use strict';
// Council daemon HTTP server.
//   /agent/*  — the Chrome extension polls here for tab commands
//   /mcp      — streamable-HTTP MCP endpoint (Antigravity)
//   /api/*    — popup panel + manual testing
// Zero npm deps.

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Brain } = require('./db.js');
const { runSession } = require('./engine.js');
const { handleMcp, TOOLS } = require('./mcp.js');

const CALL_TIMEOUT_MS = 5 * 60 * 1000; // per model call (real chats stream slowly)

// Dispatches model calls to the extension: a command sits in `pending`
// until the extension's next /agent/poll picks it up; the extension posts
// the result to /agent/result which resolves the waiting call.
class AgentHub {
  constructor() {
    this.roster = [];        // [{tabId, site, name, role}] from the extension
    this.current = null;     // {command, resolve, reject, timer} — kept until settled
  }
  setRoster(roster) { this.roster = roster || []; }
  hasRoster() { return this.roster.some(r => r.role === 'debater'); }
  // The pending command stays in `current` until /agent/result settles it,
  // so the extension may re-poll without losing the in-flight call.
  takeCommand() {
    return this.current ? this.current.command : null;
  }
  settle(callId, result) {
    if (!this.current || this.current.command.callId !== callId) return false;
    clearTimeout(this.current.timer);
    const { resolve, reject } = this.current;
    this.current = null;
    if (result.ok) resolve(result.text);
    else reject(new Error(result.error || 'extension reported failure'));
    return true;
  }
  callModel(role, entry, prompt) {
    if (this.current) return Promise.reject(new Error('another model call is in flight'));
    if (!this.hasRoster()) {
      return Promise.reject(new Error(
        'open Chrome with the AI Council extension and arm Daemon mode (roster empty)'));
    }
    return new Promise((resolve, reject) => {
      const callId = crypto.randomUUID();
      const command = { op: 'send_and_wait', callId, role, site: entry.site, prompt };
      const clear = () => {
        if (this.current && this.current.command.callId === callId) this.current = null;
      };
      this.current = {
        command,
        resolve, reject,
        timer: setTimeout(() => {
          clear();
          reject(new Error(`timeout waiting for ${entry.name} (is Chrome open with the extension armed?)`));
        }, CALL_TIMEOUT_MS)
      };
    });
  }
}

function startServer({ port = 0, dbPath } = {}) {
  const brain = new Brain(dbPath ||
    path.join(os.homedir(), '.ai-council', 'council.db'));
  const hub = new AgentHub();
  const startedAt = Date.now();

  const activeProject = () => {
    const name = brain.getSetting('active_project') || 'default';
    return brain.getProjectByName(name) || brain.upsertProject(name, null);
  };

  const writeOutFile = (session, verdict) => {
    const project = brain.getProject(session.project_id);
    if (!project || !project.root_path) return null;
    const file = session.kind === 'question' ? 'resolution.md' : 'framework.md';
    try {
      fs.mkdirSync(project.root_path, { recursive: true });
      const target = path.join(project.root_path, file);
      fs.writeFileSync(target,
        `# ${file === 'framework.md' ? 'Project Framework' : 'Resolution'} — AI Council\n\n` +
        `- Session: ${session.id}  Rounds: ${session.rounds_used}\n` +
        `- Routing: ${session.routing_mode}  Judges: ${session.judge_mode}\n\n${verdict}\n`);
      return target;
    } catch (_) { return null; }
  };

  // ---- debate runner shared by MCP tools and /api/debate ----
  async function askCouncil({ question, context, kind, routingMode, judgeMode, maxRounds }) {
    if (!hub.hasRoster()) {
      throw new Error('open Chrome with the AI Council extension and arm Daemon mode (roster empty)');
    }
    const project = activeProject();
    const roster = hub.roster;
    const debaters = roster.filter(r => r.role === 'debater');
    const judges = roster.filter(r => r.role === 'judge');
    if (!judges.length) {
      throw new Error('no judge selected — check a Judge tab in the extension popup, then re-arm');
    }
    const idea = context ? `${question}\n\nContext:\n${context}` : question;
    const result = await runSession(brain, hub.callModel.bind(hub), {
      projectId: project.id,
      kind: kind === 'question' ? 'question' : 'framework',
      idea,
      routingMode: routingMode || brain.getSetting('routing_mode') || 'balanced',
      judgeMode: judgeMode || brain.getSetting('judge_mode') || 'synthesis',
      maxRounds: parseInt(maxRounds || brain.getSetting('max_rounds') || '3', 10),
      debaters, judges
    });
    const session = brain.getSession(result.sessionId);
    const outFile = writeOutFile(session, result.verdict);
    return { ...result, outFile, project };
  }

  const json = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 10e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, {
          ok: true, uptime_s: Math.floor((Date.now() - startedAt) / 1000),
          roster: hub.roster, project: activeProject().name,
          rated_verdicts: brain.ratedVerdictCount()
        });
      }

      if (req.method === 'POST' && url.pathname === '/agent/poll') {
        const body = await readBody(req);
        if (Array.isArray(body.roster)) hub.setRoster(body.roster);
        const command = hub.takeCommand();
        if (command) return json(res, 200, { command });
        res.writeHead(204); return res.end();
      }

      if (req.method === 'POST' && url.pathname === '/agent/result') {
        const body = await readBody(req); // {callId, ok, text?, error?}
        const settled = hub.settle(body.callId, body);
        return json(res, settled ? 200 : 409, { ok: settled });
      }

      if (req.method === 'POST' && url.pathname === '/mcp') {
        const body = await readBody(req);
        const rpc = await handleMcp(body, { brain, askCouncil, activeProject, hub });
        return json(res, 200, rpc);
      }

      if (req.method === 'POST' && url.pathname === '/api/project') {
        const b = await readBody(req); // {name, rootPath?}
        if (!b.name) return json(res, 400, { ok: false, error: 'name required' });
        const p = brain.upsertProject(b.name, b.rootPath || null);
        brain.setSetting('active_project', b.name);
        return json(res, 200, { ok: true, project: p });
      }

      if (req.method === 'POST' && url.pathname === '/api/prefs') {
        const b = await readBody(req); // {routingMode?, judgeMode?, maxRounds?}
        for (const k of ['routing_mode', 'judge_mode', 'max_rounds']) {
          const key = k === 'routing_mode' ? 'routingMode' : k === 'judge_mode' ? 'judgeMode' : 'maxRounds';
          if (b[key] !== undefined) brain.setSetting(k, String(b[key]));
        }
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/api/debate') {
        const b = await readBody(req); // {question, context?, kind?...}
        if (!b.question) return json(res, 400, { ok: false, error: 'question required' });
        const result = await askCouncil(b);
        return json(res, 200, { ok: true, ...result });
      }

      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const limit = parseInt(url.searchParams.get('limit') || '5', 10);
        return json(res, 200, { ok: true, sessions: brain.listSessions(limit) });
      }

      if (req.method === 'GET' && url.pathname === '/api/session') {
        const id = parseInt(url.searchParams.get('id'), 10);
        const s = brain.getSession(id);
        if (!s) return json(res, 404, { ok: false, error: 'not found' });
        return json(res, 200, { ok: true, session: s, messages: brain.messagesForSession(id) });
      }

      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const b = await readBody(req); // {sessionId, accepted}
        const s = brain.getSession(b.sessionId);
        if (!s) return json(res, 404, { ok: false, error: 'session not found' });
        const judgeModels = brain.messagesForSession(s.id)
          .filter(m => m.role === 'judge' || m.role === 'meta')
          .map(m => m.model);
        brain.rateJudges([...new Set(judgeModels)], !!b.accepted);
        return json(res, 200, { ok: true, rated_verdicts: brain.ratedVerdictCount() });
      }

      return json(res, 404, { ok: false, error: 'no such route' });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server, port: server.address().port, brain, hub,
        askCouncil, close: () => new Promise(r => server.close(r))
      });
    });
  });
}

module.exports = { startServer, AgentHub };

if (require.main === module) {
  startServer({ port: 8765 }).then(({ port }) => {
    console.log(`AI Council daemon listening on http://127.0.0.1:${port}`);
    console.log(`MCP endpoint: http://127.0.0.1:${port}/mcp   Brain: ~/.ai-council/council.db`);
  }).catch(e => { console.error(e); process.exit(1); });
}
