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

export const readMarksFile = (filePath: string): SessionMarks => {
  try {
    return normalizeMarks(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return emptyMarks();
  }
};

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

export const writeSessionMarks = (marks: SessionMarks): void =>
  writeMarksFile(defaultMarksPath(), marks);

/**
 * Watch the marks file for changes. Watches the parent DIRECTORY: the
 * rename-based write replaces the file inode, which would detach a plain
 * file watcher. Events for other files in ~/.config/codev (accounts.json,
 * our own .tmp) are filtered out by name.
 */
export const watchSessionMarks = (
  onChange: (marks: SessionMarks) => void,
): (() => void) => {
  const filePath = defaultMarksPath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Debounce: fs.watch on macOS fires several times per change
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
    if (filename && filename !== MARKS_FILENAME) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      onChange(readMarksFile(filePath));
    }, 50);
  });

  watcher.on('error', () => {
    // Swallow watcher errors (dir deleted, permissions changed, OS watcher
    // limits) — an unhandled 'error' event would crash the main process.
    // The next app restart recovers the watch.
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };
};
