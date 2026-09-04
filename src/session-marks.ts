/**
 * Pin / hide marks for Claude Code sessions (session-finding Batch 1 PR-2,
 * docs/session-finding-plan.md §4.4).
 *
 * Single cross-account store at ~/.config/codev/session-marks.json (the same
 * directory as the accounts registry), pushed to the renderer via fs.watch —
 * the same pattern as the status files. sessionIds are stable across resumes
 * (`--resume`/`--continue` reuse the id); `--fork-session` and `/branch` mint
 * a new one, which is why pins drift across a branch (issue #142) — plain
 * sessionId keying stays, and the drift is a display problem, not a store one.
 *
 * Pure helpers (normalize / with* transitions) are separated from fs wrappers
 * so they are unit-testable; fs functions take an explicit file path with
 * default-path wrappers for the app (same layout as share-manager.ts). The
 * authority invariant, atomic write and directory watch are shared with the
 * saved-lists store — see `atomic-json-store.ts` for why they must be one.
 */

import * as os from 'os';
import * as path from 'path';

import {
  isAuthoritativeRead as isAuthoritativeStoreRead,
  mutateStoreFile,
  readStoreResult,
  watchStoreFile,
  writeStoreFile,
} from './atomic-json-store';

export interface PinInfo {
  pinnedAt: string; // ISO timestamp
  cwd: string;
  accountLabel?: string;
  group: string | null; // reserved for v2 named groups
}

export interface SessionMarks {
  version: 1;
  pins: Record<string, PinInfo>;
  hidden: string[];
}

export const emptyMarks = (): SessionMarks => ({
  version: 1,
  pins: {},
  hidden: [],
});

/** Coerce unknown JSON into a valid SessionMarks (drops malformed entries). */
export const normalizeMarks = (raw: unknown): SessionMarks => {
  const marks = emptyMarks();
  if (!raw || typeof raw !== 'object') return marks;
  const obj = raw as Record<string, unknown>;
  const pins = obj.pins;
  if (pins && typeof pins === 'object' && !Array.isArray(pins)) {
    for (const [id, info] of Object.entries(pins as Record<string, unknown>)) {
      if (!id || !info || typeof info !== 'object') continue;
      const p = info as Record<string, unknown>;
      marks.pins[id] = {
        pinnedAt:
          typeof p.pinnedAt === 'string'
            ? p.pinnedAt
            : new Date(0).toISOString(),
        cwd: typeof p.cwd === 'string' ? p.cwd : '',
        accountLabel:
          typeof p.accountLabel === 'string' ? p.accountLabel : undefined,
        group: typeof p.group === 'string' ? p.group : null,
      };
    }
  }
  if (Array.isArray(obj.hidden)) {
    marks.hidden = [
      ...new Set(
        obj.hidden.filter(
          (x: unknown): x is string => typeof x === 'string' && x.length > 0,
        ),
      ),
    ];
  }
  return marks;
};

// Pin and hide are mutually exclusive: pinning unhides, hiding unpins —
// a pinned-but-hidden session has no sensible rendering.

export const withPin = (
  marks: SessionMarks,
  sessionId: string,
  info: { pinnedAt: string; cwd: string; accountLabel?: string },
): SessionMarks => ({
  version: 1,
  pins: {
    ...marks.pins,
    [sessionId]: {
      pinnedAt: info.pinnedAt,
      cwd: info.cwd,
      accountLabel: info.accountLabel,
      group: null,
    },
  },
  hidden: marks.hidden.filter((id) => id !== sessionId),
});

export const withoutPin = (
  marks: SessionMarks,
  sessionId: string,
): SessionMarks => {
  const pins = { ...marks.pins };
  delete pins[sessionId];
  return { version: 1, pins, hidden: [...marks.hidden] };
};

export const withHidden = (
  marks: SessionMarks,
  sessionId: string,
): SessionMarks => {
  const pins = { ...marks.pins };
  delete pins[sessionId];
  return {
    version: 1,
    pins,
    hidden: marks.hidden.includes(sessionId)
      ? [...marks.hidden]
      : [...marks.hidden, sessionId],
  };
};

export const withoutHidden = (
  marks: SessionMarks,
  sessionId: string,
): SessionMarks => ({
  version: 1,
  pins: { ...marks.pins },
  hidden: marks.hidden.filter((id) => id !== sessionId),
});

// --- fs layer (path-based, testable; default-path wrappers below) ---

const MARKS_FILENAME = 'session-marks.json';

/**
 * A read plus whether its result is authoritative.
 *
 * `known: false` means the pin set is UNKNOWN, not empty. Callers that act on
 * emptiness — clearing a stored browse preference, broadcasting a change —
 * must not act on an unknown read, or a transient filesystem failure destroys
 * user state that is still perfectly intact on disk.
 */
export interface MarksRead {
  marks: SessionMarks;
  known: boolean;
}

/**
 * Is a parsed value a marks store we may treat as AUTHORITATIVE? The rule —
 * normalization must be a no-op — is the shared store's; kept as a named
 * export because the tests exercise it against `normalizeMarks` directly.
 */
export const isAuthoritativeRead = (
  raw: unknown,
  marks: SessionMarks,
): boolean => isAuthoritativeStoreRead(raw, marks);

export const readMarksFileResult = (filePath: string): MarksRead => {
  const read = readStoreResult(filePath, normalizeMarks, emptyMarks);
  return { marks: read.value, known: read.known };
};

export const readMarksFile = (filePath: string): SessionMarks =>
  readMarksFileResult(filePath).marks;

export const writeMarksFile = (filePath: string, marks: SessionMarks): void =>
  writeStoreFile(filePath, marks);

const defaultMarksPath = (): string =>
  path.join(os.homedir(), '.config', 'codev', MARKS_FILENAME);

export const readSessionMarks = (): SessionMarks =>
  readMarksFile(defaultMarksPath());

export const readSessionMarksResult = (): MarksRead =>
  readMarksFileResult(defaultMarksPath());

/**
 * Read-modify-write that REFUSES to write when the store could not be read —
 * one keystroke against an unreadable store would otherwise erase every other
 * pin and hidden id on disk. Collapsing the four callers onto this one path is
 * deliberate: four copies of read-modify-write are four chances to forget the
 * guard.
 */
export const mutateMarksFile = (
  filePath: string,
  mutate: (marks: SessionMarks) => SessionMarks,
): MarksRead => {
  const read = mutateStoreFile(filePath, normalizeMarks, emptyMarks, mutate);
  return { marks: read.value, known: read.known };
};

export const mutateSessionMarks = (
  mutate: (marks: SessionMarks) => SessionMarks,
): MarksRead => mutateMarksFile(defaultMarksPath(), mutate);

export const writeSessionMarks = (marks: SessionMarks): void =>
  writeMarksFile(defaultMarksPath(), marks);

/** Watch a marks file for changes (path-based, testable). */
export const watchMarksFile = (
  filePath: string,
  onChange: (marks: SessionMarks) => void,
  onError?: (err: Error) => void,
): (() => void) =>
  watchStoreFile(
    filePath,
    (p) => readStoreResult(p, normalizeMarks, emptyMarks),
    onChange,
    onError,
  );

export const watchSessionMarks = (
  onChange: (marks: SessionMarks) => void,
  onError?: (err: Error) => void,
): (() => void) => watchMarksFile(defaultMarksPath(), onChange, onError);
