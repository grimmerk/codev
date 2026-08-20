# CodeV

Quick switcher for VS Code/Cursor projects, Claude Code session manager with live status indicators, and built-in terminal.

**Download:** [Latest release (notarized DMG)](https://github.com/grimmerk/codev/releases/latest) · [Mac App Store](https://apps.apple.com/us/app/switchv/id1663612397) (v1.0.33, does not include Claude Code sessions or git branch features)

## Features

### Quick Switcher for VS Code / Cursor Projects

Press `⌃+⌘+R` or click the menu bar icon to launch the Quick Switcher. Search and select a project to open or switch to it in VS Code or Cursor — even if the IDE is not running yet. In Normal App mode, the window stays visible for monitoring; in Menu Bar mode, it works like Spotlight.

- **Recent projects** (white items): your latest VS Code/Cursor folders, workspaces, and recently opened files — read directly from IDE data, no extension required
- **Working folder items** (green items): first-level subfolders found by scanning a folder you choose (Settings → General → Working Dir)
- **Git branch display**: shows the current branch for each recently opened project
- Multi-word search across project names, paths, and branch names
- Supports VS Code and Cursor — switch between them in Settings → General → IDE
- Remove items from the recent list by hovering and clicking "x"
- **Quick-launch Claude session**: `⌘+Enter` to launch a new Claude Code session in the configured terminal, `⇧+Enter` to launch in CodeV's embedded terminal, `⌘+Click` as mouse alternative

### Claude Code Session Switching

CodeV can list, search, and resume Claude Code sessions. Press `⌃+⌘+R` to open the Quick Switcher, then `Tab` to toggle to Sessions mode. Live status dots show session state: working (orange pulse), idle (green), needs attention (orange blink).

Search covers **every session and every user prompt you ever typed** (not just the ~100 most recent sessions shown in the list) plus titles, branches, PR links, and last AI replies. When a match sits in the middle of a conversation, the row shows a `⌕ #N …` snippet with the surrounding context. Closed one-shot sessions (≤2 messages, untitled, no PR) fold into an expandable "minor sessions" row to keep the list scannable.

**Pin** the sessions you keep coming back to (hover 📌 on a row, or `⌘D` on the selected row): they **move into** a **📌 Pinned** zone at the top, ordered by recency like the rest of the list — works even for old sessions found via deep search. **Hide** one-offs you never want in the main flow (hover ⊘, or `⇧⌘D`): they move into the minor-sessions fold, stay searchable, and can be unhidden from inside the fold (they carry a persistent ⊘ marker there). Pins and hides live in `~/.config/codev/session-marks.json`, shared across accounts.

The `📌 Pinned (N)` header carries two independent toggles:

| Click | Effect |
|---|---|
| the `▾ 📌 Pinned (N)` label | **Group / ungroup.** Ungrouped (`▸`), pinned sessions drop back into their normal chronological position with a ★ instead of sitting in a block at the top — use it when you want one list purely in time order. Nothing is ever hidden either way. |
| the `only` chip on the right | **Pinned only.** The list — and the search box — is scoped to pinned sessions. Click again to leave. |

Keyboard semantics worth knowing: the shortcuts act on the **selected row** (the one with the blue left border — hovering selects), and require an explicit selection. `⌘D` = pin/unpin toggle; `⇧⌘D` = hide (on a pinned row this unpins *and* folds in one step — pin and hide are mutually exclusive). When the last pin is removed the header disappears entirely (that's normal, not a collapse). A pinned session is never folded away as a "minor session", whatever its message count.

**Simple rule**: when running multiple sessions in the same project directory at the same time, give each running session a name. Closed sessions don't need names — they won't cause issues.

- **Best**: start with a name — `claude -n "my task"` (or `claude --name "my task"`)
- **Or**: `/rename` in-session, then exit and resume (bare `claude` or `claude -r` picker sessions need this to be identifiable)
- **Temporary sessions**: no need to rename — just close them when done. Only sessions that are actively running alongside other same-directory sessions need names.
- **When resuming from terminal**: `claude --resume <uuid>` or `claude -r <uuid>` are most reliable. Note: `claude -r` (interactive picker) does **not** update process args after selection — it behaves like bare `claude` for detection. CodeV itself always uses `--resume <uuid>`.

For the full same-cwd accuracy matrix (detection + switch by launch method and terminal), see the [design doc](docs/claude-session-integration-design.md#same-cwd-session-matching).

**Terminal support:**

| Terminal | Switch method | Launch method | Notes |
|----------|--------------|---------------|-------|
| iTerm2 | Title match → TTY fallback | AppleScript new tab/window | Most reliable; cross-reference fixes detection for bare `claude` + `/rename`'d sessions |
| Terminal.app | Title match → TTY fallback | AppleScript `do script` | Built-in macOS terminal; same TTY accuracy as iTerm2 |
| Ghostty | Title match → cwd fallback | AppleScript new tab/window | Needs `/rename` for same-cwd. **Note:** Ghostty may not support `⌘+V` (paste) and `⌘+Z` (undo) in CodeV's search bar by default — add `keybind = super+v=paste_from_clipboard` and `keybind = super+z=undo` to `~/.config/ghostty/config` ([ghostty#10749](https://github.com/ghostty-org/ghostty/issues/10749#issuecomment-4131892831)) |
| cmux | Title match → TTY fallback | CLI new-workspace | Same as iTerm2 (requires cmux v0.63+); requires socket access in cmux Settings (`automation` or `allowAll`) |
| VS Code | URI handler (session-level) | `open -b` + URI handler | Requires Claude Code VS Code extension v2.1.72+; `[VSCODE]` badge on active sessions; adaptive resume via IDE lock file polling (~0.5s if project already open) |

### Multi-Account Support (Claude Code)

Run multiple Claude Code accounts (e.g. personal + work) on one machine. Each account gets its own config dir (via `CLAUDE_CONFIG_DIR`); the default account stays at `~/.claude` untouched. The Sessions tab aggregates sessions from every account (non-default ones get a purple account badge), and each session always resumes under the account it belongs to.

**Setup** — Settings → Accounts:

1. **Add** an account (e.g. `work`) — writes the registry (`~/.config/codev/accounts.json`) and generates `~/.config/codev/accounts.sh`
2. **Install** Shell integration — appends one marker-guarded `source` line to `~/.zshrc` (zsh; the generated file is bash-sourceable manually, fish unsupported)
3. Open a new shell and log in: `claude work`

**Shell commands** (from the generated `accounts.sh`):

| Command | What it does |
|---------|--------------|
| `claude` | Launches the **global default** account (configurable, see below) |
| `claude <name> […]` | Launches that account, full passthrough (e.g. `claude work -r`) |
| `claude-<name> […]` | Function form of the same (e.g. `claude-work mcp list`) |
| `claude-whoami` | Which account bare `claude` resolves to here, plus its auth status |
| `claude-accounts` | Quick list of configured accounts |

Tab completion included (zsh): `claude <TAB>` completes account names; `codev account <TAB>` completes subcommands and labels. (The `claude` completion is registered only when nothing else completes `claude` — if you already have one, account names won't be injected into it.)

The **default account** can be launched three equivalent ways: bare `claude`, `claude <its-name>`, or `claude-<its-name>` (the UI's row shows this).

**`codev account` CLI** (the account manager — same generator the Settings UI uses):

| Command | What it does |
|---------|--------------|
| `codev account list` (`ls`) | Accounts + identity; `*` marks the bare-`claude` default |
| `codev account add <name> [--dir D]` | Register an account (default dir `~/.claude-<name>`) |
| `codev account default <name>` | Point bare `claude` at an account |
| `codev account remove <name>` (`rm`) | Unregister; keeps its folder on disk |
| `codev account rename <old> <new>` | Rename a label — the folder is not moved; also the way to rename the auto-seeded default account (`personal`) |
| `codev account regenerate` (`regen`) | Rewrite `accounts.sh` from the registry |
| `codev account show` (`preview`) | Dry-run print of the generated `accounts.sh` |
| `codev account install` / `uninstall` | Add / remove the `~/.zshrc` source block |
| `codev account share <name>` | Sharing status for that account (claude-md / skills / commands) |
| `codev account share <name> <item> --link\|--copy [--entry E]` | Share the anchor's item — link stays in sync, copy forks |
| `codev account unshare <name> <item> [--entry E] [--restore-backup\|--keep-copy]` | Remove the link; `--restore-backup` = true undo, `--keep-copy` = keep a fork |
| `codev account sync-settings <name> <key...>` | Copy settings keys from the anchor (`statusLine`, `model`, `effortLevel`, `theme`) |

> **Add is just a mapping.** `add <name>` registers *name → config folder* (default `~/.claude-<name>` — that folder **is** the account's `CLAUDE_CONFIG_DIR`). Claude Code itself creates and fills the folder on first login (`claude <name>`). One folder = one account: registering an already-registered folder under a second name is rejected.
>
> **Name vs folder.** The name is a mutable label; the folder is fixed at creation. They can diverge (after a rename) and the UI shows `· folder: …` on the row when they do. Folders deliberately never move on rename: Claude Code keys the account's credentials by the config-dir **path**, so moving the folder would orphan the login.
>
> **Remove is non-destructive.** It only unregisters that mapping: the account's folder, login, and session history all stay on disk. `codev account add <name>` (or the UI) later reattaches everything — identity and sessions reappear immediately, no re-login needed. **Caveat after a rename:** the folder keeps its *original* suffix (rename never moves folders), so re-attach with the folder-matching name — e.g. an account created as `work`, renamed to `ff`, then removed, re-attaches via `add work` (or any name with `--dir ~/.claude-work`), **not** `add ff`. Likewise, an account originally registered with a custom `--dir` always needs `--dir <original-folder>` again on re-add.

**Common scenarios:**

| You are… | What happens / what to do |
|----------|---------------------------|
| An existing Claude Code user opening CodeV for the first time | Accounts tab is **empty** (zero footprint — no registry is created until you act); your `~/.claude` login keeps working as before. When you add a second account, **you name your existing login at the same time** (a field appears; empty = `main`) and both get registered together. |
| Renaming any account later | The **Rename** button on each row, or `codev account rename <old> <new>`. To pre-name your existing default before adding anything: `codev account add <name> --dir ~/.claude` (registers the default itself; no extra account created). `default` is a reserved name. |
| Starting fresh: add first, log in later | Add a name (UI or CLI) → it shows "not logged in" → in a new shell, `claude <name>` runs Claude Code's login and creates the folder. |
| Already running a second account by hand (own shell function + custom folder) | Register it with `codev account add <name> --dir <your-folder>` — **any folder works**; `~/.claude-<name>` is only the default. Identity and sessions attach immediately, no re-login. If your hand-rolled wrapper was named `claude`, retire it (it would fight the generated dispatcher). |
| Wondering why a name maps to a different folder | Renames change only the name side of the *name → folder* mapping; folders never move (credentials are keyed by the folder path) — the UI shows `· folder: …` on the row when they diverge. |

> Not yet supported: auto-detecting existing config folders for one-click registration, and a warning when `accounts.sh` overrides a hand-rolled `claude()` shell function ([#127](https://github.com/grimmerk/codev/issues/127)); continuing an existing conversation under a *different* account — "copy-fork" — needs transcript-level workarounds first ([#128](https://github.com/grimmerk/codev/issues/128)).

The `codev` command runs the CLI **bundled inside CodeV.app** (`ELECTRON_RUN_AS_NODE`) — no system Node, no sudo, no PATH edits. CodeV refreshes `accounts.sh` on every launch, so moving or renaming the app self-heals. (Not available in MAS builds — sandboxed.)

**Cross-account sharing** (also in the UI: each account row's **Sharing** button):

Share the anchor's global files with other accounts — per item, three choices: **Link** (symlink; one file, stays in sync, edits from either side land in the same place), **Copy** (independent fork), or skip. Never silently overwrites: existing content is backed up to a timestamped `.codev-bak-*` sibling first, which also makes **Unlink & restore** a true undo. Plain Unlink loses nothing (the anchor's copy is untouched; re-link anytime). The panel also has one-click **settings-key sync** buttons (`statusLine` / `model` / `effortLevel` / `theme`) and refreshes automatically when the window regains focus (so terminal-side file changes show up live).

| Item | Shareable? | How |
|------|------------|-----|
| Global `CLAUDE.md`, `skills/`, `commands/` | ✅ | Link or Copy (verified: Claude Code follows symlinks) |
| `statusLine` / `model` / `effortLevel` / `theme` | ✅ | `sync-settings` (per-key copy — they live in `settings.json`) |
| `plugins/` | ❌ | Per-account install state with absolute paths. Install and enable plugins in each account separately — `enabledPlugins` is per-account and **not** a syncable key |
| `.claude.json`, session data, hooks | ❌ | Identity / live-written / installed per-dir by CodeV |

**In the CodeV UI:**

| Where | What |
|-------|------|
| Settings → Accounts | List/add/remove/rename accounts, set the global default, install shell integration, per-account **Sharing** panel (link/copy/unlink + settings-key sync) |
| Sessions tab | Sessions from all accounts with account badges; resume uses each session's own account |
| Projects tab: `⌥⌘+Enter` | Pick the account for a new session (`⌘+Enter` stays instant, under the global default). Account override applies to external terminals (iTerm2, Terminal.app, Ghostty, cmux); VS Code ([#121](https://github.com/grimmerk/codev/issues/121)) and the embedded Term tab ignore it |

**Gotcha:** inside a Claude Code session, `!claude auth status` reports the *global default* (the shell snapshot carries the dispatcher function), not the session's account — use `!command claude auth status` instead. Full design + details: [docs/multi-account-support-design.md](docs/multi-account-support-design.md).

### Embedded Terminal

CodeV includes a built-in terminal tab (powered by xterm.js + node-pty, same technology as VS Code's integrated terminal). Press `⌃+⌘+T` from anywhere (global shortcut) or `⌘+3` when CodeV is in foreground to open it.

- Pre-spawned on app start for instant access
- Default working directory: Settings → General → Working Dir (fallback to home)
- Terminal state preserved when switching tabs
- `⌘+K` clears screen, `Shift+Enter` for multi-line input (Claude Code compatible)
- `Cmd+←/→` jumps to beginning/end of line
- **"Claude in Terminal" button**: launches a new Claude Code session in the configured external terminal using the current working directory

### App Mode

CodeV supports two window modes, configurable in Settings → General → App Mode:

| | Normal App (default) | Menu Bar |
|--|--|--|
| **Dock** | Visible | Hidden |
| **On blur** | Stays visible | Auto-hides |
| **Window position** | Remembers last position, draggable | Centers on screen each time |
| **On startup** | Shows window | Hidden until shortcut/tray click |
| **`⌃+⌘+R`** | Toggle show/hide | Toggle show/hide |
| **Click Dock icon** | Shows hidden window | N/A |
| **Best for** | Dashboard / monitoring (keep in corner) | Quick access (spotlight-like) |

**Real-time updates when unfocused (Normal mode):** Status dots, final assistant/user messages, and session order update via fs.watch — no need to re-focus. New sessions and full list refresh only occur on re-focus.

### Tab Switching

| Shortcut | Action |
|----------|--------|
| `Tab` | Toggle between Projects ↔ Sessions |
| `⌃+Tab` | Cycle all tabs forward |
| `⌘+[` / `⌘+]` | Cycle all tabs backward / forward |
| `⌘+1` / `⌘+2` / `⌘+3` | Jump to Projects / Sessions / Terminal |

### AI Assistant feature

#### Insight Chat mode

1. Select the code or text you want to get analyzed insight in any editor or even on web page.
2. Press `⌘+C` to copy the selected code to your clipboard.
3. Press `⌃+⌘+E` to open the Code AI Assistant window, which will:
   - Create a floating window with the code from your clipboard
   - Generate an insight using Anthropic Claude
4. The window will display your code and start generating an insight.
5. You can use the input text field to continue the discussion.
6. You can custom your prompt on the menu bar.

> Note: For a smooth demonstration workflow, make sure to copy your code to the clipboard before triggering the Code AI Assistant with ⌃+⌘+E.

**You can click the toggle on the top bar and switch to `Insight Split view mode`**.

#### Chat from Selection mode

When you customize the prompt as empty, you can still copy your code first, and trigger `⌃+⌘+E`, it would still navigate to the AI Assistant view without triggering insight generation, then you can input your follow-up message to discuss with AI.

#### Smart chat mode

Trigger `⌃+⌘+C` shortcut to launch pure AI chat mode, just like the Claude or ChatGPT desktop

#### Additional Features

- Syntax highlighting for various programming languages
- Streaming explanation that updates in real-time
- Automatic language detection
- Error handling

#### How AI Assistant Works

- The Code AI Assistant uses Claude API to generate explanations/insight.
- The API request is made from the main Electron process (not the renderer) for security.
- Explanations/Insights are streamed in real-time for a better user experience.
- The UI is a semi-transparent floating window that can be closed when not needed.

#### Setup

1. Make sure you have an Anthropic API key. You can get one from [Anthropic's website](https://console.anthropic.com/).

2. Set up your API key on the menu bar (-> Setting -> API key setting), or add your API key to the `.env` file in the root directory:

   ```
   ANTHROPIC_API_KEY=your_api_key_here
   ```

## Development

- Do the following in the `root folder`:
  - `yarn install`
  - DB setup
    - For the first time or every time db scheme changes, execute `yarn db:migrate` to generate SQLite DB file (`./prisma/dev.db`) and generate TypeScript interface. `yarn db:view` can be used to view DB data.
      - `db:migrate` will also automatically do this part, `yarn install` will also include generated types in node_modules/.prisma/index.d.ts)
  - `yarn start`

> **Git worktree note:** Prisma 4.x downloads native engine binaries during postinstall, but `yarn install` in a worktree may not trigger this correctly. If you see `PrismaClientInitializationError: Unable to require libquery_engine-darwin-arm64.dylib.node`, copy the binary from the main repo: `cp <main-repo>/node_modules/@prisma/engines/libquery_engine-darwin-arm64.dylib.node node_modules/@prisma/engines/`

### SQLite database locations

CodeV uses its own SQLite database (via Prisma) for storing user settings, AI assistant settings, and conversation history. Recent projects data is read directly from VS Code/Cursor's `state.vscdb`.

- **Development:** `./prisma/dev.db`
- **Production (non-MAS):** `~/Library/Application\ Support/CodeV/dev.db`
- **Production (MAS sandbox):** `~/Library/Containers/com.lifeoverflow.switchv/Data/Library/Application\ Support/CodeV/dev.db`

Note: paths with spaces require escaping with `\` in the terminal (e.g. `Application\ Support`).

Database models and their current usage:

| Model | Purpose | Status |
|-------|---------|--------|
| User | Stores `workingFolder` path | Active |
| AIAssistantSettings | API key, custom prompt, IDE preference, left click behavior | Active |
| Conversation | AI chat conversation history | Active |
| Message | AI chat messages | Active |
| VSWindow | Legacy — was used by the old VS Code extension to send window records via HTTP. No longer written to since migrating to reading VS Code/Cursor's `state.vscdb` directly. | Deprecated |

### Use VS Code Debugger

#### To debug main process

In VS Code Run and Debug, choose `Electron: Main Process` to launch and debug.

#### To debug render process, please directly set up breakpoints in the opened dev tool instead, which is what Electron official site recommends

Ref: https://www.electronjs.org/docs/latest/tutorial/application-debugging#renderer-process.

p.s. We had tried to use VS Code debugger setting for this, but it became invalid after migrating to the new version of Electron.

## Packaging a macOS app

### Packaging an app

- package a mac app: `yarn make`. Then you can move/copy out/CodeV-darwin-arm64/CodeV.app to your application folder and use it daily.

### Packaging an MAS built pkg for submitting to App Store

#### Prerequisites: Certificates and Provisioning Profile

1. **Create certificates** in Xcode → Settings → Accounts → Manage Certificates, or via [Apple Developer website](https://developer.apple.com/account/resources/certificates/list). You need:
   - `Apple Distribution: Your Name (TEAM_ID)` — for signing the app
   - `3rd Party Mac Developer Installer: Your Name (TEAM_ID)` — for signing the pkg
2. **Download and import** the certificates: double-click the `.cer` files or use Keychain Access → File → Import Items.
3. **Import the intermediate certificate**: If code signing fails with "valid signing identity not found", you may be missing the intermediate certificate. Download [Apple Worldwide Developer Relations Certification Authority](https://www.apple.com/certificateauthority/) and import it into Keychain Access (System keychain).
4. **Create a provisioning profile** on the [Apple Developer website](https://developer.apple.com/account/resources/profiles/list) → Profiles → Mac App Store distribution. Select the App ID and distribution certificate. No device registration is needed for MAS profiles (that's only for iOS/Ad Hoc). Download and save as `embedded.provisionprofile` in the project root.

Ref: [Electron MAS submission guide](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide#prepare-provisioning-profile), [Electron code signing](https://www.electronjs.org/docs/latest/tutorial/code-signing#signing--notarizing-macos-builds)

#### Build and submit

1. Execute `yarn make_mas` to generate the app.
2. Execute `sh ./sign.sh` to convert app to pkg.
3. Use [Transporter](https://apps.apple.com/app/transporter/id1450874784) to upload the pkg to App Store Connect, then submit for review.
4. Note: The MAS build runs in a sandbox. Users need to grant access to IDE data via IDE Settings → Grant Access so CodeV can read the recent projects list.

### Packaging for non-App Store distribution (with notarization)

macOS 10.15+ requires notarization for apps distributed outside the App Store, otherwise Gatekeeper will block them.

#### Prerequisites

1. **Create a "Developer ID Application" certificate** on the [Apple Developer website](https://developer.apple.com/account/resources/certificates/list) → Certificates → + → Developer ID Application. Choose G2 Sub-CA. You'll need a CSR file (Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority → Save to disk).
2. **Import the certificate** and its intermediate cert. If codesign fails with "unable to build chain to self-signed root", download the [Developer ID G2 intermediate certificate](https://www.apple.com/certificateauthority/) (`DeveloperIDG2CA.cer`) and import it: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain DeveloperIDG2CA.cer`
3. **Create an App-Specific Password** at [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords. This is used by `notarytool`.
4. **Set environment variables** in `.env`:
   ```
   APPLE_ID=your@email.com
   APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   APPLE_TEAM_ID=GL35G6YCWG
   ```

No provisioning profile is needed for non-MAS distribution.

#### Build, sign, and notarize

1. Execute `yarn make` to generate the app.
2. Execute `sh ./sign-notarize.sh` — this will sign with Developer ID, create a DMG, submit for notarization (takes ~2-5 min), and staple the ticket.
3. The output `./out/CodeV.dmg` is ready to distribute.

Key differences from MAS build: uses Developer ID (not Apple Distribution) certificate, no sandbox, hardened runtime required, entitlements are in `notarize-parent.plist` (main app: hardened runtime + network + file access) / `notarize-child.plist` (helpers: hardened runtime only). Since there's no sandbox, using a single plist for both would also work, but we split them for consistency with the MAS build's `parent.plist` / `child.plist` pattern and to follow the principle of least privilege.

Ref: [Electron code signing & notarization](https://www.electronjs.org/docs/latest/tutorial/code-signing#signing--notarizing-macos-builds)

### Server packaging takeaway notes

ref:

1. https://github.com/prisma/prisma/issues/8449
2. ~~https://github.com/vercel/pkg/issues/1508~~ (we had use vercel/pkg to package server but we have decided to embed server to electron)

## Key development notes

1. shared in the FOSSASIA 2025 summit talk https://slides.com/grimmer/fossasia-2025-switchv-streamlining-developer-workflow-with-an-open-source-vs-code-launcher
2. On MacOS, the created Electron BrowserWindow object may be destroyed by the system automatically somehow due to the resource management (e.g. running in the background for a while and memory is tight), so we need to check if a windows `isDestroyed()` result when reusing them.
3. React UI takeaway
   1. Pay an attention to React closure trap. E.g. if we register some callback function in the `useEffect(()=>{ /*...*/}, []});`, it may always use some initial state value, even its implementation is outside this useEffect, the solution is to use the useRef version of that state.
   2. Updating state may not take an effect immediately. If you have some logic which is checking the value as some condition, you may update `useRef` version of that state when you update the state.
