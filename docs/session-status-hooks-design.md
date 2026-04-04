# Session Status Hooks — Design Doc

## Goal

Show active session status (working / idle / needs-attention) via colored dots in CodeV's session list, using Claude Code's hooks system for near-zero CPU cost.

## Status Model

| Status | Dot Color | Meaning | Trigger |
|---|---|---|---|
| **Working** | Purple `#CE93D8` | Claude is processing | `UserPromptSubmit` hook |
| **Idle** | Green `#66BB6A` | Waiting for user input | `Stop` hook |
| **Needs attention** | Orange `#FFA726` | Permission prompt or question | `PermissionRequest` hook, or pending `AskUserQuestion` |
| **Active (unknown)** | Purple `#CE93D8` | Running but no hook data yet | Detected via `sessions/*.json` but no status file |

## Architecture

```
Claude Code session
  → hook fires (Stop/PermissionRequest/UserPromptSubmit/etc.)
  → runs ~/.claude/codev-status-hook.sh
  → writes ~/.claude/codev-status/{sessionId}.json

CodeV (main process)
  ← fs.watch(~/.claude/codev-status/) detects file change
  ← reads status file
  → IPC to renderer → dot color update
```

### On CodeV startup (catch-up for sessions started before CodeV)

```
1. Read ~/.claude/sessions/*.json → list of active sessions (PID + sessionId + cwd)
2. For each active session:
   a. Check ~/.claude/codev-status/{sessionId}.json → use if exists
   b. Otherwise, read last ~50 lines of session JSONL → determine initial status
      - Has pending AskUserQuestion tool use → needs-attention
      - Last assistant message with no pending tool use → idle
      - Note: `stop_reason` can be null in some JSONL entries — don't rely on it
      - Otherwise → working (or unknown)
```

## Hook Configuration

### What CodeV writes to `~/.claude/settings.json`

CodeV merges hook entries into the user's existing `~/.claude/settings.json`, never overwriting existing hooks.

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "~/.claude/codev-status-hook.sh", "timeout": 5 }]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "~/.claude/codev-status-hook.sh", "timeout": 5 }]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "~/.claude/codev-status-hook.sh", "timeout": 5 }]
      }
    ],
    "SubagentStart": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "~/.claude/codev-status-hook.sh", "timeout": 5 }]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "~/.claude/codev-status-hook.sh", "timeout": 5 }]
      }
    ]
  }
}
```

### Hook script (`~/.claude/codev-status-hook.sh`)

Receives JSON via stdin with `session_id`, `hook_event_name`, `cwd`, etc.

```bash
#!/bin/bash
# CodeV session status hook — writes status for CodeV to watch
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
EVENT=$(echo "$INPUT" | grep -o '"hook_event_name":"[^"]*"' | head -1 | cut -d'"' -f4)
CWD=$(echo "$INPUT" | grep -o '"cwd":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$SESSION_ID" ]; then exit 0; fi

STATUS_DIR="$HOME/.claude/codev-status"
mkdir -p "$STATUS_DIR"

case "$EVENT" in
  UserPromptSubmit|SubagentStart) STATUS="working" ;;
  Stop)                          STATUS="idle" ;;
  PermissionRequest)             STATUS="needs-attention" ;;
  SessionEnd)                    rm -f "$STATUS_DIR/$SESSION_ID.json"; exit 0 ;;
  *)                             STATUS="unknown" ;;
esac

echo "{\"status\":\"$STATUS\",\"timestamp\":$(date +%s),\"cwd\":\"$CWD\"}" > "$STATUS_DIR/$SESSION_ID.json"
```

### Merge strategy (preserving user's existing hooks)

```
For each event (Stop, UserPromptSubmit, etc.):
  1. Read existing hooks[event] array (or empty if none)
  2. Check if any entry's hooks[].command contains "codev-status-hook"
  3. If found → skip (already configured)
  4. If not found → append our entry to the array
  5. Write back settings.json
```

### Disable behavior

When user disables in Settings:
1. Remove entries with command containing "codev-status-hook" from each event
2. Delete `~/.claude/codev-status-hook.sh`
3. Optionally: delete `~/.claude/codev-status/` directory

## CodeV Settings

In popup.tsx, under General:
- **Session Status** toggle (default: ON)
  - ON: installs hooks + hook script, starts fs.watch
  - OFF: removes hooks + hook script, stops fs.watch, all dots revert to current behavior (purple = active)

## Relationship with `detectActiveSessions`

Status hooks are an **additional layer** on top of the existing detection system. Detection tells you *which* sessions are running; hooks tell you *what state* those sessions are in.

| Timing | What runs | Purpose |
|---|---|---|
| Startup | `fetchClaudeSessions()` → `detectActiveSessions()` | Detect which sessions are alive (PID check) |
| Tab switch to Sessions | `fetchClaudeSessions()` → `detectActiveSessions()` | Refresh active state |
| Window focus (from background) | `onFocusWindow` → `fetchClaudeSessions()` | Refresh active state |
| Startup (once) | `getSessionStatuses()` → JSONL scan | Determine initial status for sessions without hook data |
| Real-time | `fs.watch` on `codev-status/` | Status updates from hooks (working/idle/needs-attention) |
| Window focus | `getSessionStatuses()` | Refresh statuses on return from background |

`detectActiveSessions()` has a 5s TTL cache, so overlapping calls (e.g., from `fetchClaudeSessions` and `getSessionStatuses` at startup) typically hit cache.

## Performance

| Operation | Cost | Frequency |
|---|---|---|
| Hook script execution | ~5ms (bash + write file) | Per Claude Code turn (~1-5/min) |
| fs.watch notification | ~0ms (OS-level, no polling) | Per status file change |
| Status file read | ~1ms | Per fs.watch event |
| Startup JSONL scan | ~1ms per session (tail 50 lines) | Once on CodeV launch |
| Total CPU when idle | ~0% | — |

### Architecture note: `get-session-statuses` and duplicate detection

The `get-session-statuses` IPC handler internally calls `detectActiveSessions()` and `readClaudeSessions(500)` to find sessions without status files for JSONL scanning. This duplicates work the renderer already does.

**Why it's acceptable:**
- Both functions have 5s TTL cache. At startup, the renderer's detection and `get-session-statuses` run within ~1s, so the second call hits cache (~0ms).
- No race condition — both calls return correct results; at worst there's duplicate work on a cold cache (~45ms total).
- `getSessionStatuses()` is called **once on mount** + **once per window focus**. After that, updates come from `fs.watch` push via `onSessionStatusesUpdated` (merge, not replace).

**Why not pass `activeMap` from renderer instead:**
- Adds IPC coupling (renderer must finish detection before requesting statuses).
- The handler becomes dependent on renderer timing.
- Cache hit already makes the duplicate cost ~0ms.
- Keeping the handler self-contained is simpler and more maintainable.

### Hook events: comparison with claude-control

claude-control uses the same hook mechanism with a similar script. Comparison:

| Event | claude-control | CodeV | Notes |
|---|---|---|---|
| SessionStart | ✓ | ✗ | Not added — purple (init) dot is acceptable for the few seconds before first prompt |
| SessionEnd | ✓ | ✓ | Removes status file |
| Stop | ✓ | ✓ | → idle |
| UserPromptSubmit | ✓ | ✓ | → working |
| PermissionRequest | ✓ | ✓ | → needs-attention |
| SubagentStart | ✓ | ✓ | → working |
| PostToolUseFailure | ✓ | ✗ | Not added — tool failures aren't always severe; no separate error color needed yet |

Key difference: claude-control keys status files by PID (`$PPID`), CodeV keys by sessionId. SessionId is more stable across resume cycles.

### Bug fix: merge vs replace on status update

`onSessionStatusesUpdated` must **merge** into existing state (`{...prev, ...newStatuses}`), not replace. JSONL-scanned statuses (for sessions without status files) exist only in React state. A replace would clear them when fs.watch fires for unrelated status file changes.

## VS Code Claude Code Sessions

Hooks fire for ALL Claude Code sessions, including VS Code extension (`entrypoint: "claude-vscode"`). This means:
- VS Code sessions will also have status files in `codev-status/`
- Combined with `~/.claude/sessions/*.json` detection (PR #78), we can:
  1. Detect VS Code sessions as active (PID file exists, entrypoint = "claude-vscode")
  2. Show their status (hook writes status file regardless of entrypoint)
  3. Future: show first/last prompt by reading their session JSONL

This is a stepping stone for issue #66 item #5 (VS Code Claude Code session support).

## Phase Plan

### Phase 1 (this PR)
- Hook config management (install/merge/remove)
- Hook script creation
- Settings toggle
- fs.watch for status directory
- Dot color based on status (working/idle/needs-attention)
- Startup scan for initial status

### Phase 2 (future)
- Text question detection (? heuristic with 20s grace period)
- VS Code session display with status
- Notification/sound for needs-attention
- Detail view showing specific tool waiting for approval

## References

- [Claude Code hooks documentation](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [c9watch PR #66](https://github.com/minchenlee/c9watch/pull/66) — NeedsAttention detection, AskUserQuestion, 20s grace period
- [c9watch PR #14](https://github.com/minchenlee/c9watch/pull/14) — CPU optimization
- [cmux claude-hook](~/git/cmux/CLI/cmux.swift) — cmux's hook-based session monitoring
- [CodeV issue #66 item #2](https://github.com/grimmerk/codev/issues/66) — Feature request
- [CodeV issue #63](https://github.com/grimmerk/codev/issues/63) — Related: Ghostty TTY support
