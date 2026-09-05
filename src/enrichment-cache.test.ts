import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deserializeEnrichment,
  ENRICHMENT_CACHE_VERSION,
  EnrichmentState,
  assistantTextOfLine,
  minePrRefs,
  readEnrichmentCacheFile,
  serializeEnrichment,
  writeEnrichmentCacheFile,
} from './enrichment-cache';

const state = (): EnrichmentState => ({
  fileState: new Map([
    ['a', { mtimeMs: 1, size: 10 }],
    ['b', { mtimeMs: 2, size: 20 }],
    ['gone', { mtimeMs: 3, size: 30 }],
  ]),
  titles: new Map([['a', 'title a']]),
  branches: new Map([['a', 'main']]),
  prLinks: new Map([
    ['a', { prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' }],
  ]),
  recaps: new Map([['b', { text: 'next: ship', at: '2026-09-05T00:00:00Z' }]]),
  prRefs: new Map([
    ['a', ['o/r#7', '#8']],
    ['b', []],
  ]),
  prRefBytes: new Map([
    ['a', 10],
    ['b', 0],
  ]),
});

describe('serializeEnrichment / deserializeEnrichment', () => {
  it('round-trips every field and omits empties', () => {
    const file = serializeEnrichment(state());
    expect(file.version).toBe(ENRICHMENT_CACHE_VERSION);
    expect(file.sessions.a).toEqual({
      mtimeMs: 1,
      size: 10,
      title: 'title a',
      branch: 'main',
      prLink: { prNumber: 7, prUrl: 'https://github.com/o/r/pull/7' },
      prRefs: ['o/r#7', '#8'],
      prRefsScannedBytes: 10,
    });
    expect(file.sessions.b).toEqual({
      mtimeMs: 2,
      size: 20,
      recap: { text: 'next: ship', at: '2026-09-05T00:00:00Z' },
    });
    const back = deserializeEnrichment(JSON.parse(JSON.stringify(file)));
    expect(back.fileState).toEqual(state().fileState);
    expect(back.titles).toEqual(state().titles);
    expect(back.branches).toEqual(state().branches);
    expect(back.prLinks).toEqual(state().prLinks);
    expect(back.recaps).toEqual(state().recaps);
    expect(back.prRefs).toEqual(new Map([['a', ['o/r#7', '#8']]]));
    expect(back.prRefBytes).toEqual(new Map([['a', 10]]));
  });

  it('prunes sessions outside `keep`, so deleted sessions leave the cache', () => {
    const file = serializeEnrichment(state(), new Set(['a', 'b']));
    expect(Object.keys(file.sessions).sort()).toEqual(['a', 'b']);
  });

  it('starts cold on a version mismatch, a non-object, or a malformed entry', () => {
    expect(deserializeEnrichment(null).fileState.size).toBe(0);
    expect(deserializeEnrichment('x').fileState.size).toBe(0);
    expect(
      deserializeEnrichment({
        version: 99,
        sessions: { a: { mtimeMs: 1, size: 1 } },
      }).fileState.size,
    ).toBe(0);
    const partial = deserializeEnrichment({
      version: ENRICHMENT_CACHE_VERSION,
      sessions: {
        ok: {
          mtimeMs: 1,
          size: 1,
          title: 'x',
          prLink: { prNumber: 'no', prUrl: 'u' },
          prRefs: ['#1', 2, ''],
          prRefsScannedBytes: 'many',
        },
        // A cursor past the file, or not a whole byte, cannot be resumed from.
        tooFar: { mtimeMs: 1, size: 10, prRefsScannedBytes: 11 },
        fractional: { mtimeMs: 1, size: 10, prRefsScannedBytes: 2.5 },
        atEnd: { mtimeMs: 1, size: 10, prRefsScannedBytes: 10 },
        bad: { mtimeMs: 'one', size: 1 },
        alsoBad: null,
      },
    });
    expect([...partial.fileState.keys()]).toEqual([
      'ok',
      'tooFar',
      'fractional',
      'atEnd',
    ]);
    expect(partial.titles.get('ok')).toBe('x');
    expect(partial.prLinks.has('ok')).toBe(false);
    expect(partial.prRefs.get('ok')).toEqual(['#1']);
    expect(partial.prRefBytes.has('ok')).toBe(false);
    expect(partial.prRefBytes.has('tooFar')).toBe(false);
    expect(partial.prRefBytes.has('fractional')).toBe(false);
    expect(partial.prRefBytes.get('atEnd')).toBe(10);
  });
});

describe('minePrRefs', () => {
  // Record shapes copied from a real transcript (2026-09-05): an assistant
  // record carries `message` BEFORE its top-level `type`, and the message
  // has its own `"type":"message"`; a user record has `type` first.
  const assistant = (content: unknown) =>
    JSON.stringify({
      parentUuid: '1e20089d',
      isSidechain: false,
      message: {
        model: 'claude-fable-5',
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content,
      },
      requestId: 'req_1',
      type: 'assistant',
      uuid: 'u1',
      timestamp: '2026-09-05T00:00:00Z',
    });
  const user = (content: unknown) =>
    JSON.stringify({
      parentUuid: '137369c9',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content },
      uuid: 'u2',
    });

  it('reads only assistant records and canonicalises each form, lowercased and deduplicated', () => {
    const text = [
      user('see #1 and https://github.com/o/r/pull/2'),
      assistant([
        { type: 'thinking', thinking: 'maybe #99', signature: 'x' },
        {
          type: 'text',
          text: 'opened #3, https://GitHub.com/Grimmerk/CodeV/Pull/147, o/r#5, again #3',
        },
      ]),
      user([
        {
          type: 'tool_result',
          content: 'o/r#6 listed by gh; "type":"assistant" quoted',
        },
      ]),
      assistant([
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'gh pr view 7 (#7)' },
        },
      ]),
      '{"type":"system","subtype":"away_summary","content":"recap mentions #8"}',
      'not json at all #10',
    ].join('\n');
    expect(minePrRefs(text)).toEqual([
      '#3',
      'grimmerk/codev#147',
      'o/r#5',
      '#7',
    ]);
  });

  it('skips what `seen` already holds and reports only the new ones, in order', () => {
    const seen = new Set(['#3']);
    expect(minePrRefs(assistant('#3 then #4'), seen)).toEqual(['#4']);
    expect([...seen]).toEqual(['#3', '#4']);
  });

  it('never reads a bare number, an HTML entity, a leading zero, a hex-looking anchor, or a paste marker', () => {
    expect(
      minePrRefs(
        assistant(
          '15980 and &#38; and #0 and #012 and a#9 and x/y#1a and [Image #4] but #5',
        ),
      ),
    ).toEqual(['#5']);
  });

  // The matcher had these boundaries and the miner did not: `#147abc` was
  // persisted as `#147`, and `notgithub.com/…/pull/9` as `o/r#9`.
  it('applies the same right-side and host boundaries as the query matcher', () => {
    expect(
      minePrRefs(
        assistant(
          '#147abc #147_x /pull/147abc o/r#12abc https://notgithub.com/o/r/pull/9 then #147, and https://github.com/o/r/pull/9',
        ),
      ),
    ).toEqual(['#147', 'o/r#9']);
  });

  it('assistantTextOfLine joins text and tool inputs, and rejects everything else', () => {
    expect(
      assistantTextOfLine(
        assistant([
          { type: 'text', text: 'a' },
          { type: 'tool_use', input: { command: 'b' } },
          { type: 'thinking', thinking: 'c' },
        ]),
      ),
    ).toBe('a\n{"command":"b"}');
    expect(assistantTextOfLine(assistant('plain'))).toBe('plain');
    expect(assistantTextOfLine(user('"type":"assistant"'))).toBeNull();
    expect(assistantTextOfLine('{"type":"assistant"')).toBeNull();
    expect(assistantTextOfLine('')).toBeNull();
  });
});

describe('enrichment cache file layer', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-enrich-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads back; a missing or corrupt file is a cold start', () => {
    const file = path.join(dir, 'enrichment-cache.json');
    expect(readEnrichmentCacheFile(file).fileState.size).toBe(0);
    writeEnrichmentCacheFile(file, state(), new Set(['a']));
    const back = readEnrichmentCacheFile(file);
    expect([...back.fileState.keys()]).toEqual(['a']);
    expect(back.titles.get('a')).toBe('title a');
    fs.writeFileSync(file, '{not json');
    expect(readEnrichmentCacheFile(file).fileState.size).toBe(0);
  });
});
