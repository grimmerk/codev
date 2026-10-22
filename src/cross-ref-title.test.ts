import { describe, expect, it } from 'vitest';
import { pickSessionByTabTitle } from './cross-ref-title';

const titles = new Map([
  ['s-fix', 'Fix'],
  ['s-fix-backend', 'Fix backend'],
  ['s-other', 'Other'],
]);
const none = () => false;

describe('pickSessionByTabTitle', () => {
  it('takes the most specific title when one contains another', () => {
    // The tab title contains both `Fix` and `Fix backend`; the old loop took
    // whichever it met first.
    expect(
      pickSessionByTabTitle('✳ Fix backend', ['s-fix', 's-fix-backend'], titles, none),
    ).toBe('s-fix-backend');
    expect(
      pickSessionByTabTitle('✳ Fix backend', ['s-fix-backend', 's-fix'], titles, none),
    ).toBe('s-fix-backend');
  });

  it('only picks from the candidates, never another transcript in the directory', () => {
    expect(pickSessionByTabTitle('✳ Fix backend', ['s-fix'], titles, none)).toBe('s-fix');
    expect(pickSessionByTabTitle('✳ Other', ['s-fix'], titles, none)).toBeUndefined();
  });

  it('skips a session already placed on another process', () => {
    expect(
      pickSessionByTabTitle('✳ Fix backend', ['s-fix', 's-fix-backend'], titles, id => id === 's-fix-backend'),
    ).toBe('s-fix');
  });

  it('returns nothing for a candidate without a title or a tab that names no one', () => {
    expect(pickSessionByTabTitle('anything', ['s-untitled'], titles, none)).toBeUndefined();
    expect(pickSessionByTabTitle('9e439ca9-5a3b-4e', ['s-fix', 's-other'], titles, none)).toBeUndefined();
  });
});
