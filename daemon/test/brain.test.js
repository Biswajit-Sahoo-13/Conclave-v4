'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Brain } = require('../db.js');

test('schema is idempotent (reopen same file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
  const dbPath = path.join(dir, 'council.db');
  const b1 = new Brain(dbPath);
  b1.upsertProject('proj', 'C:/x');
  b1.close();
  const b2 = new Brain(dbPath); // must not throw on existing schema
  const p = b2.getProjectByName('proj');
  assert.ok(p && p.root_path === 'C:/x');
  b2.close();
});

test('settings roundtrip', () => {
  const b = new Brain(':memory:');
  b.setSetting('active_project', 'demo');
  b.setSetting('active_project', 'demo2'); // upsert
  assert.strictEqual(b.getSetting('active_project'), 'demo2');
});

test('project upsert updates root_path', () => {
  const b = new Brain(':memory:');
  b.upsertProject('a', 'C:/one');
  b.upsertProject('a', 'C:/two');
  assert.strictEqual(b.getProjectByName('a').root_path, 'C:/two');
});

test('session lifecycle + messages', () => {
  const b = new Brain(':memory:');
  const p = b.upsertProject('p', null);
  const sid = b.createSession(p.id, 'framework', 'idea', 'balanced', 'synthesis', 3);
  b.insertMessage(sid, 1, 'Qwen', 'debater', 'text1', 0.9);
  b.insertMessage(sid, 1, 'GLM', 'adversary', 'text2', 0.4);
  b.finishSession(sid, 'final verdict', 2);
  const s = b.getSession(sid);
  assert.strictEqual(s.status, 'done');
  assert.strictEqual(s.rounds_used, 2);
  assert.strictEqual(s.verdict, 'final verdict');
  const msgs = b.messagesForSession(sid);
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[1].confidence, 0.4);
});

test('failSession stores error', () => {
  const b = new Brain(':memory:');
  const p = b.upsertProject('p', null);
  const sid = b.createSession(p.id, 'question', 'q', 'balanced', 'single', 3);
  b.failSession(sid, 'timeout');
  assert.strictEqual(b.getSession(sid).status, 'failed');
  assert.ok(b.getSession(sid).error.includes('timeout'));
});

test('decisions and open questions per project', () => {
  const b = new Brain(':memory:');
  const p = b.upsertProject('p', null);
  const sid = b.createSession(p.id, 'framework', 'i', 'balanced', 'single', 3);
  b.addDecision(p.id, sid, 'db', 'PostgreSQL', 'relational', 'MongoDB');
  b.addOpenQuestion(p.id, 'deploy how?');
  assert.strictEqual(b.decisionsForProject(p.id)[0].decision, 'PostgreSQL');
  assert.strictEqual(b.openQuestionsForProject(p.id).length, 1);
});

test('issues lifecycle', () => {
  const b = new Brain(':memory:');
  const p = b.upsertProject('p', null);
  const id = b.createIssue(p.id, 'ONNX fail', 'RuntimeError', 'export step');
  b.resolveIssue(id, 'use opset 17', 0.87);
  const issue = b.getIssue(id);
  assert.strictEqual(issue.status, 'resolved');
  assert.strictEqual(issue.confidence, 0.87);
});

test('model stats: rates, weights, cold start', () => {
  const b = new Brain(':memory:');
  assert.strictEqual(b.modelWeight('Gemini'), 1.0); // never judged
  b.rateJudges(['Gemini'], true);
  b.rateJudges(['Gemini'], true);
  b.rateJudges(['Gemini'], false);
  assert.strictEqual(b.modelWeight('Gemini').toFixed(3), (2 / 3).toFixed(3));
  assert.strictEqual(b.ratedVerdictCount(), 3);
  b.recordDebateParticipation(['Qwen', 'GLM']);
  assert.strictEqual(b.getStats('Qwen').debates, 1);
});

test('listSessions returns newest first with preview', () => {
  const b = new Brain(':memory:');
  const p = b.upsertProject('p', null);
  const s1 = b.createSession(p.id, 'framework', 'x'.repeat(200), 'balanced', 'single', 3);
  const s2 = b.createSession(p.id, 'question', 'why fail', 'balanced', 'single', 3);
  const list = b.listSessions(5);
  assert.strictEqual(list[0].id, s2);
  assert.ok(list[1].idea_preview.length <= 80);
});
