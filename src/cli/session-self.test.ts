import { describe, expect, it } from 'vitest';

import {
  isLive,
  parsePsLine,
  ProcessInfo,
  proofFor,
  readProcesses,
  Registration,
  registrationFrom,
  resolveSelf,
} from './session-self';

const ID_A = '11111111-aaaa-4aaa-8aaa-000000000001';
const ID_B = '11111111-bbbb-4bbb-8bbb-000000000002';
const START = 'Sun Nov  1 10:00:00 2026';

const proc = (over: Partial<ProcessInfo> = {}): ProcessInfo => ({
  pid: 800,
  ppid: 1,
  startUtc: 'Sun Nov 1 10:00:00 2026',
  command: 'claude',
  ...over,
});

const reg = (over: Partial<Registration> = {}): Registration => ({
  pid: 800,
  sessionId: ID_A,
  cwd: '/Users/dev/git/acme-app',
  procStart: START,
  name: 'billing fix',
  status: 'busy',
  kind: 'interactive',
  startedAt: 1793527200000,
  updatedAt: 1793527500000,
  accountLabel: 'main',
  accountDir: '/Users/dev/.claude',
  ...over,
});

const shell = proc({ pid: 900, ppid: 800, command: '/bin/zsh', startUtc: 'Sun Nov 1 10:05:00 2026' });

describe('parsePsLine', () => {
  it('reads pid, ppid, start and command from a real ps line', () => {
    // `ps -o pid=,ppid=,lstart=,comm=` under TZ=UTC LC_ALL=C.
    expect(parsePsLine(' 6121  5475 Fri Nov 20 12:19:21 2026     claude\n')).toEqual({
      pid: 6121,
      ppid: 5475,
      startUtc: 'Fri Nov 20 12:19:21 2026',
      command: 'claude',
    });
    // A single-digit day is space-padded; a command may contain spaces.
    expect(
      parsePsLine('  900   800 Sun Nov  1 10:05:00 2026     /Applications/My App.app/Contents/MacOS/app'),
    ).toEqual({
      pid: 900,
      ppid: 800,
      startUtc: 'Sun Nov 1 10:05:00 2026',
      command: '/Applications/My App.app/Contents/MacOS/app',
    });
    expect(parsePsLine('')).toBeNull();
  });
});

describe('proofFor', () => {
  it('accepts a matching start time, whatever the padding', () => {
    expect(proofFor(reg(), proc(), undefined)).toBe('process-start');
  });

  it('rejects a registration whose start time is another process’s — even if everything else fits', () => {
    const stale = reg({ procStart: 'Sat Oct 31 08:00:00 2026' });
    expect(proofFor(stale, proc(), ID_A)).toBeNull();
  });

  it('without a start time, only the environment naming the same session is proof', () => {
    const old = reg({ procStart: '' });
    expect(proofFor(old, proc({ command: '/bin/zsh' }), ID_A)).toBe('environment');
    expect(proofFor(old, proc({ command: '/bin/zsh' }), ID_B)).toBeNull();
    expect(proofFor(old, proc({ command: '/bin/zsh' }), undefined)).toBeNull();
  });

  it('a process merely being called claude is not proof: the file may be an earlier process’s', () => {
    // An old-format file left by a session that exited; a NEW claude now has
    // its pid. Nothing ties the two together, so it must not be believed.
    const leftover = reg({ procStart: '' });
    for (const command of ['claude', '/usr/local/bin/claude', 'claude-code']) {
      expect(proofFor(leftover, proc({ command }), undefined)).toBeNull();
      expect(proofFor(leftover, proc({ command }), ID_B)).toBeNull();
    }
    expect(
      resolveSelf([proc()], (pid) => (pid === 800 ? [leftover] : []), ID_B),
    ).toMatchObject({ ok: false, reason: 'not-in-session' });
  });
});

describe('resolveSelf', () => {
  const lookup =
    (table: Record<number, Registration[]>) =>
    (pid: number): Registration[] =>
      table[pid] ?? [];

  it('finds the nearest ancestor that owns a registration', () => {
    const r = resolveSelf([shell, proc()], lookup({ 800: [reg()] }), ID_A);
    expect(r).toEqual({
      ok: true,
      registration: reg(),
      proof: 'process-start',
      environmentAgrees: true,
    });
  });

  it('prefers the nearer session when sessions are nested', () => {
    const inner = proc({ pid: 850, ppid: 800, startUtc: 'Sun Nov 1 10:03:00 2026' });
    const innerReg = reg({
      pid: 850,
      sessionId: ID_B,
      procStart: 'Sun Nov  1 10:03:00 2026',
      accountLabel: 'work',
    });
    const r = resolveSelf(
      [shell, inner, proc()],
      lookup({ 850: [innerReg], 800: [reg()] }),
      ID_B,
    );
    expect(r.ok && r.registration.sessionId).toBe(ID_B);
    expect(r.ok && r.registration.accountLabel).toBe('work');
  });

  it('reports — and does not hide — an environment that names another session', () => {
    const r = resolveSelf([shell, proc()], lookup({ 800: [reg()] }), ID_B);
    expect(r).toMatchObject({ ok: true, environmentAgrees: false });
    expect(r.ok && r.registration.sessionId).toBe(ID_A);
    const none = resolveSelf([shell, proc()], lookup({ 800: [reg()] }));
    expect(none).toMatchObject({ ok: true, environmentAgrees: null });
  });

  it('skips a stale registration and says "not in a session" rather than use it', () => {
    const stale = reg({ procStart: 'Sat Oct 31 08:00:00 2026' });
    expect(resolveSelf([shell, proc()], lookup({ 800: [stale] }), ID_A)).toMatchObject({
      ok: false,
      reason: 'not-in-session',
    });
    expect(resolveSelf([], lookup({}), ID_A)).toMatchObject({
      ok: false,
      reason: 'not-in-session',
    });
  });

  it('one pid registered under two accounts: the environment decides, or nobody does', () => {
    const main = reg();
    const work = reg({ sessionId: ID_B, accountLabel: 'work', accountDir: '/Users/dev/.claude-work' });
    const table = lookup({ 800: [main, work] });
    const decided = resolveSelf([proc()], table, ID_B);
    expect(decided.ok && decided.registration.accountLabel).toBe('work');
    expect(resolveSelf([proc()], table, undefined)).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    });
    expect(
      resolveSelf([proc()], table, '99999999-9999-4999-8999-999999999999'),
    ).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
});

describe('which registrations are running', () => {
  it('isLive: the pid must be running AND have started when the file says', () => {
    expect(isLive(reg(), proc())).toBe(true);
    // Padding differs between ps and the file; the time does not.
    expect(isLive(reg({ procStart: 'Sun Nov 1 10:00:00 2026' }), proc())).toBe(true);
    // A reused pid: alive, but a different process.
    expect(isLive(reg(), proc({ startUtc: 'Mon Nov 2 09:00:00 2026' }))).toBe(false);
    expect(isLive(reg(), undefined)).toBe(false);
    expect(isLive(reg(), proc({ pid: 801 }))).toBe(false);
    // An older file with no start time: only a claude executable will do.
    expect(isLive(reg({ procStart: '' }), proc())).toBe(true);
    expect(isLive(reg({ procStart: '' }), proc({ command: '/bin/zsh' }))).toBe(false);
  });

  it('registrationFrom: a file that names no session is not one', () => {
    const account = { label: 'main', dir: '/Users/dev/.claude', configDirEnv: null, isAnchor: true };
    // Shape of a real peer-token-only file (2.1.329); values invented.
    expect(
      registrationFrom({ peerToken: 'abc', procStart: START, pidDomain: 'darwin' }, 800, account),
    ).toBeNull();
    expect(registrationFrom({ pid: 801, sessionId: ID_A }, 800, account)).toBeNull();
    expect(
      registrationFrom(
        { pid: 800, sessionId: ID_A, cwd: '/x', startedAt: 5, updatedAt: 'soon', status: 'idle' },
        800,
        account,
      ),
    ).toMatchObject({ pid: 800, sessionId: ID_A, status: 'idle', startedAt: 5, updatedAt: 0, kind: '' });
  });

  it('readProcesses: one real ps call, and a pid that is not running is simply absent', () => {
    // Real `ps`. 99998 is a valid pid that is almost never running.
    const found = readProcesses([process.pid, 99998]);
    expect(found.has(process.pid)).toBe(true);
    // A pid macOS cannot have makes `ps` fail the whole call; the running
    // process must still be found.
    expect(readProcesses([process.pid, 99999999]).has(process.pid)).toBe(true);
    expect(found.get(process.pid)?.startUtc).toMatch(/^\w{3} \w{3} \d{1,2} [\d:]{8} \d{4}$/);
    expect(readProcesses([]).size).toBe(0);
  });
});
