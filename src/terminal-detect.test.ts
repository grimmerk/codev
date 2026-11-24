import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectTerminal,
  detectTerminals,
  readRegisteredStart,
  resolveSwitchTerminal,
} from './terminal-detect';
import { createTerminalCache, TerminalCache } from './terminal-detect-cache';

const START_A = 'Tue Nov  3 07:06:18 2026';
const START_B = 'Wed Nov  4 11:30:02 2026';

// Invented names; the shape is that of a real listing (see process-tree.test.ts).
const listing = (claudeStart = START_A) =>
  [
    '    1     0 Mon Nov  2 14:19:51 2026     /sbin/launchd',
    ' 4249     1 Mon Nov  2 14:22:03 2026     /Applications/Ghostty.app/Contents/MacOS/ghostty',
    ' 7547  4249 Tue Nov  3 07:06:13 2026     -/bin/zsh',
    `10251  7547 ${claudeStart}     claude`,
    '86698     1 Tue Nov  3 09:00:00 2026     /Applications/iTerm.app/Contents/MacOS/iTerm2',
    '86720 86698 Tue Nov  3 09:00:09 2026     claude',
    ' 3000     1 Tue Nov  3 13:00:00 2026     /opt/tools/Electron.app/Contents/MacOS/Electron',
    ' 3002  3000 Tue Nov  3 13:00:05 2026     claude',
    ' 5002     1 Tue Nov  3 14:00:05 2026     claude',
  ].join('\n');

/** Deps that count their spawns. */
const harness = (over: { ps?: () => Promise<string>; starts?: Record<number, string | null> } = {}) => {
  const calls = { ps: 0, psCommand: [] as number[][] };
  const cache = createTerminalCache();
  const starts: Record<number, string | null> = over.starts ?? {};
  return {
    calls,
    cache,
    starts,
    deps: {
      cache,
      ps: () => {
        calls.ps++;
        return over.ps ? over.ps() : Promise.resolve(listing());
      },
      psCommand: (pids: number[]) => {
        calls.psCommand.push(pids);
        return Promise.resolve(' 3000 /opt/tools/Electron.app/Contents/MacOS/Electron /src/CodeV\n');
      },
      registeredStart: (pid: number) => starts[pid] ?? null,
    },
  };
};

describe('terminal cache', () => {
  let cache: TerminalCache;
  beforeEach(() => {
    cache = createTerminalCache();
  });

  it('returns an entry only for the same pid AND the same start time', () => {
    cache.put(10251, START_A, 'ghostty');
    expect(cache.get(10251, START_A)).toBe('ghostty');
    // The start is compared with its spaces squashed, as `lstart` pads the day.
    expect(cache.get(10251, 'Tue Nov 3 07:06:18 2026')).toBe('ghostty');
    expect(cache.get(10252, START_A)).toBeNull();
  });

  it('misses for a recycled pid: same number, another start time', () => {
    cache.put(10251, START_A, 'ghostty');
    expect(cache.get(10251, START_B)).toBeNull();
  });

  it('misses when the caller cannot say when the process started', () => {
    cache.put(10251, START_A, 'ghostty');
    expect(cache.get(10251, null)).toBeNull();
    expect(cache.get(10251, undefined)).toBeNull();
    expect(cache.get(10251, '')).toBeNull();
    expect(cache.get(10251, '   ')).toBeNull();
  });

  it("never stores 'unknown', an empty terminal, a missing start or a bad pid", () => {
    cache.put(10251, START_A, 'unknown');
    cache.put(10252, START_A, '');
    cache.put(10253, '', 'ghostty');
    cache.put(10254, null, 'ghostty');
    cache.put(10255, undefined, 'ghostty');
    cache.put(0, START_A, 'ghostty');
    cache.put(1, START_A, 'ghostty');
    cache.put(-5, START_A, 'ghostty');
    cache.put(1.5, START_A, 'ghostty');
    expect(cache.size()).toBe(0);
    expect(cache.get(10251, START_A)).toBeNull();
  });

  it("keeps a known answer when a later detection of the same process is 'unknown'", () => {
    cache.put(10251, START_A, 'ghostty');
    cache.put(10251, START_A, 'unknown');
    expect(cache.get(10251, START_A)).toBe('ghostty');
  });

  it('replaces the entry when the pid is detected again under a new start', () => {
    cache.put(10251, START_A, 'ghostty');
    cache.put(10251, START_B, 'iterm2');
    expect(cache.get(10251, START_A)).toBeNull();
    expect(cache.get(10251, START_B)).toBe('iterm2');
    expect(cache.size()).toBe(1);
  });

  it('drops the oldest entry past its limit', () => {
    const small = createTerminalCache(2);
    small.put(11, START_A, 'ghostty');
    small.put(12, START_A, 'iterm2');
    small.put(11, START_A, 'ghostty'); // refreshed: 12 is now the oldest
    small.put(13, START_A, 'cmux');
    expect(small.size()).toBe(2);
    expect(small.get(12, START_A)).toBeNull();
    expect(small.get(11, START_A)).toBe('ghostty');
    expect(small.get(13, START_A)).toBe('cmux');
  });
});

describe('detectTerminals', () => {
  it('answers for every pid from ONE listing', async () => {
    const h = harness();
    const got = await detectTerminals([10251, 86720, 5002, 424242], h.deps);
    expect(Object.fromEntries(got)).toEqual({
      10251: 'ghostty',
      86720: 'iterm2',
      5002: 'unknown',
      424242: 'unknown',
    });
    expect(h.calls.ps).toBe(1);
    expect(h.calls.psCommand).toEqual([]);
  });

  it('runs nothing for no pids', async () => {
    const h = harness();
    expect((await detectTerminals([], h.deps)).size).toBe(0);
    expect(h.calls.ps).toBe(0);
  });

  it('remembers what it found, with the start time from the listing, and not unknowns', async () => {
    const h = harness();
    await detectTerminals([10251, 5002, 424242], h.deps);
    expect(h.cache.size()).toBe(1);
    expect(h.cache.get(10251, START_A)).toBe('ghostty');
    expect(h.cache.get(5002, 'Tue Nov  3 14:00:05 2026')).toBeNull();
  });

  it('fetches a command line only for an Electron ancestor, once', async () => {
    const h = harness();
    const got = await detectTerminals([3002, 10251], h.deps);
    expect(got.get(3002)).toBe('codev');
    expect(got.get(10251)).toBe('ghostty');
    expect(h.calls.ps).toBe(1);
    expect(h.calls.psCommand).toEqual([[3000]]);
  });

  it('walks past an Electron whose command line could not be read', async () => {
    const h = harness();
    const got = await detectTerminals([3002], {
      ...h.deps,
      psCommand: () => Promise.reject(new Error('ps failed')),
    });
    expect(got.get(3002)).toBe('unknown');
  });

  it("gives 'unknown' when the listing fails, is empty or throws", async () => {
    for (const ps of [
      () => Promise.resolve(''),
      () => Promise.reject(new Error('killed by its timeout')),
      () => {
        throw new Error('spawn failed');
      },
    ]) {
      const h = harness({ ps });
      expect(await detectTerminal(10251, h.deps)).toBe('unknown');
      expect(h.cache.size()).toBe(0);
    }
  });

  it('answers from the cache when the listing fails, for a process it can prove', async () => {
    const h = harness({ ps: () => Promise.resolve(''), starts: { 10251: START_A, 86720: START_B } });
    h.cache.put(10251, START_A, 'ghostty');
    h.cache.put(86720, START_A, 'iterm2'); // the registration now states another start
    const got = await detectTerminals([10251, 86720], h.deps);
    expect(got.get(10251)).toBe('ghostty');
    expect(got.get(86720)).toBe('unknown');
  });
});

describe('resolveSwitchTerminal', () => {
  it('detects with one listing the first time, then answers from the cache with none', async () => {
    const h = harness({ starts: { 10251: START_A } });
    expect(await resolveSwitchTerminal(10251, h.deps)).toEqual({ terminal: 'ghostty', src: 'ps' });
    expect(h.calls.ps).toBe(1);
    expect(await resolveSwitchTerminal(10251, h.deps)).toEqual({ terminal: 'ghostty', src: 'cache' });
    expect(h.calls.ps).toBe(1);
  });

  it('uses what a badge detection found', async () => {
    const h = harness({ starts: { 86720: 'Tue Nov  3 09:00:09 2026' } });
    await detectTerminals([10251, 86720], h.deps);
    expect(await resolveSwitchTerminal(86720, h.deps)).toEqual({ terminal: 'iterm2', src: 'cache' });
    expect(h.calls.ps).toBe(1);
  });

  it('detects again when the pid was reused: the registration states another start', async () => {
    const h = harness({ starts: { 10251: START_A } });
    await resolveSwitchTerminal(10251, h.deps);
    // The same pid now belongs to a process started later, in iTerm2.
    h.starts[10251] = START_B;
    const reused = [
      '86698     1 Tue Nov  3 09:00:00 2026     /Applications/iTerm.app/Contents/MacOS/iTerm2',
      `10251 86698 ${START_B}     claude`,
    ].join('\n');
    const got = await resolveSwitchTerminal(10251, { ...h.deps, ps: () => Promise.resolve(reused) });
    expect(got).toEqual({ terminal: 'iterm2', src: 'ps' });
    // …and the entry now describes the new process.
    expect(h.cache.get(10251, START_A)).toBeNull();
    expect(h.cache.get(10251, START_B)).toBe('iterm2');
  });

  it('detects when no registration states a start, however full the cache', async () => {
    const h = harness();
    h.cache.put(10251, START_A, 'iterm2'); // would be wrong: the listing says ghostty
    expect(await resolveSwitchTerminal(10251, h.deps)).toEqual({ terminal: 'ghostty', src: 'ps' });
    expect(h.calls.ps).toBe(1);
  });

  it("does not remember 'unknown': the next switch detects again", async () => {
    let fail = true;
    const h = harness({
      ps: () => Promise.resolve(fail ? '' : listing()),
      starts: { 10251: START_A },
    });
    expect(await resolveSwitchTerminal(10251, h.deps)).toEqual({ terminal: 'unknown', src: 'ps' });
    fail = false;
    expect(await resolveSwitchTerminal(10251, h.deps)).toEqual({ terminal: 'ghostty', src: 'ps' });
    expect(h.calls.ps).toBe(2);
  });

  it('falls back to a detection when the cache or the registration read throws', async () => {
    const h = harness();
    const broken: TerminalCache = {
      get: () => {
        throw new Error('broken cache');
      },
      put: () => {
        throw new Error('broken cache');
      },
      clear: () => undefined,
      size: () => 0,
    };
    // A cache that throws on store loses the memory, not the answer.
    expect(await resolveSwitchTerminal(10251, { ...h.deps, cache: broken })).toEqual({
      terminal: 'ghostty',
      src: 'ps',
    });
    expect(
      await resolveSwitchTerminal(10251, {
        ...h.deps,
        registeredStart: () => {
          throw new Error('unreadable');
        },
      }),
    ).toEqual({ terminal: 'ghostty', src: 'ps' });
  });

  it('never rejects', async () => {
    const h = harness({
      ps: () => {
        throw new Error('spawn failed');
      },
    });
    await expect(resolveSwitchTerminal(10251, h.deps)).resolves.toEqual({
      terminal: 'unknown',
      src: 'ps',
    });
  });
});

describe('readRegisteredStart', () => {
  let root: string;
  let a: string;
  let b: string;
  const write = (dir: string, pid: number, body: unknown) => {
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'sessions', `${pid}.json`),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-detect-'));
    a = path.join(root, 'account-a');
    b = path.join(root, 'account-b');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads the start of the one registration for the pid', () => {
    write(b, 10251, { pid: 10251, sessionId: 's', procStart: START_A });
    expect(readRegisteredStart(10251, [a, b])).toBe('Tue Nov 3 07:06:18 2026');
  });

  it('is null when no account has the file', () => {
    expect(readRegisteredStart(10251, [a, b])).toBeNull();
    expect(readRegisteredStart(10251, [])).toBeNull();
  });

  it('is null for a registration without a start time (older Claude Code)', () => {
    write(a, 10251, { pid: 10251, sessionId: 's' });
    expect(readRegisteredStart(10251, [a, b])).toBeNull();
    write(a, 10251, { pid: 10251, sessionId: 's', procStart: '  ' });
    expect(readRegisteredStart(10251, [a, b])).toBeNull();
  });

  it('is null when two accounts disagree: one file is a leftover of an earlier process', () => {
    write(a, 10251, { pid: 10251, sessionId: 'old', procStart: START_A });
    write(b, 10251, { pid: 10251, sessionId: 'new', procStart: START_B });
    expect(readRegisteredStart(10251, [a, b])).toBeNull();
    expect(readRegisteredStart(10251, [b, a])).toBeNull();
  });

  it('is null when a leftover without a start sits beside a good one', () => {
    write(a, 10251, { pid: 10251, sessionId: 'new', procStart: START_A });
    write(b, 10251, { pid: 10251, sessionId: 'old' });
    expect(readRegisteredStart(10251, [a, b])).toBeNull();
  });

  it('is null for a file that names another pid, or is not JSON', () => {
    write(a, 10251, { pid: 999, sessionId: 's', procStart: START_A });
    expect(readRegisteredStart(10251, [a])).toBeNull();
    write(a, 10251, '{"pid": 10251, "procSt');
    expect(readRegisteredStart(10251, [a])).toBeNull();
  });
});
