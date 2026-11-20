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
 * - **A record says which session it was, and nothing a session said.**
 *   It holds the session id, its title, account label, project path, pid
 *   and tty, so that per-session patterns show (one crowded window, one
 *   account, a session that always falls back to cwd). The title is
 *   whatever the Sessions tab shows for the row: the name the user gave
 *   with `/rename`, or else the one Claude Code generated — a model-written
 *   summary of the conversation in a few words. The prompts and the
 *   transcript text themselves are not recorded. The log stays on this
 *   machine in an owner-only (0600) file; titles and paths describe the
 *   owner's work, so results quoted anywhere public should carry
 *   placeholders instead (the summary script's `--redact`).
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
  /** Whether the script carried a title block at all (the row had a title). */
  hasTitle?: boolean;
  /**
   * The account of this switch. For a resume it is the account the launch
   * runs under, set where that is decided (`buildResumeCommand`): history's
   * account for a session history knows, else the row's label. Only the
   * terminal paths that build a resume command do this (iTerm2, Ghostty,
   * Terminal.app, cmux). Everything else keeps what main set — the row's
   * label, once checked that an account carries it: a switch to a running
   * session, which launches nothing, and a resume through VS Code, Claude
   * Desktop or the embedded terminal. Null: no account was resolved.
   */
  account?: string | null;
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
  /**
   * True when the command did exit, but only because its caller's own
   * timeout killed it. Its times are real waits, not a completed switch.
   *
   * Only the `osascript` callbacks report this (`error.killed`): the
   * resume launches of iTerm2, Ghostty and Terminal.app, and the Ghostty
   * and Terminal.app switches, which run with a 5 s timeout. The iTerm2
   * switch has no timeout to be killed by. The cmux paths never set it:
   * the cmux resume is timed around a promise that does not hand over its
   * error, and the cmux switch discards its CLI errors. So `false` on a
   * cmux record does not say its command was not killed.
   */
  killed?: boolean;
}

export interface SwitchTiming {
  mark(step: SwitchMark): void;
  set(facts: SwitchFacts): void;
  /** The external command (osascript, the cmux CLI) was started. */
  spawned(): void;
  /**
   * It exited. `stdout`, when the command is a switch script, names the
   * branch that matched. `killed` is the callback's `error.killed`: the
   * command was stopped by its timeout instead of finishing. Passed by the
   * `osascript` callbacks only (see `SwitchSnapshot.killed`).
   */
  exited(stdout?: string, killed?: boolean): void;
  /**
   * `openSession` settled. The record closes now if nothing is still
   * running, otherwise when it exits (or at the safety deadline).
   */
  settle(ok: boolean): void;
}

export interface SwitchTimingDeps {
  /** A monotonic clock in ms. */
  now: () => number;
  /**
   * The reading of `now` that is time zero — the IPC's arrival. Given when
   * the caller read the clock before doing anything else, so that its own
   * setup is inside the measurement; otherwise the clock is read here.
   */
  origin?: number;
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
  const t0 = typeof deps.origin === 'number' ? deps.origin : deps.now();
  const marks: Partial<Record<SwitchMark, number>> = {};
  let facts: SwitchFacts = {};
  let spawnedAt: number | null = null;
  let exitedAt: number | null = null;
  let running = 0;
  let settled = false;
  let ok = true;
  let killed = false;
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
      killed,
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
    exited: (stdout, wasKilled) =>
      guard(() => {
        if (finished) return;
        running = Math.max(0, running - 1);
        exitedAt = since();
        if (wasKilled === true) killed = true;
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
  /**
   * IPC arrival to the command's exit. Null when there was none to see:
   * the command timed out, or the path starts no command (`untimed`).
   */
  main: number | null;
  /**
   * `clickToIpc + main`: what the user waited. Null whenever `main` is.
   * Without a click stamp the click-to-IPC part counts as zero, so `total`
   * then equals `main`; `clickToIpc` is null on such a record, which is how
   * a reader can tell. (A negative `clickToIpc` — the two clocks disagreeing
   * — also counts as zero here, and is recorded as measured.)
   */
  total: number | null;
}

/**
 * True for a switch this log cannot time end to end: no command was
 * started and awaited (`spawned()` was never called), so there is no exit
 * to measure to. That is the rule, whatever the path. In practice it is
 * mostly the paths that hand over with a fire-and-forget `open` or a
 * message to the renderer (VS Code, Claude Desktop, the embedded terminal;
 * what they do next, such as VS Code's 500 ms wait before its URI command,
 * happens out of sight). It is also a terminal launch that failed before
 * its command started, for example when the script file could not be
 * written: such a record is untimed with tool `osascript`.
 */
export const isUntimed = (snap: SwitchSnapshot): boolean => snap.spawnedAt === null;

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
  // The end is the command's exit and nothing else. Two kinds of record
  // have none, and for both `run`, `main` and `total` stay null while
  // `returned` is what is known:
  // - a command that timed out never reported one (the record closed at
  //   the deadline, which is not a duration of anything);
  // - a record on which no command was started and awaited (mostly the
  //   paths handed to VS Code, Claude Desktop or the embedded terminal),
  //   where `openSession` returning is not "switched" (see `isUntimed`).
  const end = snap.timedOut || isUntimed(snap) ? null : exitedAt;
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
  /** Only for a slow, timed-out or killed switch: the busiest processes right after it. */
  top?: { cpu: number; comm: string }[];
  /** The target process's controlling terminal, and where the value came from. */
  tty?: string | null;
  ttySrc?: 'live-report' | 'ps' | null;
}

export interface SwitchContext {
  /** ISO time of the IPC arriving. */
  ts: string;
  sessionId: string;
  active: boolean;
  /** The row's title as the click carried it: `/rename`d, or generated. */
  title?: string | null;
  projectPath?: string | null;
  /** The process switched to; none for a resume. */
  pid?: number | null;
}

/** A title is a line of text; anything longer is cut. In code points. */
export const SWITCH_TITLE_MAX = 200;

/**
 * A non-empty string of at most `max` code points, else null. Cut by code
 * point, not by UTF-16 unit: a cut through the middle of an emoji would
 * leave half a character at the end of the value.
 */
export const textOrNull = (v: unknown, max = 4096): string | null => {
  if (typeof v !== 'string' || v === '') return null;
  // `length` counts UTF-16 units, never fewer than the code points.
  if (v.length <= max) return v;
  return Array.from(v).slice(0, max).join('');
};

/** A usable pid, else null: the value crossed an IPC boundary. */
export const pidOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;

/**
 * The tty from `ps -o tty= -p <pid>`: `ttys004`, or null when the process
 * has none (`??`), is gone (empty output), or `ps` failed.
 */
export const parseTty = (psOut: string | null | undefined): string | null => {
  const t = (psOut || '').trim();
  return t && t !== '??' && /^[\w/.-]+$/.test(t) ? t : null;
};

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

/**
 * 2: the record names its session (`sessionId`, `title`, `account`,
 * `project`, `pid`, `tty`, `ttySrc`); version 1 had only `sid`, the first 8
 * characters of the id.
 */
export const SWITCH_RECORD_VERSION = 2;

/** A switch slower than this also records the busiest processes. */
export const SLOW_SWITCH_MS = 1000;

/**
 * Slow enough to also ask what the machine was busy with. A switch whose
 * command never reported back (`timedOut`) has no total to compare, and
 * one whose command was killed by its timeout did not finish either: both
 * are the slowest kind there is, so `cutShort` always counts.
 */
export const isSlowSwitch = (ms: SwitchStepMs, cutShort = false): boolean =>
  cutShort || (typeof ms.total === 'number' && ms.total > SLOW_SWITCH_MS);

export const buildSwitchRecord = (
  ctx: SwitchContext,
  stamp: RendererStamp | undefined,
  snap: SwitchSnapshot,
  ms: SwitchStepMs,
  sys: SwitchSystemSample,
): Record<string, unknown> => ({
  v: SWITCH_RECORD_VERSION,
  ts: ctx.ts,
  sessionId: textOrNull(ctx.sessionId, 128),
  title: textOrNull(ctx.title, SWITCH_TITLE_MAX),
  account: textOrNull(snap.facts.account, 128),
  project: textOrNull(ctx.projectPath),
  pid: pidOrNull(ctx.pid),
  tty: sys.tty ?? null,
  ttySrc: sys.tty ? sys.ttySrc ?? null : null,
  via: stamp?.via ?? null,
  kind: ctx.active ? 'switch' : 'resume',
  terminal: snap.facts.terminal ?? snap.facts.configured ?? null,
  configured: snap.facts.configured ?? null,
  tool: snap.facts.tool ?? null,
  branch: snap.facts.branch ?? null,
  order: snap.facts.order ?? null,
  hasTitle: snap.facts.hasTitle ?? null,
  // A command killed by its timeout did not switch, whatever `openSession` returned.
  ok: snap.ok && snap.killed !== true,
  timedOut: snap.timedOut,
  killed: snap.killed === true,
  untimed: isUntimed(snap),
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
