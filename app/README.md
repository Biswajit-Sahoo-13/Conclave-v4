# AI Council App (v4 — all-in-one Electron)

One installed Windows app: your AI chats inside it, the council engine and
SQLite Brain built in, optional MCP server for Antigravity. No Chrome
extension, no daemon exe.

## Run from source (development)

```
cd app
npm install
npm start
```

First run: click each site in the sidebar (Qwen, GLM, …) and log in once —
sessions persist (`persist:council` partition).

## Build the installer

```
npm run dist
```

Output: `dist/AI Council Setup.exe` (NSIS, one-click install, Start Menu
shortcut).

## Using it

1. Sidebar → open Qwen and GLM, log in (green dot = loaded). Roles are
   pre-assigned: first site debates, second debates + judges. Change roles
   in **Advanced**.
2. Simple mode: paste your idea → **START THE DEBATE** → watch the live
   timeline → verdict is stored in the Brain and (if a project folder is
   set in Advanced) written as `framework.md`.
3. Advanced: routing mode, judge mode, rounds, project name/folder,
   session history with accept/reject feedback (trains weighted judges).
4. MCP button (sidebar bottom): serves `http://127.0.0.1:8765/mcp` for
   Antigravity — `ask_council`, `get_project_state`, `record_issue`,
   `submit_feedback`.

## Engine copies — drift warning

`app/engine/*.js` are copies of the daemon modules (`daemon/db.js`,
`daemon/engine.js`, `daemon/mcp.js`, root `prompts.js`, `sites.js`).
If the daemon changes, re-copy them:

```
cp daemon/db.js daemon/engine.js daemon/mcp.js app/engine/
cp prompts.js sites.js app/engine/
```

SQLite: uses the same `node:sqlite` module; the app Brain lives at
`~/.ai-council/council-app.db` (separate from the extension daemon's DB).

## Selector maintenance

If a chat site changes its DOM, update `engine/sites.js` (same file the
extension uses) — that is the only file that should need touching.
