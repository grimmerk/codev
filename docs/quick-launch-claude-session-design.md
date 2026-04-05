# Quick Launch New Claude Session — Design Doc

## Problem

Launching a new Claude Code session from CodeV currently has friction:
- **Terminal tab**: `cd path && claude` works but is confined to CodeV's embedded terminal — cannot use external terminals (iTerm2, Ghostty, etc.) which are preferred for long sessions
- **Manual**: opening an external terminal, cd-ing, running `claude` manually defeats CodeV's purpose as a quick switcher
- **`claude` CLI has no `--cwd` flag**: must `cd` to the target directory first

Two scenarios exist:
1. **Multi-step** (already covered by Terminal tab) — complex operations needing full shell
2. **One-shot launch** — quickly start a new Claude session in a specific directory, optionally in an external terminal

## Design: Three Phases

### Phase 1: `Cmd+Enter` on Projects Tab (Highest ROI)

**Key insight**: The Projects tab already IS a path picker — no new UI needed.

#### Shortcuts

| Action | Effect |
|--------|--------|
| `Enter` (existing) | Open project in VS Code/Cursor |
| `Cmd+Enter` (new) | Launch new Claude session in **default Launch Terminal** (from Settings) |
| `Shift+Enter` (new) | Launch new Claude session in **CodeV terminal** (switches to Term tab) |

Note: Exact shortcut assignment may be swapped after hands-on testing. Both shortcuts should be user-customizable (like existing ⌃+⌘+R etc.).

#### User Flow

1. `⌃+⌘+R` → open CodeV
2. (optional) type to filter projects
3. Select project with arrow keys
4. `Cmd+Enter` → done. CodeV hides, external terminal opens with `cd <path> && claude`

#### Why This Works

- Zero new UI — reuses existing project list as path picker
- Zero learning curve — same muscle memory as `Enter` to open project
- Path already resolved from project data
- Terminal choice from existing "Launch Terminal" setting
- `Shift+Enter` gives "quick task in CodeV terminal" escape hatch
- Fire-and-forget: `cd && claude`, no need to see output

#### Implementation

- Add key handler in `switcher-ui.tsx` project selection for `Cmd+Enter` / `Shift+Enter`
- Reuse launch logic from `claude-session-utility.ts` — same as `openSession()` but with `claude` instead of `claude --resume <id>`
- New IPC handler: `launch-new-claude-session(projectPath, terminalApp?, terminalMode?)`
- For CodeV terminal: send `cd <path> && claude\n` to PTY via existing `terminalInput` IPC
- No `--name` flag by default — launching from CodeV doesn't imply a specific session purpose

#### Key Files

| File | Changes |
|------|---------|
| `src/switcher-ui.tsx` | Key handler for Cmd+Enter / Shift+Enter on project items |
| `src/claude-session-utility.ts` | New `launchNewClaudeSession()` function (reuses existing terminal launch logic) |
| `src/main.ts` | New IPC handler `launch-new-claude-session` |
| `src/preload.ts` | Expose new IPC to renderer |
| `src/electron-api.d.ts` | Type definition for new API |

#### Mouse Support

`Cmd+Click` on a project item also launches a new Claude session (same as `Cmd+Enter`).

#### UI Button Consideration (Deferred)

A permanent Claude icon button on each project item was considered but deferred:
- **Pro**: Discoverable, mouse-friendly
- **Con**: Visual noise on items where it's unused; Projects row already has name + branch + path + X button
- **Con**: Sessions tab items are even more crowded — inconsistent if only Projects has it
- **Decision**: Start with keyboard (`Cmd+Enter`) + mouse (`Cmd+Click`) only. Revisit if discoverability is a problem.

An alternative is the **expanded item view** (see Phase 1.5 below).

#### Custom Shortcut Support

Both shortcuts should be user-customizable (like existing ⌃+⌘+R etc.).

### Phase 1.5: Expanded Project Item View (Deferred)

An expandable detail view for project items, similar to the planned Space-key Quick Look for sessions (#66 item 3).

#### Concept

```
  fred-ff [main]                              /Users/grimmer/git
  ┌─────────────────────────────────────────────────────────┐
  │  [Open in IDE]  [New Claude ▾]  [Open in Terminal]      │
  │  Active sessions: 2 (1 CLI, 1 VS Code)                  │
  └─────────────────────────────────────────────────────────┘
  codev [docs/quick-launch-claude-session]     /Users/grimmer/git
```

- `Space` or `→` to expand selected project item
- Shows action buttons + extra info (active sessions, git status)
- `[New Claude ▾]` dropdown for terminal selection
- `Esc` or `←` to collapse

#### Relationship with Cmd+Enter

These can coexist — expanded view is for "browse then decide" users, `Cmd+Enter` is for power users who want instant action. Like Finder: `Space` = Quick Look, `Cmd+O` = open.

If expanded view becomes the primary interaction model, `Cmd+Enter` shortcut becomes less critical but still valuable as a fast path.

### Phase 2: Search Bar `>` Command Mode (Power User Flexibility)

When user types `>` as the first character in **either** Projects or Sessions search bar, it enters command mode.

#### Syntax

```
> claude                    → show project list for selection
> claude codev              → fuzzy-filter projects, select to launch
> claude @ghostty codev     → override terminal for this launch
> claude @codev fred-ff     → explicitly use CodeV terminal
```

#### Visual Changes on `>` Entry

- Search bar border changes color (e.g., cyan accent)
- Placeholder text changes to: `claude [project], @terminal to override`
- List below replaces sessions/projects with matching project items + terminal badge

#### `@` Terminal Picker

- Typing `@` after `> claude ` shows a dropdown of terminal options: `@iterm2`, `@ghostty`, `@terminal`, `@cmux`, `@codev`
- Selecting one inserts a styled badge (like Slack @mentions)
- Omitting `@` uses the default from Settings → Launch Terminal

#### Why `>` Prefix

- Familiar from VS Code command palette
- Doesn't conflict with any session/project search term
- Clean entry/exit: backspace past `>` returns to normal search

#### Supported in Both Tabs

Yes — same `>` behavior in Projects and Sessions search bars. In Sessions tab, `>` provides "launch new session" alongside existing "search existing sessions" flow. This addresses the need to quickly launch a new session even while browsing existing sessions.

#### Future Extensibility

The `>` command mode can later support additional commands beyond `claude`:
- `> git status codev` — run git command for a project
- `> code codev` — open project in VS Code (alternative to Enter)
- etc.

#### Implementation Complexity: Medium

- Prefix detection in search input handler
- Command parsing logic (split command, project name, @terminal)
- Autocomplete UI reusing project list data
- Visual mode switching (border color, placeholder)
- Optional: `@` badge rendering (can defer, use plain text first)

### Phase 3: Terminal Tab Enhancements (Nice-to-Have)

#### A. "Open in External Terminal" Button

Small icon in terminal tab header area. Detects current PTY working directory, opens it in configured Launch Terminal.

Use case: user has been navigating in CodeV terminal and wants to "promote" to a proper terminal.

#### B. "Launch Claude Here in External Terminal" Shortcut

While in Terminal tab, a shortcut or button that takes the current directory and opens `cd <cwd> && claude` in external terminal.

Use case: user cd'd to the right place in CodeV terminal but wants the Claude session in a real terminal.

## Worktree Scenarios

Launching new sessions often involves git worktrees. Three cases:

| Case | Path | How created | Phase 1 coverage |
|------|------|-------------|------------------|
| **A. Sibling worktree** | `~/git/codev-xxx` | Manual `git worktree add` | ✅ Appears in Projects (if under Working Directory) |
| **B. Claude-managed** | Inside project (`.claude/worktrees/...`) | `claude --worktree [name]` | Partial — path may not be in Projects list |
| **C. Existing path** | Any existing directory | Already created elsewhere | ✅ If in Projects list |

**Notes:**
- `claude --worktree [name]` only accepts a name, not a custom path. It creates worktrees in a Claude-managed location inside the project.
- Preferred workflow: sibling worktrees at `~/git/<project>-<name>` (Case A). These appear automatically in Projects tab when Working Directory is set to `~/git/`.
- One-shot worktree creation (create + launch in one action) requires multiple steps (`git worktree add` + `cd` + `claude`), better suited for Terminal tab or Phase 2 `>` command mode.
- Phase 1 covers Cases A and C fully. Case B is uncommon when users prefer sibling worktrees.

## Technical Notes

### Command Construction

For terminal-based launch, the command is:
```bash
cd "<project-path>" && claude
```

This reuses the same pattern as existing session resume (`cd "<path>" && claude --resume <id>`), just without the `--resume` flag.

For **VS Code** launch, use the URI handler instead (no `cd` needed):
```bash
# Open project folder first (if not already open), then launch Claude Code tab
# Use `open -b` with bundle ID to avoid extra Dock icon (vs `code` CLI)
open -b com.microsoft.VSCode "<project-path>"
open "vscode://anthropic.claude-code/open"

# Or with a pre-filled prompt:
open "vscode://anthropic.claude-code/open?prompt=<encoded-text>"
```
See `docs/vscode-session-support-design.md` Layer 9 for details. Requires Claude Code VS Code extension v2.1.72+.

### Terminal-Specific Launch

Each terminal already has launch logic in `claude-session-utility.ts`:
- **iTerm2**: AppleScript `create tab` + `write text`
- **Ghostty**: AppleScript `new surface configuration` with `initial input`
- **cmux**: CLI `new-workspace --command`
- **Terminal.app**: AppleScript `do script`
- **VS Code**: `open -b <bundleId> <path>` + URI handler `vscode://anthropic.claude-code/open`
- **CodeV**: `terminalInput()` IPC to embedded PTY

The new `launchNewClaudeSession()` function can delegate to these same implementations.

### Settings Integration

Uses existing settings:
- `session-terminal-app`: which terminal to use (iterm2/ghostty/cmux/terminal/vscode)
- `session-terminal-mode`: tab or window (not applicable to VS Code)

No new settings needed for Phase 1. Phase 2's `@terminal` override is per-invocation, not persisted.

## Priority & Effort

| Phase | Effort | Impact | Description |
|-------|--------|--------|-------------|
| Phase 1 | Small | High | `Cmd+Enter` on project → new claude session |
| Phase 2 | Medium | Medium | `>` command mode in search bar |
| Phase 3 | Small | Low | Terminal tab → external terminal button |

Recommendation: Start with Phase 1. It covers 80%+ of the "quick launch" use case with minimal code. Phase 2 is worth doing if search bar command mode is desired as a platform for future commands. Phase 3 is independent.

## Open Questions

1. **Shortcut assignment**: `Cmd+Enter` vs `Shift+Enter` — which maps to external vs CodeV terminal? To be decided during implementation testing.
2. **Sessions tab new-session shortcut**: Should there be a way to launch a new session from Sessions tab without switching to Projects tab first? Phase 2's `>` command mode addresses this.
3. **Phase 2 scope**: Is `>` command mode needed now, or is Phase 1 sufficient? Depends on whether the command platform is valuable beyond just `claude` launch.
