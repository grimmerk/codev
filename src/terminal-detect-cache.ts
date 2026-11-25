/**
 * Remembers which terminal app a process runs in, so that a switch does not
 * walk the process tree again for an answer the Sessions list already has.
 *
 * A pid alone is not a safe key: pids are reused, and a new process under an
 * old pid may sit in another terminal. An entry is therefore stored with the
 * process's START TIME and is returned only to a caller that states the
 * same start time for the pid now. A caller that cannot state one gets
 * nothing, and detects as before.
 *
 * Pure: no fs, no child processes. `terminal-detect.ts` supplies the start
 * times (from the process listing when storing, from the session's
 * registration file when reading).
 */
import { squashSpaces } from './process-tree';

export const UNKNOWN_TERMINAL = 'unknown';

/** Far more than the sessions one machine runs; the oldest entry goes first. */
export const TERMINAL_CACHE_MAX = 512;

export interface TerminalCache {
  /**
   * The terminal remembered for `pid`, when `currentStart` — the start time
   * of the process holding that pid NOW — equals the one stored. Null on
   * any doubt: no entry, no start time given, or a different one.
   */
  get(pid: number, currentStart: string | null | undefined): string | null;
  /** Remember a detection. 'unknown', an empty start or a bad pid is ignored. */
  put(pid: number, start: string | null | undefined, terminal: string): void;
  clear(): void;
  size(): number;
}

const validPid = (pid: unknown): pid is number =>
  typeof pid === 'number' && Number.isInteger(pid) && pid > 1;

export const createTerminalCache = (max: number = TERMINAL_CACHE_MAX): TerminalCache => {
  const entries = new Map<number, { start: string; terminal: string }>();
  return {
    get: (pid, currentStart) => {
      if (!validPid(pid) || typeof currentStart !== 'string') return null;
      const now = squashSpaces(currentStart);
      const entry = entries.get(pid);
      if (!entry || !now || entry.start !== now) return null;
      return entry.terminal;
    },
    put: (pid, start, terminal) => {
      if (!validPid(pid) || typeof start !== 'string') return;
      const s = squashSpaces(start);
      // A failed detection is not an answer: caching it would turn one slow
      // moment into a wrong terminal for the life of the process.
      if (!s || !terminal || terminal === UNKNOWN_TERMINAL) return;
      entries.delete(pid); // re-insert, so the entry counts as the newest
      entries.set(pid, { start: s, terminal });
      while (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    clear: () => entries.clear(),
    size: () => entries.size,
  };
};
