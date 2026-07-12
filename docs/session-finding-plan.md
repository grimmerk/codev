# Session-Finding Improvement Plan (search / browse / pins / preview)

> **Status: decided; Batch 1 in flight** (finalized 2026-07-12 via a brainstorm session).
> PR-1 "search & noise" (§4.1–§4.3: B2 highlight + A1/B1 full search + C1 folding) = **PR #132**;
> PR-2 "pins" (§4.4 D1, incl. C1's manual hide) not started; Batch 2/3 not started.
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

**UI spec (proposed to the user):**
- Hovering a session row reveals a 📌 button on the right; click toggles; pinned rows show a
  persistent small ★.
- Top of the Sessions list: a collapsible "📌 Pinned (N)" section, expanded by default; rows
  fully reuse the existing session row (status dot / badges / PR / title all intact).
- A pinned session **also** stays in its chronological position (with the ★) — the section is
  a shortcut, not a move (Notion favorites behave the same).
- While searching: the pinned section hides; results are one unified list (matching pinned
  rows keep the ★).
- Unpin: hover-`x` on the pinned row (the recent-projects list already has this pattern) or
  click 📌 again.
- One-line empty-state hint.
- v1 ordering: pinnedAt desc; named groups are v2 (schema keeps a `group?` field now).

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
- Edge cases (v1 ignores them; re-pin manually if hit): explicit `--fork-session`,
  cross-account copy-fork (issue #128).

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
  duplication; only explicit `--fork-session` creates ancestor/descendant double-matches —
  rare, v1 ignores.
- Expired sessions (transcript already cleaned up): the index keeps the text → results get an
  "expired" badge (readable, not resumable).

## 6. Batch 3 — add by feel

| Item | Content | Note |
|---|---|---|
| D3 `/pin` | Custom slash command: leverages Claude Code's slash **autocomplete** (answers the user's dislike of `!` having none); the command runs `codev pin`; sessionId from the **`CLAUDE_CODE_SESSION_ID` env var** ([FACT], §7); accepts one LLM turn (user OK'd). Args possible: `/pin as "…"` | UI pin remains primary |
| B4 filters | `project:` `branch:` `account:` `has:pr` `msgs:>10` `after:` chips | |
| A4-lite | "Generate title" button in the preview (haiku, writes a custom title) | No batch auto-summarizing |
| C3 chain collapse | **Essentially defunct** (2026-07-12): normal resumes reuse the sessionId (§4.4) — no generation chains exist; only meaningful if `--fork-session` / copy-fork become common | Kept for the record |

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
   **reuse the sessionId and continue the same file by default**; only `--fork-session`
   creates a new id/file. ⚠️ Old Claude Code versions forked by default — stale web posts and
   old experience still claim that; don't trust them (this plan's first draft got it wrong
   until the user challenged it).
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

- "Pinned section AND chronological position both show the row" is the proposed default; the
  user hasn't given a final verdict (switch to section-only if they object).
- `session-marks.json` single file vs. the handoff's `~/.claude/codev-status/pinned.json`:
  this doc leans to the former (multi-account + hidden list); revisit at implementation time.
- Whether C4 v1 card and v2 pane ship together: judge by effort at the time.
- Whether FTS indexes thinking blocks: v1 no (size/noise), keep a flag.
