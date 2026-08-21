# AI Council v1 "Complex" — Design Spec

- Date: 2026-08-21
- Branch: `v1-complex-high-features`
- Status: approved by user (architecture, routing modes, judge modes, MCP, UI, testing)

## 1. Goal

Upgrade AI Council from a standalone Chrome extension (v0.2) to a two-part
system: a local Node.js **council daemon** owning a real SQLite **Project
Brain**, an **adaptive routing** debate engine, a **multi-judge ensemble**,
and an **MCP server** that lets Antigravity run debates automatically.
The extension keeps working standalone (v0.2 local mode) when the daemon
is off.

## 2. Architecture

```
ANTIGRAVITY ──MCP──► COUNCIL DAEMON (Node.js, zero npm deps)
                        │  node:http server on 127.0.0.1:8765
                        │  node:sqlite Project Brain (council.db)
                        │  adaptive engine + judge ensemble
                        ▼ HTTP (extension polls ~2/s)
                  CHROME EXTENSION
                        ▼ send prompt / capture answer
                  logged-in chat tabs (Qwen, GLM, Gemini, ChatGPT, Claude)
```

Constraints:

- **Zero npm dependencies.** Only `node:http`, `node:sqlite`, `node:path`,
  `node:crypto`. User runs the daemon via `start-council.bat`. Node >= 22.5
  required (`node:sqlite`); user has Node 25.
- Daemon ↔ extension: plain HTTP. Extension background service worker polls
  `POST /agent/poll` every 500 ms when armed; commands carry a tab hint
  (site name) and the extension executes SEND_AND_WAIT on a matching open
  tab and posts the result to `POST /agent/result`.
- Extension fallback: if daemon unreachable, popup shows "daemon offline —
  local mode" and all v0.2 behavior remains.

## 3. Repository layout

```
/                           (repo root = extension, unchanged deploy story)
  manifest.json             v1.0.0, +host_permissions http://127.0.0.1:8765/*
  background.js             + daemon poller agent alongside local engine
  popup.html / popup.js     + daemon panel (status, project, modes, history,
                            feedback buttons)
  prompts.js                + CommonJS export tail (shared with daemon)
  sites.js, content.js      unchanged
daemon/
  server.js                 HTTP routes + wiring
  db.js                     node:sqlite schema + repositories (WAL mode)
  engine.js                 adaptive routing + judge ensemble + session runner
  mcp.js                    streamable-HTTP MCP endpoint (JSON-RPC 2.0)
  stdio-bridge.js           line-delimited JSON-RPC stdin -> daemon HTTP
  fake-browser.js           test double: simulates chat tabs
  start-council.bat         starts daemon, opens council.db in %USERPROFILE%
  test/
    engine.test.js          routing decisions, confidence parsing, judges
    brain.test.js           repositories CRUD + relations
    e2e.test.js             full loop with fake-browser, no Chrome
docs/superpowers/specs/     this document
```

## 4. Project Brain (SQLite schema)

```sql
CREATE TABLE projects(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE sessions(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,              -- 'framework' | 'question'
  idea TEXT NOT NULL,
  routing_mode TEXT NOT NULL,      -- 'conservative'|'balanced'|'aggressive'
  judge_mode TEXT NOT NULL,        -- 'single'|'synthesis'|'panel'|'weighted'
  rounds_planned INTEGER, rounds_used INTEGER,
  status TEXT NOT NULL DEFAULT 'running',  -- running|done|failed
  verdict TEXT, created_at TEXT DEFAULT (datetime('now')), finished_at TEXT
);
CREATE TABLE messages(
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  round_idx INTEGER NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL,              -- debater|adversary|judge|meta|digest
  text TEXT NOT NULL,
  confidence REAL,                 -- parsed NN% or NULL
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE decisions(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  session_id INTEGER REFERENCES sessions(id),
  topic TEXT NOT NULL, decision TEXT NOT NULL,
  reason TEXT, rejected TEXT,      -- rejected alternatives (free text)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE open_questions(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',   -- open|resolved
  resolved_by_session INTEGER
);
CREATE TABLE issues(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL, error TEXT, context TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open|resolved
  resolution TEXT, confidence REAL, created_at TEXT
);
CREATE TABLE model_stats(
  model TEXT PRIMARY KEY,
  debates INTEGER DEFAULT 0, judged INTEGER DEFAULT 0,
  accepted INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0
);
```

Weighted-judge weight = `accepted / (accepted + rejected)` when the model has
>= 1 rated verdict, else 1.0. Popup displays "weights untrained" until the
project has >= 10 rated verdicts total.

## 5. Adaptive routing engine

Confidence parsing: regex `/CONFIDENCE:\s*(\d{1,3})\s*%/i` on the last 400
chars of an answer; null when absent (treated as low).

After each round the engine computes: per-model confidence, judge
AGREE/DISAGREE (existing JUDGE_AGREE_PROMPT), average confidence.

- **conservative** — always run `rounds_planned`; routing only assigns the
  rotating adversary (v0.2 behavior).
- **balanced** (default) —
  - all agree AND avg confidence >= 75 → skip remaining rounds, judge now;
  - else next round re-asks ONLY models that disagreed or scored < 75;
    agreeing models keep their previous answer as current;
  - adversary role goes to the biggest outlier (largest confidence gap to
    the group median; tie → lowest confidence).
- **aggressive** — balanced rules, plus when avg confidence < 60 after the
  last planned round, extend by up to 2 extra rounds using a fresh attack
  prompt variant (attacker asked to find a completely different angle).

Never exceeds: planned rounds + 2. Round cap and all thresholds constant at
top of `engine.js`.

## 6. Judge ensemble

Verdict request per judge = existing JUDGE_FINAL_PROMPT + transcript.
Roles: checked judge tabs are judges; one is designated **chief** (first
checked) — chief also acts as meta-judge.

- **single** — only the chief judges.
- **synthesis** (default) — two judges verdict independently; chief merges
  with META_PROMPT: "two judge verdicts follow; produce one final framework;
  list every judge-vs-judge disagreement you had to resolve under
  '## JUDGE DISAGREEMENTS RESOLVED'".
- **panel** — every judge verdicts; per-section merge by chief, appending
  "(votes: A for, B against)" to each DISAGREEMENTS RESOLVED entry.
- **weighted** — panel mechanics, but before merging the chief receives each
  verdict tagged with that judge's accuracy weight and is instructed to
  favor higher-weight judges on disputes.

Judge call failure: retry once (existing), then continue with remaining
judges; if ALL judges fail the session fails. Synthesis with only one
available judge degrades to single mode (logged in session record).

## 7. MCP server

Streamable HTTP at `POST /mcp` — JSON-RPC 2.0: `initialize`,
`notifications/initialized`, `tools/list`, `tools/call`. Single client
session state (Antigravity) is sufficient; no auth (localhost only).
`stdio-bridge.js` for stdio-only clients: reads JSON-RPC per line on stdin,
forwards to daemon HTTP, writes responses to stdout.

Tools:

| tool | params | returns |
|---|---|---|
| `ask_council` | `question`, `context?`, `kind?` (framework\|question) | verdict markdown + session_id |
| `get_project_state` | — | decisions, open questions, last 5 verdicts |
| `record_issue` | `title`, `error`, `context?`, `debate?` (bool) | issue_id (+ verdict if debated) |
| `submit_feedback` | `session_id`, `accepted` (bool) | updates model_stats |

`ask_council` execution: create session in Brain → engine runs the debate by
dispatching tab commands to the extension (timeout 5 min per model call;
overall 20 min) → store messages/verdict/decisions → also write
`framework.md` or `resolution.md` into the project `root_path` if set.
If the extension is not polling (Chrome closed), return JSON-RPC error with
message "open Chrome with the AI Council extension".

## 8. Extension changes

- `manifest.json`: version 1.0.0; host_permissions +=
  `"http://127.0.0.1:8765/*"`.
- `background.js`: new agent loop — when armed (popup toggle "Daemon mode",
  persisted), poll every 500 ms; on command `{op:'send_and_wait', site,
  prompt}` pick a tab whose host matches the site (prefer the configured
  debater/judge mapping sent at session start), run existing
  SEND_AND_WAIT via chrome.tabs.sendMessage, post result. Local v0.2
  engine code path untouched.
- `popup`: daemon panel — status dot (polls `GET /status`), project name,
  judge-mode + routing-mode dropdowns, last 5 sessions with verdict
  previews, per-session Accept/Reject buttons (POST /feedback), and
  "daemon offline — local mode" banner when unreachable.
- `prompts.js`: append `if (typeof module !== 'undefined') module.exports = {...}`
  so the daemon requires the same file the extension loads as a script.
  New prompts added: META_PROMPT (synthesis), ATTACK_ANGLE_PROMPT
  (aggressive extra rounds).

## 9. Error handling

- Daemon down → extension banner + local mode (no data loss; local debates
  simply don't reach the Brain).
- Chrome/extension down → MCP ask_council returns instructive error.
- SQLite: WAL mode; daemon is the only writer; queries wrapped, failures
  logged to stderr + returned as 500s.
- Per-model call: 1 retry after 5 s (matches v0.2).
- Engine exceptions mark session `failed` with the error stored.

## 10. Testing

`node --test daemon/test/`:

- `engine.test.js` — confidence parser edge cases; balanced skip logic;
  targeted re-ask set computation; outlier/adversary selection; aggressive
  extension cap; judge degradation to single when second judge fails.
- `brain.test.js` — schema migration idempotency, CRUD, relations, weight
  computation, feedback updates.
- `e2e.test.js` — fake-browser (scripted answers with confidence lines and
  forced disagreement) drives a full balanced+synthesis session through the
  HTTP API; asserts stored messages, decisions extracted, verdict markdown,
  framework.md written to a temp dir.

Manual verification (not automatable here): real tabs on chat.qwen.ai and
chat.z.ai, Antigravity MCP handshake against its actual client strictness.

## 11. Out of scope (explicit)

- No auth/multi-user on the daemon (localhost single user).
- No summarization models beyond the referee digest.
- No auto-detection of Antigravity errors without it calling MCP.
- v0.2 standalone/manual modes are not altered.
