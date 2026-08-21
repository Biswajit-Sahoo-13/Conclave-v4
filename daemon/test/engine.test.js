'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Brain } = require('../db.js');
const { runSession, parseConfidence, parseModelAgreement, pickOutlier } = require('../engine.js');
const { createFakeBrowser } = require('../fake-browser.js');

const DEBATERS = [
  { tabId: 1, name: 'Qwen', site: 'chat.qwen.ai' },
  { tabId: 2, name: 'GLM', site: 'chat.z.ai' }
];
const JUDGES = [
  { tabId: 3, name: 'Gemini', site: 'gemini.google.com' },
  { tabId: 4, name: 'ChatGPT', site: 'chatgpt.com' }
];

function baseCfg(over = {}) {
  return {
    projectId: 1, kind: 'framework', idea: 'Build X',
    routingMode: 'balanced', judgeMode: 'synthesis', maxRounds: 3,
    debaters: DEBATERS, judges: JUDGES, ...over
  };
}

// ---------- parsing ----------

test('parseConfidence finds value in tail', () => {
  assert.strictEqual(parseConfidence('stuff\nCONFIDENCE: 87%'), 0.87);
});
test('parseConfidence clamps >100', () => {
  assert.strictEqual(parseConfidence('CONFIDENCE: 150%'), 1);
});
test('parseConfidence returns null when absent', () => {
  assert.strictEqual(parseConfidence('no confidence stated'), null);
});
test('parseConfidence ignores values outside last 400 chars', () => {
  assert.strictEqual(parseConfidence('CONFIDENCE: 90%\n' + 'x'.repeat(500)), null);
});

test('parseModelAgreement maps statuses', () => {
  const r = parseModelAgreement('Qwen: AGREE\nGLM: DISAGREE', DEBATERS);
  assert.strictEqual(r.perModel.Qwen, 'AGREE');
  assert.strictEqual(r.perModel.GLM, 'DISAGREE');
  assert.strictEqual(r.groupAgree, false);
});
test('parseModelAgreement group agree', () => {
  const r = parseModelAgreement('Qwen: AGREE\nGLM: agree', DEBATERS);
  assert.strictEqual(r.groupAgree, true);
});

test('pickOutlier picks furthest from median', () => {
  const answers = { 1: { confidence: 0.9 }, 2: { confidence: 0.2 } };
  assert.strictEqual(pickOutlier(DEBATERS, answers, 0), 1); // GLM is the outlier
});

// ---------- routing ----------

test('balanced: unanimous high confidence skips to judging after round 1', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  const fb = createFakeBrowser((role, entry) => {
    if (role === 'referee') return 'Qwen: AGREE\nGLM: AGREE';
    if (role === 'meta') return '## VERDICT\nmerged\n## OPEN QUESTIONS\n- none listed';
    return `Answer from ${entry.name}. Why needed: core. CONFIDENCE: 90%`;
  });
  const r = await runSession(brain, fb.callModel, baseCfg());
  assert.strictEqual(r.roundsUsed, 1);
  // no round-2 debater prompts
  assert.strictEqual(fb.calls.filter(c => c.role === 'debater' || c.role === 'adversary').length, 2);
});

test('balanced: only disagreeing model is re-asked', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  const fb = createFakeBrowser((role, entry) => {
    if (role === 'referee') return 'Qwen: AGREE\nGLM: DISAGREE';
    if (role === 'meta') return '## VERDICT\nok';
    return `Answer from ${entry.name}. CONFIDENCE: ${entry.name === 'GLM' ? 50 : 90}%`;
  });
  const r = await runSession(brain, fb.callModel, baseCfg({ maxRounds: 2 }));
  // round 1: both; round 2: only GLM (disagree + low confidence)
  const glmDebates = fb.calls.filter(c => c.name === 'GLM' && (c.role === 'debater' || c.role === 'adversary'));
  const qwenDebates = fb.calls.filter(c => c.name === 'Qwen' && (c.role === 'debater' || c.role === 'adversary'));
  assert.strictEqual(glmDebates.length, 2);
  assert.strictEqual(qwenDebates.length, 1);
  assert.strictEqual(r.roundsUsed, 2);
});

test('conservative: full rounds regardless of agreement', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  const fb = createFakeBrowser((role, entry) => {
    if (role === 'referee') return 'Qwen: AGREE\nGLM: AGREE';
    if (role === 'meta') return '## VERDICT\nok';
    return `Answer. CONFIDENCE: 95%`;
  });
  const r = await runSession(brain, fb.callModel, baseCfg({ routingMode: 'conservative', maxRounds: 3 }));
  assert.strictEqual(r.roundsUsed, 3);
  assert.strictEqual(fb.calls.filter(c => c.role === 'debater' || c.role === 'adversary').length, 6);
});

test('aggressive: extends beyond cap while confidence is low, capped at +2', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  const fb = createFakeBrowser((role, entry) => {
    if (role === 'referee') return 'Qwen: DISAGREE\nGLM: DISAGREE';
    if (role === 'meta') return '## VERDICT\nok';
    return `Low-confidence answer. CONFIDENCE: 30%`;
  });
  const r = await runSession(brain, fb.callModel, baseCfg({ routingMode: 'aggressive', maxRounds: 2 }));
  assert.strictEqual(r.roundsUsed, 4); // 2 planned + 2 extra
});

test('aggressive: stops extending once confidence rises', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  let round = 0;
  const fb = createFakeBrowser((role, entry) => {
    if (role === 'referee') return 'Qwen: DISAGREE\nGLM: DISAGREE';
    if (role === 'meta') return '## VERDICT\nok';
    round++;
    // both low in round 1, high afterwards — engine should stop at planned cap
    return `Answer. CONFIDENCE: ${round <= 2 ? 30 : 90}%`;
  });
  const r = await runSession(brain, fb.callModel, baseCfg({ routingMode: 'aggressive', maxRounds: 2 }));
  assert.strictEqual(r.roundsUsed, 2);
});

// ---------- judges ----------

test('synthesis: two judges then meta merge', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  const fb = createFakeBrowser((role, entry) => {
    if (role === 'judge') return `## VERDICT\nfrom ${entry.name}`;
    if (role === 'meta') return '## VERDICT\nmerged-final\n## JUDGE DISAGREEMENTS RESOLVED\n- x -> y';
    if (role === 'referee') return 'Qwen: AGREE\nGLM: AGREE';
    return 'Answer. CONFIDENCE: 90%';
  });
  const r = await runSession(brain, fb.callModel, baseCfg());
  assert.ok(r.verdict.includes('merged-final'));
  assert.strictEqual(fb.calls.filter(c => c.role === 'judge').length, 2);
});

test('synthesis degrades to single with one judge', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  const fb = createFakeBrowser((role, entry) => {
    if (role === 'referee') return 'Qwen: AGREE\nGLM: AGREE';
    return 'Answer. CONFIDENCE: 90%';
  });
  const r = await runSession(brain, fb.callModel, baseCfg({ judges: [JUDGES[0]] }));
  assert.ok(r.verdict.includes('degraded to single'));
});

test('panel: all judges verdict, chief merges with votes', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  const fb = createFakeBrowser((role, entry) => {
    if (role === 'judge') return `## VERDICT\nfrom ${entry.name}`;
    if (role === 'meta') return '## VERDICT\npanel-merged (votes: 2 for, 1 against)';
    if (role === 'referee') return 'Qwen: AGREE\nGLM: AGREE';
    return 'Answer. CONFIDENCE: 90%';
  });
  const r = await runSession(brain, fb.callModel, baseCfg({ judgeMode: 'panel' }));
  assert.ok(r.verdict.includes('panel-merged'));
  assert.strictEqual(fb.calls.filter(c => c.role === 'judge').length, 2);
});

test('weighted: untrained note appears below 10 rated verdicts', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  brain.rateJudges(['Gemini'], true); // 1 rated verdict
  const fb = createFakeBrowser((role, entry) => {
    if (role === 'referee') return 'Qwen: AGREE\nGLM: AGREE';
    if (role === 'meta') return '## VERDICT\nweighted-merged';
    if (role === 'judge') return '## VERDICT\nv';
    return 'Answer. CONFIDENCE: 90%';
  });
  const r = await runSession(brain, fb.callModel, baseCfg({ judgeMode: 'weighted' }));
  assert.ok(r.verdict.includes('untrained'));
});

// ---------- persistence ----------

test('verdict sections are extracted into decisions and open questions', async () => {
  const brain = new Brain(':memory:');
  const project = brain.upsertProject('p', null);
  const fb = createFakeBrowser((role, entry) => {
    if (role === 'referee') return 'Qwen: AGREE\nGLM: AGREE';
    if (role === 'meta') return [
      '## VERDICT', 'final', '',
      '## DISAGREEMENTS RESOLVED',
      '- database -> PostgreSQL + relational fits the workload', '',
      '## REJECTED IDEAS', '- MongoDB', '',
      '## FRAMEWORK', '...', '',
      '## OPEN QUESTIONS', '- how to deploy?', '- auth provider?'
    ].join('\n');
    return 'Answer. CONFIDENCE: 90%';
  });
  const r = await runSession(brain, fb.callModel, baseCfg({ projectId: project.id }));
  const decisions = brain.decisionsForProject(project.id);
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].decision, 'PostgreSQL + relational fits the workload');
  const qs = brain.openQuestionsForProject(project.id);
  assert.strictEqual(qs.length, 2);
  const s = brain.getSession(r.sessionId);
  assert.strictEqual(s.status, 'done');
});

test('failed session is marked failed with error', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  const fb = createFakeBrowser(() => { throw new Error('boom'); });
  await assert.rejects(
    () => runSession(brain, fb.callModel, baseCfg()),
    /boom/
  );
  const s = brain.listSessions(1)[0];
  assert.strictEqual(s.status, 'failed');
});

test('model call retries once before failing', async () => {
  const brain = new Brain(':memory:');
  brain.upsertProject('p', null);
  let attempts = 0;
  const fb = createFakeBrowser(() => { attempts++; throw new Error('flaky'); });
  await assert.rejects(() => runSession(brain, fb.callModel, baseCfg()));
  // session aborts once the FIRST model exhausts its retry
  assert.strictEqual(attempts, 2);
});
