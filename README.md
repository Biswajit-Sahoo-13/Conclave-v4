# AI Council — Multi-Model Debate Extension

Turns your open AI chat tabs into a debate chamber: each model gets your idea,
critiques the others' answers for N rounds, and a judge model produces the
final structured framework. Works with your normal logged-in free accounts
(no API keys).

## Install (Chrome, semi-manual for v1)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Open the chat sites you want (e.g. chat.qwen.ai and chat.z.ai) and start
   a **new chat** in each

## Use

1. Click the AI Council extension icon
2. Paste your idea / prompt
3. Check the **Debaters** columns and pick one **Judge**
4. Rounds default to 3 (hard cap). Optional: judge early-stop on agreement,
   and **Adversary mode** (last debater must attack every claim instead of
   agreeing — breaks shared-wrong-belief hallucinations)
5. Click a mode:
   - **Auto Debate** — fully automatic; needs working site selectors
   - **Manual Debate** — you are the hands: copy each generated prompt into
     the tab, select the model's answer, click **Capture**. Immune to UI
     redesigns; use this whenever Auto breaks on a site.
   - **Resolve Question** — same as Auto, for Antigravity bugs/errors

The final verdict appears in the judge's chat tab and is saved to
`Downloads/ai-council/framework.md` (includes a Mermaid flowchart of the
idea flow and a "Why needed" line per component).

## Antigravity handoff (semi-automated v1)

- Point Antigravity at `Downloads/ai-council/` or copy `framework.md` into
  your project folder and tell Antigravity to follow it.
- When Antigravity reports an error, paste it into the popup and hit
  **Resolve Question**; give the resulting answer back to Antigravity.

## When a site breaks

Chat sites redesign often. If extraction or injection fails on one site,
edit its entry in `sites.js` (selector candidate lists) — that is the only
file that should ever need touching. DevTools on the chat tab → inspect the
assistant message and the input box to find current selectors.

## Known limitations (honest list)

- Selectors in `sites.js` are best-effort; verify on first run per site.
- Very long responses (10k+ chars) fed between tabs consume a lot of context;
  v2 should summarize between rounds.
- All tabs must stay open and logged in; reCAPTCHA/anti-bot checks on some
  sites may occasionally block automated sends.
