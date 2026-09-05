import { describe, expect, it } from 'vitest';

import {
  compileQuery,
  emptyQuery,
  extractSnippet,
  findPrRef,
  findPromptMatch,
  highlightNeedles,
  isEmptyQuery,
  isImageMarkerHash,
  isMinorSession,
  matchesAllWords,
  matchesAllWordsOrId,
  matchesSessionId,
  parsePrRef,
  parseQuery,
  parseQueryDate,
  promptNeedles,
  QueryTarget,
  sessionRepos,
  tokenizeQuery,
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

describe('tokenizeQuery', () => {
  it('splits on whitespace and keeps a quoted phrase together, quotes removed', () => {
    expect(tokenizeQuery('a  b\tc')).toEqual(['a', 'b', 'c']);
    expect(tokenizeQuery('title:"foo bar" x')).toEqual(['title:foo bar', 'x']);
    expect(tokenizeQuery('"foo bar"')).toEqual(['foo bar']);
  });

  it('lets an unterminated quote run to the end (someone is still typing)', () => {
    expect(tokenizeQuery('a "foo bar')).toEqual(['a', 'foo bar']);
  });
});

describe('parsePrRef', () => {
  it('reads the URL, owner/repo#N and #N forms, never a bare number', () => {
    expect(parsePrRef('https://github.com/grimmerk/codev/pull/147')).toEqual({
      number: 147,
      repo: 'grimmerk/codev',
    });
    expect(
      parsePrRef('https://github.com/grimmerk/codev/issues/144#issuecomment-1'),
    ).toEqual({ number: 144, repo: 'grimmerk/codev' });
    expect(parsePrRef('grimmerk/codev/pull/137')).toEqual({
      number: 137,
      repo: 'grimmerk/codev',
    });
    expect(parsePrRef('github.com/o/r/pull/9/files')).toEqual({
      number: 9,
      repo: 'o/r',
    });
    expect(parsePrRef('grimmerk/codev#147')).toEqual({
      number: 147,
      repo: 'grimmerk/codev',
    });
    expect(parsePrRef('#147')).toEqual({ number: 147 });
    expect(parsePrRef('147')).toBeNull();
    expect(parsePrRef('#abc')).toBeNull();
    // Leading zeros are not a PR number, here as in the miner.
    expect(parsePrRef('#012')).toBeNull();
    expect(parsePrRef('#0')).toBeNull();
    expect(parsePrRef('o/r#012')).toBeNull();
    expect(parsePrRef('https://github.com/o/r/pull/012')).toBeNull();
    expect(parsePrRef('https://github.com/grimmerk/codev')).toBeNull();
    // A scheme must be followed by the GitHub host; a dotted owner is not an
    // owner; a subdomain is not github.com.
    expect(parsePrRef('https://example.com/o/pull/1')).toBeNull();
    expect(parsePrRef('example.com/o/pull/1')).toBeNull();
    expect(parsePrRef('https://evil.github.com/o/r/pull/1')).toBeNull();
    expect(parsePrRef('https://www.github.com/o/r/pull/1')).toEqual({
      number: 1,
      repo: 'o/r',
    });
  });
});

describe('parseQueryDate', () => {
  const now = new Date(2026, 8, 5, 15, 30).getTime();
  it('reads YYYY-MM-DD as local midnight, Nh/Nd/Nw as ago, today and yesterday', () => {
    expect(parseQueryDate('2026-09-01', now)).toBe(
      new Date(2026, 8, 1).getTime(),
    );
    expect(parseQueryDate('7d', now)).toBe(now - 7 * 86400000);
    expect(parseQueryDate('2w', now)).toBe(now - 14 * 86400000);
    expect(parseQueryDate('3h', now)).toBe(now - 3 * 3600000);
    expect(parseQueryDate('today', now)).toBe(new Date(2026, 8, 5).getTime());
    expect(parseQueryDate('yesterday', now)).toBe(
      new Date(2026, 8, 4).getTime(),
    );
    expect(parseQueryDate('soon', now)).toBeNull();
    expect(parseQueryDate('2026-13-40', now)).toBeNull();
  });
});

describe('parseQuery', () => {
  const now = new Date(2026, 8, 5, 15, 30).getTime();

  it('keeps a query with no operators exactly as before: lowercased bare words', () => {
    const q = parseQuery('Multi  Sessions', now);
    expect(q.words).toEqual(['multi', 'sessions']);
    expect(q.fields).toEqual([]);
    expect(q.prRefs).toEqual([]);
    expect(q.ignored).toEqual([]);
  });

  it('routes each operator: fields, has:, is:, after:/before:, pr:', () => {
    const q = parseQuery(
      'title:PR2 branch:mcp msg:"deploy now" project:fred account:work recap:next has:pr is:live after:7d before:2026-09-01 pr:147',
      now,
    );
    expect(q.fields).toEqual([
      { field: 'title', value: 'pr2' },
      { field: 'branch', value: 'mcp' },
      { field: 'msg', value: 'deploy now' },
      { field: 'project', value: 'fred' },
      { field: 'account', value: 'work' },
      { field: 'recap', value: 'next' },
    ]);
    expect(q.has).toEqual(['pr']);
    expect(q.is).toEqual(['live']);
    expect(q.after).toBe(now - 7 * 86400000);
    expect(q.before).toBe(new Date(2026, 8, 1).getTime());
    expect(q.prRefs).toEqual([{ number: 147, strict: true }]);
    expect(q.words).toEqual([]);
  });

  it('recognises PR references in every spelling, and pr: with a repo or URL', () => {
    const q = parseQuery(
      '#147 grimmerk/codev#148 https://github.com/o/r/pull/9 pr:o/r#10 pr:https://github.com/o/r/issues/11',
      now,
    );
    expect(q.prRefs).toEqual([
      { number: 147 },
      { number: 148, repo: 'grimmerk/codev' },
      { number: 9, repo: 'o/r' },
      { number: 10, repo: 'o/r' },
      { number: 11, repo: 'o/r' },
    ]);
    expect(q.words).toEqual([]);
  });

  it('leaves an unknown key:, a clock time and a non-PR URL as bare words', () => {
    const q = parseQuery('error:ENOENT 12:30 https://example.com/x foo', now);
    expect(q.words).toEqual([
      'error:enoent',
      '12:30',
      'https://example.com/x',
      'foo',
    ]);
    expect(q.ignored).toEqual([]);
  });

  it('reports an operator whose value is unusable instead of silently dropping it', () => {
    const q = parseQuery(
      'title: has:tea is:cold after:soon pr:abc pr:012 ok',
      now,
    );
    expect(q.ignored).toEqual([
      'title:',
      'has:tea',
      'is:cold',
      'after:soon',
      'pr:abc',
      'pr:012',
    ]);
    expect(q.words).toEqual(['ok']);
  });

  it('keeps a leading-zero hash as a bare word rather than reading it as a PR', () => {
    const q = parseQuery('#012', now);
    expect(q.prRefs).toEqual([]);
    expect(q.words).toEqual(['#012']);
  });

  it('accepts is:running and is:active as is:live', () => {
    expect(parseQuery('is:running', now).is).toEqual(['live']);
    expect(parseQuery('is:active', now).is).toEqual(['live']);
  });

  it('narrows repeated bounds: the latest after:, the earliest before:', () => {
    const q = parseQuery(
      'after:2026-09-01 after:2026-09-03 before:2026-09-04 before:2026-09-02',
      now,
    );
    expect(q.after).toBe(new Date(2026, 8, 3).getTime());
    expect(q.before).toBe(new Date(2026, 8, 2).getTime());
  });

  it('isEmptyQuery is true only when nothing constrains the result', () => {
    expect(isEmptyQuery(parseQuery('', now))).toBe(true);
    expect(isEmptyQuery(parseQuery('title:', now))).toBe(true);
    expect(isEmptyQuery(emptyQuery())).toBe(true);
    expect(isEmptyQuery(parseQuery('is:live', now))).toBe(false);
    expect(isEmptyQuery(parseQuery('after:1d', now))).toBe(false);
    expect(isEmptyQuery(parseQuery('x', now))).toBe(false);
  });
});

describe('findPrRef', () => {
  it('matches #N, owner/repo#N, /pull/N and /issues/N — delimited, never a bare number', () => {
    expect(findPrRef('see #147 for details', { number: 147 })).toEqual({
      index: 4,
      length: 4,
    });
    expect(findPrRef('grimmerk/codev#147', { number: 147 })).toEqual({
      index: 0,
      length: 18,
    });
    expect(
      findPrRef('x https://github.com/o/r/pull/147/files', { number: 147 }),
    ).toEqual({
      index: 10,
      length: 23,
    });
    expect(
      findPrRef('https://github.com/o/r/issues/147', { number: 147 }),
    ).not.toBeNull();
    expect(findPrRef('#1475 and 15980 and 147', { number: 147 })).toBeNull();
    expect(findPrRef('/pull/1470', { number: 147 })).toBeNull();
    expect(findPrRef('a#147', { number: 147 })).toBeNull();
    // The number must end there: an identifier or a longer number is not it.
    expect(findPrRef('see #147abc', { number: 147 })).toBeNull();
    expect(findPrRef('see #147_x', { number: 147 })).toBeNull();
    expect(findPrRef('/pull/147abc', { number: 147 })).toBeNull();
    // The host must be github.com itself, not the tail of another name.
    expect(
      findPrRef('https://notgithub.com/o/r/pull/147', { number: 147 }),
    ).toBeNull();
    expect(
      findPrRef('https://www.github.com/o/r/pull/147', { number: 147 }),
    ).not.toBeNull();
    expect(
      findPrRef('https://evil.github.com/o/r/pull/147', { number: 147 }),
    ).toBeNull();
    // A path segment inside some other URL is not the host either.
    expect(
      findPrRef('https://example.com/github.com/o/r/pull/147', {
        number: 147,
      }),
    ).toBeNull();
    expect(
      findPrRef('not_github.com/o/r/pull/147', { number: 147 }),
    ).toBeNull();
    expect(
      findPrRef('(github.com/o/r/pull/147)', { number: 147 }),
    ).not.toBeNull();
    expect(findPrRef('see #147, done', { number: 147 })).not.toBeNull();
    expect(findPrRef('(see #147)', { number: 147 })).not.toBeNull();
  });

  it("honours the repo when the reference names one; a bare #N counts only inside that repo's own sessions", () => {
    const ref = { number: 147, repo: 'grimmerk/codev' };
    expect(
      findPrRef('https://github.com/fireflies/fred/pull/147', ref),
    ).toBeNull();
    expect(findPrRef('fireflies/fred#147', ref)).toBeNull();
    expect(
      findPrRef('https://github.com/grimmerk/codev/pull/147', ref),
    ).not.toBeNull();
    expect(findPrRef('grimmerk/codev#147', ref)).not.toBeNull();
    // Live finding: `pr:grimmerk/codev#151` listed eight sessions because a
    // bare `#151` counted regardless of repo. It counts only when the
    // session's own repo context (badge URL, qualified refs) names the repo.
    expect(findPrRef('opened #147 today', ref)).toBeNull();
    expect(findPrRef('opened #147 today', ref, ['fireflies/fred'])).toBeNull();
    expect(
      findPrRef('opened #147 today', ref, ['fireflies/fred', 'Grimmerk/CodeV']),
    ).not.toBeNull();
    // A wrong-repo hit does not hide a right one further on.
    expect(
      findPrRef('fireflies/fred#147 then grimmerk/codev#147', ref),
    ).toEqual({
      index: 24,
      length: 18,
    });
  });

  it('pr:N is strict: a badge URL or a qualified mention counts, a bare #N does not', () => {
    const strict = { number: 147, strict: true };
    expect(findPrRef('opened #147 today', strict)).toBeNull();
    expect(findPrRef('opened #147 today', strict, ['o/r'])).toBeNull();
    expect(
      findPrRef('pr #147 https://github.com/o/r/pull/147', strict),
    ).not.toBeNull();
    expect(findPrRef('o/r#147', strict)).not.toBeNull();
    // The bare query form stays broad.
    expect(findPrRef('opened #147 today', { number: 147 })).not.toBeNull();
  });

  it('sessionRepos derives the repo context from the badge URL and qualified refs', () => {
    expect(
      sessionRepos('https://github.com/Grimmerk/CodeV/pull/151', [
        '#3',
        'o/r#5',
        'grimmerk/codev#151',
      ]),
    ).toEqual(['grimmerk/codev', 'o/r']);
    expect(sessionRepos(undefined, undefined)).toEqual([]);
    expect(sessionRepos('not a url', ['#1'])).toEqual([]);
    expect(sessionRepos('https://evil.github.com/o/r/pull/1')).toEqual([]);
    expect(sessionRepos('https://example.com/github.com/o/r/pull/1')).toEqual(
      [],
    );
  });

  // Live finding: `pr:151` listed a session whose only "#151" was the marker
  // Claude Code writes for a pasted screenshot.
  it('does not read the [Image #N] paste marker as a reference, but still finds a real one after it', () => {
    expect(
      findPrRef('[image #151] tested the packaged build', { number: 151 }),
    ).toBeNull();
    expect(findPrRef('[Image #151]'.toLowerCase(), { number: 151 })).toBeNull();
    expect(findPrRef('[image #151] then see #151', { number: 151 })).toEqual({
      index: 22,
      length: 4,
    });
    expect(isImageMarkerHash('[Image #3]', 7)).toBe(true);
    expect(isImageMarkerHash('image #3', 6)).toBe(false);
    expect(isImageMarkerHash('#3', 0)).toBe(false);
  });
});

describe('compileQuery', () => {
  const now = new Date(2026, 8, 5, 15, 30).getTime();
  const target: QueryTarget = {
    sessionId: '4ed7505a-eae6-43a5-827b-465c8b5eb759',
    text: 'codev /Users/g/git/codev open the PR for me #147 harden again',
    title: 'agentic-fred harden again - pr2-1533',
    branch: 'feat-mcp-arch',
    project: 'codev /Users/g/git/codev',
    account: 'work',
    recap: 'Next: push the fix',
    prompts: ['open the PR for me', 'now address #147'],
    hasPr: true,
    isLive: true,
    isPinned: false,
    lastTimestamp: new Date(2026, 8, 4).getTime(),
  };
  const matches = (query: string, t = target) =>
    compileQuery(parseQuery(query, now)).test(t);

  it('bare words search the text, case-insensitively, and the session id by prefix', () => {
    expect(matches('HARDEN codev')).toBe(true);
    expect(matches('harden absent')).toBe(false);
    expect(matches('4ed7')).toBe(true);
    expect(matches('4ed')).toBe(false);
  });

  it('scoped terms look only at their field', () => {
    expect(matches('title:pr2')).toBe(true);
    expect(matches('title:codev')).toBe(false);
    expect(matches('branch:mcp')).toBe(true);
    expect(matches('project:git/codev')).toBe(true);
    expect(matches('account:work')).toBe(true);
    expect(matches('account:home')).toBe(false);
    expect(matches('recap:push')).toBe(true);
    expect(matches('msg:address')).toBe(true);
    expect(matches('msg:harden')).toBe(false);
  });

  it('a scoped term fails on a target that lacks the field, so a caller must not compile what it cannot judge', () => {
    expect(matches('title:pr2', { ...target, title: undefined })).toBe(false);
    expect(matches('msg:open', { ...target, prompts: undefined })).toBe(false);
    expect(matches('is:live', { ...target, isLive: undefined })).toBe(false);
  });

  it('has:, is:, after:, before: read the flags and the timestamp', () => {
    expect(matches('has:pr has:title has:branch has:recap')).toBe(true);
    expect(matches('has:pr', { ...target, hasPr: false })).toBe(false);
    expect(matches('has:recap', { ...target, recap: '' })).toBe(false);
    expect(matches('is:live')).toBe(true);
    expect(matches('is:pinned')).toBe(false);
    expect(matches('after:2026-09-04')).toBe(true);
    expect(matches('after:2026-09-05')).toBe(false);
    expect(matches('before:2026-09-05')).toBe(true);
    expect(matches('before:2026-09-04')).toBe(false);
    expect(matches('after:1d', { ...target, lastTimestamp: undefined })).toBe(
      false,
    );
  });

  it('PR references match any spelling in the text, and every term must hold', () => {
    expect(matches('#147')).toBe(true);
    expect(matches('#147 title:nope')).toBe(false);
    // The fixture text carries only a bare `#147`: broad finds it, strict
    // needs the badge URL (what both callers append when a badge exists) or
    // the session's own repo context.
    expect(matches('pr:147')).toBe(false);
    const badged = {
      ...target,
      text: `${target.text} PR #147 https://github.com/grimmerk/codev/pull/147`,
    };
    expect(matches('pr:147 title:pr2', badged)).toBe(true);
    expect(matches('pr:148', badged)).toBe(false);
    expect(matches('grimmerk/codev#147', badged)).toBe(true);
    expect(matches('fireflies/fred#147', badged)).toBe(false);
    expect(matches('grimmerk/codev#147')).toBe(false);
    expect(
      matches('grimmerk/codev#147', { ...target, repos: ['grimmerk/codev'] }),
    ).toBe(true);
    expect(
      matches('pr:https://github.com/grimmerk/codev/pull/147', badged),
    ).toBe(true);
  });

  it('an ignored operator does not constrain the match', () => {
    expect(matches('after:soon harden')).toBe(true);
  });
});

describe('highlightNeedles / promptNeedles', () => {
  it('collects words, scoped values and the spellings of each PR reference, deduplicated', () => {
    const q = parseQuery('foo title:bar msg:baz #147 foo', 0);
    expect(highlightNeedles(q)).toEqual([
      'foo',
      'bar',
      'baz',
      '#147',
      '/pull/147',
      '/issues/147',
    ]);
    expect(promptNeedles(q)).toEqual(['foo', 'foo', 'baz']);
  });
});

describe('findPromptMatch with PR references', () => {
  it('lands on the prompt carrying the reference when no word matches', () => {
    const m = findPromptMatch(
      ['setup', 'please look at o/r#147 now'],
      [],
      [{ number: 147 }],
    );
    expect(m).toEqual({
      promptIndex: 1,
      snippet: 'please look at o/r#147 now',
    });
  });
});
