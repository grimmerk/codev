/**
 * Which terminal app does a running session sit in? The impure half:
 *
 * - `detectTerminals(pids)` — ONE `ps` listing for any number of pids
 *   (process-tree.ts parses and walks it), where the walk used to spawn two
 *   `ps` per level per pid. Every answer it finds is remembered. One more
 *   `ps` (a command-line lookup) runs only when an ancestor is an Electron
 *   process whose path does not already identify CodeV.
 * - `resolveSwitchTerminal(pid)` — what a switch calls: the remembered
 *   answer when it can be proved to belong to the process holding the pid
 *   now, otherwise a detection as above.
 *
 * Nothing here throws or rejects. A listing that fails or times out gives
 * 'unknown', exactly as the old walk did, and the caller falls back to the
 * configured terminal.
 *
 * No Electron imports, so this runs under vitest.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { getScannableAccounts } from './accounts';
import {
  parseCommandLines,
  parseProcessTable,
  walkToTerminal,
} from './process-tree';
import {
  createTerminalCache,
  TerminalCache,
  UNKNOWN_TERMINAL,
} from './terminal-detect-cache';

/** The old walk gave each `ps` 2 s; the one listing gets the same. */
export const DETECT_PS_TIMEOUT_MS = 2000;

/** An Electron inside an Electron is already unusual; this only bounds the loop. */
const MAX_CMDLINE_ROUNDS = 3;

const run = (args: string[]): Promise<string> =>
  new Promise((resolve) => {
    try {
      execFile(
        'ps',
        args,
        {
          encoding: 'utf-8',
          timeout: DETECT_PS_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          // `lstart` in the form a session registration's `procStart` has:
          // UTC, in the C locale.
          env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
        },
        // A listing cut short by the timeout is not a listing.
        (err, stdout) => resolve(err || typeof stdout !== 'string' ? '' : stdout),
      );
    } catch {
      resolve('');
    }
  });

/**
 * The start time that Claude Code registered for the process holding `pid`
 * (`sessions/<pid>.json`, field `procStart`), read from every account. It
 * costs a small file read per account and no spawn.
 *
 * Null unless the answer is beyond doubt: at least one account has the
 * file, and EVERY file found names this pid and states the same start. An
 * older Claude Code writes no `procStart`, and a leftover file of an
 * earlier process under the same pid (in another account) would disagree:
 * both give null, and the caller detects instead of trusting the cache.
 */
export const readRegisteredStart = (
  pid: number,
  accountDirs: string[] = getScannableAccounts().map((a) => a.dir),
): string | null => {
  let start: string | null = null;
  for (const dir of accountDirs) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, 'sessions', `${pid}.json`), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      return null;
    }
    let data: { pid?: unknown; procStart?: unknown };
    try {
      data = JSON.parse(text);
    } catch {
      return null;
    }
    if (data?.pid !== pid || typeof data.procStart !== 'string' || !data.procStart.trim()) {
      return null;
    }
    const s = data.procStart.replace(/\s+/g, ' ').trim();
    if (start !== null && start !== s) return null;
    start = s;
  }
  return start;
};

export interface DetectDeps {
  /** `ps -axo pid=,ppid=,lstart=,comm=` under TZ=UTC LC_ALL=C; '' on failure. */
  ps?: () => Promise<string>;
  /** `ps -o pid=,command= -p <pids>`; '' on failure. */
  psCommand?: (pids: number[]) => Promise<string>;
  registeredStart?: (pid: number) => string | null;
  cache?: TerminalCache;
}

const sharedCache = createTerminalCache();

/** For tests. */
export const resetTerminalCache = (): void => sharedCache.clear();

const cachedFor = (pid: number, deps: DetectDeps): string | null => {
  try {
    const start = (deps.registeredStart ?? readRegisteredStart)(pid);
    return (deps.cache ?? sharedCache).get(pid, start);
  } catch {
    return null;
  }
};

/**
 * The terminal of each pid, from one process listing. A pid whose chain
 * names no terminal, or any pid when the listing failed, is 'unknown' —
 * except that a failed listing still answers from the cache where the
 * cache can prove its entry, so one slow moment does not blank a badge
 * the app had already worked out.
 */
export const detectTerminals = async (
  pids: number[],
  deps: DetectDeps = {},
): Promise<Map<number, string>> => {
  const result = new Map<number, string>();
  for (const pid of pids) result.set(pid, UNKNOWN_TERMINAL);
  if (pids.length === 0) return result;
  try {
    const ps = deps.ps ?? (() => run(['-axo', 'pid=,ppid=,lstart=,comm=']));
    const psCommand =
      deps.psCommand ??
      ((list: number[]) => run(['-o', 'pid=,command=', '-p', list.join(',')]));
    const table = parseProcessTable(await ps().catch(() => ''));
    if (table.size === 0) {
      for (const pid of pids) result.set(pid, cachedFor(pid, deps) ?? UNKNOWN_TERMINAL);
      return result;
    }
    // Only an Electron ancestor needs its command line (is it CodeV?), so
    // the usual chain is answered by the listing alone.
    const cmdlines = new Map<number, string>();
    for (let round = 0; round <= MAX_CMDLINE_ROUNDS; round++) {
      const need = new Set<number>();
      for (const pid of pids) {
        const walked = walkToTerminal(table, pid, cmdlines);
        result.set(pid, walked.terminal);
        if (walked.needCmdline !== undefined) need.add(walked.needCmdline);
      }
      if (need.size === 0) break;
      const fetched =
        round < MAX_CMDLINE_ROUNDS
          ? parseCommandLines(await psCommand([...need]).catch(() => ''))
          : new Map<number, string>();
      // A process that did not answer has no command line to match.
      for (const pid of need) cmdlines.set(pid, fetched.get(pid) ?? '');
    }
    const cache = deps.cache ?? sharedCache;
    for (const pid of pids) {
      cache.put(pid, table.get(pid)?.start, result.get(pid) ?? UNKNOWN_TERMINAL);
    }
  } catch {
    // Whatever was worked out so far stands; the rest stays 'unknown'.
  }
  return result;
};

/** One pid; 'unknown' when its chain names no terminal or the listing failed. */
export const detectTerminal = async (pid: number, deps: DetectDeps = {}): Promise<string> =>
  (await detectTerminals([pid], deps)).get(pid) ?? UNKNOWN_TERMINAL;

/** How a switch decided its terminal: from the cache, or from a process listing. */
export type DetectSource = 'cache' | 'ps';

/**
 * The terminal for a switch to the running process `pid`.
 *
 * The cached answer is used only when ALL of these hold; anything else
 * runs a detection (one `ps`), as a switch always did:
 * 1. an earlier detection of this pid named a terminal ('unknown' is never
 *    stored), with the process's start time from that listing;
 * 2. a session registration for this pid exists and states a start time;
 * 3. every registration found for the pid states that same start time, and
 *    it equals the stored one — so the pid has not been reused since.
 */
export const resolveSwitchTerminal = async (
  pid: number,
  deps: DetectDeps = {},
): Promise<{ terminal: string; src: DetectSource }> => {
  const cached = cachedFor(pid, deps);
  if (cached) return { terminal: cached, src: 'cache' };
  try {
    return { terminal: await detectTerminal(pid, deps), src: 'ps' };
  } catch {
    return { terminal: UNKNOWN_TERMINAL, src: 'ps' };
  }
};
