# Session-Finding Improvement Plan (search / browse / pins / preview)

> **Status: Batch 1 shipped; Batch 2/3 not started** (finalized 2026-07-12 via a brainstorm session).
> PR-1 "search & noise" (§4.1–§4.3: B2 highlight + A1/B1 full search + C1 folding) = **PR #132 (merged)**;
> PR-2 "pins" (§4.4 D1, incl. C1's manual hide) = **PR #136 (merged)**, plus a browse-modes
> follow-up (§4.4: recency ordering · ungroup · pinned-only scope).
> Row readability (§4.5) = **PR #139 (merged)**.
> **Live review 2026-08-20** re-measured the remaining pain and produced a follow-up queue —
> PR-reference canonicalization (§4.6), a frecency list (§6) — recorded below with the
> measurements that justify each.
> **2026-09-05**: a live experiment on `/branch` (§4.7, issue #142) falsified two claims in
> this document — §4.4's "forking is an edge case" and §6's "C3 chain collapse is defunct".
> Both are corrected in place.
> **Order, priority and "is this done" live in tracking issue #144, not in this file** — a
> committed document cannot be corrected without a PR, so status written here goes stale
> and has done so before. This file holds the reasoning: why A precedes B, how a mechanism
> works, why an option was rejected.
> This document is the cross-session / cross-model implementation reference: every "decision"
> below was confirmed point-by-point with the user — do not re-open decided options;
> implementation details (§4–§6) may adapt to what you find.
> Related: `docs/pin-feature-handoff.md` (pin groundwork; its §4 [FACT]s remain valid),
> issue #106 (session-list perf), #66 (detail-view idea), #105 (real-time preview), #131 (search cap).
> A Traditional Chinese working copy may exist locally as `session-finding-plan-zh-tw.md` (untracked).

## 1. Problem definition

The user's pain points when trying to find a session (paraphrased):

1. Search only covered 1st user message / final AI message / final user message / branch /
   custom title / AI title / PR link — no full-text search, so hit rate was low. The user
   compensates by hand-titling every non-throwaway session.
2. When a match sits in a UI-truncated region, the highlight is invisible (a row matches but
   you can't see *why*).
3. Highlight colors had too little contrast (translucent gray over orange/green text ≈ invisible).
4. Compared with Notion: **(a) verifying a candidate is nearly free there** (click → content
   appears in the right pane → wrong? next), **(b) less noise**. In CodeV, verifying a candidate
   = open terminal → resume → wait; and the list is polluted by throwaway one-shot sessions.

Framing — finding a session has three complementary paths plus one multiplier:

- **A. You remember a keyword** → search coverage (data layer)
- **B. Search results are trustworthy & readable** → match presentation
- **C. You recognize it by sight** → browsing signal/noise
- **D. The important ones are always at hand** → pins (no search needed)
- **Multiplier: fast verify (preview)** — raises the value of A–D across the board

## 2. Measured data (2026-07-12, the user's machine)

| Item | Value | Implication |
|---|---|---|
| Transcripts | personal 868MB / 549 files + work 26MB / 39 files ≈ **894MB / 588 files** | SQLite FTS5 (or even on-demand `rg`) is plenty — no Rust / external engine needed |
| `history.jsonl` | 15,324 prompt lines, **414 unique sessions**, 6.7MB (work account: 142 lines / 50KB) | Each line = one complete user prompt (`display` field, longest measured 9,224 chars, **not truncated**) |
| Transcript retention | oldest 2026-04-09 (~3 months) | Claude Code's `cleanupPeriodDays` prunes old transcripts; **once the FTS index exists it doubles as a permanent text archive** (expired sessions stay readable, not resumable) |
| Actual search scope (pre-PR-#132) | **Only the ~100 loaded sessions**: search was the renderer's `filterSessionsLocally` client-side filter; main-side `searchClaudeSessions` (500-pool) was wired but never called — dead code (issue #131) | With 414 sessions, **~314 were completely unfindable** → A1 went from nice-to-have to mandatory; the cache already holds the full set, so widening costs nothing |

Open-source survey conclusion: **nobody uses exotic tech**. claude-code-history-viewer
(Tauri+Rust) does client-side full scans in a Web Worker — its real value is the conversation
*reader*; c9watch also brute-scans JSONL; raine/claude-history (Rust TUI) has field-aware
lexical + local-embedding hybrid search, more than we need. TencentDB-Agent-Memory is fully
local (SQLite + sqlite-vec) but solves *agent long-term memory*, not *humans finding sessions* — skipped.

## 3. Decided (confirmed point-by-point with the user — do not re-open)

| # | Decision | Rationale |
|---|---|---|
| 1 | **C2 compact/title-only mode: dropped** | The user already titles non-throwaway sessions; search targets are mostly those |
| 2 | **A2' transitional rg version: dropped — build the full A2 FTS5 directly** | User's call: if we build it, build the real one |
| 3 | **A2+ file-path reverse lookup: demoted to a small bonus**, only if trivial while doing A2 | |
| 4 | **A3 semantic/vector, E ask-AI, Tencent memory: parked** | Re-evaluate remaining pain after FTS + preview ship |
| 5 | **C4 preview promoted** (user asked: with C4, is B1 still needed? → see §5.1; B1 as a standalone item is dissolved into A1 and A2) | |
| 6 | **B2 highlight colors: do immediately** (pure CSS) | |
| 7 | **C1 junk folding: do it**, using "no custom title + very few msgs" as the signal | Matches Notion's low-noise advantage |
| 8 | **D1 pin UI: do it** (spec in §4.4); **D3 in-session `/pin`: Batch 3**, as a custom slash command, accepting one LLM turn | User dislikes the `!` path's lack of autocompletion; slash commands get Claude Code's built-in autocomplete, and the `!` path's "no LLM turn" selling point was empirically disproven (§7) |
| 9 | AI batch summaries/grouping: no; instead **A4-lite**: a "Generate title" button in the preview (haiku, writes a custom title — fits the user's manual-titling habit) | User is skeptical of AI-title quality; heuristics first |

**Rejected-options record (kept for reference, with re-open conditions):**
- **C2 compact/title-only mode**: idea = Notion cmd+P-style one-line title rows for titled
  sessions, expanded rows only for untitled — denser visual scanning. Dropped because search
  targets are mostly titled sessions, and C1 (de-noise) + C4 (fast verify) cover the scanning
  need. Re-open if browsing still feels hard after Batches 1/2.
- **A2' rg deep-search stopgap**: idea = press Enter → shell out to ripgrep over the 894MB of
  transcripts (2–3 days to ship, zero index maintenance) as demand validation before FTS.
  Dropped: the user chose to go straight to full FTS5. Residual value: one-shot `rg` scans
  remain a good **index-debugging tool** (checking the incremental FTS index for gaps) during
  A2 development — not a product feature.
- **A3 semantic/vector, E ask-AI, Tencent memory**: parked, not killed — re-open if
  "I remember the concept but not the keyword" stays a common failure mode after FTS + preview.

## 4. Batch 1 — quick wins (each S effort)

### 4.1 B2: highlight contrast fix (hours)

Was: translucent gray boxes per call site. Now: one shared amber background + dark text style
(`SEARCH_HIGHLIGHT_STYLE`), readable over orange (1st msg) / green (title) / white text.
Pure CSS in `switcher-ui.tsx`.

### 4.2 A1+B1 merged: all-sessions × all-user-prompts search + match snippet (fixes issue #131)

- **Pre-PR state (issue #131)**: search = renderer `filterSessionsLocally`
  (`switcher-ui.tsx`) filtering only the ~100 loaded sessions; main-side
  `searchClaudeSessions` (`claude-session-utility.ts`, 500-pool, 50-result cap) was fully
  wired (IPC handler + preload) but never called — **dead code**. ⇒ ~314/414 sessions unfindable.
- **Why merge with the snippet work**: full-prompt matches mostly land in *middle* prompts —
  which the UI never shows → without a snippet the match is invisible. They are one feature.
- Data: `history.jsonl` has one line per prompt; the accumulator used to keep only first/last
  and discard the middle. Change: while scanning, also build a **main-process module-level**
  `Map<sessionId, string[]>` of all prompts (~+7MB RAM).
- **Design: dual-path union** (because enrichment fields exist only renderer-side, and only
  for the loaded ~100):
  1. Main-side search IPC (rewrites the dead `searchClaudeSessions`): searches **all**
     sessions' project name + **all prompts**; returns matched sessions + `matchedSnippet`
     (~40 chars around the match) + field/index attribution.
  2. Renderer keeps `filterSessionsLocally` (covers branch / PR / AI response / custom title
     / terminal badge).
  3. Union both; main-side hits outside the loaded 100 are **appended to the list + lazily
     enriched**.
- **Important: never ship all prompts inside the IPC-returned session objects** (7MB per call
  would wreck IPC).
- Renderer: when the match isn't in a visible field, one row line switches to the snippet.
- Perf: scanning 6.7MB of in-memory strings ≈ 5–20ms/query, imperceptible behind a debounce;
  **does not touch the list-refresh path** (that cost is issue #106's IPC/process-scan/
  enrichment — orthogonal).

### 4.3 C1: junk-session folding

- Criteria (ALL must hold to fold): `messageCount ≤ 2` **and** no custom title **and** no PR
  link **and** not active.
- UI: collapse into a gray "· N minor sessions" row (expandable); plus a right-click
  "Hide session" for manual hiding (stored in §4.4's file, `hidden` list — ships with PR-2).
- Conservative by design: over-showing (expand reveals everything) beats over-hiding.

### 4.4 D1: Pin ★ + Pinned section

Groundwork in `docs/pin-feature-handoff.md` (its §5 [REC] is the base; deviations below are
multi-account-era updates).

**UI spec — as shipped** (PR #136 + the browse-modes follow-up; supersedes the original
proposal, which is kept below as the rejected-options record):
- Hovering a session row reveals a 📌 button on the right; click toggles; pinned rows show a
  persistent small ★.
- Top of the Sessions list: a "📌 Pinned (N)" header, rows fully reuse the existing session
  row (status dot / badges / PR / title all intact).
- **Zone-only, not dual placement**: pinning MOVES the session into the zone; the timeline
  keeps no duplicate. (User verdict during PR #136 live testing: the duplicate was more noise
  than signal. The original proposal — and Notion's favorites — kept both.)
- **Ordering: `lastTimestamp` DESC** (recency), `pinnedAt` DESC as the tie-break for
  unresolved placeholder rows. PR #136 shipped `pinnedAt` ASC so a new pin appended at the
  zone bottom rather than reshuffling rows under the cursor; that traded away the ordering
  every other list uses, and the hover-suppression in `suppressHoverSelection()` already
  absorbs the layout movement it was avoiding.
- **Two independent toggles on the header** (both persisted in localStorage):
  - label / `▾▸` = **group / ungroup**. Ungrouped, pins fall back to their chronological slot
    with the ★ — the "everything in time order" browsing mode. It replaces the earlier
    collapse semantics, where collapsing removed pins from the zone *and* the timeline at
    once, i.e. browsing could make a pinned session invisible.
  - `only` chip = **scope**: list and search are restricted to pinned sessions.
  - Both toggles live on one line because vertical space is the scarce resource in a
    menu-bar popup.
- While searching: the zone does not group; results are one unified list (matching pinned
  rows keep the ★). With `only` on, the search is scoped to pins.
- A pinned session is never folded into the minor-sessions group regardless of its stats
  (pinning is an explicit "keep this"); pins outside the loaded window are appended to the
  timeline when ungrouped, so no mode can drop them.
- Unpin: click 📌 again, or `⌘D` on the selected row.
- Named groups are v2 (the schema already keeps a `group?` field).

**Store (deviation from the handoff [REC], justified: multi-account era + hidden list too):**
- Single file `~/.config/codev/session-marks.json` (one per machine, cross-account;
  `~/.config/codev/` already hosts the accounts registry):
  ```json
  { "pins": { "<sessionId>": { "pinnedAt": "…", "cwd": "…", "accountLabel": "…", "group": null } },
    "hidden": ["<sessionId>", "…"] }
  ```
- `fs.watch` on that file, same pattern as the status files (`session-status-hooks.ts` is the template).

**sessionId stability (verified 2026-07-12 — simplified the design substantially):**
- [FACT] Claude Code 2.1.207: `--resume` / `--continue` **reuse the original sessionId and
  append to the same transcript file by default**; a new id is opt-in via `--fork-session`
  (help text: "When resuming, create a new session ID **instead of reusing the original**").
  Matches the user's daily observation (msgs count accumulating on one row across resumes).
- ⇒ **Keying pins by sessionId is enough**; normal resumes need no migration machinery.
- ⚠️ **This next line was wrong and is kept only to mark the correction.** It read:
  *"Edge cases (v1 ignores them; re-pin manually if hit): explicit `--fork-session`,
  cross-account copy-fork."* The premise — that forking is rare — is false: `/branch`
  produces a new sessionId on every use and accounts for 23.9% of transcripts. Pins
  therefore drift routinely, which was confirmed against the live marks file. See §4.7
  and issue #142; cross-account copy-fork remains issue #128.

### 4.5 Row readability: a matched row must show *why* it matched (2026-08-20 review)

The user's report — "a long title still filters correctly, but I see no highlight" — has three
independent causes, all confirmed in code, plus one finding that turned out to be **bigger than
the reported symptom**.

**Measured on the user's machine (2026-08-20), 125 unique custom titles:**

| Measurement | Value |
|---|---|
| Title length | median **44** chars, max **165** |
| Longer than the UI's 35-char hard slice | **64%** |
| Chain-style (`A -> B > C`, newest step at the END) | **38%** |
| **Titles sharing their first 35 chars with another title** | **48/125 = 38%**, in 13 groups |
| Largest such group | **8 sessions** all rendering as `fred-ff nextjs backend and mcp arch` |
| First prompts longer than the 50-char slice (`both` display mode) | **39%** (of 522 sessions) |
| Last prompts longer than the 40-char slice | **42%** |
| Titled sessions whose title never appears as a `/rename` prompt | **27/78 = 35%** |

⇒ The title column — the user's primary identification signal, since they hand-title every
non-throwaway session — **is visually ambiguous for 38% of sessions even without searching**.
Fixing the highlight is necessary; fixing identifiability is worth more.

**Causes:**

- **R1 — hard slice.** `customTitles[id].slice(0, 35)` is applied *before* `Highlighter`, while
  `filterSessionsLocally` matches the *full* title ⇒ a match past char 35 filters the row in and
  highlights nothing.
- **R2 — CSS clip.** Row line 1 is `nowrap + overflow:hidden + ellipsis` with all right-hand
  badges `flexShrink: 0`; the branch renders after the title and is the first casualty. (Branch
  is not hard-sliced — same visible effect, different mechanism.)
- **R3 — snippet suppression hole.** The `⌕` line is suppressed when the match is in prompt #0
  or the last prompt, on the grounds that the row already displays those — but it displays only
  their first 50/40 chars. A match past the slice is then suppressed *and* invisible.
- **R4 — the two search paths carry different fields.** Main-side deep search sees
  `projectName + project + all prompts` and is the only path that returns a snippet; the
  renderer filter sees the enrichment fields (title / branch / PR / AI reply) but returns only
  a boolean. A title-only match therefore produces no snippet at all — which matters for the
  35% of titled sessions with no `/rename` prompt to fall back on.

**Status: shipped** (v1.0.86). `truncateMiddle` and `windowAroundMatch` are pure
helpers in `session-search.ts`; the row applies them through one `fitToRow()`
so every capped line follows the same rule. The title budget went 35 → 60 and is
expected to need tuning against the real window. Issue #138's snippet-line
colour ships with it. R3 needed no separate fix: once the first/last lines
window to the match, suppressing the duplicate `⌕` line is correct again.

**Fixes (one PR):**

- **T1 — middle-ellipsis title** (`head … tail`) instead of a head-only slice, plus the full
  title on the `title=` attribute. Fixes the 38% ambiguity, and needs no search to pay off.
- **T2 — match-aware window**: when searching, if the first match falls outside the visible
  window, move the window to the match (reuse the pure `extractSnippet()` in
  `session-search.ts`). Apply to title / first / last / assistant lines. **This subsumes a fix
  for R3** — once the visible line scrolls to the match, the suppression is correct again.
- **T3 — branch**: same windowing, and consider moving the branch to line 2 so it stops
  competing with the title for line 1.

**Naming guidance given to the user** (their titles are a running log, and every list UI
truncates from the right): put the discriminator in the first ~20 chars, drop the leading
project name (the row already prints it), and prefer `<stem>-<n> <current focus>` over an
ever-growing `A > B > C` chain. After T1 the constraint relaxes to "head 15 + tail 15 must be
unique", so chaining becomes viable again if each appended step stays short.

### 4.6 PR-reference canonicalization: `#123` ⇄ the full URL (2026-08-20 review)

Searching a session's *own* PR works either way today, because `filterSessionsLocally` builds
the badge haystack as `PR #<n> <url>`. Searching **user prompts** does not: the haystack is the
raw prompt text, so the query has to use the same form the prompt happened to use.

**Measured**: 2,506 (session, PR-number) pairs mentioned across all prompts —

| Forms present in the prompts | Pairs | Consequence today |
|---|---|---|
| both `#N` and the URL | 486 (**19.4%**) | either query finds it |
| URL only | 960 (**38.3%**) | searching `#N` misses it |
| `#N` only | 1,060 (**42.3%**) | searching the URL misses it |

⇒ **80.6% of PR mentions are reachable by only one of the two forms.**

**Fix**: a pure term parser in `session-search.ts`, applied to *both* the main-side deep search
and the renderer filter (one comparison, two callers — not two implementations). A query word
recognized as a PR reference (`https://github.com/o/r/pull/N`, `#N`, `o/r#N`) matches if any
equivalent form appears in the target (`#N`, `/pull/N`, `/issues/N`, `o/r#N`). **Require a
delimiter — never match a bare number** (`#1598` must not hit `15980`).

Cost: a query with no PR reference takes exactly today's path (one `String.includes` per word);
a PR term costs at most 3 `includes` instead of 1, cheapest form first. Full-corpus search is
5–20ms behind a 180ms debounce, so this stays imperceptible — but measure and record the timing
in the PR.

Free follow-on: the same parser gives the §6 `B4` filters (`is:pinned`, `has:pr`, `pr:1598`,
`project:`, `branch:`, `after:`).

### 4.7 `/branch` creates generation chains (measured 2026-09-05)

Full evidence and task breakdown: **issue #142**. Recorded here because two claims in
this document were built on the opposite assumption (§4.4 and §6's C3 row, both now
corrected).

**What `/branch` does.** It copies the transcript to a **new sessionId** and lets the
**same process** keep writing to the new file — verified end to end: pid unchanged,
`sessions/<pid>.json` updated in place, parent transcript left intact and resumable.
Claude Code records the link itself on every copied line:

```json
"forkedFrom": { "sessionId": "<parent>", "messageUuid": "<branch point>" }
```

A root transcript has zero such lines, so a single extra grep pattern in the enrichment
scan yields an exact child → parent map. No heuristics.

**The part that breaks CodeV: the transcript is copied, `history.jsonl` is not.** The
child's pre-branch prompts exist only in the transcript, while the session list is built
from `history.jsonl`. Four consequences:

1. **Deep search cannot see them** — searching for anything said before the branch finds
   the *parent*, never the child.
2. **`messageCount` is wrong** — a child carrying a whole conversation renders as "1 msgs".
3. **Pins do not follow** — confirmed in the live `session-marks.json`.
4. **Ordering** — resuming a parent lifts it above the child that continues the work.

**The sharper problem is identity, not the chain.** `/branch` moves you *into* the new
session, so the new name lands on the work you are continuing — the wrong way round. The
workaround in daily use is a three-step rename swap, done because `/branch` carries
in-flight subagents into the child, so the unfinished task genuinely continues there and
the name follows the work. Names are therefore **deliberately reused across generations**;
three live sessions with byte-identical names were observed at once. That also breaks
iTerm2 switching, which matches on tab title — all three rows switch to the same terminal.

⇒ The missing abstraction is **stable task identity across sessionIds**. The rename dance
is a manual substitute for it, and pin drift, search pointing at ancestors, and
indistinguishable rows are all the same gap surfacing in different places. Design that
before building the individual fixes.

**Method note.** `~/cc-session-snap.sh` captures sessionId / pid registration / transcript
listing / `history.jsonl` tail; run it either side of an action and diff. It is what turned
"resume sometimes seems confused" into the numbers above, and it applies to any future
question about session identity (`/fork` is the open one — see #142's comment).

### 4.8 Saved session lists + the live view (issues #145, #94)

Status and open questions live in **#144**; the reasoning is here.

**The model is Session Buddy, not favourites.** Pins (§4.4) are "this matters long-term";
a saved list is "this is what I had open on Tuesday" — a named snapshot of the running
set, put down so the windows can be closed and picked up later. The two are different
things and both stay.

**Why the live view is a prerequisite, not a nicety.** "Save what is open" needs a correct
answer to "what is open", and `~/.claude/sessions/<pid>.json` alone does not give one:
measured 2026-09-05 across 33 real sessions, one was running with no registration and
one was registered with a dead process. Saving from the registrations would omit a
session and store a ghost. So the live report joins `ps` (ground truth for "running";
knows nothing about sessions) against the registrations (knows the session; can be stale
or missing), and a process with no registration is shown as its own row marked
`⚠ unregistered`. The join is what makes the count trustworthy; the same measurement also
showed that four of five "unregistered claude processes" were the daemon and its pty
helpers, which is why the filter is "session process **and** (registered **or** attached to
a tty)" rather than "any `claude` binary".

**Why it lives in the Sessions tab as scopes, not as a new tab.** Row rendering, search,
pins, status dots and resume-on-click all already live there; a separate screen would
either duplicate them or force a refactor of the biggest file in the app. Vertical space
is the scarce resource, so the two new entry points are chips in the search row (which has
spare width), and a scope replaces the list rather than adding to it. Scopes rank: a list
being viewed beats live, live beats pinned-only — encoded in `session-list-view.ts` so a
stale flag can never blank the list.

**What a member stores is the feature.** A list of bare sessionIds is useless for recall.
Each member captures title, branch, pin state (a snapshot — never updated later), the last
user and assistant messages, and the **recap** Claude Code writes into the transcript
(`"type":"system","subtype":"away_summary"`), every text field capped so a 30-session list
is a few tens of KB. The recap is preferred over the last assistant turn because it is
written to answer exactly the question a snapshot answers, and it is reliable enough to
lead with: 65 of 66 non-trivial sessions carry one (the misses are ≤29-line stubs that never
reached the three turns it needs). It is not unconditional — it can be switched off in
`/config`, needs the terminal to have been unfocused, and **never repeats back-to-back, so it
can predate the session's last turn** — which is why the row shows the last message as a
fallback and marks a recap `⏱` when it is more than 30 minutes older than the session's last
activity: its final sentence is usually "next: …", and acting on a stale one is the failure
mode.

**Deliberately absent: "open all".** In a browser, restoring 22 tabs is cheap. Here, 22
sessions is ~3GB of processes — the very problem the feature exists to relieve. Restore is
per-row (the existing click-to-resume), and a whole-set restore, if it ever comes, has to
show the projected cost first.

**Drift across `/branch` is shared with pins.** A list's members are keyed by sessionId
(each carrying the captured title, branch, pin state, messages and recap), so §4.7 applies
unchanged: after a branch, the member's key points at the ancestor. That is one more consumer of
the stable-task-identity decision in #142 (C1), and an argument for making it rather than
routing around it.

**Store.** `~/.config/codev/session-lists.json`, beside the marks store, on the same
authoritative-read / atomic-write / directory-watch machinery — extracted into
`src/atomic-json-store.ts` so the read-authority invariant PR #137 spent four rounds on has
exactly one implementation. **That invariant has a corollary the first live test paid for:
the store's normalizer must be a fixed point of itself.** A cap that landed on a space wrote
a trailing blank that the next read trimmed away, so the file the app had just written read
back as "normalization would change this" — non-authoritative — and every later write was
refused, silently. Two rules follow: normalize → serialize → normalize must be byte-stable
(tested), and a refused write must be shown, never swallowed.

**The `ps` join is also what makes "is it running" right for rows the registration-based
detection cannot see.** A session with no history row yet (a `/branch` child before its
first prompt) is invisible to `detectActiveSessions`, so a row for it reads as not running and
a click *resumes* it — a second process for the same id. Saved-list members and pin
placeholders now take their running state from the join as well, and viewing a list refreshes
it. The general fix — feeding the join into active detection itself — is #142 C0 territory.

**What the row shows.** By default, nothing extra: the live scope is a "running sessions
only" browse, and the one figure that says whether there is a problem — the total memory —
sits beside the search box. Per-row memory and uptime are behind a `stats` toggle (off by
default, remembered), because on most rows they track the message count closely enough to be
noise (user verdict after two rounds); they earn their width at the "which one do I close
first" moment, which is occasional. The tty is never on the row: a person cannot act on a tty
name, and it stays in the tooltip and in the data, where the future window-switching (#142 C0)
needs it.

**What the main list deliberately does not show.** A running process whose session has no
`history.jsonl` line — a `/branch` child before its first prompt (measured: the `/branch` prompt
itself is recorded under the *parent*) — has no row in the main list, and never did before
this feature either. The live scope synthesizes a row for it (named after its cwd, `⚠
unregistered` if it also lacks a registration); the main list does not. Decided 2026-09-05 to
keep it that way for now: a synthetic main-list row would be nearly blank (`codev · … msgs ·
dot`) until `forkedFrom` is read, and the honest presentation is the generation chain — the
child under its parent's lineage, with the parent's title — which is #142 C2/C3. The precise
repro and the interim option are in #149; the workaround today is the live scope.

**An untrusted store is reported, not repaired.** When the lists file exists but its
normalization is not a no-op (hand-edited, or a hypothetical future format change), the UI
says so with what the file holds — "N lists / M sessions inside; fix or remove it" — instead
of silently showing an empty list, which read as "my list was deleted" in a live test. It is
never rewritten from the UI: that would be an exception to the read-authority rule for a case
no released build produces, and a real format change is a versioned migration's job.

## 5. Batch 2 — structural investments

### 5.1 C4: preview / detail (v1 card → v2 pane)

- Corresponds to issue #66's "detail view" and #105; kills the root bottleneck ("must resume
  to verify") — the counterpart of Notion's right pane.
- **v1 (card)**: click a row (or press Space) → in-place detail card: custom/AI title, full
  first/last message, branch, PR, msgs, account, time + a text digest of the last N messages.
- **v2 (pane/reader)**: list left + read-only transcript reader right: lazy-load the last N
  messages, markdown rendering (the AI Chat tab already has an md renderer to reuse), tool
  calls collapsed to one-liner chips, **jump-to-match when arriving from search** (match
  positions come from A2's FTS).
- The "with C4 do we still need B1?" ruling: they serve different steps — B1 lets you **scan
  the list and see why each row matched** (no opening each one), C4 lets you **inspect one
  candidate deeply**. But B1's standalone work is absorbed: prompt-match snippets ship in
  §4.2, transcript-match snippets come free from A2's `snippet()` → **there is no standalone
  B1 work item**.
- Transcript-reading caveats: lines contain base64 images and huge tool_results — extract
  text blocks only; files can be tens of MB (tail-read + paginate).

### 5.2 A2: FTS5 full-text index (full version, no rg stopgap)

- Engine: **better-sqlite3 (already a dependency) + FTS5**. DB at `~/.config/codev/search-index.db`.
- Schema sketch: `messages(session_id, account, project, role, ts, text)` + an FTS5 virtual
  table (external-content or contentless both fine); plus `files(path, mtime, bytes_indexed)`
  for incremental progress.
- **Incremental indexing**: transcripts are append-only → track a per-file byte offset, parse
  only the delta; triggers: app focus / timer / session end. First full build runs in the
  background (chunked; never block the UI).
- **Extraction rules v1**: user + assistant text blocks; **exclude** thinking,
  tool_use/tool_result, base64. Indexing tool output (useful for "which session touched file
  X") stays behind a flag / v2 — that's A2+ (build a small inverted index from tool_use
  file_path args if trivial).
- **CJK trap and fix**: FTS5's trigram tokenizer needs ≥3 chars — 2-char CJK terms like
  「上限」 would miss → **pre-segment CJK runs into space-joined bigrams at index AND query
  time** (ASCII words left intact), on top of the default unicode61 tokenizer. Pure JS
  preprocessing, no native tokenizer dependency, mixed CJK/EN queries fine.
- Ranking: bm25 × recency; `snippet()` feeds B1/C4 directly.
- Multi-account: one DB with an `account` column; scan sources via the existing
  `getScannableAccounts()`.
- Duplicate-content note: normal resumes append to the same file (§4.4) — no cross-file
  duplication. **But `/branch` copies the transcript into a new file on every use, and it is
  a daily action (23.9% of transcripts, §4.7)** — so ancestor/descendant double-matches are
  common, not rare, and an index must dedupe them. The copied lines carry `forkedFrom`, so
  "skip lines whose `forkedFrom.sessionId` is already indexed" is exact. (This note used to
  say only `--fork-session` creates duplicates; that was wrong.)
- Expired sessions (transcript already cleaned up): the index keeps the text → results get an
  "expired" badge (readable, not resumable).

## 6. Batch 3 — add by feel

| Item | Content | Note |
|---|---|---|
| D3 `/pin` | Custom slash command: leverages Claude Code's slash **autocomplete** (answers the user's dislike of `!` having none); the command runs `codev pin`; sessionId from the **`CLAUDE_CODE_SESSION_ID` env var** ([FACT], §7); accepts one LLM turn (user OK'd). Args possible: `/pin as "…"` | UI pin remains primary |
| B4 filters | `project:` `branch:` `account:` `has:pr` `msgs:>10` `after:` `is:pinned` chips | **Promoted** (2026-08-20): the §4.6 term parser does most of the work, and `is:pinned` overlaps the pinned-only scope |
| D4 "Frequent" list | A frecency scope (`distinct active days × log(1+prompts) × exp(-age/14d)`) alongside the pinned scope. **Derive it from `history.jsonl`, which is already loaded** — no click instrumentation, so no weeks-long cold start | **Measured 2026-08-20, and the numbers argue for modest expectations**: only 3 of the frecency top-10 are outside the recency top-20, so most of it is a re-ordering of rows you can already see. It does **not** subsume pins — of the user's 7 real pins, 3 rank in the frecency top-10 but three others rank #26/#63/#72, because a pin is often exactly the *low*-activity session you refuse to lose. The two intents are complementary: frecency = "I keep coming back", pin = "I decided this matters" |
| A4-lite | "Generate title" button in the preview (haiku, writes a custom title) | No batch auto-summarizing |
| C3 chain collapse | **Live, not defunct — this entry was wrong.** It said generation chains do not exist because normal resumes reuse the sessionId. `/branch` also creates one, and it is a daily action: **21 of 88 transcripts on disk (23.9%) carry `forkedFrom`** (measured 2026-09-05, §4.7). | Tracked in issue #142 |

## 7. Key technical facts (gotchas — read before implementing)

1. **There is no clean in-session typed trigger** ([FACT], empirically proven —
   `pin-feature-handoff.md` §4): `/pin` triggers an LLM turn; **`!` bash-mode does too** (the
   output is submitted to the model — docs claim otherwise; on the real machine it turned);
   a `UserPromptSubmit` hook block (exit 2) avoids the turn but always shows a blocked notice
   (`suppressOutput` can't hide it). ⇒ Don't re-attempt "no turn AND no notice"; D3's premise
   is "accept the turn, gain autocomplete".
2. **`CLAUDE_CODE_SESSION_ID`** exists in the session shell and holds the session UUID (NOT
   the commonly-cited `CLAUDE_SESSION_ID`).
3. **Custom titles live inside the transcript**: `/rename` writes a `"type":"custom-title"`
   line; CodeV reads it via grep + tail -1 (`claude-session-utility.ts`). Resumes append to
   the same file (fact 4) → titles persist naturally; pins keyed by sessionId persist the
   same way.
4. **Resume semantics (verified on 2.1.207 via `--help`)**: `--resume` / `--continue`
   **reuse the sessionId and continue the same file by default**; `--fork-session` creates a
   new id/file, **and so does `/branch`** — the same process keeps writing to a copied
   transcript under a new id (§4.7, measured on 2.1.260). ⚠️ Old Claude Code versions forked
   by default — stale web posts and old experience still claim that; don't trust them (this
   plan's first draft got it wrong until the user challenged it). Anything about `/fork` must
   carry a version: its meaning changed at 2.1.161 and again at 2.1.212 (issue #142).
5. **history.jsonl: one line = one complete user prompt** (`display` untruncated, longest
   measured 9,224 chars); a session spans many lines; the accumulator keeps first/last and,
   since PR #132, all prompts in a main-side map.
6. **cachedSessions is metadata, not transcripts**: one small object per session
   (id/project/first/last/timestamps/count/account); 414 sessions ≪ 1MB; 5s TTL
   (`CACHE_TTL_MS`); the 894MB of transcripts are only ever tail-read per visible session
   during enrichment. **Never stuff large data into IPC-returned session objects.**
7. **The real pre-#132 search cap was the ~100 loaded sessions** (issue #131): renderer
   `filterSessionsLocally` only filtered the loaded list; main-side `searchClaudeSessions`
   was dead code. Fixed by §4.2 (shipped in PR #132).
8. **FTS5 trigram needs ≥3 chars** → 2-char CJK terms miss → bigram pre-segmentation (§5.2).
9. **Transcript lines contain base64 images and huge tool_results** → extract/render text
   blocks only, for both indexing and preview.
10. Multi-account: always iterate via `getScannableAccounts()`; user-level cross-account data
    (pins/hidden/index) lives in `~/.config/codev/`, one copy.
11. Lint: no CI lint gate; pre-existing files are not prettier-formatted → **format only the
    lines you change**; new files may be fully prettier'd.

## 8. Open questions (decide during implementation)

- ~~"Pinned section AND chronological position both show the row"~~ — **settled**: dual
  placement was rejected by the user during PR #136 live testing (zone-only). The browse-modes
  follow-up then gave the chronological view back as an explicit *ungroup* toggle rather than
  as a duplicate row; see §4.4.
- ~~`session-marks.json` single file vs. the handoff's `~/.claude/codev-status/pinned.json`~~ —
  **settled**: single cross-account file at `~/.config/codev/session-marks.json` (shipped).
- Whether C4 v1 card and v2 pane ship together: judge by effort at the time.
- Whether FTS indexes thinking blocks: v1 no (size/noise), keep a flag.
