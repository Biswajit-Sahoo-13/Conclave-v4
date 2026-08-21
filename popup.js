// Popup: scans open tabs for supported chat sites, lets the user assign
// roles (debater / judge), then starts the debate in the background.

const KNOWN_HOSTS = {
  "chat.qwen.ai": "Qwen",
  "chat.z.ai": "GLM",
  "gemini.google.com": "Gemini",
  "chatgpt.com": "ChatGPT",
  "claude.ai": "Claude"
};

const tabsEl = document.getElementById("tabs");
const statusEl = document.getElementById("status");
const chatTabs = []; // {tabId, name, title}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

function renderTabs() {
  if (!chatTabs.length) {
    tabsEl.innerHTML = "No supported chat tabs found. Open chat.qwen.ai / chat.z.ai / etc. first.";
    return;
  }
  tabsEl.innerHTML =
    "<div class='tab-row'><b>Tab</b>&nbsp;&nbsp;<span class='role'>Debaters</span>&nbsp;&nbsp;<span class='role'>Judge</span></div>" +
    chatTabs.map((t, i) => `
      <div class="tab-row">
        <span style="flex:1">${esc(t.name)} — ${esc(t.title)}</span>
        <label><input type="checkbox" data-debate="${i}"></label>
        <label><input type="radio" name="judge" data-judge="${i}"></label>
      </div>`).join("");
}

async function scanTabs() {
  const all = await chrome.tabs.query({});
  for (const t of all) {
    if (!t.url) continue;
    let host;
    try { host = new URL(t.url).host; } catch (_) { continue; }
    if (KNOWN_HOSTS[host]) {
      chatTabs.push({ tabId: t.id, name: KNOWN_HOSTS[host], title: (t.title || "").slice(0, 30) });
    }
  }
  renderTabs();
}

function getConfig(mode) {
  const idea = document.getElementById("idea").value.trim();
  if (!idea) return { error: "Paste your idea or question first." };

  const debaters = [];
  let judge = null;
  chatTabs.forEach((t, i) => {
    if (tabsEl.querySelector(`[data-debate="${i}"]`).checked) debaters.push(t);
    if (tabsEl.querySelector(`[data-judge="${i}"]`)?.checked) judge = t;
  });

  if (debaters.length < 1) return { error: "Select at least one debater tab." };
  if (!judge) return { error: "Select a judge tab." };
  if (debaters.length === 1 && debaters[0].tabId === judge.tabId) {
    return { error: "Judge cannot be the only debater — select another debater or another judge." };
  }
  if (document.getElementById("adversarial").checked && debaters.length >= 2) {
    debaters[debaters.length - 1].adversarial = true;
  }

  return {
    idea,
    debaters,
    judge,
    maxRounds: parseInt(document.getElementById("rounds").value, 10),
    earlyStop: document.getElementById("earlyStop").checked,
    adversarial: document.getElementById("adversarial").checked,
    timeoutMs: 300000
  };
}

function showStatus(text, isErr) {
  statusEl.style.display = "block";
  statusEl.classList.toggle("err", !!isErr);
  statusEl.textContent = text;
}

async function start(type) {
  const config = getConfig();
  if (config.error) return showStatus(config.error, true);
  showStatus("Starting... keep the chat tabs open and visible.");

  // Content scripts registered statically only load on tabs opened after
  // install; force-inject for tabs that were already open.
  await chrome.scripting.executeScript({
    target: { tabId: config.judge.tabId },
    files: ["sites.js", "content.js"]
  }).catch(() => {});
  for (const d of config.debaters) {
    await chrome.scripting.executeScript({
      target: { tabId: d.tabId },
      files: ["sites.js", "content.js"]
    }).catch(() => {});
  }

  chrome.runtime.sendMessage({ type, config }, (res) => {
    if (chrome.runtime.lastError) return showStatus(chrome.runtime.lastError.message, true);
    showStatus(res.ok ? (res.log || []).join("\n") : `FAILED: ${res.error}`, !res.ok);
  });
}

// Live progress updates from the background worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS") showStatus(msg.log.join("\n"));
});

document.getElementById("debate").addEventListener("click", () => start("START_DEBATE"));
document.getElementById("question").addEventListener("click", () => start("START_QUESTION"));
scanTabs();

// ---------------- manual mode ----------------
// Same debate logic as background.js, but you are the "hands": copy each
// prompt into the tab yourself, select the model's answer, click Capture.
// Immune to UI redesigns because it never touches site selectors.

const manualBox = document.getElementById("manualBox");
const manualStep = document.getElementById("manualStep");
const manualPrompt = document.getElementById("manualPrompt");
const manualHint = document.getElementById("manualHint");

let manual = null; // {config, steps, idx, answers}

function buildManualSteps(config) {
  const steps = [];
  for (let round = 1; round <= config.maxRounds; round++) {
    for (const d of config.debaters) {
      steps.push({ round, tab: d, prompt: null });
    }
  }
  steps.push({ round: "JUDGE", tab: config.judge, prompt: null });
  return steps;
}

function showManualStep() {
  const s = manual.steps[manual.idx];
  if (!s) return finishManual();
  if (s.round === "JUDGE") {
    s.prompt = JUDGE_FINAL_PROMPT +
      `The user's original idea was:\n${manual.config.idea}\n\n` +
      judgeTranscript(manual.config.debaters, manual.answers);
  } else if (s.round > 1) {
    // built here, not upfront: needs the answers captured so far
    s.prompt = buildDebatePrompt(s.round, manual.config.idea,
      othersBlock(manual.config.debaters, manual.answers, s.tab.tabId), s.tab.adversarial);
  } else {
    s.prompt = manual.config.idea;
  }
  manualStep.textContent =
    `Round ${s.round === "JUDGE" ? "FINAL — " + s.tab.name + " (judge)" : s.round + "/" + manual.config.maxRounds + " — " + s.tab.name + (s.tab.adversarial ? " (adversary)" : "")}`;
  manualPrompt.value = s.prompt;
  manualHint.textContent =
    `1) Copy the prompt  2) Paste & send it in the ${s.tab.name} tab  ` +
    `3) Select the answer text there  4) Come back and click Capture`;
}

async function captureFrom(tabId) {
  const tryGet = () => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "GET_SELECTION" }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) resolve(null);
      else resolve(res.text);
    });
  });
  let text = await tryGet();
  if (!text) {
    // content script not loaded yet (e.g. after extension reload) — inject, retry
    await chrome.scripting.executeScript({ target: { tabId }, files: ["sites.js", "content.js"] }).catch(() => {});
    text = await tryGet();
  }
  return text;
}

function saveMd(filename, text) {
  const dataUrl = "data:text/markdown;charset=utf-8," + encodeURIComponent(text);
  chrome.downloads.download({ url: dataUrl, filename: `ai-council/${filename}`, saveAs: false });
}

function finishManual() {
  const verdict = manual.answers[manual.config.judge.tabId] || "";
  const cfg = manual.config;
  const md =
    `# Project Framework — generated by AI Council (manual mode)\n\n` +
    `- Date: ${new Date().toISOString()}\n` +
    `- Debaters: ${cfg.debaters.map(d => d.name + (d.adversarial ? " (adversary)" : "")).join(", ")}\n` +
    `- Judge: ${cfg.judge.name}\n\n` +
    `## Original Idea\n\n${cfg.idea}\n\n` +
    `## Judge Verdict\n\n${verdict}\n`;
  saveMd("framework.md", md);
  manualStep.textContent = "Done — framework.md saved to Downloads/ai-council/";
  manualHint.textContent = "";
  manualPrompt.value = "";
  showStatus("Manual debate complete. framework.md saved.");
}

document.getElementById("manual").addEventListener("click", () => {
  const config = getConfig();
  if (config.error) return showStatus(config.error, true);
  manual = { config, steps: null, idx: 0, answers: {} };
  manual.steps = buildManualSteps(config);
  manualBox.style.display = "block";
  showManualStep();
});

document.getElementById("copyPrompt").addEventListener("click", async () => {
  await navigator.clipboard.writeText(manualPrompt.value);
  manualHint.textContent = "Copied. Paste it into the chat tab now.";
});

document.getElementById("capture").addEventListener("click", async () => {
  const s = manual.steps[manual.idx];
  if (!s) return;
  const text = await captureFrom(s.tab.tabId);
  if (!text) {
    showStatus("Could not capture: go to the " + s.tab.name + " tab, select the model's answer text (drag over it), then come back and click Capture again.", true);
    return;
  }
  manual.answers[s.tab.tabId] = text;
  showStatus(`Captured ${text.length} chars from ${s.tab.name}.`);
  manual.idx++;
  showManualStep();
});
