import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cdAndResume,
  foldHistoryText,
  formatReference,
  formatResumeCommand,
  HistoryScan,
  IdentityAccount,
  isSessionId,
  locateTranscript,
  matchSessions,
  pickOne,
  readTranscriptTitle,
  readTranscriptTitles,
  resolveSessionIdentity,
  scanHistories,
  titleFromRecords,
  transcriptSlug,
  transcriptSlugCandidates,
} from './session-identity';

// Record shapes below follow real files (key order included), read on
// 2026-11-20; every value is invented.
//   history.jsonl : display, pastedContents, timestamp, project, sessionId
//   custom-title  : type, customTitle, sessionId
//   user          : parentUuid, isSidechain, …, type, message, …, cwd, sessionId
const ID_A = '11111111-aaaa-4aaa-8aaa-000000000001';
const ID_B = '11111111-bbbb-4bbb-8bbb-000000000002';
const ID_C = '2222cafe-cccc-4ccc-8ccc-000000000003';

const historyLine = (
  sessionId: string,
  project: string,
  display: string,
  timestamp: number,
): string =>
  JSON.stringify({ display, pastedContents: {}, timestamp, project, sessionId });

const customTitle = (sessionId: string, title: string): string =>
  JSON.stringify({ type: 'custom-title', customTitle: title, sessionId });

const aiTitle = (sessionId: string, title: string): string =>
  JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId });

const userRecord = (sessionId: string, cwd: string, text: string): string =>
  JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: text },
    uuid: '00000000-0000-4000-8000-00000000abcd',
    timestamp: '2026-11-01T10:00:00.000Z',
    userType: 'external',
    entrypoint: 'cli',
    cwd,
    sessionId,
    version: '2.1.300',
    gitBranch: 'main',
  });

const anchor = (dir: string): IdentityAccount => ({
  label: 'main',
  dir,
  configDirEnv: null,
  isAnchor: true,
});

const extra = (dir: string, label = 'work'): IdentityAccount => ({
  label,
  dir,
  configDirEnv: dir,
  isAnchor: false,
});

let tmp: string;
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codev-ident-')));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const writeTranscript = (
  accountDir: string,
  slugSource: string,
  sessionId: string,
  lines: string[],
): string => {
  const dir = path.join(accountDir, 'projects', transcriptSlug(slugSource));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
};

describe('history scan', () => {
  it('merges accounts, tags each session, and keeps first/last by timestamp', () => {
    const scan: HistoryScan = {
      sessions: new Map(),
      prompts: new Map(),
      promptTimes: new Map(),
    };
    foldHistoryText(
      scan,
      [
        historyLine(ID_A, '/Users/dev/git/acme-app', 'second prompt', 2000),
        'not json at all',
        historyLine(ID_A, '/Users/dev/git/acme-app', 'first prompt', 1000),
        '',
        historyLine(ID_A, '/Users/dev/git/acme-app', 'third prompt', 3000),
      ].join('\n'),
      anchor('/Users/dev/.claude'),
    );
    foldHistoryText(
      scan,
      historyLine(ID_B, '/Users/dev/git/acme-api', 'hello', 2500),
      extra('/Users/dev/.claude-work'),
    );

    const a = scan.sessions.get(ID_A);
    expect(a).toMatchObject({
      firstDisplay: 'first prompt',
      lastDisplay: 'third prompt',
      firstTimestamp: 1000,
      lastTimestamp: 3000,
      promptCount: 3,
      accountLabel: 'main',
      accountConfigDirEnv: null,
    });
    expect(scan.sessions.get(ID_B)).toMatchObject({
      accountLabel: 'work',
      accountConfigDirEnv: '/Users/dev/.claude-work',
      accountIsAnchor: false,
    });
    // Prompts keep FILE order, with their times alongside.
    expect(scan.prompts.get(ID_A)).toEqual([
      'second prompt',
      'first prompt',
      'third prompt',
    ]);
    expect(scan.promptTimes.get(ID_A)).toEqual([2000, 1000, 3000]);
  });

  it('one unreadable history does not hide the other account', () => {
    const good = path.join(tmp, 'good');
    const bad = path.join(tmp, 'bad');
    fs.mkdirSync(good);
    // A directory where the file should be: readFileSync throws EISDIR.
    fs.mkdirSync(path.join(bad, 'history.jsonl'), { recursive: true });
    fs.writeFileSync(
      path.join(good, 'history.jsonl'),
      historyLine(ID_A, '/Users/dev/git/acme-app', 'hi', 1) + '\n',
    );
    const failed: string[] = [];
    const scan = scanHistories([extra(bad, 'broken'), anchor(good)], (label) =>
      failed.push(label),
    );
    expect(failed).toEqual(['broken']);
    expect([...scan.sessions.keys()]).toEqual([ID_A]);
  });
});

describe('transcript location', () => {
  it('slugs a path the way projects/ names it', () => {
    expect(transcriptSlug('/Users/dev/git/acme-app')).toBe(
      '-Users-dev-git-acme-app',
    );
    expect(transcriptSlug('/Users/dev/git/acme_app/.claude/worktrees/fix.1')).toBe(
      '-Users-dev-git-acme-app--claude-worktrees-fix-1',
    );
    // UTF-16 units, not characters: an astral character is two dashes.
    expect(transcriptSlug('/x/😀/y')).toBe('-x----y');
  });

  it('offers the recorded path first, then its physical form, without repeats', () => {
    const resolve = (p: string) => p.replace(/^\/tmp\b/, '/private/tmp');
    expect(transcriptSlugCandidates('/tmp/acme', resolve)).toEqual([
      '-tmp-acme',
      '-private-tmp-acme',
    ]);
    expect(transcriptSlugCandidates('/Users/dev/acme', resolve)).toEqual([
      '-Users-dev-acme',
    ]);
    expect(transcriptSlugCandidates('', resolve)).toEqual([]);
  });

  it('finds a subdirectory session under ITS OWN slug, not the repository root', () => {
    const account = path.join(tmp, 'acct');
    const repo = path.join(tmp, 'acme-app');
    const sub = path.join(repo, 'packages', 'core');
    const file = writeTranscript(account, sub, ID_A, [
      userRecord(ID_A, sub, 'hello'),
    ]);
    expect(locateTranscript([account], sub, ID_A)).toEqual({
      path: file,
      accountDir: account,
      outsideProjectSlug: false,
    });
    // Asking with the repository root must not find it by the strict rule…
    expect(locateTranscript([account], repo, ID_A)).toBeNull();
    // …and the read-anywhere fallback finds it, and says how.
    expect(
      locateTranscript([account], repo, ID_A, { scanAllSlugs: true }),
    ).toEqual({ path: file, accountDir: account, outsideProjectSlug: true });
  });

  it('tries the account dirs in the order given', () => {
    const first = path.join(tmp, 'first');
    const second = path.join(tmp, 'second');
    const project = path.join(tmp, 'acme-app');
    writeTranscript(first, project, ID_A, ['{}']);
    const inSecond = writeTranscript(second, project, ID_A, ['{}']);
    expect(locateTranscript([second, first], project, ID_A)?.path).toBe(
      inSecond,
    );
  });

  it('refuses an id that is not one, before it reaches a path', () => {
    const account = path.join(tmp, 'acct');
    const project = path.join(tmp, 'acme-app');
    writeTranscript(account, project, ID_A, ['{}']);
    // Would resolve to the real file if it were joined into the path.
    const sneaky = `x/../${ID_A}`;
    expect(isSessionId(sneaky)).toBe(false);
    expect(
      locateTranscript([account], project, sneaky, { scanAllSlugs: true }),
    ).toBeNull();
    expect(isSessionId('$(touch x)')).toBe(false);
    expect(isSessionId(ID_A)).toBe(true);
  });
});

describe('title', () => {
  it('prefers the custom title, and falls through an empty one', () => {
    expect(
      titleFromRecords(customTitle(ID_A, 'billing fix'), aiTitle(ID_A, 'Auto')),
    ).toEqual({ title: 'billing fix', kind: 'custom' });
    expect(
      titleFromRecords(customTitle(ID_A, '  '), aiTitle(ID_A, 'Auto name')),
    ).toEqual({ title: 'Auto name', kind: 'ai' });
    expect(titleFromRecords(undefined, undefined)).toEqual({
      title: '',
      kind: 'none',
    });
    expect(titleFromRecords('{"type":"custom-title","custo', undefined).kind).toBe(
      'none',
    );
  });

  it('strips the quotes an older /rename stored around the name', () => {
    expect(titleFromRecords(customTitle(ID_A, '"quoted name"')).title).toBe(
      'quoted name',
    );
  });

  it('takes the LAST record of each kind, wherever the chunk boundaries fall', () => {
    const account = path.join(tmp, 'acct');
    const project = path.join(tmp, 'acme-app');
    const filler = (n: number) =>
      Array.from({ length: n }, (_, i) => userRecord(ID_A, project, `prompt ${i}`));
    const file = writeTranscript(account, project, ID_A, [
      customTitle(ID_A, 'old name'),
      ...filler(20),
      aiTitle(ID_A, 'generated'),
      customTitle(ID_A, 'new name'),
      ...filler(20),
    ]);
    const aiOnly = writeTranscript(account, project, ID_B, [
      aiTitle(ID_B, 'first generated'),
      ...filler(20),
      aiTitle(ID_B, 'last generated'),
      ...filler(20),
    ]);
    // Every chunk size from "smaller than one record" up: a marker cut by a
    // boundary, a record spanning several chunks, and the one-chunk case.
    for (const chunk of [7, 64, 333, 4096, 1 << 20]) {
      expect(readTranscriptTitle(file, chunk)).toEqual({
        title: 'new name',
        kind: 'custom',
      });
      expect(readTranscriptTitle(aiOnly, chunk)).toEqual({
        title: 'last generated',
        kind: 'ai',
      });
    }
  });

  it('an empty last custom title falls through to the generated one', () => {
    const account = path.join(tmp, 'acct');
    const project = path.join(tmp, 'acme-app');
    const file = writeTranscript(account, project, ID_A, [
      customTitle(ID_A, 'once named'),
      aiTitle(ID_A, 'generated'),
      customTitle(ID_A, ''),
    ]);
    for (const chunk of [16, 1 << 20]) {
      expect(readTranscriptTitle(file, chunk)).toEqual({
        title: 'generated',
        kind: 'ai',
      });
    }
  });

  it('is not fooled by a longer record that embeds a title record unescaped', () => {
    const account = path.join(tmp, 'acct');
    const project = path.join(tmp, 'acme-app');
    // A wrapper record whose payload is a title record as an OBJECT, so the
    // marker appears with its quotes unescaped — after the real title.
    const wrapper = JSON.stringify({
      type: 'progress',
      data: { type: 'custom-title', customTitle: 'embedded', sessionId: ID_B },
      sessionId: ID_A,
    });
    const file = writeTranscript(account, project, ID_A, [
      customTitle(ID_A, 'the real one'),
      wrapper,
      userRecord(ID_A, project, 'later'),
    ]);
    expect(readTranscriptTitle(file).title).toBe('the real one');
    expect(readTranscriptTitle(path.join(tmp, 'no-such.jsonl'))).toEqual({
      title: '',
      kind: 'none',
    });
  });

  it('reads titles from real files, ignoring a prompt that merely quotes a title record', () => {
    const account = path.join(tmp, 'acct');
    const project = path.join(tmp, 'acme-app');
    const renamed = writeTranscript(account, project, ID_A, [
      userRecord(ID_A, project, 'start'),
      customTitle(ID_A, 'first name'),
      userRecord(ID_A, project, 'more'),
      customTitle(ID_A, 'renamed later'),
    ]);
    // The user pasted a title record into a prompt. Inside the JSON string
    // its quotes are escaped, so it must not be taken for a title.
    const quotedOnly = writeTranscript(account, project, ID_B, [
      userRecord(ID_B, project, customTitle(ID_B, 'not a title')),
    ]);
    const untitled = writeTranscript(account, project, ID_C, [
      userRecord(ID_C, project, 'nothing here'),
    ]);
    const titles = readTranscriptTitles([renamed, quotedOnly, untitled]);
    expect(titles.get(renamed)).toEqual({
      title: 'renamed later',
      kind: 'custom',
    });
    expect(titles.has(quotedOnly)).toBe(false);
    expect(titles.has(untitled)).toBe(false);
  });
});

describe('matching a query to sessions', () => {
  const sessions = [
    { sessionId: ID_A, title: 'billing fix' },
    { sessionId: ID_B, title: 'billing fix' }, // a /branch sibling
    { sessionId: ID_C, title: 'Billing fix follow-up' },
    { sessionId: '3333beef-dddd-4ddd-8ddd-000000000004', title: 'cafe' },
    { sessionId: '44440000-eeee-4eee-8eee-000000000005', title: '' },
  ];
  const ids = (q: string) => matchSessions(q, sessions).map((s) => s.sessionId);

  it('returns every session sharing a title, never one of them', () => {
    expect(ids('billing fix')).toEqual([ID_A, ID_B]);
    expect(ids('  BILLING FIX ')).toEqual([ID_A, ID_B]);
  });

  it('returns every session an id prefix fits', () => {
    expect(ids('11111111')).toEqual([ID_A, ID_B]);
    expect(ids('11111111-a')).toEqual([ID_A]);
  });

  it('a full id is exactly that session', () => {
    expect(ids(ID_B)).toEqual([ID_B]);
    expect(ids(ID_B.toUpperCase())).toEqual([ID_B]);
    expect(ids('99999999-9999-4999-8999-999999999999')).toEqual([]);
  });

  it('keeps both readings of a hex-shaped query: id prefix AND title', () => {
    // "cafe" is the title of one session and inside the id of another, but
    // only a PREFIX counts for ids.
    expect(ids('cafe')).toEqual(['3333beef-dddd-4ddd-8ddd-000000000004']);
    expect(ids('2222cafe')).toEqual([ID_C]);
    // A title that is also the start of another session's id: both.
    const both = [
      { sessionId: 'abc00000-0000-4000-8000-000000000001', title: 'x' },
      { sessionId: 'fff00000-0000-4000-8000-000000000002', title: 'abc' },
    ];
    expect(matchSessions('abc', both)).toHaveLength(2);
  });

  it('falls back to a partial title only when nothing matched outright', () => {
    expect(ids('follow-up')).toEqual([ID_C]);
    // An exact title exists, so the longer title containing it is not added.
    expect(ids('billing fix')).not.toContain(ID_C);
    expect(ids('billing')).toEqual([ID_A, ID_B, ID_C]);
  });

  it('matches nothing for an empty query — an untitled session is not "the empty title"', () => {
    expect(ids('')).toEqual([]);
    expect(ids('   ')).toEqual([]);
    expect(ids('no such thing')).toEqual([]);
  });

  it('pickOne refuses when there is more than one, or none', () => {
    const two = matchSessions('billing fix', sessions);
    expect(pickOne(two)).toEqual({
      ok: false,
      reason: 'ambiguous',
      matches: two,
    });
    expect(pickOne([])).toEqual({ ok: false, reason: 'none', matches: [] });
    const one = matchSessions('11111111-a', sessions);
    expect(pickOne(one)).toEqual({ ok: true, session: sessions[0] });
  });
});

describe('resume command', () => {
  it('has no prefix for the anchor account and a quoted one otherwise', () => {
    expect(formatResumeCommand(ID_A, null)).toBe(
      `command claude --resume ${ID_A}`,
    );
    expect(formatResumeCommand(ID_A, "/Users/O'Brien/.claude work")).toBe(
      `CLAUDE_CONFIG_DIR='/Users/O'\\''Brien/.claude work' command claude --resume ${ID_A}`,
    );
    expect(
      formatResumeCommand(ID_A, '/Users/dev/.claude-work', " --settings '/x.json'"),
    ).toBe(
      `CLAUDE_CONFIG_DIR='/Users/dev/.claude-work' command claude --settings '/x.json' --resume ${ID_A}`,
    );
  });

  it('formats the reference on one line', () => {
    expect(formatReference('billing fix', ID_A)).toBe(`billing fix (${ID_A})`);
    expect(formatReference(' two\nlines ', ID_A)).toBe(`two lines (${ID_A})`);
    expect(formatReference('', ID_A)).toBe(ID_A);
  });

  // The real path: the resolved command is run by a real shell, with a stub
  // `claude` on PATH that reports what it was given.
  it('survives a shell: hostile characters in the project path and the config dir stay data', () => {
    const nasty = "it's $HOME `id` \"q\" & co";
    const project = path.join(tmp, nasty);
    const configDir = path.join(tmp, `cfg ${nasty}`);
    fs.mkdirSync(project);
    const transcript = writeTranscript(configDir, project, ID_A, [
      userRecord(ID_A, project, 'hi'),
      customTitle(ID_A, 'billing fix'),
    ]);
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'claude'),
      '#!/bin/sh\nprintf \'%s\\n\' "$CLAUDE_CONFIG_DIR" "$PWD" "$*"\n',
      { mode: 0o755 },
    );

    const account = extra(configDir);
    const identity = resolveSessionIdentity({
      sessionId: ID_A,
      project,
      account,
      accountDirs: [configDir],
      title: (file) => readTranscriptTitles([file]).get(file) ?? { title: '', kind: 'none' },
      anchorDir: path.join(tmp, 'anchor'),
    });
    expect(identity).toMatchObject({
      title: 'billing fix',
      titleKind: 'custom',
      account: 'work',
      projectPath: project,
      transcriptPath: transcript,
      transcriptOutsideProjectSlug: false,
      reference: `billing fix (${ID_A})`,
    });

    const out = execFileSync('/bin/sh', ['-c', identity.resumeCommand], {
      encoding: 'utf-8',
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: '/nonexistent-home' },
    });
    expect(out.split('\n').slice(0, 3)).toEqual([
      configDir,
      project,
      `--resume ${ID_A}`,
    ]);
  });

  it('cdAndResume omits the cd when there is no project', () => {
    expect(cdAndResume('', 'command claude --resume x')).toBe(
      'command claude --resume x',
    );
  });

  it('reports a missing transcript, keeps a captured title, and builds no command for a bad id', () => {
    const gone = resolveSessionIdentity({
      sessionId: ID_B,
      project: path.join(tmp, 'acme-app'),
      account: anchor(path.join(tmp, 'acct')),
      accountDirs: [path.join(tmp, 'acct')],
      title: () => {
        throw new Error('must not be read without a transcript');
      },
      fallbackTitle: 'captured by a list',
      anchorDir: path.join(tmp, 'acct'),
    });
    expect(gone.transcriptPath).toBeNull();
    expect(gone.title).toBe('captured by a list');
    expect(gone.resumeCommand).toBe(
      `cd '${path.join(tmp, 'acme-app')}' && command claude --resume ${ID_B}`,
    );

    const bad = resolveSessionIdentity({
      sessionId: 'abc; rm -rf x',
      project: '/Users/dev/git/acme-app',
      account: undefined,
      accountLabel: 'ghost',
      accountDirs: [],
      title: { title: '', kind: 'none' },
      anchorDir: '/Users/dev/.claude',
    });
    expect(bad.resumeCommand).toBe('');
    expect(bad.account).toBe('ghost');
  });
});
