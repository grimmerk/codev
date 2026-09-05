import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isAuthoritativeRead } from './atomic-json-store';
import {
  emptyLists,
  LIST_TEXT_CAPS,
  mutateListsFile,
  normalizeLists,
  normalizeMember,
  readListsFileResult,
  SessionList,
  withList,
  withoutList,
  withRenamedList,
  writeListsFile,
} from './session-lists';

const member = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId,
  project: '/Users/x/git/proj',
  projectName: 'proj',
  pinned: false,
  lastTimestamp: 1000,
  ...over,
});

const list = (id: string, members: unknown[] = []): SessionList => ({
  id,
  name: `list ${id}`,
  createdAt: '2026-09-05T00:00:00.000Z',
  members: members as SessionList['members'],
});

describe('normalizeMember', () => {
  it('rejects anything without a sessionId', () => {
    expect(normalizeMember(null)).toBeNull();
    expect(normalizeMember('x')).toBeNull();
    expect(normalizeMember({ project: '/a' })).toBeNull();
    expect(normalizeMember({ sessionId: '' })).toBeNull();
  });

  it('caps every text field and drops empty optionals', () => {
    const long = 'x'.repeat(2000);
    const m = normalizeMember(
      member('s1', {
        title: long,
        branch: long,
        recap: { text: long, at: '2026-09-05T01:00:00Z' },
        lastUserMessage: long,
        lastAssistantMessage: '   ',
      }),
    );
    expect(m?.title?.length).toBe(LIST_TEXT_CAPS.title);
    expect(m?.branch?.length).toBe(LIST_TEXT_CAPS.title);
    expect(m?.recap?.text.length).toBe(LIST_TEXT_CAPS.recap);
    expect(m?.recap?.at).toBe('2026-09-05T01:00:00Z');
    expect(m?.lastUserMessage?.length).toBe(LIST_TEXT_CAPS.message);
    // Whitespace-only is absent, not an empty string that renders as a line.
    expect(m?.lastAssistantMessage).toBeUndefined();
  });

  it('derives projectName from the path when it is missing', () => {
    const m = normalizeMember({
      sessionId: 's1',
      project: '/Users/x/git/fred-ff',
    });
    expect(m?.projectName).toBe('fred-ff');
    expect(m?.pinned).toBe(false);
    expect(m?.lastTimestamp).toBe(0);
  });
});

describe('normalizeLists', () => {
  it('returns empty lists for garbage input', () => {
    expect(normalizeLists(null)).toEqual(emptyLists());
    expect(normalizeLists('nope')).toEqual(emptyLists());
    expect(normalizeLists({ lists: 'x' })).toEqual(emptyLists());
  });

  it('drops malformed lists, dedupes list ids and member ids', () => {
    const raw = {
      version: 1,
      lists: [
        list('a', [member('s1'), member('s1'), 'junk', member('s2')]),
        list('a'),
        { name: 'no id' },
        list('b'),
      ],
    };
    const n = normalizeLists(raw);
    expect(n.lists.map((l) => l.id)).toEqual(['a', 'b']);
    expect(n.lists[0].members.map((m) => m.sessionId)).toEqual(['s1', 's2']);
  });

  it('is a no-op on a well-formed store (the authority invariant)', () => {
    const raw = {
      version: 1,
      lists: [
        list('a', [
          member('s1', { title: 't', recap: { text: 'r', at: 'x' } }),
        ]),
      ],
    };
    expect(isAuthoritativeRead(raw, normalizeLists(raw))).toBe(true);
  });

  it('is a fixed point of itself, even when a cap lands on whitespace', () => {
    // A 500-char message whose 500th character is a space: the first pass
    // caps it, and the result must survive a second pass byte-for-byte —
    // otherwise the store the app just wrote is refused by the next write.
    const onSpace =
      'a'.repeat(LIST_TEXT_CAPS.message - 1) + ' tail of the message';
    const raw = {
      version: 1,
      lists: [
        list('a', [
          member('s1', {
            lastUserMessage: onSpace,
            lastAssistantMessage:
              'x'.repeat(LIST_TEXT_CAPS.message - 3) + '   end',
            title: 'y'.repeat(LIST_TEXT_CAPS.title - 1) + ' z',
          }),
        ]),
      ],
    };
    const once = normalizeLists(raw);
    const twice = normalizeLists(JSON.parse(JSON.stringify(once)));
    expect(isAuthoritativeRead(once, twice)).toBe(true);
    expect(once.lists[0].members[0].lastUserMessage?.endsWith(' ')).toBe(false);
  });

  it('is NOT a no-op when it had to coerce — so such a read is not authoritative', () => {
    // A member that normalization would rewrite (missing pinned, capped title).
    const raw = {
      version: 1,
      lists: [list('a', [{ sessionId: 's1', title: 'x'.repeat(300) }])],
    };
    expect(isAuthoritativeRead(raw, normalizeLists(raw))).toBe(false);
  });
});

describe('list transitions', () => {
  it('withList puts the newest first and replaces by id', () => {
    let s = withList(emptyLists(), list('a'));
    s = withList(s, list('b'));
    expect(s.lists.map((l) => l.id)).toEqual(['b', 'a']);
    s = withList(s, { ...list('a'), name: 'renamed' });
    expect(s.lists.map((l) => l.id)).toEqual(['a', 'b']);
    expect(s.lists[0].name).toBe('renamed');
  });

  it('withoutList and withRenamedList leave other lists untouched', () => {
    let s = withList(withList(emptyLists(), list('a')), list('b'));
    s = withRenamedList(s, 'a', '  new name  ');
    expect(s.lists.find((l) => l.id === 'a')?.name).toBe('new name');
    expect(s.lists.find((l) => l.id === 'b')?.name).toBe('list b');
    // An empty rename keeps the old name rather than producing a blank one.
    s = withRenamedList(s, 'a', '   ');
    expect(s.lists.find((l) => l.id === 'a')?.name).toBe('new name');
    s = withoutList(s, 'a');
    expect(s.lists.map((l) => l.id)).toEqual(['b']);
  });
});

describe('lists file roundtrip', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-lists-'));
    file = path.join(dir, 'session-lists.json');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('missing file reads as empty AND authoritative', () => {
    const r = readListsFileResult(file);
    expect(r.value).toEqual(emptyLists());
    expect(r.known).toBe(true);
  });

  it('writes atomically and reads back the same value', () => {
    const s = withList(emptyLists(), list('a', [member('s1', { title: 't' })]));
    writeListsFile(file, s);
    expect(fs.readdirSync(dir)).toEqual(['session-lists.json']); // no .tmp left
    const r = readListsFileResult(file);
    expect(r.known).toBe(true);
    expect(r.value).toEqual(s);
  });

  it('mutate refuses to write over an unreadable store', () => {
    fs.writeFileSync(file, '{not json');
    const r = mutateListsFile(file, (s) => withList(s, list('a')));
    expect(r.known).toBe(false);
    // The corrupt bytes are still there — nothing was overwritten.
    expect(fs.readFileSync(file, 'utf-8')).toBe('{not json');
  });

  it('mutate refuses to write over a store it would have coerced', () => {
    const coercible = JSON.stringify({
      version: 1,
      lists: [list('keep', [{ sessionId: 's1' }])], // member lacks pinned/lastTimestamp
    });
    fs.writeFileSync(file, coercible);
    const r = mutateListsFile(file, (s) => withList(s, list('new')));
    expect(r.known).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe(coercible);
  });
});
