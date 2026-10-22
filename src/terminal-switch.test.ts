import { describe, expect, it } from 'vitest';
import {
  buildGhosttySwitchScript,
  buildITerm2SwitchScript,
  buildTerminalAppSwitchScript,
  escapeAppleScript,
  switchOrderFor,
} from './terminal-switch';

const ghostty = (pid: number, title: string | undefined, order: 'tty-first' | 'title-first') =>
  buildGhosttySwitchScript(pid, title, order, '/p');

const builders = [
  ['iTerm2', buildITerm2SwitchScript],
  ['Terminal.app', buildTerminalAppSwitchScript],
  ['Ghostty', ghostty],
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

  it('iTerm2 and Terminal.app get no cwd fallback — only Ghostty does', () => {
    for (const build of [buildITerm2SwitchScript, buildTerminalAppSwitchScript]) {
      expect(build(7, 'gg', 'tty-first')).not.toContain('found-by-cwd');
    }
  });

  it('Ghostty: cwd runs last, after tty and title, in either order', () => {
    for (const order of ['tty-first', 'title-first'] as const) {
      const script = ghostty(7, 'gg', order);
      const cwd = script.indexOf('found-by-cwd');
      expect(cwd).toBeGreaterThan(script.indexOf('found-by-tty'));
      expect(cwd).toBeGreaterThan(script.indexOf('found-by-title'));
    }
  });

  it('Ghostty: with no pid there is no tty block, only title then cwd', () => {
    const script = buildGhosttySwitchScript(undefined, 'gg', 'tty-first', '/p');
    expect(script).not.toContain('found-by-tty');
    expect(script).not.toContain('ps -o tty=');
    expect(script.indexOf('found-by-title')).toBeLessThan(script.indexOf('found-by-cwd'));
  });

  it('Ghostty: the tty is read by raw code inside try, so stable Ghostty still compiles', () => {
    // Stable 1.3's dictionary has no `tty`; a plain `tty of term` may fail to
    // compile there and take title and cwd down with it.
    const script = ghostty(7, undefined, 'tty-first');
    expect(script).toContain('«class Gtty» of term');
    expect(script).not.toMatch(/\btty of term\b/);
    expect(script.indexOf('try')).toBeLessThan(script.indexOf('«class Gtty»'));
  });

  it('Ghostty: the project path is escaped for an AppleScript string literal', () => {
    const script = buildGhosttySwitchScript(7, undefined, 'tty-first', '/a "b" \\c');
    expect(script).toContain('is "/a \\"b\\" \\\\c"');
  });

  it('escapeAppleScript escapes backslashes before quotes', () => {
    expect(escapeAppleScript('a\\"b')).toBe('a\\\\\\"b');
  });
});
