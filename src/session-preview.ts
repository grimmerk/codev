/**
 * Session Preview: which preview lines a Sessions row shows under its title.
 *
 * Two independent settings — which user prompt(s), and whether the last
 * assistant reply — replace the single `session-display-mode` dropdown, whose
 * three choices were all user prompts and whose assistant line could not be
 * turned off.
 *
 * Migration is done at read time, never by rewriting the store: the old key
 * is only ever read as a fallback, so resolving twice gives the same answer
 * and an older build still finds a value it understands.
 */

export type UserPromptPreview = 'none' | 'first' | 'last' | 'both';

export interface SessionPreviewSettings {
  userPrompt: UserPromptPreview;
  assistantReply: boolean;
}

export const SETTINGS_KEY_USER_PROMPT = 'session-preview-user-prompt';
export const SETTINGS_KEY_ASSISTANT_REPLY = 'session-preview-assistant-reply';
/** The single dropdown's key (<= 1.0.94): 'first' | 'last' | 'both'. */
export const SETTINGS_KEY_LEGACY_MODE = 'session-display-mode';

export const DEFAULT_SESSION_PREVIEW: SessionPreviewSettings = {
  userPrompt: 'first',
  assistantReply: true,
};

const USER_PROMPT_VALUES: readonly UserPromptPreview[] = ['none', 'first', 'last', 'both'];

export const asUserPrompt = (value: unknown): UserPromptPreview | undefined =>
  USER_PROMPT_VALUES.find((v) => v === value);

/**
 * The settings in effect, from whatever the store holds.
 *
 * User prompt: the new key when it holds a known value; else the old key
 * (which never had 'none', so a stray 'none' there is not trusted); else the
 * default. Assistant reply: the new key when it is a boolean; else on — the
 * old dropdown always showed it, so an upgraded install looks the same until
 * something is changed.
 */
export const resolveSessionPreview = (stored: {
  userPrompt?: unknown;
  assistantReply?: unknown;
  legacyMode?: unknown;
}): SessionPreviewSettings => {
  const legacy = asUserPrompt(stored.legacyMode);
  return {
    userPrompt:
      asUserPrompt(stored.userPrompt) ??
      (legacy && legacy !== 'none' ? legacy : undefined) ??
      DEFAULT_SESSION_PREVIEW.userPrompt,
    assistantReply:
      typeof stored.assistantReply === 'boolean'
        ? stored.assistantReply
        : DEFAULT_SESSION_PREVIEW.assistantReply,
  };
};

/**
 * What to mirror into the old key when the user prompt choice is saved, so a
 * downgraded build shows the latest choice it can express. 'none' has no
 * equivalent there: null means leave the old key as it is.
 */
export const legacyModeFor = (userPrompt: UserPromptPreview): string | null =>
  userPrompt === 'none' ? null : userPrompt;

/**
 * Which user prompts a row actually renders. In 'both', a last prompt equal
 * to the first is not repeated. Both false means the row has no prompt line
 * at all (and must not reserve space for one).
 */
export const userPromptLines = (
  userPrompt: UserPromptPreview,
  first: string | undefined,
  last: string | undefined,
): { first: boolean; last: boolean } => ({
  first: (userPrompt === 'first' || userPrompt === 'both') && !!first,
  last:
    (userPrompt === 'last' && !!last) ||
    (userPrompt === 'both' && !!last && last !== first),
});

const holdsWord = (text: string, word: string): boolean =>
  text.toLowerCase().includes(word.toLowerCase());

/**
 * A prompt that is on no row line and holds a query word that no on-row
 * prompt holds — the one a search has to name, since nothing on the row
 * shows why that word matched. Judged per word: a visible prompt matching
 * one word of the query does not explain another word found only off the row.
 */
export const offRowPromptMatch = (
  words: readonly string[],
  onRow: readonly (string | undefined)[],
  prompts: readonly (string | undefined)[],
): string | undefined => {
  const visible = onRow.filter((p): p is string => !!p);
  const unexplained = words.filter((w) => !visible.some((p) => holdsWord(p, w)));
  return prompts.find(
    (p): p is string =>
      !!p && !visible.includes(p) && unexplained.some((w) => holdsWord(p, w)),
  );
};

/**
 * The reply text a search matched, from the sources the filter searches, in
 * display order: the first that holds a query word. A saved-list member has
 * two (the current reply and the one captured with the list) and either can
 * be the match.
 */
export const matchingReply = (
  words: readonly string[],
  replies: readonly (string | undefined)[],
): string | undefined =>
  replies.find((r): r is string => !!r && words.some((w) => holdsWord(r, w)));
