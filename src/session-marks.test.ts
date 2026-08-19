import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  emptyMarks,
  normalizeMarks,
  isAuthoritativeRead,
  mutateMarksFile,
  readMarksFile,
  readMarksFileResult,
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

  // Both cases above yield empty marks, but they do not mean the same thing:
  // "no store yet" is a fact, "could not parse the store" is ignorance. A
  // caller that clears user state when the pin set looks empty must be able
  // to tell them apart.
  it('reports a missing file as authoritative and an unreadable one as unknown', () => {
    const file = path.join(dir, 'session-marks.json');
    expect(readMarksFileResult(file)).toEqual({
      marks: emptyMarks(),
      known: true,
    });

    fs.writeFileSync(file, '{not json');
    expect(readMarksFileResult(file)).toEqual({
      marks: emptyMarks(),
      known: false,
    });

    const marks = withPin(emptyMarks(), 'abc', {
      pinnedAt: '2026-07-14T01:02:03Z',
      cwd: '/repo',
    });
    writeMarksFile(file, marks);
    expect(readMarksFileResult(file)).toEqual({ marks, known: true });
  });

  // normalizeMarks is deliberately forgiving so a partly-corrupt store still
  // renders. That is right for display and wrong for authority: a file that
  // parses but is not our schema must not be declared authoritative, or the
  // next pin overwrites it.
  // The guard that matters most: if strict authority ever rejected our OWN
  // output, pins would silently stop persisting. Round-tripping must hold.
  it('treats a store this build wrote as authoritative', () => {
    const file = path.join(dir, 'session-marks.json');
    const marks = withHidden(
      withPin(emptyMarks(), 'abc', {
        pinnedAt: '2026-07-14T01:02:03Z',
        cwd: '/repo',
        accountLabel: 'work',
      }),
      'junk-1',
    );
    writeMarksFile(file, marks);
    const read = readMarksFileResult(file);
    expect(read.known).toBe(true);
    expect(read.marks).toEqual(marks);
  });

  // Authority is "normalization is a no-op". Enumerating the ways a forgiving
  // normalizer can differ is not a list anyone can finish — four review rounds
  // each found one more — so the check compares the whole result instead.
  it('refuses any store this build would rewrite', () => {
    const file = path.join(dir, 'session-marks.json');
    const rewritten: [string, string][] = [
      ['[]', 'an array is not a marks object'],
      ['{}', 'missing envelope — we would add version/pins/hidden'],
      [
        '{"version":2,"pins":{},"hidden":[]}',
        'a newer format this build cannot read',
      ],
      ['{"version":1,"pins":[],"hidden":[]}', 'pins must be an object'],
      ['{"version":1,"pins":{},"hidden":{}}', 'hidden must be an array'],
      [
        '{"version":1,"pins":{"abc":"garbage"},"hidden":[]}',
        'a pin entry that is dropped',
      ],
      [
        '{"version":1,"pins":{"abc":{"pinnedAt":42,"cwd":7,"group":null}},"hidden":[]}',
        'a pin entry whose FIELDS are coerced',
      ],
      ['{"version":1,"pins":{},"hidden":["ok",42]}', 'a non-string hidden id'],
      [
        '{"version":1,"pins":{},"hidden":["a","a"]}',
        'duplicates we would collapse',
      ],
      [
        '{"version":1,"pins":{},"hidden":[],"groups":{"x":1}}',
        'an unknown field a future build added',
      ],
    ];
    for (const [json, why] of rewritten) {
      fs.writeFileSync(file, json);
      expect(readMarksFileResult(file).known, why).toBe(false);
      expect(mutateMarksFile(file, (p) => withHidden(p, 'x')).known).toBe(
        false,
      );
      expect(fs.readFileSync(file, 'utf-8'), why).toBe(json);
    }
  });

  it('ignores key order, which is not a rewrite', () => {
    const marks = withPin(emptyMarks(), 'abc', {
      pinnedAt: '2026-07-14T01:02:03Z',
      cwd: '/repo',
    });
    const reordered = {
      hidden: [],
      pins: {
        abc: { group: null, cwd: '/repo', pinnedAt: '2026-07-14T01:02:03Z' },
      },
      version: 1,
    };
    expect(isAuthoritativeRead(reordered, marks)).toBe(true);
  });

  // Every mutation is read-modify-write over the whole file, so a read that
  // degrades to empty marks turns the next pin into a full overwrite.
  describe('mutateMarksFile', () => {
    it('applies and persists the mutation on a readable store', () => {
      const file = path.join(dir, 'session-marks.json');
      writeMarksFile(file, withHidden(emptyMarks(), 'junk-1'));

      const res = mutateMarksFile(file, (prev) =>
        withPin(prev, 'abc', {
          pinnedAt: '2026-07-14T01:02:03Z',
          cwd: '/repo',
        }),
      );

      expect(res.known).toBe(true);
      expect(Object.keys(res.marks.pins)).toEqual(['abc']);
      expect(readMarksFile(file).hidden).toEqual(['junk-1']);
    });

    it('creates the store on the first-ever mutation (ENOENT is authoritative)', () => {
      const file = path.join(dir, 'nested', 'session-marks.json');
      const res = mutateMarksFile(file, (prev) => withHidden(prev, 'junk-1'));
      expect(res.known).toBe(true);
      expect(readMarksFile(file).hidden).toEqual(['junk-1']);
    });

    it('refuses to write when the store is unreadable, leaving it byte-identical', () => {
      const file = path.join(dir, 'session-marks.json');
      const corrupt = "{not json — but somebody's real pins are in here";
      fs.writeFileSync(file, corrupt);

      const res = mutateMarksFile(file, (prev) =>
        withPin(prev, 'abc', {
          pinnedAt: '2026-07-14T01:02:03Z',
          cwd: '/repo',
        }),
      );

      expect(res.known).toBe(false);
      // Not "the mutation was skipped" — nothing was written at all.
      expect(fs.readFileSync(file, 'utf-8')).toBe(corrupt);
    });
  });
});
