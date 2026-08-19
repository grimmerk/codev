/**
 * Pin / hide marks for Claude Code sessions (session-finding Batch 1 PR-2,
 * docs/session-finding-plan.md §4.4).
 *
 * Single cross-account store at ~/.config/codev/session-marks.json (the same
 * directory as the accounts registry), pushed to the renderer via fs.watch —
 * the same pattern as the status files. sessionIds are stable across resumes
 * (verified: `--resume`/`--continue` reuse the id; only `--fork-session`
 * creates a new one), so plain sessionId keying needs no migration logic.
 *
 * Pure helpers (normalize / with* transitions) are separated from fs wrappers
 * so they are unit-testable; fs functions take an explicit file path with
 * default-path wrappers for the app (same layout as share-manager.ts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

/** The only store version this build understands. */
const SUPPORTED_VERSION = 1;

/**
 * Does a parsed value look like a store we understand?
 *
 * `normalizeMarks` is deliberately forgiving — it coerces anything into valid
 * v1 marks so a partly-corrupt store still renders. That is right for display
 * and wrong for authority: without this check a `[]`, a `pins: []`, or a
 * version-2 file written by a future build would parse, normalize to empty,
 * be declared authoritative, and then be OVERWRITTEN by the next pin. Rejecting
 * an unsupported version matters most — that is the case where the data is
 * perfectly good and only this build is too old to read it.
 */
export const isKnownMarksShape = (raw: unknown): boolean => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const o = raw as Record<string, unknown>;
  if (o.version !== undefined && o.version !== SUPPORTED_VERSION) return false;
  if (
    o.pins !== undefined &&
    (typeof o.pins !== 'object' || o.pins === null || Array.isArray(o.pins))
  ) {
    return false;
  }
  if (o.hidden !== undefined && !Array.isArray(o.hidden)) return false;
  return true;
};

export const readMarksFileResult = (filePath: string): MarksRead => {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return { marks: normalizeMarks(raw), known: isKnownMarksShape(raw) };
  } catch (err) {
    // A missing file IS authoritative: no store yet means no marks yet, which
    // is simply the first run. Anything else — permissions, IO, malformed
    // JSON — leaves the real contents unknown.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { marks: emptyMarks(), known: code === 'ENOENT' };
  }
};

export const readMarksFile = (filePath: string): SessionMarks =>
  readMarksFileResult(filePath).marks;

export const writeMarksFile = (filePath: string, marks: SessionMarks): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // temp + rename so a crash mid-write can't corrupt the store
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(marks, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
};

const defaultMarksPath = (): string =>
  path.join(os.homedir(), '.config', 'codev', MARKS_FILENAME);

export const readSessionMarks = (): SessionMarks =>
  readMarksFile(defaultMarksPath());

export const readSessionMarksResult = (): MarksRead =>
  readMarksFileResult(defaultMarksPath());

/**
 * Read-modify-write that REFUSES to write when the store could not be read.
 *
 * Every mutation here is read-modify-write over the whole file, so a read that
 * silently degrades to empty marks turns the next pin or hide into a full
 * overwrite: one keystroke against an unreadable store would erase every other
 * pin and hidden id on disk. A missing file is still fine — ENOENT is
 * authoritative (see MarksRead), so the first-ever pin creates the store as
 * usual.
 *
 * Returns the resulting marks with `known: true` when the write happened, or
 * the unknown read (`known: false`) when it was refused and nothing was
 * touched. Collapsing the four callers onto this one path is deliberate: four
 * copies of read-modify-write are four chances to forget the guard.
 */
export const mutateMarksFile = (
  filePath: string,
  mutate: (marks: SessionMarks) => SessionMarks,
): MarksRead => {
  const read = readMarksFileResult(filePath);
  if (!read.known) return read;
  const next = mutate(read.marks);
  writeMarksFile(filePath, next);
  return { marks: next, known: true };
};

export const mutateSessionMarks = (
  mutate: (marks: SessionMarks) => SessionMarks,
): MarksRead => mutateMarksFile(defaultMarksPath(), mutate);

export const writeSessionMarks = (marks: SessionMarks): void =>
  writeMarksFile(defaultMarksPath(), marks);

/**
 * Watch a marks file for changes (path-based, testable). Watches the parent
 * DIRECTORY: the rename-based write replaces the file inode, which would
 * detach a plain file watcher. Events for sibling files (accounts.json, our
 * own .tmp) are filtered out by name.
 */
export const watchMarksFile = (
  filePath: string,
  onChange: (marks: SessionMarks) => void,
  onError?: (err: Error) => void,
): (() => void) => {
  const dir = path.dirname(filePath);
  const filename = path.basename(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Debounce: fs.watch on macOS fires several times per change
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = fs.watch(dir, { persistent: false }, (_event, changed) => {
    if (changed && changed !== filename) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const read = readMarksFileResult(filePath);
      // Never broadcast an unknown read. Announcing "the marks are now empty"
      // because the file could not be parsed would push every listener into
      // acting on state that is still intact on disk; staying silent leaves
      // them on the last thing actually seen.
      if (!read.known) return;
      onChange(read.marks);
    }, 50);
  });

  watcher.on('error', (err: Error) => {
    // A dead watcher must not crash the main process (unhandled 'error'
    // would) — close it and let the owner decide whether to recreate.
    try {
      watcher.close();
    } catch {}
    if (debounceTimer) clearTimeout(debounceTimer);
    onError?.(err);
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };
};

export const watchSessionMarks = (
  onChange: (marks: SessionMarks) => void,
  onError?: (err: Error) => void,
): (() => void) => watchMarksFile(defaultMarksPath(), onChange, onError);
