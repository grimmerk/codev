import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  branchFromSwitchOutput,
  buildSwitchRecord,
  cpuPercentBetween,
  createSwitchTiming,
  isSlowSwitch,
  isUntimed,
  parseTopCpu,
  parseTty,
  sanitizeStamp,
  shouldRotate,
  stepDurations,
  SwitchSnapshot,
  textOrNull,
} from './switch-timing';
import {
  appendSwitchLogLine,
  noteLiveReport,
  resetLiveReportNote,
  startSwitchTiming,
} from './switch-timing-log';
import {
  buildGhosttySwitchScript,
  buildITerm2SwitchScript,
  buildTerminalAppSwitchScript,
} from './terminal-switch';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const summary = require('../scripts/switch-timing-summary.js');

/** A collector on a hand-driven clock, with its timers captured. */
const harness = (deadlineMs = 1000) => {
  let now = 100;
  const finished: SwitchSnapshot[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const timing = createSwitchTiming({
    now: () => now,
    onFinish: (s) => finished.push(s),
    deadlineMs,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return { timing, finished, timers, advance: (ms: number) => (now += ms) };
};

describe('createSwitchTiming', () => {
  it('waits for the script when openSession returns before it exits', () => {
    // The running-session paths fire osascript and return at once.
    const h = harness();
    h.advance(2);
    h.timing.mark('settings');
    h.advance(30);
    h.timing.mark('detect');
    h.advance(1);
    h.timing.mark('script');
    h.timing.spawned();
    h.advance(1);
    h.timing.settle(true);
    expect(h.finished).toHaveLength(0);
    h.advance(400);
    h.timing.exited('found-by-tty\n');
    expect(h.finished).toHaveLength(1);
    const snap = h.finished[0];
    expect(snap.marks).toEqual({ settings: 2, detect: 32, script: 33, returned: 34 });
    expect(snap.spawnedAt).toBe(33);
    expect(snap.exitedAt).toBe(434);
    expect(snap.facts.branch).toBe('tty');
    expect(snap.timedOut).toBe(false);
    expect(h.timers[0].cleared).toBe(true);
  });

  it('closes on settle when the command already exited (the resume paths await it)', () => {
    const h = harness();
    h.timing.set({ branch: 'new-tab' });
    h.timing.spawned();
    h.advance(250);
    h.timing.exited();
    expect(h.finished).toHaveLength(0);
    h.timing.settle(true);
    expect(h.finished).toHaveLength(1);
    // A launch script prints nothing; the branch set beforehand stands.
    expect(h.finished[0].facts.branch).toBe('new-tab');
    expect(h.timers).toHaveLength(0);
  });

  it('closes at the deadline, flagged, when the command never reports back', () => {
    const h = harness(5000);
    h.timing.spawned();
    h.timing.settle(true);
    expect(h.timers[0].ms).toBe(5000);
    h.advance(5000);
    h.timers[0].fn();
    expect(h.finished).toHaveLength(1);
    expect(h.finished[0].timedOut).toBe(true);
    expect(h.finished[0].exitedAt).toBeNull();
    // `returned` is when `openSession` settled (here, at once), not the
    // deadline 5000 ms later at which the record closed.
    expect(h.finished[0].marks.returned).toBe(0);
    expect(h.finished[0].endedAt).toBe(5000);
    // A late exit does not produce a second record.
    h.timing.exited('found-by-tty');
    expect(h.finished).toHaveLength(1);
  });

  it('records a rejected openSession as not ok, once', () => {
    const h = harness();
    h.timing.settle(false);
    h.timing.settle(true);
    expect(h.finished).toHaveLength(1);
    expect(h.finished[0].ok).toBe(false);
  });

  it('carries the kill of a command stopped by its timeout, and only that', () => {
    const killed = harness();
    killed.timing.spawned();
    killed.timing.settle(true);
    killed.advance(5000);
    killed.timing.exited('', true);
    expect(killed.finished[0]).toMatchObject({ killed: true, timedOut: false, exitedAt: 5000 });
    // An ordinary exit, with or without the argument, is not a kill.
    const normal = harness();
    normal.timing.spawned();
    normal.timing.exited('found-by-tty', false);
    normal.timing.settle(true);
    expect(normal.finished[0].killed).toBe(false);
  });

  it('lets the launch replace the account main set first', () => {
    // main sets the row's label; a resume then sets the account it runs under.
    const h = harness();
    h.timing.set({ account: 'from-the-row', configured: 'iterm2' });
    h.timing.set({ account: 'from-history' });
    h.timing.settle(true);
    expect(h.finished[0].facts).toMatchObject({ account: 'from-history', configured: 'iterm2' });
  });

  it('measures from the origin it is given, not from its own creation', () => {
    // The caller read the clock at 90, then spent 10 ms setting up.
    let now = 100;
    const finished: SwitchSnapshot[] = [];
    const timing = createSwitchTiming({
      now: () => now,
      origin: 90,
      onFinish: (s) => finished.push(s),
    });
    now = 103;
    timing.mark('settings');
    now = 120;
    timing.settle(true);
    expect(finished[0].marks).toEqual({ settings: 13, returned: 30 });
  });

  it('never throws into the switch, even when the sink does', () => {
    const timing = createSwitchTiming({
      now: () => 0,
      onFinish: () => {
        throw new Error('disk full');
      },
    });
    expect(() => {
      timing.mark('script');
      timing.spawned();
      timing.exited('found-by-title');
      timing.settle(true);
    }).not.toThrow();
  });
});

describe('branchFromSwitchOutput', () => {
  it('names a branch for every value the real switch scripts can return', () => {
    // The contract is with terminal-switch.ts: if a script grows a new
    // return value, this fails instead of the log quietly saying null.
    const scripts = [
      buildITerm2SwitchScript(1, 'a title', 'tty-first'),
      buildTerminalAppSwitchScript(1, 'a title', 'title-first'),
      buildGhosttySwitchScript(1, 'a title', 'tty-first', '/tmp/proj'),
    ];
    const returned = new Set<string>();
    for (const s of scripts) {
      for (const m of s.matchAll(/return "([^"]+)"/g)) returned.add(m[1]);
    }
    expect([...returned].sort()).toEqual(
      ['found-by-cwd', 'found-by-title', 'found-by-tty', 'not found'].sort(),
    );
    expect([...returned].map((r) => branchFromSwitchOutput(`${r}\n`)).sort()).toEqual(
      ['cwd', 'none', 'title', 'tty'].sort(),
    );
  });

  it('is null — unknown, not "none" — for a failed or silent script', () => {
    expect(branchFromSwitchOutput('')).toBeNull();
    expect(branchFromSwitchOutput(undefined)).toBeNull();
    expect(branchFromSwitchOutput('execution error: not allowed (-1743)')).toBeNull();
  });
});

describe('cpuPercentBetween', () => {
  const core = (user: number, sys: number, idle: number) => ({
    times: { user, nice: 0, sys, idle, irq: 0 },
  });

  it('is the non-idle share across all cores', () => {
    const before = [core(1000, 500, 8000), core(2000, 500, 7000)];
    // Core 0: +300 busy, +100 idle. Core 1: +0 busy, +400 idle. 300 of 800.
    const after = [core(1200, 600, 8100), core(2000, 500, 7400)];
    expect(cpuPercentBetween(before, after)).toBe(37.5);
  });

  it('is null when no time passed or the samples do not line up', () => {
    const a = [core(1, 1, 1)];
    expect(cpuPercentBetween(a, a)).toBeNull();
    expect(cpuPercentBetween(a, [core(2, 2, 2), core(1, 1, 1)])).toBeNull();
    expect(cpuPercentBetween(undefined, a)).toBeNull();
  });
});

describe('stepDurations', () => {
  const snap = (over: Partial<SwitchSnapshot>): SwitchSnapshot => ({
    marks: {},
    spawnedAt: null,
    exitedAt: null,
    endedAt: 0,
    facts: {},
    ok: true,
    timedOut: false,
    ...over,
  });
  const ipc = { wallMs: 1_000_010, perfEpochMs: 1_000_010.4 };
  const stamp = { wallMs: 1_000_000, perfEpochMs: 1_000_001.2, via: 'enter' as const, rows: 3 };

  it('splits a running-session switch into its steps, ending at the exit', () => {
    const ms = stepDurations(
      snap({
        marks: { settings: 2, detect: 32, script: 33, returned: 34.5 },
        spawnedAt: 33.6,
        exitedAt: 434,
        endedAt: 434,
      }),
      stamp,
      ipc,
    );
    expect(ms).toEqual({
      clickToIpc: 10,
      clickToIpcHr: 9.2,
      settings: 2,
      detect: 30,
      build: 1,
      spawn: 0.6,
      run: 400.4,
      returned: 34.5,
      main: 434,
      total: 444,
    });
  });

  it('leaves detect null for a resume and counts that time in build', () => {
    const ms = stepDurations(
      snap({ marks: { settings: 2, script: 5, returned: 300 }, spawnedAt: 6, exitedAt: 299 }),
      stamp,
      ipc,
    );
    expect(ms.detect).toBeNull();
    expect(ms.build).toBe(3);
    expect(ms.run).toBe(293);
  });

  it('has no total for a command that timed out, and no click time without a stamp', () => {
    const timedOut = stepDurations(
      snap({ marks: { returned: 5 }, spawnedAt: 4, endedAt: 15000, timedOut: true }),
      undefined,
      ipc,
    );
    // The 15 s deadline is when the record closed, not how long anything took.
    expect(timedOut.total).toBeNull();
    expect(timedOut.main).toBeNull();
    expect(timedOut.run).toBeNull();
    // What was measured stays: main got its answer back after 5 ms.
    expect(timedOut.returned).toBe(5);
    expect(timedOut.spawn).toBe(4);
    expect(timedOut.clickToIpc).toBeNull();
    // Without a stamp the total is main's own span, not a guess.
    const noStamp = stepDurations(
      snap({ marks: { returned: 5 }, spawnedAt: 1, exitedAt: 5, endedAt: 5 }),
      undefined,
      ipc,
    );
    expect(noStamp.total).toBe(5);
  });

  it('gives no end-to-end time to a path that starts no command', () => {
    // VS Code, Claude Desktop, the embedded terminal: `openSession` returns
    // after handing over, long before anything is switched.
    const handedOver = snap({ marks: { settings: 2, returned: 6 }, endedAt: 6 });
    expect(isUntimed(handedOver)).toBe(true);
    const ms = stepDurations(handedOver, stamp, ipc);
    expect(ms).toMatchObject({ run: null, main: null, total: null, returned: 6, settings: 2 });
    expect(ms.clickToIpc).toBe(10);
    expect(isSlowSwitch(ms)).toBe(false);
    expect(isUntimed(snap({ spawnedAt: 3, exitedAt: 9 }))).toBe(false);
  });

  it('keeps the measured wait of a killed command', () => {
    // Unlike the no-exit deadline, the ~5 s here was really waited.
    const ms = stepDurations(
      snap({ marks: { returned: 4 }, spawnedAt: 3, exitedAt: 5003, killed: true }),
      undefined,
      ipc,
    );
    expect(ms).toMatchObject({ run: 5000, main: 5003, total: 5003 });
  });

  it('counts a timed-out switch as slow although it has no total', () => {
    const fast = stepDurations(snap({ marks: { returned: 5 }, endedAt: 5 }), undefined, ipc);
    expect(isSlowSwitch(fast)).toBe(false);
    expect(isSlowSwitch(fast, true)).toBe(true);
    const slow = stepDurations(
      snap({ marks: { returned: 5 }, spawnedAt: 5, exitedAt: 1001 }),
      undefined,
      ipc,
    );
    expect(slow.total).toBe(1001);
    expect(isSlowSwitch(slow)).toBe(true);
    expect(isSlowSwitch({ ...slow, total: 1000 })).toBe(false);
  });

  it('does not let a renderer clock that runs ahead shorten the total', () => {
    const ahead = { ...stamp, wallMs: ipc.wallMs + 50 };
    const ms = stepDurations(
      snap({ marks: { returned: 20 }, spawnedAt: 1, exitedAt: 20, endedAt: 20 }),
      ahead,
      ipc,
    );
    expect(ms.clickToIpc).toBe(-50); // kept as measured
    expect(ms.total).toBe(20);
  });
});

describe('sanitizeStamp', () => {
  it('keeps a well-formed stamp and drops what it cannot trust', () => {
    expect(sanitizeStamp({ wallMs: 1, perfEpochMs: 2, via: 'enter', rows: 9 })).toEqual({
      wallMs: 1,
      perfEpochMs: 2,
      via: 'enter',
      rows: 9,
    });
    expect(sanitizeStamp({ wallMs: 1, perfEpochMs: 2, via: 'rm -rf', rows: 'many' })).toEqual({
      wallMs: 1,
      perfEpochMs: 2,
      via: undefined,
      rows: undefined,
    });
    expect(sanitizeStamp({ wallMs: '1', perfEpochMs: 2 })).toBeUndefined();
    expect(sanitizeStamp('2026')).toBeUndefined();
    expect(sanitizeStamp(undefined)).toBeUndefined();
  });
});

describe('parseTopCpu', () => {
  it('returns the busiest processes by name, without their paths', () => {
    const out = [
      '  0.0 /sbin/launchd',
      ' 88.1 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer',
      ' 12.5 /Users/someone/Applications/My App.app/Contents/MacOS/My App',
      '140.2 claude',
      'garbage line',
      '',
    ].join('\n');
    expect(parseTopCpu(out)).toEqual([
      { cpu: 140.2, comm: 'claude' },
      { cpu: 88.1, comm: 'WindowServer' },
      { cpu: 12.5, comm: 'My App' },
    ]);
  });

  it('reads a comma decimal (ps follows the locale)', () => {
    expect(parseTopCpu(' 3,5 /bin/zsh\n 12,0 /usr/bin/top', 1)).toEqual([
      { cpu: 12, comm: 'top' },
    ]);
  });
});

describe('shouldRotate', () => {
  it('rotates when the line would cross the cap, never an empty file', () => {
    expect(shouldRotate(900, 100, 1000)).toBe(false); // lands exactly on the cap
    expect(shouldRotate(900, 101, 1000)).toBe(true);
    expect(shouldRotate(0, 5000, 1000)).toBe(false);
  });
});

describe('the log file', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-timing-'));
    file = path.join(dir, 'nested', 'switch-timing.jsonl');
    resetLiveReportNote();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('rotates to .1 at the cap and keeps exactly one old file', async () => {
    const line = 'x'.repeat(40);
    await appendSwitchLogLine(file, line, 100);
    await appendSwitchLogLine(file, line, 100); // 82 bytes
    expect(fs.existsSync(`${file}.1`)).toBe(false);
    await appendSwitchLogLine(file, 'second', 100); // would be 89: fits
    await appendSwitchLogLine(file, line, 100); // would be 130: rotate
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toBe(`${line}\n${line}\nsecond\n`);
    expect(fs.readFileSync(file, 'utf-8')).toBe(`${line}\n`);
    await appendSwitchLogLine(file, 'y'.repeat(80), 100); // rotate again
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toBe(`${line}\n`);
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual([
      'switch-timing.jsonl',
      'switch-timing.jsonl.1',
    ]);
  });

  const SESSION = {
    sessionId: '0f1e2d3c-aaaa-bbbb-cccc-123456789abc',
    active: true,
    title: 'an example title',
    projectPath: '/Users/someone/code/example',
    pid: 4242,
  };

  const runSwitch = (
    stamp: unknown,
    deps: {
      sysctl?: () => Promise<string>;
      psTop?: () => Promise<string>;
      psTty?: (pid: number) => Promise<string>;
      listings?: NonNullable<Parameters<typeof startSwitchTiming>[2]>['listings'];
      deadlineMs?: number;
    } = {},
    session: Parameters<typeof startSwitchTiming>[0] = SESSION,
    // What main does once it has validated the row's label; `never` hangs the command.
    { account = 'second' as string | null, exits = true, killed = false } = {},
  ) =>
    new Promise<Record<string, unknown> | null>((resolve) => {
      const timing = startSwitchTiming(
        session,
        stamp,
        {
          filePath: file,
          sysctl: async () =>
            'total = 2048.00M  used = 512.50M  free = 1535.50M  (encrypted)\n2\n',
          psTop: async () => ' 91.0 /usr/libexec/somed\n  1.0 /bin/zsh\n',
          psTty: async () => 'ttys007\n',
          ...deps,
          onWritten: resolve,
        },
      );
      timing.set({ configured: 'iterm2', terminal: 'ghostty', order: 'tty-first' });
      timing.mark('settings');
      timing.set({ account });
      timing.mark('script');
      timing.spawned();
      timing.settle(true);
      if (exits) timing.exited(killed ? '' : 'found-by-title\n', killed);
    });

  it('writes one line per switch, naming the session it was', async () => {
    noteLiveReport({ live: [{}, {}, {}] });
    let psCalls = 0;
    const record = await runSwitch(
      { wallMs: Date.now(), perfEpochMs: performance.timeOrigin + performance.now(), via: 'click', rows: 42 },
      {
        psTop: async () => {
          psCalls++;
          return '';
        },
      },
    );
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const onDisk = JSON.parse(lines[0]);
    expect(onDisk).toEqual(record);
    expect(onDisk).toMatchObject({
      v: 2,
      sessionId: '0f1e2d3c-aaaa-bbbb-cccc-123456789abc',
      title: 'an example title',
      account: 'second',
      project: '/Users/someone/code/example',
      pid: 4242,
      tty: 'ttys007',
      ttySrc: 'ps',
      via: 'click',
      kind: 'switch',
      terminal: 'ghostty',
      configured: 'iterm2',
      tool: null,
      branch: 'title',
      order: 'tty-first',
      ok: true,
      timedOut: false,
      mem: { level: 2, swapUsedMb: 512.5, swapTotalMb: 2048 },
      claudeProcs: 3,
      rows: 42,
    });
    expect('sid' in onDisk).toBe(false);
    // Owner-only: the line names a session, a title and a path.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(onDisk.ms.total).toBeGreaterThanOrEqual(0);
    expect(onDisk.load).toHaveLength(3);
    expect(onDisk.ncpu).toBe(os.cpus().length);
    // A fast switch does not pay for `ps`, and has no `top`.
    expect(psCalls).toBe(0);
    expect('top' in onDisk).toBe(false);
  });

  it('carries the process-listing counters as they stand when the record is built', async () => {
    const counters = {
      n: 12,
      failed: 2,
      last: { reason: 'timeout', ms: 10012, path: 'badge' },
    };
    const record = await runSwitch(undefined, { listings: () => counters });
    expect(record?.listings).toEqual(counters);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8').trim()).listings).toEqual(counters);
    // One added field: the version is not bumped.
    expect(record?.v).toBe(2);
  });

  it('reads the real counters when none are injected', async () => {
    const record = await runSwitch(undefined);
    expect(record?.listings).toEqual({
      n: expect.any(Number),
      failed: expect.any(Number),
      last: null,
    });
  });

  it('still writes the record when the counters cannot be read', async () => {
    const record = await runSwitch(undefined, {
      listings: () => {
        throw new Error('unreadable');
      },
    });
    expect(record).not.toBeNull();
    expect('listings' in (record ?? {})).toBe(false);
    expect(record?.terminal).toBe('ghostty');
  });

  it('adds the busiest processes only when the switch was slow', async () => {
    const record = await runSwitch({
      wallMs: Date.now() - 1500, // the click was 1.5 s before the IPC arrived
      perfEpochMs: performance.timeOrigin + performance.now() - 1500,
      via: 'enter',
      rows: 1,
    });
    expect((record.ms as { total: number }).total).toBeGreaterThan(1000);
    expect(record.top).toEqual([
      { cpu: 91, comm: 'somed' },
      { cpu: 1, comm: 'zsh' },
    ]);
  });

  it('samples the busiest processes for a command that never reports back', async () => {
    // The hung command is the case the sample exists for, and it has no total.
    let psCalls = 0;
    const record = await runSwitch(
      { wallMs: Date.now(), perfEpochMs: performance.timeOrigin + performance.now(), via: 'click', rows: 1 },
      {
        deadlineMs: 20,
        psTop: async () => {
          psCalls++;
          return ' 97.5 /usr/libexec/stuckd\n';
        },
      },
      SESSION,
      { exits: false },
    );
    expect(psCalls).toBe(1);
    expect(record).toMatchObject({
      timedOut: true,
      branch: null,
      top: [{ cpu: 97.5, comm: 'stuckd' }],
    });
    const ms = record.ms as Record<string, number | null>;
    expect(ms.run).toBeNull();
    expect(ms.main).toBeNull();
    expect(ms.total).toBeNull();
    // No upper bound on purpose: this run is on the real clock, and the time
    // before `settle()` can legitimately exceed any small limit on a busy
    // machine. That `returned` is the settle time and not the deadline is
    // asserted on a controlled clock in 'closes at the deadline, flagged,
    // when the command never reports back' (`marks.returned` 0 against a
    // 5000 ms deadline) and in the `stepDurations` timed-out case.
    expect(typeof ms.returned).toBe('number');
  });

  it('marks a killed command: not ok, sampled as slow, however short the wait', async () => {
    let psCalls = 0;
    const record = await runSwitch(
      undefined,
      {
        psTop: async () => {
          psCalls++;
          return ' 55.0 /usr/bin/osascript\n';
        },
      },
      SESSION,
      { killed: true },
    );
    // `openSession` had resolved (the running-session paths return at once).
    expect(record).toMatchObject({ killed: true, ok: false, timedOut: false, untimed: false, branch: null });
    expect(psCalls).toBe(1);
    expect(record.top).toEqual([{ cpu: 55, comm: 'osascript' }]);
    expect(typeof (record.ms as { run: unknown }).run).toBe('number');
  });

  it('marks a normal switch as neither killed nor untimed', async () => {
    const record = await runSwitch(undefined);
    expect(record).toMatchObject({ killed: false, untimed: false, ok: true });
  });

  it('takes the count, its age and the tty from one live report, even if a newer one arrives', async () => {
    noteLiveReport({ live: [{ pid: 4242, tty: 'ttys011' }, { pid: 1, tty: 'ttys001' }] });
    // The record closes synchronously inside runSwitch; its write is deferred.
    const pending = runSwitch(undefined, { psTty: async () => 'ttys077\n' });
    // A newer report lands in between: after the count was taken, before the tty is.
    noteLiveReport({ live: [{ pid: 4242, tty: 'ttys099' }] });
    const record = await pending;
    expect(record).toMatchObject({ claudeProcs: 2, tty: 'ttys011', ttySrc: 'live-report' });
  });

  it('drops the record when an existing log cannot be made owner-only', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old line\n');
    const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const chmod = vi.spyOn(fs.promises, 'chmod').mockRejectedValue(eperm);
    try {
      await expect(appendSwitchLogLine(file, 'new line', 1000)).rejects.toThrow(/owner-only/);
      // Through the whole path too: the write is reported as dropped, not thrown.
      expect(await runSwitch(undefined)).toBeNull();
    } finally {
      chmod.mockRestore();
    }
    expect(fs.readFileSync(file, 'utf-8')).toBe('old line\n');
  });

  it('still creates a missing log, owner-only: nothing to fix is not a failure', async () => {
    const chmod = vi.spyOn(fs.promises, 'chmod');
    try {
      await appendSwitchLogLine(file, 'first line', 1000);
      // The chmod of the absent file failed with ENOENT, and that was fine.
      await expect(chmod.mock.results[0].value).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      chmod.mockRestore();
    }
    expect(fs.readFileSync(file, 'utf-8')).toBe('first line\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('writes on when only the rotated copy cannot be fixed', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old line\n');
    fs.writeFileSync(`${file}.1`, 'older\n');
    const real = fs.promises.chmod.bind(fs.promises);
    const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    const chmod = vi
      .spyOn(fs.promises, 'chmod')
      .mockImplementation((p, mode) => (String(p).endsWith('.1') ? Promise.reject(eperm) : real(p, mode)));
    try {
      await appendSwitchLogLine(file, 'new line', 1000);
    } finally {
      chmod.mockRestore();
    }
    expect(fs.readFileSync(file, 'utf-8')).toBe('old line\nnew line\n');
  });

  it('makes an existing log and its rotated copy owner-only, not just a new one', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'old line\n', { mode: 0o644 });
    fs.writeFileSync(`${file}.1`, 'older line\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644); // past the umask
    fs.chmodSync(`${file}.1`, 0o644);
    const mode = (f: string) => fs.statSync(f).mode & 0o777;

    // An append that does not rotate fixes both files.
    await appendSwitchLogLine(file, 'new line', 1000);
    expect(mode(file)).toBe(0o600);
    expect(mode(`${file}.1`)).toBe(0o600);
    expect(fs.readFileSync(file, 'utf-8')).toBe('old line\nnew line\n');

    // A rotation carries no loose mode over to `.1`.
    fs.chmodSync(file, 0o644);
    await appendSwitchLogLine(file, 'x'.repeat(40), 30);
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toBe('old line\nnew line\n');
    expect(mode(`${file}.1`)).toBe(0o600);
    expect(mode(file)).toBe(0o600);
  });

  it('takes the tty from the last live-sessions report instead of spawning ps', async () => {
    noteLiveReport({
      live: [
        { pid: 4242, tty: 'ttys011' },
        { pid: 77, tty: null },
      ],
    });
    let psCalls = 0;
    const psTty = async () => {
      psCalls++;
      return 'ttys099\n';
    };
    const known = await runSwitch(undefined, { psTty });
    expect(known).toMatchObject({ pid: 4242, tty: 'ttys011', ttySrc: 'live-report' });
    expect(psCalls).toBe(0);
    // A pid the report listed without a tty still gets the one lookup.
    const unknown = await runSwitch(undefined, { psTty }, { ...SESSION, pid: 77 });
    expect(unknown).toMatchObject({ pid: 77, tty: 'ttys099', ttySrc: 'ps' });
    expect(psCalls).toBe(1);
  });

  it('records a resume with no pid, no tty and no lookup; missing optionals are null', async () => {
    let psCalls = 0;
    const record = await runSwitch(
      undefined,
      {
        psTty: async () => {
          psCalls++;
          return 'ttys001';
        },
      },
      { sessionId: 'abc', active: false, pid: null },
      { account: null },
    );
    expect(record).toMatchObject({
      v: 2,
      kind: 'resume',
      sessionId: 'abc',
      title: null,
      account: null,
      project: null,
      pid: null,
      tty: null,
      ttySrc: null,
    });
    expect(psCalls).toBe(0);
  });

  it('records a null tty when the lookup fails or the process has none', async () => {
    const failed = await runSwitch(undefined, {
      psTty: async () => {
        throw new Error('ps failed');
      },
    });
    expect(failed).toMatchObject({ pid: 4242, tty: null, ttySrc: null });
    const none = await runSwitch(undefined, { psTty: async () => '??\n' });
    expect(none).toMatchObject({ tty: null, ttySrc: null });
  });

  it('still writes the record when sysctl and the live count are unavailable', async () => {
    const record = await runSwitch(undefined, {
      sysctl: async () => {
        throw new Error('no sysctl');
      },
    });
    expect(record).toMatchObject({ mem: null, claudeProcs: null, via: null, rows: null });
    expect((record.ms as { clickToIpc: unknown }).clickToIpc).toBeNull();
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  it('drops the record, without throwing, when the file cannot be written', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(file); // a directory where the log should be
    expect(await runSwitch(undefined)).toBeNull();
  });
});

describe('parseTty', () => {
  it('reads a tty and treats every kind of absence as null', () => {
    expect(parseTty('ttys004\n')).toBe('ttys004');
    expect(parseTty('??\n')).toBeNull(); // no controlling terminal
    expect(parseTty('')).toBeNull(); // the process is gone
    expect(parseTty(null)).toBeNull();
    expect(parseTty('ps: illegal option -- x')).toBeNull();
  });
});

describe('textOrNull', () => {
  it('cuts by code point, so a cut never leaves half a character', () => {
    const emoji = '\u{1F600}'; // two UTF-16 units
    const cut = textOrNull(`${'a'.repeat(199)}${emoji}${emoji}`, 200);
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.endsWith(emoji)).toBe(true);
    // Every character whole: no lone surrogate at the cut.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
    // 150 emoji are 300 units but only 150 code points: under the cap, kept whole.
    expect(textOrNull(emoji.repeat(150), 200)).toBe(emoji.repeat(150));
    expect(textOrNull('', 200)).toBeNull();
    expect(textOrNull(7, 200)).toBeNull();
  });
});

describe('buildSwitchRecord', () => {
  it('records the account main validated, from the facts', () => {
    const snap: SwitchSnapshot = {
      marks: { returned: 1 },
      spawnedAt: null,
      exitedAt: null,
      endedAt: 1,
      facts: { account: 'second' },
      ok: true,
      timedOut: false,
    };
    const ms = stepDurations(snap, undefined, { wallMs: 0, perfEpochMs: 0 });
    const ctx = { ts: '2026-01-02T03:04:05.000Z', sessionId: 'id-1', active: true };
    expect(buildSwitchRecord(ctx, undefined, snap, ms, {}).account).toBe('second');
    // A label main dropped (no such account) is null, never the raw string.
    const dropped = { ...snap, facts: { account: null } };
    expect(buildSwitchRecord(ctx, undefined, dropped, ms, {}).account).toBeNull();
  });

  it('says how the terminal was decided, and `none` when nothing was detected', () => {
    const snap = (facts: SwitchSnapshot['facts']): SwitchSnapshot => ({
      marks: { returned: 1 },
      spawnedAt: null,
      exitedAt: null,
      endedAt: 1,
      facts,
      ok: true,
      timedOut: false,
    });
    const ctx = { ts: '2026-01-02T03:04:05.000Z', sessionId: 'id-1', active: true };
    const build = (facts: SwitchSnapshot['facts']) => {
      const s = snap(facts);
      return buildSwitchRecord(ctx, undefined, s, stepDurations(s, undefined, { wallMs: 0, perfEpochMs: 0 }), {});
    };
    expect(build({ detectSrc: 'cache' }).detectSrc).toBe('cache');
    expect(build({ detectSrc: 'ps' }).detectSrc).toBe('ps');
    // A switch without a pid detects nothing.
    const noPid = build({});
    expect([noPid.kind, noPid.detectSrc]).toEqual(['switch', 'none']);
    // Neither does a resume: `openSession` detects for running sessions only.
    const resumed = snap({ tool: 'osascript', branch: 'new-tab' });
    const resume = buildSwitchRecord(
      { ...ctx, active: false },
      undefined,
      resumed,
      stepDurations(resumed, undefined, { wallMs: 0, perfEpochMs: 0 }),
      {},
    );
    expect([resume.kind, resume.detectSrc, resume.ms]).toEqual([
      'resume',
      'none',
      expect.objectContaining({ detect: null }),
    ]);
    // The version is not bumped for one added field.
    expect(build({ detectSrc: 'cache' }).v).toBe(2);
  });

  it('carries the listing counters only when the sample has them', () => {
    const snap: SwitchSnapshot = {
      marks: { returned: 1 },
      spawnedAt: null,
      exitedAt: null,
      endedAt: 1,
      facts: {},
      ok: true,
      timedOut: false,
    };
    const ms = stepDurations(snap, undefined, { wallMs: 0, perfEpochMs: 0 });
    const ctx = { ts: '2026-01-02T03:04:05.000Z', sessionId: 'id-1', active: true };
    const none = { n: 3, failed: 0, last: null };
    expect(buildSwitchRecord(ctx, undefined, snap, ms, { listings: none }).listings).toEqual(none);
    const failed = { n: 4, failed: 1, last: { reason: 'error EAGAIN', ms: 3, path: 'switch' } };
    expect(buildSwitchRecord(ctx, undefined, snap, ms, { listings: failed }).listings).toEqual(failed);
    expect('listings' in buildSwitchRecord(ctx, undefined, snap, ms, {})).toBe(false);
    expect('listings' in buildSwitchRecord(ctx, undefined, snap, ms, { listings: null })).toBe(false);
  });

  it('drops values of the wrong shape and cuts an overlong title', () => {
    const snap: SwitchSnapshot = {
      marks: {},
      spawnedAt: null,
      exitedAt: null,
      endedAt: 1,
      facts: {},
      ok: true,
      timedOut: false,
    };
    const ms = stepDurations(snap, undefined, { wallMs: 0, perfEpochMs: 0 });
    const r = buildSwitchRecord(
      {
        ts: '2026-01-02T03:04:05.000Z',
        sessionId: 'id-1',
        active: true,
        title: 't'.repeat(500),
        projectPath: '',
        pid: 12.5,
      },
      undefined,
      { ...snap, facts: { account: 42 as unknown as string } },
      ms,
      // A source without a tty is not a source.
      { tty: null, ttySrc: 'ps' },
    );
    expect((r.title as string).length).toBe(200);
    expect(r).toMatchObject({ account: null, project: null, pid: null, tty: null, ttySrc: null });
  });

  it('marks a resume and keeps unknowns as null rather than guessing', () => {
    const snap: SwitchSnapshot = {
      marks: { returned: 5 },
      spawnedAt: null,
      exitedAt: null,
      endedAt: 5,
      facts: {},
      ok: false,
      timedOut: false,
    };
    const ms = stepDurations(snap, undefined, { wallMs: 0, perfEpochMs: 0 });
    const r = buildSwitchRecord(
      { ts: '2026-01-02T03:04:05.000Z', sessionId: 'abcdefghijkl', active: false },
      undefined,
      snap,
      ms,
      { mainCpuMicros: { user: 12345, system: 678 } },
    );
    expect(r).toMatchObject({
      sessionId: 'abcdefghijkl',
      title: null,
      kind: 'resume',
      terminal: null,
      branch: null,
      tool: null,
      ok: false,
      cpuPct: null,
      mainCpuMs: { user: 12.3, system: 0.7 },
      load: [],
    });
  });
});

describe('scripts/switch-timing-summary.js', () => {
  it('interpolates percentiles and ignores non-numbers', () => {
    expect(summary.percentile([10, 20, 30, 40], 50)).toBe(25);
    expect(summary.percentile([40, 10, 30, 20, null, NaN, 'x'], 90)).toBeCloseTo(37, 10);
    expect(summary.percentile([7], 90)).toBe(7);
    expect(summary.percentile([], 50)).toBeNull();
  });

  it('computes a correlation only when there is something to correlate', () => {
    expect(summary.pearson([[1, 2], [2, 4], [3, 6]])).toBeCloseTo(1, 10);
    expect(summary.pearson([[1, 6], [2, 4], [3, 2]])).toBeCloseTo(-1, 10);
    expect(summary.pearson([[1, 2], [2, 4]])).toBeNull(); // too few
    expect(summary.pearson([[1, 5], [2, 5], [3, 5]])).toBeNull(); // no variance
    expect(summary.pearson([[1, 2], [null, 4], [3, 6], [4, 8]])).toBeCloseTo(1, 10);
  });

  it('skips malformed lines and groups what is left', () => {
    const rec = (terminal: string, branch: string | null, run: number, load1: number) =>
      JSON.stringify({
        v: 1,
        kind: 'switch',
        terminal,
        branch,
        ncpu: 10,
        load: [load1, 0, 0],
        ms: { run, total: run + 10 },
      });
    const text = [
      rec('iterm2', 'tty', 100, 2),
      '{"truncated": ',
      rec('iterm2', 'title', 300, 12),
      '',
      '"a string"',
      '{"v":1}',
      rec('ghostty', null, 900, 25),
    ].join('\n');
    const { records, malformed } = summary.parseLines(text);
    expect(records).toHaveLength(3);
    expect(malformed).toBe(3);
    const s = summary.summarize(records);
    expect(s.all.total).toEqual({ n: 3, p50: 310, p90: 790 });
    expect(s.all.detect.n).toBe(0);
    expect(s.byTerminal.map((g: { key: string; n: number }) => [g.key, g.n])).toEqual([
      ['iterm2', 2],
      ['ghostty', 1],
    ]);
    expect(s.byBranch.map((g: { key: string }) => g.key).sort()).toEqual(['title', 'tty', 'unknown']);
    expect(s.load.buckets.map((b: { n: number }) => b.n)).toEqual([1, 0, 1, 1]);
    expect(s.load.rTotalVsLoad1).toBeGreaterThan(0.9);
    const report = summary.formatReport(s, malformed);
    expect(report).toContain('3 switches');
    expect(report).toContain('3 malformed line(s) skipped');
  });

  it('groups running-session switches by how the terminal was decided, old lines included', () => {
    const rec = (kind: string, detectSrc: unknown, detect: number | null, total: number) => ({
      v: 2,
      kind,
      terminal: 'ghostty',
      ...(detectSrc === undefined ? {} : { detectSrc }),
      ms: { detect, run: total - 20, total },
    });
    const lines = [
      rec('switch', undefined, 2003, 5000), // written before the field existed
      rec('switch', undefined, 90, 700),
      rec('switch', 'cache', 0.4, 600),
      rec('switch', 'cache', 0.6, 800),
      rec('switch', 'ps', 70, 900),
      rec('switch', 'none', null, 500),
      rec('resume', 'none', null, 1500), // a resume is not in this table
      rec('resume', undefined, null, 1400),
    ].map((r) => JSON.stringify(r));
    const { records, malformed } = summary.parseLines(lines.join('\n'));
    expect(malformed).toBe(0);
    const s = summary.summarize(records);
    const groups = Object.fromEntries(
      s.byDetectSrc.map((g: { key: string; n: number; steps: { detect: unknown } }) => [
        g.key,
        [g.n, g.steps.detect],
      ]),
    );
    expect(groups).toEqual({
      '(not recorded)': [2, { n: 2, p50: 1046.5, p90: 1811.7 }],
      cache: [2, { n: 2, p50: 0.5, p90: 0.58 }],
      ps: [1, { n: 1, p50: 70, p90: 70 }],
      none: [1, { n: 0, p50: null, p90: null }],
    });
    const report = summary.formatReport(s);
    expect(report).toContain('by how the terminal was decided');
    expect(report).toMatch(/\(not recorded\)\s+2\b/);
    // A value that is not text makes the line malformed, like every text field.
    expect(summary.parseLines(JSON.stringify(rec('switch', 7, 1, 100))).malformed).toBe(1);
  });

  describe('process-listing counters', () => {
    const rec = (ts: string, listings?: unknown) => ({
      v: 2,
      ts,
      kind: 'switch',
      terminal: 'ghostty',
      detectSrc: 'cache',
      ...(listings === undefined ? {} : { listings }),
      ms: { detect: 0.5, run: 500, total: 520 },
    });
    const parse = (...rs: unknown[]) =>
      summary.parseLines(rs.map((r) => JSON.stringify(r)).join('\n'));

    it('prints one line from the newest record that has them', () => {
      const { records, malformed } = parse(
        rec('2026-01-01T10:00:00.000Z'), // written before the field existed
        rec('2026-01-03T10:00:00.000Z', {
          n: 40,
          failed: 3,
          last: { reason: 'timeout', ms: 10012.4, path: 'badge' },
        }),
        rec('2026-01-02T10:00:00.000Z', { n: 7, failed: 0, last: null }),
        rec('2026-01-04T10:00:00.000Z'), // newest of all, but without the field
      );
      expect(malformed).toBe(0);
      expect(records).toHaveLength(4);
      const s = summary.summarize(records);
      expect(s.listings).toEqual({
        n: 40,
        failed: 3,
        last: { reason: 'timeout', ms: 10012.4, path: 'badge' },
      });
      expect(summary.formatReport(s).split('\n')).toContain(
        'Process listings since the app started: 40, failed 3 (last: timeout, 10012 ms, badge)',
      );
    });

    it('prints no failure when there has been none', () => {
      const { records } = parse(rec('2026-01-02T10:00:00.000Z', { n: 7, failed: 0, last: null }));
      expect(summary.formatReport(summary.summarize(records)).split('\n')).toContain(
        'Process listings since the app started: 7, failed 0',
      );
    });

    it('takes the later line when two records share a time', () => {
      const { records } = parse(
        rec('2026-01-02T10:00:00.000Z', { n: 1, failed: 0, last: null }),
        rec('2026-01-02T10:00:00.000Z', { n: 2, failed: 0, last: null }),
      );
      expect(summary.summarize(records).listings).toMatchObject({ n: 2 });
    });

    it('prints nothing for a log written before the field existed, and still reads it', () => {
      const { records, malformed } = parse(
        rec('2026-01-01T10:00:00.000Z'),
        { v: 1, sid: 'deadbeef', kind: 'switch', terminal: 'ghostty', ms: { run: 50, total: 60 } },
        rec('2026-01-01T11:00:00.000Z', null),
      );
      expect(malformed).toBe(0);
      expect(records).toHaveLength(3);
      const s = summary.summarize(records);
      expect(s.listings).toBeNull();
      expect(summary.formatReport(s)).not.toContain('Process listings');
    });

    it('treats a value of the wrong shape as a malformed line', () => {
      for (const bad of [
        'a string',
        7,
        [],
        { n: '40', failed: 3, last: null },
        { n: 40, last: null },
        { n: 40, failed: 3, last: 'timeout' },
        { n: 40, failed: 3, last: { reason: 7, ms: 1, path: 'badge' } },
        { n: 40, failed: 3, last: { reason: 'timeout', ms: '1', path: 'badge' } },
        { n: 40, failed: 3, last: { reason: 'timeout', ms: 1, path: null } },
      ]) {
        const { records, malformed } = parse(rec('2026-01-02T10:00:00.000Z', bad));
        expect([records.length, malformed, JSON.stringify(bad)]).toEqual([0, 1, JSON.stringify(bad)]);
      }
    });

    it('strips escape sequences from what it prints', () => {
      const { records } = parse(
        rec('2026-01-02T10:00:00.000Z', {
          n: 1,
          failed: 1,
          last: { reason: 'error \u001b[31mX', ms: 5, path: 'bad\u001b[0mge' },
        }),
      );
      const report = summary.formatReport(summary.summarize(records));
      expect(report).not.toContain('\u001b');
      expect(report).toContain('Process listings since the app started: 1, failed 1 (last: error ');
    });
  });

  // Two v2 sessions and one v1 line, as a log that spans the version change.
  const mixed = () => {
    const v2 = (
      sessionId: string,
      title: string | null,
      account: string | null,
      project: string,
      branch: string,
      total: number,
    ) => ({
      v: 2,
      kind: 'switch',
      terminal: 'iterm2',
      sessionId,
      title,
      account,
      project,
      pid: 1,
      tty: 'ttys001',
      branch,
      ms: { run: total - 20, total },
    });
    return [
      { v: 1, sid: 'deadbeef', kind: 'switch', terminal: 'ghostty', branch: 'cwd', ms: { run: 50, total: 60 } },
      v2('aaaa1111-0000', 'first title', 'second', '/home/u/code/alpha', 'tty', 100),
      v2('bbbb2222-0000', null, null, '/home/u/code/beta', 'cwd', 2000),
      v2('aaaa1111-0000', 'renamed title', 'second', '/home/u/code/alpha', 'tty', 300),
      v2('aaaa1111-0000', 'renamed title', 'second', '/home/u/code/alpha', 'cwd', 200),
    ];
  };

  it('groups per session from v2 lines and keeps v1 lines in every other grouping', () => {
    const s = summary.summarize(mixed());
    expect(s.count).toBe(5);
    expect(s.unnamed).toBe(1);
    expect(s.sessions).toHaveLength(2);
    expect(s.sessions[0]).toMatchObject({
      sessionId: 'aaaa1111-0000',
      title: 'renamed title', // the latest one
      account: 'second',
      project: '/home/u/code/alpha',
      terminals: ['iterm2'],
      n: 3,
      totalP50: 200,
      totalP90: 280,
      runP50: 180,
      branches: 'tty×2 cwd×1',
    });
    expect(s.sessions[1]).toMatchObject({ sessionId: 'bbbb2222-0000', title: null, account: '(none)', n: 1 });
    // A v2 line without a label had no account; the v1 line never said.
    // Neither is "the anchor", which has a label like every account.
    expect(s.byAccount.map((g: { key: string; n: number }) => [g.key, g.n])).toEqual([
      ['second', 3],
      ['(unknown)', 1],
      ['(none)', 1],
    ]);
    expect(s.byTerminal.find((g: { key: string }) => g.key === 'ghostty').n).toBe(1);
    const report = summary.formatReport(s);
    expect(report).toContain('By session (2 of 2, sorted by switches; 1 older record(s) do not name a session)');
    expect(report).toContain('(no title)');
  });

  it('sorts sessions by p90 total on request, and caps the table unless --all', () => {
    const byP90 = summary.summarize(mixed(), { sort: 'p90' });
    expect(byP90.sessions.map((r: { sessionId: string }) => r.sessionId)).toEqual([
      'bbbb2222-0000',
      'aaaa1111-0000',
    ]);
    const many = Array.from({ length: 25 }, (_, i) => ({
      v: 2,
      sessionId: `id-${String(i).padStart(2, '0')}`,
      terminal: 'iterm2',
      branch: 'tty',
      ms: { total: i },
    }));
    const s = summary.summarize(many);
    const capped = summary.formatReport(s, 0, {});
    expect(capped).toContain('By session (20 of 25');
    expect(capped).toContain('--all lists every session');
    expect(summary.formatReport(s, 0, { all: true })).toContain('By session (25 of 25');
  });

  it('redacts ids, titles, accounts and paths to placeholders that are stable for a log', () => {
    const once = summary.redactRecords(mixed());
    expect(once).toEqual(summary.redactRecords(mixed())); // same log, same names
    expect(once.map((r: { sessionId?: string }) => r.sessionId)).toEqual([
      undefined,
      'session-1',
      'session-2',
      'session-1',
      'session-1',
    ]);
    expect(once[1]).toMatchObject({
      title: 'title of session-1',
      account: 'account-1',
      project: '~/project-1',
      tty: 'ttys001',
      branch: 'tty',
      ms: { total: 100 },
    });
    // One session keeps one name through a rename; "no title" stays visible.
    expect(once[3].title).toBe('title of session-1');
    expect(once[2]).toMatchObject({ title: null, account: null, project: '~/project-2' });
    expect(once[0].sid).toBe('redacted');
    const report = summary.formatReport(summary.summarize(once), 0, { redact: true });
    for (const secret of ['aaaa1111', 'bbbb2222', 'deadbeef', 'renamed', 'first title', 'alpha', 'beta', 'second']) {
      expect(report).not.toContain(secret);
    }
    expect(report).toContain('Redacted:');
    expect(report).toContain('session-1');
    expect(report).toContain('~/project-2');
    // Same grouping as the unredacted log: redaction renames, it does not merge.
    expect(summary.summarize(once).sessions.map((r: { n: number }) => r.n)).toEqual([3, 1]);
  });

  it('keeps every redacted placeholder distinct past session-9', () => {
    // `session-10` … `session-12` used to be clipped to one label.
    const many = Array.from({ length: 12 }, (_, i) => ({
      v: 2,
      sessionId: `real-id-${i}`,
      title: `private ${i}`,
      account: `acct-${i}`,
      project: `/home/u/code/p${i}`,
      terminal: 'iterm2',
      branch: 'tty',
      ms: { total: 100 + i, run: 90 },
    }));
    const report: string = summary.formatReport(
      summary.summarize(summary.redactRecords(many)),
      0,
      { redact: true, all: true },
    );
    const rows = report.split('\n').filter((l) => /^ {2}session-\d+ /.test(l));
    const labels = rows.map((l) => l.trim().split(/\s+/)[0]);
    expect(labels).toHaveLength(12);
    expect(new Set(labels).size).toBe(12);
    expect(labels).toContain('session-10');
    expect(labels).toContain('session-12');
    for (const n of [10, 11, 12]) {
      expect(report).toContain(`account-${n}`);
      expect(report).toContain(`~/project-${n}`);
    }
    expect(report).not.toContain('…');
  });

  it('lengthens real id labels until no two sessions share one', () => {
    const labels = summary.sessionLabels(['abcdefgh-1111', 'abcdefgh-1222', 'zzzzzzzz-9999'], false);
    expect([...labels.values()]).toEqual(['abcdefgh-11', 'abcdefgh-12', 'zzzzzzzz-99']);
    expect([...summary.sessionLabels(['abcdefgh-1111', 'zzzzzzzz-9999'], false).values()]).toEqual([
      'abcdefgh',
      'zzzzzzzz',
    ]);
  });

  it('strips control characters from every field it prints', () => {
    const ESC = '\u001b';
    const hostile = {
      v: 2,
      sessionId: `id${ESC}[2J-0001`,
      // An OSC title-set, a forged row via newline, a C1 CSI, a bidi override.
      title: `ok${ESC}]0;pwned\u0007\n  forged-row  99\u009b31m\u202e`,
      account: `acc\rount`,
      project: `/home/u/co\u0000de${ESC}[31m`,
      terminal: `iterm2${ESC}[1m`,
      branch: `tty\n  fake`,
      kind: `switch\u007f`,
      ms: { total: 100, run: 90 },
    };
    const clean = { ...hostile, sessionId: 'id-0002', title: 'fine', branch: 'tty', kind: 'switch' };
    const report: string = summary.formatReport(summary.summarize([hostile, clean]), 0, { all: true });
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(report)).toBe(false);
    // The newline in the title did not become a line of its own.
    expect(report.split('\n').filter((l) => l.includes('forged-row'))).toHaveLength(1);
    expect(report.split('\n').some((l) => /^\s*forged-row/.test(l))).toBe(false);
    expect(report.split('\n').some((l) => /^\s*fake/.test(l))).toBe(false);
    expect(summary.safeText(`a${ESC}[31mb\u009b\u007fc\n`)).toBe('a[31mbc');
    expect(summary.safeText(null)).toBe('');
    // The three direction marks: invisible, and they reorder what follows.
    const marks = [0x061c, 0x200e, 0x200f].map((c) => String.fromCharCode(c)).join('');
    expect(summary.safeText(`a${marks}b`)).toBe('ab');
    // Same for --redact, whose placeholders are safe but whose other fields are the log's.
    const redacted: string = summary.formatReport(
      summary.summarize(summary.redactRecords([hostile, clean])),
      0,
      { redact: true },
    );
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(redacted)).toBe(false);
  });

  it('clips by code point and never through a character', () => {
    const emoji = '\u{1F600}';
    expect(summary.clip(emoji.repeat(5), 5)).toBe(emoji.repeat(5));
    expect(summary.clip(emoji.repeat(6), 5)).toBe(`${emoji.repeat(4)}…`);
    expect(summary.clip('abcdef', 4)).toBe('abc…');
  });

  it('abbreviates the home directory only at a path boundary', () => {
    expect(summary.tildePath('/Users/al/code/x', '/Users/al')).toBe('~/code/x');
    expect(summary.tildePath('/Users/al', '/Users/al')).toBe('~');
    expect(summary.tildePath('/Users/al-work/code/x', '/Users/al')).toBe('/Users/al-work/code/x');
    expect(summary.tildePath('/Users/al/code/x', '/Users/al/')).toBe('~/code/x');
    expect(summary.tildePath('/srv/x', '')).toBe('/srv/x');
  });

  it('says how many records a percentile covers when it is not all of them', () => {
    const rec = (kind: string, ms: Record<string, number>, timedOut = false) => ({
      v: 2,
      sessionId: 'one',
      kind,
      terminal: 'iterm2',
      branch: 'tty',
      timedOut,
      ms,
    });
    const records = [
      rec('switch', { detect: 20, run: 100, total: 130 }),
      rec('switch', { detect: 40, run: 300, total: 350 }),
      rec('resume', { run: 500, total: 520 }),
      // A hung command: only what main measured. A stray total must not count.
      rec('switch', { detect: 30, returned: 35, total: 15000 }, true),
    ];
    const s = summary.summarize(records);
    expect(s.timedOut).toBe(1);
    expect(s.slow).toBe(0);
    expect(s.all.total).toEqual({ n: 3, p50: 350, p90: 486 });
    expect(s.all.detect.n).toBe(3);
    expect(s.sessions[0]).toMatchObject({ n: 4, totalN: 3, runN: 3, totalP50: 350 });
    const report: string = summary.formatReport(s, 0, {});
    const all = report.split('\n').find((l) => /^ {2}all\s/.test(l));
    // n is 4; detect and total each cover 3 and say so.
    expect(all).toMatch(/^ {2}all\s+4\s/);
    expect(all).toContain('30/38 (3)');
    expect(all).toContain('350/486 (3)');
    // The resume group's one record has every step it could: no marker, and no detect at all.
    const resume = report.split('\n').find((l) => /^ {2}resume\s/.test(l));
    expect(resume).not.toContain('(');
    expect(resume).toContain('520/520');
    const session = report.split('\n').find((l) => /^ {2}one\s/.test(l));
    expect(session).toContain('350/486 (3)');
  });

  it('counts a line with a wrong-typed field as malformed, by one rule for every text field', () => {
    const good = { v: 2, kind: 'switch', terminal: 'iterm2', branch: null, ms: { total: 5, run: 4 } };
    const bad = [
      { ...good, kind: { toString: null } }, // String() of this throws
      { ...good, terminal: 7 },
      { ...good, branch: ['tty'] },
      { ...good, account: {} },
      { ...good, sessionId: 12345 },
      { ...good, title: true },
      { ...good, project: { path: '/x' } },
      { ...good, tty: 4 },
      { ...good, sid: [] },
      // A status flag that is not a boolean: `"true"` is not `true`, and
      // reading it as "not killed" would put the row among the completed.
      { ...good, killed: 'true' },
      { ...good, ok: 0 },
      { ...good, timedOut: 'false' },
      { ...good, untimed: 1 },
      { ...good, ms: [] }, // an array is not a set of steps
      { ...good, ms: 'fast' },
      [good],
    ];
    const text = [good, ...bad].map((r) => JSON.stringify(r)).join('\n');
    const { records, malformed } = summary.parseLines(text);
    expect(records).toEqual([good]);
    expect(malformed).toBe(bad.length);
    // Real booleans, and an absent or null flag, are fine.
    const flagged = { ...good, ok: false, timedOut: false, killed: true, untimed: null };
    expect(summary.parseLines(JSON.stringify(flagged)).records).toEqual([flagged]);
    // And what is accepted cannot make the report throw.
    expect(() => summary.formatReport(summary.summarize(records), malformed, {})).not.toThrow();
  });

  it('keeps switches that did not complete out of run, main and total, and counts each kind', () => {
    const rec = (over: Record<string, unknown>, ms: Record<string, number | null>) => ({
      v: 2,
      sessionId: 'one',
      kind: 'switch',
      terminal: 'ghostty',
      tool: 'osascript',
      branch: 'tty',
      ms: { settings: 1, ...ms },
      ...over,
    });
    const records = [
      rec({}, { run: 100, main: 110, total: 120 }),
      rec({}, { run: 300, main: 310, total: 320 }),
      // Killed at the 5 s limit: a real wait, not a switch. Excluded for
      // being killed, whatever `ok` says.
      rec({ killed: true, branch: null }, { run: 5000, main: 5010, total: 5020 }),
      // A launch that failed.
      rec({ ok: false }, { run: 900, main: 910, total: 920 }),
      // Handed to another app: flagged, and an older line recognised by its tool.
      rec({ untimed: true, tool: 'open', terminal: 'vscode' }, { returned: 3, main: null, total: null }),
      rec({ tool: 'pty', terminal: 'codev' }, { returned: 2, main: 2, total: 4 }),
    ];
    const s = summary.summarize(records);
    expect(s).toMatchObject({ count: 6, killed: 1, failed: 1, untimed: 2, timedOut: 0, slow: 0 });
    // The writer marks a killed switch `ok: false`, and a launch that failed
    // before its command started is untimed as well as failed. Each switch
    // is still counted once: timed out, else killed, else failed, else untimed.
    const overlapping = [
      ...records,
      rec({ killed: true, ok: false }, { run: 5000, main: 5010, total: 5020 }),
      rec({ timedOut: true, ok: false }, { returned: 3 }),
      rec({ untimed: true, ok: false }, { returned: 3 }),
    ];
    const o = summary.summarize(overlapping);
    expect(o).toMatchObject({ count: 9, timedOut: 1, killed: 2, failed: 2, untimed: 2 });
    const completedCount = o.all.total.n;
    expect(completedCount).toBe(2);
    expect(o.timedOut + o.killed + o.failed + o.untimed + completedCount).toBe(o.count);
    expect(s.all.total).toEqual({ n: 2, p50: 220, p90: 300 });
    expect(s.all.run).toEqual({ n: 2, p50: 200, p90: 280 });
    expect(s.all.main.n).toBe(2);
    // Steps before the exit are still everyone's.
    expect(s.all.settings.n).toBe(6);
    expect(s.runShareP50).toBeCloseTo((100 / 120 + 300 / 320) / 2, 10);
    const report: string = summary.formatReport(s, 0, {});
    expect(report).toContain('1 killed by their timeout');
    expect(report).toContain('2 not timed end to end');
  });

  it('survives a log with more sessions than a call takes arguments', () => {
    // `Math.max(...rows)` throws RangeError somewhere past 100k arguments.
    const n = 300_000;
    const ids = Array.from({ length: n }, (_, i) => `id-${String(i).padStart(8, '0')}`);
    const labels = summary.sessionLabels(ids, false);
    expect(labels.size).toBe(n);
    expect(labels.get(ids[n - 1])).toBe(ids[n - 1]);
    const table: string = summary.renderTable(
      ['a', 'b'],
      ids.map((id) => [id, 'x']),
    );
    expect(table.split('\n')).toHaveLength(n + 1);
  });

  it('tells a missing input from one that exists and cannot be read', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-summary-'));
    try {
      const good = path.join(dir, 'good.jsonl');
      fs.writeFileSync(good, '{"ms":{"total":5}}\n');
      const missing = path.join(dir, 'nope.jsonl');
      const unreadable = path.join(dir, 'a-directory'); // reading it fails with EISDIR
      fs.mkdirSync(unreadable);
      const r = summary.readFiles([missing, unreadable, good]);
      expect(r.missing).toEqual([0]);
      expect(r.unreadable).toEqual([{ index: 1, code: 'EISDIR' }]);
      expect(summary.parseLines(r.text).records).toHaveLength(1);

      // The default run: `.1` readable, the live log not. It must say so.
      const script = path.join(__dirname, '..', 'scripts', 'switch-timing-summary.js');
      const plain = spawnSync(process.execPath, [script, good, unreadable], { encoding: 'utf-8' });
      expect(plain.status).toBe(1);
      expect(plain.stderr).toContain(`cannot read ${unreadable} (EISDIR): the report is incomplete`);
      expect(plain.stdout).toContain('Incomplete: 1 input file(s) exist but could not be read.');
      expect(plain.stdout).toContain('1 switches');

      // Redacted: the input is named by position, never by path.
      const redacted = spawnSync(process.execPath, [script, '--redact', good, unreadable, missing], {
        encoding: 'utf-8',
      });
      expect(redacted.stderr).toContain('cannot read input 2 (EISDIR)');
      expect(redacted.stderr).toContain('cannot read input 3: no such file');
      expect(redacted.stderr + redacted.stdout).not.toContain(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses flags apart from files and rejects an unknown one', () => {
    expect(summary.parseArgs(['--redact', 'a.jsonl', '--sort=p90', '--all'])).toMatchObject({
      redact: true,
      all: true,
      sort: 'p90',
      files: ['a.jsonl'],
      bad: [],
    });
    expect(summary.parseArgs(['--redacted']).bad).toEqual(['--redacted']);
  });

  it('reports an empty log instead of failing', () => {
    const { records, malformed } = summary.parseLines('');
    expect(summary.formatReport(summary.summarize(records), malformed)).toBe('No switch records.');
  });
});
