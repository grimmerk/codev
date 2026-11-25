/**
 * The impure half of the switch timing log (see switch-timing.ts for what
 * is measured and why): start a collector when a switch's IPC arrives, and
 * when the switch is over, sample the machine and append one JSON line to
 * `~/.config/codev/switch-timing.jsonl`, beside the marks and lists stores.
 * The line names the session (id, title, account, project path, pid, tty),
 * so the file and its rotated copy are kept owner-only. A title can be a
 * summary of the conversation that Claude Code generated; the prompts and
 * the transcript text themselves are not written.
 *
 * What this costs in the main process, all of it synchronous and none of
 * it a spawn or a disk access: when the IPC arrives, one `os.cpus()`, one
 * `process.cpuUsage()` and two clock reads; a clock read per mark along the
 * way; and when the record closes — in the callback of the command's exit,
 * or as `openSession` settles — one more `os.cpus()`, one `os.loadavg()`
 * and one `process.cpuUsage()`. Everything that spawns or
 * touches the disk — `sysctl` for memory pressure, a `ps` for the tty when
 * the last live-sessions report did not have it, another `ps` for the
 * busiest processes after a slow, timed-out or killed switch, the append
 * itself —
 * runs after the switch has finished, and a failure in any of it is
 * dropped: the switch has already happened.
 *
 * No Electron imports, so the whole path runs under vitest.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parseMemoryPressure } from './live-sessions';
import { getListingStats } from './terminal-detect';
import {
  buildSwitchRecord,
  cpuPercentBetween,
  createSwitchTiming,
  isSlowSwitch,
  parseTopCpu,
  parseTty,
  pidOrNull,
  sanitizeStamp,
  shouldRotate,
  stepDurations,
  SWITCH_LOG_MAX_BYTES,
  SwitchContext,
  SwitchSnapshot,
  SwitchSystemSample,
  SwitchTiming,
} from './switch-timing';

export const SWITCH_LOG_FILENAME = 'switch-timing.jsonl';

export const defaultSwitchLogPath = (): string =>
  path.join(os.homedir(), '.config', 'codev', SWITCH_LOG_FILENAME);

// --- the running-process count the app already has ---

// The Sessions tab asks main for a live-sessions report (a `ps`) each time
// the window opens. Remembering that report's size gives every switch a
// process count without a `ps` of its own; the age says how stale it is.
// The same report lists each process's tty, which saves the record a `ps`
// for the session it switched to.
let lastLive: { count: number; at: number; ttys: Map<number, string> } | null = null;

export const noteLiveReport = (
  report:
    | { live?: { pid?: number; tty?: string | null }[]; measuredAt?: number }
    | null
    | undefined,
): void => {
  try {
    if (report && Array.isArray(report.live)) {
      const ttys = new Map<number, string>();
      for (const p of report.live) {
        if (p && typeof p.pid === 'number' && typeof p.tty === 'string' && p.tty) {
          ttys.set(p.pid, p.tty);
        }
      }
      lastLive = { count: report.live.length, at: Date.now(), ttys };
    }
  } catch {
    // Not worth a failed report.
  }
};

/** For tests. */
export const resetLiveReportNote = (): void => {
  lastLive = null;
};

// --- append with rotation ---

/**
 * Owner-only, whatever the file was created as. A missing file is fine:
 * there is nothing to fix. Any other failure is returned as false — the
 * file exists and could not be made owner-only.
 */
const makeOwnerOnly = async (filePath: string): Promise<boolean> => {
  try {
    await fs.promises.chmod(filePath, 0o600);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
};

/**
 * Append one line, moving the file to `<file>.1` first when the line would
 * take it past the cap. One old file is kept; the one before it is replaced.
 *
 * Both files are set to 0600 on every append, not only when created: the
 * `mode` of an append applies to a new file only, so a log that an earlier
 * build (or anything else) left group- or world-readable would stay so, and
 * rotation would carry that mode over to `.1`.
 *
 * If the log exists and cannot be made owner-only, this throws and the
 * line is not written: a record names a session, and the rule is that it
 * goes into an owner-only file or nowhere. (A `.1` that cannot be fixed
 * does not stop the append: nothing is being written to it.)
 */
export const appendSwitchLogLine = async (
  filePath: string,
  line: string,
  maxBytes: number = SWITCH_LOG_MAX_BYTES,
): Promise<void> => {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  let size = 0;
  try {
    size = (await fs.promises.stat(filePath)).size;
  } catch {
    // No file yet.
  }
  const data = line.endsWith('\n') ? line : `${line}\n`;
  // Before the rename, so the rotated file is already owner-only.
  if (!(await makeOwnerOnly(filePath))) {
    throw new Error('switch timing log is not owner-only and could not be made so');
  }
  if (shouldRotate(size, Buffer.byteLength(data), maxBytes)) {
    await fs.promises.rename(filePath, `${filePath}.1`);
  }
  // A `.1` this append did not just create may predate the rule.
  await makeOwnerOnly(`${filePath}.1`);
  // Owner-only when created, like the marks and lists stores beside it.
  await fs.promises.appendFile(filePath, data, { encoding: 'utf-8', mode: 0o600 });
};

// One append at a time: two switches finishing together must not both
// decide to rotate, or the second rename would replace the file the first
// had just kept.
let appendQueue: Promise<void> = Promise.resolve();

const run = (cmd: string, args: string[], timeoutMs: number): Promise<string> =>
  new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (_err, stdout) => resolve(typeof stdout === 'string' ? stdout : ''),
      );
    } catch {
      resolve('');
    }
  });

export interface SwitchLogDeps {
  filePath?: string;
  /** `sysctl -n vm.swapusage kern.memorystatus_vm_pressure_level`; empty on failure. */
  sysctl?: () => Promise<string>;
  /** `ps -A -o %cpu=,comm=`; empty on failure. */
  psTop?: () => Promise<string>;
  /** `ps -o tty= -p <pid>`; empty on failure. */
  psTty?: (pid: number) => Promise<string>;
  /** The process-listing counters of terminal detection. For tests. */
  listings?: () => SwitchSystemSample['listings'];
  maxBytes?: number;
  /** How long to wait for a command that never reports its exit. For tests. */
  deadlineMs?: number;
  /** Called after the line is written (or dropped). For tests. */
  onWritten?: (record: Record<string, unknown> | null) => void;
}

/**
 * Begin timing one switch. Call it when the IPC arrives; pass the result
 * down the switch path and `settle()` it when `openSession` settles.
 * Returns `undefined` when anything at all goes wrong setting up — every
 * caller uses `timing?.…`, so the switch then runs untimed.
 */
export const startSwitchTiming = (
  session: Omit<SwitchContext, 'ts'>,
  rawStamp: unknown,
  deps: SwitchLogDeps = {},
): SwitchTiming | undefined => {
  try {
    // The clock first: everything below, the CPU snapshots included, is
    // part of what main spends on a switch and belongs inside `main`.
    const origin = performance.now();
    const ipc = {
      wallMs: Date.now(),
      perfEpochMs: performance.timeOrigin + origin,
    };
    const stamp = sanitizeStamp(rawStamp);
    const cpusBefore = os.cpus();
    const cpuUsageBefore = process.cpuUsage();
    const ctx: SwitchContext = { ...session, ts: new Date(ipc.wallMs).toISOString() };
    const pid = pidOrNull(session.pid);

    const onFinish = (snap: SwitchSnapshot) => {
      // The samples that describe the span are taken at its end, at once;
      // the rest waits for the event loop to be free of the switch.
      // One reference to the live report: the count, its age and (in the
      // deferred write) the tty must all come from the same report, and a
      // newer one may replace `lastLive` before that write runs.
      const live = lastLive;
      let sys: SwitchSystemSample = {};
      try {
        sys = {
          loadavg: os.loadavg(),
          cpuPct: cpuPercentBetween(cpusBefore, os.cpus()),
          ncpu: cpusBefore.length,
          mainCpuMicros: process.cpuUsage(cpuUsageBefore),
          claudeProcs: live ? live.count : null,
          liveAgeMs: live ? Date.now() - live.at : null,
        };
      } catch {
        // A record without system figures is still a record.
      }
      setImmediate(() => {
        void writeRecord(snap, sys, live).catch(() => deps.onWritten?.(null));
      });
    };

    const writeRecord = async (
      snap: SwitchSnapshot,
      sys: SwitchSystemSample,
      live: typeof lastLive,
    ) => {
      const ms = stepDurations(snap, stamp, ipc);
      const sysctl =
        deps.sysctl ??
        (() =>
          run('sysctl', ['-n', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level'], 2000));
      const psTop = deps.psTop ?? (() => run('ps', ['-A', '-o', '%cpu=,comm='], 3000));
      // The tty that live-sessions report gave this pid, when it has one;
      // otherwise one `ps`, here, after the switch.
      const knownTty = pid !== null ? live?.ttys.get(pid) ?? null : null;
      const psTty =
        deps.psTty ??
        ((p: number) => run('ps', ['-o', 'tty=', '-p', String(p)], 1000));
      const [sysctlOut, psOut, ttyOut] = await Promise.all([
        sysctl().catch(() => ''),
        isSlowSwitch(ms, snap.timedOut || snap.killed === true) ? psTop().catch(() => '') : Promise.resolve(null),
        pid !== null && !knownTty ? psTty(pid).catch(() => '') : Promise.resolve(null),
      ]);
      const tty = knownTty ?? parseTty(ttyOut);
      // In-memory counters, read as the record is built: no spawn, no disk.
      let listings: SwitchSystemSample['listings'] = null;
      try {
        listings = (deps.listings ?? getListingStats)() ?? null;
      } catch {
        // A record without them is still a record.
      }
      const full: SwitchSystemSample = {
        ...sys,
        tty,
        ttySrc: tty ? (knownTty ? 'live-report' : 'ps') : null,
        memory: parseMemoryPressure(sysctlOut),
        listings,
        ...(psOut !== null ? { top: parseTopCpu(psOut) } : {}),
      };
      const record = buildSwitchRecord(ctx, stamp, snap, ms, full);
      const line = JSON.stringify(record);
      const filePath = deps.filePath ?? defaultSwitchLogPath();
      const next = appendQueue.then(() =>
        appendSwitchLogLine(filePath, line, deps.maxBytes),
      );
      appendQueue = next.catch(() => undefined);
      await next;
      deps.onWritten?.(record);
    };

    return createSwitchTiming({
      now: () => performance.now(),
      origin,
      onFinish,
      deadlineMs: deps.deadlineMs,
    });
  } catch {
    return undefined;
  }
};
