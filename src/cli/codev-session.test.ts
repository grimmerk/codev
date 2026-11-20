import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSessionCli } from './codev-session';
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
  opts: { title?: string; at: number; transcript?: boolean },
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
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
};

const run = (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = runSessionCli(argv, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    accounts: () => [main, work],
    anchorDir: () => main.dir,
    cwd: () => app,
  });
  return { code, out, err, stdout: out.join('\n'), stderr: err.join('\n') };
};

beforeEach(() => {
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
  });

  it('refuses a title two sessions share: lists both, prints NO command', () => {
    const r = run('resume', 'billing fix');
    expect(r.code).toBe(2);
    // stdout is what the shell function evals — it must stay empty.
    expect(r.out).toEqual([]);
    expect(r.stderr).toContain('2 sessions match');
    expect(r.stderr).toContain(ID_A.slice(0, 8));
    expect(r.stderr).toContain(ID_B.slice(0, 8));
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

  it('keeps even its help off stdout', () => {
    const r = run('resume', '--help');
    expect([r.code, r.out]).toEqual([0, []]);
    expect(r.stderr).toContain('codev session resume');
  });
});

describe('codev session show', () => {
  it('shows every session sharing the title, each under its own account', () => {
    const r = run('show', 'billing fix', '--json');
    expect(r.code).toBe(0);
    const got = JSON.parse(r.stdout);
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
      resumeCommand: `cd '${app}' && command claude --resume ${ID_A}`,
      reference: `billing fix (${ID_A})`,
    });
    expect(got[1].account).toBe('work');
    expect(got[1].resumeCommand).toContain(`CLAUDE_CONFIG_DIR='${work.dir}'`);
  });

  it('prints every field as text, and says when the transcript is gone', () => {
    const text = run('show', ID_D.slice(0, 8)).stdout;
    expect(text).toContain(`Session ID:   ${ID_D}`);
    expect(text).toContain('Title:        (none)');
    expect(text).toContain('Transcript:   (not found');
    expect(run('show', 'nothing like this').code).toBe(1);
    expect(run('show').code).toBe(2);
  });
});

describe('codev session list', () => {
  const idsOf = (stdout: string): string[] =>
    JSON.parse(stdout).map((s: { sessionId: string }) => s.sessionId);

  it('lists all accounts newest first', () => {
    expect(idsOf(run('list', '--json').stdout)).toEqual([ID_A, ID_B, ID_C, ID_D]);
    expect(idsOf(run('list', '--json', '--limit', '2').stdout)).toEqual([
      ID_A,
      ID_B,
    ]);
    expect(idsOf(run('list', '--json', '--account', 'work').stdout)).toEqual([
      ID_B,
      ID_C,
    ]);
  });

  it('--path keeps sessions of exactly that directory, not of one inside it', () => {
    // cwd is the app directory; ID_D lives in app/packages.
    expect(idsOf(run('list', '--path', '.', '--json').stdout)).toEqual([
      ID_A,
      ID_B,
    ]);
    expect(idsOf(run('list', '--path', 'packages', '--json').stdout)).toEqual([
      ID_D,
    ]);
    // A symlink to the directory names the same directory.
    const link = path.join(tmp, 'link-to-api');
    fs.symlinkSync(api, link);
    expect(idsOf(run('list', '--path', link, '--json').stdout)).toEqual([ID_C]);
    const empty = run('list', '--path', tmp);
    expect(empty.code).toBe(1);
  });

  it('marks a session whose transcript is gone, and rejects bad usage', () => {
    const r = run('list');
    const row = r.out.find((l) => l.startsWith(ID_D.slice(0, 8)));
    expect(row).toContain('✗');
    expect(r.out.find((l) => l.startsWith(ID_A.slice(0, 8)))).not.toContain('✗');
    expect(run('list', '--account', 'nope').code).toBe(2);
    expect(run('list', '--limit', '0').code).toBe(2);
    expect(run('frobnicate').code).toBe(2);
  });
});
