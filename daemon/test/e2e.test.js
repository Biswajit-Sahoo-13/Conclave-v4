'use strict';
// End-to-end: real HTTP daemon + a scripted fake "extension" that polls
// /agent/poll and answers commands. No Chrome needed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../server.js');

const ROSTER = [
  { tabId: 1, site: 'chat.qwen.ai', name: 'Qwen', role: 'debater' },
  { tabId: 2, site: 'chat.z.ai', name: 'GLM', role: 'debater' },
  { tabId: 3, site: 'gemini.google.com', name: 'Gemini', role: 'judge' },
  { tabId: 4, site: 'chatgpt.com', name: 'ChatGPT', role: 'judge' }
];

function fakeTabAnswer(site, prompt) {
  if (/decide whether its core approach|one line per model/i.test(prompt)) {
    return 'Qwen: AGREE\nGLM: AGREE'; // converge immediately
  }
  if (/referee of an ongoing multi-model debate/i.test(prompt)) {
    return 'ESTABLISHED: all agree\nDISPUTED: none\nUNRESOLVED: none';
  }
  if (/You are the judge of a multi-model debate/i.test(prompt)) {
    return [
      '## VERDICT', 'Build it as a CLI first.', '',
      '## AGREED POINTS', '- start small', '',
      '## DISAGREEMENTS RESOLVED', '- language -> Node.js + zero deps', '',
      '## REJECTED IDEAS', '- microservices', '',
      '## FRAMEWORK', 'single daemon, sqlite, mcp', '',
      '## FLOWCHART', '```mermaid\nflowchart TD\nA-->B\n```', '',
      '## OPEN QUESTIONS', '- packaging?'
    ].join('\n');
  }
  if (/CHIEF judge/i.test(prompt)) {
    return [
      '## VERDICT', 'merged final', '',
      '## DISAGREEMENTS RESOLVED', '- language -> Node.js + zero deps', '',
      '## REJECTED IDEAS', '- microservices', '',
      '## FRAMEWORK', 'final framework', '',
      '## FLOWCHART', '```mermaid\nflowchart TD\nA-->B\n```', '',
      '## OPEN QUESTIONS', '- packaging?', '',
      '## JUDGE DISAGREEMENTS RESOLVED', '- tone -> concise'
    ].join('\n');
  }
  return 'Sensible answer. Why needed: core feature. CONFIDENCE: 90%';
}

async function j(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

test('e2e: MCP ask_council through the full loop', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const inst = await startServer({ dbPath: path.join(dir, 'council.db') });
  t.after(() => inst.close());

  // set project with a real root folder so framework.md gets written
  await j(`http://127.0.0.1:${inst.port}/api/project`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'e2e', rootPath: path.join(dir, 'proj') })
  });

  // fake extension: continuously answer commands
  let stop = false;
  const poller = (async () => {
    while (!stop) {
      let res;
      try { res = await j(`http://127.0.0.1:${inst.port}/agent/poll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'fake-ext', roster: ROSTER })
      }); } catch (_) { break; }
      if (res && res.command) {
        await j(`http://127.0.0.1:${inst.port}/agent/result`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callId: res.command.callId, ok: true,
            text: fakeTabAnswer(res.command.site, res.command.prompt)
          })
        });
      } else {
        await new Promise(r => setTimeout(r, 5));
      }
    }
  })();
  t.after(() => { stop = true; });

  // MCP handshake + tool call
  const init = await j(`http://127.0.0.1:${inst.port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.strictEqual(init.result.serverInfo.name, 'ai-council');
  const tools = await j(`http://127.0.0.1:${inst.port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  });
  assert.strictEqual(tools.result.tools.length, 5);

  const called = await j(`http://127.0.0.1:${inst.port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'ask_council', arguments: { question: 'Design a CLI tool', kind: 'framework' } }
    })
  });
  // ask_council is now an async job: returns session_id, poll get_session
  const started = called.result.content[0].text;
  const sessionId = parseInt((started.match(/session_id: (\d+)/) || [])[1], 10);
  assert.ok(sessionId >= 1, 'ask_council returned a session id');

  let verdictText = '';
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 25));
    const poll = await j(`http://127.0.0.1:${inst.port}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100 + i, method: 'tools/call',
        params: { name: 'get_session', arguments: { session_id: sessionId } } })
    });
    const state = JSON.parse(poll.result.content[0].text);
    if (state.status === 'done') { verdictText = state.verdict; break; }
    assert.strictEqual(state.status, 'running', `unexpected status ${state.status}`);
  }
  assert.ok(verdictText.includes('merged final'), 'meta verdict returned via get_session');

  // framework.md written into the project root
  const fw = path.join(dir, 'proj', 'framework.md');
  assert.ok(fs.existsSync(fw), 'framework.md written');
  assert.ok(fs.readFileSync(fw, 'utf8').includes('merged final'));

  // drive-by defense: web origins are rejected, wrong Host is rejected
  const evil = await fetch(`http://127.0.0.1:${inst.port}/agent/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', 'Origin': 'https://evil.example' },
    body: JSON.stringify({ agentId: 'evil', roster: [{ site: 'x', role: 'debater' }] })
  });
  assert.strictEqual(evil.status, 403, 'cross-origin browser request blocked');

  // Brain captured decisions + open questions from the verdict
  const state = await j(`http://127.0.0.1:${inst.port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'get_project_state', arguments: {} } })
  });
  const stateObj = JSON.parse(state.result.content[0].text);
  assert.ok(stateObj.decisions.some(d => d.decision === 'Node.js + zero deps'));
  assert.ok(stateObj.open_questions.some(q => q.question === 'packaging?'));

  // feedback trains judge weights
  const fb = await j(`http://127.0.0.1:${inst.port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'submit_feedback', arguments: { session_id: sessionId, accepted: true } } })
  });
  assert.ok(fb.result.content[0].text.includes('feedback recorded'));

  const sessions = await j(`http://127.0.0.1:${inst.port}/api/sessions?limit=5`, { method: 'GET' });
  assert.strictEqual(sessions.sessions[0].status, 'done');
});

test('e2e: ask_council errors clearly when extension is absent', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const inst = await startServer({ dbPath: path.join(dir, 'council.db') });
  t.after(() => inst.close());

  // no /agent/poll ever happens -> roster empty
  const err = await j(`http://127.0.0.1:${inst.port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'ask_council', arguments: { question: 'x' } } })
  });
  assert.ok(err.error.message.includes('open Chrome'));
});

test('e2e: record_issue with debate resolves the issue', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  const inst = await startServer({ dbPath: path.join(dir, 'council.db') });
  t.after(() => inst.close());

  let stop = false;
  const poller = (async () => {
    while (!stop) {
      let res;
      try { res = await j(`http://127.0.0.1:${inst.port}/agent/poll`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'fake-ext', roster: ROSTER })
      }); } catch (_) { break; }
      if (res && res.command) {
        await j(`http://127.0.0.1:${inst.port}/agent/result`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            callId: res.command.callId, ok: true,
            text: fakeTabAnswer(res.command.site, res.command.prompt)
          })
        });
      } else {
        await new Promise(r => setTimeout(r, 5));
      }
    }
  })();
  t.after(() => { stop = true; });

  const res = await j(`http://127.0.0.1:${inst.port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'record_issue',
        arguments: { title: 'build fails', error: 'ENOENT', debate: true } } })
  });
  assert.ok(res.result.content[0].text.includes('resolved by session'));
});
