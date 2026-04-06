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
