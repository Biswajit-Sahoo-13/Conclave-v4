// Background orchestrator: runs the debate loop across chat tabs.
//
// Flow:
//   1. Round 1: every debater tab receives the user's idea independently.
//   2. Rounds 2..N: each debater receives the referee digest of earlier
//      rounds + the other debaters' latest answers (capped for context
//      safety) and is asked to critique and revise.
//   3. Adversary mode: one debater per round is the attacker, and the
//      role ROTATES each round so no model settles into permanent
//      agreement.
//   4. Early stop (optional): the judge answers AGREE/DISAGREE after each
//      round; AGREE ends the debate.
//   5. Final: the judge tab receives all final answers and must produce a
//      structured framework verdict, which also lands in the judge's chat.
//   6. The verdict is saved via the Downloads API (semi-automation
//      handoff for Antigravity).

importScripts("prompts.js");

// ---------------- tab messaging ----------------

const lastTextByTab = {}; // tabId -> last successfully extracted text

function sendMessage(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, error: "no response from tab" });
      }
    });
  });
}

// Extract-before-resend: on failure, first try GET_LAST — if the model DID
// answer but extraction raced (selector drift, slow DOM), we accept the new
// text instead of typing the prompt a second time into the chat.
async function sendAndWait(tabId, prompt, timeoutMs, label, report) {
  const attempts = 2;
  for (let i = 1; i <= attempts; i++) {
    const res = await sendMessage(tabId, { type: "SEND_AND_WAIT", prompt, timeoutMs });
    if (res.ok) {
      lastTextByTab[tabId] = res.text;
      return res;
    }
    if (i < attempts) {
      const rescue = await sendMessage(tabId, { type: "GET_LAST" });
      if (rescue.ok && rescue.text && rescue.text !== lastTextByTab[tabId]) {
        report(`${label}: extraction recovered without re-sending the prompt.`);
        lastTextByTab[tabId] = rescue.text;
        return { ok: true, text: rescue.text };
      }
      report(`${label} failed (${res.error}) — retrying once in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    } else {
      throw new Error(`${label}: ${res.error}`);
    }
  }
}

// ---------------- debate engine ----------------

let running = false;

async function runDebate(config, outFile) {
  if (running) throw new Error("A debate is already running.");
  running = true;
  const log = [];
  const report = (line) => {
    log.push(line);
    chrome.runtime.sendMessage({ type: "PROGRESS", line, log }).catch(() => {});
  };

  try {
    const debaters = config.debaters;       // [{tabId, name}]
    const judge = config.judge;             // {tabId, name}
    const maxRounds = config.maxRounds || 3;
    const earlyStop = !!config.earlyStop;
    const digest = !!config.digest;

    const answers = {};   // tabId -> latest answer text
    let digestText = null;
    let stoppedEarly = 0;

    for (let round = 1; round <= maxRounds; round++) {
      report(`--- Round ${round}/${maxRounds} ---`);

      // adversary role rotates: debater index (round-1) mod count
      const adversaryIdx = adversarialIndex(config, round);

      for (let i = 0; i < debaters.length; i++) {
        const d = debaters[i];
        d.adversarial = i === adversaryIdx;
        const prompt = round === 1
          ? config.idea
          : buildDebatePrompt(round, config.idea,
              othersBlock(debaters, answers, d.tabId, digestText), d.adversarial);
        report(`Sending to ${d.name}${d.adversarial ? " (adversary)" : ""}...`);
        const res = await sendAndWait(d.tabId, prompt, config.timeoutMs, d.name, report);
        answers[d.tabId] = res.text;
        report(`${d.name} answered (${res.text.length} chars).`);
      }

      if (round < maxRounds) {
        if (earlyStop && await modelsAgree(config, judge, debaters, answers, report)) {
          stoppedEarly = round;
          report(`${judge.name} says AGREE — stopping early after round ${round}.`);
          break;
        }
        if (digest) {
          report(`Compressing round ${round} into a referee digest...`);
          const dig = await sendAndWait(judge.tabId,
            ROUND_DIGEST_PROMPT + judgeTranscript(debaters, answers),
            config.timeoutMs, "Digest", report);
          digestText = dig.text;
        }
      }
    }

    // Final judgment — the verdict is also written into the judge's own chat
    const userIdeaBlock = `The user's original idea was:\n${config.idea}\n\n`;
    report(`Requesting final framework from ${judge.name}...`);
    const verdict = await sendAndWait(judge.tabId,
      JUDGE_FINAL_PROMPT + userIdeaBlock + judgeTranscript(debaters, answers),
      config.timeoutMs, `Judge ${judge.name}`, report);

    const md = buildOutputMd(config, log, verdict.text, stoppedEarly);
    const downloadId = await saveFile(outFile || "framework.md", md);
    report(`Done. ${outFile || "framework.md"} saved to Downloads/ai-council/ (move it into your project for Antigravity).`);
    return { ok: true, log, verdict: verdict.text, downloadId };
  } finally {
    running = false;
  }
}

function adversarialIndex(config, round) {
  if (!config.adversarial || config.debaters.length < 2) return -1;
  return (round - 1) % config.debaters.length; // rotates each round
}

async function modelsAgree(config, judge, debaters, answers, report) {
  report(`Asking ${judge.name} if models agree...`);
  const res = await sendAndWait(judge.tabId,
    JUDGE_AGREE_PROMPT + judgeTranscript(debaters, answers),
    config.timeoutMs, "Agreement check", report);
  return res.ok && /^AGREE\b/i.test(res.text.trim());
}

function buildOutputMd(config, log, verdictText, stoppedEarly) {
  const stamp = new Date().toISOString().replace(":", "-");
  return (
    `# Project Framework — generated by Conclave\n\n` +
    `- Date: ${new Date().toISOString()}\n` +
    `- Debaters: ${config.debaters.map(d => d.name).join(", ")}\n` +
    `- Judge: ${config.judge.name}\n` +
    `- Rounds: ${config.maxRounds}${stoppedEarly ? ` (stopped early after ${stoppedEarly})` : ""}\n` +
    `- Adversary mode: ${config.adversarial ? "on (rotating)" : "off"}\n\n` +
    `## Original Idea\n\n${config.idea}\n\n` +
    `## Judge Verdict\n\n${verdictText}\n\n` +
    `---\n\n<!-- session: ${stamp} -->\n`
  );
}

function saveFile(filename, text) {
  return new Promise((resolve, reject) => {
    const dataUrl = "data:text/markdown;charset=utf-8," + encodeURIComponent(text);
    chrome.downloads.download(
      { url: dataUrl, filename: `ai-council/${filename}`, saveAs: false },
      (id) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(id))
    );
  });
}

// Re-run the debate on an Antigravity question: takes question/error text,
// debates it the same way, saves resolution.md with the judge's answer.
async function runQuestion(config) {
  return runDebate({
    ...config,
    idea:
      "A coding agent (Antigravity) hit this problem while building the project:\n\n" +
      config.idea +
      "\n\nDiagnose the root cause and propose the fix. Prefer the fix with " +
    "the strongest evidence and fewest assumptions."
  }, "resolution.md");
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START_DEBATE" || msg.type === "START_QUESTION") {
    if (agentInFlight) {
      sendResponse({ ok: false, error: "a daemon-driven command is using the chat tabs — try again when it finishes" });
      return false;
    }
    const run = msg.type === "START_DEBATE" ? runDebate : runQuestion;
    run(msg.config)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
});

// ============================================================
// Daemon agent: when armed, polls the local council daemon for
// tab commands (send prompt -> capture answer) and posts results
// back. The v0.2 local engine above is untouched and still works
// when the daemon is off.
// ============================================================

const DAEMON = "http://127.0.0.1:8765";
const AGENT_ID = "ext-" + Math.random().toString(36).slice(2, 10);
let agentRunning = false;
let agentInFlight = false; // a daemon-driven tab command is executing

async function getStored(key) {
  return new Promise((resolve) => chrome.storage.local.get(key, (o) => resolve(o[key])));
}

// Keep the daemon roster honest: when a chat tab closes, prune it so the
// daemon stops dispatching commands to dead tabs; if a replacement tab for
// the same site exists, rebind to it.
async function refreshRosterAfterTabLoss(closedTabId) {
  const roster = (await getStored("daemonRoster")) || [];
  if (!roster.some(r => r.tabId === closedTabId)) return;
  const next = [];
  for (const entry of roster) {
    if (entry.tabId === closedTabId) {
      const tabs = await chrome.tabs.query({ url: `https://${entry.site}/*` }).catch(() => []);
      const replacement = tabs.find(t => t.id !== closedTabId);
      if (replacement) next.push({ ...entry, tabId: replacement.id });
    } else {
      next.push(entry);
    }
  }
  chrome.storage.local.set({ daemonRoster: next });
}

if (chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => { refreshRosterAfterTabLoss(tabId); });
}

async function postJson(path, body) {
  const res = await fetch(DAEMON + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (res.status === 204) return null;
  return res.json();
}

async function executeCommand(cmd) {
  // cross-mode lock: never drive a tab from the daemon while a local
  // debate is using the same tabs, and never two commands at once
  if (running) {
    return postJson("/agent/result", {
      callId: cmd.callId, ok: false,
      error: "a local debate is running in the extension — wait for it to finish"
    });
  }
  // roster entries carry the tabId to use for each site
  const roster = (await getStored("daemonRoster")) || [];
  let entry = roster.find(r => r.site === cmd.site);
  if (entry) {
    const alive = await chrome.tabs.get(entry.tabId).then(() => true, () => false);
    if (!alive) {
      const tabs = await chrome.tabs.query({ url: `https://${cmd.site}/*` }).catch(() => []);
      const replacement = tabs[0];
      if (replacement) {
        entry = { ...entry, tabId: replacement.id };
        chrome.storage.local.set({ daemonRoster: roster.map(r => r.site === cmd.site ? entry : r) });
      }
    }
  }
  if (!entry) {
    return postJson("/agent/result", {
      callId: cmd.callId, ok: false, error: `no roster tab for site ${cmd.site}`
    });
  }
  agentInFlight = true;
  try {
    if (cmd.op === "extract") {
      // daemon-side rescue: return the last assistant text without sending
      await chrome.scripting.executeScript({
        target: { tabId: entry.tabId }, files: ["sites.js", "content.js"]
      }).catch(() => {});
      chrome.tabs.sendMessage(entry.tabId, { type: "GET_LAST" }, (res) => {
        const out = (!res || !res.ok)
          ? { callId: cmd.callId, ok: false, error: (res && res.error) || "extract failed" }
          : { callId: cmd.callId, ok: true, text: res.text };
        postJson("/agent/result", out).catch(() => {});
      });
      return;
    }
    // make sure the content script is present (tab may predate install)
    await chrome.scripting.executeScript({
      target: { tabId: entry.tabId }, files: ["sites.js", "content.js"]
    }).catch(() => {});
    chrome.tabs.sendMessage(
      entry.tabId,
      { type: "SEND_AND_WAIT", prompt: cmd.prompt, timeoutMs: 280000 },
      (res) => {
        const out = (!res || !res.ok)
          ? { callId: cmd.callId, ok: false, error: (res && res.error) || "tab command failed" }
          : { callId: cmd.callId, ok: true, text: res.text };
        if (res && res.ok) lastTextByTab[entry.tabId] = res.text;
        postJson("/agent/result", out).catch(() => {});
      }
    );
  } finally {
    agentInFlight = false;
  }
}

async function agentTick() {
  if (!agentRunning) return;
  try {
    const roster = (await getStored("daemonRoster")) || [];
    const res = await postJson("/agent/poll", { agentId: AGENT_ID, roster });
    if (res && res.command) await executeCommand(res.command);
  } catch (_) { /* daemon offline — popup shows the banner */ }
  if (agentRunning) setTimeout(agentTick, 500);
}

async function armAgent(armed) {
  agentRunning = armed;
  if (armed) agentTick(); // fetch activity keeps the service worker alive
}

// service worker can restart at any time — re-arm automatically
(async () => {
  const cfg = await getStored("daemonConfig");
  if (cfg && cfg.armed) armAgent(true);
})();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "SET_DAEMON") {
    chrome.storage.local.set({
      daemonConfig: { armed: msg.armed },
      daemonRoster: msg.roster || []
    }, () => {
      armAgent(msg.armed);
      sendResponse({ ok: true });
    });
    return true;
  }
});
