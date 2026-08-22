// Content script: injects prompts into the chat input, sends them,
// waits for the streaming response to finish, and extracts the text.
// All DOM access goes through sites.js configs with generic fallbacks.

(() => {
  if (window.__aiCouncilInjected) return;
  window.__aiCouncilInjected = true;

  const cfg = configForHost(location.host);

  // ---------- helpers ----------

  function firstMatch(selectors) {
    if (!cfg) return null;
    for (const sel of selectors) {
      try {
        const el = document.querySelector(sel);
        if (el) return el;
      } catch (_) { /* invalid selector on this page — skip */ }
    }
    return null;
  }

  function allMatches(selectors) {
    if (!cfg) return [];
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        if (els.length) return [...els];
      } catch (_) { /* skip */ }
    }
    return [];
  }

  function visible(el) {
    return el && el.offsetParent !== null && el.textContent.trim().length > 0;
  }

  function getInputElement() {
    let el = firstMatch((cfg && cfg.inputSelectors) || []);
    if (el && visible(el)) return el;
    // generic fallback: largest visible contenteditable or textarea near bottom
    const candidates = [...document.querySelectorAll("div[contenteditable='true'], textarea")]
      .filter(visible);
    if (!candidates.length) return null;
    return candidates[candidates.length - 1];
  }

  function getSendButton() {
    let btn = firstMatch((cfg && cfg.sendButtonSelectors) || []);
    if (btn && btn.offsetParent !== null) return btn;
    // fallback: last enabled icon button inside/near the input's form
    const input = getInputElement();
    const scope = input ? (input.closest("form") || document) : document;
    const buttons = [...scope.querySelectorAll("button")].filter(b => !b.disabled && b.offsetParent !== null);
    return buttons[buttons.length - 1] || null;
  }

  function getUserElements() {
    return allMatches((cfg && cfg.userSelectors) || []);
  }

  // Returns the text of the most recent assistant response on the page.
  // Strategy: configured assistant selectors, else every top-level message
  // block minus user blocks, take the last one.
  function getLastAssistantText() {
    const userEls = getUserElements();
    const isUser = (el) => userEls.some(u => u === el || u.contains(el) || el.contains(u));

    let blocks = allMatches((cfg && cfg.assistantSelectors) || []);
    if (!blocks.length) {
      // generic fallback: common message-block containers
      blocks = [...document.querySelectorAll(
        "[class*='message'], [class*='Message'], " +
        "model-response, message-content, [data-message-author-role='assistant']"
      )].filter(visible);
    }
    blocks = blocks.filter(el => !isUser(el));
    if (!blocks.length) return null;

    const last = blocks[blocks.length - 1];
    const text = last.innerText.trim();
    return text.length > 0 ? text : null;
  }

  // ---------- prompt injection ----------

  async function typePrompt(text) {
    const input = getInputElement();
    if (!input) throw new Error("No chat input found on this page. Open a new chat first.");

    input.focus();
    if (input.tagName === "TEXTAREA") {
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // contenteditable: insert as plain text via clipboard paste event,
      // which React-based chats (Qwen, Z.ai, ChatGPT) handle reliably
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      input.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true, cancelable: true, clipboardData: dt
      }));
      // some editors need direct DOM insertion as well
      if (!input.textContent.includes(text.slice(0, 40))) {
        document.execCommand("insertText", false, text);
      }
    }
    await sleep(300);
  }

  async function clickSend() {
    const btn = getSendButton();
    if (!btn) throw new Error("No send button found.");
    btn.click();
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Waits until the newest assistant message stops growing, indicating the
  // response finished streaming. Returns its text. The stability window
  // widens for long responses: thinking models can pause >6s mid-stream,
  // which would otherwise look "done" (false completion).
  async function waitForResponse(timeoutMs = 240000) {
    const started = Date.now();
    const before = getLastAssistantText(); // response that existed before send
    let lastLen = before ? before.length : 0;
    let stableCount = 0;

    while (Date.now() - started < timeoutMs) {
      await sleep(750);
      const stableNeeded = (Date.now() - started) > 90000 ? 14 : 8;
      const cur = getLastAssistantText();
      const curLen = cur ? cur.length : 0;
      if (curLen > lastLen) {
        lastLen = curLen;
        stableCount = 0;
      } else if (curLen === lastLen && curLen > 0 && cur !== before) {
        stableCount++;
        if (stableCount >= stableNeeded) return cur;
      } else {
        stableCount = 0;
      }
    }
    const final = getLastAssistantText();
    if (final && final !== before) return final;
    throw new Error("Timed out waiting for the response to finish.");
  }

  // ---------- message API ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === "PING") {
          sendResponse({ ok: true, host: location.host, name: cfg ? cfg.name : location.host });
        } else if (msg.type === "SEND_AND_WAIT") {
          const baseline = getLastAssistantText();
          await typePrompt(msg.prompt);
          await clickSend();
          const text = await waitForResponse(msg.timeoutMs || 240000);
          sendResponse({ ok: true, text });
        } else if (msg.type === "GET_LAST") {
          sendResponse({ ok: true, text: getLastAssistantText() });
        } else if (msg.type === "GET_SELECTION") {
          // Manual mode: whatever the user highlighted on the page is the
          // answer — immune to selector breakage.
          const sel = String(window.getSelection && window.getSelection() || "");
          sendResponse(sel.trim().length > 20
            ? { ok: true, text: sel.trim() }
            : { ok: false, error: "Select the model's answer text on the page first (selection too short)." });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async response
  });
})();
