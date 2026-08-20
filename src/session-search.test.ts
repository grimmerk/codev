import { describe, expect, it } from 'vitest';

import {
  extractSnippet,
  findPromptMatch,
  isMinorSession,
  matchesAllWords,
  truncateMiddle,
  windowAroundMatch,
} from './session-search';

describe('matchesAllWords', () => {
  it('requires every word (AND semantics), matching across the combined text', () => {
    const target =
      'codev multi account /effort 我問一下 sessions 上限'.toLowerCase();
    expect(matchesAllWords(target, ['multi', 'sessions'])).toBe(true);
    expect(matchesAllWords(target, ['multi', 'missing'])).toBe(false);
  });

  it('matches 2-char CJK substrings', () => {
    expect(matchesAllWords('原本的 sessions 數我有設上限', ['上限'])).toBe(
      true,
    );
    expect(matchesAllWords('原本的 sessions 數我有設上限', ['下限'])).toBe(
      false,
    );
  });
});

describe('extractSnippet', () => {
  it('adds ellipses only where text is truncated', () => {
    const text = 'a'.repeat(100) + 'NEEDLE' + 'b'.repeat(100);
    const snippet = extractSnippet(text, 100, 6, 10);
    expect(snippet).toBe('…aaaaaaaaaaNEEDLEbbbbbbbbbb…');
  });

  it('omits leading ellipsis at start of text and collapses whitespace', () => {
    const text =
      'NEEDLE line one\n\n  line two after newline and more trailing text';
    const snippet = extractSnippet(text, 0, 6, 30);
    expect(snippet.startsWith('NEEDLE line one line two')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet).not.toContain('\n');
  });
});

describe('findPromptMatch', () => {
  const prompts = [
    'first prompt about setup',
    'middle prompt mentioning 上限 and performance',
    'last prompt wrapping up',
  ];

  it('finds the first prompt containing a word and reports its index', () => {
    const m = findPromptMatch(prompts, ['上限']);
    expect(m).not.toBeNull();
    expect(m!.promptIndex).toBe(1);
    expect(m!.snippet).toContain('上限');
  });

  it('is case-insensitive against the prompt text', () => {
    const m = findPromptMatch(['Deploy STAGING now'], ['staging']);
    expect(m).not.toBeNull();
    expect(m!.snippet).toContain('STAGING');
  });

  it('returns null when no prompt contains any word (project-only match)', () => {
    expect(findPromptMatch(prompts, ['codev'])).toBeNull();
  });
});

describe('isMinorSession', () => {
  it('folds closed, untitled, PR-less sessions with ≤2 messages', () => {
    expect(
      isMinorSession({ messageCount: 1, isActive: false }, false, false),
    ).toBe(true);
    expect(
      isMinorSession({ messageCount: 2, isActive: false }, false, false),
    ).toBe(true);
  });

  it('never folds active sessions, titled sessions, PR sessions, or 3+ msgs', () => {
    expect(
      isMinorSession({ messageCount: 1, isActive: true }, false, false),
    ).toBe(false);
    expect(
      isMinorSession({ messageCount: 1, isActive: false }, true, false),
    ).toBe(false);
    expect(
      isMinorSession({ messageCount: 1, isActive: false }, false, true),
    ).toBe(false);
    expect(
      isMinorSession({ messageCount: 3, isActive: false }, false, false),
    ).toBe(false);
  });

  it('treats unknown messageCount as not minor (conservative)', () => {
    expect(isMinorSession({ isActive: false }, false, false)).toBe(false);
  });
});

describe('truncateMiddle', () => {
  it('keeps both ends, which is where these titles carry meaning', () => {
    // Real shape from the corpus: the newest step is at the end.
    const t =
      'fred-ff nextjs backend and mcp arch clean up -> nextjs backend arch alternative > canva debug';
    const out = truncateMiddle(t, 60);
    expect(out.length).toBe(60);
    expect(out.startsWith('fred-ff nextjs')).toBe(true);
    expect(out.endsWith('canva debug')).toBe(true);
    expect(out).toContain('…');
  });

  it('distinguishes titles that share a long prefix', () => {
    const a = 'fred-ff nextjs backend and mcp arch clean up -> alternative 0';
    const b = 'fred-ff nextjs backend and mcp arch clean up -> canva debug';
    // The old head-only cut rendered both identically at 35 chars.
    expect(a.slice(0, 35)).toBe(b.slice(0, 35));
    expect(truncateMiddle(a, 40)).not.toBe(truncateMiddle(b, 40));
  });

  it('leaves short text untouched', () => {
    expect(truncateMiddle('short', 60)).toBe('short');
    expect(truncateMiddle('exactly-ten', 11)).toBe('exactly-ten');
  });
});

describe('windowAroundMatch', () => {
  const long = `${'a'.repeat(200)}NEEDLE${'b'.repeat(200)}`;

  it('moves the window so a far-away match is actually visible', () => {
    const out = windowAroundMatch(long, ['needle'], 60);
    expect(out).toContain('NEEDLE');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });

  it('falls back to the ordinary rendering when nothing matches', () => {
    expect(windowAroundMatch(long, ['absent'], 60)).toBe(
      truncateMiddle(long, 60),
    );
    expect(windowAroundMatch(long, [], 60)).toBe(truncateMiddle(long, 60));
  });

  it('does not move the window for a match already in view', () => {
    const text = `NEEDLE${'x'.repeat(200)}`;
    expect(windowAroundMatch(text, ['needle'], 60)).toBe(
      truncateMiddle(text, 60),
    );
  });

  it('uses the EARLIEST match when several words hit', () => {
    const out = windowAroundMatch(long, ['bbb', 'needle'], 60);
    expect(out).toContain('NEEDLE');
  });

  it('leaves text shorter than the window alone', () => {
    expect(windowAroundMatch('tiny NEEDLE', ['needle'], 60)).toBe(
      'tiny NEEDLE',
    );
  });
});
