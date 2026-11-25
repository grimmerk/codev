import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BACKGROUND_LISTING_TIMEOUT_MS,
  classifyListing,
  detectTerminal,
  detectTerminals,
  getListingStats,
  listingTimeoutFor,
  PsRun,
  readRegisteredStart,
  resetListingStats,
  resolveSwitchTerminal,
  SWITCH_LISTING_TIMEOUT_MS,
} from './terminal-detect';
import { createTerminalCache, TerminalCache } from './terminal-detect-cache';

// The module's own runner calls `execFile`; the tests of that runner drive
// its callback by hand. Every other test injects `ps`, so nothing is spawned.
const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock }));

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

// A failed listing warns once; the tests that fail one on purpose read the
// spy, and nothing reaches the test output.
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetListingStats();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

/** Deps that count their spawns and keep the timeout each one was given. */
const harness = (
  over: { ps?: () => Promise<string | PsRun>; starts?: Record<number, string | null> } = {},
) => {
  const calls = { ps: 0, psCommand: [] as number[][], timeouts: [] as number[] };
  const cache = createTerminalCache();
  const starts: Record<number, string | null> = over.starts ?? {};
  return {
    calls,
    cache,
    starts,
    deps: {
      cache,
      ps: (timeoutMs: number) => {
        calls.ps++;
        calls.timeouts.push(timeoutMs);
        return over.ps ? over.ps() : Promise.resolve(listing());
      },
      psCommand: (pids: number[], timeoutMs: number) => {
        calls.psCommand.push(pids);
        calls.timeouts.push(timeoutMs);
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
    const got = await detectTerminals([10251, 86720, 5002, 424242], 'badge', h.deps);
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
    expect((await detectTerminals([], 'badge', h.deps)).size).toBe(0);
    expect(h.calls.ps).toBe(0);
  });

  it('remembers what it found, with the start time from the listing, and not unknowns', async () => {
    const h = harness();
    await detectTerminals([10251, 5002, 424242], 'badge', h.deps);
    expect(h.cache.size()).toBe(1);
    expect(h.cache.get(10251, START_A)).toBe('ghostty');
    expect(h.cache.get(5002, 'Tue Nov  3 14:00:05 2026')).toBeNull();
  });

  it('fetches a command line only for an Electron ancestor, once', async () => {
    const h = harness();
    const got = await detectTerminals([3002, 10251], 'badge', h.deps);
    expect(got.get(3002)).toBe('codev');
    expect(got.get(10251)).toBe('ghostty');
    expect(h.calls.ps).toBe(1);
    expect(h.calls.psCommand).toEqual([[3000]]);
  });

  it('walks past an Electron whose command line could not be read', async () => {
    const h = harness();
    const got = await detectTerminals([3002], 'badge', {
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
    const got = await detectTerminals([10251, 86720], 'badge', h.deps);
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
    await detectTerminals([10251, 86720], 'badge', h.deps);
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

describe('the timeout each path gives its listing', () => {
  it('is 2 s for a switch and 10 s for background work', () => {
    expect(SWITCH_LISTING_TIMEOUT_MS).toBe(2000);
    expect(BACKGROUND_LISTING_TIMEOUT_MS).toBe(10000);
    expect(listingTimeoutFor('switch')).toBe(2000);
    expect(listingTimeoutFor('badge')).toBe(10000);
    expect(listingTimeoutFor('crossref')).toBe(10000);
  });

  it('hands the badge refresh and the cross-reference 10 s', async () => {
    const badge = harness();
    await detectTerminals([10251, 86720], 'badge', badge.deps);
    expect(badge.calls.timeouts).toEqual([10000]);
    const crossref = harness();
    await detectTerminals([10251], 'crossref', crossref.deps);
    expect(crossref.calls.timeouts).toEqual([10000]);
  });

  it('keeps 2 s for a switch that misses the cache', async () => {
    const h = harness();
    expect(await resolveSwitchTerminal(10251, h.deps)).toEqual({ terminal: 'ghostty', src: 'ps' });
    expect(h.calls.timeouts).toEqual([2000]);
    const one = harness();
    await detectTerminal(10251, one.deps);
    expect(one.calls.timeouts).toEqual([2000]);
  });

  it('gives the command-line lookup the timeout of its listing', async () => {
    const badge = harness();
    await detectTerminals([3002], 'badge', badge.deps);
    expect(badge.calls.timeouts).toEqual([10000, 10000]);
    const sw = harness();
    await resolveSwitchTerminal(3002, sw.deps);
    expect(sw.calls.timeouts).toEqual([2000, 2000]);
  });
});

describe('classifyListing', () => {
  it('is null for a listing with processes in it', () => {
    expect(classifyListing(null, 800)).toBeNull();
  });

  it("is 'empty' when nothing failed and nothing was parsed", () => {
    expect(classifyListing(null, 0)).toBe('empty');
  });

  it("is 'timeout' when the callback says the command was killed", () => {
    expect(classifyListing({ killed: true, code: null, signal: 'SIGTERM' }, 0)).toBe('timeout');
  });

  it("is 'timeout' for the false timeout too: killed, SIGPIPE, nothing on stdout", () => {
    // The app's own event loop was blocked past the timeout; `ps` had long finished.
    expect(classifyListing({ killed: true, code: null, signal: 'SIGPIPE' }, 0)).toBe('timeout');
  });

  it('names the exit code, the spawn error or the signal of any other failure', () => {
    expect(classifyListing({ killed: false, code: 1, signal: null }, 0)).toBe('error 1');
    expect(classifyListing({ code: 'EAGAIN' }, 0)).toBe('error EAGAIN');
    expect(classifyListing({ killed: false, code: null, signal: 'SIGKILL' }, 0)).toBe('error SIGKILL');
    // An error is a failure whatever was parsed.
    expect(classifyListing({ killed: false, code: 2 }, 800)).toBe('error 2');
  });

  it('does not call an output overflow a timeout, although it kills the child', () => {
    expect(
      classifyListing({ killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', signal: 'SIGTERM' }, 0),
    ).toBe('error ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
  });

  it('keeps the reason short and plain when the error says nothing usable', () => {
    expect(classifyListing({}, 0)).toBe('error unknown');
    expect(classifyListing({ code: { nested: true }, signal: '' }, 0)).toBe('error unknown');
    expect(classifyListing({ code: 'E BAD\n/x\u001b[31m' }, 0)).toBe('error EBADx31m');
    expect(classifyListing({ code: 'X'.repeat(200) }, 0)).toBe(`error ${'X'.repeat(40)}`);
  });
});

describe('listing counters', () => {
  const falseTimeout: PsRun = { stdout: '', error: { killed: true, code: null, signal: 'SIGPIPE' } };

  it('start at nothing, and count a listing that worked', async () => {
    expect(getListingStats()).toEqual({ n: 0, failed: 0, last: null });
    const h = harness();
    await detectTerminals([10251], 'badge', h.deps);
    expect(getListingStats()).toEqual({ n: 1, failed: 0, last: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it('record a false timeout: the reason, how long it ran, and for whom', async () => {
    const h = harness({
      ps: () => new Promise((resolve) => setTimeout(() => resolve(falseTimeout), 30)),
    });
    const got = await detectTerminals([10251], 'badge', h.deps);
    expect(got.get(10251)).toBe('unknown');
    const stats = getListingStats();
    expect(stats).toEqual({
      n: 1,
      failed: 1,
      last: { reason: 'timeout', ms: expect.any(Number), path: 'badge' },
    });
    expect(Number.isInteger(stats.last?.ms)).toBe(true);
    expect(stats.last?.ms).toBeGreaterThanOrEqual(25);
    expect(stats.last?.ms).toBeLessThan(5000);
  });

  it('warn once per failure, in one short line', async () => {
    const h = harness({ ps: () => Promise.resolve(falseTimeout) });
    await detectTerminals([10251, 86720], 'badge', h.deps);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(warn.mock.calls[0][0]).toMatch(
      /^\[terminal-detect\] process listing failed: timeout, \d+ ms \(badge\)$/,
    );
  });

  it('do not accept a listing that came with an error, whatever it printed', async () => {
    const h = harness({
      ps: () => Promise.resolve({ stdout: listing(), error: { killed: true, signal: 'SIGTERM' } }),
    });
    expect((await detectTerminals([10251], 'badge', h.deps)).get(10251)).toBe('unknown');
    expect(getListingStats()).toMatchObject({ n: 1, failed: 1, last: { reason: 'timeout' } });
    expect(h.cache.size()).toBe(0);
  });

  it("record 'empty' and an error, each with its path", async () => {
    const empty = harness({ ps: () => Promise.resolve('') });
    await detectTerminals([10251], 'crossref', empty.deps);
    expect(getListingStats().last).toMatchObject({ reason: 'empty', path: 'crossref' });

    const noSpawn = harness({ ps: () => Promise.resolve({ stdout: '', error: { code: 'EAGAIN' } }) });
    expect(await resolveSwitchTerminal(10251, noSpawn.deps)).toEqual({ terminal: 'unknown', src: 'ps' });
    expect(getListingStats()).toMatchObject({
      n: 2,
      failed: 2,
      last: { reason: 'error EAGAIN', path: 'switch' },
    });
  });

  it('count a runner that rejects or throws as an error', async () => {
    const rejects = harness({ ps: () => Promise.reject(Object.assign(new Error('x'), { code: 'EMFILE' })) });
    await detectTerminals([10251], 'badge', rejects.deps);
    expect(getListingStats().last).toMatchObject({ reason: 'error EMFILE', path: 'badge' });
    const throws = harness({
      ps: () => {
        throw new Error('spawn failed');
      },
    });
    await detectTerminals([10251], 'badge', throws.deps);
    expect(getListingStats()).toMatchObject({ n: 2, failed: 2, last: { reason: 'error unknown' } });
  });

  it('add up over the life of the app, and keep the last failure after a success', async () => {
    let next: string | PsRun = falseTimeout;
    const h = harness({ ps: () => Promise.resolve(next), starts: { 10251: START_A } });
    await detectTerminals([10251], 'badge', h.deps);
    next = '';
    await detectTerminals([10251], 'crossref', h.deps);
    next = listing();
    await resolveSwitchTerminal(10251, h.deps);
    expect(getListingStats()).toMatchObject({
      n: 3,
      failed: 2,
      last: { reason: 'empty', path: 'crossref' },
    });
    expect(warn).toHaveBeenCalledTimes(2);
    // A switch answered from the cache runs no listing.
    expect(await resolveSwitchTerminal(10251, h.deps)).toEqual({ terminal: 'ghostty', src: 'cache' });
    expect(getListingStats().n).toBe(3);
  });

  it('count nothing when there is nothing to detect', async () => {
    await detectTerminals([], 'badge', harness().deps);
    expect(getListingStats()).toEqual({ n: 0, failed: 0, last: null });
  });

  it('hand out a copy', async () => {
    await detectTerminals([10251], 'badge', harness({ ps: () => Promise.resolve('') }).deps);
    const copy = getListingStats();
    copy.n = 99;
    if (copy.last) copy.last.reason = 'changed';
    expect(getListingStats()).toMatchObject({ n: 1, last: { reason: 'empty' } });
  });

  it('still answer when the warning itself throws', async () => {
    warn.mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const h = harness({ ps: () => Promise.resolve(''), starts: { 10251: START_A } });
    h.cache.put(10251, START_A, 'ghostty');
    // The failed listing falls back to the proved cache entry, as before.
    expect((await detectTerminals([10251], 'badge', h.deps)).get(10251)).toBe('ghostty');
  });
});

describe('the module\'s own runner', () => {
  type Callback = (err: unknown, stdout: string) => void;
  /** Answer the next `execFile` calls in order; keep what each was called with. */
  const answer = (...answers: [unknown, string][]) => {
    const seen: { file: string; args: string[]; opts: Record<string, any> }[] = [];
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (file: string, args: string[], opts: Record<string, any>, cb: Callback) => {
        seen.push({ file, args, opts });
        const [err, stdout] = answers.shift() ?? [null, ''];
        setImmediate(() => cb(err, stdout));
      },
    );
    return seen;
  };
  const noRegistration = { cache: createTerminalCache(), registeredStart: () => null };

  it('runs the badge listing with 10 s, in UTC and the C locale', async () => {
    const seen = answer([null, listing()]);
    const got = await detectTerminals([10251], 'badge', noRegistration);
    expect(got.get(10251)).toBe('ghostty');
    expect(seen).toHaveLength(1);
    expect(seen[0].file).toBe('ps');
    expect(seen[0].args).toEqual(['-axo', 'pid=,ppid=,lstart=,comm=']);
    expect(seen[0].opts.timeout).toBe(10000);
    expect(seen[0].opts.env).toMatchObject({ TZ: 'UTC', LC_ALL: 'C' });
    expect(getListingStats()).toEqual({ n: 1, failed: 0, last: null });
  });

  it('runs the cross-reference listing with 10 s', async () => {
    const seen = answer([null, listing()]);
    await detectTerminals([10251], 'crossref', noRegistration);
    expect(seen[0].opts.timeout).toBe(10000);
  });

  it('runs a switch listing with 2 s', async () => {
    const seen = answer([null, listing()]);
    expect(await resolveSwitchTerminal(10251, noRegistration)).toEqual({
      terminal: 'ghostty',
      src: 'ps',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].opts.timeout).toBe(2000);
  });

  it('runs the command-line lookup with the timeout of its listing', async () => {
    const seen = answer(
      [null, listing()],
      [null, ' 3000 /opt/tools/Electron.app/Contents/MacOS/Electron /src/CodeV\n'],
    );
    expect((await detectTerminals([3002], 'badge', noRegistration)).get(3002)).toBe('codev');
    expect(seen.map((c) => [c.args, c.opts.timeout])).toEqual([
      [['-axo', 'pid=,ppid=,lstart=,comm='], 10000],
      [['-o', 'pid=,command=', '-p', '3000'], 10000],
    ]);
    // Only the listing is counted, not the lookup.
    expect(getListingStats().n).toBe(1);
  });

  it('records the false timeout as execFile reports it', async () => {
    const killed = Object.assign(new Error('Command failed: ps'), {
      killed: true,
      code: null,
      signal: 'SIGPIPE',
    });
    answer([killed, '']);
    expect((await detectTerminals([10251], 'badge', noRegistration)).get(10251)).toBe('unknown');
    expect(getListingStats()).toMatchObject({
      n: 1,
      failed: 1,
      last: { reason: 'timeout', path: 'badge' },
    });
  });

  it('records a non-zero exit and a spawn that throws', async () => {
    answer([Object.assign(new Error('Command failed'), { killed: false, code: 1, signal: null }), '']);
    await detectTerminals([10251], 'badge', noRegistration);
    expect(getListingStats().last).toMatchObject({ reason: 'error 1' });
    execFileMock.mockReset();
    execFileMock.mockImplementation(() => {
      throw Object.assign(new Error('spawn ps EAGAIN'), { code: 'EAGAIN' });
    });
    expect(await resolveSwitchTerminal(10251, noRegistration)).toEqual({
      terminal: 'unknown',
      src: 'ps',
    });
    expect(getListingStats()).toMatchObject({
      n: 2,
      failed: 2,
      last: { reason: 'error EAGAIN', path: 'switch' },
    });
  });
});
