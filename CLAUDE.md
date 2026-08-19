# CodeV Development Guide

## Git

- **Default branch: `main`** (changed from `develop` — PRs should target `main`)
- `develop` branch is legacy and no longer used

## PR Review & Push Frequency

- **Wait for all AI reviewers before pushing fixes.** This repo uses CodeRabbit (free OSS plan) and cubic. Both trigger on every push, but their review timing differs. Push once, wait for both to finish, then address all comments in a single fix commit.
- **CodeRabbit free plan rate limits (per developer, across all repos):**
  - 200 files per hour
  - After 3 back-to-back reviews, limited to 4 reviews per hour
  - Each push triggers an incremental review — rapid pushes (4+ within an hour) will queue or delay reviews
- **Practical rule:** wait for all reviewers to finish, address all comments, then push fixes together (one or more commits is fine, but aim for a single push). This conserves review quota and avoids triggering redundant review cycles.
- **A green `CodeRabbit pass` does not mean it reviewed anything.** `gh pr checks` prints the same green tick whether CodeRabbit reviewed and found nothing or never ran. The distinction is only in the status description:

  ```bash
  SHA=$(gh pr view <pr-number> --json headRefOid --jq .headRefOid)
  gh api repos/grimmerk/codev/commits/"$SHA"/statuses \
    --jq '.[] | select(.context=="CodeRabbit") | "\(.state) — \(.description)"'
  # "success — Review completed"     ← actually reviewed
  # "success — Review rate limited"  ← never ran; the tick is meaningless
  ```

  **cubic needs a different source, and its review body is not it** — it does not always post one. On PR #137 it reviewed a head, found nothing, and posted no body at all, so a body-based check reported "not reviewed yet". Read the check-run output, which is always present and states the counts:

  ```bash
  gh api repos/grimmerk/codev/commits/"$SHA"/check-runs \
    --jq '.check_runs[] | select(.name|test("cubic")) | "\(.conclusion) — \(.output.summary)"'
  # "success — AI review completed with 1 review. 0 issues found across 4 files"
  ```

  When it *does* post a body, that body embeds the SHA it reviewed (`<!-- cubic:review-post:…:<sha>:… -->`), which is useful corroboration but not a substitute.
- **Findings arrive in three places, and only one of them has an unresolved count.** Inline review comments become threads (`reviewThreads`, resolvable); plain comments are issue comments; and CodeRabbit puts `🧹 Nitpick` and `⚠️ Outside diff range` blocks in the **review body** (`gh api repos/.../pulls/<n>/reviews --jq '.[].body'`), which is neither. Measured on PR #137: `reviewThreads` reported zero unresolved twice while a real finding — once a Major — sat in a review body. A review-body finding has no thread, so answer it with `gh pr comment` quoting it.
- **Whether a bot must review before merging is a judgment, not a rule.** Nothing here requires it, and CodeRabbit's free-plan rate limit can withhold a review indefinitely (it was limited on 4 of 6 heads in one evening on PR #137, largely self-inflicted by pushing four times). Default: wait for both. Escape hatch, when the wait stops being informative — if two attempts on the *current* head both come back rate-limited (the automatic run from the push, then one `@coderabbitai review` posted at least ~30 minutes after the rate-limit timestamp), treat CodeRabbit as unavailable and judge on cubic plus CI. Say so explicitly rather than reporting that both reviewers passed.

## Build Commands

- Electron: `yarn start` (dev), `yarn make` (build)
- Dev mode stale processes: if `yarn start` fails with `EADDRINUSE`, run `pkill -f "Electron.*codev"` first
- Native modules (node-pty, better-sqlite3) are rebuilt automatically by `@electron/rebuild`

## Lint/Format

- `yarn lint` (check), `yarn format` (fix)

## Code Style

- Use TypeScript for all components with strict typing
- Use single quotes for strings
- Use trailing commas in arrays/objects
- Organize imports alphabetically
- Use async/await for asynchronous operations
- Keep components decoupled with clear interfaces

## Architecture Overview

CodeV is an Electron menu bar app with three main features:

### 1. Project Switcher (Projects tab)
- Reads VS Code/Cursor recent projects from IDE SQLite DB
- Scans working directory for subfolders
- Shows git branch, IDE active dot (purple)

### 2. Claude Code Session Manager (Sessions tab)
- Reads `~/.claude/history.jsonl` for session list
- Detects active sessions via `~/.claude/sessions/<PID>.json` (PR #67)
- Live status indicators via Claude Code hooks (PR #92): working (orange pulse), idle (green), needs-attention (orange blink)
- Supports iTerm2, Terminal.app, Ghostty, cmux, VS Code terminal switching
- VS Code session support: detection, `[VSCODE]` badge, URI handler switching (PR #103)
- Quick-launch: `⌘+Enter` on project item launches new session (PR #102)

### 3. Embedded Terminal (Term tab)
- xterm.js + node-pty (same as VS Code's integrated terminal)
- Pre-spawned on app start for instant access
- Custom key handling: `⌘+K` (clear), `Shift+Enter` (multiline), `⌘+←/→` (line start/end)
- Sessions detected as `codev` terminal type (not parent terminal)

### Key Files
- `src/main.ts` — Electron main process, IPC handlers, shortcuts, auto-update
- `src/switcher-ui.tsx` — Main renderer (Projects/Sessions/Terminal tabs)
- `src/popup.tsx` — Settings popup
- `src/claude-session-utility.ts` — Session detection, switching, terminal integration
- `src/session-status-hooks.ts` — Hook management, status file I/O, JSONL scan
- `src/terminal-tab.tsx` — Embedded terminal component
- `src/electron-api.d.ts` — IPC type definitions (replaces `(window as any).electronAPI`)
- `src/epipe-fix.ts` — EPIPE crash prevention for Node 24 dev mode

### Design Documents
- `docs/claude-session-integration-design.md` — Session detection, switching, data sources
- `docs/session-status-hooks-design.md` — Hook architecture, status flow, complexity analysis

## Dev Mode Gotchas

- **EPIPE dialog**: Caused by orphaned Electron processes, not code bugs. Fix: `pkill -f "Electron.*codev"` before restart. Production builds unaffected.
- **webpack hot reload resets React state**: Pulling `.ts/.tsx` changes triggers reload → tab resets to default. Only in dev mode.
- **node-pty spawn-helper**: copy-webpack-plugin copies it but strips execute bit → FixPermissionsPlugin in webpack.main.config.ts restores it.
- **xterm.js production build**: webpack 5.73 innerGraph bug breaks class hierarchy. Fixed by upgrading to 5.90+ and `optimization: { innerGraph: false }`.

## Global Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌃+⌘+R` | Quick Switcher (toggle) |
| `⌃+⌘+T` | Terminal tab (toggle) |
| `⌃+⌘+E` | AI Insight |
| `⌃+⌘+C` | AI Chat |

All customizable in Settings → Shortcuts.
