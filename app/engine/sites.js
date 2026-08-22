// Per-site DOM configuration.
// These selectors are best-effort and WILL need occasional updates when
// a chat site redesigns. Keep them as small candidate lists; content.js
// has generic fallbacks (last assistant-looking block / any contenteditable
// or textarea input) if all candidates fail.

const SITE_CONFIGS = {
  "chat.qwen.ai": {
    name: "Qwen",
    // assistant message containers, most specific first
    assistantSelectors: [
      "#chat-message-el .message-assistant",
      "[class*='message-assistant']",
      "#chat-message-el > div:last-child"
    ],
    // user's own messages (excluded when extracting)
    userSelectors: ["[class*='message-user']"],
    inputSelectors: ["div#chat-input", "textarea#chat-input"],
    sendButtonSelectors: [
      "button[class*='send']",
      "button[aria-label*='Send' i]",
      "button[aria-label*='send' i]"
    ]
  },

  "chat.z.ai": {
    name: "GLM (Z.ai)",
    assistantSelectors: [
      "[class*='assistant'] [class*='markdown']",
      "[class*='AssistantMessage']",
      "[class*='message-assistant']"
    ],
    userSelectors: ["[class*='user'] p", "[class*='UserMessage']"],
    inputSelectors: ["div#chat-input", "textarea[placeholder]", "div[contenteditable='true']"],
    sendButtonSelectors: [
      "button[class*='send']",
      "button[aria-label*='Send' i]",
      "button[aria-label*='send' i]"
    ]
  },

  "gemini.google.com": {
    name: "Gemini",
    assistantSelectors: [
      "model-response .markdown",
      "message-content",
      "[class*='response-container']"
    ],
    userSelectors: ["user-query", "[class*='query-content']"],
    inputSelectors: ["rich-textarea div[contenteditable='true']", "textarea"],
    sendButtonSelectors: [
      "button[aria-label*='Send' i]",
      "button.send-button",
      "button[mattooltip*='Send' i]"
    ]
  },

  "chatgpt.com": {
    name: "ChatGPT",
    assistantSelectors: ["[data-message-author-role='assistant']"],
    userSelectors: ["[data-message-author-role='user']"],
    inputSelectors: ["div#prompt-textarea", "div[contenteditable='true']"],
    sendButtonSelectors: ["button[data-testid='send-button']", "button[aria-label*='Send' i]"]
  },

  "claude.ai": {
    name: "Claude",
    assistantSelectors: ["div.font-claude-message", "[class*='assistant']"],
    userSelectors: ["div.font-user-message", "[class*='user-message']"],
    inputSelectors: ["div[contenteditable='true']", "fieldset div.ProseMirror"],
    sendButtonSelectors: ["button[aria-label*='Send' i]", "button[aria-label*='send message' i]"]
  }
};

function configForHost(host) {
  return SITE_CONFIGS[host] || null;
}
