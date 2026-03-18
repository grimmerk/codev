# Claude Code Session List Integration Design

## Goal

Add Claude Code session history to the CodeV Quick Switcher, allowing developers to quickly search, browse, and resume past sessions — just as fast as switching VS Code/Cursor projects.

## Claude Code File Structure

```
~/.claude/
├── history.jsonl                          # Global prompt log (append-only, ~3MB)
├── cache/
│   └── session-metadata.db                # SQLite cache DB (~1.5MB, NOT real-time)
├── projects/
│   ├── -Users-you-git-my-project/         # Encoded project path (/ → -)
│   │   ├── sessions-index.json            # Per-project session index (may not exist)
│   │   ├── abc123.jsonl                   # Full conversation log for session abc123
│   │   ├── abc123/                        # Session subdirectory
│   │   │   └── tool-results/              # Tool output files
│   │   └── memory/                        # Project-level memory files
│   └── -Users-you-git-another/
│       └── ...
├── settings.json                          # User settings
├── session-monitor-titles.json            # c9watch custom titles (if c9watch installed)
└── session-monitor-names.json             # c9watch legacy names (unused)
```

## Data Sources

### 1. `~/.claude/history.jsonl` — Primary (used in MVP)

Global append-only log. A line is appended **every time the user sends a prompt** (not just first/last).

```json
{"display":"Fix the auth bug...","timestamp":1759146405713,"project":"/Users/you/git/my-project","sessionId":"abc-123-def"}
```

| Field | Description |
|-------|-------------|
| `display` | User's prompt text |
| `timestamp` | Unix milliseconds |
| `project` | Original project path |
| `sessionId` | UUID |

Properties:
- **Real-time** (appended on every prompt)
- Single file, ~3MB, fast to read (~40ms in Node.js)
- Requires deduplication (multiple lines per session — one per user prompt)
- No `summary`, `title`, or `custom-title` fields
- `messageCount` can only count user prompts (not assistant responses)

### 2. `~/.claude/projects/{path}/{session-id}.jsonl` — Secondary (used for custom titles)

Full conversation log for a single session. One JSON object per line.

**Entry types:**

| Type | Description |
|------|-------------|
| `user` | User prompt (`message.content` as string or array) |
| `assistant` | Claude's response (`message.content` array with text/tool_use/thinking blocks) |
| `custom-title` | User-defined title via `/title` or `/rename` command |
| `summary` | Conversation summary (from `/compact`) |
| `file-history-snapshot` | Checkpoint data for file edits |
| `progress` | Streaming progress updates |
| `queue-operation` | Internal queue state |
| `system` | System messages |

**The `custom-title` entry (important):**
```json
{"type":"custom-title","customTitle":"my-session-name","sessionId":"abc-123-def"}
```

Key facts about custom titles:
- This is the **only** place Claude Code stores `/title` names — there is no centralized title file
- `history.jsonl` and `sessions-index.json` do NOT contain this field
- Can appear **anywhere** in the file (not just at the beginning)
- A session can be renamed multiple times; each rename appends a new entry
- The **last** `custom-title` entry is the current title
- Empty `customTitle` clears any previous title

**Performance notes:**
- 170 JSONL files, total ~771MB
- Some files are very large (80–108MB for long sessions)
- Grepping 100 files for custom-title takes ~2s (I/O bound)
- Currently uses `grep "custom-title" <file> | tail -1` per file, async parallel via `Promise.all`
- Results cached with 5s TTL

### 3. `~/.claude/cache/session-metadata.db` — Not used in MVP

SQLite database with FTS5 index, rich metadata.

**Problem: This is a cache DB that is NOT updated in real-time.** Testing showed data can lag days behind (e.g., DB latest 3/15, actual latest session 3/18).

**Schema — `session_metadata` table:**
```sql
CREATE TABLE session_metadata (
    path TEXT PRIMARY KEY,
    mtime INTEGER NOT NULL,
    project TEXT NOT NULL,
    session_id TEXT NOT NULL,
    first_timestamp TEXT,
    last_timestamp TEXT,
    message_count INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    models_used TEXT NOT NULL,
    has_subagents INTEGER NOT NULL,
    first_user_message TEXT,
    data BLOB NOT NULL                  -- binary blob (format undocumented)
);
```

**Other tables:**

| Table | Purpose |
|-------|---------|
| `activity_cache` | Tool call counts and alert counts per session |
| `activity_alerts` | Alerts by severity/category |
| `aggregate_stats` | Global counters (total_sessions, total_messages), auto-updated via triggers |
| `cache_metadata` | Schema version (currently `6`) |
| `session_fts` | FTS5 virtual table for full-text search on `first_user_message` and `models_used` |

Stats: 852 sessions, 1.5MB, queries ~5ms. Could be used in Phase 2 for enrichment (token stats, model info).

### 4. `~/.claude/projects/{path}/sessions-index.json` — Not used in MVP

Per-project session index. Directory name encoding: path with `/` replaced by `-`.

```json
{
  "version": 1,
  "entries": [{
    "sessionId": "abc-123-def",
    "fullPath": "/Users/you/.claude/projects/.../abc-123-def.jsonl",
    "fileMtime": 1770028945180,
    "firstPrompt": "Fix the auth bug...",
    "summary": "OAuth token refresh bug fix",
    "messageCount": 42,
    "created": "2026-02-01T10:00:00Z",
    "modified": "2026-02-01T12:30:00Z",
    "gitBranch": "fix/auth-bug",
    "projectPath": "/Users/you/git/my-project",
    "isSidechain": false,
    "prNumber": 42,
    "prUrl": "https://github.com/...",
    "prRepository": "owner/repo"
  }],
  "originalPath": "/Users/you/git/my-project"
}
```

**Problems:**
- **Not guaranteed to exist.** Some projects never get this file despite having many sessions.
- `summary` is AI-generated and not always present.
- `prNumber`/`prUrl`/`prRepository` only present for PR-related sessions.
- Update timing is unclear.

Could supplement with branch name, AI summary, and PR info in Phase 2.

### Data Source Comparison

| | `history.jsonl` | `session-metadata.db` | `projects/*/*.jsonl` | `sessions-index.json` |
|---|---|---|---|---|
| **Real-time** | Yes | No (cache, can lag days) | Yes | Unclear |
| **Speed** | Fast (~40ms, 3MB) | Very fast (~5ms) | Slow (scan dirs, 771MB) | Medium (per-project) |
| **Data richness** | Low (prompt text) | Medium (tokens/models) | High (full conversation) | Medium (branch/summary/PR) |
| **Reliability** | High (append-only) | Medium (may be stale) | High | Low (may be missing) |
| **Used by** | c9watch history, CodeV | — | claude-history | c9watch monitor |
| **Best for** | Session list + search | Stats + enrichment | Full-text search + titles | Branch/PR supplement |

### Data Retention

The "30 days" in Claude Code's data-usage docs refers to **server-side** retention, not local. Local files are **not observed to be auto-deleted** — `history.jsonl` entries persist 5+ months, session JSONL files persist indefinitely. However, Claude Code could introduce local cleanup in a future version.

## Current Implementation

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Renderer (switcher-ui.tsx)                               │
│  ┌─────────────────────────────────────────────────────┐│
│  │ fetchClaudeSessions()                               ││
│  │  1. getClaudeSessions() → show list immediately     ││
│  │  2. detectActiveSessions() → update green dots      ││
│  │  3. loadCustomTitles() → update title display       ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
                    ↕ IPC
┌─────────────────────────────────────────────────────────┐
│ Main Process (claude-session-utility.ts)                 │
│  - readClaudeSessions(): parse history.jsonl (cached)   │
│  - detectActiveSessions(): async ps + lsof (cached)    │
│  - loadCustomTitles(): async parallel grep (cached)    │
│  - openSessionInITerm2(): AppleScript via temp .scpt   │
└─────────────────────────────────────────────────────────┘
```

### Non-blocking loading pattern (SWR-like)

1. **Immediate**: Session list from `history.jsonl` (cached, ~0ms warm / ~40ms cold)
2. **Background (~0.5s)**: Active session detection via async `ps aux` + `lsof`
3. **Background (~2s)**: Custom titles via async parallel `grep` on 100 JSONL files

All background operations use async `exec` (not `execSync`) to avoid blocking Electron's main thread. Results cached with 5s TTL. Cache is NOT invalidated on window focus (TTL expiry is sufficient).

### Active session detection

- For `claude --resume <id>` processes: session ID extracted directly from command args
- For `claude -r` processes (no explicit ID): `lsof -p <pid> -Fn | grep "^n/" | head -1` finds working directory, then matched against most recent session for that project in `history.jsonl`
- **Known limitation:** Only detects sessions in terminals, not VS Code integrated terminal

### Custom title extraction

`grep "custom-title" <file> | tail -1` on each session's JSONL. Must read entire file since title position is unpredictable (user can `/title` at any point, multiple times). The last occurrence is the current title.

**Workaround for grep matching false positives:** Use `"type":"custom-title"` pattern to avoid matching tool call outputs that mention "custom-title" as a string.

### iTerm2 integration

| Action | Method |
|--------|--------|
| **Detect** | `ps aux` → `ps -o tty= -p <pid>` → get tty |
| **Switch** | AppleScript: iterate windows/tabs/sessions, match tty `ends with` |
| **Launch (tab)** | AppleScript: `create tab with default profile` + `write text` |
| **Launch (window)** | AppleScript: `create window with default profile` + `write text` |

**Workarounds discovered:**
- `ps -o tty=` output has trailing whitespace → pipe through `tr -d '[:space:]'`
- AppleScript inline `-e '...'` fails with embedded double quotes → write to temp `.scpt` file, execute with `osascript <file>`

## UI Design

### Mode switching

Header with toggle buttons + `Tab` key:
```
🤖 CodeV Quick Switcher  [Projects] [Sessions]  [Settings]
```

`Tab` is intercepted in react-select's `onKeyDown` (Projects mode) to prevent default behavior and switch to Sessions mode.

### Session item layout

```
● project-name · "custom title" · first prompt text  →  last prompt    N msgs  Xm ago
```

- Green dot: active session (flexShrink 0, doesn't affect alignment)
- Project name: bold white
- Custom title: green, in quotes, truncated to 30 chars
- First prompt: grey (`#b0b0b0`)
- Last prompt: amber (`#e8a946`)
- Right side: message count + relative time

Entire row: `overflow: hidden`, `whiteSpace: nowrap`, `textOverflow: ellipsis`

### Session display modes (Settings)

| Mode | Shows |
|------|-------|
| First Prompt (default) | First user message (grey) |
| Last Prompt | Last user message (amber) |
| First + Last | First (grey) → Last (amber) |

**Note:** "Last prompt" is last **user** prompt from `history.jsonl`, not assistant response. Getting assistant's last response requires reading full session JSONL — may need Rust native module.

### Search

Multi-word AND: all words must match against `projectName + project path + firstUserMessage`. Same behavior as Projects mode. Search highlight via `react-highlight-words`.

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `⌘⌃R` | Open Quick Switcher |
| `Tab` | Toggle Projects / Sessions |
| `↑` / `↓` | Navigate session list |
| `Enter` | Open/resume selected session |
| `Esc` | Clear search, or hide window |

## Settings

In the Settings popup:

| Setting | Options | Default | Storage |
|---------|---------|---------|---------|
| Session Terminal | New Tab / New Window | New Tab | `electron-settings` |
| Session Preview | First Prompt / Last Prompt / First + Last | First Prompt | `electron-settings` |

## Terminal Support Matrix

| Terminal | Detect | Switch | Launch |
|----------|--------|--------|--------|
| iTerm2 ✅ | `ps` + `lsof` + tty | AppleScript tty focus | AppleScript: new tab/window + execute |
| Terminal.app | `ps` + tty | AppleScript focus | AppleScript: new tab + execute |
| Ghostty | `ps` + parent check | AppleScript activate | Activate + paste command / clipboard |
| cmux | `ps` + `cmux list-panes` | `cmux select-workspace` | Activate + paste command / clipboard |
| Custom | — | — | User command template / clipboard |

**MVP: iTerm2 only.** Others planned for Phase 2+.

## Phase Plan

### Phase 1 (MVP) — ✅ Implemented

- Session list from `history.jsonl` sorted by last activity
- Multi-word AND search on project name + first prompt
- `Tab` key to toggle Projects / Sessions
- Active session detection (green dot) via async process scanning
- Custom title display via async grep
- Open/resume in iTerm2 (new tab or window)
- Session Terminal + Preview mode settings
- Color-coded message types (first=grey, last=amber, title=green)
- Non-blocking SWR loading with 5s TTL cache

### Phase 2 (Planned)

- Terminal.app / Ghostty / cmux support
- Last assistant response (requires JSONL parsing — Rust native module candidate)
- Branch name from `sessions-index.json`
- Full-text search across conversation content
- Bookmark functionality
- Duplicate session prevention (detect + switch instead of launch)
- Custom title as searchable field
- UI: two-line layout for better alignment and information density

### Phase 3 (Future)

- Session preview panel (conversation summary)
- Cost/token statistics from `session-metadata.db`
- Custom terminal command template
- PR info display from `sessions-index.json`

## Technical Decisions

### TypeScript vs Rust

TypeScript is sufficient for MVP. `history.jsonl` reading (~40ms) and session list rendering are fast. Custom title grep is I/O bound — Rust wouldn't help significantly.

**Rust native module justified for:** full JSONL parsing (last assistant response, full-text search across 771MB), where the 5-10x speedup matters. claude-history achieves <1s for 170 files using Rust + rayon parallel.

### `history.jsonl` vs `session-metadata.db`

`session-metadata.db` has richer data but is a stale cache. `history.jsonl` is always up to date. Same approach used by c9watch's history page.

### grep vs full JSONL parsing for custom titles

`grep "custom-title" <file> | tail -1` avoids parsing multi-MB JSON files. Async parallel `exec` keeps it non-blocking. ~2s for 100 files (I/O bound on 771MB total).

**Future optimization options:**
- Rust native module for parallel scanning
- mtime-based cache invalidation (only re-grep changed files)
- Build persistent custom title index file

## References

- [c9watch](https://github.com/minchenlee/c9watch) — Session monitoring + history search (Tauri/Rust/Svelte)
- [claude-history](https://github.com/raine/claude-history) — Rust TUI for session browsing, full-text search, resume/fork
- [Session Data Sources wiki](https://github.com/grimmerk/c9watch/wiki/Session-Data-Sources-and-Architecture) — Comprehensive research on Claude Code's data files
- [cpark design](cpark-design.md) — Session bookmark/parking concept (not yet implemented)
