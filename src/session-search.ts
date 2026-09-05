/**
 * Pure session-search / list helpers (no fs, no electron) so they are unit-testable.
 *
 * Used by:
 * - claude-session-utility.ts — main-side full-prompt search (issue #131)
 * - switcher-ui.tsx — minor-session folding predicate
 *
 * The query language (issue #140, plan §4.6) lives here too: `parseQuery`
 * turns the search box into terms, `compileQuery` turns the terms into ONE
 * matcher that both search paths run. Two implementations of "does this
 * session match" is how PR #137 and #147 each produced a round of drift bugs;
 * the two callers now differ only in what they can put on the target.
 */

// ---------------------------------------------------------------------------
// Query language
// ---------------------------------------------------------------------------

/** Fields a term can be aimed at with `field:value`. */
export type ScopedField =
  | 'title'
  | 'branch'
  | 'msg'
  | 'project'
  | 'account'
  | 'recap';

const SCOPED_FIELDS: ReadonlySet<string> = new Set<ScopedField>([
  'title',
  'branch',
  'msg',
  'project',
  'account',
  'recap',
]);
const HAS_VALUES: ReadonlySet<string> = new Set([
  'pr',
  'title',
  'branch',
  'recap',
]);
const IS_VALUES: ReadonlySet<string> = new Set(['live', 'pinned']);
const IS_ALIASES: Record<string, string> = { running: 'live', active: 'live' };

/**
 * A pull-request (or issue — GitHub numbers them together) reference. The
 * repo is kept when the query carried one, so `grimmerk/codev#147` does not
 * match a `fireflies/x/pull/147` URL, and a bare `#147` in the target counts
 * for it only when the session's own repo context names `grimmerk/codev`
 * (`QueryTarget.repos`) — a bare number cannot say which repo it meant, so
 * the session has to. The full table is on `findPrRefWith`.
 */
export interface PrRef {
  number: number;
  /** `owner/repo`, lowercased. */
  repo?: string;
  /**
   * `pr:N` with no repo: only a session's own PR badge or a repo-qualified
   * mention counts, never a bare `#N` — every repo has its own N. A bare
   * `#N` in the query stays broad on purpose.
   */
  strict?: boolean;
}

export interface ScopedTerm {
  field: ScopedField;
  /** Lowercased. */
  value: string;
}

export interface ParsedQuery {
  /** Bare words (lowercased): today's "search everything" semantics. */
  words: string[];
  fields: ScopedTerm[];
  prRefs: PrRef[];
  /** `has:` values: `pr` `title` `branch` `recap`. */
  has: string[];
  /** `is:` values: `live` `pinned`. */
  is: string[];
  /** `after:` — sessions last active at or after this epoch ms. */
  after?: number;
  /** `before:` — sessions last active before this epoch ms. */
  before?: number;
  /**
   * Terms recognised as operators whose value could not be used
   * (`after:soon`, `has:tea`, `title:`). Dropped from matching and reported,
   * so the search box can say so rather than silently ignoring them.
   */
  ignored: string[];
}

export const emptyQuery = (): ParsedQuery => ({
  words: [],
  fields: [],
  prRefs: [],
  has: [],
  is: [],
  ignored: [],
});

/** True when nothing in the query constrains the result. */
export const isEmptyQuery = (q: ParsedQuery): boolean =>
  q.words.length === 0 &&
  q.fields.length === 0 &&
  q.prRefs.length === 0 &&
  q.has.length === 0 &&
  q.is.length === 0 &&
  q.after === undefined &&
  q.before === undefined;

/**
 * Split on whitespace, honouring double quotes: `title:"foo bar"` is one
 * token with the quotes removed (`title:foo bar`). An unterminated quote runs
 * to the end of the query, which is what someone still typing expects.
 */
export const tokenizeQuery = (query: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of query) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
};

// A GitHub owner is alphanumerics and hyphens only — no dot — which is what
// keeps `example.com/o/pull/1` from reading as owner `example.com`.
const OWNER = '[a-z0-9-]+';
const REPO = `${OWNER}\\/[a-z0-9_.-]+`;
// `github.com` or `www.github.com`, and only where a host can stand: at the
// start, after a scheme's `://`, or after a character no host or path
// contains. That refuses a subdomain (`evil.github.com` — a dot before it),
// the tail of another name (`notgithub.com`, `not_github.com`), and a path
// segment inside some other URL (`https://example.com/github.com/o/r/…`).
const HOST = '(?<=^|:\\/\\/|[^a-z0-9_.\\/-])(?:www\\.)?github\\.com';
// Numbers never start with a zero, matching the miner: `#012` is not PR 12.
const NUMBER = '[1-9][0-9]*';
// The host is optional: `owner/repo/pull/N` is unambiguous on its own, and it
// is what people type when they shorten a URL by hand. A scheme, when
// present, must be followed by the GitHub host — `https://example.com/o/pull/1`
// is a URL to search for as a word, not a PR reference.
const PR_URL_RE = new RegExp(
  `^(?:(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/)?(${REPO})\\/(?:pull|issues)\\/(${NUMBER})(?:[/?#].*)?$`,
);
const REPO_HASH_RE = new RegExp(`^(${REPO})#(${NUMBER})$`);
const BARE_HASH_RE = new RegExp(`^#(${NUMBER})$`);

/**
 * Read a token (lowercased) as a PR reference, or null. Forms: the GitHub
 * URL (pull or issues, trailing path allowed), `owner/repo#N`, `#N`. Never a
 * bare number — `1598` is a word.
 */
export const parsePrRef = (tokenLower: string): PrRef | null => {
  let m = PR_URL_RE.exec(tokenLower);
  if (m) return { number: Number(m[2]), repo: m[1] };
  m = REPO_HASH_RE.exec(tokenLower);
  if (m) return { number: Number(m[2]), repo: m[1] };
  m = BARE_HASH_RE.exec(tokenLower);
  if (m) return { number: Number(m[1]) };
  return null;
};

/**
 * The repos a session is known to be about, for `QueryTarget.repos`: the
 * `owner/repo` of its PR badge URL and of every repo-qualified reference
 * (`owner/repo#N`) it carries. One derivation for both search paths.
 */
export const sessionRepos = (
  prUrl?: string,
  refs?: readonly string[],
): string[] => {
  const out = new Set<string>();
  if (prUrl) {
    const m = new RegExp(`${HOST}\\/(${REPO})\\/`, 'i').exec(prUrl);
    if (m) out.add(m[1].toLowerCase());
  }
  for (const r of refs ?? []) {
    const hash = r.indexOf('#');
    if (hash > 0) out.add(r.slice(0, hash).toLowerCase());
  }
  return [...out];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RELATIVE_UNIT_MS: Record<string, number> = {
  h: 60 * 60 * 1000,
  d: DAY_MS,
  w: 7 * DAY_MS,
};

/**
 * A point in time for `after:` / `before:`: `YYYY-MM-DD` (local midnight),
 * `Nh` / `Nd` / `Nw` ago, `today`, `yesterday`. Null when unreadable.
 */
export const parseQueryDate = (value: string, now: number): number | null => {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    const [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const date = new Date(y, mo - 1, d);
    // Date rolls an out-of-range month or day forward (2026-13-40 becomes a
    // real day in 2027); a typo must be reported, not silently moved.
    return date.getMonth() === mo - 1 && date.getDate() === d
      ? date.getTime()
      : null;
  }
  const rel = /^(\d+)([hdw])$/.exec(value);
  if (rel) return now - Number(rel[1]) * RELATIVE_UNIT_MS[rel[2]];
  if (value === 'today' || value === 'yesterday') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime() - (value === 'yesterday' ? DAY_MS : 0);
  }
  return null;
};

/**
 * Parse the search box. Everything is lowercased; a token with an unknown
 * `key:` prefix (`error:`, `12:30`, a URL that is not a PR) stays a bare
 * word, so the operators cost nothing to queries that do not use them.
 */
export const parseQuery = (query: string, now = Date.now()): ParsedQuery => {
  const q = emptyQuery();
  for (const raw of tokenizeQuery(query)) {
    const token = raw.toLowerCase();
    const pr = parsePrRef(token);
    if (pr) {
      q.prRefs.push(pr);
      continue;
    }
    const colon = token.indexOf(':');
    const key = colon > 0 ? token.slice(0, colon) : '';
    const value = colon > 0 ? token.slice(colon + 1) : '';
    if (key === 'pr') {
      // `pr:147`, `pr:o/r#147`, `pr:<url>` — a number alone is allowed here
      // because the key already says what it is.
      const ref = /^[1-9][0-9]*$/.test(value)
        ? { number: Number(value), strict: true }
        : parsePrRef(value);
      if (ref) q.prRefs.push(ref);
      else q.ignored.push(raw);
    } else if (SCOPED_FIELDS.has(key)) {
      if (value) q.fields.push({ field: key as ScopedField, value });
      else q.ignored.push(raw);
    } else if (key === 'has') {
      if (HAS_VALUES.has(value)) q.has.push(value);
      else q.ignored.push(raw);
    } else if (key === 'is') {
      const v = IS_ALIASES[value] ?? value;
      if (IS_VALUES.has(v)) q.is.push(v);
      else q.ignored.push(raw);
    } else if (key === 'after' || key === 'before') {
      const t = parseQueryDate(value, now);
      if (t === null) q.ignored.push(raw);
      else if (key === 'after') q.after = Math.max(q.after ?? -Infinity, t);
      else q.before = Math.min(q.before ?? Infinity, t);
    } else if (token) {
      q.words.push(token);
    }
  }
  return q;
};

/**
 * What a matcher needs to know about one session. Everything optional: a
 * caller supplies what it has, and a term aimed at a field the caller could
 * not supply simply fails for that session — so a caller that cannot judge a
 * term must leave it out of the query it compiles (see the two callers).
 */
export interface QueryTarget {
  sessionId: string;
  /** Free text bare words and PR references search. Raw case. */
  text: string;
  title?: string;
  branch?: string;
  /** Project name and path together. */
  project?: string;
  account?: string;
  recap?: string;
  /** For `msg:` — every prompt the caller has (all of them on the main side; first/last in the renderer). */
  prompts?: string[];
  hasPr?: boolean;
  isLive?: boolean;
  isPinned?: boolean;
  lastTimestamp?: number;
  /**
   * The repos this session is known to be about (`owner/repo`, any case):
   * its PR badge's URL and any repo-qualified reference it carries. A
   * repo-qualified query accepts a bare `#N` in the text only when the
   * session's own context names that repo.
   */
  repos?: string[];
}

/**
 * Where a PR reference occurs in `textLower`, honouring the repo when the
 * reference carries one. Delimited forms only — `#147` never matches inside
 * `#1475` or `15980` — which is the rule §4.6 insists on: **never match a
 * bare number**.
 */
interface PrRefPatterns {
  ref: PrRef;
  n: string;
  hash: RegExp;
  url: RegExp;
}

// Built once per query, not once per session.
const prRefPatterns = (ref: PrRef): PrRefPatterns => {
  const n = String(ref.number);
  return {
    ref,
    n,
    // `#N` and `owner/repo#N`. The optional repo group is anchored by the
    // boundary before it, so `foo/bar#12` captures `foo/bar`, not `o/bar`.
    // The number must END there too: `#147abc` is an identifier, not PR 147.
    hash: new RegExp(
      `(?:^|[^0-9a-z_./-])((?:${REPO})?)#${n}(?![0-9a-z_])`,
      'g',
    ),
    url: new RegExp(
      `${HOST}\\/(${REPO})\\/(?:pull|issues)\\/${n}(?![0-9a-z_])`,
      'g',
    ),
  };
};

/**
 * Is the `#` at `hashIndex` the one in Claude Code's `[Image #N]` marker for
 * a pasted screenshot? Those are numbered per session from 1 — exactly the
 * range small PR numbers live in. Seen in the first live test: `pr:151`
 * listed a session whose only "#151" was `[Image #151]`. One rule for the
 * query matcher and the transcript miner, so they cannot disagree about it.
 */
export const isImageMarkerHash = (text: string, hashIndex: number): boolean =>
  hashIndex >= 7 &&
  text.slice(hashIndex - 7, hashIndex).toLowerCase() === '[image ';

/**
 * Which occurrences count, by how much the QUERY said:
 *
 * | query form              | qualified `o/r#N` / URL in text | bare `#N` in text                    |
 * |-------------------------|----------------------------------|--------------------------------------|
 * | `#N`                    | any repo                         | yes                                  |
 * | `pr:N`                  | any repo                         | no                                   |
 * | `o/r#N`, URL, `pr:o/r#N`| same repo only                   | only if the session's own repos include `o/r` |
 *
 * The first live test of a bare `pr:151` listed eight sessions, and
 * `pr:grimmerk/codev#151` still listed them because a bare `#151` used to
 * count regardless — hence the two strict rows. (Most of the eight were the
 * miner's missing right boundary reading `#151e2b` as `#151`; the rows stay
 * because every repo has its own N.)
 */
const findPrRefWith = (
  textLower: string,
  p: PrRefPatterns,
  reposLower?: string[],
): { index: number; length: number } | null => {
  const { ref, n, hash, url } = p;
  // Most sessions never mention the number at all; a substring check is far
  // cheaper than either regex over a session's whole prompt text. Measured
  // over 560 sessions: a PR-reference keystroke cost ~20ms without this,
  // against ~8ms for a bare word.
  if (!textLower.includes(n)) return null;
  const bareAllowed = ref.repo
    ? !!reposLower && reposLower.includes(ref.repo)
    : !ref.strict;
  hash.lastIndex = 0;
  for (let m = hash.exec(textLower); m; m = hash.exec(textLower)) {
    const repo = m[1];
    const at = m.index + m[0].length - n.length - 1 - repo.length;
    if (repo) {
      if (ref.repo && repo !== ref.repo) continue;
    } else {
      if (!bareAllowed) continue;
      if (isImageMarkerHash(textLower, at)) continue;
    }
    return { index: at, length: repo.length + 1 + n.length };
  }
  url.lastIndex = 0;
  for (let m = url.exec(textLower); m; m = url.exec(textLower)) {
    if (ref.repo && m[1] !== ref.repo) continue;
    return { index: m.index, length: m[0].length };
  }
  return null;
};

export const findPrRef = (
  textLower: string,
  ref: PrRef,
  repos?: string[],
): { index: number; length: number } | null =>
  findPrRefWith(
    textLower,
    prRefPatterns(ref),
    repos?.map((r) => r.toLowerCase()),
  );

export interface QueryMatcher {
  test: (target: QueryTarget) => boolean;
  query: ParsedQuery;
}

/**
 * One matcher for one query. Every term must hold (AND), and a term that
 * looks at a field the target does not carry fails — the caller decides what
 * it can judge by what it compiles, not by how the matcher forgives.
 */
export const compileQuery = (query: ParsedQuery): QueryMatcher => {
  const lower = (s: string | undefined) => (s ?? '').toLowerCase();
  const prPatterns = query.prRefs.map(prRefPatterns);
  const test = (t: QueryTarget): boolean => {
    const textLower = t.text.toLowerCase();
    const reposLower = t.repos?.map((r) => r.toLowerCase());
    for (const w of query.words) {
      if (!textLower.includes(w) && !matchesSessionId(t.sessionId, w))
        return false;
    }
    for (const p of prPatterns) {
      if (!findPrRefWith(textLower, p, reposLower)) return false;
    }
    for (const { field, value } of query.fields) {
      if (field === 'msg') {
        if (!(t.prompts ?? []).some((p) => p.toLowerCase().includes(value)))
          return false;
      } else if (!lower(t[field]).includes(value)) {
        return false;
      }
    }
    for (const h of query.has) {
      const present =
        h === 'pr'
          ? !!t.hasPr
          : h === 'title'
            ? !!t.title
            : h === 'branch'
              ? !!t.branch
              : !!t.recap;
      if (!present) return false;
    }
    for (const i of query.is) {
      if (i === 'live' ? !t.isLive : !t.isPinned) return false;
    }
    if (
      query.after !== undefined &&
      !((t.lastTimestamp ?? -Infinity) >= query.after)
    )
      return false;
    if (
      query.before !== undefined &&
      !((t.lastTimestamp ?? Infinity) < query.before)
    )
      return false;
    return true;
  };
  return { test, query };
};

/**
 * Strings worth highlighting in a matched row: bare words, scoped values, and
 * the `#N` / `/pull/N` spellings of each PR reference. Highlighting is
 * cosmetic — `#147` will also light up inside `#1475` on a row that matched
 * for another reason — so it deliberately does not re-run the matcher.
 */
export const highlightNeedles = (q: ParsedQuery): string[] => {
  const out = [...q.words, ...q.fields.map((f) => f.value)];
  for (const r of q.prRefs) {
    out.push(`#${r.number}`, `/pull/${r.number}`, `/issues/${r.number}`);
  }
  return [...new Set(out.filter(Boolean))];
};

/** The words a prompt snippet should be centred on: bare words and `msg:` values. */
export const promptNeedles = (q: ParsedQuery): string[] => [
  ...q.words,
  ...q.fields.filter((f) => f.field === 'msg').map((f) => f.value),
];

export interface PromptMatch {
  /** 0-based index into the session's prompt list (0 = first user message). */
  promptIndex: number;
  /** Human-readable context window centered on the first matched word. */
  snippet: string;
}

/** AND-match: every word must appear somewhere in the haystack (both lowercased). */
export const matchesAllWords = (
  haystackLower: string,
  wordsLower: string[],
): boolean => wordsLower.every((w) => haystackLower.includes(w));

/**
 * Does a query word name a session by its id? A PREFIX of at least four hex
 * characters (hyphens allowed), never a substring: the id is searchable so
 * the one a terminal status line shows can be typed in, and people type it
 * from the start. A substring rule would make `de` or `cafe` match nearly
 * every session on the machine through its id, regardless of content.
 */
export const matchesSessionId = (
  sessionId: string,
  wordLower: string,
): boolean =>
  wordLower.length >= 4 &&
  /^[0-9a-f-]+$/.test(wordLower) &&
  sessionId.toLowerCase().startsWith(wordLower);

/**
 * `matchesAllWords` plus the id rule: every word must match the text OR
 * the session id. One definition for both search paths (main-side prompt
 * search and the renderer's field filter), so they cannot disagree about
 * what an id query is.
 */
export const matchesAllWordsOrId = (
  haystackLower: string,
  sessionId: string,
  wordsLower: string[],
): boolean =>
  wordsLower.every(
    (w) => haystackLower.includes(w) || matchesSessionId(sessionId, w),
  );

/**
 * Extract a snippet of `radius` chars on each side of the match, collapsing
 * whitespace/newlines so it renders as a single line. Ellipses mark truncation.
 */
export const extractSnippet = (
  text: string,
  matchStart: number,
  matchLen: number,
  radius = 40,
): string => {
  const start = Math.max(0, matchStart - radius);
  const end = Math.min(text.length, matchStart + matchLen + radius);
  const core = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${core}${end < text.length ? '…' : ''}`;
};

/**
 * Find the first prompt containing any of the search words and return a
 * snippet around it. Returns null when no prompt contains any word (e.g. the
 * session matched on project name only).
 */
export const findPromptMatch = (
  prompts: string[],
  wordsLower: string[],
  prRefs: PrRef[] = [],
  repos?: string[],
): PromptMatch | null => {
  for (let i = 0; i < prompts.length; i++) {
    const lower = prompts[i].toLowerCase();
    for (const w of wordsLower) {
      const idx = lower.indexOf(w);
      if (idx !== -1) {
        return {
          promptIndex: i,
          snippet: extractSnippet(prompts[i], idx, w.length),
        };
      }
    }
    for (const ref of prRefs) {
      const hit = findPrRef(lower, ref, repos);
      if (hit) {
        return {
          promptIndex: i,
          snippet: extractSnippet(prompts[i], hit.index, hit.length),
        };
      }
    }
  }
  return null;
};

/**
 * Minor-session ("junk") folding predicate: a closed session with almost no
 * content and no user-assigned identity. Conservative on purpose — sessions
 * with an unknown messageCount are NOT minor (fold less, never hide real work).
 */
export const isMinorSession = (
  session: { messageCount?: number; isActive?: boolean },
  hasCustomTitle: boolean,
  hasPrLink: boolean,
): boolean =>
  !session.isActive &&
  !hasCustomTitle &&
  !hasPrLink &&
  typeof session.messageCount === 'number' &&
  session.messageCount <= 2;

/**
 * Where a match found in `text.toLowerCase()` lives in `text` itself.
 *
 * Folding is not length-preserving — 'İ' lowercases to two code units — so an
 * offset found in the lowercased copy does not address the same character in
 * the source. Matching still has to be done with `toLowerCase`, because that is
 * what `matchesAllWords` uses to decide the row belongs in the results at all;
 * a regex with `/i` folds differently and would list a row that shows no
 * highlight. So the offset is translated, not re-derived.
 *
 * Translating by counting prefix lengths is not enough: a query can begin
 * INSIDE an expansion (the combining dot of 'İ'), and a prefix count can only
 * name whole source characters, so it reports the character AFTER the one the
 * match started in and the span comes back empty. Recording which source
 * character each folded unit came from answers both ends exactly.
 */
const foldedOrigins = (text: string): number[] => {
  const origins: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const folded = text[i].toLowerCase();
    for (let k = 0; k < folded.length; k++) origins.push(i);
  }
  return origins;
};

/**
 * Shorten from the MIDDLE, keeping both ends: `head … tail`.
 *
 * Head-only truncation is wrong for this app's titles specifically. Measured on
 * the reference machine (125 unique custom titles): median 44 chars, 64% longer
 * than the old 35-char cut, and 38% written as `A -> B > C` chains whose newest
 * step sits at the END — so the cut removed exactly the part that identifies
 * the session. Worse, 48 of 125 titles shared their first 35 characters: eight
 * different sessions all rendered as `fred-ff nextjs backend and mcp arch`.
 */
export const truncateMiddle = (text: string, max: number): string => {
  if (max <= 0) return '';
  if (text.length <= max) return text;
  // At one character there is no room for head, tail AND a marker; the marker
  // is the only honest thing to keep.
  if (max === 1) return '…';
  // Bias the head slightly longer — it carries the topic, the tail the latest step.
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(text.length - tail) : ''}`;
};

/**
 * A `max`-char window over `text` that is guaranteed to show A match, with
 * ellipses marking whichever end was cut.
 *
 * A match, not *the first* match: the earliest occurrence is only used to
 * decide where to centre the window. If the ordinary rendering already shows
 * some later occurrence of the same word, that rendering is returned unchanged
 * — the reader still sees a highlight, and they see it in the familiar head+
 * tail shape instead of a window that jumped for no visible reason.
 *
 * A row can only justify its place in the results if you can see why it
 * matched. Every line here is length-capped, so a hit past the cap filtered the
 * row in and then showed nothing — measured: 39% of first prompts and 42% of
 * last prompts exceed the cap they are rendered at. When nothing matches (or
 * the match already sits inside the head window) this falls back to `fallback`,
 * which is the ordinary non-search rendering.
 */
export const windowAroundMatch = (
  text: string,
  wordsLower: string[],
  max: number,
  fallback: (text: string, max: number) => string = truncateMiddle,
): string => {
  if (text.length <= max) return text;

  // Match exactly as `matchesAllWords` does, then translate the offset into
  // the source (see sourceIndexOfLowerIndex). Two matching rules for one
  // question is how a row ends up listed with nothing highlighted.
  const lower = text.toLowerCase();
  let atLower = -1;
  let wordLen = 0;
  for (const w of wordsLower) {
    if (!w) continue;
    const i = lower.indexOf(w);
    if (i !== -1 && (atLower === -1 || i < atLower)) {
      atLower = i;
      wordLen = w.length;
    }
  }
  let at = -1;
  let hit = '';
  if (atLower !== -1) {
    if (lower.length === text.length) {
      // Nothing expanded, so the two strings share coordinates.
      at = atLower;
      hit = text.slice(at, at + wordLen);
    } else {
      const origins = foldedOrigins(text);
      at = origins[atLower];
      // Inclusive end: the source character the match's LAST folded unit came
      // from, so a match that starts or ends inside an expansion still yields
      // a non-empty span.
      hit = text.slice(at, origins[atLower + wordLen - 1] + 1);
    }
  }
  if (at === -1) return fallback(text, max);

  // No useful window exists in one or two characters, and building one would
  // spend the whole budget on ellipses; the fallback already honours the cap.
  if (max <= 2) return fallback(text, max);

  // ASK the fallback whether the match is already on screen rather than
  // modelling where it keeps characters. An earlier version assumed a head
  // window (`at < max - 1`) while the fallback truncated from the MIDDLE, so a
  // match at index 40 of a 60-char budget was declared visible and then landed
  // in the elided middle — the one thing this helper promises cannot happen.
  const plain = fallback(text, max);
  if (plain.toLowerCase().includes(hit.toLowerCase())) return plain;

  // Every ellipsis rendered counts against `max`, or a "capped" line silently
  // overruns the space the row reserved for it.
  // Position roughly a third in, then pull the window forward if the match's
  // TAIL would fall outside it. Centring alone is not enough: a long search
  // word can start inside the window and still run past its end, so the
  // trailing ellipsis swallows it and this branch fails at the one thing it
  // exists to do.
  const wantEnd = at + hit.length;
  let start = Math.max(0, at - Math.floor(max / 3));
  // Reserve the trailing ellipsis while positioning; give it back below if the
  // window reaches the end of the text.
  let room = max - (start > 0 ? 1 : 0) - 1;
  if (start + room < wantEnd) {
    // A word longer than the window cannot fit whole — then show it from its
    // first character rather than from the middle of it.
    start = Math.min(at, Math.max(0, wantEnd - room));
    room = max - (start > 0 ? 1 : 0) - 1;
  }
  const lead = start > 0 ? '…' : '';
  if (start + room >= text.length) {
    return `${lead}${text.slice(start, start + (max - lead.length))}`;
  }
  return `${lead}${text.slice(start, start + room)}…`;
};
