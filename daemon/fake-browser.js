'use strict';
// Test double: simulates the Chrome extension answering model calls.
// answers: (role, entry, prompt) => string  OR a map keyed by entry.name.

function createFakeBrowser(answers) {
  const calls = [];
  const fn = typeof answers === 'function'
    ? answers
    : (role, entry) => {
        const a = answers[entry.name];
        if (typeof a === 'function') return a(role, entry, calls);
        return a || `Default answer from ${entry.name}. CONFIDENCE: 80%`;
      };
  const callModel = async (role, entry, prompt) => {
    calls.push({ role, name: entry.name, prompt });
    await new Promise(r => setTimeout(r, 1));
    return fn(role, entry, prompt);
  };
  return { callModel, calls };
}

module.exports = { createFakeBrowser };
