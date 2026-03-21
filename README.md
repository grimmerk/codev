# CodeV

Use this to quickly open and switch VS Code/Cursor projects, and use AI assistant to analyze your code and chat with it instantly.

## Features

### Quick Switcher for VS Code / Cursor Projects

Spotlight-like quick open: press `⌃+⌘+R` or click the menu bar icon to launch the Quick Switcher. Search and select a project to open or switch to it in VS Code or Cursor — even if the IDE is not running yet.

- **Recent projects** (white items): your latest VS Code/Cursor folders, workspaces, and recently opened files — read directly from IDE data, no extension required
- **Working folder items** (green items): first-level subfolders found by scanning a folder you choose (Settings → Working Directory)
- **Git branch display**: shows the current branch for each recently opened project
- Multi-word search across project names, paths, and branch names
- Supports VS Code and Cursor — switch between them in Settings → IDE Preference
- Remove items from the recent list by hovering and clicking "x"

**Download:** [Latest release (notarized DMG)](https://github.com/grimmerk/codev/releases/latest) · [Mac App Store](https://apps.apple.com/us/app/switchv/id1663612397) (v1.0.33, does not include Claude Code sessions or git branch features)

### Claude Code Session Switching

CodeV can list, search, and resume Claude Code sessions. Press `⌃+⌘+R` to open the Quick Switcher, then `Tab` to toggle to Sessions mode.

**For best accuracy** when you have multiple sessions in the same project directory:

1. **Start sessions with a name**: `claude -n "name"` (or `claude --name "name"`). Most reliable — works on all terminals.
2. **Or `/rename` in-session, then exit and resume**: bare `claude` sessions need `/rename` + exit + resume to be identifiable. Without this, CodeV may show the purple active dot on the wrong session.
3. **When resuming from terminal**: `claude --resume <uuid>`, `claude -r <uuid>`, or `claude -r "title"` all work. CodeV itself always uses `--resume <uuid>`.

**Same-cwd accuracy by launch method** (only matters when multiple sessions share the same project directory):

| How session was started | Detection (purple dot) | Switch: iTerm2 | Switch: Ghostty/cmux |
|------------------------|----------------------|----------------|---------------------|
| `claude -n "name"` | ✓ All terminals | ✓ Title match | ✓ Title match |
| `/rename`'d + resumed (`-r <uuid>` or `-r "title"`) | ✓ All terminals | ✓ Title match | ✓ Title match |
| `claude -r` picker → select `/rename`'d session | ✓ All terminals | ✓ Title match | ✓ Title match |
| `-r <uuid>` without `/rename` | ✓ All terminals | ✓ **TTY match** | ✗ cwd fallback |
| bare `claude`, no `/rename` | ✗ All terminals | ✗ | ✗ |

**Key**: iTerm2 has TTY matching as an extra fallback — it can switch correctly even without a custom title, as long as detection has the correct PID. Ghostty/cmux lack per-tab TTY ([ghostty#11592](https://github.com/ghostty-org/ghostty/issues/11592)), so they require a custom title for same-cwd accuracy.

**Terminal support:**

| Terminal | Switch method | Launch method | Notes |
|----------|--------------|---------------|-------|
| iTerm2 | Title match → TTY fallback | AppleScript new tab/window | Most reliable for same-cwd |
| Ghostty | Title match → cwd fallback | AppleScript new tab/window | Needs `/rename` for same-cwd |
| cmux | Title match → cwd fallback | CLI new-workspace | Needs `/rename` for same-cwd; requires socket access in cmux Settings (`automation` or `allowAll`) |

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
