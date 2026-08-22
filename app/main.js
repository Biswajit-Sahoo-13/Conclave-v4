'use strict';
// AI Council app — main process.
// Owns: the window + chat webviews, the SQLite Brain, the debate engine,
// the optional MCP/HTTP server, and the IPC bridge to the renderer panel.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Brain } = require('./engine/db.js');
const { runSession } = require('./engine/engine.js');
const { runInWebview } = require('./automation.js');
const { startServer, WebviewHub } = require('./server-lite.js');

const SITES = [
  { site: 'chat.qwen.ai', name: 'Qwen', url: 'https://chat.qwen.ai' },
  { site: 'chat.z.ai', name: 'GLM', url: 'https://chat.z.ai' },
  { site: 'gemini.google.com', name: 'Gemini', url: 'https://gemini.google.com' },
  { site: 'chatgpt.com', name: 'ChatGPT', url: 'https://chatgpt.com' },
  { site: 'claude.ai', name: 'Claude', url: 'https://claude.ai' }
];

let mainWindow = null;
let brain = null;
let hub = new WebviewHub();
let httpServer = null;
let running = false;

function brainPath() {
  return path.join(os.homedir(), '.ai-council', 'council-app.db');
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------- debate runner (IPC + HTTP share this) ----------

async function askCouncil({ question, context, kind, routingMode, judgeMode, maxRounds }) {
  if (running) throw new Error('a debate is already running');
  if (!hub.hasRoster()) throw new Error('assign at least one Debater site in the app first');
  running = true;
  try {
    const project = activeProject();
    const roster = hub.roster;
    const debaters = roster.filter(r => r.role === 'debater').map(r => ({ tabId: r.site, name: r.name, site: r.site }));
    const judges = roster.filter(r => r.role === 'judge').map(r => ({ tabId: r.site, name: r.name, site: r.site }));
    if (!judges.length) throw new Error('assign a Judge site in the app first');

    const callModel = hub.bindCallModel(runInWebview, 300000);
    const emit = (line) => send('council:progress', line);
    const wrapped = (role, entry, prompt) => {
      emit(`Sending to ${entry.name}${role === 'adversary' ? ' (adversary)' : ''}...`);
      return callModel(role, entry, prompt).then(text => {
        emit(`${entry.name} answered (${text.length} chars).`);
        return text;
      });
    };

    const result = await runSession(brain, wrapped, {
      projectId: project.id,
      kind: kind === 'question' ? 'question' : 'framework',
      idea: context ? `${question}\n\nContext:\n${context}` : question,
      routingMode: routingMode || brain.getSetting('routing_mode') || 'balanced',
      judgeMode: judgeMode || brain.getSetting('judge_mode') || 'synthesis',
      maxRounds: parseInt(maxRounds || brain.getSetting('max_rounds') || '3', 10),
      debaters, judges
    });

    const session = brain.getSession(result.sessionId);
    let outFile = null;
    if (project.root_path) {
      try {
        const file = session.kind === 'question' ? 'resolution.md' : 'framework.md';
        outFile = path.join(project.root_path, file);
        fs.mkdirSync(project.root_path, { recursive: true });
        fs.writeFileSync(outFile, `# ${file}\n\n${result.verdict}\n`);
      } catch (_) { outFile = null; }
    }
    return { ...result, outFile };
  } finally {
    running = false;
  }
}

function activeProject() {
  const name = brain.getSetting('active_project') || 'default';
  return brain.getProjectByName(name) || brain.upsertProject(name, null);
}

// ---------- window ----------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 840,
    title: 'AI Council',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      webviewTag: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  brain = new Brain(brainPath());
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (httpServer) httpServer.close();
  app.quit();
});

// ---------- IPC ----------

ipcMain.handle('council:sites', () => SITES);

ipcMain.handle('council:setRoles', (_e, roster) => {
  hub.setRoster(roster || []);
  return { ok: true };
});

ipcMain.handle('council:run', async (_e, cfg) => {
  try {
    const r = await askCouncil(cfg);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('council:mcpToggle', async (_e, enabled) => {
  try {
    if (enabled && !httpServer) {
      httpServer = await startServer({ port: 8765, brain, hub, askCouncil });
      return { ok: true, port: httpServer.port };
    }
    if (!enabled && httpServer) {
      await httpServer.close();
      httpServer = null;
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});

ipcMain.handle('council:state', async () => {
  const project = activeProject();
  return {
    project: { name: project.name, rootPath: project.root_path },
    sessions: brain.listSessions(10),
    decisions: brain.decisionsForProject(project.id).slice(0, 10),
    openQuestions: brain.openQuestionsForProject(project.id).slice(0, 10)
  };
});

ipcMain.handle('council:saveProject', (_e, { name, rootPath }) => {
  const p = brain.upsertProject(name || 'default', rootPath || null);
  brain.setSetting('active_project', p.name);
  return { ok: true, project: p };
});

ipcMain.handle('council:feedback', (_e, { sessionId, accepted }) => {
  const s = brain.getSession(sessionId);
  if (!s) return { ok: false, error: 'session not found' };
  const judges = brain.messagesForSession(s.id)
    .filter(m => m.role === 'judge' || m.role === 'meta').map(m => m.model);
  brain.rateJudges([...new Set(judges)], !!accepted);
  return { ok: true };
});
