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
 */
export type TitleKind = 'custom' | 'ai' | 'none';

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
