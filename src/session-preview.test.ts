import { describe, expect, it } from 'vitest';
import {
  legacyModeFor,
  resolveSessionPreview,
  matchingReply,
  offRowPromptMatch,
  userPromptLines,
} from './session-preview';

describe('resolveSessionPreview', () => {
  it('a fresh install shows the first user prompt and the assistant reply', () => {
    expect(resolveSessionPreview({})).toEqual({ userPrompt: 'first', assistantReply: true });
  });

  it('carries each old dropdown value over, with the assistant reply on', () => {
    for (const mode of ['first', 'last', 'both'] as const) {
      expect(resolveSessionPreview({ legacyMode: mode })).toEqual({
        userPrompt: mode,
        assistantReply: true,
      });
    }
  });

  it('prefers the new settings over the old key once they exist', () => {
    expect(
      resolveSessionPreview({ userPrompt: 'none', assistantReply: false, legacyMode: 'both' }),
    ).toEqual({ userPrompt: 'none', assistantReply: false });
  });

  it('resolves each setting on its own: one saved, the other still migrated', () => {
    expect(resolveSessionPreview({ assistantReply: false, legacyMode: 'last' })).toEqual({
      userPrompt: 'last',
      assistantReply: false,
    });
    expect(resolveSessionPreview({ userPrompt: 'both' })).toEqual({
      userPrompt: 'both',
      assistantReply: true,
    });
  });

  it('falls back past a garbage new value to the old key, then to the default', () => {
    expect(resolveSessionPreview({ userPrompt: 'everything', legacyMode: 'last' }).userPrompt).toBe('last');
    expect(resolveSessionPreview({ userPrompt: 42, legacyMode: { a: 1 } }).userPrompt).toBe('first');
    expect(resolveSessionPreview({ userPrompt: null, legacyMode: '' }).userPrompt).toBe('first');
  });

  it('does not take "none" from the old key, which never had it', () => {
    expect(resolveSessionPreview({ legacyMode: 'none' }).userPrompt).toBe('first');
  });

  it('treats a non-boolean assistant reply value as unset (on)', () => {
    for (const bad of ['false', 0, null, 'off']) {
      expect(resolveSessionPreview({ assistantReply: bad }).assistantReply).toBe(true);
    }
  });

  it('is idempotent: resolving what was saved gives the same settings', () => {
    const once = resolveSessionPreview({ legacyMode: 'both' });
    const again = resolveSessionPreview({
      userPrompt: once.userPrompt,
      assistantReply: once.assistantReply,
      legacyMode: legacyModeFor(once.userPrompt),
    });
    expect(again).toEqual(once);
  });
});

describe('legacyModeFor', () => {
  it('round-trips through the old key, so a downgrade sees the latest choice', () => {
    for (const mode of ['first', 'last', 'both'] as const) {
      expect(resolveSessionPreview({ legacyMode: legacyModeFor(mode) }).userPrompt).toBe(mode);
    }
  });

  it('leaves the old key alone for "none", which it cannot express', () => {
    expect(legacyModeFor('none')).toBeNull();
  });
});

describe('userPromptLines', () => {
  it('renders nothing for "none", whatever the session has', () => {
    expect(userPromptLines('none', 'a', 'b')).toEqual({ first: false, last: false });
  });

  it('renders only the chosen prompt', () => {
    expect(userPromptLines('first', 'a', 'b')).toEqual({ first: true, last: false });
    expect(userPromptLines('last', 'a', 'b')).toEqual({ first: false, last: true });
    expect(userPromptLines('both', 'a', 'b')).toEqual({ first: true, last: true });
  });

  it('does not repeat a last prompt equal to the first in "both"', () => {
    expect(userPromptLines('both', 'a', 'a')).toEqual({ first: true, last: false });
  });

  it('reports no line when the chosen prompt is missing, so no gap is reserved', () => {
    expect(userPromptLines('last', 'a', undefined)).toEqual({ first: false, last: false });
    expect(userPromptLines('first', '', 'b')).toEqual({ first: false, last: false });
  });
});

describe('offRowPromptMatch', () => {
  it('names a hidden prompt when nothing on the row matches', () => {
    expect(offRowPromptMatch(['needle'], ['first one'], ['first one', 'the Needle'])).toBe(
      'the Needle',
    );
    expect(offRowPromptMatch(['needle'], [], ['a needle', 'b'])).toBe('a needle');
  });

  it('judges each query word: a visible match for one does not explain another', () => {
    expect(
      offRowPromptMatch(['alpha', 'beta'], ['has alpha'], ['has alpha', 'only beta']),
    ).toBe('only beta');
  });

  it('names nothing when every word the hidden prompt holds is already on the row', () => {
    expect(
      offRowPromptMatch(['alpha', 'beta'], ['alpha and beta'], ['alpha and beta', 'beta again']),
    ).toBeUndefined();
    expect(offRowPromptMatch(['alpha'], ['x'], ['x', 'y'])).toBeUndefined();
  });

  it('never names a prompt that is on the row', () => {
    expect(offRowPromptMatch(['alpha'], ['same alpha'], ['same alpha', 'same alpha'])).toBeUndefined();
  });
});

describe('matchingReply', () => {
  it('prefers the first source when both match', () => {
    expect(matchingReply(['needle'], ['current needle', 'captured needle'])).toBe('current needle');
  });

  it('falls to the captured reply when only it matches', () => {
    expect(matchingReply(['needle'], ['current, moved on', 'captured Needle'])).toBe(
      'captured Needle',
    );
    expect(matchingReply(['needle'], [undefined, 'captured needle'])).toBe('captured needle');
  });

  it('is undefined when no source matches or there is no query word', () => {
    expect(matchingReply(['needle'], ['a', 'b'])).toBeUndefined();
    expect(matchingReply([], ['a needle'])).toBeUndefined();
  });
});
