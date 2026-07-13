import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyMarks,
  normalizeMarks,
  readMarksFile,
  withHidden,
  withoutHidden,
  withoutPin,
  withPin,
  writeMarksFile,
} from './session-marks';

describe('normalizeMarks', () => {
  it('returns empty marks for garbage input', () => {
    expect(normalizeMarks(null)).toEqual(emptyMarks());
    expect(normalizeMarks('nope')).toEqual(emptyMarks());
    expect(normalizeMarks([1, 2])).toEqual(emptyMarks());
    expect(normalizeMarks({ pins: [1], hidden: 'x' })).toEqual(emptyMarks());
  });

  it('keeps valid entries, defaults missing fields, dedupes hidden', () => {
    const raw = {
      pins: {
        abc: { pinnedAt: '2026-07-14T00:00:00Z', cwd: '/x', group: 'g1' },
        bad: 'not-an-object',
        def: {},
      },
      hidden: ['h1', 'h1', '', 42, 'h2'],
    };
    const m = normalizeMarks(raw);
    expect(Object.keys(m.pins).sort()).toEqual(['abc', 'def']);
    expect(m.pins.abc.group).toBe('g1');
    expect(m.pins.def.cwd).toBe('');
    expect(typeof m.pins.def.pinnedAt).toBe('string');
    expect(m.hidden).toEqual(['h1', 'h2']);
  });
});

describe('pin/hide transitions', () => {
  const info = { pinnedAt: '2026-07-14T00:00:00Z', cwd: '/repo' };

  it('pinning unhides and hiding unpins (mutual exclusion)', () => {
    let m = withHidden(emptyMarks(), 's1');
    expect(m.hidden).toEqual(['s1']);

    m = withPin(m, 's1', info);
    expect(m.pins.s1).toBeTruthy();
    expect(m.hidden).toEqual([]);

    m = withHidden(m, 's1');
    expect(m.pins.s1).toBeUndefined();
    expect(m.hidden).toEqual(['s1']);
  });

  it('unpin and unhide are idempotent and non-destructive', () => {
    let m = withPin(emptyMarks(), 's1', info);
    m = withPin(m, 's2', { ...info, accountLabel: 'work' });
    m = withoutPin(m, 's1');
    m = withoutPin(m, 's1');
    expect(Object.keys(m.pins)).toEqual(['s2']);
    expect(m.pins.s2.accountLabel).toBe('work');

    m = withHidden(m, 'h1');
    m = withoutHidden(m, 'h1');
    m = withoutHidden(m, 'h1');
    expect(m.hidden).toEqual([]);
  });

  it('does not mutate the input marks', () => {
    const base = withPin(emptyMarks(), 's1', info);
    const frozen = JSON.stringify(base);
    withHidden(base, 's1');
    withoutPin(base, 's1');
    withPin(base, 's2', info);
    expect(JSON.stringify(base)).toBe(frozen);
  });
});

describe('marks file roundtrip', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-marks-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads back the same marks (nested dir is created)', () => {
    const file = path.join(dir, 'nested', 'session-marks.json');
    const marks = withHidden(
      withPin(emptyMarks(), 'abc', {
        pinnedAt: '2026-07-14T01:02:03Z',
        cwd: '/repo',
        accountLabel: 'work',
      }),
      'junk-1',
    );
    writeMarksFile(file, marks);
    expect(readMarksFile(file)).toEqual(marks);
    // no temp leftovers from the rename-based write
    expect(
      fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp-')),
    ).toEqual([]);
  });

  it('returns empty marks for a missing or corrupt file', () => {
    const file = path.join(dir, 'session-marks.json');
    expect(readMarksFile(file)).toEqual(emptyMarks());
    fs.writeFileSync(file, '{not json');
    expect(readMarksFile(file)).toEqual(emptyMarks());
  });
});
