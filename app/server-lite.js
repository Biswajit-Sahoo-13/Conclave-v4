'use strict';
// In-app HTTP server: MCP for Antigravity + a few API routes for the UI.
// Port of daemon/server.js with the extension AgentHub replaced by the
// in-app WebviewHub (drives the app's own <webview> chat tabs directly).

const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { runSession } = require('./engine/engine.js');
const { handleMcp } = require('./engine/mcp.js');

class WebviewHub {
  constructor() { this.roster = []; } // [{site, name, role, contentsId}]
  setRoster(r) { this.roster = r || []; }
  hasRoster() { return this.roster.some(r => r.role === 'debater'); }
  bindCallModel(runInWebview, timeoutMs = 300000) {
    return (role, entry, prompt) => {
      const r = this.roster.find(x => x.site === entry.site);
      if (!r) return Promise.reject(new Error(`no webview assigned for ${entry.name}`));
      return Promise.race([
        runInWebview(r.contentsId, entry.site, prompt, timeoutMs - 5000),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error(`timeout waiting for ${entry.name}`)), timeoutMs))
      ]);
    };
  }
}

function startServer({ port = 8765, brain, hub, askCouncil, startDebateJob }) {
  const activeProject = () => {
    const name = brain.getSetting('active_project') || 'default';
    return brain.getProjectByName(name) || brain.upsertProject(name, null);
  };
  const json = (res, code, body) => {
    const data = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 10e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
  });

  // Drive-by defense (same policy as the daemon): Host must be the literal
  // loopback address+port (kills DNS rebinding); cross-origin browser
  // requests must come from a chrome-extension:// origin. Local tools
  // (Antigravity's MCP client, curl) send no Origin header and pass.
  let boundPort = 0;
  const requestBlocked = (req) => {
    const host = String(req.headers.host || '');
    const allowed = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
    if (host && !allowed.has(host.toLowerCase())) return 'bad host';
    const origin = req.headers.origin;
    if (origin && !String(origin).startsWith('chrome-extension://')) return 'bad origin';
    return null;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const blocked = requestBlocked(req);
      if (blocked) return json(res, 403, { ok: false, error: `forbidden: ${blocked}` });
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/status') {
        return json(res, 200, { ok: true, roster: hub.roster, project: activeProject().name });
      }
      if (req.method === 'POST' && url.pathname === '/mcp') {
        const body = await readBody(req);
        const rpc = await handleMcp(body, { brain, askCouncil, startDebateJob, activeProject, hub });
        return json(res, 200, rpc);
      }
      if (req.method === 'POST' && url.pathname === '/api/project') {
        const b = await readBody(req);
        if (!b.name) return json(res, 400, { ok: false, error: 'name required' });
        const p = brain.upsertProject(b.name, b.rootPath || null);
        brain.setSetting('active_project', b.name);
        return json(res, 200, { ok: true, project: p });
      }
      if (req.method === 'POST' && url.pathname === '/api/prefs') {
        const b = await readBody(req);
        for (const k of ['routing_mode', 'judge_mode', 'max_rounds']) {
          const key = k === 'routing_mode' ? 'routingMode' : k === 'judge_mode' ? 'judgeMode' : 'maxRounds';
          if (b[key] !== undefined) brain.setSetting(k, String(b[key]));
        }
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/debate') {
        const b = await readBody(req);
        if (!b.question) return json(res, 400, { ok: false, error: 'question required' });
        const r = await askCouncil(b);
        return json(res, 200, { ok: true, ...r });
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        return json(res, 200, { ok: true, sessions: brain.listSessions(10) });
      }
      if (req.method === 'POST' && url.pathname === '/api/feedback') {
        const b = await readBody(req);
        const s = brain.getSession(b.sessionId);
        if (!s) return json(res, 404, { ok: false, error: 'session not found' });
        const judges = brain.messagesForSession(s.id)
          .filter(m => m.role === 'judge' || m.role === 'meta').map(m => m.model);
        brain.rateJudges([...new Set(judges)], !!b.accepted);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { ok: false, error: 'no such route' });
    } catch (e) {
      return json(res, 500, { ok: false, error: String(e && e.message || e) });
    }
  });

  return new Promise((resolve, reject) => {
    // surface listen failures (e.g. EADDRINUSE) through the promise instead
    // of leaking an unhandled 'error' event into the main process
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      boundPort = server.address().port;
      resolve({ server, port: boundPort, close: () => new Promise(r => server.close(r)) });
    });
  });
}

module.exports = { startServer, WebviewHub };
