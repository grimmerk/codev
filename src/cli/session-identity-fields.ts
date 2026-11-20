/**
 * The renderer-safe half of session identity: the shape, the list of copyable
 * fields and the one-line reference. No Node imports at all, so the Sessions
 * tab can import it; `session-identity.ts` (fs, child_process) re-exports it
 * for the main process and the CLI.
 */

/**
 * `custom` is the name `/rename` gave the session — the one another Claude
 * session can address it by. `ai` is the title Claude Code generated on its
 * own, shown when there is no custom one; it is not a messaging address.
 * `unknown` is a title somebody captured earlier (the row, a saved list) when
 * the transcript can no longer say which of the two it was.
 */
export type TitleKind = 'custom' | 'ai' | 'unknown' | 'none';

/**
 * Does a query word name a session by its id? A PREFIX of at least four hex
 * characters (hyphens allowed), never a substring: the id is searchable so
 * the one a terminal status line shows can be typed in, and people type it
 * from the start. A substring rule would make `de` or `cafe` match nearly
 * every session on the machine through its id, regardless of content.
 *
 * ONE rule for the Sessions tab's search and for `codev session <id>`: it
 * lives here because this file is the only one both can import.
 */
export const matchesSessionId = (
  sessionId: string,
  wordLower: string,
): boolean =>
  wordLower.length >= 4 &&
  /^[0-9a-f-]+$/.test(wordLower) &&
  sessionId.toLowerCase().startsWith(wordLower);

/** `Title (full-id)` on one line — what to hand another session or a person. */
export const formatReference = (title: string, sessionId: string): string => {
  const t = title.replace(/\s+/g, ' ').trim();
  return t ? `${t} (${sessionId})` : sessionId;
};

export interface SessionIdentity {
  title: string;
  titleKind: TitleKind;
  sessionId: string;
  /** Account label. */
  account: string;
  projectPath: string;
  /** null when no account has the transcript any more. */
  transcriptPath: string | null;
  /** See `TranscriptLocation.outsideProjectSlug`. */
  transcriptOutsideProjectSlug: boolean;
  /** `cd <project> && … claude --resume <id>`; '' when the id is not usable. */
  resumeCommand: string;
  reference: string;
}

/** The copyable fields, in display order — one list for the menu, the detail view and the CLI. */
export type IdentityFieldKey =
  | 'title'
  | 'sessionId'
  | 'transcriptPath'
  | 'projectPath'
  | 'resumeCommand'
  | 'reference';

export const IDENTITY_FIELDS: { key: IdentityFieldKey; label: string }[] = [
  { key: 'title', label: 'Title' },
  { key: 'sessionId', label: 'Session ID' },
  { key: 'transcriptPath', label: 'Transcript path' },
  { key: 'projectPath', label: 'Project path' },
  { key: 'resumeCommand', label: 'Resume command' },
  { key: 'reference', label: 'Reference' },
];

export const identityFieldValue = (
  identity: SessionIdentity,
  key: IdentityFieldKey,
): string => identity[key] ?? '';
