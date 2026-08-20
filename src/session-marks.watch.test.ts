import * as realFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock fs BEFORE the module under test imports it: fs.watch is replaced by a
// controllable fake so the watcher 'error' path can be driven deterministically.
const handlers: Record<string, (...args: any[]) => void> = {};
const fakeWatcher = {
  close: vi.fn(),
  on: (event: string, cb: (...args: any[]) => void) => {
    handlers[event] = cb;
    return fakeWatcher;
  },
};

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    watch: vi.fn(() => fakeWatcher),
  };
});

import * as fs from 'fs';
import { watchMarksFile } from './session-marks';

describe('watchMarksFile error recovery', () => {
  it('closes the dead watcher and reports the error to the owner', () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    watchMarksFile('/tmp/nowhere/session-marks.json', onChange, onError);
    expect(typeof handlers.error).toBe('function');

    const boom = new Error('watcher blew up');
    handlers.error(boom);

    expect(fakeWatcher.close).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('watchMarksFile broadcast', () => {
  let dir: string;

  afterEach(() => {
    vi.useRealTimers();
    if (dir) realFs.rmSync(dir, { recursive: true, force: true });
  });

  // Fire the fs.watch callback the module registered, then run the debounce.
  const fireChange = (file: string) => {
    const calls = (fs.watch as unknown as { mock: { calls: any[][] } }).mock
      .calls;
    const listener = calls[calls.length - 1][2];
    listener('change', path.basename(file));
    vi.advanceTimersByTime(60);
  };

  it('broadcasts a readable store and stays silent on an unreadable one', () => {
    vi.useFakeTimers();
    dir = realFs.mkdtempSync(path.join(os.tmpdir(), 'codev-marks-watch-'));
    const file = path.join(dir, 'session-marks.json');
    const onChange = vi.fn();

    realFs.writeFileSync(
      file,
      JSON.stringify({ version: 1, pins: {}, hidden: ['a'] }),
    );
    watchMarksFile(file, onChange);
    fireChange(file);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].hidden).toEqual(['a']);

    // An unparseable store means the marks are UNKNOWN, not empty. Announcing
    // empty here would push every listener into acting on state that is still
    // intact on disk — the pinned-only reset would wipe a valid preference.
    realFs.writeFileSync(file, '{not json');
    fireChange(file);
    expect(onChange).toHaveBeenCalledTimes(1);

    // A deletion IS authoritative: the store really is gone.
    realFs.rmSync(file);
    fireChange(file);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls[1][0].hidden).toEqual([]);
  });
});
