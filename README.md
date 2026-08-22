# Conclave v1 "Complex" — Extension + Daemon

Two parts, two branches:

- **`main`** — v0.2: standalone Chrome extension (local engine, manual mode).
  Works with zero setup.
- **`v1-complex-high-features`** (this branch) — v1.1: Simple/Advanced UI on
  top of the local **council daemon** (Node.js, zero npm dependencies) with a
  real SQLite **Project Brain**, **adaptive routing**, **multi-judge
  ensembles**, and an **MCP server** for Antigravity.

## The two UI modes (v1.1)

- **Simple (default)** — paste your idea, press *Start the debate*, watch a
  live timeline (thinking / attacking / refereeing / judging) with inline SVG
  icons. Roles auto-assign from your open tabs; quality defaults are locked
  (3 rounds, adversary on, referee digest on). Zero setup, no daemon needed.
  First run shows a guided checklist that auto-checks as you open the chat
  sites. Errors come with *Try again* / *Use Manual mode* actions.
- **Advanced** — the full v1.0 surface: role matrix, rounds, early-stop,
  adversary, digest, Auto/Manual/Resolve, and the Daemon panel (project,
  routing + judge modes, session history, feedback, arm toggle).

## Quick start (noob path)

1. Load the extension (below), open `chat.qwen.ai` and `chat.z.ai`, log in.
2. Click the Conclave icon — the checklist auto-checks as tabs appear.
3. Paste your idea → **START THE DEBATE** → watch the timeline → open
   `framework.md` from the green result card.

## Quick start (daemon, Advanced)

1. Start the daemon: double-click `daemon/start-conclave.bat`
   (or `node daemon/server.js`). It listens on `http://127.0.0.1:8765`
   and stores the Brain in `%USERPROFILE%\.ai-council\council.db`.
2. Switch the popup to **Advanced**, pick debaters + judge.
3. In the **Daemon** panel: set a project name and (optionally) a project
   folder — verdicts get written there as `framework.md` / `resolution.md`.
   Choose routing mode and judge mode, then check **Arm daemon mode**.
4. Now debates can be triggered two ways:
   - From Antigravity via MCP (see below) — fully automatic loop.
   - `curl -X POST http://127.0.0.1:8765/api/debate -d '{"question":"..."}'`

## MCP tools (for Antigravity)

HTTP endpoint: `http://127.0.0.1:8765/mcp` (streamable HTTP, JSON-RPC 2.0).
stdio clients: use `daemon/stdio-bridge.js` as the MCP command.

| tool | what it does |
|---|---|
| `ask_council(question, context?, kind?)` | runs the full debate in your Chrome tabs, returns the verdict, stores everything |
| `get_project_state()` | decisions (with reasons/rejected alternatives), open questions, recent verdicts |
| `record_issue(title, error, context?, debate?)` | logs an Antigravity error; `debate: true` resolves it via a council debate |
| `submit_feedback(session_id, accepted)` | trains judge reliability weights (weighted-panel mode) |

Example Antigravity config (streamable HTTP):
```json
{ "mcpServers": { "conclave": { "url": "http://127.0.0.1:8765/mcp" } } }
```
Or stdio:
```json
{ "mcpServers": { "conclave": {
    "command": "node",
    "args": ["C:/path/to/ai-debate-extension/daemon/stdio-bridge.js"] } } }
```

## Engine (daemon)

- **Routing modes** — `conservative` (full rounds, rotating adversary only),
  `balanced` (default: unanimous + avg confidence ≥ 75% skips remaining
  rounds; only disagreeing/low-confidence models are re-asked; adversary
  targets the outlier), `aggressive` (balanced + up to 2 extra rounds with
  a fresh attack angle while avg confidence < 60%).
- **Judge modes** — `single`, `synthesis` (2 judges + chief meta-merge that
  must list judge-vs-judge disagreements), `panel` (all judges vote,
  majority per point), `weighted` (votes weighted by your accept/reject
  feedback; "untrained" note until 10 rated verdicts).
- Every message, decision, open question and issue is stored in SQLite;
  verdict sections are parsed into durable `decisions` and `open_questions`.

## Tests

```
node --test daemon/test/engine.test.js daemon/test/brain.test.js daemon/test/e2e.test.js
```
31 tests: parsing edge cases, routing behavior, judge ensembles,
Brain repositories, and a full-loop e2e with a fake browser (no Chrome).

## Fallback behavior

- Daemon off → popup shows "offline", local v0.2 modes still work.
- Chrome/extension not armed → MCP `ask_council` returns a clear error.
- One judge fails → synthesis degrades to single (noted in the verdict).

Design spec: `docs/superpowers/specs/2026-08-21-complex-version-design.md`
