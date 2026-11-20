import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  branchFromSwitchOutput,
  buildSwitchRecord,
  cpuPercentBetween,
  createSwitchTiming,
  isSlowSwitch,
  parseTopCpu,
  sanitizeStamp,
  shouldRotate,
  stepDurations,
  SwitchSnapshot,
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
    expect(timedOut.total).toBeNull();
    expect(timedOut.run).toBeNull();
    expect(timedOut.clickToIpc).toBeNull();
    expect(isSlowSwitch(timedOut)).toBe(false);
    // Without a stamp the total is main's own span, not a guess.
    const noStamp = stepDurations(snap({ marks: { returned: 5 }, endedAt: 5 }), undefined, ipc);
    expect(noStamp.total).toBe(5);
  });

  it('does not let a renderer clock that runs ahead shorten the total', () => {
    const ahead = { ...stamp, wallMs: ipc.wallMs + 50 };
    const ms = stepDurations(snap({ marks: { returned: 20 }, endedAt: 20 }), ahead, ipc);
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

  const runSwitch = (
    stamp: unknown,
    deps: { sysctl?: () => Promise<string>; psTop?: () => Promise<string> } = {},
  ) =>
    new Promise<Record<string, unknown> | null>((resolve) => {
      const timing = startSwitchTiming(
        '0f1e2d3c-aaaa-bbbb-cccc-123456789abc',
        true,
        stamp,
        {
          filePath: file,
          sysctl: async () =>
            'total = 2048.00M  used = 512.50M  free = 1535.50M  (encrypted)\n2\n',
          psTop: async () => ' 91.0 /usr/libexec/somed\n  1.0 /bin/zsh\n',
          ...deps,
          onWritten: resolve,
        },
      );
      timing.set({ configured: 'iterm2', terminal: 'ghostty', order: 'tty-first' });
      timing.mark('settings');
      timing.mark('script');
      timing.spawned();
      timing.settle(true);
      timing.exited('found-by-title\n');
    });

  it('writes one line per switch, with no trace of the session beyond an id prefix', async () => {
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
      v: 1,
      sid: '0f1e2d3c',
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
    expect(lines[0]).not.toContain('aaaa-bbbb');
    expect(onDisk.ms.total).toBeGreaterThanOrEqual(0);
    expect(onDisk.load).toHaveLength(3);
    expect(onDisk.ncpu).toBe(os.cpus().length);
    // A fast switch does not pay for `ps`, and has no `top`.
    expect(psCalls).toBe(0);
    expect('top' in onDisk).toBe(false);
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

describe('buildSwitchRecord', () => {
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
      sid: 'abcdefgh',
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

  it('reports an empty log instead of failing', () => {
    const { records, malformed } = summary.parseLines('');
    expect(summary.formatReport(summary.summarize(records), malformed)).toBe('No switch records.');
  });
});
