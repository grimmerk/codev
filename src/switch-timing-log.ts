/**
 * The impure half of the switch timing log (see switch-timing.ts for what
 * is measured and why): start a collector when a switch's IPC arrives, and
 * when the switch is over, sample the machine and append one JSON line to
 * `~/.config/codev/switch-timing.jsonl`, beside the marks and lists stores.
 *
 * On the switch's path this costs one `os.cpus()` read, one
 * `process.cpuUsage()` and a few clock reads. Everything that spawns or
 * touches the disk — `sysctl` for memory pressure, `ps` for a slow switch,
 * the append itself — runs after the switch has finished, and a failure in
 * any of it is dropped: the switch has already happened.
 *
 * No Electron imports, so the whole path runs under vitest.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { parseMemoryPressure } from './live-sessions';
import {
  buildSwitchRecord,
  cpuPercentBetween,
  createSwitchTiming,
  isSlowSwitch,
  parseTopCpu,
  sanitizeStamp,
  shouldRotate,
  stepDurations,
  SWITCH_LOG_MAX_BYTES,
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
let lastLive: { count: number; at: number } | null = null;

export const noteLiveReport = (
  report: { live?: unknown[]; measuredAt?: number } | null | undefined,
): void => {
  try {
    if (report && Array.isArray(report.live)) {
      lastLive = { count: report.live.length, at: Date.now() };
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
 * Append one line, moving the file to `<file>.1` first when the line would
 * take it past the cap. One old file is kept; the one before it is replaced.
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
  if (shouldRotate(size, Buffer.byteLength(data), maxBytes)) {
    await fs.promises.rename(filePath, `${filePath}.1`);
  }
  await fs.promises.appendFile(filePath, data, 'utf-8');
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
  maxBytes?: number;
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
  sessionId: string,
  active: boolean,
  rawStamp: unknown,
  deps: SwitchLogDeps = {},
): SwitchTiming | undefined => {
  try {
    const ipc = {
      wallMs: Date.now(),
      perfEpochMs: performance.timeOrigin + performance.now(),
    };
    const stamp = sanitizeStamp(rawStamp);
    const cpusBefore = os.cpus();
    const cpuUsageBefore = process.cpuUsage();
    const ctx = { ts: new Date(ipc.wallMs).toISOString(), sessionId, active };

    const onFinish = (snap: SwitchSnapshot) => {
      // The samples that describe the span are taken at its end, at once;
      // the rest waits for the event loop to be free of the switch.
      let sys: SwitchSystemSample = {};
      try {
        sys = {
          loadavg: os.loadavg(),
          cpuPct: cpuPercentBetween(cpusBefore, os.cpus()),
          ncpu: cpusBefore.length,
          mainCpuMicros: process.cpuUsage(cpuUsageBefore),
          claudeProcs: lastLive ? lastLive.count : null,
          liveAgeMs: lastLive ? Date.now() - lastLive.at : null,
        };
      } catch {
        // A record without system figures is still a record.
      }
      setImmediate(() => {
        void writeRecord(snap, sys).catch(() => deps.onWritten?.(null));
      });
    };

    const writeRecord = async (snap: SwitchSnapshot, sys: SwitchSystemSample) => {
      const ms = stepDurations(snap, stamp, ipc);
      const sysctl =
        deps.sysctl ??
        (() =>
          run('sysctl', ['-n', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level'], 2000));
      const psTop = deps.psTop ?? (() => run('ps', ['-A', '-o', '%cpu=,comm='], 3000));
      const [sysctlOut, psOut] = await Promise.all([
        sysctl().catch(() => ''),
        isSlowSwitch(ms) ? psTop().catch(() => '') : Promise.resolve(null),
      ]);
      const full: SwitchSystemSample = {
        ...sys,
        memory: parseMemoryPressure(sysctlOut),
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

    return createSwitchTiming({ now: () => performance.now(), onFinish });
  } catch {
    return undefined;
  }
};
