/**
 * Pure session-search / list helpers (no fs, no electron) so they are unit-testable.
 *
 * Used by:
 * - claude-session-utility.ts — main-side full-prompt search (issue #131)
 * - switcher-ui.tsx — minor-session folding predicate
 */

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
 * The source index whose lowercased prefix is `lowerIndex` code units long.
 *
 * `toLowerCase()` can change length ('İ' becomes two code units), so an offset
 * found in a lowercased copy does not address the same character in the
 * source. Walking the prefix maps one to the other WITHOUT changing what
 * counts as a match — matching has to stay `toLowerCase`-based because that is
 * what `matchesAllWords` uses to decide the row belongs in the results at all.
 * A regex with the `i` flag folds differently (it will not accept 'İ' for 'i'),
 * so a row could be listed and then show no highlight.
 */
const sourceIndexOfLowerIndex = (text: string, lowerIndex: number): number => {
  let lowerLen = 0;
  for (let i = 0; i < text.length; i++) {
    if (lowerLen >= lowerIndex) return i;
    lowerLen += text[i].toLowerCase().length;
  }
  return text.length;
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
  const at = atLower === -1 ? -1 : sourceIndexOfLowerIndex(text, atLower);
  // The SOURCE span, not the query word: its length in the original text is
  // what the window has to make room for.
  const hit =
    atLower === -1
      ? ''
      : text.slice(at, sourceIndexOfLowerIndex(text, atLower + wordLen));
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
