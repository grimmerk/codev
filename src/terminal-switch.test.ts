import { describe, expect, it } from 'vitest';
import {
  buildITerm2SwitchScript,
  buildTerminalAppSwitchScript,
  escapeAppleScript,
  switchOrderFor,
} from './terminal-switch';

const builders = [
  ['iTerm2', buildITerm2SwitchScript],
  ['Terminal.app', buildTerminalAppSwitchScript],
] as const;

describe('switch script order follows pid provenance', () => {
  it('exact pid → tty first; guessed pid → title first', () => {
    expect(switchOrderFor(true)).toBe('tty-first');
    expect(switchOrderFor(false)).toBe('title-first');
  });

  for (const [name, build] of builders) {
    it(`${name}: tty-first tries the tty block before the title block`, () => {
      const script = build(4242, 'gg', 'tty-first');
      expect(script.indexOf('found-by-tty')).toBeGreaterThan(-1);
      expect(script.indexOf('found-by-tty')).toBeLessThan(
        script.indexOf('found-by-title'),
      );
      expect(script).toContain('ps -o tty= -p 4242');
      expect(script.trim().endsWith('return "not found"\nend tell')).toBe(true);
    });

    it(`${name}: title-first tries the title block before the tty block, keeping both`, () => {
      const script = build(4242, 'gg', 'title-first');
      expect(script.indexOf('found-by-title')).toBeLessThan(
        script.indexOf('found-by-tty'),
      );
      expect(script).toContain('found-by-tty');
    });

    it(`${name}: without a title only the tty block is emitted, whatever the order`, () => {
      for (const order of ['tty-first', 'title-first'] as const) {
        const script = build(7, undefined, order);
        expect(script).toContain('found-by-tty');
        expect(script).not.toContain('found-by-title');
      }
    });

    it(`${name}: the title is escaped for an AppleScript string literal`, () => {
      const script = build(7, 'say "hi" \\ bye', 'title-first');
      expect(script).toContain('contains "say \\"hi\\" \\\\ bye"');
    });
  }

  it('escapeAppleScript escapes backslashes before quotes', () => {
    expect(escapeAppleScript('a\\"b')).toBe('a\\\\\\"b');
  });
});
