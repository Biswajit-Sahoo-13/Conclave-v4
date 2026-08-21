# AI Council v1 "Complex" — Extension + Daemon

Two parts, two branches:

- **`main`** — v0.2: standalone Chrome extension (local engine, manual mode).
  Works with zero setup.
- **`v1-complex-high-features`** (this branch) — v1.0: adds the local
  **council daemon** (Node.js, zero npm dependencies) with a real SQLite
  **Project Brain**, **adaptive routing**, **multi-judge ensembles**, and an
  **MCP server** that lets Antigravity run debates automatically.

## Quick start (daemon)

1. Start the daemon: double-click `daemon/start-council.bat`
   (or `node daemon/server.js`). It listens on `http://127.0.0.1:8765`
   and stores the Brain in `%USERPROFILE%\.ai-council\council.db`.
2. Reload the extension in `chrome://extensions` (v1.0.0 from this branch).
3. Open your chat tabs, open the popup, pick debaters + judge as usual.
4. In the **Daemon** panel: set a project name and (optionally) a project
   folder — verdicts get written there as `framework.md` / `resolution.md`.
   Choose routing mode and judge mode, then check **Arm daemon mode**.
5. Now debates can be triggered two ways:
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
{ "mcpServers": { "ai-council": { "url": "http://127.0.0.1:8765/mcp" } } }
```
Or stdio:
```json
{ "mcpServers": { "ai-council": {
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
