import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateAccountsSh } from './account-manager';
import { CliDeps, runSessionCli } from './codev-session';
import { IdentityAccount, transcriptSlug } from './session-identity';

// Record shapes follow real files (see session-identity.test.ts); values are invented.
const ID_A = '11111111-aaaa-4aaa-8aaa-000000000001';
const ID_B = '11111111-bbbb-4bbb-8bbb-000000000002';
const ID_C = '2222cafe-cccc-4ccc-8ccc-000000000003';
const ID_D = '33330000-dddd-4ddd-8ddd-000000000004';

let tmp: string;
let main: IdentityAccount;
let work: IdentityAccount;
let app: string;
let api: string;

const addSession = (
  account: IdentityAccount,
  sessionId: string,
  project: string,
  opts: { title?: string; at: number; transcript?: boolean; extra?: string[] },
): void => {
  fs.appendFileSync(
    path.join(account.dir, 'history.jsonl'),
    JSON.stringify({
      display: `prompt of ${sessionId.slice(0, 4)}`,
      pastedContents: {},
      timestamp: opts.at,
      project,
      sessionId,
    }) + '\n',
  );
  if (opts.transcript === false) return;
  const dir = path.join(account.dir, 'projects', transcriptSlug(project));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: 'hello' },
      cwd: project,
      sessionId,
    }),
  ];
  if (opts.title) {
    lines.push(
      JSON.stringify({ type: 'custom-title', customTitle: opts.title, sessionId }),
    );
  }
  lines.push(...(opts.extra ?? []));
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
};

let selfDeps: Pick<CliDeps, 'ancestors' | 'env' | 'processes'> = {};

const run = (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = runSessionCli(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    accounts: () => [main, work],
    anchorDir: () => main.dir,
    cwd: () => app,
    ancestors: () => [],
    env: () => ({}),
    // Never the real `ps`: a fixture pid could be a real process here.
    processes: () => new Map(),
    ...selfDeps,
  });
  return { code, out, err, stdout: out.join('\n'), stderr: err.join('\n') };
};

beforeEach(() => {
  selfDeps = {};
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codev-sess-')));
  main = {
    label: 'main',
    dir: path.join(tmp, 'claude'),
    configDirEnv: null,
    isAnchor: true,
  };
  work = {
    label: 'work',
    dir: path.join(tmp, 'claude work'),
    configDirEnv: path.join(tmp, 'claude work'),
    isAnchor: false,
  };
  app = path.join(tmp, 'git', 'acme-app');
  api = path.join(tmp, 'git', 'acme-api');
  for (const d of [main.dir, work.dir, app, api, path.join(app, 'packages')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // Two sessions share a title across accounts (a /branch pair would too).
  addSession(main, ID_A, app, { title: 'billing fix', at: 4000 });
  addSession(work, ID_B, app, { title: 'billing fix', at: 3000 });
  addSession(work, ID_C, api, { title: 'api cleanup', at: 2000 });
  addSession(main, ID_D, path.join(app, 'packages'), {
    title: 'gone',
    at: 1000,
    transcript: false,
  });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('codev session resume', () => {
  it('prints exactly the command, with the account prefix, and nothing else on stdout', () => {
    const r = run('resume', 'api', 'cleanup');
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      `cd '${api}' && CLAUDE_CONFIG_DIR='${work.dir}' command claude --resume ${ID_C}`,
    ]);
    expect(r.stderr).toContain('as work');
    // The anchor account: the variable is unset, never left to the shell.
    expect(run('resume', ID_A).out).toEqual([
      `cd '${app}' && env -u CLAUDE_CONFIG_DIR claude --resume ${ID_A}`,
    ]);
  });

  it('refuses a title two sessions share: lists both, prints NO command', () => {
    const r = run('resume', 'billing fix');
    expect(r.code).toBe(2);
    // stdout is what the shell function evals — it must stay empty.
    expect(r.out).toEqual([]);
    expect(r.stderr).toContain('2 sessions match');
    // The two ids share their first eight characters, so the listing has to
    // show them in full — "name one by id" is no help otherwise.
    expect(ID_A.slice(0, 8)).toBe(ID_B.slice(0, 8));
    expect(r.stderr).toContain(ID_A);
    expect(r.stderr).toContain(ID_B);
    // The id that disambiguates is accepted.
    expect(run('resume', ID_B).out).toEqual([
      `cd '${app}' && CLAUDE_CONFIG_DIR='${work.dir}' command claude --resume ${ID_B}`,
    ]);
  });

  it('refuses an ambiguous id prefix the same way', () => {
    const r = run('resume', '11111111');
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
  });

  it('prints no command when nothing matches, the transcript is gone, or the project is', () => {
    const none = run('resume', 'no such session');
    expect([none.code, none.out]).toEqual([1, []]);

    const gone = run('resume', ID_D);
    expect([gone.code, gone.out]).toEqual([1, []]);
    expect(gone.stderr).toContain('transcript is gone');

    fs.rmSync(api, { recursive: true });
    const moved = run('resume', ID_C);
    expect([moved.code, moved.out]).toEqual([1, []]);
    expect(moved.stderr).toContain('no longer exists');
  });

  it('takes no --pretty and no unknown option: nothing reaches stdout', () => {
    for (const args of [
      ['resume', ID_C, '--pretty'],
      ['resume', ID_C, '--frce'],
      ['resume', '--last', '3', ID_C],
    ]) {
      const r = run(...args);
      expect([r.code, r.out]).toEqual([2, []]);
      expect(r.stderr).toContain('unknown option');
      expect(r.stderr).toContain('Usage:');
    }
  });

  it('keeps even its help off stdout', () => {
    const r = run('resume', '--help');
    expect([r.code, r.out]).toEqual([0, []]);
    expect(r.stderr).toContain('codev session resume');
  });
});

// The whole path an agent takes (#172): this CLI prints the command, the
// `codev()` function of a generated accounts.sh evals it in a real shell, and
// a stub `claude` on PATH reports what it was started with. The calling shell
// exports ANOTHER account's CLAUDE_CONFIG_DIR, as a shell inside that
// account's Claude Code session does. The global default is a third account,
// so a command that went through the `claude` dispatcher is caught as well.
describe('codev session resume, run by the codev() shell function', () => {
  const setup = () => {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'claude'),
      '#!/bin/sh\necho "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR-<unset>} PWD=$PWD ARGS=$*"\n',
      { mode: 0o755 },
    );
    // Stands in for the app binary: hands back what the real CLI printed.
    const resumeFile = path.join(tmp, 'resume-command');
    const appExec = path.join(tmp, 'CodeV');
    fs.writeFileSync(
      appExec,
      [
        '#!/bin/sh',
        'cli=$(basename "$1"); shift',
        '[ "$cli $1" = "codev-session.js resume" ] && cat "$RESUME_FILE"',
      ].join('\n') + '\n',
      { mode: 0o755 },
    );
    const accountsSh = path.join(tmp, 'accounts.sh');
    const regAccount = (label: string, isAnchor: boolean) => ({
      label,
      dir: path.join(tmp, `reg-${label}`),
      identityFile: path.join(tmp, `reg-${label}`, '.claude.json'),
      configDirEnv: isAnchor ? null : path.join(tmp, `reg-${label}`),
      isAnchor,
    });
    fs.writeFileSync(
      accountsSh,
      generateAccountsSh({
        version: 1,
        defaultAccount: 'third',
        appPath: tmp,
        appExec,
        accounts: [regAccount('main', true), regAccount('third', false)],
      }),
    );
    const inherited = path.join(tmp, 'claude-second');
    return (shell: string, query: string): string => {
      const printed = run('resume', query);
      expect(printed.code).toBe(0);
      fs.writeFileSync(resumeFile, printed.stdout + '\n');
      return execFileSync(
        shell,
        ['-c', `. "${accountsSh}"\ncodev session resume ${query}`],
        {
          encoding: 'utf-8',
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: tmp,
            RESUME_FILE: resumeFile,
            CLAUDE_CONFIG_DIR: inherited,
          },
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
    };
  };

  for (const shell of ['zsh', 'bash']) {
    it(`${shell}: an anchor session resumes with the inherited CLAUDE_CONFIG_DIR unset`, () => {
      expect(setup()(shell, ID_A)).toBe(
        `CLAUDE_CONFIG_DIR=<unset> PWD=${app} ARGS=--resume ${ID_A}\n`,
      );
    });

    it(`${shell}: another account's session resumes under that account`, () => {
      expect(setup()(shell, ID_C)).toBe(
        `CLAUDE_CONFIG_DIR=${work.dir} PWD=${api} ARGS=--resume ${ID_C}\n`,
      );
    });
  }
});

// Real record shapes (2026-11-20): an assistant turn is several records, each
// holding ONE kind of block; a tool result comes back as a `user` record.
const said = (
  role: 'user' | 'assistant',
  sessionId: string,
  content: unknown,
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    message: { role, content },
    type: role,
    uuid: '00000000-0000-4000-8000-00000000abcd',
    timestamp: '2026-11-01T10:00:00.000Z',
    cwd: '/Users/dev/git/acme-app',
    sessionId,
    ...extra,
  });

describe('codev session show', () => {
  it('prints JSON by default: every session sharing the title, each under its own account', () => {
    const r = run('show', 'billing fix');
    expect(r.code).toBe(0);
    expect(r.out).toHaveLength(1); // one line, parseable as a whole
    const got = JSON.parse(r.stdout).sessions;
    expect(got.map((g: { sessionId: string }) => g.sessionId)).toEqual([ID_A, ID_B]);
    expect(got[0]).toMatchObject({
      title: 'billing fix',
      titleKind: 'custom',
      account: 'main',
      projectPath: app,
      transcriptPath: path.join(
        main.dir,
        'projects',
        transcriptSlug(app),
        `${ID_A}.jsonl`,
      ),
      resumeCommand: `cd '${app}' && env -u CLAUDE_CONFIG_DIR claude --resume ${ID_A}`,
      reference: `billing fix (${ID_A})`,
    });
    expect(got[1].account).toBe('work');
    expect(got[1].resumeCommand).toContain(`CLAUDE_CONFIG_DIR='${work.dir}'`);
  });

  it('--pretty prints every field as text, and says when the transcript is gone', () => {
    const text = run('show', ID_D.slice(0, 8), '--pretty').stdout;
    expect(text).toContain(`Session ID:     ${ID_D}`);
    expect(text).toContain('Title:          (none)');
    expect(text).toContain('Transcript:     (not found');
  });

  it('keeps stdout empty on failure and puts a JSON error on stderr', () => {
    const none = run('show', 'nothing like this');
    expect([none.code, none.out]).toEqual([1, []]);
    expect(JSON.parse(none.stderr).error).toContain('No session matches');
    const usage = run('show');
    expect([usage.code, usage.out]).toEqual([2, []]);
    expect(run('show', 'zzz', '--pretty').stderr).toContain('No session matches');
  });
});

describe('codev session view', () => {
  it('prints the last N spoken messages of the one matching session', () => {
    addSession(work, '5555aaaa-0000-4000-8000-000000000005', api, {
      title: 'talkative',
      at: 5000,
      extra: [
        said('user', ID_C, 'first question'),
        said('assistant', ID_C, [{ type: 'thinking', thinking: 'hmm', signature: 's' }]),
        said('assistant', ID_C, [{ type: 'text', text: 'first answer' }]),
        said('assistant', ID_C, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
        said('user', ID_C, [{ tool_use_id: 't1', type: 'tool_result', content: 'file.txt' }], {
          toolUseResult: { stdout: 'file.txt' },
        }),
        said('assistant', ID_C, [{ type: 'text', text: 'second answer' }]),
        'not json',
        said('user', ID_C, 'second question'),
      ],
    });
    const r = run('view', 'talkative', '--last', '3');
    expect(r.code).toBe(0);
    const got = JSON.parse(r.stdout);
    expect(got).toMatchObject({ title: 'talkative', account: 'work' });
    expect(got.messages).toEqual([
      { role: 'assistant', timestamp: '2026-11-01T10:00:00.000Z', text: 'first answer' },
      { role: 'assistant', timestamp: '2026-11-01T10:00:00.000Z', text: 'second answer' },
      { role: 'user', timestamp: '2026-11-01T10:00:00.000Z', text: 'second question' },
    ]);
    const pretty = run('view', 'talkative', '--last', '1', '--pretty').stdout;
    expect(pretty).toContain('── user');
    expect(pretty).toContain('second question');
    expect(pretty).not.toContain('second answer');
  });

  it('refuses to pick among several matches: no stdout, the candidates on stderr', () => {
    const r = run('view', 'billing fix');
    expect([r.code, r.out]).toEqual([2, []]);
    const e = JSON.parse(r.stderr);
    expect(e.error).toContain('2 sessions match');
    expect(e.matches.map((m: { sessionId: string }) => m.sessionId)).toEqual([
      ID_A,
      ID_B,
    ]);
  });

  it('fails cleanly when the transcript is gone or --last is not a count', () => {
    const gone = run('view', ID_D);
    expect([gone.code, gone.out]).toEqual([1, []]);
    expect(run('view', ID_A, '--last', 'many').code).toBe(2);
    expect(run('view', ID_A, '--last').code).toBe(2);
  });
});

describe('codev session self', () => {
  const START = 'Sun Nov  1 10:00:00 2026';
  const register = (
    account: IdentityAccount,
    pid: number,
    sessionId: string,
    procStart = START,
  ): void => {
    fs.mkdirSync(path.join(account.dir, 'sessions'), { recursive: true });
    // Key order of a real sessions/<pid>.json.
    fs.writeFileSync(
      path.join(account.dir, 'sessions', `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId,
        cwd: api,
        startedAt: 1,
        procStart,
        version: '2.1.329',
        kind: 'interactive',
        entrypoint: 'cli',
        name: 'api cleanup',
        nameSource: 'user',
        status: 'busy',
      }),
    );
  };
  const chain = [
    { pid: 900, ppid: 800, startUtc: 'Sun Nov 1 10:05:00 2026', command: '/bin/zsh' },
    { pid: 800, ppid: 1, startUtc: 'Sun Nov 1 10:00:00 2026', command: 'claude' },
  ];

  it('names the session of the nearest registered ancestor, under the account that holds the registration', () => {
    register(work, 800, ID_C);
    selfDeps = { ancestors: () => chain, env: () => ({ CLAUDE_CODE_SESSION_ID: ID_C }) };
    const r = run('self');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      sessionId: ID_C,
      title: 'api cleanup',
      account: 'work',
      projectPath: api,
      pid: 800,
      name: 'api cleanup',
      proof: 'process-start',
      environmentAgrees: true,
      // What `self --pretty` prints as "Last prompt … · N prompts" is in the JSON too.
      lastActive: new Date(2000).toISOString(),
      promptCount: 1,
      // No timestamped record in its transcript: the last prompt.
      lastActivity: new Date(2000).toISOString(),
    });
  });

  it('does not take a leftover registration of an earlier process with the same pid', () => {
    register(work, 800, ID_C, 'Sat Oct 31 08:00:00 2026');
    selfDeps = { ancestors: () => chain, env: () => ({}) };
    const r = run('self');
    expect([r.code, r.out]).toEqual([1, []]);
    expect(JSON.parse(r.stderr).error).toContain('self:');
  });

  it('fails outside a session', () => {
    const r = run('self');
    expect([r.code, r.out]).toEqual([1, []]);
  });
});

describe('live sessions and last activity', () => {
  const ID_E = '44440000-eeee-4eee-8eee-000000000005';
  const START = 'Sun Nov  1 10:00:00 2026';
  // Key order of a real sessions/<pid>.json (2.1.329); values invented.
  const register = (
    account: IdentityAccount,
    pid: number,
    sessionId: string,
    over: Record<string, unknown> = {},
  ): void => {
    fs.mkdirSync(path.join(account.dir, 'sessions'), { recursive: true });
    fs.writeFileSync(
      path.join(account.dir, 'sessions', `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId,
        cwd: app,
        startedAt: 1793527200000,
        procStart: START,
        version: '2.1.329',
        peerProtocol: 1,
        kind: 'interactive',
        entrypoint: 'cli',
        name: 'billing fix',
        updatedAt: 1793527500000,
        status: 'busy',
        ...over,
      }),
    );
  };
  const ps = (pid: number, startUtc = 'Sun Nov 1 10:00:00 2026') =>
    [pid, { pid, ppid: 1, startUtc, command: 'claude' }] as const;
  const live = (...procs: ReturnType<typeof ps>[]) => {
    selfDeps = { processes: () => new Map(procs) };
  };
  // A turn_duration record, then bookkeeping with no timestamp of its own —
  // how a real transcript usually ends.
  const tail = (at: string, sessionId: string) => [
    JSON.stringify({
      parentUuid: 'x',
      isSidechain: false,
      type: 'system',
      subtype: 'turn_duration',
      durationMs: 1200,
      messageCount: 4,
      timestamp: at,
      uuid: '00000000-0000-4000-8000-00000000beef',
      isMeta: false,
      cwd: app,
      sessionId,
    }),
    JSON.stringify({
      type: 'cost-state',
      sessionId,
      totalCostUSD: 1.5,
      startTime: 1793527200000,
      modelUsage: { m: { timestamp: '2030-01-01T00:00:00.000Z' } },
    }),
  ];
  const idsOf = (stdout: string): string[] =>
    JSON.parse(stdout).sessions.map((s: { sessionId: string }) => s.sessionId);
  const listed = (...argv: string[]) =>
    JSON.parse(run('list', ...argv).stdout).sessions as Record<string, unknown>[];

  it('marks running sessions, and not a leftover file whose pid now belongs to another process', () => {
    register(main, 700, ID_A);
    // Same pid alive, different start: the pid was reused — not ID_C running.
    register(work, 702, ID_C, { cwd: api, status: 'idle' });
    live(ps(700), ps(702, 'Mon Nov 2 09:00:00 2026'));
    const rows = listed();
    const byId = new Map(rows.map((r) => [r.sessionId, r]));
    expect(byId.get(ID_A)).toMatchObject({ live: true, pid: 700, status: 'busy' });
    expect(byId.get(ID_C)).toMatchObject({ live: false, pid: null, status: null });
    expect(byId.get(ID_B)).toMatchObject({ live: false });
    // A registration whose process is gone is not running either.
    live();
    expect(listed().every((r) => r.live === false)).toBe(true);
  });

  it('--live / --not-live filter on it, and --live lists a running session history has never seen', () => {
    register(main, 700, ID_A);
    // ID_E: running, never prompted — in no history.jsonl. Its transcript
    // already carries the title.
    register(work, 703, ID_E, { cwd: api, name: 'fresh branch', updatedAt: 5000, status: 'idle' });
    const dir = path.join(work.dir, 'projects', transcriptSlug(api));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${ID_E}.jsonl`),
      JSON.stringify({ type: 'custom-title', customTitle: 'fresh branch', sessionId: ID_E }) + '\n',
    );
    live(ps(700), ps(703));
    expect(idsOf(run('list', '--live').stdout)).toEqual([ID_E, ID_A]);
    const e = listed('--live')[0];
    expect(e).toMatchObject({
      title: 'fresh branch',
      account: 'work',
      projectPath: api,
      live: true,
      status: 'idle',
      lastActive: null,
      promptCount: 0,
    });
    expect(idsOf(run('list', '--not-live').stdout)).toEqual([ID_B, ID_C, ID_D]);
    // …and show finds it by its title.
    expect(JSON.parse(run('show', 'fresh branch').stdout).sessions[0].sessionId).toBe(ID_E);
    expect(run('list', '--live', '--not-live').code).toBe(2);
  });

  it('lastActivity is the last timestamped transcript record; lastActive stays the last prompt', () => {
    fs.rmSync(path.join(main.dir, 'projects'), { recursive: true });
    addSession(main, ID_A, app, {
      title: 'billing fix',
      at: 4000,
      extra: tail('2026-11-01T12:34:56.000Z', ID_A),
    });
    const a = listed().find((r) => r.sessionId === ID_A);
    expect(a).toMatchObject({
      lastActive: new Date(4000).toISOString(),
      lastActivity: '2026-11-01T12:34:56.000Z',
    });
    const shown = JSON.parse(run('show', ID_A).stdout).sessions[0];
    expect(shown.lastActivity).toBe('2026-11-01T12:34:56.000Z');
    expect(shown.live).toBe(false);
    // Never earlier than the last prompt: a prompt that never reached the
    // transcript, or a transcript that is gone, leaves the prompt time.
    addSession(main, ID_A, app, { at: Date.parse('2026-11-02T08:00:00.000Z'), transcript: false });
    expect(listed().find((r) => r.sessionId === ID_A)?.lastActivity).toBe('2026-11-02T08:00:00.000Z');
    expect(listed().find((r) => r.sessionId === ID_D)?.lastActivity).toBe(new Date(1000).toISOString());
  });

  it('--pretty has a LIVE column and always explains ✗', () => {
    register(main, 700, ID_A);
    live(ps(700));
    const r = run('list', '--path', '.', '--pretty');
    expect(r.out[0]).toContain('LIVE');
    expect(r.out.find((l) => l.startsWith(ID_A.slice(0, 8)))).toContain('busy');
    // No row here has ✗, and the legend still says what it means.
    expect(r.out.some((l) => l.startsWith(ID_D.slice(0, 8)))).toBe(false);
    expect(r.stdout).toContain('✗ = transcript gone, cannot be resumed (not about running)');
    expect(run('show', ID_A, '--pretty').stdout).toContain('Running:        yes — pid 700 · busy');
  });
});

describe('options', () => {
  it('rejects an option the command does not have instead of ignoring it', () => {
    // A typo must not run as if the option had not been given.
    const typo = run('list', '--limt', '1');
    expect([typo.code, typo.out]).toEqual([2, []]);
    const e = JSON.parse(typo.stderr);
    expect(e.error).toContain('unknown option --limt');
    expect(e.usage).toContain('codev session list');
    // Another command's option is unknown here too.
    expect(run('show', ID_A, '--last', '2').code).toBe(2);
    expect(run('view', ID_A, '--all').code).toBe(2);
    expect(run('self', '--path', '.').code).toBe(2);
    expect(run('list', '--all=yes').code).toBe(2);
    // …and so is an argument a command has no use for.
    expect(run('self', 'extra').code).toBe(2);
    expect(run('list', 'extra').code).toBe(2);
    // `--` ends the options: a title may start with dashes.
    expect(run('show', '--', '--no-such-title').code).toBe(1);
  });

  it('a value option followed by another option is a missing value, not that option as the value', () => {
    for (const args of [
      ['list', '--path', '--pretty'],
      ['list', '--account', '--all'],
      ['list', '--limit', '-1'],
      ['view', ID_A, '--last', '--pretty'],
      // An empty value would resolve to the current directory.
      ['list', '--path', ''],
      ['list', '--path='],
    ]) {
      const r = run(...args);
      expect([r.code, r.out]).toEqual([2, []]);
      expect(r.stderr).toContain('needs a value');
      expect(r.stderr).toContain('Usage:');
    }
    // The = form still carries a value that starts with a dash.
    const dashed = run('list', '--path=--pretty');
    expect(dashed.code).toBe(0);
    expect(JSON.parse(dashed.stdout)).toEqual({ total: 0, sessions: [] });
  });

  it('reports a failure inside a command the same way as any other: JSON on stderr, nothing on stdout', () => {
    // A transcript that is found but cannot be read: a directory in its place.
    const id = '7777cccc-0000-4000-8000-000000000007';
    addSession(main, id, app, { at: 7000, transcript: false });
    fs.mkdirSync(
      path.join(main.dir, 'projects', transcriptSlug(app), `${id}.jsonl`),
      { recursive: true },
    );
    const r = run('view', id);
    expect([r.code, r.out]).toEqual([1, []]);
    expect(r.err).toHaveLength(1);
    expect(JSON.parse(r.stderr).error).toMatch(/^view: /);
    // --pretty gets plain text, still on stderr only.
    const p = run('view', id, '--pretty');
    expect([p.code, p.out]).toEqual([1, []]);
    expect(p.stderr).toMatch(/^view: /);
    expect(() => JSON.parse(p.stderr)).toThrow();
  });

  it('does not take a property of Object.prototype for a command', () => {
    for (const name of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const r = run(name);
      expect([r.code, r.out]).toEqual([2, []]);
      expect(JSON.parse(r.stderr).error).toBe(`Unknown command: ${name}`);
    }
  });

  it('accepts each command’s own options', () => {
    expect(run('list', '--path', '.', '--account', 'main', '--limit', '5', '--pretty').code).toBe(0);
    expect(run('list', '--all', '--limit=2').code).toBe(0);
    expect(run('show', ID_A, '--pretty').code).toBe(0);
    expect(run('view', ID_A, '--last=1', '--pretty').code).toBe(0);
  });
});

describe('a transcript that is not under its project’s own directory', () => {
  it('is still found — title included — through the one shared index', () => {
    // History says the session belongs to `api`; its file sits under another
    // slug (the project path was renamed since, say).
    const id = '6666bbbb-0000-4000-8000-000000000006';
    const other = path.join(tmp, 'git', 'renamed-since');
    addSession(work, id, other, { title: 'moved house', at: 6000 });
    const historyFile = path.join(work.dir, 'history.jsonl');
    fs.writeFileSync(
      historyFile,
      fs.readFileSync(historyFile, 'utf-8').split(other).join(api),
    );
    const listed = JSON.parse(run('list').stdout).sessions.find(
      (s: { sessionId: string }) => s.sessionId === id,
    );
    expect(listed).toMatchObject({ title: 'moved house', projectPath: api });
    expect(listed.transcriptPath).toContain(transcriptSlug(other));
    // Findable by its title, and flagged for what it is.
    const shown = JSON.parse(run('show', 'moved house').stdout).sessions;
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      sessionId: id,
      transcriptOutsideProjectSlug: true,
    });
  });
});

describe('codev session list', () => {
  const idsOf = (stdout: string): string[] =>
    JSON.parse(stdout).sessions.map((s: { sessionId: string }) => s.sessionId);

  it('lists all accounts newest first', () => {
    expect(idsOf(run('list').stdout)).toEqual([ID_A, ID_B, ID_C, ID_D]);
    expect(idsOf(run('list', '--limit', '2').stdout)).toEqual([
      ID_A,
      ID_B,
    ]);
    expect(idsOf(run('list', '--account', 'work').stdout)).toEqual([
      ID_B,
      ID_C,
    ]);
  });

  it('--path keeps sessions of exactly that directory, not of one inside it', () => {
    // cwd is the app directory; ID_D lives in app/packages.
    expect(idsOf(run('list', '--path', '.').stdout)).toEqual([
      ID_A,
      ID_B,
    ]);
    expect(idsOf(run('list', '--path', 'packages').stdout)).toEqual([
      ID_D,
    ]);
    // A symlink to the directory names the same directory.
    const link = path.join(tmp, 'link-to-api');
    fs.symlinkSync(api, link);
    expect(idsOf(run('list', '--path', link).stdout)).toEqual([ID_C]);
    // No sessions there is an answer, not a failure.
    const empty = run('list', '--path', tmp);
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual({ total: 0, sessions: [] });
  });

  it('marks a session whose transcript is gone, and rejects bad usage', () => {
    const r = run('list', '--pretty');
    const row = r.out.find((l) => l.startsWith(ID_D.slice(0, 8)));
    expect(row).toContain('✗');
    expect(r.out.find((l) => l.startsWith(ID_A.slice(0, 8)))).not.toContain('✗');
    expect(run('list', '--account', 'nope').code).toBe(2);
    expect(run('list', '--limit', '0').code).toBe(2);
    expect(run('frobnicate').code).toBe(2);
  });
});
