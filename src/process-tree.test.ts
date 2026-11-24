import { describe, expect, it } from 'vitest';

import {
  MAX_WALK_HOPS,
  parseCommandLines,
  parseProcessTable,
  walkToTerminal,
} from './process-tree';

// The shape of `TZ=UTC LC_ALL=C ps -axo pid=,ppid=,lstart=,comm=` on macOS,
// captured from a real machine: right-aligned pids, a five-field start time
// (the day of the month padded with a space), then the executable — a full
// path that may contain spaces, or a bare name. Every name and path below is
// invented.
const LISTING = [
  '    1     0 Mon Nov  2 14:19:51 2026     /sbin/launchd',
  '  339     1 Mon Nov  2 14:20:42 2026     /usr/libexec/logd',
  // Ghostty → login → shell → claude
  ' 4249     1 Mon Nov  2 14:22:03 2026     /Applications/Ghostty.app/Contents/MacOS/ghostty',
  ' 7521  4249 Tue Nov  3 07:06:13 2026     /usr/bin/login',
  ' 7547  7521 Tue Nov  3 07:06:13 2026     -/bin/zsh',
  '10251  7547 Tue Nov  3 07:06:18 2026     claude',
  // iTerm2: its server helper lives under a directory with a space in it
  '86698     1 Tue Nov  3 09:00:00 2026     /Applications/iTerm.app/Contents/MacOS/iTerm2',
  '86701 86698 Tue Nov  3 09:00:01 2026     /Users/someone/Library/Application Support/iTerm2/iTermServer-3.7.9',
  '86710 86701 Tue Nov  3 09:00:02 2026     -zsh',
  '86720 86710 Tue Nov  3 09:00:09 2026     claude',
  // Terminal.app
  '  900     1 Tue Nov  3 10:00:00 2026     /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
  '  901   900 Tue Nov  3 10:00:01 2026     login',
  '  902   901 Tue Nov  3 10:00:01 2026     -zsh',
  '  903   902 Tue Nov  3 10:00:05 2026     claude',
  // cmux
  ' 1200     1 Tue Nov  3 11:00:00 2026     /Applications/cmux.app/Contents/MacOS/cmux',
  ' 1201  1200 Tue Nov  3 11:00:01 2026     /bin/zsh',
  ' 1202  1201 Tue Nov  3 11:00:05 2026     claude',
  // The packaged app: its helper is named after it
  ' 2000     1 Tue Nov  3 12:00:00 2026     /Applications/CodeV.app/Contents/MacOS/CodeV',
  ' 2001  2000 Tue Nov  3 12:00:01 2026     /bin/zsh',
  ' 2002  2001 Tue Nov  3 12:00:05 2026     claude',
  // An Electron binary whose path does not say which app it is
  ' 3000     1 Tue Nov  3 13:00:00 2026     /opt/tools/Electron.app/Contents/MacOS/Electron',
  ' 3001  3000 Tue Nov  3 13:00:01 2026     /bin/zsh',
  ' 3002  3001 Tue Nov  3 13:00:05 2026     claude',
  // An editor's helper: no terminal anywhere above it
  ' 5000     1 Tue Nov  3 14:00:00 2026     /Applications/Some Editor.app/Contents/MacOS/Some Editor',
  ' 5001  5000 Tue Nov  3 14:00:01 2026     /Applications/Some Editor.app/Contents/Frameworks/Editor Helper (Plugin).app/Contents/MacOS/Editor Helper (Plugin)',
  ' 5002  5001 Tue Nov  3 14:00:05 2026     claude',
  // Its parent exited: 6000 is not in the listing
  ' 6001  6000 Tue Nov  3 15:00:00 2026     claude',
  // Two pids naming each other as parent (pids reused while ps was reading)
  ' 7001  7002 Tue Nov  3 16:00:00 2026     /bin/zsh',
  ' 7002  7001 Tue Nov  3 16:00:00 2026     /bin/zsh',
  '',
].join('\n');

describe('parseProcessTable', () => {
  const table = parseProcessTable(LISTING);

  it('reads pid, parent, start and the executable of every line', () => {
    expect(table.size).toBe(29);
    expect(table.get(10251)).toEqual({
      pid: 10251,
      ppid: 7547,
      start: 'Tue Nov 3 07:06:18 2026',
      comm: 'claude',
    });
    expect(table.get(1)).toEqual({
      pid: 1,
      ppid: 0,
      start: 'Mon Nov 2 14:19:51 2026',
      comm: '/sbin/launchd',
    });
  });

  it('keeps an executable path whole when it contains spaces', () => {
    expect(table.get(86701)?.comm).toBe(
      '/Users/someone/Library/Application Support/iTerm2/iTermServer-3.7.9',
    );
    expect(table.get(5001)?.comm).toBe(
      '/Applications/Some Editor.app/Contents/Frameworks/Editor Helper (Plugin).app/Contents/MacOS/Editor Helper (Plugin)',
    );
  });

  it('skips what is not a process line, and survives no input', () => {
    expect(parseProcessTable('  PID  PPID STARTED COMM\nnot a line\n 12 x y\n').size).toBe(0);
    expect(parseProcessTable('').size).toBe(0);
    expect(parseProcessTable(null).size).toBe(0);
    expect(parseProcessTable(undefined).size).toBe(0);
  });
});

describe('walkToTerminal', () => {
  const table = parseProcessTable(LISTING);
  const terminalOf = (pid: number) => walkToTerminal(table, pid).terminal;

  it('names the terminal at the top of each chain', () => {
    expect(walkToTerminal(table, 10251)).toEqual({ terminal: 'ghostty', hops: 4 });
    expect(terminalOf(86720)).toBe('iterm2');
    expect(terminalOf(903)).toBe('terminal');
    expect(terminalOf(1202)).toBe('cmux');
    expect(terminalOf(2002)).toBe('codev');
  });

  it('matches iTerm at its helper, whose path has a space, before reaching the app', () => {
    expect(walkToTerminal(table, 86720)).toEqual({ terminal: 'iterm2', hops: 3 });
  });

  it('matches a bare "Terminal" only as the whole name', () => {
    const bare = parseProcessTable(
      [
        '  50     1 Tue Nov  3 10:00:00 2026     Terminal',
        '  51    50 Tue Nov  3 10:00:01 2026     claude',
        '  60     1 Tue Nov  3 10:00:00 2026     /opt/terminal-helper',
        '  61    60 Tue Nov  3 10:00:01 2026     claude',
      ].join('\n'),
    );
    expect(walkToTerminal(bare, 51).terminal).toBe('terminal');
    expect(walkToTerminal(bare, 61).terminal).toBe('unknown');
  });

  it('is unknown when no ancestor is a terminal', () => {
    expect(walkToTerminal(table, 5002)).toEqual({ terminal: 'unknown', hops: 3 });
  });

  it('is unknown for a pid that is not in the listing', () => {
    expect(walkToTerminal(table, 424242)).toEqual({ terminal: 'unknown', hops: 0 });
  });

  it('stops at a parent that is gone', () => {
    expect(walkToTerminal(table, 6001)).toEqual({ terminal: 'unknown', hops: 1 });
  });

  it('never looks at pid 1, and answers for pid 1 itself without walking on', () => {
    // 339's parent is launchd: the walk ends at 339.
    expect(walkToTerminal(table, 339)).toEqual({ terminal: 'unknown', hops: 1 });
    expect(walkToTerminal(table, 1)).toEqual({ terminal: 'unknown', hops: 1 });
    // Even a launchd that looked like a terminal would not be asked.
    const odd = parseProcessTable(
      [
        '    1     0 Mon Nov  2 14:19:51 2026     /odd/ghostty',
        '   70     1 Tue Nov  3 10:00:00 2026     claude',
      ].join('\n'),
    );
    expect(walkToTerminal(odd, 70).terminal).toBe('unknown');
  });

  it('stops at a cycle after visiting each pid once', () => {
    const walked = walkToTerminal(table, 7001);
    expect(walked.terminal).toBe('unknown');
    expect(walked.hops).toBe(2);
    expect(walked.hops).toBeLessThan(MAX_WALK_HOPS);
  });

  it('stops a process that is its own parent after one look', () => {
    const self = parseProcessTable('  80    80 Tue Nov  3 10:00:00 2026     /bin/zsh\n');
    expect(walkToTerminal(self, 80)).toEqual({ terminal: 'unknown', hops: 1 });
  });

  describe('an Electron ancestor', () => {
    it('asks for the command line it was not given', () => {
      expect(walkToTerminal(table, 3002)).toEqual({
        terminal: 'unknown',
        hops: 3,
        needCmdline: 3000,
      });
    });

    it('is CodeV when its command line says so', () => {
      const cmdlines = new Map([[3000, '/opt/tools/Electron.app/Contents/MacOS/Electron /src/CodeV']]);
      expect(walkToTerminal(table, 3002, cmdlines)).toEqual({ terminal: 'codev', hops: 3 });
    });

    it('is walked past when its command line names another app', () => {
      const cmdlines = new Map([[3000, '/opt/tools/Electron.app/Contents/MacOS/Electron /src/other']]);
      expect(walkToTerminal(table, 3002, cmdlines)).toEqual({ terminal: 'unknown', hops: 3 });
      // …and an empty one (the process did not answer) is no match either.
      expect(walkToTerminal(table, 3002, new Map([[3000, '']])).terminal).toBe('unknown');
    });

    it('needs no command line when the path already names codev', () => {
      const dev = parseProcessTable(
        [
          ' 90     1 Tue Nov  3 10:00:00 2026     /src/codev/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
          ' 91    90 Tue Nov  3 10:00:01 2026     claude',
        ].join('\n'),
      );
      expect(walkToTerminal(dev, 91)).toEqual({ terminal: 'codev', hops: 2 });
    });

    it('is not asked about when a terminal sits below it', () => {
      const nested = parseProcessTable(
        [
          ' 95     1 Tue Nov  3 10:00:00 2026     /opt/tools/Electron.app/Contents/MacOS/Electron',
          ' 96    95 Tue Nov  3 10:00:00 2026     /Applications/Ghostty.app/Contents/MacOS/ghostty',
          ' 97    96 Tue Nov  3 10:00:01 2026     claude',
        ].join('\n'),
      );
      expect(walkToTerminal(nested, 97)).toEqual({ terminal: 'ghostty', hops: 2 });
    });
  });
});

describe('parseCommandLines', () => {
  it('reads a pid and the rest of the line', () => {
    const out = [
      ' 3000 /opt/tools/Electron.app/Contents/MacOS/Electron /src/My App --flag',
      '   12 -zsh',
      'garbage',
      '',
    ].join('\n');
    expect([...parseCommandLines(out)]).toEqual([
      [3000, '/opt/tools/Electron.app/Contents/MacOS/Electron /src/My App --flag'],
      [12, '-zsh'],
    ]);
    expect(parseCommandLines('').size).toBe(0);
    expect(parseCommandLines(undefined).size).toBe(0);
  });
});
