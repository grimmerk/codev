# Changelog

## 1.0.36

- Fix: three-layer iTerm2 switch matching (title → TTY → fallback)
- Fix: custom title loading for paths with underscores (e.g. test_codev)
- Fix: grep false positive for custom-title in long sessions
- Detect multiple active sessions with same working directory

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

## 1.0.33

- Launch at Login toggle (App Store guideline 2.4.5 fix)
- Dynamic app version in Settings popup
- Non-App Store notarized DMG distribution
- GitHub Actions CI for notarized builds

## 1.0.31

- Cursor IDE support alongside VS Code
- IDE Preference Settings to switch between VS Code and Cursor
- Read recent projects directly from VS Code/Cursor SQLite
- Recently opened files support
- Mac App Store sandbox compatible with folder access grant
