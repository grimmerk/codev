# Multi-Account Support — Design Doc

Status: **Draft / for review.** Covers CLI-level multi-account for Claude Code plus
CodeV Sessions-tab integration. Verified against Claude Code **2.1.201** on macOS.

---

## 0. TL;DR

- **Model: one Claude Code config dir per account** via `CLAUDE_CONFIG_DIR`.
  Default account stays at `~/.claude`; each extra account is `~/.claude-<label>`
  (e.g. `~/.claude-personal`). Verified that this isolates sessions, settings,
  account identity (`.claude.json` → `oauthAccount`), and — pending one final
  interactive check (§3.3) — credentials.
- **CodeV never touches tokens.** It only ever sets `CLAUDE_CONFIG_DIR` and launches
  the official `claude` binary. This keeps us inside Anthropic's "using the official
  product" safe harbor (§2) regardless of how the third-party-token policy swings.
- **CLI:** CodeV generates thin per-account shell functions (`claude-personal …`)
  and, optionally, a `claude <account> …` dispatcher, installed via a single sourced
  file. All native flags (`-r`, `--resume`, `mcp`, …) pass through untouched.
- **CodeV Sessions:** scan **every** registered config dir, tag each session with its
  account, show an account badge, and resume/launch with that account's
  `CLAUDE_CONFIG_DIR`. This makes "resume with the account it was opened with"
  (requirement 4.1) fall out for free — the account *is* the config dir the session
  lives in.
- **Cross-account file reuse:** per-project `CLAUDE.md` / `.claude/` are already
  shared (they live in the project). Global `CLAUDE.md` / skills / commands / plugins /
  settings are shareable via opt-in symlinks. Session data is intentionally *not*
  shared — it is aggregated for display instead.

---

## 1. Requirements (traceability)

| # | Requirement | Priority | Where addressed |
|---|-------------|----------|-----------------|
| 1 | CLI can pick account: `claude --account2` / `claude personal` | Must | §6.A |
| 2 | Preserve all existing `claude` behavior (`-r`, etc.) | Must | §6.A |
| 3 | Env-var points at account/config folder | (mechanism) | §3, §4 |
| 4.1 | CodeV resume/reopen uses the session's original account | Must | §6.E |
| 4.2 | CodeV: optionally pick a different account | Nice | §6.G |
| 5 | CLI multi-account config easy (must); CodeV config (nice) | Must/Nice | §6.C, §6.D, §6.G |
| 6 | pyenv-style auto-switch by project folder | Nice | §6.H |
| 7 | UI/UX fits current Sessions/Projects/Settings | Must | §6.E, §6.G |
| 8 | CLI installed by CodeV (auto or on-click), hook-style | Must | §6.C |

---

## 2. Is this allowed? (ToS / third-party-token policy)

**Having multiple personal accounts is not a ToS violation.** Anthropic staff have
stated it is fine to hold multiple Max accounts; the personal ↔ Team/Enterprise
switch is an officially supported flow.

**What *is* prohibited** is (a) sharing/reselling a single account across people, and
(b) *using subscription (Free/Pro/Max) OAuth tokens in another product, tool, or
service — including the Agent SDK*. This second rule is the one whose enforcement
messaging has flip-flopped over time (the "we'll block subscription-auth in
third-party agents" back-and-forth).

**Why CodeV is unaffected — three tiers of "using a subscription":**

| Tier | Example | Policy |
|------|---------|--------|
| ① Run the official `claude` binary (any flags, incl. `-p`) | CodeV launching `claude` | ✅ Always sanctioned |
| ② A third-party tool uses the subscription OAuth token to drive the model | OpenCode/Cline with Max login; Agent SDK on a subscription token | ⚠️ The contested/prohibited zone |
| ③ API key | pay-as-you-go | ✅ Separate, unrelated |

CodeV lives entirely in tier ①: it sets an env var and execs the official CLI. It
**never reads the OAuth token, never calls the model, never embeds an agent.** Even
`claude auth status` (used only to label accounts) makes no model call. Self-imposed
red line: **CodeV must never drive the model using a subscription token** — stay a
launcher, not an agent.

---

## 3. Verified mechanism (foundation)

### 3.1 What `CLAUDE_CONFIG_DIR` relocates (empirically confirmed)

Running `CLAUDE_CONFIG_DIR=/tmp/x claude -p "…"` created:

```
/tmp/x/.claude.json          ← moved here (holds oauthAccount identity, per-project state, MCP user config)
/tmp/x/projects/…            ← session history / transcripts
/tmp/x/sessions/             ← active-session PID files
/tmp/x/backups/
```

So **the entire per-user Claude state — including `.claude.json` and its
`oauthAccount` block — is config-dir-scoped.** (Note: this contradicts a claim in
some docs that `.claude.json` stays at `~/.claude.json`; on 2.1.201 it moves. Tested.)

Also relocated when present: `settings.json`, `history.jsonl`, `skills/`, `commands/`,
`plugins/`, `todos/`, `shell-snapshots/`, `codev-status/` is **not** (see §6.F).

### 3.2 Fresh config dir = separate account (confirmed)

`CLAUDE_CONFIG_DIR=/tmp/x claude -p "OK"` on a **fresh** dir returned:

```
Not logged in · Please run /login
```

even though the default account (`~/.claude`) is logged in. So Claude Code does **not**
fall back to the default account's credentials for a different config dir → the
credential lookup is effectively **keyed by config dir**. This is what makes
config-dir-per-account a *true* account switch on macOS, not just a settings swap.

Useful side-finding: **`claude auth status` prints clean JSON** and is config-dir
aware:

```json
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
  "email": "…", "orgId": "…", "orgName": "…", "subscriptionType": "max" }
```

CodeV can label accounts either by reading `$DIR/.claude.json` → `oauthAccount.emailAddress`
(fast, pure file read, no subprocess, no model call) or by running
`CLAUDE_CONFIG_DIR=$DIR claude auth status` (authoritative, handles token expiry).

`claude auth` subcommands exist and are the official surface: `login`, `logout`,
`status`. There is **no** `--profile` / `--config-dir` flag — the env var is the only
switch.

### 3.3 Confirmed: credentials are isolated per config dir ✅

The fresh-dir test proved a new dir *starts* logged-out; a second test proved that
**logging into account 2 does not disturb account 1** (older Claude Code kept a single
global keychain item `Claude Code-credentials`, which is why tools like *claudini* swap
keychain items — 2.1.201 does not).

**Result (verified 2026-07, CC 2.1.201):** with the default account
(a personal Max account) logged in at `~/.claude`, logging a *different* account
(a work Team account) into `~/.claude-ma-test` produced two live sessions
**simultaneously** (each `claude auth status` reported its own account); logging out the
test dir left the default account **still logged in**. So `CLAUDE_CONFIG_DIR` alone is
the whole mechanism — no `CLAUDE_CODE_OAUTH_TOKEN` needed — and accounts can run
concurrently in separate terminals. The test used:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-ma-test" claude auth login   # interactive; log in
claude auth status                                            # expect: still logged in (default untouched)
CLAUDE_CONFIG_DIR="$HOME/.claude-ma-test" claude auth logout
claude auth status                                            # KEY: still logged in ⇒ isolated ✅ ; logged out ⇒ shared keychain ❌
rm -rf "$HOME/.claude-ma-test"
```

- **Isolated (confirmed):** `CLAUDE_CONFIG_DIR` alone is the whole mechanism.
- **Fallback (not needed):** had it been a shared keychain, we would add a per-account
  `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) to each launch — kept here only
  as a note; the design does not use it.

---

### 3.4 The default account is special — leave `CLAUDE_CONFIG_DIR` *unset* ⚠️

The default account (unset `CLAUDE_CONFIG_DIR`) keeps its `.claude.json` at
**`~/.claude.json` (HOME level)**, while its dir contents (`history.jsonl`, `projects/`,
`sessions/`, `settings.json`) live in `~/.claude/`. A *custom* config dir instead keeps
**everything inside the dir**, including `<dir>/.claude.json`.

Consequence (verified — it cost us a test): `CLAUDE_CONFIG_DIR="$HOME/.claude"` does
**NOT** reproduce the default account. Claude then looks for `~/.claude/.claude.json`
(absent), reports "config not found," appears logged out, and drops a stray empty
`~/.claude/.claude.json`. Therefore:

- **Default account ⇒ NO `CLAUDE_CONFIG_DIR`.** Identity read from `~/.claude.json`.
- **Extra account ⇒ `CLAUDE_CONFIG_DIR=~/.claude-<label>`.** Identity at `<dir>/.claude.json`.
- Session data (`history.jsonl` / `projects` / `sessions`) is under `<dir>/` for BOTH
  (default dir = `~/.claude`), so CodeV scans by `dir` uniformly; only the identity-file
  path and the launch prefix differ by whether the account is the default.

## 4. Architecture: config-dir-per-account

```
~/.claude                    → account "default"  (existing, untouched)
~/.claude-personal           → account "personal"
~/.claude-work               → account "work"
   each: .claude.json (identity), settings.json, projects/, sessions/, history.jsonl,
         skills/, commands/, plugins/   (credentials via per-dir-keyed keychain)

Single source of truth (registry), read by both the shell layer and CodeV:
~/.config/codev/accounts.json
   { "accounts": [
       { "label": "default",  "dir": "~/.claude",          "email": "…", "sub": "max" },
       { "label": "personal", "dir": "~/.claude-personal",  "email": "…", "sub": "pro" }
     ],
     "projectMap": { "/Users/me/git/work-repo": "work" }   // §6.H, optional
   }
   // Simplified sketch — each entry also records `configDirEnv`, `identityFile`,
   // and `isDefault`; see §11 for the full copy-paste schema.
```

Launching account X = `CLAUDE_CONFIG_DIR=<X.dir> claude …` **for extra accounts**; the
**default account launches with NO prefix** (see §3.4 — never `CLAUDE_CONFIG_DIR=~/.claude`).
Identity file per account: default → `~/.claude.json` (HOME); extra → `<dir>/.claude.json`.
The registry records `configDirEnv` (null for default, the dir for extras) and
`identityFile`, so CodeV derives the launch prefix + identity without special-casing.

---

## 5. Cross-account file reuse (answering the reuse question)

| File / data | Scope | Shared across accounts? | How |
|---|---|---|---|
| Project `CLAUDE.md` (`<repo>/CLAUDE.md`) | Project folder | **Yes, automatically** | Lives in the repo; account-independent |
| Project `.claude/` (settings, commands, local memory) | Project folder | **Yes, automatically** | Same — in the repo |
| Global `~/.claude/CLAUDE.md` (user instructions) | Config dir | No by default → **opt-in symlink** | `ln -s ~/.claude/CLAUDE.md ~/.claude-x/CLAUDE.md` |
| Global `skills/`, `commands/`, `plugins/` | Config dir | No by default → **opt-in symlink** | symlink the dir |
| `settings.json` (model, hooks, permissions, env) | Config dir | Optional symlink (careful) | Symlink ⇒ hooks/permissions shared; or install hook per-dir (§6.F) |
| Single `settings.json` keys (`statusLine`, `model`, `effortLevel`, `theme`) | Config dir | **Yes — per-key copy** | Copy the key into the other account's settings.json (statusLine done for `work` 2026-07; HOME-based script serves all accounts) |
| `.claude.json` (identity + per-project trust) | Config dir | **No — never symlink** | Holds `oauthAccount`; must stay per-account |
| Auto-memory (`projects/<path>/memory/`, `MEMORY.md`) | Config dir | No by default | Per-account, or advanced: symlink individual `memory/` subdirs |
| Session data (`history.jsonl`, `projects/*.jsonl`, `sessions/`) | Config dir | **No — aggregated for display, not shared** | CodeV scans all dirs (§6.E) |

**Verified 2026-07-09:** Claude Code follows symlinks for both `skills/<name>` entries
and the global `CLAUDE.md` — a work-account `-p` probe listed the symlinked
`fireflies-repos` skill and had the symlinked CLAUDE.md's rules in context. So the
symlink mechanism above is confirmed viable; the remaining Batch 3 work is UX
(share checkboxes / `codev account share`), not feasibility.

**Collision & ownership policy (the actual Batch 3 UX work):** sharing must never
silently overwrite. If the target already exists in the other account: back it up
(`*.codev-bak`, the convention session-status-hooks already uses) or skip and report —
never `ln -sf`. Link per **entry** (`skills/<name>`), not whole dirs, so an account
keeps private skills alongside shared ones. (Note: it's *hard* links that can't target
directories — a **symlink to a dir works fine** and new files *inside* a linked skill
are picked up automatically; only a brand-new skill needs a new per-entry link. If an
account needs no private skills, a whole-`skills/`-dir symlink is the zero-maintenance
alternative — current and future skills auto-shared, at the cost that anything either
account adds becomes shared.) A symlink is ONE file both ways — edits
from either account hit the same inode; offer **link (stay in sync) / copy (fork) /
skip** per item. `plugins/` is untested: the payload dir may symlink, but enablement
lives in each account's `settings.json` (`enabledPlugins`) and plugins may keep their
own state — needs its own experiment. Session data stays unshared by design (it's
live-written and identity-bound, and §6.E aggregation already provides the union view);
cross-account "resume" (§6.G/2c) should **copy-fork** a transcript into the target
account, never link it.

Your guess was right: **per-project files are account-independent; only the global
files need help.** "Reusing" session data across accounts isn't actually desirable —
each account owns its sessions; what you want is CodeV *showing* them all, which §6.E
does.

CodeV's "Add account" flow (§6.D) offers per-item checkboxes: *Share global CLAUDE.md
/ skills / commands / plugins / settings with the default account?* → creates the
symlinks. `.claude.json` is never offered.

**Per-key copy instead of whole-file symlink (`settings.json`):** individual settings
keys can be shared by copying just that key into the other account's `settings.json` —
e.g. `statusLine` (done manually for `work`, 2026-07: same
`bash ~/.claude/statusline-command.sh` command works for every account since the script
path is HOME-based and Claude Code feeds it the session's own context via stdin).
Candidates for a future `codev account sync-settings <keys>`: `statusLine`, `model`,
`effortLevel`, `theme`. Hooks stay per-dir (§6.F installs them per account).

---

## 6. Sub-feature designs (approaches, pros/cons, recommendation)

### 6.A CLI: invoking a specific account

| Approach | How | Pros | Cons |
|---|---|---|---|
| **(a) Per-account functions** *(rec, baseline)* | `claude-personal(){ CLAUDE_CONFIG_DIR=~/.claude-personal claude "$@"; }` generated per account | Dead simple; `"$@"` passes **all** native flags perfectly (`-r`, `mcp`, completion unaffected); zero shadowing risk | One function per account; naming |
| **(b) `claude <account>` dispatcher** *(rec, add-on)* | Wrap `claude` so `claude personal -r` → route to personal; first arg matched against account labels, everything else passthrough (built on the existing `claude2` passthrough pattern) | Matches your "claude personal" mental model; one entry point | Shadows the real `claude` — must carefully passthrough subcommands/flags; slightly more fragile |
| (c) Compiled dispatcher (Rust/Bun on PATH) | A `cv`/`claudex` binary resolves account → `execvp` real claude | Robust; could also do §6.H auto-switch and read the registry | A binary to build/ship/update; PATH-ordering vs real `claude`; overkill for v1 |

**Recommendation:** ship **(a)** as the robust baseline; add **(b)** for ergonomics
(guard the shadow with a strict label match + full passthrough, exactly like the
user's existing `claude2`). Defer **(c)** unless §6.H auto-switch grows enough logic to
justify a binary. `--account2`-style flags are *not* recommended as the primary form
(a flag on a shadowed `claude` is more error-prone than a first-arg label or a named
function).

**Query helpers (the reverse — "which account am I on?"):** `claude-whoami` prints the
account that this shell's bare `claude` resolves to (respects `CLAUDE_CONFIG_DIR`;
unset ⇒ the default), with our label + a live `claude auth status`; `claude-accounts`
lists all. These ship in Batch 1 (they make the imminent smoke-test legible and answer
"what does the default map to"). Do **not** expose them as `claude whoami` — a bare
first-arg would be swallowed by the dispatcher / passed to real `claude`; use distinct
function names. Batch 2 folds them into `codev account current | list | default`.

**Implemented (Batch 2a):** the `codev account` CLI (`src/cli/codev-account.ts`, run
via `yarn account <cmd>`) now generates **both** `accounts.json` and `accounts.sh` from
one shared generator (`src/cli/account-manager.ts`) — no more hand-editing. Commands:
`list`, `add <label> [--dir D]`, `default <label>`, `remove <label>`, `regenerate`,
`show` (dry-run), `install`/`uninstall` (the marker-guarded `~/.zshrc` source block).
A Vitest generator suite + CI guard the shell output. A real `codev` binary on PATH and
the Settings UI are Batch 2b.

**Caveat — the dispatcher leaks into Claude Code sessions (shell snapshots):** Claude
Code captures the interactive shell's functions into a snapshot
(`~/.claude/shell-snapshots/…`) and sources it for Bash-tool / `!` commands. So *inside
any session*, bare `claude …` resolves to the dispatcher function and routes to the
**global default** — NOT the session's own account. Consequences: (a) `!claude auth
status` is not a valid probe of the session's account (it reports the default; use
`command claude auth status` or `echo $CLAUDE_CONFIG_DIR` instead); (b) nested/scripted
`claude` invocations from within a session go to the default account — use
`command claude` or an explicit `claude <label>` when the account matters.

### 6.B Account registry (source of truth)

- **`~/.config/codev/accounts.json`** (plain JSON), owned/written by CodeV, readable
  by the shell layer via `jq`. The generated shell functions are **static** (one per
  account) so they need no runtime lookup — regenerated only when accounts change.
- Alternative: keep it inside CodeV's `electron-settings`
  (`~/Library/Application Support/CodeV/settings.json`, new `accounts` key). The shell
  side can still read it with `jq`, but a dedicated file is cleaner and shell-friendly.
- **Recommendation:** dedicated `~/.config/codev/accounts.json`; mirror the label/email
  into CodeV settings only as a cache.

### 6.C CLI shell integration install (requirement 8, hook-style)

| Approach | Pros | Cons |
|---|---|---|
| (a) Auto-append a managed block to `~/.zshrc` (`# >>> codev accounts >>>` markers) | Fully automatic | Edits the user's rc; must be idempotent + cleanly removable; shell detection (zsh/bash/fish) |
| **(b) Write `~/.config/codev/accounts.sh`; user adds one `source` line** *(rec)* | Minimal footprint; regenerating accounts never re-touches rc; easy to audit | One manual step (or a guided one-click for the single source line) |
| (c) Settings shows the snippet for manual copy | Zero filesystem risk | Least convenient |

**Recommendation:** **(b)** + a one-click "Install shell integration" button (Settings)
that appends a single marker-guarded `source ~/.config/codev/accounts.sh` to the
detected rc, with **(c)** as manual fallback. Mirrors the existing Session-Status hook
toggle (write file with `0o755`, register a reference, idempotent, removable). Detect
shell; warn if not zsh/bash.

**Supported environments (current implementation, Batch 2a/2b):** the Install button /
`codev account install` writes only `~/.zshrc` → **zsh** is the supported shell (the
macOS default). The generated `accounts.sh` is bash-compatible — bash users can
`source` it manually from `.bashrc` — while **fish is unsupported** (different function
syntax; the `env`-prefixed commands CodeV injects at resume do parse in fish ≥3.1, but
the dispatcher/whoami functions won't load there). Account-aware resume/launch covers
every terminal CodeV supports (iTerm2, Terminal.app, Ghostty, cmux, embedded Term tab);
VS Code sessions can't be account-switched (grimmerk/codev#121). rc-file shell
detection remains future work.

### 6.D Add-account (login) bootstrap

OAuth is interactive (browser) — CodeV cannot automate it, only orchestrate it.

Flow: **Settings → Accounts → "Add account"** → prompt for a label →
`mkdir ~/.claude-<label>` → spawn the configured terminal running
`CLAUDE_CONFIG_DIR=~/.claude-<label> claude auth login` → user completes OAuth →
CodeV polls `~/.claude-<label>/.claude.json` for `oauthAccount` → saves to registry →
offer the reuse-symlink checkboxes (§5) → regenerate `accounts.sh`.

Optional headless path for power users: `claude setup-token` → store
`CLAUDE_CODE_OAUTH_TOKEN` per account (also the §3.3 fallback).

### 6.E CodeV: multi-dir session aggregation + account-aware resume  ← core CodeV change

Today CodeV reads a **hardcoded** `~/.claude` (history.jsonl at
`claude-session-utility.ts:50-52`; `CLAUDE_DIR` at `session-status-hooks.ts:12-16`;
`sessions/` scan at `:875-947`). To support accounts:

1. **Aggregate:** iterate registered config dirs; for each, read its
   `history.jsonl` / `projects/` / `sessions/`; tag every `ClaudeSession` with
   `{ accountLabel, configDir }`. Merge into one sorted list.
2. **Badge:** show a small account badge on each session row (same visual language as
   the existing `ITERM2` badge). Hide badges entirely when only the default account
   exists (zero UI change for single-account users).
3. **Account-aware launch/resume — the injection:** at the command choke points, when
   the session's account ≠ default, prefix `CLAUDE_CONFIG_DIR="<dir>" ` onto the
   command:
   - iTerm2 / Terminal.app: into `fullCommand` →
     `cd "<path>" && CLAUDE_CONFIG_DIR="<dir>" claude --resume <id>`
     (built in `runCommandInTerminal`, `claude-session-utility.ts:1157-1310`; resume
     else-branches at `:1531/:1808`).
   - Ghostty / cmux: into `claudeCmd` (cwd is passed separately) — `:1746/:1827`.
   - CodeV embedded term: prepend to the `cmd` string (`main.ts:1124`) or set the pty
     `env` (`main.ts:1850`).
   - New session: `launchNewClaudeSession` (`:1347`).
   - **VS Code: not possible** (launch is a URI handler, no shell/env — `:1321-1339`).
     VS Code sessions' account is whatever the VS Code extension is signed into;
     out of scope for CodeV env injection. Note in UI.
4. **Result:** requirement 4.1 is automatic — a session's account is the dir it was
   read from, so resuming re-injects exactly that account.

Use absolute paths (not `~`) in the injected string to avoid tilde-expansion issues
inside AppleScript.

### 6.F CodeV: status hooks across accounts

The hook **script** already writes to a fixed `~/.claude/codev-status/<id>.json`
(absolute, not `$CLAUDE_CONFIG_DIR`), so **one watch dir still sees every account** —
good. But the hook must be **registered** in each account's `settings.json`. Options:

- **(a)** `installHooks()` (`session-status-hooks.ts:73-116`) loops over all registered
  config dirs and merges the hook entry into each `settings.json`. *(rec — explicit,
  survives un-symlinked settings.)*
- **(b)** Symlink account settings.json to the default (§5) so the hook is inherited.
  Simpler but couples all settings.

**Recommendation:** (a). Keep the fixed status dir; register per dir.

### 6.G CodeV: optional account picker (requirement 4.2, nice-to-have)

- Resume normally uses the session's own account (§6.E). For the rare "resume this
  transcript under a different account" case, add a modifier (e.g. long-press / a
  small dropdown in an expanded row) listing accounts. Note that resuming a transcript
  under a *different* account may not find it (session history is per-dir), so this is
  really "start a new session in this cwd under account Y" — align the UX wording.
- New-session launch (Projects `⌘+Enter`): allow an account override, e.g. extend the
  planned `>` command mode (`> claude @work myrepo`) or an account segment in the
  expanded project row.
- **Coupled with Batch 3 (§5).** Truly resuming/sharing a *transcript* across accounts
  only works if the session data (and global config: CLAUDE.md/skills) is shareable
  across config dirs — i.e. it depends on Batch 3's cross-account reuse. So design 2c
  and Batch 3 **together**: without sharing, 2c is limited to "new session in this cwd
  under account Y"; with sharing, genuine cross-account resume becomes possible.

### 6.H pyenv-style auto-switch by folder (requirement 6, nice-to-have, "reverse" priority)

**Caution first:** never `export CLAUDE_CONFIG_DIR` globally — it would hijack *every*
claude (including CodeV-launched ones). Auto-switch must be per-invocation/per-shell.

| Approach | How | Pros | Cons |
|---|---|---|---|
| **(a) `.claude-account` file in repo + zsh `chpwd` hook** *(rec)* | `chpwd` reads the file, sets `CLAUDE_CONFIG_DIR` for that shell | pyenv-like; per-repo; committable or git-ignored | Needs a `chpwd` hook; zsh-specific |
| (b) `direnv` `.envrc` with `export CLAUDE_CONFIG_DIR=…` | Reuse a battle-tested tool | Robust, scoped | Extra dependency; per-repo `.envrc` |
| (c) Registry `projectMap` read by the `claude` wrapper | Wrapper matches cwd prefix → account | Central; no per-repo file; shared with CodeV | Only works through the wrapper; wrapper complexity |
| (d) CodeV `projectMap` (UI) | CodeV launches use it | Great for CodeV-initiated launches | Doesn't cover raw terminal `cd && claude` |

**Recommendation:** defer to a later phase. When built, do **(a)** for the terminal
and **(d)** for CodeV, backed by the same `projectMap` in the registry so both agree.

---

## 7. Phasing (agreed)

- **Batch 1 — ✅ Done** (branch `feat/multi-account-support`) **(satisfies 1, 2, 4.1, 5-min, 7, 8):**
  - *P0 CLI:* registry (`~/.config/codev/accounts.json`); per-account functions +
    `claude <account>` dispatcher + `claude-whoami` / `claude-accounts` (§6.A);
    shell integration via a sourced file + one rc line (§6.C b); semi-manual add-account
    (first `claude-<label>` run walks through login). §3.3 confirmed.
  - *P1 CodeV:* multi-dir session aggregation + **account badge** (non-default accounts
    only) + account-aware resume/launch (§6.E); active-dot + title/branch enrichment per
    account; same-cwd cross-ref per account; hooks registered per config dir (§6.F).
  - *Deferred:* VS Code (`claude-vscode`) sessions can't be account-switched (URI-handler
    launch) — tracked in grimmerk/codev#121. (Setup is no longer hand-made — see
    Batch 2a below.)
- **Batch 2 — in progress (order 2a→2e):**
  - *2a — ✅ Done* (branch `feat/codev-account-cli`): `codev account` CLI generates the
    registry + `accounts.sh` from one shared generator (§6.A/B); Vitest + CI added.
  - *2b (UI ✅, branch `feat/accounts-settings-ui`):* Accounts tab in Settings —
    list/add/remove + set-default + shell-integration toggle (§6.D), as IPC wrappers
    over the shared manager (one generator with the CLI). Rename deferred (labels name
    dirs; remove+add covers it). Remaining 2b item: a real `codev` binary on PATH.
  - *2c:* account picker / per-launch override (§6.G, 4.2).
  - *2d:* pyenv-style folder auto-switch + terminal-side resume-to-right-account (§6.H).
  - *2e:* configurable global-default (bare `claude` → chosen account) — last, since it
    also needs the CLI/UI to manage.
- **Batch 3 — later:** cross-account symlink reuse of global files
  (CLAUDE.md / skills / commands / plugins / settings, §5).

---

## 8. Key code touch-points (from the code map)

| Area | File:line | Change |
|---|---|---|
| Session list path | `claude-session-utility.ts:50-52` | Loop over config dirs |
| Active-session scan | `claude-session-utility.ts:875-947` | Per dir; tag account |
| Enrichment/project encoding | `:1096-1129, :1555-1632` | Per dir |
| Launch new | `:1316-1348` (`:1347`) | Inject `CLAUDE_CONFIG_DIR` prefix |
| Resume choke points | `runCommandInTerminal :1157-1310`; else-branches `:1531,:1746,:1808,:1827/1953` | Inject prefix |
| CodeV term | `main.ts:1124` / pty env `main.ts:1850` | Prefix or env |
| Settings storage | `electron-settings` (`main.ts:12`) + new IPC pair | `accounts` cache |
| Settings UI | `popup.tsx` (Sessions/General) | Accounts section |
| Hooks install | `session-status-hooks.ts:73-116` | Loop over config dirs |
| CLI helper (new) | modeled on `session-status-hooks.ts` `installHooks()` | Write `accounts.sh`, source line |

No CLI/PATH helper exists today; the hook installer is the reference pattern.

---

## 9. Open decisions (for review)

1. **Start scope:** Phase 0 only, Phase 0+1, or full?
2. **CLI form:** per-account functions only, or also the `claude <account>` dispatcher?
3. **Shell install invasiveness:** auto-append to `~/.zshrc`, or write file + one
   sourced line, or manual snippet only?
4. **Account labels:** free-form (`personal`, `work`) — confirm naming + the config-dir
   pattern `~/.claude-<label>`.
5. **§3.3 credential test:** run now (recommended) or proceed on current evidence?

---

## 10. Risks & gotchas

- **Global `export CLAUDE_CONFIG_DIR` hijacks everything** — only ever set it
  per-invocation (§6.H caution).
- **§3.3 unconfirmed** — if login-2 clobbers login-1, fall back to per-account
  `CLAUDE_CODE_OAUTH_TOKEN` (rest of design unchanged).
- **VS Code sessions** can't be account-switched from CodeV (URI-handler launch).
- **rc-file editing** must be idempotent, marker-guarded, removable; detect shell.
- **`.claude.json` must never be symlinked** across accounts (identity + trust).
- **Hook registration per dir** or symlinked settings — don't forget account-2's
  `settings.json`, or its sessions get no status dots.
- **`~/.claude.json` at the old path:** some third-party tools still read
  `~/.claude.json` directly; with per-dir `.claude.json`, only the default account's is
  at the legacy path. Low impact for CodeV (we read per dir), but worth noting.

---

## 11. How to use it now (Batch 1, manual setup)

Batch 1 ships the *engine*; account setup is manual until the Batch 2 UI/CLI.

- **Registry** — `~/.config/codev/accounts.json`: one entry per account with
  `label`, `dir`, `configDirEnv` (null for the default), `identityFile`, `isDefault`.
  The default account is `~/.claude` (its `.claude.json` sits at `~/.claude.json`,
  HOME level — never set `CLAUDE_CONFIG_DIR=~/.claude`, see §3.4). Extra accounts
  live in `~/.claude-<label>`.
- **Shell** — `~/.config/codev/accounts.sh` (sourced from `~/.zshrc`) defines
  `claude` (dispatcher), `claude-<label>`, `claude-whoami`, `claude-accounts`.
  Add an account: create its registry entry, then run `claude-<label>` once and
  complete the browser login (populates `~/.claude-<label>`).
- **CodeV** — with the registry present and ≥2 accounts logged in, the Sessions
  tab lists sessions from every account (recency-merged), badges non-default
  accounts, resumes each under its own account, shows per-account active dots +
  titles, and registers status hooks in each account's `settings.json`.
- **No registry / one account** — CodeV behaves exactly as before; the feature is
  invisible and opt-in (graceful fallback to a single default account).

### Concrete example — personal (default) + work

`~/.config/codev/accounts.json`:

```json
{
  "version": 1,
  "defaultAccount": "personal",
  "accounts": [
    { "label": "personal", "dir": "/Users/you/.claude",       "identityFile": "/Users/you/.claude.json",            "configDirEnv": null,                        "isDefault": true },
    { "label": "work",     "dir": "/Users/you/.claude-work",  "identityFile": "/Users/you/.claude-work/.claude.json", "configDirEnv": "/Users/you/.claude-work", "isDefault": false }
  ]
}
```

`~/.config/codev/accounts.sh` (then add `[ -f ~/.config/codev/accounts.sh ] && source ~/.config/codev/accounts.sh` to `~/.zshrc`):

```bash
claude-personal() { command claude "$@"; }                                   # default: NO CLAUDE_CONFIG_DIR
claude-work()     { CLAUDE_CONFIG_DIR="$HOME/.claude-work" command claude "$@"; }
claude() { case "$1" in                                                        # `claude work …` / bare `claude`
  personal) shift; command claude "$@" ;;
  work)     shift; CLAUDE_CONFIG_DIR="$HOME/.claude-work" command claude "$@" ;;
  *)               command claude "$@" ;;
esac }
```

Then run `claude-work` once and complete the browser login (populates
`~/.claude-work`). Restart CodeV so it registers status hooks in the work
account's `settings.json`. (`claude-whoami` / `claude-accounts` helpers can be
added the same way — see the generated file for the full set.)
