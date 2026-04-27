# Changelog

## 1.0.75

- Feat: Launch new Claude session as a git worktree from the Projects tab
  - Press `⌘+Shift+Enter` on a project → dialog asks for branch name (optional)
  - With a name: runs `claude -w "<name>" -n "<name>"` in the configured terminal
  - Without a name: behaves like the existing `⌘+Enter` (normal session)
  - The `-n` flag also sets a custom title so Ghostty's title-match can locate
    the right tab when switching back (Ghostty has no per-tab TTY exposure).
- Feat: worktree-aware session display
  - Worktree session paths (`<repo>/.claude/worktrees/<name>`) now show the
    parent repo name (e.g., `codev`) with a small `WT` badge, instead of the
    worktree folder name (e.g., `test-worktree-4`).
  - New `parseWorktreePath()` helper + `isWorktree` / `parentRepo` fields on
    `ClaudeSession`.
- Fix: Ghostty session-switching no longer "jumps to the wrong window" on
  match miss
  - The `activate` AppleScript call is now inside the success branch, so we
    don't bring Ghostty forward when no matching tab is found.
  - Benefits all session switches, not just worktrees.

## 1.0.74

- Fix: session status dot stuck on purple for sessions with large responses (#116)
  - `tail -n 50` on large JSONL files exceeded `execFile` maxBuffer (1MB)
  - Reduced to 15 lines + raised maxBuffer to 5MB
- Fix: eliminate tab flash on startup (default tab now passed via URL hash)
- Style: project paths display `~/` instead of `/Users/<user>/`
- Style: shortcut display uses macOS symbols (`⌘⌃R` instead of `Cmd+Ctrl+R`)
- Style: needs-attention dot changed from orange `#FFA726` to warm red `#F06856`
- Style: working pulse animation slowed from 2s to 2.5s
- Style: normal mode banner only shown on first launch
- Feat: clicking shortcut in title bar opens Settings → Shortcuts tab
- Feat: project search supports `~/` prefix and full path matching (with highlight)

## 1.0.73

- Feat: embedded terminal search (`Cmd+F`)
  - Search overlay with previous/next/close buttons and match counter
  - `Enter` for next match, `Shift+Enter` for previous, `Escape` to close
  - Powered by `@xterm/addon-search`

## 1.0.72

- Fix: window-toggle actions bring window to front when covered by another app (Normal mode)
  - `Cmd+Ctrl+R` (Quick Switcher), `Cmd+Ctrl+T` (Terminal), and tray left-click
  - Previously: visible-but-unfocused first press hid the window
  - Now: visible+unfocused → focus to top; visible+focused → hide (or toggle Terminal tab)
  - Menu bar mode unaffected (`onBlur` auto-hide makes the state unreachable)

## 1.0.71

- Fix: use `setActivationPolicy` instead of `app.dock.hide/show` for proper Dock behavior
  - Normal mode: Dock icon with running dot + App Switcher
  - Menu bar mode: no Dock icon (clean accessory mode)
  - No Dock icon flash on app launch (LSUIElement=true kept)
- Feat: tray right-click menu mode toggle (Switch to Normal/Menu Bar Mode)

## 1.0.70

- Feat: Normal App mode — window stays visible, shows in Dock, draggable
  - Toggle in Settings: Normal App (default for new users) / Menu Bar
  - Instant switching, no restart needed
  - `Cmd+Ctrl+R` toggles show/hide in both modes
  - Title bar shows "Dev Hub" sub-title + mode indicator + shortcut key
  - Banner on first launch and mode switch (auto-dismiss)
  - Clicking Dock icon shows hidden window
- Feat: Settings UI redesigned with tabs (General / Sessions / Shortcuts)
  - All settings visible without scrolling
  - No more content changing based on active main tab
  - Hints on context-specific settings (projects/sessions/tray)
- Style: Terminal renamed to Terminal.app in Launch Terminal dropdown
- Style: title bar padding reduced for tighter layout

## 1.0.69

- Feat: adaptive VS Code resume via IDE lock file polling
  - Replaces fixed 2s delay with `~/.claude/ide/*.lock` detection
  - Already-open project: instant (~0.5s vs ~2s before)
  - Cold start: adaptive poll + 1.5s post-ready delay
- Fix: duplicate Claude Code tab on VS Code window restore (cases 3, 5, 7)
  - Active sessions skip URI handler when project needs to be opened
  - Closed sessions wait for extension ready before URI handler
- Fix: resume not opening session tab when project window already open (case 2)
- Fix: active VS Code session switching to wrong window

## 1.0.68

- Feat: quick-launch new Claude session from Projects tab
  - `Cmd+Enter`: launch in default Launch Terminal
  - `Shift+Enter`: launch in CodeV embedded terminal
  - `Cmd+Click`: launch in default Launch Terminal
  - Supports all terminals: iTerm2, Ghostty, Terminal.app, cmux, VS Code, CodeV
- Feat: Terminal tab "Claude in Terminal" overlay button (launches in external terminal using current cwd)
- Feat: Launch Terminal + Launch Mode moved to General settings (visible on all tabs)
- Feat: Settings popup scrollable + no auto-close on outside click
- Fix: search crash on regex special characters (`+`, `*`, `?`) via `autoEscape`
- Fix: cold-start extra window for iTerm2/Terminal.app (pgrep detection)
- Fix: VS Code extra Dock icon (use `open -b bundleId` instead of `code` CLI)
- Fix: terminal tab rendering flash on tab switch (#99, visibility instead of display)
- Refactor: shared `runCommandInTerminal` for resume + new session launch
- Style: title bar renamed to "CodeV"

## 1.0.67

- Feat: VS Code Claude Code session support — detect, display, switch, resume
  - Active sessions: `[VSCODE]` badge, instant switch via URI handler
  - Closed sessions: JSONL scan + hooks index, resume via `code <path>` + URI handler
  - `ai-title` as display name fallback (custom-title > ai-title > first prompt)
  - VS Code added to Launch Terminal dropdown in Settings
  - Requires Claude Code VS Code extension v2.1.72+
- Feat: real-time session preview updates on idle
  - Last assistant message, last user message, and session order auto-update
  - Single `tail -n 100` read for both user + assistant messages
  - fs.watch debounced (50ms) to reduce duplicate triggers on macOS
- Feat: search by terminal type (`vscode`/`ghostty`/`iterm2`)
- Style: PR badge before terminal badge, search highlighting on both
- Fix: ISO string timestamps normalized to unix ms (correct sort order)
- Fix: skip `<ide_opened_file>` context blocks in VS Code session preview

## 1.0.66

- Style: use `*` separator for custom titles (matches Claude Code display)

## 1.0.65

- Style: remove quotes around custom session titles (color already distinguishes them)

## 1.0.64

- Feat: show last assistant response for all sessions (not just active)

## 1.0.63

- Fix: Terminal tab sessions correctly detected as CODEV (not parent terminal)
- Click Terminal tab session → switches to Term tab instead of external terminal

## 1.0.62

- Feat: session status hooks — colored dots for working (pulse) / idle / needs-attention (blink)
- Feat: auto-install Claude Code hooks for session status detection (toggle in Settings → Sessions)
- Fix: legacy fallback detection now supports npm-installed Claude Code (#95)
- Known: if hooks are removed externally while CodeV is running, restart CodeV to recover (#93)

## 1.0.61

- Fix: terminal cursor — white non-blinking block (matching iTerm2 style)
- Feat: Cmd+K clears terminal screen
- Feat: Shift+Enter sends newline in terminal (for Claude Code multi-line input)

## 1.0.60

- Fix: terminal cd uses ~ shorthand + clear for cleaner output
- Fix: POSIX-safe shell escaping for cd path
- Move Working Dir setting to General (visible in Projects + Terminal tabs)

## 1.0.59

- Feat: SVG starburst icon for Sessions tab header (sunflower yellow)

## 1.0.58

- Feat: ⌃+⌘+T global shortcut for Terminal tab (customizable in Settings)
- Fix: Cmd+←/→ in xterm (beginning/end of line)

## 1.0.57

- Fix: menubar Keyboard Shortcuts submenu now reflects custom shortcuts
- Fix: GitHub release notes now aggregate all unreleased changelog entries
- Feat: PR link badge in session list items (clickable, opens browser, searchable by URL)
- Feat: purple dot on projects currently open in VS Code/Cursor
- Pin axios to 1.14.0 (avoid compromised 1.14.1)

## 1.0.56

- Feat: embedded Terminal tab (xterm.js + node-pty)
- Pre-spawn PTY on app start for instant terminal access
- Tab switching: Tab (Projects↔Sessions), ⌃+Tab (cycle all), ⌘+1/2/3 (jump)
- Default Tab setting now supports Terminal
- Fix: white flash on window show/hide/quit
- Upgrade webpack 5.73 → 5.105 (fix xterm.js production tree-shaking)
- EPIPE crash prevention for Node 24 dev mode

## 1.0.55

- Feat: macOS Terminal.app support — launch, switch (title + TTY matching), cross-ref disambiguation

## 1.0.54

- Fix: cmux launch now waits for cmux to be ready before creating workspace (#75)
- Fix: revert accidental DevTools enable in switcher window

## 1.0.53

- Upgrade Electron 29 → 41 (Node 24, Chromium 146)
- Upgrade electron-forge 7.2 → 7.11, TypeScript 5.3 → 5.7
- Upgrade better-sqlite3 v11 → v12, react-select, axios, prettier, etc.
- Add `IElectronAPI` type definition — removes ~100 `as any` casts
- Design doc: add VS Code session data gap analysis

## 1.0.52

- Fix: VS Code Claude Code sessions no longer cause false purple dots on terminal sessions

## 1.0.51

- Fix: cache update status to survive renderer race condition
- "Latest" now clickable to re-check for updates

## 1.0.50

- Green dot badge on Settings button when update is ready to install

## 1.0.49

- Custom update UI: "Check for Update" + "Install & Restart" in Settings popup
- No auto-popup dialogs — update check is manual only

## 1.0.48

- In-app auto-update for non-MAS builds (via update-electron-app)
- CI: upload signed zip alongside DMG for Squirrel.Mac auto-updater

## 1.0.47

- Settings popup redesign: grouped by General/Projects/Sessions
- Add IDE Preference + Left-Click Behavior to Settings popup
- Custom keyboard shortcuts: edit, save, reset from Settings popup
- MAS: Grant Access button in IDE row
- Fix: mouse hover jump on window focus return
- Fix: assistant message color toned down
- Remove archived extension folder
- Docs: Ghostty keybind workaround for paste/undo

## 1.0.46

- Fix: arrow keys not changing selected item after returning from background
- Fix: Settings panel close not returning focus to correct search input (React closure trap)

## 1.0.45

- cmux: three-layer switch matching (title → TTY → cwd fallback), same as iTerm2
- Requires cmux v0.63+ with per-surface `tty=` in tree output

## 1.0.44

- Rewrite detection: use `~/.claude/sessions/` PID files (~5ms vs ~200-450ms)
- Supports VS Code + Claude Desktop sessions via `entrypoint` field
- Cross-ref fallback only for rare same-cwd ambiguity (iTerm2/cmux parallel)
- Legacy fallback for old Claude Code without `sessions/` directory

## 1.0.43

- cmux: cross-reference detection via tree TTY field (requires cmux v0.63+)
- Fixes purple dot for bare `claude` / `claude -r` sessions with in-session `/rename` on cmux

## 1.0.42

- iTerm2: cross-reference detection via per-tab TTY + tab name matching
- Fixes purple dot for bare `claude` / `claude -r` sessions with in-session `/rename`

## 1.0.41

- Fix: detection regex matches `-r` in addition to `--resume` for correct purple dot
- Fix: same-cwd session disambiguation via `-n`/`--name` and `-r`/`--resume` title matching
- Docs: full same-cwd detection + switch accuracy matrix

## 1.0.40

- Projects: remove item count (react-select layout constraint)
- Projects: larger branch name font for better readability

## 1.0.39

- Projects: show git branch name (async loaded, searchable)
- Projects: unified selection style with Sessions (left border + subtle highlight)

## 1.0.38

- cmux: two-layer switch matching (title → cwd fallback), same as Ghostty
- cmux: surface-level tab switching via `focus-panel` (multi-tab workspaces)
- Optimized cmux switching: single `tree --all` call replaces `list-workspaces` + `tree`

## 1.0.37

- iTerm2: three-layer switch matching (title → TTY → fallback)
- Ghostty: two-layer switch matching (title → cwd fallback)
- Fix: custom title loading for paths with underscores (e.g. test_codev)
- Fix: grep false positive for custom-title in long sessions
- Fix: project path encoding to match Claude Code's directory naming
- CHANGELOG.md with CI auto-read for release notes
- README: session switching guide with terminal support matrix

## 1.0.36

- Detect multiple active sessions with same working directory
- Fix: don't override CI secrets with empty .env values

## 1.0.35

- Add cmux and Ghostty terminal support with auto-detection
- Auto-detect which terminal active sessions are running in (iTerm2/Ghostty/cmux)
- Terminal badge (ITERM2, CMUX, GHOSTTY) shown on active sessions
- Settings: Launch Terminal selector, Launch Mode (New Tab/Window)
- Session settings only visible in Sessions tab
- Fix: don't override CI secrets with empty .env values

## 1.0.34

- Add Claude Code session list with Tab switching
- Session list sorted by last activity from history.jsonl
- Multi-word AND search on project name, prompts, custom titles, branches
- Active session detection with purple dot
- Last assistant response for active sessions (blue text)
- Custom title display from session JSONL files
- Git branch name display
- Open/resume sessions in iTerm2 (new tab or window)
- Session Preview mode (First/Last/Both user prompts)
- Default Tab setting (Projects or Sessions)
- Non-blocking SWR-like loading with 5s TTL cache
- 1.5-3 line layout with color-coded elements

## 1.0.33 (App Store submission)

- Launch at Login toggle (App Store guideline 2.4.5 fix)
- Dynamic app version in Settings popup
- Non-App Store notarized DMG distribution
- GitHub Actions CI for notarized builds

## 1.0.31

- Fix: apply IDE preference immediately on save
- Fix: cast preferredIDE string to IDEMode type

## 1.0.30

- Cursor IDE support alongside VS Code
- IDE Preference Settings to switch between VS Code and Cursor
- Documentation: mention Cursor support and MAS sandbox note

## 1.0.29

- Security-scoped bookmark for IDE SQLite access in MAS sandbox
- Fix: sign better_sqlite3.node for MAS builds
- Fix: exclude electron binary from asset-relocator-loader
- Fix: use --platform=mas for MAS builds
- Recently opened file items support

## 1.0.28

- Initial TestFlight build
- Disable migration/server, read VS Code/Cursor SQLite directly
- Prepare embedded.provisionprofile for TestFlight

## 1.0.26

- Original App Store release (VS Code extension based)

## 1.0.0

- Initial version
