# VS Code Claude Code Session Support

## Goal

Add VS Code Claude Code sessions to CodeV's session list, enabling detection, display, switching, resuming, and launching — on par with terminal-based sessions.

## Background

Claude Code runs inside VS Code as an extension (`entrypoint: "claude-vscode"`). These sessions share the same `~/.claude/` data layer as CLI sessions, but with key differences:

- **Not in `history.jsonl`**: VS Code sessions are excluded from the global history log (upstream bugs [#24579](https://github.com/anthropics/claude-code/issues/24579), [#18619](https://github.com/anthropics/claude-code/issues/18619))
- **No `/rename` support**: Cannot set custom titles ([#33165](https://github.com/anthropics/claude-code/issues/33165))
- **Has `ai-title`**: Auto-generated titles stored in session JSONL (e.g., `"Casual greeting and session start"`)
- **URI handler available**: `vscode://anthropic.claude-code/open?session=<UUID>` can switch to a specific session tab
- **Hooks work**: Status hooks fire for VS Code sessions (verified experimentally)

## Data Availability

| Data | Available | Source |
|------|-----------|--------|
| Active session metadata | Yes | `~/.claude/sessions/<PID>.json` with `entrypoint: "claude-vscode"` |
| Session status (working/idle/needs-attention) | Yes | Hooks write to `~/.claude/codev-status/{sessionId}.json` |
| Conversation history | Yes | `~/.claude/projects/{path}/{sessionId}.jsonl` (same format as CLI) |
| AI-generated title | Yes | `ai-title` entry in session JSONL (written once per session) |
| Custom title (`/rename`) | No | Not supported in VS Code extension |
| First/last user prompt | Yes | Readable from session JSONL head/tail |
| Last assistant response | Yes | Readable from session JSONL tail (existing algorithm) |
| Git branch | Yes | In JSONL entries |
| PR links | Yes | If created during session |
| Closed session record | **No** | Not in `history.jsonl` — requires workaround |
| IDE workspace info | Yes | `~/.claude/ide/<PID>.lock` (workspace folders, IDE name) |

## Architecture

### Layer 1: Detection

**Active sessions** — Remove the `entrypoint !== 'cli'` filter in `detectActiveSessions()` (line 635 of `claude-session-utility.ts`). VS Code sessions will appear alongside CLI sessions.

**Closed sessions** — Two-pronged approach:
1. **Hooks index (real-time)**: Extend `codev-status-hook.sh` to append a record to `~/.claude/codev-status/vscode-sessions.jsonl` on `SessionStart` when `entrypoint === "claude-vscode"`. This captures new VS Code sessions as they start.
2. **JSONL scan (startup, one-time)**: On app startup, scan `~/.claude/projects/*/` for JSONL files with `entrypoint: "claude-vscode"` in their first line. Merge results with hooks index. Cache the result.

### Layer 2: Display

- **Badge**: Show `[VSCODE]` badge (similar to existing `[GHOSTTY]`, `[ITERM2]` badges)
- **Title**: Use `ai-title` from JSONL. Priority: `custom-title > ai-title > first prompt`
  - Also apply `ai-title` fallback to CLI sessions that lack `/rename` titles
- **Status dot**: Same as CLI sessions (hooks already fire for VS Code)
- **First/last prompt**: Read from JSONL head/tail (shared algorithm with existing "show final assistant message")
- **Search**: Include `ai-title` in search filter

### Layer 3: Switch (active sessions)

Use the VS Code URI handler:
```
open "vscode://anthropic.claude-code/open?session=<UUID>"
```

Verified behavior:
- Existing session UUID: switches to that session tab in VS Code
- First call requires user to allow the URI handler (one-time dialog)
- No Accessibility API or AppleScript needed
- MAS-compatible (uses standard URI scheme)

### Layer 4: Resume (closed sessions)

Same URI handler works for closed sessions:
```
open "vscode://anthropic.claude-code/open?session=<UUID>"
```

If the session belongs to the current workspace, it resumes in a new tab.

### Layer 5: Launch (new session)

```
open "vscode://anthropic.claude-code/open"
open "vscode://anthropic.claude-code/open?prompt=<url-encoded-text>"
```

### Layer 6: Title Enrichment (`ai-title`)

Add `ai-title` grep to `loadSessionEnrichment()` alongside existing `custom-title` grep. Merge into the titles map with priority: `custom-title > ai-title`.

Format in JSONL: `{"type":"ai-title","sessionId":"...","aiTitle":"..."}`

Characteristics:
- Written once per session (does not change)
- Present in both VS Code and newer CLI sessions
- AI-generated, descriptive (e.g., "Casual greeting and session start")

## Implementation Plan

### Phase 1: Active VS Code sessions (this PR)

1. Remove `entrypoint` filter in `detectActiveSessions()`
2. Return `entrypoint` field from session JSON to caller
3. Add `[VSCODE]` badge rendering in `switcher-ui.tsx`
4. Add `ai-title` support to `loadSessionEnrichment()`
5. Route VS Code session clicks to URI handler (`open "vscode://..."`)
6. Add `ai-title` to search filter
7. Add "New VS Code Session" launch option

### Phase 2: Closed VS Code sessions (follow-up)

1. Extend hooks to record VS Code session starts in index file
2. Add JSONL scan for historical VS Code sessions on startup
3. Merge closed VS Code sessions into session list
4. Handle resume via URI handler

## Performance

| Operation | Cost | Notes |
|-----------|------|-------|
| Detection (active) | +0ms | Same `sessions/*.json` read, just removed filter |
| ai-title grep | +~1ms/session | Parallel with existing greps, single pass possible |
| URI handler switch | ~50ms | Single `open` command |
| Hooks index write | ~5ms/event | Only on SessionStart, append-only |
| JSONL scan (startup) | ~50-200ms | One-time, cached. Reads first line of each JSONL |

## VS Code URI Handler Reference

| URL | Effect |
|-----|--------|
| `vscode://anthropic.claude-code/open` | Open new Claude Code tab |
| `vscode://anthropic.claude-code/open?session=<UUID>` | Switch to / resume session |
| `vscode://anthropic.claude-code/open?prompt=<text>` | Open with pre-filled prompt |

First call shows a permission dialog in VS Code. User can check "Do not ask me again" to suppress future dialogs.

## Alternatives Considered

### Accessibility API (AXUIElement)
- Can find Claude Code tab in VS Code's AX tree (`AXRadioButton title="Claude Code"`)
- More complex, requires Accessibility permission, not MAS-compatible
- **Decision**: Not needed — URI handler provides better precision (session-level vs tab-level)

### `code -r <path>` (c9watch / claude-control approach)
- Only switches to VS Code window, cannot target specific session
- **Decision**: URI handler is strictly better

### Wait for upstream `history.jsonl` fix
- Upstream bugs #24579, #18619 may eventually add VS Code sessions to history
- **Decision**: Don't block on this — hooks index + JSONL scan covers the gap
