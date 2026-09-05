# Changelog

## 1.0.89

- Feat: a search result explains itself and can be walked ([#141](https://github.com/grimmerk/codev/issues/141), [#146](https://github.com/grimmerk/codev/issues/146))
  - **Every hit, not the first.** The `match #N` line gains `‹ 2/12 ›` when a session's prompts hit more than once, stepping the snippet through them; the main-side search now returns up to 20 hits per session, each with its prompt time
  - **The prompts around a hit**, one click (`▸`) away on the match line: the prompt before (`↑`) and after (`↓`). The smallest useful version of the reader in #66 — user prompts only; assistant text is not in the index
  - **`by match`** chip while searching: order results by when the match happened instead of the session's last activity, so the session where you typed the word an hour ago is not buried under one touched five minutes ago. Off by default — "what was I just working on" is the commoner question
  - **`match path` / `match assistant` / `match recap` / `match reply`** lines say which field a row matched in when that field is not on the row (the path, the assistant's mined references, a recap the row is not showing, a reply hidden behind a recap). Fields that render — title, branch, project name, badge, first/last prompt — already carry the highlight, so they add no line: vertical space stays the scarce resource
- Feat: switch to a running session by its **terminal (tty)** first, title second ([#142](https://github.com/grimmerk/codev/issues/142) C0). Three `/branch` siblings deliberately share a title, and the title-first match sent every one of their rows to the same iTerm2 tab; a process has exactly one tty, so that is what the click matches now (iTerm2 and Terminal.app; Ghostty has no per-tab tty, [#63](https://github.com/grimmerk/codev/issues/63), and keeps title-then-cwd). Running rows that share a title show their tty (`·ttys003`) so they can be told apart on screen
- Feat: a **memory warning chip** beside `● live` when the machine is under pressure — swap past 8GB, or macOS's own pressure level at warn (amber) / critical (red) — with the figures in the live chip's tooltip otherwise. Read from `sysctl vm.swapusage` and `kern.memorystatus_vm_pressure_level` on the same refresh as the process table, so it costs nothing extra. Added the night 42 `claude` processes at 5.1GB pushed a 32GB machine to 18GB of swap: swap was the number that said so first
- Feat: **normal app mode's window can be resized** and reopens at its last position and size (a remembered window that would land on an unplugged display is ignored); the header is already a drag region, so the macOS title-bar double-click action applies to it ([#148](https://github.com/grimmerk/codev/issues/148) step 1; width-aware line caps are step 2)
- Fix: a session parked at Claude Code's context-limit prompt no longer shows as `working` forever — no hook fires there, so a `working` status untouched for 10 minutes is shown as idle ([#110](https://github.com/grimmerk/codev/issues/110))
- Docs: README on keeping the machine responsive — sessions grow with time, Spotlight should skip `~/Library/Application Support/Claude` and `~/.claude`, and what the swap chip means

## 1.0.88

- Feat: aim the search — field-scoped terms, PR references in any spelling, `is:live`, and a persisted enrichment cache ([#140](https://github.com/grimmerk/codev/issues/140), [#134](https://github.com/grimmerk/codev/issues/134))
  - **Operators**: `title:x` `branch:x` `msg:x` `project:x` `account:x` `recap:x` search one field; `has:pr|title|branch|recap`; `is:live|pinned`; `after:7d` / `after:2026-09-01` / `after:today` and `before:…` by last activity; `"two words"` keeps a phrase together. Bare words keep today's meaning. Every term must hold. A `?` chip beside the search box shows the list; an operator with an unreadable value is reported under the box and ignored rather than silently matching nothing
  - **A pull request in any spelling**: `#147`, `pr:147`, `owner/repo#147` and the GitHub URL all find each other, in your prompts and in what the assistant said. Measured on the reference machine's prompts: 80.6% of PR mentions were reachable by only one form before. Delimited forms only — `#147` never hits `#1475` or `15980`. Three levels of strictness, set by the first live test: `#147` is broad (any mention, any repo); `pr:147` counts only a session's own PR badge or a repo-qualified mention (`owner/repo#147` or the URL, in any repo); a repo in the query (`owner/repo#147`, the URL, `pr:owner/repo#147`) accepts a bare `#147` only in sessions whose own badge or references name that repo. (That test listed eight sessions for `pr:151`; most were the miner reading `#151` out of longer identifiers such as the hex colour `#151e2b` — fixed by a right-side boundary on both sides — and the strict levels stay because every repo does have its own 151.) Claude Code's `[Image #N]` marker for a pasted screenshot is not a PR reference (found matching a session whose only "#151" was `[Image #151]`)
  - **The assistant's replies are mined for the PRs it mentioned** (its text and the commands it ran; never tool output, so a session that ran `gh pr list` did not "work on" twenty PRs), so "the PR you opened for me" is findable by number. Measured: 91 transcripts / 739MB mined in 2.0s cold, then incrementally from the byte where the last pass stopped; 3,889 references across 65 sessions
  - **One matcher, two callers**: the main-side full-prompt search and the renderer's filter now compile the same query into one matcher and differ only in what each side can put on the target (`is:` is judged in the renderer, everything else on the main side, which also sees title / branch / recap for every session now). Search stays behind the 180ms debounce: 7–10ms per keystroke for words, ~20ms for a PR reference, over 560 sessions
  - **The enrichment cache survives a restart** (`~/.config/codev/enrichment-cache.json`): title, branch, PR badge, recap, mined references and per-file mtime+size, written a few seconds after a scan and flushed on quit. A second launch starts warm and re-reads only transcripts that changed. A bad file is a cold start, never an error. **One background pass over every session** runs 20s after launch, in chunks with pauses, so operators see every session and not just the loaded window; measured 6.8s cold for the whole corpus, stat-only afterwards
- Feat: `▶ open N` on a saved list — resume the members that are **not** running ([#145](https://github.com/grimmerk/codev/issues/145))
  - For the moments that want the whole set back: after a reboot or macOS update, after closing everything to reclaim memory, or to move the set to another terminal app (change the terminal in Settings, then press it). Reverses 1.0.87's "deliberately no open all" — same reasoning, different moments: the cost is real, so it is shown on the button (`open 12 · ~1.7GB?`, from the mean size of the processes currently running) and confirmed with a second click
  - Opens only members without a running process by the `ps` join, so pressing it twice opens nothing new; launches one session every 0.7s rather than all in one tick; reports members skipped because their project folder or transcript is gone. Under the embedded CodeV terminal it explains itself instead of opening twelve sessions into one pane
  - Fix on the way: each terminal launch now writes its own temp AppleScript file — the shared name meant one launch's cleanup could delete the script the next osascript was about to read once launches were 0.7s apart
- 30 new unit tests (query tokenizer / parser / matcher, PR-reference boundaries, cache round-trip, the miner against real-shaped records) — 168 total

## 1.0.87

- Feat: saved session lists and a live-process view, on the Session Buddy model ([#145](https://github.com/grimmerk/codev/issues/145), [#94](https://github.com/grimmerk/codev/issues/94))
  - **`● N live` chip** next to the search box scopes the list to sessions with a running process; the total memory they hold shows beside it. A **`stats`** toggle (off by default, remembered) adds each row's **memory and uptime** for the "which one to close first" moment — off by default because on most rows those figures track the message count closely enough to be noise. Pid and terminal device live in the tooltip. Measured while building it: 36 `claude` processes held 4.66GB while the terminal app itself held 368MB
  - The live view is built by joining `ps` against `~/.claude/sessions/`, not by trusting the registration files: a session that is running but never registered shows up marked **`⚠ unregistered`** (invisible to every other view), and a registration whose process is gone is counted as stale in the chip's tooltip instead of being shown as a ghost. The same join also tells a saved-list member whether it is running, so clicking a running session that has no history row yet (a fresh `/branch` child) switches to it instead of resuming a second copy
  - **`save list…`** captures what is on screen — the live set, the pinned set, or a search result — as a named list, stored in `~/.config/codev/session-lists.json`
  - **`🗂 N` chip** shows the saved lists; click one to view its members in the order they were captured and resume any of them. Lists can be renamed (`✎` on the row or in the list header) and deleted (`✕`, confirmed with a second click). The default name is today's `MMDD` — a label, not an identity — and becomes `MMDD-2`, `MMDD-3` on a second save that day. A member whose transcript is gone still reads as the session it was, because the list stored its title, branch and last messages
  - Each member carries the **recap line** Claude Code writes into the transcript (`away_summary` — "where we are, what's next"), shown on the row in place of the last reply. Measured: 65 of 66 non-trivial sessions have one. A recap that predates the session's last activity by more than 30 minutes is marked `⏱`, because its "next step" may already be done
  - **Search matches the session id** (both search paths, one shared rule), so the id a terminal status line shows finds the session — the one field that stays unique when several sessions share a name ([#142](https://github.com/grimmerk/codev/issues/142)). The rule is a **prefix of at least four hex characters**, never a substring — `de` or `cafe` would otherwise match nearly every session through its id. A row that matched on its id shows an `id 4ed7505a` marker, since the id is not otherwise on screen
  - A session with **two running processes** (a resumed copy, or a `/branch` parent and child) shows both in the live scope, the second marked `⚠ 2nd process`, so the chip's count and the list agree and the memory total adds every process
  - The marks and lists stores are now written with owner-only permissions (`0600`); the lists store carries conversation snippets
  - **A scope survives resuming from it.** Open a session from a saved list or from the live scope, come back, and you are still in that list / that scope — a scope is a place to work through several sessions. Only the search box is cleared on return, as before
  - Deliberately absent: an "open all" button. Reopening 22 browser tabs is cheap; resuming 22 sessions is ~3GB of processes, which is the problem this feature exists to relieve
  - Under the hood: the marks store and the new lists store share one atomic-JSON-store module (`src/atomic-json-store.ts`) — the read-authority invariant PR #137 spent four review rounds on now has exactly one implementation. 53 new unit tests (lists normalize / transitions / file roundtrip / normalizer fixed point / untrusted-file inspection, `ps` parsing and the live join, list-view scopes, session-id prefix search) — 138 total

## 1.0.86

- Feat: session rows are readable again when titles are long
  - **Long titles now shorten from the middle** (`head … tail`) instead of losing everything past 35 characters. Measured on a 125-title corpus: the median title is **44 characters** against that 35-char cut, **64% of titles run past it**, and **48 of them shared their first 35 characters** — eight different sessions all rendered as `fred-ff nextjs backend and mcp arch`. Titles written as `A -> B > C` chains keep their newest step, which is the part that identifies the session
  - **Hover a title to read it in full** — the row shows a shortened form, the tooltip shows everything
  - **Searching moves each line's window to the match.** Every capped line — title, first and last message, branch, last AI reply — now shows *why* the row matched instead of filtering it in and showing nothing (39% of first prompts and 42% of last prompts were longer than the space they render in)
  - **The `match #N` line is no longer mistaken for a message line** ([#138](https://github.com/grimmerk/codev/issues/138)): it was the same grey as the first-message line with an unreadable `⌕` glyph; it is now amber, in the same family as the search highlight, with a labelled marker

## 1.0.85

- Feat: three ways to browse pinned sessions, from the same `📌 Pinned (N)` header
  - **Pinned zone now sorts by recency** like every other list (it used to sort by when you pinned, which buried the session you touched five minutes ago beneath months-old pins)
  - **Collapsing the zone now ungroups instead of hiding**: pinned sessions fall back to their normal chronological position, still marked ★ — that gives you a pure "everything in time order" list, and no browsing state can make a pinned session invisible any more
  - **New `only` toggle** on the right of the header: show — and search — pinned sessions only
  - A pinned session is never folded away into the "minor sessions" group, and pins older than the loaded list stay visible in every mode
  - Searching now also matches the title / branch / PR link of pinned sessions older than the loaded list — previously such a pin was visible while browsing but reported as "no match" the moment you searched for its name
  - The `N sessions` count next to the search box reports the scoped total while `only` is on, instead of the unfiltered one

## 1.0.84

- Feat: session pins & manual hide — session-finding Batch 1 PR-2 (plan: `docs/session-finding-plan.md` §4.4)
  - **📌 Pinned zone** at the top of the Sessions list (collapsible, state remembered): pin via the hover 📌 icon on any row or `⌘D` on the selected row; a pinned session ALSO keeps its chronological spot (marked ★) — the zone is a shortcut, not a move
  - Pins work on any displayed row, including deep-search matches beyond the loaded ~100 (the zone fetches those by id and lazily enriches them)
  - **Hide** (hover ⊘ or `⇧⌘D`): forces a session into the minor-sessions fold — reversible from inside the expanded fold, still searchable; pin and hide are mutually exclusive (pinning unhides, hiding unpins)
  - While searching, the pinned zone steps aside and results are one unified list (★ still marks pinned matches)
  - Store: `~/.config/codev/session-marks.json` (single cross-account file, fs.watch-pushed to the UI, temp+rename writes); sessionIds are resume-stable so no migration logic is needed
  - 7 new unit tests (marks normalize / pin-hide transitions / file roundtrip) — 52 total

## 1.0.83

- Feat: session finding Batch 1 — "search & noise" (plan: `docs/session-finding-plan.md`)
  - **Search now covers ALL sessions × ALL user prompts** (fixes #131 — previously only the ~100 loaded sessions' visible fields were searchable, leaving ~3/4 of history unfindable): a debounced main-process search scans every prompt of every session (multi-account) and appends matches beyond the loaded list, with lazy enrichment
  - **Matched-prompt snippet line** (`⌕ #N …context…`) shows *why* a row matched when the hit is in a middle prompt that isn't visible in the row
  - **High-contrast search highlight**: unified amber background + dark text (the old per-field translucent styles were near-invisible on colored text)
  - **Minor-session folding**: closed, untitled, PR-less sessions with ≤2 messages collapse into an expandable "N minor sessions" row (search always shows everything; manual hide comes with the pins PR)
  - Prompt text stays in the main process — only small snippets cross IPC; search is in-memory (ms-scale) and does not touch the list-refresh path
- Fix (pre-existing): custom titles / branch names no longer vanish at random
  - Per-session enrichment greps now run in bounded batches of 10 (was ~400 concurrent process spawns, which pushed the biggest transcripts past the silent 3s exec timeout; timeout also raised to 5s)
  - Branch is read from the last 50 transcript lines instead of 5 — an active session's tail is often tool output with no `gitBranch` field (measured: tail -5 hit 0, tail -20 hit 12)
  - Enrichment cache is now mtime-keyed per transcript (#134): unchanged files are never re-grepped (a ~ms `stat` pass replaces the 5s wall-clock TTL, whose entry-time stamp made any >5s scan stale on arrival — perpetual rescans); concurrent callers are serialized onto one accumulated cache; scan batches went 10 → 25 for a faster cold start
  - Enrichment reads are now shell-free (`execFile` + in-process tail read): no interpolated paths near a shell, and a timed-out/failed read no longer marks the transcript as scanned — it retries on the next pass
- Minor-session fold UX: sticky boundary header while scrolled inside the group, plus an always-visible fold bar under the list while expanded; folding resets on each popup show; all fold controls are keyboard-accessible (Enter/Space)

## 1.0.82

- Feat: multi-account Batch 3 — cross-account sharing (share engine + CLI + UI)
  - Share the anchor's `CLAUDE.md` / `skills/` / `commands/` with other accounts: **Link** (symlink, stays in sync) or **Copy** (independent fork), per item
  - Never silently overwrites: existing content is backed up to `.codev-bak-<ts>` first; **Unlink & restore** is a true undo, plain Unlink loses nothing (source untouched)
  - UI: per-account **Sharing ▸/▾** panel (per-item status + Link/Copy/Unlink/**Unlink & restore**; recognizes pre-existing hand-made symlinks; refreshes on window focus so terminal-side file changes show up live) plus one-click **settings-key sync buttons** (`statusLine`/`model`/`effortLevel`/`theme`)
  - CLI: `codev account share|unshare` (`--entry` for single skills/commands entries, `--restore-backup`/`--keep-copy` on unshare) and `codev account sync-settings <name> <keys>` (same allowlist; hooks/`enabledPlugins`/permissions deliberately excluded)
  - `plugins/` is NOT symlink-shared (per-account install registry with absolute paths — verified by experiment)
  - Hardening from review: unshare validates the restore/keep-copy source *before* unlinking; keep-copy stages to a unique temp first (no TOCTOU); backup names uniquified beyond 1s precision; malformed settings.json fails with the path; real-fs integration tests cover the engine (14 cases, 35 total)

## 1.0.81

- Refactor: registry field `isDefault` → `isAnchor` (naming collision fix)
  - The per-account flag marks the **anchor** (`~/.claude`) account; the *dispatcher default* is the top-level `defaultAccount` — the old name conflated the two (an account could read `isDefault: true` while not being the bare-`claude` default)
  - No compatibility shim: the registry format never shipped in a release, so the key simply changed (a missing flag is inferred from the dir — `~/.claude` is the anchor by definition); no behavior change

## 1.0.80

- Feat: multi-account Batch 2c-lite — pick the account when launching a new session
  - `⌥⌘+Enter` on a project opens a small account picker (↑↓ / Enter / Esc, or click) — external terminals (iTerm2/Terminal.app/Ghostty/cmux); a non-default pick launches via explicit `CLAUDE_CONFIG_DIR` + `command claude`, a default-account pick via `env -u CLAUDE_CONFIG_DIR claude`
  - Plain `⌘+Enter` unchanged: opens instantly under the global default; single-account (or registry-less) setups never see the picker
  - Search-bar hint shows `⌥⌘+Enter: pick account` only for multi-account setups, and updates live after account changes (no app restart)
  - Tab completion for `claude <name>`: `claude <TAB>` completes account names (polite: skipped if another completion owns `claude`; other positions keep file completion)
  - Removed the stray `|` (react-select's default separator) before the search-bar hint
  - Accounts UI: per-row **Rename**; the first-ever add asks what to name your existing `~/.claude` login (defaults to `main`) instead of assuming `personal`; `default` is now a reserved account name
  - `codev account rename <old> <new>` (CLI) — labels are renameable; folders never move (credentials are keyed by the folder path)
  - README gains a Multi-Account section (shell commands, `codev account` CLI, UI map)
  - Roadmap: 2d (folder→account auto-switch) dropped — one folder legitimately hosts sessions from multiple accounts; cross-account *resume* stays deferred to Batch 3 (copy-fork design)

## 1.0.79

- Feat: multi-account Batch 2b (part 2) — `codev` command in your shell
  - `codev account list|add|default|remove|regenerate|show|install|uninstall` works in the terminal: `accounts.sh` gains a `codev()` launcher that runs the CLI bundled inside CodeV.app via `ELECTRON_RUN_AS_NODE` (no system Node required)
  - CodeV records its real `.app` location on every launch and refreshes `accounts.sh` — moving the app self-heals, and generator updates propagate without manual `regenerate`
  - The CLI is compiled into the app at build time (`resources/cli` extraResource)
  - zsh tab completion for `codev` (subcommands + account labels); MAS builds skip the `codev()` launcher (sandboxed + no `ELECTRON_RUN_AS_NODE`)

## 1.0.78

- Feat: multi-account Batch 2b (part 1) — Accounts tab in Settings
  - List accounts (identity, default marker), add (with log-in hint), remove, and set the global default — via IPC over the same shared generator the `codev account` CLI uses
  - Shell-integration install/uninstall (`~/.zshrc` source block) from the UI
  - Remaining 2b item: a real `codev` binary on PATH

## 1.0.77

- Feat: multi-account Batch 2a + 2e — `codev account` CLI + configurable global-default
  - `codev account list | add <label> [--dir D] | default <label> | remove <label> | regenerate | show | install | uninstall`
  - One shared generator (`src/cli/account-manager.ts`) produces both `~/.config/codev/accounts.json` and `accounts.sh`, replacing Batch 1's hand-editing; run in dev via `yarn account <cmd>` (PATH install + Settings UI land in Batch 2b)
  - Batch 2e (global-default): `codev account default <label>` + the shell dispatcher route bare `claude` to a chosen account; CodeV resume now uses `command claude` (bypasses the dispatcher) so a non-anchor global-default can't misroute an anchor-account resume
  - Adds Vitest + a generator test suite, and a real CI workflow (replacing the placeholder)

## 1.0.76

- Feat: multi-account support (Batch 1) — run multiple Claude Code accounts (e.g. personal + work) from one machine
  - Sessions tab aggregates sessions across all accounts (recency-merged), badges non-default accounts, and resumes each under its own account (`CLAUDE_CONFIG_DIR`)
  - Per-account active dots, custom titles/branches, previews, and status hooks
  - CLI helpers via `~/.config/codev/accounts.sh`: `claude <account>` / `claude-<account>`, `claude-whoami`, `claude-accounts`
  - Fully opt-in: with no `~/.config/codev/accounts.json` registry (or a single account), CodeV behaves exactly as before
  - Setup is manual for now (registry + `accounts.sh`); a management UI/CLI is planned. VS Code sessions can't be account-switched (#121). See `docs/multi-account-support-design.md`.

## 1.0.75

- Feat: Sessions search clears after opening a session
  - Opening a session (Enter or click) clears the search keyword on return; the full list is shown again
  - Toggling away without selecting (shortcut/Esc/blur) keeps the keyword so you can resume searching

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
