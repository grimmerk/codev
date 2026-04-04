# Changelog

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
