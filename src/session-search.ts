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
  if (max <= 1 || text.length <= max) return text;
  // Bias the head slightly longer — it carries the topic, the tail the latest step.
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(text.length - tail) : ''}`;
};

/**
 * A `max`-char window over `text` that is guaranteed to CONTAIN the first
 * search match, with ellipses marking whichever end was cut.
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
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of wordsLower) {
    if (!w) continue;
    const i = lower.indexOf(w);
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  // No match, or already visible in the plain head window: render as usual.
  if (at === -1 || at < max - 1) return fallback(text, max);
  const start = Math.max(0, at - Math.floor(max / 3));
  const end = Math.min(text.length, start + max - 1);
  return `…${text.slice(start, end)}${end < text.length ? '…' : ''}`;
};
