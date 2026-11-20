import { describe, expect, it } from 'vitest';

import {
  parsePsLine,
  ProcessInfo,
  proofFor,
  Registration,
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

  it('without a start time, needs the environment or a claude command', () => {
    const old = reg({ procStart: '' });
    expect(proofFor(old, proc({ command: '/bin/zsh' }), ID_A)).toBe('environment');
    expect(proofFor(old, proc({ command: '/usr/local/bin/claude' }), undefined)).toBe(
      'command-name',
    );
    expect(proofFor(old, proc({ command: '/bin/zsh' }), ID_B)).toBeNull();
    expect(proofFor(old, proc({ command: '/bin/zsh' }), undefined)).toBeNull();
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
