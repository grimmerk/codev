#!/usr/bin/env node
/**
 * `codev session` — find, describe and resume Claude Code sessions from a
 * terminal, across every account CodeV knows (`claude -r` sees one).
 *
 * Run (dev):  yarn session <cmd> [args]
 * e.g.        yarn session list --path .
 *             yarn session show "billing fix" --pretty
 *
 * Output is JSON on stdout unless `--pretty` asks for the human-readable form:
 * the main caller is another agent. Errors go to stderr (one JSON object, or
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
  readAncestors,
  readRegistrations,
  resolveSelf,
} from './session-self';
import { readLastMessages } from './session-transcript';
import {
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
  SessionIdentity,
  SessionTitle,
} from './session-identity';

export const USAGE = `codev session — find, describe, read and resume Claude Code sessions (all accounts)

Usage:
  codev session list [--path <dir>] [--account <label>] [--all | --limit N]
                                     Sessions, newest first (30 unless --all /
                                     --limit; every one with --path).
                                     --path . = sessions whose project is this directory
  codev session show <title | id>    Title, full id, account, project path, transcript
                                     path and resume command of EVERY matching session
  codev session view <title | id> [--last N]
                                     The last N things the user and the assistant said
                                     (default 10; text only — no tool calls, tool
                                     results or thinking). One session only.
  codev session self                 The session this command is being run from
  codev session resume <title | id>  Resume it in this terminal, under its own account
  codev session help                 Show this help

Output: JSON on stdout; add --pretty for the human-readable form. Errors go to
stderr with a non-zero status. (resume prints no JSON: it runs the session.)

<title | id>:
  a full session id, the start of one, or a session title (its /rename name).
  Titles are matched whole, ignoring case; part of a title works when nothing
  matches outright. Titles are not unique — /branch copies share theirs — so
  show lists every match, while view and resume refuse to pick one.

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
}

/** A history session with what the transcript adds. */
interface CliSession extends HistorySession {
  title: string;
  titleKind: SessionTitle['kind'];
  transcriptPath: string | null;
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

const clip = (s: string, max: number): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
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

/** Split argv into flags (with their values) and positionals. */
const parseArgs = (
  args: string[],
  valueFlags: string[],
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
        const value = eq > 0 ? a.slice(eq + 1) : args[++i];
        if (value === undefined) throw new Error(`${name} needs a value`);
        flags.set(name, value);
      } else {
        flags.set(name, true);
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
 * Every session in every account's history, newest first, with its transcript
 * located — and no title yet: reading titles is the one slow step (a grep
 * over each transcript), so `attachTitles` is called on as few as will do.
 */
const loadSessions = (
  accounts: IdentityAccount[],
  err: (line: string) => void,
): CliSession[] => {
  const scan = scanHistories(accounts, (label, e) =>
    err(`codev session: could not read the history of "${label}": ${(e as Error).message}`),
  );
  return [...scan.sessions.values()]
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    .map((s) => ({
      ...s,
      title: '',
      titleKind: 'none' as const,
      transcriptPath:
        locateTranscript(accountDirsFor(s, accounts), s.project, s.sessionId)
          ?.path ?? null,
    }));
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
): SessionIdentity =>
  resolveSessionIdentity({
    sessionId: s.sessionId,
    project: s.project,
    account: accounts.find((a) => a.label === s.accountLabel),
    accountLabel: s.accountLabel,
    accountDirs: accountDirsFor(s, accounts),
    // Already read for matching; a transcript found only by the fallback
    // search has not been, so that one is read here.
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
      : id.title;

const printIdentity = (
  id: SessionIdentity,
  s: CliSession,
  out: (line: string) => void,
): void => {
  out(`Title:        ${describeTitle(id)}`);
  out(`Session ID:   ${id.sessionId}`);
  out(`Account:      ${id.account}`);
  out(`Project:      ${id.projectPath || '(unknown)'}`);
  out(
    `Transcript:   ${
      id.transcriptPath
        ? id.transcriptPath +
          (id.transcriptOutsideProjectSlug
            ? "   (not under this project's own directory)"
            : '')
        : '(not found — Claude Code has removed it, or it never had one)'
    }`,
  );
  out(`Resume:       ${id.resumeCommand || '(not available)'}`);
  out(`Reference:    ${id.reference}`);
  out(
    `Last active:  ${localTime(s.lastTimestamp)} · ${s.promptCount} prompt${s.promptCount === 1 ? '' : 's'}`,
  );
};

const listRow = (s: CliSession, accountPad: number): string => {
  const what = s.title
    ? s.title
    : s.firstDisplay
      ? `“${clip(s.firstDisplay, 50)}”`
      : '';
  return [
    s.sessionId.slice(0, 8),
    s.accountLabel.padEnd(accountPad),
    localTime(s.lastTimestamp),
    s.transcriptPath ? ' ' : '✗',
    `${clip(tildify(s.project), 44).padEnd(44)}`,
    clip(what, 70),
  ].join('  ');
};

const printRows = (rows: CliSession[], line: (l: string) => void): void => {
  const pad = Math.max(7, ...rows.map((s) => s.accountLabel.length));
  line(
    ['ID      ', 'ACCOUNT'.padEnd(pad), 'LAST ACTIVE     ', ' ', 'PROJECT'.padEnd(44), 'TITLE / “FIRST PROMPT”'].join('  '),
  );
  for (const s of rows) line(listRow(s, pad));
};

const isoOrNull = (ms: number): string | null =>
  ms ? new Date(ms).toISOString() : null;

/** The compact row used by `list` and by an "ambiguous" error. */
const summaryOf = (s: CliSession) => ({
  sessionId: s.sessionId,
  title: s.title,
  titleKind: s.titleKind,
  account: s.accountLabel,
  projectPath: s.project,
  transcriptPath: s.transcriptPath,
  lastActive: isoOrNull(s.lastTimestamp),
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
  // `resume` never speaks JSON: its stdout is a shell command.
  const pretty = rest.includes('--pretty') || cmd === 'resume';
  const emit = (value: unknown, text: () => void): void => {
    if (pretty) text();
    else out(JSON.stringify(value));
  };
  /** Report a failure on stderr — never on stdout — and return `code`. */
  const fail = (code: number, message: string, matches?: CliSession[]): number => {
    if (pretty) {
      err(message);
      if (matches?.length) printRows(matches, err);
    } else {
      err(
        JSON.stringify({
          error: message,
          ...(matches?.length ? { matches: matches.map(summaryOf) } : {}),
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
    const sessions = loadSessions(accounts, warn);
    attachTitles(
      isFullSessionId(query)
        ? sessions.filter(
            (s) => s.sessionId.toLowerCase() === query.toLowerCase(),
          )
        : sessions,
    );
    return matchSessions(query, sessions);
  };

  let flags: Map<string, string | true>;
  let positional: string[];
  try {
    ({ flags, positional } = parseArgs(rest, [
      '--path',
      '--account',
      '--limit',
      '--last',
    ]));
  } catch (e) {
    return fail(2, `${cmd}: ${(e as Error).message}`);
  }
  if (flags.has('--help') || cmd === 'help' || cmd === undefined) {
    // `resume` keeps stdout for the command alone — help included.
    (cmd === 'resume' ? err : out)(USAGE);
    return 0;
  }

  switch (cmd) {
    case 'list':
    case 'ls': {
      if (positional.length > 0) {
        return fail(
          2,
          `list: unexpected argument "${positional[0]}" (did you mean --path?)`,
        );
      }
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
      const limit = flags.has('--all')
        ? Infinity
        : positiveInt('--limit', typeof wantPath === 'string' ? Infinity : 30);
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
      const all = loadSessions(accounts, warn).filter(
        (s) =>
          (target === null || sameDir(s.project)) &&
          (typeof wantAccount !== 'string' || s.accountLabel === wantAccount),
      );
      // Only the rows that will be printed pay for a title.
      const rows = all.slice(0, limit);
      attachTitles(rows);
      // An empty list is an answer, not an error: exit 0 with no sessions.
      emit({ total: all.length, sessions: rows.map(summaryOf) }, () => {
        if (rows.length === 0) {
          out(
            target !== null
              ? `No sessions with project path ${tildify(target)}`
              : 'No sessions found',
          );
          return;
        }
        printRows(rows, out);
        const more = all.length - rows.length;
        out(
          `${rows.length} session${rows.length === 1 ? '' : 's'}` +
            (more > 0 ? ` shown, ${more} older not shown (--all)` : '') +
            (rows.some((s) => !s.transcriptPath)
              ? ' · ✗ = transcript gone, cannot be resumed'
              : '') +
            ' · details: codev session show <id>',
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
        const ids = matches.map((s) => identityOf(s, accounts, deps.anchorDir()));
        emit(
          {
            sessions: ids.map((id, i) => ({
              ...id,
              lastActive: isoOrNull(matches[i].lastTimestamp),
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
          matches,
        );
      }
      const s = picked.session;
      const id = identityOf(s, accounts, deps.anchorDir());
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
      const known = loadSessions(accounts, warn).find(
        (s) => s.sessionId === reg.sessionId,
      );
      const session: CliSession = known ?? {
        sessionId: reg.sessionId,
        project: reg.cwd,
        firstDisplay: '',
        lastDisplay: '',
        firstTimestamp: 0,
        lastTimestamp: 0,
        promptCount: 0,
        accountLabel: reg.accountLabel,
        accountDir: reg.accountDir,
        accountConfigDirEnv:
          accounts.find((a) => a.label === reg.accountLabel)?.configDirEnv ??
          null,
        accountIsAnchor: !!accounts.find((a) => a.label === reg.accountLabel)
          ?.isAnchor,
        title: '',
        titleKind: 'none',
        transcriptPath: null,
      };
      // The account is the one whose config dir holds the registration.
      session.accountLabel = reg.accountLabel;
      session.accountDir = reg.accountDir;
      attachTitles([session]);
      const id = identityOf(session, accounts, deps.anchorDir());
      emit(
        {
          ...id,
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
          out(`Process:      pid ${reg.pid} · ${reg.status || 'status unknown'}`);
          out(
            `Known by:     its sessions/<pid>.json registration (${found.proof})` +
              (found.environmentAgrees === false
                ? ' — CLAUDE_CODE_SESSION_ID names a different session'
                : ''),
          );
        },
      );
      return 0;
    }

    default:
      return fail(2, `Unknown command: ${cmd} (see: codev session help)`);
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
