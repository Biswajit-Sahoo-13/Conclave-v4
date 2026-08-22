# AI Council — Desktop App Roadmap: v3 (portable daemon.exe) + v4 (Electron all-in-one)

- Date: 2026-08-22
- Status: approved by user
- Branches: v3 on `v1-complex-high-features`; v4 on new `v4-electron-app`

## v3 — Portable `council-daemon.exe`

Goal: replace `start-council.bat` with a single portable exe. The Chrome
extension and all v1.1 behavior stay unchanged.

Build pipeline (all scripted in `daemon/build-exe.bat`):

1. `daemon/build-bundle.js` — zero-dependency bundler: wraps
   `server.js`, `engine.js`, `db.js`, `mcp.js`, `prompts.js` into one
   CommonJS file with a tiny module registry (native `node:*` requires
   pass through; `require.main` emulated so server self-starts).
2. Node SEA (Single Executable Application, official):
   `node --experimental-sea-config sea-config.json` → blob;
   copy `node.exe` → `council-daemon.exe`;
   inject blob via `npx --yes postject` with the NODE_SEA sentinel fuse.
3. Output: `daemon/council-daemon.exe` (~100 MB, portable, no install).

Runtime contract (identical to `node daemon/server.js`): listens on
127.0.0.1:8765, Brain at `~/.ai-council/council.db`, MCP at `/mcp`.

Exclusions: `council-daemon.exe`, `sea-prep.blob`, `bundle.cjs` are build
artifacts — git-ignored; sources remain the single truth.

Verification (automated before delivery): launch exe → `/status` 200 →
MCP `initialize` handshake OK → `/api/project` persists → kill.

## v4 — All-in-one Electron app (installer)

Goal: one installed Windows app; no Chrome, no extension, no daemon exe.

- `app/` project on branch `v4-electron-app`; npm deps: `electron`,
  `electron-builder` (+ `better-sqlite3` fallback). Only place in the
  project with npm dependencies.
- Main process reuses the engine: copies of `daemon/{db,engine,mcp}.js`
  + `prompts.js` (drift noted in app README); HTTP + MCP server on
  8765 in-process (toggle, off by default).
- UI: sidebar with site tabs (Qwen, GLM, Gemini, ChatGPT, Claude) as
  `<webview>` guests with a persistent partition (logins survive);
  control panel = ported Simple timeline + Advanced panel; IPC via
  preload bridge instead of chrome.* APIs.
- Automation: main process runs the send-and-wait cycle inside guest
  webContents via `executeJavaScript` (same `sites.js` selector configs;
  content-script logic ported to an injected string).
- SQLite: prefer built-in `node:sqlite` if the Electron Node supports
  it, else `better-sqlite3` adapter with the same Brain schema.
- Packaging: electron-builder NSIS → `AI Council Setup.exe`
  (~70 MB): Program Files, Start Menu shortcut.

Risks (accepted): npm download size; `node:sqlite` availability in
Electron's Node (adapter fallback); site bot-walls inside Electron
(mitigate with normal user-agent).

## Out of scope

- Auto-update channels, code signing, macOS/Linux builds.
- Changes to v2 extension/daemon behavior.
