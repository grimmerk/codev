import { describe, expect, it } from 'vitest';

import {
  extractSnippet,
  findPromptMatch,
  isMinorSession,
  matchesAllWords,
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
