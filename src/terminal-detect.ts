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
 * configured terminal. Why it failed is counted (`getListingStats`), so
 * that how often it happens can be read from the switch timing log.
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

/** Who asked for a listing: the badges, a switch, or the same-cwd cross-reference. */
export type ListingPath = 'badge' | 'switch' | 'crossref';

/**
 * A switch waits on its listing, so it gets what each `ps` of the old walk
 * got: after 2 s the switch goes to the terminal in Settings.
 */
export const SWITCH_LISTING_TIMEOUT_MS = 2000;

/**
 * The badges and the same-cwd cross-reference are background work that
 * nobody waits on, so they can afford to wait much longer — and need to.
 * `execFile`'s timeout is a timer in THIS process: when the app's own event
 * loop is blocked for longer than the timeout, the timer fires as soon as
 * the loop runs again, although `ps` finished long before, and the callback
 * gets `killed: true` with an empty stdout. At start-up the main process is
 * busy, and with 2 s that false timeout can leave the list without badges.
 */
export const BACKGROUND_LISTING_TIMEOUT_MS = 10000;

export const listingTimeoutFor = (path: ListingPath): number =>
  path === 'switch' ? SWITCH_LISTING_TIMEOUT_MS : BACKGROUND_LISTING_TIMEOUT_MS;

/** An Electron inside an Electron is already unusual; this only bounds the loop. */
const MAX_CMDLINE_ROUNDS = 3;

/** What one `ps` gave: its stdout, and the `execFile` callback's error (null when it ran). */
export interface PsRun {
  stdout: string;
  error: { killed?: unknown; code?: unknown; signal?: unknown } | null;
}

const run = (args: string[], timeoutMs: number): Promise<PsRun> =>
  new Promise((resolve) => {
    try {
      execFile(
        'ps',
        args,
        {
          encoding: 'utf-8',
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          // `lstart` in the form a session registration's `procStart` has:
          // UTC, in the C locale.
          env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
        },
        (err, stdout) =>
          resolve({ stdout: typeof stdout === 'string' ? stdout : '', error: err ?? null }),
      );
    } catch (err) {
      resolve({ stdout: '', error: asPsError(err) });
    }
  });

const asPsError = (err: unknown): NonNullable<PsRun['error']> =>
  err && typeof err === 'object' ? (err as NonNullable<PsRun['error']>) : {};

/** An injected runner may answer with plain text; a rejection or a throw is a failed run. */
const settle = async (start: () => Promise<string | PsRun>): Promise<PsRun> => {
  try {
    const got = await start();
    if (typeof got === 'string') return { stdout: got, error: null };
    return got && typeof got === 'object' ? got : { stdout: '', error: {} };
  } catch (err) {
    return { stdout: '', error: asPsError(err) };
  }
};

/** A listing cut short, or one whose command failed, is not a listing. */
const textOf = (ran: PsRun): string =>
  ran.error || typeof ran.stdout !== 'string' ? '' : ran.stdout;

/**
 * Why a listing is unusable, or null when it is fine:
 * - `timeout` — the callback said `killed`: the timeout fired. That is also
 *   the shape of a FALSE timeout (see `BACKGROUND_LISTING_TIMEOUT_MS`), which
 *   shows as a run far longer than the timeout it was given;
 * - `error <code or signal>` — `ps` could not be started (`EAGAIN` when no
 *   process can be spawned), exited non-zero, or died on a signal; the
 *   code when there is one, else the signal;
 * - `error unknown` — an error that states neither a code nor a signal;
 * - `empty` — no error, and not one process line in the output.
 */
export const classifyListing = (error: PsRun['error'], rows: number): string | null => {
  if (error) {
    const { killed, code, signal } = error;
    // Too much output also kills the child; that is not a timeout.
    if (killed === true && code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'timeout';
    const tag = [code, signal].find(
      (v) => (typeof v === 'string' && v !== '') || typeof v === 'number',
    );
    const text = tag === undefined ? '' : String(tag).replace(/[^\w.-]/g, '').slice(0, 40);
    return `error ${text || 'unknown'}`;
  }
  return rows === 0 ? 'empty' : null;
};

export interface ListingFailure {
  reason: string;
  /** How long the listing ran, from the call to its callback, in whole ms. */
  ms: number;
  path: ListingPath;
}

/** Process listings since the app started. */
export interface ListingStats {
  /** Listings attempted. */
  n: number;
  failed: number;
  /** The latest failure; null when there has been none. */
  last: ListingFailure | null;
}

const stats: ListingStats = { n: 0, failed: 0, last: null };

/** A copy: what the switch timing log writes into each record. */
export const getListingStats = (): ListingStats => ({
  n: stats.n,
  failed: stats.failed,
  last: stats.last ? { ...stats.last } : null,
});

/** For tests. */
export const resetListingStats = (): void => {
  stats.n = 0;
  stats.failed = 0;
  stats.last = null;
};

const noteListing = (path: ListingPath, reason: string | null, ms: number): void => {
  try {
    stats.n++;
    if (reason === null) return;
    stats.failed++;
    stats.last = { reason, ms: Math.round(ms), path };
    // One short line per failure; no pid and no path of anything.
    console.warn(
      `[terminal-detect] process listing failed: ${reason}, ${Math.round(ms)} ms (${path})`,
    );
  } catch {
    // Counting must never cost a detection.
  }
};

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
 *
 * Known limit: the registration is Claude Code's record, not the process
 * table. If a process dies without its file being removed (a crash, a
 * `kill -9`) and the pid is then reused by a process that does not
 * register over it, the stale start still matches and the cache answers
 * for the dead session. The app would list that session as running either
 * way (it treats "file exists and pid is alive" as running), and a switch
 * to it goes wrong with or without the cache; proving the pid's owner here
 * would put a `ps` back on every switch, which is what this module removes.
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
  /**
   * `ps -axo pid=,ppid=,lstart=,comm=` under TZ=UTC LC_ALL=C, with the
   * timeout of the path that asked. Plain text stands for a run without an
   * error; a `PsRun` carries the callback's error.
   */
  ps?: (timeoutMs: number) => Promise<string | PsRun>;
  /** `ps -o pid=,command= -p <pids>`, with the same timeout. */
  psCommand?: (pids: number[], timeoutMs: number) => Promise<string | PsRun>;
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
 *
 * `path` says who is asking. It decides how long the listing may take
 * (`listingTimeoutFor`) and is recorded with a failure.
 */
export const detectTerminals = async (
  pids: number[],
  path: ListingPath,
  deps: DetectDeps = {},
): Promise<Map<number, string>> => {
  const result = new Map<number, string>();
  for (const pid of pids) result.set(pid, UNKNOWN_TERMINAL);
  if (pids.length === 0) return result;
  try {
    const timeoutMs = listingTimeoutFor(path);
    const ps =
      deps.ps ?? ((ms: number) => run(['-axo', 'pid=,ppid=,lstart=,comm='], ms));
    const psCommand =
      deps.psCommand ??
      ((list: number[], ms: number) => run(['-o', 'pid=,command=', '-p', list.join(',')], ms));
    const startedAt = performance.now();
    const listed = await settle(() => ps(timeoutMs));
    const table = parseProcessTable(textOf(listed));
    noteListing(path, classifyListing(listed.error, table.size), performance.now() - startedAt);
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
          ? parseCommandLines(textOf(await settle(() => psCommand([...need], timeoutMs))))
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

/**
 * One pid, for a switch (so with the switch's timeout): 'unknown' when its
 * chain names no terminal or the listing failed.
 */
export const detectTerminal = async (pid: number, deps: DetectDeps = {}): Promise<string> =>
  (await detectTerminals([pid], 'switch', deps)).get(pid) ?? UNKNOWN_TERMINAL;

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
