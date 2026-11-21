#!/usr/bin/env node
/**
 * `codev session` — find, describe and resume Claude Code sessions from a
 * terminal, across every account CodeV knows (`claude -r` sees one).
 *
 * Run (dev):  yarn session <cmd> [args]
 * e.g.        yarn session list --path .
 *             yarn session show "billing fix" --pretty
 *
 * Output is JSON on stdout unless `--pretty` asks for the human-readable form
 * (`resume` excepted — see below): the main caller is another agent. Errors go to stderr (one JSON object, or
 * plain text with `--pretty`) with a non-zero status, so stdout is always
 * either a complete answer or empty.
 *
 * Read-only, with one documented exception: describing or resuming a session
 * of an account that shares the anchor's auto-memory writes that project's
 * `--settings` file under ~/.config/codev/memory-settings — the same file
 * CodeV writes when it resumes the session itself.
 *
 * `resume` is the one command with no JSON. It does not start anything: it prints the command on stdout and the
 * `codev()` shell function in accounts.sh evals it, so `claude` becomes a
 * child of the user's own shell — the same process tree as a hand-typed
 * resume, which is what CodeV's terminal detection reads. Everything else
 * `resume` has to say goes to stderr, so stdout is either the command or
 * empty.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as manager from './account-manager';
import {
  liveRegistrations,
  ProcessInfo,
  readAncestors,
  readProcesses,
  readRegistrations,
  Registration,
  resolveSelf,
} from './session-self';
import { readLastActivity, readLastMessages } from './session-transcript';
import {
  createTranscriptIndex,
  HistorySession,
  IdentityAccount,
  isFullSessionId,
  locateTranscript,
  matchSessions,
  NO_TITLE,
  pickOne,
  readTranscriptTitles,
  resolveSessionIdentity,
  scanHistories,
  TranscriptIndex,
  SessionIdentity,
  SessionTitle,
} from './session-identity';

export const USAGE = `codev session — find, describe, read and resume Claude Code sessions (all accounts)

Usage:
  codev session list [--path <dir>] [--account <label>] [--live | --not-live]
                     [--all | --limit N]
                                     Sessions, newest first. Without --path or
                                     --live: the newest 30, unless --all or
                                     --limit N. With either: every one, unless
                                     --limit N.
                                     --path . = sessions whose project is this directory
                                     --live = only running sessions; --not-live = the rest
  codev session show <title | id>    Title, full id, account, project path, transcript
                                     path and resume command of EVERY matching session
  codev session view <title | id> [--last N]
                                     The last N things the user and the assistant said
                                     (default 10; text only — no tool calls, tool
                                     results or thinking). One session only.
  codev session self                 The session this command is being run from
  codev session resume <title | id>  Resume it in this terminal, under its own account
  codev session help                 Show this help

Output: list, show, view and self print JSON on stdout; add --pretty for the
human-readable form. Errors go to stderr with a non-zero status. resume is the
exception: it prints no JSON, only the shell command that the codev() shell
function then runs — so it takes no --pretty.

<title | id>:
  a full session id, the first four or more hex characters of one (hyphens
  allowed), or a session
  title — its /rename name, or the title Claude Code generated when it was
  never renamed. Titles are matched whole, ignoring case; part of a title works
  when nothing matches outright. Titles are not unique — /branch copies share
  theirs — so show lists every match, while view and resume refuse to pick one.
  titleKind in the output says what a title is: custom (a /rename name), ai
  (generated), unknown (captured earlier — it could be either), none (no title).

Which sessions: list, show, view and resume know the sessions in each account's
history.jsonl, plus every session running now — those come from the process's
own registration (<config dir>/sessions/<pid>.json), so a running session that
has never been given a prompt (a fresh /branch copy) is there too. One that is
neither — never prompted, or started from VS Code or Claude Desktop, and no
longer running — is not. self reads the running process's own registration.

Fields: live (with pid and status busy/idle) = the session's process is
running now. lastActive = its last prompt (history.jsonl); lastActivity = the
later of that and the last timestamped record in its transcript, so it moves
while the session works on one prompt. null when unknown. In --pretty lists,
✗ means the transcript is gone and the session cannot be resumed — it says
nothing about running.

Options: a value that starts with a dash is written --option=<value>.

Exit status: 0 found · 1 nothing matched or not available · 2 ambiguous or bad usage`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliDeps extends CliIo {
  accounts: () => IdentityAccount[];
  anchorDir: () => string;
  cwd: () => string;
  /** `self`: this process's ancestors, nearest first, and its environment. */
  ancestors?: () => ReturnType<typeof readAncestors>;
  env?: () => { CLAUDE_CODE_SESSION_ID?: string };
  /** The given pids as `ps` sees them now; a pid not running is absent. */
  processes?: (pids: number[]) => Map<number, ProcessInfo>;
}

/** A history session with what the transcript adds. */
interface CliSession extends HistorySession {
  title: string;
  titleKind: SessionTitle['kind'];
  /** Under the project's own slug, or — failing that — wherever the id's file is. */
  transcriptPath: string | null;
  /** The registration of the process running this session now; null when none is. */
  live: Registration | null;
  /** Epoch ms of the transcript's last timestamped record; 0 until read, or unknown. */
  lastActivityMs: number;
}

const tildify = (p: string): string => {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep)
    ? `~${p.slice(home.length)}`
    : p;
};

const realPathOrSelf = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

const localTime = (ms: number): string => {
  if (!ms) return '—';
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** One line, at most `max` characters — counted and cut by code point, so an emoji is never halved. */
const clip = (s: string, max: number): string => {
  const points = Array.from(s.replace(/\s+/g, ' ').trim());
  return points.length <= max
    ? points.join('')
    : `${points.slice(0, max - 1).join('')}…`;
};

/** Accounts from CodeV's registry; a machine with no registry has the one `~/.claude`. */
export const registryAccounts = (): IdentityAccount[] => {
  const reg = manager.readRegistry();
  const list: IdentityAccount[] = reg.accounts.map((a) => ({
    label: a.label,
    dir: path.resolve(manager.expandHome(a.dir)),
    configDirEnv: a.configDirEnv
      ? path.resolve(manager.expandHome(a.configDirEnv))
      : null,
    isAnchor: a.isAnchor,
    shareMemoryWithAnchor: a.shareMemoryWithAnchor === true,
  }));
  if (list.length === 0) {
    list.push({
      label: 'default',
      dir: path.join(os.homedir(), '.claude'),
      configDirEnv: null,
      isAnchor: true,
    });
  }
  return list.filter((a) => fs.existsSync(a.dir));
};

const registryAnchorDir = (): string =>
  registryAccounts().find((a) => a.isAnchor)?.dir ??
  path.join(os.homedir(), '.claude');

/** What each command accepts. `--pretty` and `--help` are added below. */
const COMMANDS: Record<
  string,
  { value: string[]; bool: string[]; positional: boolean; pretty: boolean }
> = {
  list: {
    value: ['--path', '--account', '--limit'],
    bool: ['--all', '--live', '--not-live'],
    positional: false,
    pretty: true,
  },
  show: { value: [], bool: [], positional: true, pretty: true },
  view: { value: ['--last'], bool: [], positional: true, pretty: true },
  self: { value: [], bool: [], positional: false, pretty: true },
  // No --pretty: resume's stdout is a shell command, never JSON.
  resume: { value: [], bool: [], positional: true, pretty: false },
};
COMMANDS.ls = COMMANDS.list;

/**
 * Split argv into flags (with their values) and positionals. An option the
 * command does not have is an error, not something to skip: a mistyped
 * `--limt 5` would otherwise run as if it had not been given.
 */
const parseArgs = (
  args: string[],
  valueFlags: string[],
  boolFlags: string[],
): { flags: Map<string, string | true>; positional: string[] } => {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(0, eq) : a;
      if (valueFlags.includes(name)) {
        // `--path --pretty` is a forgotten value, not a directory called
        // `--pretty`: the next token is only a value when it is not an option
        // itself. A value that does start with a dash is written `--opt=-x`.
        const next = args[i + 1];
        const value =
          eq > 0
            ? a.slice(eq + 1)
            : next !== undefined && !next.startsWith('-')
              ? args[++i]
              : undefined;
        // An empty value is a missing one too: `--path ""` would otherwise
        // resolve to the current directory and silently scope the list.
        if (value === undefined || value === '') {
          throw new Error(
            `${name} needs a value (one that starts with a dash is written ${name}=<value>)`,
          );
        }
        flags.set(name, value);
      } else if (boolFlags.includes(name)) {
        if (eq > 0) throw new Error(`${name} takes no value`);
        flags.set(name, true);
      } else {
        throw new Error(`unknown option ${name}`);
      }
    } else if (a === '-h') {
      flags.set('--help', true);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
};

const accountDirsFor = (
  s: HistorySession,
  accounts: IdentityAccount[],
): string[] => [s.accountDir, ...accounts.map((a) => a.dir)];

/**
 * A session history does not know, as its registration describes it: the
 * running session that has never been given a prompt. Its project is the
 * registration's cwd — where it is now, which is where it started unless it
 * has moved.
 */
const sessionFromRegistration = (
  reg: Registration,
  accounts: IdentityAccount[],
): HistorySession => {
  const account = accounts.find((a) => a.label === reg.accountLabel);
  return {
    sessionId: reg.sessionId,
    project: reg.cwd,
    firstDisplay: '',
    lastDisplay: '',
    firstTimestamp: 0,
    lastTimestamp: 0,
    promptCount: 0,
    accountLabel: reg.accountLabel,
    accountDir: reg.accountDir,
    accountConfigDirEnv: account?.configDirEnv ?? null,
    accountIsAnchor: !!account?.isAnchor,
  };
};

/** What a list is ordered by: the last prompt, or — for a session with none — when its registration last changed. */
const sortTime = (s: CliSession): number =>
  s.lastTimestamp || s.live?.updatedAt || s.live?.startedAt || 0;

/**
 * Every session in every account's history, plus every running one history
 * does not have, newest first, with its transcript located and whether it is
 * running — and no title yet: reading titles opens every transcript, so
 * `attachTitles` is called on as few as will do.
 */
const loadSessions = (
  accounts: IdentityAccount[],
  err: (line: string) => void,
  index: TranscriptIndex,
  running: Registration[],
): CliSession[] => {
  const scan = scanHistories(accounts, (label, e) =>
    err(`codev session: could not read the history of "${label}": ${(e as Error).message}`),
  );
  const liveById = new Map<string, Registration>();
  for (const reg of running) {
    if (!liveById.has(reg.sessionId)) liveById.set(reg.sessionId, reg);
  }
  const unprompted = [...liveById.values()]
    .filter((reg) => !scan.sessions.has(reg.sessionId))
    .map((reg) => sessionFromRegistration(reg, accounts));
  return [...scan.sessions.values(), ...unprompted]
    .map((s) => ({
      ...s,
      title: '',
      titleKind: 'none' as const,
      transcriptPath:
        // The project's own slug first; failing that, wherever a file with
        // this id is — through the shared index, so the directories are read
        // once and not once per session without a transcript.
        locateTranscript(accountDirsFor(s, accounts), s.project, s.sessionId, {
          scanAllSlugs: index,
        })?.path ?? null,
      live: liveById.get(s.sessionId) ?? null,
      lastActivityMs: 0,
    }))
    .sort((a, b) => sortTime(b) - sortTime(a));
};

/**
 * When each session last did anything — read only for the sessions that will
 * be shown. The later of the transcript's last timestamped record and the
 * last prompt: a prompt can reach history.jsonl and never the transcript
 * (seen 2026-11-21: one 16 hours after the transcript's last record), and a
 * session whose transcript is gone still has its prompts.
 */
const attachActivity = (sessions: CliSession[]): void => {
  for (const s of sessions) {
    s.lastActivityMs = Math.max(
      s.transcriptPath ? readLastActivity(s.transcriptPath) : 0,
      s.lastTimestamp,
    );
  }
};

const attachTitles = (sessions: CliSession[]): void => {
  const wanted = sessions.filter((s) => s.transcriptPath);
  const titles = readTranscriptTitles(
    wanted.map((s) => s.transcriptPath as string),
  );
  for (const s of wanted) {
    const t = titles.get(s.transcriptPath as string) ?? NO_TITLE;
    s.title = t.title;
    s.titleKind = t.kind;
  }
};

const identityOf = (
  s: CliSession,
  accounts: IdentityAccount[],
  anchorDir: string,
  index: TranscriptIndex,
): SessionIdentity =>
  resolveSessionIdentity({
    transcriptIndex: index,
    sessionId: s.sessionId,
    project: s.project,
    account: accounts.find((a) => a.label === s.accountLabel),
    accountLabel: s.accountLabel,
    accountDirs: accountDirsFor(s, accounts),
    // Normally already read for matching; `self` can name a session that
    // history does not have, and that one is read here.
    title: (file) =>
      file === s.transcriptPath
        ? { title: s.title, kind: s.titleKind }
        : (readTranscriptTitles([file]).get(file) ?? NO_TITLE),
    anchorDir,
  });

const describeTitle = (id: SessionIdentity): string =>
  id.titleKind === 'none'
    ? '(none)'
    : id.titleKind === 'ai'
      ? `${id.title}   (auto-generated — not a /rename name)`
      : id.titleKind === 'unknown'
        ? `${id.title}   (captured earlier — may be auto-generated)`
        : id.title;

const printIdentity = (
  id: SessionIdentity,
  s: CliSession,
  out: (line: string) => void,
): void => {
  out(`Title:          ${describeTitle(id)}`);
  out(`Session ID:     ${id.sessionId}`);
  out(`Account:        ${id.account}`);
  out(`Project:        ${id.projectPath || '(unknown)'}`);
  out(
    `Transcript:     ${
      id.transcriptPath
        ? id.transcriptPath +
          (id.transcriptOutsideProjectSlug
            ? "   (not under this project's own directory)"
            : '')
        : '(not found — Claude Code has removed it, or it never had one)'
    }`,
  );
  out(`Resume:         ${id.resumeCommand || '(not available)'}`);
  out(`Reference:      ${id.reference}`);
  out(
    `Running:        ${
      s.live ? `yes — pid ${s.live.pid} · ${s.live.status || 'status unknown'}` : 'no'
    }`,
  );
  out(
    `Last prompt:    ${
      s.promptCount > 0
        ? `${localTime(s.lastTimestamp)} · ${s.promptCount} prompt${s.promptCount === 1 ? '' : 's'}`
        : '(none in history)'
    }`,
  );
  out(`Last activity:  ${localTime(s.lastActivityMs)}`);
};

const listRow = (s: CliSession, accountPad: number, fullId: boolean): string => {
  const what = s.title
    ? s.title
    : s.firstDisplay
      ? `“${clip(s.firstDisplay, 50)}”`
      : '';
  return [
    fullId ? s.sessionId : s.sessionId.slice(0, 8),
    s.accountLabel.padEnd(accountPad),
    (s.live ? s.live.status || 'live' : '').padEnd(4),
    localTime(s.lastTimestamp).padEnd(16),
    localTime(s.lastActivityMs).padEnd(16),
    s.transcriptPath ? ' ' : '✗',
    `${clip(tildify(s.project), 44).padEnd(44)}`,
    clip(what, 70),
  ].join('  ');
};

/**
 * `fullId` for a list of candidates to choose from: the first eight characters
 * are a convenience in a browse list, but two candidates can share them, and
 * then "name one by id" must show ids that differ.
 */
const printRows = (
  rows: CliSession[],
  line: (l: string) => void,
  fullId = false,
): void => {
  const pad = Math.max(7, ...rows.map((s) => s.accountLabel.length));
  line(
    [
      'ID'.padEnd(fullId ? 36 : 8),
      'ACCOUNT'.padEnd(pad),
      'LIVE',
      'LAST PROMPT     ',
      'LAST ACTIVITY   ',
      ' ',
      'PROJECT'.padEnd(44),
      'TITLE / “FIRST PROMPT”',
    ].join('  '),
  );
  for (const s of rows) line(listRow(s, pad, fullId));
};

const isoOrNull = (ms: number): string | null =>
  ms ? new Date(ms).toISOString() : null;

/** Whether the session is running now, as every JSON answer says it. */
const liveFields = (s: CliSession) => ({
  live: s.live !== null,
  pid: s.live?.pid ?? null,
  status: s.live ? s.live.status || null : null,
});

/** The compact row used by `list` and by an "ambiguous" error. */
const summaryOf = (s: CliSession) => ({
  sessionId: s.sessionId,
  title: s.title,
  titleKind: s.titleKind,
  account: s.accountLabel,
  projectPath: s.project,
  transcriptPath: s.transcriptPath,
  lastActive: isoOrNull(s.lastTimestamp),
  lastActivity: isoOrNull(s.lastActivityMs),
  ...liveFields(s),
  promptCount: s.promptCount,
  firstPrompt: s.firstDisplay,
});

/** Run one `codev session …` invocation; returns the exit status. */
export const runSessionCli = (argv: string[], deps: CliDeps): number => {
  const args = [...argv];
  // Installed form is `codev session <cmd>` (the shell function strips the
  // word); the dev form passes <cmd> directly. Accept both.
  if (args[0] === 'session') args.shift();
  const [cmd, ...rest] = args;
  const { out, err } = deps;
  // Own keys only: `COMMANDS['toString']` would otherwise find a function on
  // Object.prototype and pass for a command.
  const spec =
    cmd !== undefined && Object.prototype.hasOwnProperty.call(COMMANDS, cmd)
      ? COMMANDS[cmd]
      : undefined;
  // `resume` never speaks JSON: its stdout is a shell command.
  const pretty = rest.includes('--pretty') || cmd === 'resume';
  // One index for the whole run: every lookup below shares it.
  const index = createTranscriptIndex();
  // Which sessions are running: read once, on first need.
  let runningCache: Registration[] | null = null;
  const running = (accounts: IdentityAccount[]): Registration[] =>
    (runningCache ??= liveRegistrations(accounts, deps.processes ?? readProcesses));
  const emit = (value: unknown, text: () => void): void => {
    if (pretty) text();
    else out(JSON.stringify(value));
  };
  /** Report a failure on stderr — never on stdout — and return `code`. */
  const fail = (
    code: number,
    message: string,
    more: { matches?: CliSession[]; usage?: boolean } = {},
  ): number => {
    const { matches, usage } = more;
    if (pretty) {
      err(message);
      if (matches?.length) printRows(matches, err, true);
      if (usage) err(`\n${USAGE}`);
    } else {
      err(
        JSON.stringify({
          error: message,
          ...(matches?.length ? { matches: matches.map(summaryOf) } : {}),
          ...(usage ? { usage: USAGE } : {}),
        }),
      );
    }
    return code;
  };
  const positiveInt = (name: string, fallback: number): number | null => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return typeof raw === 'string' && Number.isInteger(n) && n >= 1 ? n : null;
  };
  /** A history that could not be read must not pass in silence. */
  const warn = (message: string): void =>
    err(pretty ? message : JSON.stringify({ warning: message }));
  /** Sessions the query could mean, titles attached; [] when none. */
  const find = (query: string, accounts: IdentityAccount[]): CliSession[] => {
    // A full id cannot be a title match, so only that one transcript is
    // read; anything else needs every title.
    const sessions = loadSessions(accounts, warn, index, running(accounts));
    attachTitles(
      isFullSessionId(query)
        ? sessions.filter(
            (s) => s.sessionId.toLowerCase() === query.toLowerCase(),
          )
        : sessions,
    );
    const matches = matchSessions(query, sessions);
    attachActivity(matches);
    return matches;
  };

  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || cmd === undefined) {
    out(USAGE);
    return 0;
  }
  if (!spec) {
    return fail(2, `Unknown command: ${cmd}`, { usage: true });
  }
  let flags: Map<string, string | true>;
  let positional: string[];
  try {
    ({ flags, positional } = parseArgs(rest, spec.value, [
      ...spec.bool,
      '--help',
      ...(spec.pretty ? ['--pretty'] : []),
    ]));
  } catch (e) {
    return fail(2, `${cmd}: ${(e as Error).message}`, { usage: true });
  }
  if (flags.has('--help')) {
    // `resume` keeps stdout for the command alone — help included.
    (cmd === 'resume' ? err : out)(USAGE);
    return 0;
  }
  if (!spec.positional && positional.length > 0) {
    return fail(2, `${cmd}: unexpected argument "${positional[0]}"`, {
      usage: true,
    });
  }

  // Anything a command throws from here on — a transcript that cannot be
  // read, a broken registry — is a failure like any other: reported through
  // `fail`, so it is JSON unless --pretty (or resume), and never on stdout.
  try {
    switch (cmd) {
      case 'list':
      case 'ls': {
        const accounts = deps.accounts();
        const wantPath = flags.get('--path');
        const wantAccount = flags.get('--account');
        if (
          typeof wantAccount === 'string' &&
          !accounts.some((a) => a.label === wantAccount)
        ) {
          return fail(
            2,
            `list: no account "${wantAccount}" (have: ${accounts.map((a) => a.label).join(', ')})`,
          );
        }
        const onlyLive = flags.has('--live');
        const onlyNotLive = flags.has('--not-live');
        if (onlyLive && onlyNotLive) {
          return fail(2, 'list: --live and --not-live exclude each other');
        }
        const limit = flags.has('--all')
          ? Infinity
          : positiveInt(
              '--limit',
              typeof wantPath === 'string' || onlyLive ? Infinity : 30,
            );
        if (limit === null) {
          return fail(2, 'list: --limit needs a positive whole number');
        }
        const target =
          typeof wantPath === 'string'
            ? realPathOrSelf(path.resolve(deps.cwd(), wantPath))
            : null;
        const realCache = new Map<string, string>();
        const sameDir = (project: string): boolean => {
          if (!project) return false;
          let r = realCache.get(project);
          if (r === undefined) {
            r = realPathOrSelf(project);
            realCache.set(project, r);
          }
          return r === target;
        };
        const all = loadSessions(accounts, warn, index, running(accounts)).filter(
          (s) =>
            (target === null || sameDir(s.project)) &&
            (typeof wantAccount !== 'string' || s.accountLabel === wantAccount) &&
            (!onlyLive || s.live !== null) &&
            (!onlyNotLive || s.live === null),
        );
        // Only the rows that will be printed pay for a title and an activity time.
        const rows = all.slice(0, limit);
        attachTitles(rows);
        attachActivity(rows);
        // An empty list is an answer, not an error: exit 0 with no sessions.
        emit({ total: all.length, sessions: rows.map(summaryOf) }, () => {
          if (rows.length === 0) {
            out(
              target !== null
                ? `No ${onlyLive ? 'running ' : ''}sessions with project path ${tildify(target)}`
                : onlyLive
                  ? 'No running sessions found'
                  : 'No sessions found',
            );
            return;
          }
          printRows(rows, out);
          const more = all.length - rows.length;
          out(
            `${rows.length} session${rows.length === 1 ? '' : 's'}` +
              (more > 0 ? ` shown, ${more} older not shown (--all)` : '') +
              ` · ${rows.filter((s) => s.live).length} running` +
              ' · details: codev session show <id>',
          );
          // Always, not only when a row has one: ✗ reads as "not running"
          // otherwise.
          out(
            'LIVE = running now (busy / idle) · LAST PROMPT = last user prompt · ' +
              'LAST ACTIVITY = last transcript record or prompt, whichever is later · ' +
              '✗ = transcript gone, cannot be resumed (not about running)',
          );
        });
        return 0;
      }

      case 'show':
      case 'view':
      case 'resume': {
        const query = positional.join(' ').trim();
        if (!query) {
          return fail(2, `${cmd}: give a session title or the start of a session id`);
        }
        const last = positiveInt('--last', 10);
        if (last === null) {
          return fail(2, 'view: --last needs a positive whole number');
        }
        const accounts = deps.accounts();
        const matches = find(query, accounts);
        if (matches.length === 0) {
          return fail(1, `No session matches "${query}" (see: codev session list)`);
        }

        if (cmd === 'show') {
          const ids = matches.map((s) => identityOf(s, accounts, deps.anchorDir(), index));
          emit(
            {
              sessions: ids.map((id, i) => ({
                ...id,
                lastActive: isoOrNull(matches[i].lastTimestamp),
                lastActivity: isoOrNull(matches[i].lastActivityMs),
                ...liveFields(matches[i]),
                promptCount: matches[i].promptCount,
              })),
            },
            () => {
              if (matches.length > 1) {
                out(`${matches.length} sessions match "${query}":`);
                out('');
              }
              ids.forEach((id, i) => {
                if (i > 0) out('');
                printIdentity(id, matches[i], out);
              });
            },
          );
          return 0;
        }

        // `view` and `resume` act on ONE session: more than one is a refusal.
        const picked = pickOne(matches);
        if (picked.ok === false) {
          return fail(
            2,
            `${matches.length} sessions match "${query}" — not guessing. Name one by id:`,
            { matches },
          );
        }
        const s = picked.session;
        const id = identityOf(s, accounts, deps.anchorDir(), index);
        if (!id.transcriptPath) {
          return fail(
            1,
            `${s.sessionId}: its transcript is gone (Claude Code removes old ones).`,
          );
        }

        if (cmd === 'view') {
          const messages = readLastMessages(id.transcriptPath, last);
          emit(
            {
              sessionId: id.sessionId,
              title: id.title,
              titleKind: id.titleKind,
              account: id.account,
              projectPath: id.projectPath,
              transcriptPath: id.transcriptPath,
              messages,
            },
            () => {
              out(`${id.reference} · ${id.account} · ${tildify(id.projectPath)}`);
              out(
                `last ${messages.length} message${messages.length === 1 ? '' : 's'} (text only)`,
              );
              for (const m of messages) {
                out('');
                const at = m.timestamp ? localTime(Date.parse(m.timestamp)) : '';
                out(`── ${m.role}${at ? ` · ${at}` : ''} ──`);
                out(m.text);
              }
            },
          );
          return 0;
        }

        if (!id.resumeCommand) {
          return fail(1, `Cannot resume: "${s.sessionId}" is not a usable session id.`);
        }
        let isDir = false;
        try {
          isDir = fs.statSync(id.projectPath).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) {
          return fail(
            1,
            `Cannot resume ${s.sessionId}: its project path no longer exists (${id.projectPath || 'unknown'}).`,
          );
        }
        if (id.transcriptOutsideProjectSlug) {
          err(
            "Note: the transcript is not under this project's own directory; claude may not find it from there.",
          );
        }
        err(`Resuming ${id.reference} as ${id.account} in ${tildify(id.projectPath)}`);
        out(id.resumeCommand);
        return 0;
      }

      case 'self': {
        const accounts = deps.accounts();
        const envId = (deps.env ?? (() => process.env))().CLAUDE_CODE_SESSION_ID;
        const found = resolveSelf(
          (deps.ancestors ?? readAncestors)(),
          (pid) => readRegistrations(accounts, pid),
          envId,
        );
        if (found.ok === false) {
          return fail(found.reason === 'ambiguous' ? 2 : 1, `self: ${found.detail}`);
        }
        const reg = found.registration;
        // History knows the directory the session STARTED in, which is where its
        // transcript is filed; the registration's cwd follows the session around.
        // No process lookup here: this session is running by definition, and
        // the registration found above is the proof.
        const known = loadSessions(accounts, warn, index, []).find(
          (s) => s.sessionId === reg.sessionId,
        );
        const session: CliSession = known ?? {
          ...sessionFromRegistration(reg, accounts),
          title: '',
          titleKind: 'none',
          transcriptPath: null,
          live: null,
          lastActivityMs: 0,
        };
        // The account is the one whose config dir holds the registration.
        session.accountLabel = reg.accountLabel;
        session.accountDir = reg.accountDir;
        session.live = reg;
        attachTitles([session]);
        const id = identityOf(session, accounts, deps.anchorDir(), index);
        // The identity locates the transcript even for a session history
        // does not have.
        session.transcriptPath ??= id.transcriptPath;
        attachActivity([session]);
        emit(
          {
            ...id,
            lastActive: isoOrNull(session.lastTimestamp),
            lastActivity: isoOrNull(session.lastActivityMs),
            promptCount: session.promptCount,
            pid: reg.pid,
            // What Claude Code itself calls the session right now.
            name: reg.name,
            status: reg.status,
            cwd: reg.cwd,
            proof: found.proof,
            environmentAgrees: found.environmentAgrees,
          },
          () => {
            printIdentity(id, session, out);
            out(
              `Known by:       its sessions/<pid>.json registration (${found.proof})` +
                (found.environmentAgrees === false
                  ? ' — CLAUDE_CODE_SESSION_ID names a different session'
                  : ''),
            );
          },
        );
        return 0;
      }

      default:
        // Unreachable: every key of COMMANDS has a case above.
        return fail(2, `Unknown command: ${cmd}`, { usage: true });
    }
  } catch (e) {
    return fail(1, `${cmd}: ${(e as Error)?.message ?? String(e)}`);
  }
};

if (require.main === module) {
  // A closed pipe (`codev session list | head`) is not an error.
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
  });
  let code: number;
  try {
    code = runSessionCli(process.argv.slice(2), {
      out: (l) => process.stdout.write(l + '\n'),
      err: (l) => process.stderr.write(l + '\n'),
      accounts: registryAccounts,
      anchorDir: registryAnchorDir,
      cwd: () => process.cwd(),
    });
  } catch (e) {
    process.stderr.write(`✗ ${(e as Error).message}\n`);
    code = 1;
  }
  process.exitCode = code;
}
