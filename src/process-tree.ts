/**
 * Which terminal app is a process running in? The pure half: parse ONE
 * process listing into a table, then walk a pid's parent chain in memory.
 *
 * The walk used to cost two `ps` spawns per level (6–8 from `claude` up to
 * the terminal), and on a loaded machine it is the spawns that are slow.
 * One listing answers for every pid at once; `terminal-detect.ts` runs it.
 *
 * No child processes, no fs, no Electron: everything here runs under vitest.
 */

/** One row of `ps -axo pid=,ppid=,lstart=,comm=` (run with TZ=UTC, LC_ALL=C). */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Start time as `lstart` prints it, runs of spaces squashed to one. */
  start: string;
  /** The executable. On macOS a full path, which can contain spaces. */
  comm: string;
}

export type ProcessTable = Map<number, ProcessRow>;

export const squashSpaces = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Parse `ps -axo pid=,ppid=,lstart=,comm=`. `lstart` is five fields
 * (`Tue Nov  3 07:06:18 2026`) and `comm` is the rest of the line, spaces
 * included. A line of any other shape is skipped.
 */
export const parseProcessTable = (out: string | null | undefined): ProcessTable => {
  const table: ProcessTable = new Map();
  for (const line of (out || '').split('\n')) {
    const m =
      /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    table.set(pid, {
      pid,
      ppid: Number(m[2]),
      start: squashSpaces(m[3]),
      comm: m[4],
    });
  }
  return table;
};

/** Parse `ps -o pid=,command= -p <pids>`: pid, then the full command line. */
export const parseCommandLines = (out: string | null | undefined): Map<number, string> => {
  const lines = new Map<number, string>();
  for (const line of (out || '').split('\n')) {
    const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
    if (m) lines.set(Number(m[1]), m[2]);
  }
  return lines;
};

/** Far beyond any real chain; the visited set is what stops a loop. */
export const MAX_WALK_HOPS = 64;

export interface WalkResult {
  /** 'codev' | 'iterm2' | 'cmux' | 'ghostty' | 'terminal' | 'unknown' */
  terminal: string;
  /** Processes looked at, the starting one included. */
  hops: number;
  /**
   * Set when the walk stopped at an Electron process whose full command
   * line it was not given: the caller fetches it and walks again. (Only an
   * Electron ancestor needs one, to tell CodeV's dev build from another
   * Electron app, so the common chain never asks.)
   */
  needCmdline?: number;
}

/**
 * Walk from `pid` up its parents and name the first terminal app met. The
 * rules, and their order, are those of the per-level `ps` walk this
 * replaces: codev, an Electron whose command line names codev, iTerm,
 * cmux, Ghostty, Terminal.app. It stops, with 'unknown', at a process that
 * is not in the table (it exited, or its parent did), at a parent of 0 or
 * 1, and at a pid it has already visited.
 */
export const walkToTerminal = (
  table: ProcessTable,
  pid: number,
  cmdlines: ReadonlyMap<number, string> = new Map(),
): WalkResult => {
  const seen = new Set<number>();
  let current = pid;
  let hops = 0;
  while (hops < MAX_WALK_HOPS) {
    if (seen.has(current)) break; // a cycle: pids were reused mid-listing
    seen.add(current);
    const row = table.get(current);
    if (!row || !row.comm) break;
    hops++;

    const comm = row.comm.toLowerCase();
    // CodeV's embedded terminal (node-pty runs under Electron)
    if (comm.includes('codev')) return { terminal: 'codev', hops };
    // An Electron process is CodeV when its command line says so
    if (comm.includes('electron')) {
      const cmdline = cmdlines.get(current);
      if (cmdline === undefined) {
        return { terminal: 'unknown', hops, needCmdline: current };
      }
      if (cmdline.toLowerCase().includes('codev')) return { terminal: 'codev', hops };
    }
    if (comm.includes('iterm')) return { terminal: 'iterm2', hops };
    if (comm.includes('cmux')) return { terminal: 'cmux', hops };
    if (comm.includes('ghostty')) return { terminal: 'ghostty', hops };
    if (comm.includes('terminal.app') || comm === 'terminal') {
      return { terminal: 'terminal', hops };
    }

    if (!row.ppid || row.ppid <= 1) break;
    current = row.ppid;
  }
  return { terminal: 'unknown', hops };
};
