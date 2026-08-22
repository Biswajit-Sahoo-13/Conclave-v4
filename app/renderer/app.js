'use strict';
// Renderer panel: site tabs + webviews, Simple timeline, Advanced controls.

const svg = (paths, size = 14) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  think: svg(`<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`),
  attack: svg(`<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" fill="currentColor" stroke="none"/>`),
  notes: svg(`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>`),
  agree: svg(`<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>`),
  judge: svg(`<line x1="12" y1="3" x2="12" y2="21"/><line x1="5" y1="7" x2="19" y2="7"/><path d="M5 7l-2.5 6a3 3 0 0 0 5 0L5 7z"/><path d="M19 7l-2.5 6a3 3 0 0 0 5 0L19 7z"/>`),
  check: svg(`<polyline points="20 6 9 17 4 12"/>`),
  alert: svg(`<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>`),
  open: svg(`<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>`),
  retry: svg(`<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>`)
};

const $ = (id) => document.getElementById(id);
let SITES = [];
const state = {
  activeSite: null,
  loaded: {},   // site -> bool (page finished loading + logged-in guess)
  roles: {},    // site -> 'debater' | 'judge' | 'both' | null
  uiMode: localStorage.getItem('uiMode') || 'simple',
  running: false
};

// ---------- boot: build webviews + sidebar ----------

(async () => {
  SITES = await council.sites();
  const nav = $('siteNav'), views = $('views');
  for (const s of SITES) {
    const btn = document.createElement('button');
    btn.className = 'site-btn';
    btn.dataset.site = s.site;
    btn.innerHTML = `<span class="dot" data-dot></span>${s.name}<span class="role-tag" data-tag></span>`;
    btn.addEventListener('click', () => activateSite(s.site));
    nav.appendChild(btn);

    const wv = document.createElement('webview');
    wv.src = s.url;
    wv.partition = 'persist:council';
    wv.dataset.site = s.site;
    wv.addEventListener('did-finish-load', () => {
      state.loaded[s.site] = true;
      refreshNav();
    });
    wv.addEventListener('did-fail-load', () => { state.loaded[s.site] = false; refreshNav(); });
    views.appendChild(wv);
  }
  // default roles: first two sites debate, second also judges
  if (SITES.length >= 2) {
    state.roles[SITES[0].site] = 'debater';
    state.roles[SITES[1].site] = 'debater+judge';
  }
  activateSite(SITES[0] && SITES[0].site);
  refreshNav();
  renderRoles();
  setMode(state.uiMode);
  refreshState();
  setInterval(publishRoles, 4000);
})();

function webviewEl(site) { return document.querySelector(`webview[data-site="${site}"]`); }

function activateSite(site) {
  state.activeSite = site;
  document.querySelectorAll('webview').forEach(w => w.classList.toggle('on', w.dataset.site === site));
  document.querySelectorAll('.site-btn').forEach(b => b.classList.toggle('on', b.dataset.site === site));
}

function refreshNav() {
  document.querySelectorAll('.site-btn').forEach(b => {
    const site = b.dataset.site;
    b.querySelector('[data-dot]').classList.toggle('loaded', !!state.loaded[site]);
    const tag = b.querySelector('[data-tag]');
    const r = state.roles[site];
    tag.textContent = r ? r.replace('debater+judge', 'D+J').replace('debater', 'D').replace('judge', 'J') : '';
  });
  refreshSimpleReady();
}

// ---------- roles ----------

function renderRoles() {
  const el = $('rolesList');
  el.innerHTML = SITES.map(s => `
    <div class="role-row">
      <span class="nm">${s.name}</span>
      <label><input type="checkbox" data-r="debater" data-site="${s.site}" ${state.roles[s.site]?.includes('debater') ? 'checked' : ''}> Debater</label>
      <label><input type="checkbox" data-r="judge" data-site="${s.site}" ${state.roles[s.site]?.includes('judge') ? 'checked' : ''}> Judge</label>
    </div>`).join('');
  el.querySelectorAll('input').forEach(i => i.addEventListener('change', () => {
    const site = i.dataset.site;
    const deb = el.querySelector(`[data-r="debater"][data-site="${site}"]`).checked;
    const jud = el.querySelector(`[data-r="judge"][data-site="${site}"]`).checked;
    state.roles[site] = deb && jud ? 'debater+judge' : deb ? 'debater' : jud ? 'judge' : null;
    refreshNav(); publishRoles();
  }));
}

function rosterFromState() {
  const out = [];
  for (const s of SITES) {
    const r = state.roles[s.site];
    const wv = webviewEl(s.site);
    if (!r || !wv) continue;
    const contentsId = wv.getWebContentsId ? wv.getWebContentsId() : null;
    if (r.includes('debater')) out.push({ site: s.site, name: s.name, role: 'debater', contentsId });
    if (r.includes('judge')) out.push({ site: s.site, name: s.name, role: 'judge', contentsId });
  }
  return out;
}
async function publishRoles() { await council.setRoles(rosterFromState()); }

// ---------- mode switch ----------

function setMode(mode) {
  state.uiMode = mode;
  localStorage.setItem('uiMode', mode);
  $('modeSimple').classList.toggle('on', mode === 'simple');
  $('modeAdvanced').classList.toggle('on', mode === 'advanced');
  $('simpleView').style.display = mode === 'simple' ? 'block' : 'none';
  $('advancedView').style.display = mode === 'advanced' ? 'block' : 'none';
  refreshSimpleReady();
}
$('modeSimple').addEventListener('click', () => setMode('simple'));
$('modeAdvanced').addEventListener('click', () => setMode('advanced'));

// ---------- simple mode ----------

function refreshSimpleReady() {
  const roster = rosterFromState();
  const debaters = roster.filter(r => r.role === 'debater');
  const judges = roster.filter(r => r.role === 'judge');
  const ready = $('simpleReady');
  if (debaters.length >= 1 && judges.length >= 1) {
    ready.innerHTML = `<span class="dot ok"></span> ${debaters.map(d => d.name).join(' + ')} ready — ${judges[0].name} will judge`;
    $('simpleStart').disabled = state.running;
  } else {
    ready.innerHTML = `<span class="dot"></span> Assign a Debater and a Judge in Advanced (sidebar roles)`;
    $('simpleStart').disabled = true;
  }
}

const bubblesByName = {};
function showTimeline() {
  $('timeline').style.display = 'block';
  $('timeline').innerHTML = '';
  $('resultCard').style.display = 'none';
  $('errorCard').style.display = 'none';
}
function scrollTl() { $('timeline').scrollTop = $('timeline').scrollHeight; }
function tlDivider(t) { $('timeline').insertAdjacentHTML('beforeend', `<div class="tl-divider">${t}</div>`); scrollTl(); }
function tlBubble(kind, iconKey, text) {
  const id = 'tl' + Math.random().toString(36).slice(2, 8);
  $('timeline').insertAdjacentHTML('beforeend',
    `<div class="tl-item ${kind}" id="${id}"><span class="ic spin">${ICONS[iconKey]}</span><span class="tx">${text}</span></div>`);
  scrollTl();
  return document.getElementById(id);
}

council.onProgress((line) => {
  if (state.uiMode !== 'simple' || $('timeline').style.display === 'none') return;
  let m;
  if ((m = line.match(/^Sending to (\S+?)( \(adversary\))?\.\.\.$/))) {
    bubblesByName[m[1]] = m[2]
      ? tlBubble('attack', 'attack', `${m[1]} is attacking the other answer…`)
      : tlBubble('', 'think', `${m[1]} is thinking…`);
  } else if ((m = line.match(/^(\S+?) answered \((\d+) chars\)\./))) {
    const b = bubblesByName[m[1]];
    if (b) {
      b.classList.add('done'); b.classList.remove('attack');
      const ic = b.querySelector('.ic'); ic.classList.remove('spin'); ic.innerHTML = ICONS.check;
      b.querySelector('.tx').textContent = `${m[1]} answered`;
    }
  } else if (/judge mode|judge ensemble/i.test(line)) {
    tlBubble('judge', 'judge', 'The judges are deliberating…');
  } else if (/failed|error/i.test(line)) {
    tlBubble('attack', 'alert', 'Something went wrong — see the message below.');
  }
});

async function startSimple() {
  const idea = $('simpleIdea').value.trim();
  if (!idea) { $('simpleIdea').focus(); return; }
  state.running = true;
  refreshSimpleReady();
  showTimeline();
  tlDivider('The council convenes');
  const cfg = {
    question: idea, kind: 'framework',
    maxRounds: parseInt(localStorage.getItem('rounds') || '3', 10),
    routingMode: localStorage.getItem('routingMode') || 'balanced',
    judgeMode: localStorage.getItem('judgeMode') || 'synthesis'
  };
  const res = await council.run(cfg);
  state.running = false;
  refreshSimpleReady();
  if (!res.ok) return showError(res.error);
  showResult(res.verdict, res.outFile);
}
$('simpleStart').addEventListener('click', startSimple);

function showResult(verdict, outFile) {
  const card = $('resultCard');
  card.innerHTML =
    `<div class="head">${ICONS.check} Debate finished — framework ready</div>` +
    `<div class="preview">${(verdict || '').slice(0, 600)}${(verdict || '').length > 600 ? '…' : ''}</div>` +
    (outFile ? `<div class="actions">Saved to ${outFile}</div>` : `<div class="actions">Saved to the Project Brain (see Advanced)</div>`);
  card.style.display = 'block';
}

function showError(message) {
  const card = $('errorCard');
  card.innerHTML =
    `<div class="head">${ICONS.alert} The debate couldn't finish</div>` +
    `<div class="preview">${message}</div>` +
    `<div class="actions"><button id="btnRetry">${ICONS.retry} Try again</button></div>`;
  card.style.display = 'block';
  $('btnRetry').addEventListener('click', startSimple);
}

// ---------- advanced ----------

['rounds', 'routingMode', 'judgeMode'].forEach(id =>
  $(id).addEventListener('change', () => localStorage.setItem(id, $(id).value)));

$('saveProject').addEventListener('click', async () => {
  await council.saveProject({
    name: $('projName').value.trim() || 'default',
    rootPath: $('projRoot').value.trim() || null
  });
  refreshState();
});

$('mcpBtn').addEventListener('click', async () => {
  const on = $('mcpBtn').textContent.includes('off');
  const res = await council.mcpToggle(on);
  $('mcpBtn').textContent = res.ok ? `MCP: ${on ? 'on (127.0.0.1:8765)' : 'off'}` : 'MCP: error';
});

async function refreshState() {
  const st = await council.state();
  $('projName').value = st.project.name === 'default' ? '' : st.project.name;
  $('projRoot').value = st.project.rootPath || '';
  $('sessions').innerHTML = st.sessions.length
    ? st.sessions.map(s => `<div>#${s.id} ${s.kind} — ${s.status}
        ${s.status === 'done' ? `<button class="fb" data-id="${s.id}" data-ok="1">✓</button><button class="fb" data-id="${s.id}" data-ok="0">✗</button>` : ''}
      </div>`).join('')
    : '<div>No sessions yet.</div>';
  $('sessions').querySelectorAll('.fb').forEach(b => b.addEventListener('click', async () => {
    await council.feedback({ sessionId: parseInt(b.dataset.id), accepted: b.dataset.ok === '1' });
    refreshState();
  }));
  $('brainState').textContent = st.decisions.length
    ? `Brain: ${st.decisions.length} decisions, ${st.openQuestions.length} open questions`
    : 'Brain: empty — decisions accumulate as you run debates';
}
