# VS Code Claude Code Session Support

## Goal

Add VS Code Claude Code sessions to CodeV's session list, enabling detection, display, switching, resuming, and launching — on par with terminal-based sessions.

## Background

Claude Code runs inside VS Code as an extension (`entrypoint: "claude-vscode"`). These sessions share the same `~/.claude/` data layer as CLI sessions, but with key differences:

- **Not in `history.jsonl`**: VS Code sessions are excluded from the global history log (upstream bugs [#24579](https://github.com/anthropics/claude-code/issues/24579), [#18619](https://github.com/anthropics/claude-code/issues/18619))
- **No `/rename` support**: Cannot set custom titles ([#33165](https://github.com/anthropics/claude-code/issues/33165))
- **Has `ai-title`**: Auto-generated titles stored in session JSONL (e.g., `"Casual greeting and session start"`)
- **URI handler available**: `vscode://anthropic.claude-code/open?session=<UUID>` (requires extension v2.1.72+)
- **Hooks work**: Status hooks fire for VS Code sessions via `$CLAUDE_CODE_ENTRYPOINT` env var (verified experimentally)

## Data Availability

| Data | Available | Source |
|------|-----------|--------|
| Active session metadata | Yes | `~/.claude/sessions/<PID>.json` with `entrypoint: "claude-vscode"` |
| Session status (working/idle/needs-attention) | Yes | Hooks write to `~/.claude/codev-status/{sessionId}.json` |
| Conversation history | Yes | `~/.claude/projects/{path}/{sessionId}.jsonl` (same format as CLI) |
| AI-generated title | Yes | `ai-title` entry in session JSONL (written once per session) |
| Custom title (`/rename`) | No | Not supported in VS Code extension |
| First/last user prompt | Yes | Readable from session JSONL head/tail |
| Last assistant response | Yes | Readable from session JSONL tail (shared algorithm) |
| Git branch | Yes | In JSONL entries |
| PR links | Yes | If created during session |
| Closed session record | **No** | Not in `history.jsonl` — solved via JSONL scan + hooks index |
| IDE workspace info | Yes | `~/.claude/ide/<PID>.lock` (workspace folders, IDE name) |

## Architecture

### Layer 1: Detection

**Active sessions** — Removed the `entrypoint !== 'cli'` filter in `detectActiveSessions()`. VS Code sessions appear alongside CLI sessions. Uses async `readVSCodeSessionFromJSONL()` with head/tail for metadata.

**Closed sessions** — Two-pronged approach:
1. **Hooks index**: `codev-status-hook.sh` detects `$CLAUDE_CODE_ENTRYPOINT === "claude-vscode"` and appends to `~/.claude/codev-status/vscode-sessions.jsonl`. Uses marker files (`.vs-{sessionId}`) to avoid duplicate writes. Works even when CodeV is not running.
2. **JSONL scan**: `scanClosedVSCodeSessions()` reads first 4KB of each JSONL file to check entrypoint. Hooks-indexed sessions are skipped (no 4KB read needed). Results cached for 30s.

### Layer 2: Display

- **Badge**: `[VSCODE]` badge shown for **active** sessions only (consistent with CLI terminal badges). Closed sessions do not show terminal badges to avoid visual noise and stale badge issues.
- **Title**: `ai-title` from JSONL as fallback. Priority: `custom-title > ai-title > first prompt`
- **Status dot**: Same as CLI sessions (hooks fire for VS Code via `$CLAUDE_CODE_ENTRYPOINT`)
- **First/last prompt**: Read from JSONL via shared `parseUserMessageFromLines()`, skips `<ide_>` context blocks via `extractUserText()`
- **Search**: Includes `ai-title`, terminal type (`vscode`/`ghostty`/`iterm2`), and PR URLs
- **Badge highlights**: Search matches highlight terminal badge and PR badge text

### Layer 3: Switch (active sessions)

Uses the VS Code URI handler:
```
open "vscode://anthropic.claude-code/open?session=<UUID>"
```

Verified behavior:
- Existing session UUID: switches to that session tab in VS Code
- First call requires user to allow the URI handler (one-time dialog, check "Do not ask me again")
- No Accessibility API or AppleScript needed
- MAS-compatible (uses standard URI scheme)

### Layer 4: Resume (closed sessions)

Two-step process for VS Code resume:
1. Open project folder: `code "<projectPath>"`
2. After 2s delay (for VS Code to load workspace): URI handler `vscode://anthropic.claude-code/open?session=<UUID>`

If the user's Launch Terminal is not set to VS Code, closed sessions resume in the default terminal (standard behavior).

Measured latency:
| Scenario | Time |
|----------|------|
| Active session switch | Instant |
| Resume in already-open VS Code project | ~1-2s |
| Resume in new VS Code project | ~3-5s |

### Layer 5: Settings

- **Launch Terminal dropdown**: Added "VS Code" option alongside iTerm2, Terminal, Ghostty, cmux
- When set to VS Code, closed session clicks use the URI handler resume flow
- Launch Mode (tab/window) does not apply to VS Code

### Layer 6: Shared Algorithm (head/tail reads)

`readVSCodeSessionFromJSONL()` performs a single set of parallel reads:
- `head -n 20` → first user prompt (via `parseUserMessageFromLines()`)
- `tail -n 100` → last user prompt + last assistant message (via `parseUserMessageFromLines(lines, true)` + `parseAssistantMessageFromLines()`)
- `grep -c '"type":"user"'` → message count
- Also extracts `cwd` from JSONL content (directory name decode is lossy)

This avoids duplicate tail reads — the assistant response is extracted from the same tail output, so `loadLastAssistantResponses()` is not called again for VS Code sessions.

Shared helper functions:
| Function | Purpose | Used by |
|----------|---------|---------|
| `extractUserText(content)` | Extract text from message content, skip `<ide_>` blocks | `parseUserMessageFromLines()` |
| `parseUserMessageFromLines(lines, fromEnd?)` | Find user message in JSONL lines | `readVSCodeSessionFromJSONL()` |
| `parseAssistantMessageFromLines(lines)` | Find last assistant message in JSONL lines | `readVSCodeSessionFromJSONL()` |

### Layer 7: Title Enrichment (`ai-title`)

Added `ai-title` grep to `loadSessionEnrichment()` alongside existing `custom-title` grep. Priority: `custom-title > ai-title`.

Format in JSONL: `{"type":"ai-title","sessionId":"...","aiTitle":"..."}`

Characteristics:
- Written once per session (does not change)
- Present in both VS Code and newer CLI sessions
- AI-generated, descriptive (e.g., "Casual greeting and session start")
- See #104 for applying ai-title fallback to all sessions

## Performance

| Operation | Cost | Notes |
|-----------|------|-------|
| Detection (active) | +0ms | Same `sessions/*.json` read, removed filter |
| JSONL scan (closed) | ~50ms | 218 files, 4KB read per file, cached 30s |
| Hooks index skip | saves ~0.2ms/file | Known VS Code sessions skip 4KB entrypoint check |
| head/tail read per session | ~5-10ms | Parallel head-20 + tail-100 + grep-c |
| ai-title grep | +~1ms/session | Parallel with existing greps |
| URI handler switch | instant | Single `open` command |
| URI handler resume | ~1-5s | `code <path>` + 2s delay + URI handler |
| Hooks index write | ~5ms/event | Per hook event, marker file prevents duplicates |
| Session count | capped at 100 | Sort by timestamp, then slice after merge |
| Timestamp normalization | +0ms | ISO string → unix ms conversion in reader |

## VS Code URI Handler Reference

| URL | Effect |
|-----|--------|
| `vscode://anthropic.claude-code/open` | Open new Claude Code tab |
| `vscode://anthropic.claude-code/open?session=<UUID>` | Switch to / resume session |
| `vscode://anthropic.claude-code/open?prompt=<text>` | Open with pre-filled prompt |

Requires Claude Code VS Code extension **v2.1.72+** (released 2026-03-10).

First call shows a permission dialog in VS Code. User can check "Do not ask me again" to suppress future dialogs.

## Known Limitations

1. **Closed sessions not in `history.jsonl`**: Workaround via JSONL scan + hooks index. Upstream fix may come via [#24579](https://github.com/anthropics/claude-code/issues/24579).
2. **No `/rename` in VS Code**: Use `ai-title` as fallback ([#33165](https://github.com/anthropics/claude-code/issues/33165)).
3. **Resume delay**: 2s fixed delay for workspace loading. Could be optimized by detecting if project is already open.
4. **URI handler one-time dialog**: First use requires user to click "Allow" in VS Code.
5. **JSONL timestamp format**: VS Code uses ISO strings, CLI uses unix ms. Normalized at read time.

## Alternatives Considered

### Accessibility API (AXUIElement)
- Can find Claude Code tab in VS Code's AX tree (`AXRadioButton title="Claude Code"`)
- More complex, requires Accessibility permission, not MAS-compatible
- **Decision**: Not needed — URI handler provides better precision (session-level vs tab-level)
- Reference: [mediar-ai/mcp-server-macos-use](https://github.com/mediar-ai/mcp-server-macos-use)

### `code -r <path>` (c9watch / claude-control approach)
- Only switches to VS Code window, cannot target specific session
- **Decision**: URI handler is strictly better

### Wait for upstream `history.jsonl` fix
- Upstream bugs #24579, #18619 may eventually add VS Code sessions to history
- **Decision**: Don't block on this — hooks index + JSONL scan covers the gap
