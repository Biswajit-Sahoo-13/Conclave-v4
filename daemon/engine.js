'use strict';
// Adaptive debate engine: routing modes (conservative / balanced /
// aggressive), judge ensembles (single / synthesis / panel / weighted),
// session persistence in the Brain. Transport-agnostic: callModel is
// injected (real: extension tab commands; tests: fake-browser).

const P = require('../prompts.js');

const THRESHOLDS = {
  SKIP_CONFIDENCE: 0.75,   // balanced/aggressive: unanimous + avg >= this -> judge now
  LOW_CONFIDENCE: 0.60,    // aggressive: avg below this after cap -> extend rounds
  EXTRA_ROUNDS: 2,         // aggressive: max rounds beyond the planned cap
  RETRIES: 1               // per model call, matches extension behavior
};

// ---------- parsing ----------

function parseConfidence(text) {
  const tail = String(text || '').slice(-400);
  const m = tail.match(/CONFIDENCE:\s*(\d{1,3})\s*%/i);
  if (!m) return null;
  return Math.min(100, Math.max(0, parseInt(m[1], 10))) / 100;
}

// Referee output like "Qwen: AGREE\nGLM (adversary): DISAGREE" -> per-model map.
// Role suffixes in parentheses are tolerated (transcripts label adversaries).
function parseModelAgreement(refereeText, debaters) {
  const perModel = {};
  let sawAny = false;
  for (const d of debaters) {
    const re = new RegExp(d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      '(?:\\s*\\([^)]*\\))?\\s*:\\s*(AGREE|DISAGREE)\\b', 'i');
    const m = String(refereeText || '').match(re);
    perModel[d.name] = m ? m[1].toUpperCase() : null;
    if (m) sawAny = true;
  }
  const statuses = Object.values(perModel).filter(Boolean);
  return {
    perModel,
    groupAgree: sawAny && statuses.length > 0 && statuses.every(s => s === 'AGREE')
  };
}

function avgConfidence(answers, debaters) {
  const vals = debaters
    .map(d => answers[d.tabId] && answers[d.tabId].confidence)
    .filter(v => typeof v === 'number');
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// The biggest outlier: largest confidence gap to the group median,
// tie broken by lower confidence. Falls back to round-robin index.
function pickOutlier(debaters, answers, roundIdx) {
  const confs = debaters
    .map(d => answers[d.tabId] && answers[d.tabId].confidence)
    .map(c => (typeof c === 'number' ? c : 0))
    .sort((a, b) => a - b);
  const median = confs.length
    ? (confs.length % 2 ? confs[(confs.length - 1) / 2] : (confs[confs.length / 2 - 1] + confs[confs.length / 2]) / 2)
    : null;
  let bestIdx = -1, bestGap = -1;
  debaters.forEach((d, i) => {
    const c = (answers[d.tabId] && typeof answers[d.tabId].confidence === 'number')
      ? answers[d.tabId].confidence : 0;
    // ties (e.g. always with two models) go to the lower-confidence model
    const gap = Math.abs(c - median) + (1 - c) * 0.001;
    if (gap > bestGap) { bestGap = gap; bestIdx = i; }
  });
  return bestIdx >= 0 ? bestIdx : roundIdx % debaters.length;
}

// ---------- engine ----------

async function runSession(brain, callModel, cfg) {
  // cfg: { projectId, kind, idea, routingMode, judgeMode, maxRounds,
  //        debaters, judges, sessionId? (pre-created for async job starts) }
  const sessionId = cfg.sessionId ||
    brain.createSession(cfg.projectId, cfg.kind, cfg.idea, cfg.routingMode, cfg.judgeMode, cfg.maxRounds);

  const ask = async (role, entry, prompt) => {
    let lastErr;
    for (let i = 0; i <= THRESHOLDS.RETRIES; i++) {
      try {
        const text = await callModel(role, entry, prompt);
        if (!text || !text.trim()) throw new Error('empty response');
        return text;
      } catch (e) {
        lastErr = e;
        if (i < THRESHOLDS.RETRIES) await new Promise(r => setTimeout(r, 100)); // tests: no 5s wait
      }
    }
    throw new Error(`${entry.name} (${role}): ${lastErr && lastErr.message}`);
  };

  try {
    const debaters = cfg.debaters.map(d => ({ ...d }));
    const judges = cfg.judges.map(j => ({ ...j }));
    const chief = judges[0];
    if (!chief) throw new Error('no judge in roster');

    const answers = {}; // tabId -> { text, confidence }
    const planned = cfg.maxRounds || 3;
    const totalCap = planned + (cfg.routingMode === 'aggressive' ? THRESHOLDS.EXTRA_ROUNDS : 0);

    let roundsUsed = 0;
    let agreement = null;

    for (let roundIdx = 1; roundIdx <= totalCap; roundIdx++) {
      // balanced/aggressive: skip remaining rounds when converged
      // (conservative always runs the full plan)
      if (roundIdx > 1 && cfg.routingMode !== 'conservative' && agreement &&
          agreement.groupAgree &&
          avgConfidence(answers, debaters) >= THRESHOLDS.SKIP_CONFIDENCE) {
        break;
      }
      // aggressive: extension rounds only justified while confidence is low
      if (roundIdx > planned && avgConfidence(answers, debaters) >= THRESHOLDS.LOW_CONFIDENCE) {
        break;
      }

      // who answers this round
      let askers;
      if (roundIdx === 1 || cfg.routingMode === 'conservative') {
        askers = debaters;
      } else {
        askers = debaters.filter(d => {
          const a = answers[d.tabId];
          const st = agreement && agreement.perModel[d.name];
          return !a || st === 'DISAGREE' ||
            (a.confidence !== null && a.confidence < THRESHOLDS.SKIP_CONFIDENCE);
        });
        if (!askers.length) askers = debaters; // nothing targeted: full round
      }

      // adversary assignment
      debaters.forEach(d => { d.adversarial = false; });
      if (debaters.length >= 2) {
        let advIdx;
        if (cfg.routingMode === 'conservative' || !agreement) {
          advIdx = (roundIdx - 1) % debaters.length;
        } else {
          advIdx = pickOutlier(debaters, answers, roundIdx - 1);
        }
        debaters[advIdx].adversarial = true;
      }

      const extraAngle = roundIdx > planned;

      for (const d of askers) {
        let prompt;
        if (roundIdx === 1) {
          prompt = cfg.idea;
        } else if (extraAngle) {
          prompt = ATTACK_ANGLE(d, answers, debaters);
        } else {
          prompt = P.buildDebatePrompt(roundIdx, cfg.idea,
            P.othersBlock(debaters, mapTexts(answers), d.tabId, answers.__digest), d.adversarial);
        }
        const text = await ask(d.adversarial ? 'adversary' : 'debater', d, prompt);
        answers[d.tabId] = { text, confidence: parseConfidence(text) };
        brain.insertMessage(sessionId, roundIdx, d.name,
          d.adversarial ? 'adversary' : 'debater', text, answers[d.tabId].confidence);
      }
      roundsUsed = roundIdx;

      // referee digest + per-model agreement (needed for routing decisions)
      if (roundIdx < totalCap) {
        const transcript = P.judgeTranscript(debaters, mapTexts(answers));
        const digest = await ask('digest', chief, P.ROUND_DIGEST_PROMPT + transcript);
        brain.insertMessage(sessionId, roundIdx, chief.name, 'digest', digest, null);
        const refText = await ask('referee', chief, P.MODEL_AGREEMENT_PROMPT + transcript);
        brain.insertMessage(sessionId, roundIdx, chief.name, 'referee', refText, null);
        agreement = parseModelAgreement(refText, debaters);
        // digest replaces older context; latest answers stay in othersBlock
        answers.__digest = digest;
      }
    }

    // ---------- judge ensemble ----------
    const transcript = P.judgeTranscript(debaters, mapTexts(answers));
    const userIdeaBlock = `The user's original idea was:\n${cfg.idea}\n\n`;
    const verdict = await judgeEnsemble(cfg.judgeMode, judges, chief, brain,
      userIdeaBlock, transcript, ask, sessionId);
    brain.insertMessage(sessionId, roundsUsed, chief.name, 'meta', verdict, null);

    brain.recordDebateParticipation(debaters.map(d => d.name));
    brain.finishSession(sessionId, verdict, roundsUsed);
    extractAndStore(brain, cfg.projectId, sessionId, verdict);

    return { sessionId, verdict, roundsUsed };
  } catch (e) {
    brain.failSession(sessionId, e.message);
    throw e;
  }
}

function mapTexts(answers) {
  const m = {};
  for (const [k, v] of Object.entries(answers)) if (k !== '__digest') m[k] = v.text;
  return m;
}

function ATTACK_ANGLE(d, answers, debaters) {
  const others = debaters
    .filter(o => o.tabId !== d.tabId && answers[o.tabId])
    .map(o => `--- Answer from ${o.name} ---\n${P.truncate(answers[o.tabId].text)}`)
    .join('\n\n');
  return P.ATTACK_ANGLE_PROMPT + others;
}

async function judgeEnsemble(mode, judges, chief, brain, userIdeaBlock, transcript, ask, sessionId) {
  const verdictOf = async (j) => {
    const v = await ask('judge', j, P.JUDGE_FINAL_PROMPT + userIdeaBlock + transcript);
    brain.insertMessage(sessionId, 0, j.name, 'judge', v, null);
    return v;
  };
  const mergeWith = async (prompt) => ask('meta', chief, prompt);

  if (mode === 'single' || judges.length === 1) {
    if (mode !== 'single') {
      // degradation, logged in session via a meta note prefix
      const v = await verdictOf(chief);
      return `[judge mode '${mode}' degraded to single — only one judge available]\n\n` + v;
    }
    return verdictOf(chief);
  }

  if (mode === 'synthesis') {
    const [v1, v2] = await Promise.all([verdictOf(judges[0]), verdictOf(judges[1])]);
    return mergeWith(P.META_PROMPT +
      `===== VERDICT A — ${judges[0].name} =====\n${v1}\n\n` +
      `===== VERDICT B — ${judges[1].name} =====\n${v2}\n`);
  }

  // panel / weighted: every judge verdicts, chief merges
  const verdicts = [];
  for (const j of judges) verdicts.push({ judge: j, text: await verdictOf(j) });

  if (mode === 'panel') {
    return mergeWith(P.PANEL_MERGE_PROMPT + verdicts
      .map(v => `===== VERDICT — ${v.judge.name} =====\n${v.text}`).join('\n\n'));
  }

  // weighted
  const rated = brain.ratedVerdictCount();
  const parts = verdicts.map(v => {
    const w = brain.modelWeight(v.judge.name).toFixed(2);
    return `===== VERDICT — ${v.judge.name} (weight ${w}) =====\n${v.text}`;
  });
  const note = rated < 10
    ? `[weights still untrained — ${rated} rated verdicts so far, treated near-equally]\n\n`
    : '';
  return note + await mergeWith(P.WEIGHTED_MERGE_PROMPT + parts.join('\n\n'));
}

// Pull structured outcomes out of the verdict markdown into the Brain.
function extractAndStore(brain, projectId, sessionId, verdict) {
  const section = (name) => {
    const m = String(verdict).match(new RegExp('##\\s*' + name + '[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)', 'i'));
    return m ? m[1] : '';
  };
  for (const line of section('DISAGREEMENTS RESOLVED').split('\n')) {
    const m = line.match(/^\s*-\s*(.+?)\s*->\s*(.+)$/);
    if (m) {
      // the whole right-hand side is the decision — splitting on '+' would
      // mangle values like "Node.js + zero deps"; reasons live in the verdict
      brain.addDecision(projectId, sessionId, m[1].trim(), m[2].trim(),
        null, section('REJECTED IDEAS').trim());
    }
  }
  for (const line of section('OPEN QUESTIONS').split('\n')) {
    const m = line.match(/^\s*-\s*(.+)$/);
    if (m && m[1].trim() && !/^\.*$/.test(m[1].trim())) {
      brain.addOpenQuestion(projectId, m[1].trim());
    }
  }
}

module.exports = { runSession, parseConfidence, parseModelAgreement, pickOutlier, THRESHOLDS };
