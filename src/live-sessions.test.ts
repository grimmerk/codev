import { describe, expect, it } from 'vitest';

import {
  collectLiveSessions,
  isSessionProcess,
  joinLiveSessions,
  parseEtime,
  parsePsOutput,
  sessionIdFromArgs,
  SessionRegistration,
} from './live-sessions';

// Captured from `ps -Ao pid=,rss=,tty=,etime=,args=` on 2026-09-05, trimmed
// to the shapes that matter: sessions with a tty, the daemon family without
// one, a versioned binary path, and an unrelated process.
const PS_SAMPLE = `
 19560 309248 ttys033    02:50:59 claude -r
 33624 292864 ttys052 17-05:40:45 claude -r
 22290 202752 ttys041 02-12:14:50 /Users/g/.local/share/claude/versions/2.1.260 --session-id b7f7c407-1557-4a74-9d4e-36d5db401157 --fork-session
 67810 130048 ttys055 10-06:28:52 claude --resume f339c186-ba82-4362-a901-2938323c0198
 99578 112640 ttys017 02-12:36:52 claude -r
 93499 131072 ttys034    01:25:04 claude -n branch-test-a
 22140  27648 ??       02:44:24 /Users/g/.local/bin/claude daemon run --origin transient --spawn
 22197  16384 ??       02:44:47 claude bg-pty-host --bg-pty-host /tmp/cc-daemon-501/x/spare/59423203
 22211  33792 ??       02:44:46 claude bg-spare --bg-spare /tmp/cc-daemon-501/x/spare/59423203.cla
 22198  16384 ??       03:13:44 /Users/g/.local/share/claude/ClaudeCode.app/Contents/MacOS/claude --helper
 44444 100000 ??       01:00:00 claude --session-id 11111111-2222-4333-8444-555555555555
  1447 376832 ??    03-01:02:03 /Applications/iTerm.app/Contents/MacOS/iTerm2
`;

const reg = (
  pid: number,
  sessionId: string,
  over: Partial<SessionRegistration> = {},
): SessionRegistration => ({
  pid,
  sessionId,
  cwd: `/Users/g/git/${sessionId.slice(0, 4)}`,
  entrypoint: 'cli',
  accountLabel: 'main',
  accountDir: '/Users/g/.claude',
  ...over,
});

describe('parseEtime', () => {
  it('reads every `ps -o etime` shape', () => {
    expect(parseEtime('02:50:59')).toBe(2 * 3600 + 50 * 60 + 59);
    expect(parseEtime('17-05:40:45')).toBe(
      17 * 86400 + 5 * 3600 + 40 * 60 + 45,
    );
    expect(parseEtime('04:39')).toBe(4 * 60 + 39);
    expect(parseEtime('garbage')).toBe(0);
  });
});

describe('parsePsOutput', () => {
  it('parses pid / rss / tty / etime / args and maps ?? to null', () => {
    const procs = parsePsOutput(PS_SAMPLE);
    expect(procs.length).toBe(12);
    const first = procs[0];
    expect(first).toMatchObject({
      pid: 19560,
      rssKb: 309248,
      tty: 'ttys033',
      args: 'claude -r',
    });
    expect(procs.find((p) => p.pid === 22140)?.tty).toBeNull();
    // Args keep everything after the fixed columns, including the long path.
    expect(procs.find((p) => p.pid === 22290)?.args).toMatch(
      /^\/Users\/g\/.*--fork-session$/,
    );
  });
});

const mustFind = <T>(items: T[], pred: (t: T) => boolean, what: string): T => {
  const hit = items.find(pred);
  if (!hit) throw new Error(`fixture is missing ${what}`);
  return hit;
};

describe('isSessionProcess', () => {
  const by = (pid: number) =>
    mustFind(parsePsOutput(PS_SAMPLE), (p) => p.pid === pid, `pid ${pid}`);

  it('accepts bare, -r, --resume, -n and the versioned binary', () => {
    for (const pid of [19560, 33624, 22290, 67810, 93499, 44444]) {
      expect(isSessionProcess(by(pid))).toBe(true);
    }
  });

  it('rejects the daemon family, the app helper, and non-claude processes', () => {
    for (const pid of [22140, 22197, 22211, 22198, 1447]) {
      expect(isSessionProcess(by(pid))).toBe(false);
    }
  });

  it('rejects flag-style one-shots that run in a terminal but open no session', () => {
    const procs = parsePsOutput(
      [
        ' 1 1 ttys001 00:01 claude --version',
        ' 2 1 ttys001 00:01 claude -v',
        ' 3 1 ttys001 00:01 claude --help',
        ' 4 1 ttys001 00:01 claude --mcp-serve',
        ' 5 1 ttys001 00:01 claude --resume f339c186-ba82-4362-a901-2938323c0198',
        ' 6 1 ttys001 00:01 claude -n branch-test-a',
      ].join('\n'),
    );
    expect(procs.map((p) => isSessionProcess(p))).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
    ]);
  });
});

describe('sessionIdFromArgs', () => {
  it('finds --resume, -r <id> and --session-id, ignores bare -r', () => {
    expect(
      sessionIdFromArgs('claude --resume f339c186-ba82-4362-a901-2938323c0198'),
    ).toBe('f339c186-ba82-4362-a901-2938323c0198');
    expect(
      sessionIdFromArgs('claude -r f339c186-ba82-4362-a901-2938323c0198'),
    ).toBe('f339c186-ba82-4362-a901-2938323c0198');
    expect(
      sessionIdFromArgs(
        '/x/2.1.260 --session-id b7f7c407-1557-4a74-9d4e-36d5db401157',
      ),
    ).toBe('b7f7c407-1557-4a74-9d4e-36d5db401157');
    expect(sessionIdFromArgs('claude -r')).toBeNull();
  });
});

describe('joinLiveSessions', () => {
  const procs = parsePsOutput(PS_SAMPLE);
  const regs = [
    reg(19560, 'aaaa0000-0000-4000-8000-000000000001'),
    reg(33624, 'bbbb0000-0000-4000-8000-000000000002'),
    reg(22290, 'b7f7c407-1557-4a74-9d4e-36d5db401157'),
    reg(67810, 'f339c186-ba82-4362-a901-2938323c0198'),
    reg(93499, 'cccc0000-0000-4000-8000-000000000003'),
    // VS Code: registered, no tty — must still count as live.
    reg(44444, '11111111-2222-4333-8444-555555555555', {
      entrypoint: 'claude-vscode',
    }),
    // Registered but the process is gone.
    reg(55555, 'dead0000-0000-4000-8000-000000000009'),
  ];
  const report = joinLiveSessions(procs, regs, 1_000);

  it('counts registered sessions and tty-attached orphans, not the daemon family', () => {
    const pids = report.live.map((s) => s.pid).sort((a, b) => a - b);
    expect(pids).toEqual([19560, 22290, 33624, 44444, 67810, 93499, 99578]);
  });

  it('marks the orphan as unregistered and still recovers an id from the arguments when present', () => {
    const orphan = mustFind(report.live, (s) => s.pid === 99578, 'the orphan');
    expect(orphan.registered).toBe(false);
    expect(orphan.sessionId).toBeNull(); // bare `claude -r` names nothing
    expect(orphan.cwd).toBeNull();
    // Had it been `--resume <id>`, the id would come from the args instead.
    const alt = joinLiveSessions(
      parsePsOutput(
        ' 1 1 ttys001 00:01 claude --resume f339c186-ba82-4362-a901-2938323c0198',
      ),
      [],
    );
    expect(alt.live[0]).toMatchObject({
      registered: false,
      sessionId: 'f339c186-ba82-4362-a901-2938323c0198',
    });
  });

  it('reports a registration whose process is dead as stale, not as live', () => {
    expect(report.staleRegistrations).toEqual([
      {
        pid: 55555,
        sessionId: 'dead0000-0000-4000-8000-000000000009',
        cwd: '/Users/g/git/dead',
      },
    ]);
    expect(report.live.some((s) => s.pid === 55555)).toBe(false);
  });

  it('carries registration fields through and sums memory over live sessions only', () => {
    const vs = mustFind(report.live, (s) => s.pid === 44444, 'the VS Code row');
    expect(vs).toMatchObject({
      entrypoint: 'claude-vscode',
      accountLabel: 'main',
      tty: null,
    });
    const expected = [
      309248, 292864, 202752, 130048, 112640, 131072, 100000,
    ].reduce((a, b) => a + b, 0);
    expect(report.totalRssKb).toBe(expected);
    expect(report.measuredAt).toBe(1_000);
    // Heaviest first — that is the question this view answers.
    expect(report.live[0].pid).toBe(19560);
  });
});

describe('readSessionRegistrations (via collectLiveSessions deps)', () => {
  it('passes the anchor flag through so a synthetic row can hide the account badge', async () => {
    const report = await collectLiveSessions({
      ps: async () => ' 19560 1 ttys033 00:01 claude -r',
      readRegistrations: () => [
        reg(19560, 'aaaa0000-0000-4000-8000-000000000001', {
          accountIsAnchor: true,
        }),
      ],
      cwdOf: async () => null,
    });
    expect(report.live[0]).toMatchObject({
      accountLabel: 'main',
      accountIsAnchor: true,
    });
  });
});

describe('collectLiveSessions', () => {
  it('asks lsof for a cwd only for unregistered sessions that lack one', async () => {
    const asked: number[] = [];
    const report = await collectLiveSessions({
      ps: async () => PS_SAMPLE,
      readRegistrations: () => [
        reg(19560, 'aaaa0000-0000-4000-8000-000000000001'),
      ],
      cwdOf: async (pid) => {
        asked.push(pid);
        return `/cwd/of/${pid}`;
      },
    });
    // Every tty-attached session except the registered one is unregistered here.
    expect(asked.sort((a, b) => a - b)).toEqual([
      22290, 33624, 67810, 93499, 99578,
    ]);
    expect(report.live.find((s) => s.pid === 99578)?.cwd).toBe('/cwd/of/99578');
    expect(report.live.find((s) => s.pid === 19560)?.cwd).toBe(
      '/Users/g/git/aaaa',
    );
  });
});
