/**
 * Where does a session switch spend its time? One record per switch, from
 * the click in the renderer to the terminal's script exiting, so the cost of
 * CodeV's own code can be told apart from the cost of `osascript` and of a
 * loaded machine before anything is rewritten for speed.
 *
 * This file is the pure half: the collector that the switch path marks as
 * it goes, and the arithmetic that turns marks and samples into a record.
 * No Electron, no fs, no child processes — `switch-timing-log.ts` does the
 * reading and writing, after the switch.
 *
 * Two rules the callers rely on:
 *
 * - **Nothing here throws into a switch.** Every collector method swallows
 *   its own errors, and every call site uses `timing?.…`, so a switch with
 *   no collector, or with a broken one, runs exactly as it did before.
 * - **A record holds timings and counts, never content**: no title, prompt
 *   or path. The only trace of the session is the first 8 characters of its
 *   id, enough to tell two switches to one session from two sessions.
 */

/** Points on the path, in the order a terminal switch passes them. */
export type SwitchMark =
  /** Main read its two settings (terminal app, tab/window). */
  | 'settings'
  /** `detectTerminalApp` answered (running sessions only). */
  | 'detect'
  /** The AppleScript text (or the command line) is built. */
  | 'script'
  /** `openSession` returned to the IPC handler. */
  | 'returned';

/**
 * Which key found the tab. `none` — the script ran and matched nothing;
 * `null` on a record — the path cannot say (see `branchFromSwitchOutput`).
 */
export type SwitchBranch =
  | 'tty'
  | 'title'
  | 'cwd'
  | 'project-name'
  | 'none'
  | 'new-tab'
  | 'new-window'
  | 'new-workspace'
  | 'embedded'
  | 'deep-link';

/** What ran the switch: the thing whose exit ends the measurement. */
export type SwitchTool = 'osascript' | 'cmux-cli' | 'open' | 'pty';

/** Facts a step learns about the switch. All optional: a path sets what it knows. */
export interface SwitchFacts {
  /** The terminal named in Settings. */
  configured?: string;
  /** The terminal the switch went to, after auto-detection. */
  terminal?: string;
  tool?: SwitchTool;
  branch?: SwitchBranch | null;
  /** Which key the script tried first. */
  order?: 'tty-first' | 'title-first';
  /** Whether the script carried a title block at all (a `/rename`d session). */
  hasTitle?: boolean;
}

/** What the renderer stamps on the click that starts a switch. */
export interface RendererStamp {
  /** `Date.now()` at the keypress or click. */
  wallMs: number;
  /** `performance.timeOrigin + performance.now()` at the same moment. */
  perfEpochMs: number;
  /** How the switch was started. */
  via?: 'enter' | 'click';
  /** Rows in the session list at that moment. */
  rows?: number;
}

/** The marks and facts of one finished switch, before any system sample. */
export interface SwitchSnapshot {
  /** Monotonic ms since the IPC arrived, per mark. */
  marks: Partial<Record<SwitchMark, number>>;
  /** Monotonic ms since the IPC arrived: the external command started / exited. */
  spawnedAt: number | null;
  exitedAt: number | null;
  /** When the record was closed, on the same clock. */
  endedAt: number;
  facts: SwitchFacts;
  /** False when `openSession` rejected. */
  ok: boolean;
  /** True when the external command had not exited by the safety deadline. */
  timedOut: boolean;
}

export interface SwitchTiming {
  mark(step: SwitchMark): void;
  set(facts: SwitchFacts): void;
  /** The external command (osascript, the cmux CLI) was started. */
  spawned(): void;
  /**
   * It exited. `stdout`, when the command is a switch script, names the
   * branch that matched.
   */
  exited(stdout?: string): void;
  /**
   * `openSession` settled. The record closes now if nothing is still
   * running, otherwise when it exits (or at the safety deadline).
   */
  settle(ok: boolean): void;
}

export interface SwitchTimingDeps {
  /** A monotonic clock in ms. */
  now: () => number;
  onFinish: (snapshot: SwitchSnapshot) => void;
  /** How long to wait for a command that never reports its exit. */
  deadlineMs?: number;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  clearTimer?: (handle: unknown) => void;
}

/** A command that outlives this has been killed by its own timeout or is hung. */
export const SWITCH_DEADLINE_MS = 15000;

/**
 * The switch scripts end in `return "found-by-tty"` and the like (see
 * terminal-switch.ts); osascript prints that value. Reading it costs
 * nothing and changes no script. Anything else — an empty stdout from a
 * script that failed, a launch script, which returns nothing — is `null`:
 * unknown, which is not the same as "matched nothing".
 */
export const branchFromSwitchOutput = (
  stdout: string | undefined,
): SwitchBranch | null => {
  const out = (stdout || '').trim();
  if (out === 'found-by-tty') return 'tty';
  if (out === 'found-by-title') return 'title';
  if (out === 'found-by-cwd') return 'cwd';
  if (out === 'not found') return 'none';
  return null;
};

export const createSwitchTiming = (deps: SwitchTimingDeps): SwitchTiming => {
  const t0 = deps.now();
  const marks: Partial<Record<SwitchMark, number>> = {};
  let facts: SwitchFacts = {};
  let spawnedAt: number | null = null;
  let exitedAt: number | null = null;
  let running = 0;
  let settled = false;
  let ok = true;
  let finished = false;
  let timer: unknown = null;
  const since = () => deps.now() - t0;
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      // A broken measurement must never reach the switch.
    }
  };

  const finish = (timedOut: boolean) => {
    if (finished) return;
    finished = true;
    if (timer !== null) (deps.clearTimer ?? clearTimeout)(timer as any);
    deps.onFinish({
      marks: { ...marks },
      spawnedAt,
      exitedAt,
      endedAt: since(),
      facts: { ...facts },
      ok,
      timedOut,
    });
  };

  return {
    mark: (step) =>
      guard(() => {
        // First write wins: a step reached twice keeps its first time.
        if (!finished && marks[step] === undefined) marks[step] = since();
      }),
    set: (more) =>
      guard(() => {
        if (!finished) facts = { ...facts, ...more };
      }),
    spawned: () =>
      guard(() => {
        if (finished) return;
        running++;
        if (spawnedAt === null) spawnedAt = since();
      }),
    exited: (stdout) =>
      guard(() => {
        if (finished) return;
        running = Math.max(0, running - 1);
        exitedAt = since();
        if (stdout !== undefined && facts.branch === undefined) {
          facts = { ...facts, branch: branchFromSwitchOutput(stdout) };
        }
        if (settled && running === 0) finish(false);
      }),
    settle: (succeeded) =>
      guard(() => {
        if (finished || settled) return;
        settled = true;
        ok = succeeded;
        if (marks.returned === undefined) marks.returned = since();
        if (running === 0) {
          finish(false);
          return;
        }
        // The active-session paths return before their script exits, so the
        // record waits for it — but not forever.
        timer = (deps.setTimer ?? setTimeout)(
          () => guard(() => finish(true)),
          deps.deadlineMs ?? SWITCH_DEADLINE_MS,
        );
        (timer as { unref?: () => void })?.unref?.();
      }),
  };
};

// --- arithmetic ---

/** The fields of `os.cpus()[n].times` this needs. */
export interface CpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

/**
 * Whole-machine CPU busy % between two `os.cpus()` samples: 100 × (1 − idle
 * share), over every core. Null when the samples cannot be compared — no
 * time passed between them (the counters tick at 10 ms), or the core count
 * changed.
 */
export const cpuPercentBetween = (
  before: { times: CpuTimes }[] | null | undefined,
  after: { times: CpuTimes }[] | null | undefined,
): number | null => {
  if (!before || !after || before.length === 0 || before.length !== after.length) {
    return null;
  }
  const sum = (t: CpuTimes) => t.user + t.nice + t.sys + t.idle + t.irq;
  let total = 0;
  let idle = 0;
  for (let i = 0; i < before.length; i++) {
    total += sum(after[i].times) - sum(before[i].times);
    idle += after[i].times.idle - before[i].times.idle;
  }
  if (!(total > 0)) return null;
  const pct = 100 * (1 - idle / total);
  return round1(Math.min(100, Math.max(0, pct)));
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** `b − a` to a tenth of a ms; null when either end was never reached. */
const span = (a: number | null | undefined, b: number | null | undefined): number | null =>
  typeof a === 'number' && typeof b === 'number' ? round1(b - a) : null;

export interface SwitchStepMs {
  /** Click to the IPC arriving in main, on the wall clock (whole ms). */
  clickToIpc: number | null;
  /** The same on the two processes' high-resolution clocks. */
  clickToIpcHr: number | null;
  /** IPC arrival to the two settings read. */
  settings: number | null;
  /** `detectTerminalApp`. Null for a resume, which does not detect. */
  detect: number | null;
  /** Building the script text, plus whatever JS precedes it. */
  build: number | null;
  /** Writing the script file and starting the command. */
  spawn: number | null;
  /** The command itself: started to exited. */
  run: number | null;
  /** IPC arrival to `openSession` returning. */
  returned: number | null;
  /** IPC arrival to the end: the command's exit, else `openSession` returning. */
  main: number | null;
  /** `clickToIpc + main`: what the user waited. */
  total: number | null;
}

/**
 * Step durations from one snapshot. Each step is measured from the step
 * before it that this path actually reached, so a path that skips one
 * (a resume skips `detect`) does not lose the time: it lands in the next.
 */
export const stepDurations = (
  snap: SwitchSnapshot,
  stamp: RendererStamp | undefined,
  ipc: { wallMs: number; perfEpochMs: number },
): SwitchStepMs => {
  const { marks, spawnedAt, exitedAt } = snap;
  const afterSettings = marks.settings ?? 0;
  const beforeScript = marks.detect ?? afterSettings;
  // A command that timed out never reported an exit; the record's end is
  // then the deadline, which is not a duration of anything.
  const end = snap.timedOut ? null : exitedAt ?? marks.returned ?? snap.endedAt;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const clickToIpc = stamp && finite(stamp.wallMs) ? ipc.wallMs - stamp.wallMs : null;
  const clickToIpcHr =
    stamp && finite(stamp.perfEpochMs) ? round1(ipc.perfEpochMs - stamp.perfEpochMs) : null;
  const main = span(0, end);
  return {
    clickToIpc,
    clickToIpcHr,
    settings: span(0, marks.settings),
    detect: span(afterSettings, marks.detect),
    build: span(beforeScript, marks.script),
    spawn: span(marks.script ?? beforeScript, spawnedAt),
    run: span(spawnedAt, exitedAt),
    returned: span(0, marks.returned),
    main,
    total: main === null ? null : round1(main + Math.max(0, clickToIpc ?? 0)),
  };
};

/** System state around one switch. Every field may be missing. */
export interface SwitchSystemSample {
  loadavg?: number[];
  cpuPct?: number | null;
  ncpu?: number;
  /** `process.cpuUsage(start)` of the main process, in microseconds. */
  mainCpuMicros?: { user: number; system: number };
  memory?: { level: number; swapUsedMb: number; swapTotalMb: number } | null;
  /** Running `claude` processes in the last live-sessions report, and its age. */
  claudeProcs?: number | null;
  liveAgeMs?: number | null;
  /** Only for a slow switch: the busiest processes right after it. */
  top?: { cpu: number; comm: string }[];
}

export interface SwitchContext {
  /** ISO time of the IPC arriving. */
  ts: string;
  sessionId: string;
  active: boolean;
}

/**
 * The stamp crosses an IPC boundary, so it is checked rather than trusted:
 * anything not shaped like one is dropped, and the record simply has no
 * click time.
 */
export const sanitizeStamp = (raw: unknown): RendererStamp | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!num(r.wallMs) || !num(r.perfEpochMs)) return undefined;
  return {
    wallMs: r.wallMs,
    perfEpochMs: r.perfEpochMs,
    via: r.via === 'enter' || r.via === 'click' ? r.via : undefined,
    rows: num(r.rows) ? r.rows : undefined,
  };
};

export const SWITCH_RECORD_VERSION = 1;

/** A switch slower than this also records the busiest processes. */
export const SLOW_SWITCH_MS = 1000;

export const isSlowSwitch = (ms: SwitchStepMs): boolean =>
  typeof ms.total === 'number' && ms.total > SLOW_SWITCH_MS;

export const buildSwitchRecord = (
  ctx: SwitchContext,
  stamp: RendererStamp | undefined,
  snap: SwitchSnapshot,
  ms: SwitchStepMs,
  sys: SwitchSystemSample,
): Record<string, unknown> => ({
  v: SWITCH_RECORD_VERSION,
  ts: ctx.ts,
  sid: String(ctx.sessionId || '').slice(0, 8),
  via: stamp?.via ?? null,
  kind: ctx.active ? 'switch' : 'resume',
  terminal: snap.facts.terminal ?? snap.facts.configured ?? null,
  configured: snap.facts.configured ?? null,
  tool: snap.facts.tool ?? null,
  branch: snap.facts.branch ?? null,
  order: snap.facts.order ?? null,
  hasTitle: snap.facts.hasTitle ?? null,
  ok: snap.ok,
  timedOut: snap.timedOut,
  ms,
  load: (sys.loadavg ?? []).map((n) => Math.round(n * 100) / 100),
  cpuPct: sys.cpuPct ?? null,
  ncpu: sys.ncpu ?? null,
  mainCpuMs: sys.mainCpuMicros
    ? {
        user: round1(sys.mainCpuMicros.user / 1000),
        system: round1(sys.mainCpuMicros.system / 1000),
      }
    : null,
  mem: sys.memory ?? null,
  claudeProcs: sys.claudeProcs ?? null,
  liveAgeMs: sys.liveAgeMs ?? null,
  rows: stamp?.rows ?? null,
  ...(sys.top ? { top: sys.top } : {}),
});

/**
 * The busiest `n` processes from `ps -A -o %cpu=,comm=`. `comm` is a full
 * path on macOS, and a path under a home directory names its user, so only
 * the executable's own name is kept.
 */
export const parseTopCpu = (psOut: string, n = 3): { cpu: number; comm: string }[] =>
  psOut
    .split('\n')
    .map((line) => /^\s*([0-9]+(?:[.,][0-9]+)?)\s+(.+?)\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({
      cpu: Number(m[1].replace(',', '.')),
      comm: m[2].slice(m[2].lastIndexOf('/') + 1),
    }))
    .filter((p) => Number.isFinite(p.cpu) && p.comm)
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, n);

/** The log is capped: at this size it moves to `.1`, replacing the last one. */
export const SWITCH_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Rotate before this append? Yes when the line would take the file past the
 * cap — but never for an empty file, or one oversized line would rotate on
 * every write and keep nothing.
 */
export const shouldRotate = (
  currentBytes: number,
  incomingBytes: number,
  maxBytes: number = SWITCH_LOG_MAX_BYTES,
): boolean => currentBytes > 0 && currentBytes + incomingBytes > maxBytes;
