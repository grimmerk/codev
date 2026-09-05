import { describe, expect, it } from 'vitest';

import {
  extractSnippet,
  findPromptMatch,
  isMinorSession,
  matchesAllWords,
  matchesAllWordsOrId,
  matchesSessionId,
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

  // The band between the fallback's head slice and `max`. A head-window check
  // (`at < max - 1`) calls this visible, but truncateMiddle elides the middle,
  // so the match lands in the gap — the one thing this helper promises cannot
  // happen. Asking the fallback whether it shows the match closes it.
  it('reveals a match that the fallback would elide from the middle', () => {
    const text = `${'a'.repeat(40)}NEEDLE${'c'.repeat(200)}`;
    expect(truncateMiddle(text, 60)).not.toContain('NEEDLE');
    expect(windowAroundMatch(text, ['needle'], 60)).toContain('NEEDLE');
  });

  // A "capped" line that overruns its cap is not capped. Both ellipses count.
  it('never exceeds the budget, ellipses included', () => {
    for (const max of [20, 40, 60, 81]) {
      for (const words of [['needle'], ['absent'], []]) {
        expect(windowAroundMatch(long, words, max).length).toBeLessThanOrEqual(
          max,
        );
      }
      const nearEnd = `${'a'.repeat(300)}NEEDLE`;
      expect(
        windowAroundMatch(nearEnd, ['needle'], max).length,
      ).toBeLessThanOrEqual(max);
    }
  });

  it('falls back to the ordinary rendering when nothing matches', () => {
    expect(windowAroundMatch(long, ['absent'], 60)).toBe(
      truncateMiddle(long, 60),
    );
    expect(windowAroundMatch(long, [], 60)).toBe(truncateMiddle(long, 60));
  });

  it('does not move the window for a match the fallback already shows', () => {
    const text = `NEEDLE${'x'.repeat(200)}`;
    expect(windowAroundMatch(text, ['needle'], 60)).toBe(
      truncateMiddle(text, 60),
    );
  });

  // Discriminating: the two candidate windows are disjoint, so centring on the
  // later word would exclude the earlier one and the assertion would fail.
  it('uses the EARLIEST match when several words hit', () => {
    const text = `${'a'.repeat(150)}FIRST${'b'.repeat(400)}SECOND${'c'.repeat(150)}`;
    const out = windowAroundMatch(text, ['second', 'first'], 60);
    expect(out).toContain('FIRST');
    expect(out).not.toContain('SECOND');
  });

  it('leaves text shorter than the window alone', () => {
    expect(windowAroundMatch('tiny NEEDLE', ['needle'], 60)).toBe(
      'tiny NEEDLE',
    );
  });

  // A repeated word: the earliest occurrence picks where to centre, but if the
  // ordinary rendering already shows a LATER one the reader still gets a
  // highlight — and gets it without the text jumping. The contract is "a match
  // is visible", not "this particular occurrence is".
  it('keeps the ordinary rendering when it already shows some occurrence', () => {
    // The earliest occurrence must be ELIDED and a later one visible, or the
    // test never reaches the branch it names.
    const text = `${'a'.repeat(40)}NEEDLE${'b'.repeat(200)}NEEDLE-tail`;
    const plain = truncateMiddle(text, 60);
    expect(plain.slice(0, 30)).not.toContain('NEEDLE'); // earliest is elided
    expect(plain).toContain('NEEDLE'); // a later one survives
    expect(windowAroundMatch(text, ['needle'], 60)).toBe(plain);
  });

  it('windows when NO occurrence survives the ordinary rendering', () => {
    const text = `${'a'.repeat(60)}NEEDLE${'b'.repeat(60)}NEEDLE${'c'.repeat(200)}`;
    expect(truncateMiddle(text, 60)).not.toContain('NEEDLE');
    expect(windowAroundMatch(text, ['needle'], 60)).toContain('NEEDLE');
  });
  // The windowed branch exists to contain the match, so a long search word
  // must not be swallowed by the trailing ellipsis it makes room for.
  it('keeps a LONG matched word whole, not just its start', () => {
    const word = 'w'.repeat(30);
    const text = `${'a'.repeat(200)}${word}${'b'.repeat(200)}`;
    const out = windowAroundMatch(text, [word], 60);
    expect(out).toContain(word);
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it('shows a word longer than the window from its first character', () => {
    const word = 'w'.repeat(90);
    const text = `${'a'.repeat(200)}${word}${'b'.repeat(200)}`;
    const out = windowAroundMatch(text, [word], 60);
    expect(out.length).toBeLessThanOrEqual(60);
    // Cut at the end is unavoidable; cut at the START would hide where the
    // match begins, which is the part that tells you why the row is here.
    expect(out.replace(/…/g, '').startsWith('w')).toBe(true);
  });
  // toLowerCase() can CHANGE LENGTH — 'İ' becomes two code units — so an index
  // taken in a lowercased copy does not address the same character in the
  // source. Slicing by it shears the first matched character off the window.
  it('keeps source offsets when case folding changes length', () => {
    const text = `${'İ'.repeat(40)}${'a'.repeat(120)}NEEDLE${'b'.repeat(120)}`;
    const out = windowAroundMatch(text, ['needle'], 60);
    expect(out).toContain('NEEDLE');
    expect(out.length).toBeLessThanOrEqual(60);
  });

  // The row is listed by matchesAllWords, so the window must find the same
  // match — a regex with /i folds differently and would show no highlight.
  it('agrees with the filter on Unicode case folding', () => {
    const text = `${'a'.repeat(200)}İ${'b'.repeat(200)}`;
    expect(matchesAllWords(text.toLowerCase(), ['i'])).toBe(true);
    const out = windowAroundMatch(text, ['i'], 60);
    expect(out).toContain('İ');
  });

  // A query can begin INSIDE a folding expansion: the combining dot is the
  // second half of what 'İ' lowercases to. A prefix count can only name whole
  // source characters, so it reported the character AFTER 'İ' and the span came
  // back EMPTY — and an empty hit makes `plain.includes(hit)` trivially true,
  // so the fallback was always accepted and the only match could stay hidden.
  it('resolves a match that starts inside a folding expansion', () => {
    const text = `${'a'.repeat(200)}İ${'b'.repeat(200)}`;
    const out = windowAroundMatch(text, ['\u0307'], 60);
    expect(out).toContain('İ');
    expect(out.length).toBeLessThanOrEqual(60);
  });

  it('treats a query word as literal text, not a pattern', () => {
    const text = `${'a'.repeat(200)}a+b(c)${'d'.repeat(200)}`;
    expect(windowAroundMatch(text, ['a+b(c)'], 60)).toContain('a+b(c)');
  });

  it('honours a budget too small for any window', () => {
    const text = `${'a'.repeat(200)}NEEDLE${'b'.repeat(200)}`;
    for (const max of [0, 1, 2]) {
      expect(
        windowAroundMatch(text, ['needle'], max).length,
      ).toBeLessThanOrEqual(max);
    }
  });
});

describe('truncateMiddle lower boundary', () => {
  it('never returns more than max, even at 0 and 1', () => {
    expect(truncateMiddle('ab', 0)).toBe('');
    expect(truncateMiddle('ab', 1)).toBe('…');
    expect(truncateMiddle('abcdef', 2).length).toBe(2);
    expect(truncateMiddle('abcdef', 3).length).toBe(3);
  });
});

describe('matchesSessionId — the id is a prefix target, not a substring', () => {
  const id = '4ed7505a-eae6-43a5-827b-465c8b5eb759';

  it('matches a hex prefix of four or more characters, hyphens allowed', () => {
    expect(matchesSessionId(id, '4ed7')).toBe(true);
    expect(matchesSessionId(id, '4ed7505a-eae6')).toBe(true);
    expect(matchesSessionId(id, id)).toBe(true);
    expect(matchesSessionId(id, '4ED7'.toLowerCase())).toBe(true);
  });

  it('refuses short or non-hex words, and anything not at the start', () => {
    // `de`, `cafe`-style fragments appear inside nearly every UUID; as
    // substrings they would match the whole corpus regardless of content.
    expect(matchesSessionId(id, 'de')).toBe(false);
    expect(matchesSessionId(id, 'eae6')).toBe(false); // inside, not a prefix
    expect(matchesSessionId(id, '4ed7x')).toBe(false);
    expect(matchesSessionId(id, '')).toBe(false);
  });

  it('matchesAllWordsOrId lets each word hit the text or the id', () => {
    const text = 'fred-ff nextjs backend and mcp arch';
    expect(matchesAllWordsOrId(text, id, ['nextjs', '4ed7'])).toBe(true);
    expect(matchesAllWordsOrId(text, id, ['nextjs', 'eae6'])).toBe(false);
    // Plain text search is unchanged by the id rule.
    expect(matchesAllWordsOrId(text, id, ['mcp', 'arch'])).toBe(
      matchesAllWords(text, ['mcp', 'arch']),
    );
  });
});
