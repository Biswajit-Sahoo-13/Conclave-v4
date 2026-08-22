# Conclave — Simple/Advanced UX Design Spec

- Date: 2026-08-22
- Branch: `v1-complex-high-features` (v2)
- Status: approved (two-mode popup, live timeline Simple mode, guided
  checklist; Simple runs the local engine, daemon stays Advanced-only)
- Scope: popup only (`popup.html`, `popup.js`, CSS). Daemon, engine, MCP,
  tests, and `main` branch are untouched.

## 1. Mode toggle

- `Simple | Advanced` segmented switch at the top of the popup.
- Persisted in `chrome.storage.local` (`uiMode`), default `simple`.
- Switching is instant; both views keep their own state (idea text is
  shared — one textarea state, two layouts).

## 2. Simple mode — live debate timeline

Layout: idea textarea → big `▶ START THE DEBATE` button → live timeline
→ result card. Two controls total.

Behavior:

- **Auto roles, zero config.** Detected chat tabs in popup order: tab[0]
  and tab[1] are debaters; judge = tab[2] if a third chat tab exists,
  else tab[1] (the v0.2 engine already permits a debater to judge when
  it is not the only debater).
- **Locked defaults** (not shown in Simple mode): 3 rounds, no early
  stop, adversary mode ON, referee digest ON, language English.
- **Timeline events** — the background worker's existing PROGRESS lines
  are translated in the popup:

  | PROGRESS line (internal) | Timeline bubble (noob) |
  |---|---|
  | `--- Round N/M ---` | divider `Round N of M` |
  | `Sending to X...` | `[chat SVG icon] X — thinking…` |
  | `Sending to X (adversary)...` | `[bolt SVG icon] X — attacking the other answer…` |
  | `X answered (N chars)` | bubble icon switches to the check SVG, text `X answered` |
  | `Compressing round N...` | `[document SVG icon] Referee — summarizing the debate…` |
  | `Asking X if models agree...` | `[check-circle SVG icon] Checking if they agree…` |
  | `Requesting final framework from X...` | `[scales SVG icon] Judge X — writing the final framework…` |
  | `Done. framework.md saved...` | result card |
  | `FAILED: ...` | red card with plain-language cause + actions |

  All timeline icons are inline stroke-based SVGs (no emoji) — the
  implementation later replaced this table's original emoji placeholders.

- Bubbles append bottom-up in a scrollable area; the newest is always
  scrolled into view. Unknown PROGRESS lines render as neutral
  `working…` bubbles (never raw text).
- **Result card**: green check-SVG `Done` + first 200 chars of the verdict +
  button `Open framework.md` (uses `chrome.downloads.show` on the saved
  download id; the local engine already saves via the Downloads API).
- **Error translation**: DOM/extraction failures render as
  "I couldn't read the answer from the {site} tab" plus two buttons:
  `Try again` (rerun) and `Use Manual mode` (switches to Advanced with
  manual mode visible).

## 3. First-run guided checklist

Shown in Simple mode whenever fewer than 2 supported chat tabs are
detected:

```
① Open Qwen — chat.qwen.ai      [✓ detected]
② Open GLM  — chat.z.ai         [waiting…]
③ Press Start                   [locked until ① ②]
```

- The popup re-scans `chrome.tabs.query` every 3 seconds while open;
  steps auto-check when a matching tab appears.
- Clicking a step opens that site in a new tab.
- Step 3 unlocks when ≥2 chat tabs exist. No mention of daemon, MCP,
  SQLite, rosters, or selectors anywhere in Simple mode.

## 4. Advanced mode

Exactly the current v1.0 popup, unchanged: role matrix, rounds, early
stop, adversary, digest, Auto / Manual / Resolve buttons, Daemon panel
(status, project, routing + judge modes, sessions, feedback, arm).
One addition: the manual-mode block and daemon panel stay as-is; no
Simple-mode strings leak into Advanced.

## 5. Non-goals

- No changes to background engine, prompts, daemon, MCP, or tests.
- No new permissions. `chrome.downloads.show` is covered by the existing
  `downloads` permission; the tab rescan uses the existing `tabs`
  permission.
- No onboarding tour beyond the checklist; no analytics.

## 6. Testing

- Popup logic is UI-bound; automated coverage stays with the existing 31
  daemon tests (unaffected).
- Manual verification checklist:
  1. Fresh profile → popup opens in Simple with checklist; steps
     auto-check as tabs open.
  2. Two tabs → Start runs a full local debate; timeline shows expected
     bubbles in order; result card opens framework.md.
  3. Kill one tab mid-run → red error card with `Try again` /
     `Use Manual mode`.
  4. Toggle to Advanced → all v1.0 controls present and functional.
  5. Toggle back → still Simple after reopening popup.
