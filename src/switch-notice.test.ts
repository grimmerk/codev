import { afterEach, describe, expect, it } from 'vitest';

import {
  createPendingNotice,
  noteSwitchKilled,
  setSwitchKilledListener,
  SWITCH_NOTICE_TTL_MS,
  switchKilledMessage,
} from './switch-notice';

describe('switchKilledMessage', () => {
  it('names the terminal and the timeout', () => {
    expect(switchKilledMessage('Ghostty')).toBe(
      'Ghostty did not answer within 5 s, so the switch was cancelled. The machine may be busy — try again.',
    );
    expect(switchKilledMessage('ghostty')).toMatch(/^Ghostty did not answer/);
    expect(switchKilledMessage('Terminal.app')).toMatch(/^Terminal\.app did not answer/);
    expect(switchKilledMessage()).toMatch(/^The terminal did not answer within 5 s/);
  });
});

describe('noteSwitchKilled', () => {
  afterEach(() => setSwitchKilledListener(null));

  const collect = () => {
    const got: string[] = [];
    setSwitchKilledListener((m) => got.push(m));
    return got;
  };

  it('reports a command that its timeout killed', () => {
    const got = collect();
    noteSwitchKilled(Object.assign(new Error('killed'), { killed: true }), 'Ghostty');
    expect(got).toEqual([switchKilledMessage('Ghostty')]);
  });

  it('says nothing for a command that finished, or failed some other way', () => {
    const got = collect();
    noteSwitchKilled(null, 'Ghostty');
    noteSwitchKilled(undefined, 'Ghostty');
    noteSwitchKilled(new Error('osascript: execution error'), 'Ghostty');
    noteSwitchKilled(Object.assign(new Error('exit 1'), { killed: false }), 'Ghostty');
    noteSwitchKilled({ killed: 'yes' }, 'Ghostty');
    expect(got).toEqual([]);
  });

  it('does not throw without a listener, or with one that throws', () => {
    const killed = Object.assign(new Error('killed'), { killed: true });
    expect(() => noteSwitchKilled(killed, 'Ghostty')).not.toThrow();
    setSwitchKilledListener(() => {
      throw new Error('window is gone');
    });
    expect(() => noteSwitchKilled(killed, 'Ghostty')).not.toThrow();
  });
});

describe('createPendingNotice', () => {
  it('hands a held notice over once', () => {
    const p = createPendingNotice(() => 1000);
    expect(p.take()).toBeNull();
    p.hold('first');
    p.hold('second');
    expect(p.take()).toBe('second');
    expect(p.take()).toBeNull();
  });

  it('drops a notice nobody looked at in time', () => {
    let now = 0;
    const p = createPendingNotice(() => now);
    p.hold('fresh');
    now = SWITCH_NOTICE_TTL_MS;
    expect(p.take()).toBe('fresh');
    p.hold('stale');
    now += SWITCH_NOTICE_TTL_MS + 1;
    expect(p.take()).toBeNull();
    expect(p.take()).toBeNull();
  });
});
