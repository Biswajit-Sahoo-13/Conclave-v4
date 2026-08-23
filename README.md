# Conclave v4 — All-in-One Electron App

Everything in one installed Windows app: your AI chats live INSIDE the app
(sidebar tabs for Qwen / GLM / Gemini / ChatGPT / Claude — log in once and
sessions persist), the debate engine and SQLite Project Brain are built in,
and Antigravity can trigger debates over MCP. No Chrome extension, no
separate daemon, no Node install for daily use.

The Chrome extension from v2/v3 is still included and works standalone.

## Prerequisites

- Windows 10/11
- For daily use: nothing else — install and run
- For development/building: Node.js 22.5+ and one-time npm install (the
  only place in Conclave with npm dependencies: electron + electron-builder)
- Free logged-in accounts at chat.qwen.ai and chat.z.ai inside the app

## Run the app (development)

    cd app
    npm install
    npm start

First run: click Qwen and GLM in the sidebar and log in once (green dot =
loaded). Roles pre-assign automatically (first two sites debate, second
also judges — change in Advanced).

## Build the installer

    cd app
    npm run dist        ->  dist/Conclave Setup 4.0.0.exe (NSIS installer)

## Using it

1. Paste your idea (Simple mode) and press START THE DEBATE — watch the
   live timeline; the verdict is stored in the Brain and written as
   framework.md if a project folder is set (Advanced).
2. Advanced: routing mode, judge mode, rounds, project, session history
   with accept/reject feedback (trains weighted judges).
3. MCP button (sidebar bottom): serves http://127.0.0.1:8765/mcp for
   Antigravity.

## MCP tools (for Antigravity)

| Tool | Behavior |
|---|---|
| ask_council(question, context?, kind?) | Async job — returns session_id immediately; poll with get_session |
| get_session(session_id) | Poll a debate: running / done (+ verdict) / failed |
| get_project_state() | Decisions, open questions, recent verdicts |
| record_issue(title, error, context?, debate?) | Log an Antigravity error; debate:true resolves it via a council |
| submit_feedback(session_id, accepted) | Trains judge weights |

## Tests

    node --test daemon/test/engine.test.js daemon/test/brain.test.js daemon/test/e2e.test.js

34 tests (the engine is shared between the daemon and app/engine copies —
keep them in sync; app/README.md documents the copy commands).

## Design

"Council Chamber": dark-mode-native default + light toggle, single indigo
accent, monospace as the machine voice, inline SVG icons only.
