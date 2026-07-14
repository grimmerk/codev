import { describe, expect, it, vi } from 'vitest';

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
