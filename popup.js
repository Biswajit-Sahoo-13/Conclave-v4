// Conclave popup — two modes:
//   Simple: zero-config live debate timeline (local engine, no daemon)
//   Advanced: full v1.0 control surface (roles, manual, daemon, MCP)
// All icons are inline SVG (extension CSP forbids remote assets).

const KNOWN_HOSTS = {
  "chat.qwen.ai": "Qwen",
  "chat.z.ai": "GLM",
  "gemini.google.com": "Gemini",
  "chatgpt.com": "ChatGPT",
  "claude.ai": "Claude"
};
const SITE_URLS = {
  "Qwen": "https://chat.qwen.ai",
  "GLM": "https://chat.z.ai",
  "Gemini": "https://gemini.google.com",
  "ChatGPT": "https://chatgpt.com",
  "Claude": "https://claude.ai"
};

// ---------- inline SVG icons (feather-style, stroke = currentColor) ----------
const svg = (paths, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  play: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
  think: svg(`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`),
  attack: svg(`<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" stroke="none"/>`),
  notes: svg(`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>`),
  agree: svg(`<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`),
  judge: svg(`<line x1="12" y1="3" x2="12" y2="21"/><line x1="5" y1="7" x2="19" y2="7"/><path d="M5 7l-2.5 6a3 3 0 0 0 5 0L5 7z"/><path d="M19 7l-2.5 6a3 3 0 0 0 5 0L19 7z"/>`),
  check: svg(`<polyline points="20 6 9 17 4 12"/>`),
  clock: svg(`<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`),
  alert: svg(`<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>`),
  lock: svg(`<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`),
  open: svg(`<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>`),
  retry: svg(`<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>`),
  x: svg(`<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`),
  sun: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
  moon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`
};

// DOM helper must precede top-level uses ($("themeToggle") below).
const $ = (id) => document.getElementById(id);

// ---- theme (dark default, light variant, persisted) ----
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("themeToggle").innerHTML = theme === "light" ? ICONS.moon : ICONS.sun;
}
(async () => {
  const { uiTheme } = await chrome.storage.local.get("uiTheme").catch(() => ({}));
  applyTheme(uiTheme === "light" ? "light" : "dark");
})();
$("themeToggle").addEventListener("click", async () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(next);
  chrome.storage.local.set({ uiTheme: next }).catch(() => {});
});

const tabsEl = $("tabs");
const statusEl = $("status");
const chatTabs = []; // {tabId, name, title}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

// ============================================================
// Tab scanning (shared by checklist, simple ready-line, advanced matrix)
// ============================================================

async function scanTabs() {
  chatTabs.length = 0;
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
  renderSimpleChrome();
}

// Role selections survive the 3s tab rescans: keyed by tabId, re-applied on
// every re-render (a rebuild used to wipe the user's checkboxes).
const roleState = {}; // tabId -> {debate: bool, judge: bool}
let lastTabKey = "";

function renderTabs() {
  const tabKey = chatTabs.map(t => t.tabId).join(",");
  if (tabKey === lastTabKey && tabsEl.children.length) return; // nothing changed
  lastTabKey = tabKey;
  if (!chatTabs.length) {
    tabsEl.innerHTML = "No supported chat tabs found. Open chat.qwen.ai / chat.z.ai / etc. first.";
    return;
  }
  tabsEl.innerHTML =
    "<div class='tab-row'><b>Tab</b>&nbsp;&nbsp;<span class='role'>Debaters</span>&nbsp;&nbsp;<span class='role'>Judge</span></div>" +
    chatTabs.map((t, i) => {
      const st = roleState[t.tabId] || {};
      return `
      <div class="tab-row">
        <span style="flex:1">${esc(t.name)} — ${esc(t.title)}</span>
        <label><input type="checkbox" data-debate="${i}" data-tabid="${t.tabId}" ${st.debate ? "checked" : ""}></label>
        <label><input type="radio" name="judge" data-judge="${i}" data-tabid="${t.tabId}" ${st.judge ? "checked" : ""}></label>
      </div>`;
    }).join("");
}

tabsEl.addEventListener("change", (e) => {
  const tabId = parseInt(e.target.dataset.tabid, 10);
  if (isNaN(tabId)) return;
  const st = roleState[tabId] || (roleState[tabId] = {});
  if (e.target.dataset.debate !== undefined) st.debate = e.target.checked;
  if (e.target.dataset.judge !== undefined) {
    // radio: clear judge flag on all other tabs
    for (const k of Object.keys(roleState)) roleState[k].judge = false;
    st.judge = e.target.checked;
  }
});

// ============================================================
// Mode switching
// ============================================================

let uiMode = "simple";

async function setMode(mode) {
  // keep idea text in sync between the two textareas
  const from = uiMode === "simple" ? $("simpleIdea") : $("idea");
  const to = mode === "simple" ? $("simpleIdea") : $("idea");
  if (from.value.trim()) to.value = from.value;
  uiMode = mode;
  $("modeSimple").classList.toggle("on", mode === "simple");
  $("modeAdvanced").classList.toggle("on", mode === "advanced");
  $("simpleView").style.display = mode === "simple" ? "block" : "none";
  $("advancedView").style.display = mode === "advanced" ? "block" : "none";
  chrome.storage.local.set({ uiMode: mode }).catch(() => {});
}
$("modeSimple").addEventListener("click", () => setMode("simple"));
$("modeAdvanced").addEventListener("click", () => setMode("advanced"));

// ============================================================
// SIMPLE MODE
// ============================================================

function simpleRoles() {
  if (chatTabs.length < 2) return null;
  const debaters = [chatTabs[0], chatTabs[1]];
  const judge = chatTabs[2] || chatTabs[1];
  return { debaters, judge };
}

function renderSimpleChrome() {
  if (uiMode !== "simple") return;
  const roles = simpleRoles();
  const ready = $("simpleReady");
  const start = $("simpleStart");
  const checklist = $("checklist");

  if (roles) {
    const judgeName = roles.judge.name;
    ready.innerHTML = `<span class="dot"></span> ${esc(roles.debaters.map(d => d.name).join(" + "))} ready — ${esc(judgeName)} will judge`;
    start.disabled = false;
    checklist.style.display = "none";
  } else {
    ready.innerHTML = `<span class="dot" style="background:#cbd5e1"></span> Waiting for your chat tabs…`;
    start.disabled = true;
    renderChecklist();
    checklist.style.display = "block";
  }
}

function renderChecklist() {
  const names = ["Qwen", "GLM"];
  const detected = (n) => chatTabs.some(t => t.name === n);
  const both = names.every(detected);
  const steps = names.map((n, i) => {
    const on = detected(n);
    return `
      <div class="step ${on ? "done" : ""}" data-site="${n}">
        <span class="num">${on ? ICONS.check : (i + 1)}</span>
        <span class="txt">Open ${n}<small>${SITE_URLS[n].replace("https://", "")} — log in normally</small></span>
        <span class="state">${on ? "detected" : ICONS.clock + " waiting"}</span>
      </div>`;
  }).join("") + `
      <div class="step ${both ? "" : "locked"}" id="stepStart">
        <span class="num">${both ? ICONS.play : ICONS.lock}</span>
        <span class="txt">Press <b>Start the debate</b><small>The extension does everything else</small></span>
        <span class="state">${both ? "ready" : "locked"}</span>
      </div>`;
  $("checklist").innerHTML = steps;
  $("checklist").querySelectorAll("[data-site]").forEach(el =>
    el.addEventListener("click", () => chrome.tabs.create({ url: SITE_URLS[el.dataset.site] })));
}

// ---- live timeline ----

const timelineEl = $("timeline");
const bubblesByName = {}; // "GLM" -> element currently "thinking"

function showTimeline() {
  timelineEl.style.display = "block";
  timelineEl.innerHTML = "";
  processedLogLines = 0; // new debate: reset the dedup cursor
  $("resultCard").style.display = "none";
  $("errorCard").style.display = "none";
}

function scrollTl() { timelineEl.scrollTop = timelineEl.scrollHeight; }

function tlDivider(text) {
  timelineEl.insertAdjacentHTML("beforeend", `<div class="tl-divider">${esc(text)}</div>`);
  scrollTl();
}

function tlBubble(kind, iconKey, text) {
  const id = "tl" + Math.random().toString(36).slice(2, 8);
  timelineEl.insertAdjacentHTML("beforeend",
    `<div class="tl-item ${kind}" id="${id}"><span class="ic spin">${ICONS[iconKey]}</span><span class="tx">${esc(text)}</span></div>`);
  scrollTl();
  return document.getElementById(id);
}

// Translate internal PROGRESS lines into noob-friendly timeline events.
function tlTranslate(line) {
  let m;
  if ((m = line.match(/^--- Round (\d+)\/(\d+) ---$/))) {
    tlDivider(`Round ${m[1]} of ${m[2]}`);
  } else if ((m = line.match(/^Sending to (\S+?) \(adversary\)\.\.\.$/))) {
    bubblesByName[m[1]] = tlBubble("attack", "attack", `${m[1]} is attacking the other answer to find mistakes…`);
  } else if ((m = line.match(/^Sending to (\S+?)\.\.\.$/))) {
    bubblesByName[m[1]] = tlBubble("", "think", `${m[1]} is thinking…`);
  } else if ((m = line.match(/^(\S+?) answered \((\d+) chars\)\./))) {
    const b = bubblesByName[m[1]];
    if (b) {
      b.classList.add("done");
      b.classList.remove("attack");
      b.querySelector(".ic").classList.remove("spin");
      b.querySelector(".ic").innerHTML = ICONS.check;
      b.querySelector(".tx").textContent = `${m[1]} answered`;
    }
  } else if (/^Compressing round/.test(line)) {
    tlBubble("", "notes", "Referee is summarizing the debate…");
  } else if (/^Asking \S+ if models agree/.test(line)) {
    tlBubble("", "agree", "Checking if the models agree…");
  } else if ((m = line.match(/^Requesting final framework from (\S+?)\.\.\.$/))) {
    tlBubble("judge", "judge", `Judge ${m[1]} is writing the final framework…`);
  } else if (/^Done\./.test(line)) {
    // final card handled by the response callback
  } else if (/failed|FAILED|Timed out|timed out/.test(line)) {
    tlBubble("err", "alert", "Something went wrong — see the message below.");
  }
}

function showResult(verdict, downloadId) {
  const card = $("resultCard");
  card.innerHTML =
    `<div class="head">${ICONS.check} Debate finished — framework ready</div>` +
    `<div class="preview">${esc((verdict || "").slice(0, 400))}${(verdict || "").length > 400 ? "…" : ""}</div>` +
    `<div class="actions">
       <button class="primary" id="openFile">${ICONS.open} Open framework.md</button>
     </div>`;
  card.style.display = "block";
  if (downloadId != null) {
    $("openFile").addEventListener("click", () => chrome.downloads.show(downloadId));
  }
}

function showError(message) {
  const card = $("errorCard");
  card.innerHTML =
    `<div class="head">${ICONS.alert} The debate couldn't finish</div>` +
    `<div class="preview">${esc(message)}</div>` +
    `<div class="actions">
       <button class="primary" id="btnRetry">${ICONS.retry} Try again</button>
       <button id="btnManual">Use Manual mode</button>
     </div>`;
  card.style.display = "block";
  $("btnRetry").addEventListener("click", () => startSimple());
  $("btnManual").addEventListener("click", () => {
    setMode("advanced");
    $("manualBox").style.display = "block";
  });
}

// Locked quality defaults; auto-assigned roles.
async function startSimple() {
  const idea = $("simpleIdea").value.trim();
  if (!idea) { $("simpleIdea").focus(); return; }
  const roles = simpleRoles();
  if (!roles) return;

  const config = {
    idea,
    debaters: roles.debaters,
    judge: roles.judge,
    maxRounds: 3,
    earlyStop: false,
    adversarial: true,
    digest: true,
    timeoutMs: 300000
  };

  $("simpleStart").disabled = true;
  showTimeline();
  tlDivider("Setting up your chat tabs");

  // ensure content scripts exist in the target tabs (tabs may predate install)
  for (const t of [...config.debaters, config.judge]) {
    await chrome.scripting.executeScript({
      target: { tabId: t.tabId }, files: ["sites.js", "content.js"]
    }).catch(() => {});
  }

  chrome.runtime.sendMessage({ type: "START_DEBATE", config }, (res) => {
    $("simpleStart").disabled = false;
    if (chrome.runtime.lastError || !res || !res.ok) {
      showError((res && res.error) || chrome.runtime.lastError?.message || "Unknown error");
    } else {
      showResult(res.verdict, res.downloadId);
    }
  });
}
$("simpleStart").addEventListener("click", startSimple);

// ============================================================
// ADVANCED MODE (v1.0 behavior, unchanged)
// ============================================================

function getConfig(mode) {
  const idea = $("idea").value.trim();
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
  // adversary marking is computed per round (rotating) later — only the flag here

  return {
    idea,
    debaters,
    judge,
    maxRounds: parseInt($("rounds").value, 10),
    earlyStop: $("earlyStop").checked,
    adversarial: $("adversarial").checked,
    digest: $("digest").checked,
    timeoutMs: 300000
  };
}

// Remember settings between sessions
function saveSettings() {
  const cfg = {
    rounds: $("rounds").value,
    earlyStop: $("earlyStop").checked,
    adversarial: $("adversarial").checked,
    digest: $("digest").checked
  };
  chrome.storage.sync.set(cfg).catch(() => {});
}

async function loadSettings() {
  try {
    const s = await chrome.storage.sync.get(["rounds", "earlyStop", "adversarial", "digest"]);
    if (s.rounds) $("rounds").value = s.rounds;
    $("earlyStop").checked = !!s.earlyStop;
    $("adversarial").checked = !!s.adversarial;
    if (typeof s.digest === "boolean") $("digest").checked = s.digest;
  } catch (_) { /* storage unavailable — defaults are fine */ }
}

function showStatus(text, isErr) {
  statusEl.style.display = "block";
  statusEl.classList.toggle("err", !!isErr);
  statusEl.textContent = text;
}

async function start(type) {
  const config = getConfig();
  if (config.error) return showStatus(config.error, true);
  saveSettings();
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

// Live progress updates from the background worker. The log arrives as a
// growing array — process only NEW lines or the timeline would duplicate.
let processedLogLines = 0;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "PROGRESS") {
    if (uiMode === "simple" && timelineEl.style.display !== "none") {
      msg.log.slice(processedLogLines).forEach(tlTranslate);
      processedLogLines = msg.log.length;
    } else {
      showStatus(msg.log.join("\n"));
    }
  }
});

$("debate").addEventListener("click", () => start("START_DEBATE"));
$("question").addEventListener("click", () => start("START_QUESTION"));

// ---------------- manual mode ----------------

const manualBox = $("manualBox");
const manualStep = $("manualStep");
const manualPrompt = $("manualPrompt");
const manualHint = $("manualHint");

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
    // adversary rotates each round, same as auto mode
    manual.config.debaters.forEach((d, i) => {
      d.adversarial = manual.config.adversarial && i === (s.round - 1) % manual.config.debaters.length;
    });
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
  chrome.downloads.download({ url: dataUrl, filename: `conclave/${filename}`, saveAs: false });
}

function finishManual() {
  const verdict = manual.answers[manual.config.judge.tabId] || "";
  const cfg = manual.config;
  const md =
    `# Project Framework — generated by Conclave (manual mode)\n\n` +
    `- Date: ${new Date().toISOString()}\n` +
    `- Debaters: ${cfg.debaters.map(d => d.name + (d.adversarial ? " (adversary)" : "")).join(", ")}\n` +
    `- Judge: ${cfg.judge.name}\n\n` +
    `## Original Idea\n\n${cfg.idea}\n\n` +
    `## Judge Verdict\n\n${verdict}\n`;
  saveMd("framework.md", md);
  manualStep.textContent = "Done — framework.md saved to Downloads/conclave/";
  manualHint.textContent = "";
  manualPrompt.value = "";
  showStatus("Manual debate complete. framework.md saved.");
}

$("manual").addEventListener("click", () => {
  const config = getConfig();
  if (config.error) return showStatus(config.error, true);
  config.debaters.forEach(d => { d.adversarial = false; });
  manual = { config, steps: null, idx: 0, answers: {} };
  manual.steps = buildManualSteps(config);
  manualBox.style.display = "block";
  showManualStep();
});

$("copyPrompt").addEventListener("click", async () => {
  await navigator.clipboard.writeText(manualPrompt.value);
  manualHint.textContent = "Copied. Paste it into the chat tab now.";
});

$("capture").addEventListener("click", async () => {
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

// ---------------- daemon (v2) panel ----------------

const DAEMON = "http://127.0.0.1:8765";

async function daemonFetch(path, opts) {
  return fetch(DAEMON + path, opts);
}

function buildRoster() {
  // roles come from the same checkboxes used for local debates
  const roster = [];
  chatTabs.forEach((t, i) => {
    const isDebater = tabsEl.querySelector(`[data-debate="${i}"]`).checked;
    const isJudge = tabsEl.querySelector(`[data-judge="${i}"]`)?.checked;
    if (!isDebater && !isJudge) return;
    const host = Object.entries(KNOWN_HOSTS).find(([h, name]) => name === t.name)?.[0];
    if (!host) return;
    roster.push({ tabId: t.tabId, site: host, name: t.name, role: isJudge ? "judge" : "debater" });
  });
  return roster;
}

$("armDaemon").addEventListener("change", async (e) => {
  const roster = buildRoster();
  if (e.target.checked && !roster.length) {
    showStatus("Select at least one debater/judge tab above before arming.", true);
    e.target.checked = false;
    return;
  }
  chrome.runtime.sendMessage(
    { type: "SET_DAEMON", armed: e.target.checked, roster },
    () => { if (e.target.checked) { savePrefs(); loadSessions(); } }
  );
});

async function savePrefs() {
  try {
    await daemonFetch("/api/prefs", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routingMode: $("daemonRouting").value,
        judgeMode: $("daemonJudges").value
      })
    });
  } catch (_) { /* daemon offline */ }
}

$("saveProject").addEventListener("click", async () => {
  const name = $("projName").value.trim() || "default";
  const rootPath = $("projRoot").value.trim() || null;
  try {
    await daemonFetch("/api/project", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, rootPath })
    });
    showStatus(`Project "${name}" saved to the Brain.`);
  } catch (_) { showStatus("Daemon offline — start it with daemon/start-council.bat", true); }
});

["daemonRouting", "daemonJudges"].forEach(id =>
  $(id).addEventListener("change", savePrefs));

async function checkDaemon() {
  const dot = $("daemonDot");
  const state = $("daemonState");
  try {
    const r = await (await daemonFetch("/status")).json();
    dot.style.background = "#2c2";
    state.textContent = `online — project "${r.project}", ${r.roster.filter(x => x.role === "debater").length} debaters, ${r.roster.filter(x => x.role === "judge").length} judges, ${r.rated_verdicts} rated verdicts`;
    return true;
  } catch (_) {
    dot.style.background = "#c33";
    state.textContent = "offline — daemon mode unavailable, local mode still works";
    return false;
  }
}

async function loadSessions() {
  const el = $("sessions");
  try {
    const r = await (await daemonFetch("/api/sessions?limit=5")).json();
    if (!r.sessions.length) { el.innerHTML = "<div class='role'>No sessions yet.</div>"; return; }
    el.innerHTML = r.sessions.map(s =>
      `<div class="tab-row">
         <span class="mono" style="flex:1;font-size:11px;color:var(--text-2)">#${s.id} ${esc(s.kind)} — ${esc(s.status)} (${esc(s.routing_mode)}, ${esc(s.judge_mode)})</span>
         ${s.status === "done" ? `<button data-fb="${s.id}" data-ok="1" title="Accept verdict">${ICONS.check}</button><button data-fb="${s.id}" data-ok="0" title="Reject verdict">${ICONS.x}</button>` : ""}
       </div>`).join("");
    el.querySelectorAll("[data-fb]").forEach(b => b.addEventListener("click", async () => {
      await daemonFetch("/api/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: parseInt(b.dataset.fb), accepted: b.dataset.ok === "1" })
      });
      loadSessions();
    }));
  } catch (_) {
    el.innerHTML = "<div class='role'>Daemon offline.</div>";
  }
}

// ---------------- boot ----------------

(async () => {
  const stored = await chrome.storage.local.get("uiMode").catch(() => ({}));
  if (stored.uiMode === "advanced") setMode("advanced");
  await scanTabs();
  loadSettings();
  checkDaemon();
  loadSessions();
  // live checklist: re-scan while the popup is open
  setInterval(scanTabs, 3000);
})();
