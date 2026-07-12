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
