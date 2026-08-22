'use strict';
// Drives a chat site inside one of the app's <webview> tags: types the
// prompt, sends it, waits for the streamed answer to finish, returns text.
// Port of the extension's content.js to executeJavaScript in the guest.

const { webContents } = require('electron');
const { SITE_CONFIGS } = require('./engine/sites.js');

// Everything below runs INSIDE the chat page.
const PAGE_FN = function (cfg, prompt, timeoutMs) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function firstMatch(selectors) {
    for (const sel of selectors) {
      try { const el = document.querySelector(sel); if (el) return el; } catch (_) {}
    }
    return null;
  }
  function visible(el) {
    return el && el.offsetParent !== null && el.textContent.trim().length > 0;
  }
  function getInputElement() {
    let el = firstMatch(cfg.inputSelectors || []);
    if (el && visible(el)) return el;
    const c = [...document.querySelectorAll("div[contenteditable='true'], textarea")].filter(visible);
    return c[c.length - 1] || null;
  }
  function getSendButton() {
    let btn = firstMatch(cfg.sendButtonSelectors || []);
    if (btn && btn.offsetParent !== null) return btn;
    const input = getInputElement();
    const scope = input ? (input.closest('form') || document) : document;
    const buttons = [...scope.querySelectorAll('button')].filter(b => !b.disabled && b.offsetParent !== null);
    return buttons[buttons.length - 1] || null;
  }
  function userEls() {
    const out = [];
    for (const sel of (cfg.userSelectors || [])) {
      try { document.querySelectorAll(sel).forEach(e => out.push(e)); } catch (_) {}
    }
    return out;
  }
  function getLastAssistantText() {
    const users = userEls();
    const isUser = (el) => users.some(u => u === el || u.contains(el) || el.contains(u));
    let blocks = [];
    for (const sel of (cfg.assistantSelectors || [])) {
      try { const els = document.querySelectorAll(sel); if (els.length) { blocks = [...els]; break; } } catch (_) {}
    }
    if (!blocks.length) {
      blocks = [...document.querySelectorAll(
        "[class*='message'], [class*='Message'], model-response, message-content, [data-message-author-role='assistant']"
      )].filter(visible);
    }
    blocks = blocks.filter(el => !isUser(el));
    if (!blocks.length) return null;
    const t = blocks[blocks.length - 1].innerText.trim();
    return t.length ? t : null;
  }

  return (async () => {
    const before = getLastAssistantText();
    const input = getInputElement();
    if (!input) throw new Error('no chat input found — open a new chat in this tab first');
    input.focus();
    if (input.tagName === 'TEXTAREA') {
      input.value = prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const dt = new DataTransfer();
      dt.setData('text/plain', prompt);
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
      if (!input.textContent.includes(prompt.slice(0, 40))) {
        document.execCommand('insertText', false, prompt);
      }
    }
    await sleep(300);
    const btn = getSendButton();
    if (!btn) throw new Error('no send button found');
    btn.click();

    let lastLen = before ? before.length : 0, stable = 0;
    const started = Date.now();
    while (Date.now() - started < (timeoutMs || 240000)) {
      await sleep(750);
      const cur = getLastAssistantText();
      const len = cur ? cur.length : 0;
      if (len > lastLen) { lastLen = len; stable = 0; }
      else if (len === lastLen && len > 0 && cur !== before) {
        if (++stable >= 8) return cur;
      } else stable = 0;
    }
    const fin = getLastAssistantText();
    if (fin && fin !== before) return fin;
    throw new Error('timed out waiting for the answer');
  })();
};

async function runInWebview(contentsId, host, prompt, timeoutMs) {
  const wc = webContents.fromId(contentsId);
  if (!wc) throw new Error(`webview ${contentsId} not found`);
  const cfg = SITE_CONFIGS[host] || {};
  return wc.executeJavaScript(
    `(${PAGE_FN})(${JSON.stringify(cfg)}, ${JSON.stringify(prompt)}, ${timeoutMs || 240000})`,
    true
  );
}

module.exports = { runInWebview };
