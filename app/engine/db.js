'use strict';
// Project Brain — real SQLite storage for the council daemon.
// Zero npm deps: node:sqlite (Node >= 22.5). Daemon is the only writer.

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  root_path TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  idea TEXT NOT NULL,
  routing_mode TEXT NOT NULL,
  judge_mode TEXT NOT NULL,
  rounds_planned INTEGER,
  rounds_used INTEGER,
  status TEXT NOT NULL DEFAULT 'running',
  verdict TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  round_idx INTEGER NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  confidence REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS decisions(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  session_id INTEGER REFERENCES sessions(id),
  topic TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT,
  rejected TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS open_questions(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by_session INTEGER
);
CREATE TABLE IF NOT EXISTS issues(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  error TEXT,
  context TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  confidence REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS model_stats(
  model TEXT PRIMARY KEY,
  debates INTEGER DEFAULT 0,
  judged INTEGER DEFAULT 0,
  accepted INTEGER DEFAULT 0,
  rejected INTEGER DEFAULT 0
);
`;

class Brain {
  constructor(dbPath) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA); // idempotent
  }

  close() { this.db.close(); }

  // ---- settings / projects ----

  getSetting(key) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  }
  setSetting(key, value) {
    this.db.prepare(
      'INSERT INTO settings(key, value) VALUES(?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, String(value));
  }

  upsertProject(name, rootPath) {
    this.db.prepare(
      'INSERT INTO projects(name, root_path) VALUES(?, ?) ' +
      'ON CONFLICT(name) DO UPDATE SET root_path = excluded.root_path'
    ).run(name, rootPath || null);
    return this.getProjectByName(name);
  }
  getProjectByName(name) {
    return this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) || null;
  }
  getProject(id) {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
  }

  // ---- sessions / messages ----

  createSession(projectId, kind, idea, routingMode, judgeMode, roundsPlanned) {
    const r = this.db.prepare(
      'INSERT INTO sessions(project_id, kind, idea, routing_mode, judge_mode, rounds_planned) ' +
      'VALUES(?, ?, ?, ?, ?, ?)'
    ).run(projectId, kind, idea, routingMode, judgeMode, roundsPlanned);
    return Number(r.lastInsertRowid);
  }
  finishSession(id, verdict, roundsUsed) {
    this.db.prepare(
      "UPDATE sessions SET status='done', verdict=?, rounds_used=?, " +
      "finished_at=datetime('now') WHERE id=?"
    ).run(verdict, roundsUsed, id);
  }
  failSession(id, error) {
    this.db.prepare(
      "UPDATE sessions SET status='failed', error=?, finished_at=datetime('now') WHERE id=?"
    ).run(String(error).slice(0, 500), id);
  }
  getSession(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null;
  }
  listSessions(limit = 5) {
    return this.db.prepare(
      'SELECT id, kind, status, routing_mode, judge_mode, rounds_used, created_at, ' +
      'substr(idea, 1, 80) AS idea_preview FROM sessions ORDER BY id DESC LIMIT ?'
    ).all(limit);
  }
  insertMessage(sessionId, roundIdx, model, role, text, confidence) {
    const r = this.db.prepare(
      'INSERT INTO messages(session_id, round_idx, model, role, text, confidence) ' +
      'VALUES(?, ?, ?, ?, ?, ?)'
    ).run(sessionId, roundIdx, model, role, text, confidence);
    return Number(r.lastInsertRowid);
  }
  messagesForSession(sessionId) {
    return this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id'
    ).all(sessionId);
  }

  // ---- decisions / questions / issues ----

  addDecision(projectId, sessionId, topic, decision, reason, rejected) {
    const r = this.db.prepare(
      'INSERT INTO decisions(project_id, session_id, topic, decision, reason, rejected) ' +
      'VALUES(?, ?, ?, ?, ?, ?)'
    ).run(projectId, sessionId, topic, decision, reason || null, rejected || null);
    return Number(r.lastInsertRowid);
  }
  decisionsForProject(projectId) {
    return this.db.prepare(
      'SELECT * FROM decisions WHERE project_id = ? ORDER BY id DESC'
    ).all(projectId);
  }
  addOpenQuestion(projectId, question) {
    const r = this.db.prepare(
      'INSERT INTO open_questions(project_id, question) VALUES(?, ?)'
    ).run(projectId, question);
    return Number(r.lastInsertRowid);
  }
  openQuestionsForProject(projectId) {
    return this.db.prepare(
      "SELECT * FROM open_questions WHERE project_id = ? AND status = 'open' ORDER BY id DESC"
    ).all(projectId);
  }

  createIssue(projectId, title, error, context) {
    const r = this.db.prepare(
      'INSERT INTO issues(project_id, title, error, context) VALUES(?, ?, ?, ?)'
    ).run(projectId, title, error || null, context || null);
    return Number(r.lastInsertRowid);
  }
  resolveIssue(issueId, resolution, confidence) {
    this.db.prepare(
      "UPDATE issues SET status='resolved', resolution=?, confidence=? WHERE id=?"
    ).run(resolution, confidence, issueId);
  }
  getIssue(issueId) {
    return this.db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId) || null;
  }

  // ---- model stats (judge reliability) ----

  getStats(model) {
    return this.db.prepare('SELECT * FROM model_stats WHERE model = ?').get(model) || null;
  }
  _touchModel(model) {
    this.db.prepare('INSERT OR IGNORE INTO model_stats(model) VALUES(?)').run(model);
  }
  recordDebateParticipation(models) {
    const u = this.db.prepare('UPDATE model_stats SET debates = debates + 1 WHERE model = ?');
    for (const m of models) { this._touchModel(m); u.run(m); }
  }
  rateJudges(models, accepted) {
    const u = this.db.prepare(
      'UPDATE model_stats SET judged = judged + 1, ' +
      (accepted ? 'accepted = accepted + 1' : 'rejected = rejected + 1') +
      ' WHERE model = ?'
    );
    for (const m of models) { this._touchModel(m); u.run(m); }
  }
  // weight = share of accepted verdicts; 1.0 until first rating exists
  modelWeight(model) {
    const s = this.getStats(model);
    if (!s || !s.judged) return 1.0;
    return s.accepted / s.judged;
  }
  ratedVerdictCount() {
    const r = this.db.prepare('SELECT COALESCE(SUM(judged), 0) AS n FROM model_stats').get();
    return r ? r.n : 0;
  }
}

module.exports = { Brain };
