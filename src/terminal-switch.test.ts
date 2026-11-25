import { describe, expect, it } from 'vitest';
import {
  buildGhosttySwitchScript,
  buildITerm2SwitchScript,
  buildTerminalAppSwitchScript,
  escapeAppleScript,
  LOOP_MARK,
  splitSwitchOutput,
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
      expect(script.trim().endsWith('return "not found" & cvLoop\nend tell')).toBe(true);
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

// Issue #177: each step reads every item's key in one statement and keeps
// the per-item loop only as its fallback. These tests pin the structure;
// the behaviour against real terminals is checked by hand (see the PR).
describe('switch script: bulk read first, per-item loop only as fallback', () => {
  const all = [
    {
      name: 'Ghostty',
      script: buildGhosttySwitchScript(7, 'gg', 'tty-first', '/p'),
      reads: [
        '«class Gtty» of every terminal of every tab of every window',
        'name of every terminal of every tab of every window',
        'working directory of every terminal of every tab of every window',
      ],
      verify: ['(«class Gtty» of term) ends with targetTty', '(name of term) contains "gg"', '(working directory of term) is "/p"'],
      focus: 'focus term',
    },
    {
      name: 'iTerm2',
      script: buildITerm2SwitchScript(7, 'gg', 'tty-first'),
      reads: [
        'tty of every session of every tab of every window',
        'name of every session of every tab of every window',
      ],
      verify: ['(tty of s) ends with targetTty', '(name of s) contains "gg"'],
      focus: 'select s',
    },
    {
      name: 'Terminal.app',
      script: buildTerminalAppSwitchScript(7, 'gg', 'tty-first'),
      reads: ['tty of every tab of every window', 'custom title of every tab of every window'],
      verify: ['(tty of t) ends with targetTty', '(custom title of t) contains "gg"'],
      focus: 'set selected tab of w to t',
    },
  ];

  for (const { name, script, reads, verify, focus } of all) {
    it(`${name}: every step starts with one bulk read, in step order`, () => {
      const at = reads.map((r) => script.indexOf(`set cvAll to ${r}`));
      expect(at.every((i) => i > -1)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(script.split('set cvAll to ').length - 1).toBe(reads.length);
    });

    it(`${name}: each step's loop runs only when its bulk path did not finish`, () => {
      const guards = script.split('if not cvDone then').length - 1;
      expect(guards).toBe(reads.length);
      expect(script.split(`set cvLoop to "${LOOP_MARK}"`).length - 1).toBe(reads.length);
      // The bulk path ends by marking itself done inside its `try`; an error
      // anywhere before that (the read, a failed re-check) leaves it false.
      expect(script.split('set cvDone to true\n').length - 1).toBe(reads.length);
    });

    it(`${name}: a bulk match is read again and brought forward only if it still matches`, () => {
      for (const v of verify) {
        const check = script.indexOf(`if ${v} then`);
        expect(check).toBeGreaterThan(-1);
        const after = script.slice(check);
        // the focus comes before the step's `error "moved"` (the re-check failed)
        expect(after.indexOf(focus)).toBeGreaterThan(-1);
        expect(after.indexOf(focus)).toBeLessThan(after.indexOf('error "moved"'));
      }
    });

    it(`${name}: every exit says which path it took`, () => {
      const returns = [...script.matchAll(/return "[^"]*"(.*)/g)];
      expect(returns.length).toBeGreaterThan(0);
      for (const m of returns) expect(m[1]).toBe(' & cvLoop');
      expect(script.indexOf('set cvLoop to ""')).toBeLessThan(script.indexOf('set cvAll to'));
    });

    it(`${name}: a missing value is skipped, never compared`, () => {
      const skips = script.split('if cvV is not missing value then').length - 1;
      expect(skips).toBe(reads.length);
    });
  }

  it('Ghostty: the bulk read uses the raw tty code too, so stable Ghostty still compiles', () => {
    const script = buildGhosttySwitchScript(7, undefined, 'tty-first', '/p');
    expect(script).toContain('set cvAll to «class Gtty» of every terminal');
    expect(script).not.toMatch(/\btty of (every|term)\b/);
  });

  it('the title and the path are escaped in the bulk test and the re-check alike', () => {
    const script = buildGhosttySwitchScript(7, 'say "hi"', 'title-first', '/a "b"');
    expect(script.split('contains "say \\"hi\\""').length - 1).toBe(3); // test, re-check, loop
    expect(script.split('is "/a \\"b\\""').length - 1).toBe(3);
  });
});

describe('splitSwitchOutput', () => {
  it('separates the result from the loop mark', () => {
    expect(splitSwitchOutput('found-by-tty\n')).toEqual({ result: 'found-by-tty', loop: false });
    expect(splitSwitchOutput(`found-by-cwd${LOOP_MARK}\n`)).toEqual({ result: 'found-by-cwd', loop: true });
    expect(splitSwitchOutput(`not found${LOOP_MARK}`)).toEqual({ result: 'not found', loop: true });
    expect(splitSwitchOutput(undefined)).toEqual({ result: '', loop: false });
  });
});
