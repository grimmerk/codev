#!/usr/bin/env node
/**
 * `codev session` — find, describe and resume Claude Code sessions from a
 * terminal, across every account CodeV knows (`claude -r` sees one).
 *
 * Run (dev):  yarn session <cmd> [args]
 * e.g.        yarn session list --path .
 *             yarn session show "billing fix"
 *
 * Read-only, with one documented exception: describing or resuming a session
 * of an account that shares the anchor's auto-memory writes that project's
 * `--settings` file under ~/.config/codev/memory-settings — the same file
 * CodeV writes when it resumes the session itself.
 *
 * `resume` does not start anything: it prints the command on stdout and the
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

export const USAGE = `codev session — find, describe and resume Claude Code sessions (all accounts)

Usage:
  codev session list [--path <dir>] [--account <label>] [--all | --limit N] [--json]
                                     Sessions, newest first (30 unless --all /
                                     --limit; every one with --path).
                                     --path . = sessions whose project is this directory
  codev session show <title | id> [--json]
                                     Title, full id, account, project path, transcript
                                     path and resume command of EVERY matching session
  codev session resume <title | id>  Resume it in this terminal, under its own account.
                                     Refuses when more than one session matches.
  codev session help                 Show this help

<title | id>:
  a full session id, the start of one, or a session title (its /rename name).
  Titles are matched whole, ignoring case; part of a title works when nothing
  matches outright. Titles are not unique — /branch copies share theirs.

Exit status: 0 found · 1 nothing matched or not resumable · 2 ambiguous (resume) or bad usage`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliDeps extends CliIo {
  accounts: () => IdentityAccount[];
  anchorDir: () => string;
  cwd: () => string;
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

/** Run one `codev session …` invocation; returns the exit status. */
export const runSessionCli = (argv: string[], deps: CliDeps): number => {
  const args = [...argv];
  // Installed form is `codev session <cmd>` (the shell function strips the
  // word); the dev form passes <cmd> directly. Accept both.
  if (args[0] === 'session') args.shift();
  const [cmd, ...rest] = args;
  const { out, err } = deps;

  switch (cmd) {
    case 'list':
    case 'ls': {
      const { flags, positional } = parseArgs(rest, [
        '--path',
        '--account',
        '--limit',
      ]);
      if (flags.has('--help')) {
        out(USAGE);
        return 0;
      }
      if (positional.length > 0) {
        err(`list: unexpected argument "${positional[0]}" (did you mean --path?)`);
        return 2;
      }
      const accounts = deps.accounts();
      const wantPath = flags.get('--path');
      const wantAccount = flags.get('--account');
      if (
        typeof wantAccount === 'string' &&
        !accounts.some((a) => a.label === wantAccount)
      ) {
        err(
          `list: no account "${wantAccount}" (have: ${accounts.map((a) => a.label).join(', ')})`,
        );
        return 2;
      }
      let limit = typeof wantPath === 'string' ? Infinity : 30;
      if (flags.has('--all')) limit = Infinity;
      const rawLimit = flags.get('--limit');
      if (typeof rawLimit === 'string') {
        limit = Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1) {
          err(`list: --limit needs a positive whole number (got "${rawLimit}")`);
          return 2;
        }
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
      const keep = (s: HistorySession): boolean =>
        (target === null || sameDir(s.project)) &&
        (typeof wantAccount !== 'string' || s.accountLabel === wantAccount);
      const all = loadSessions(accounts, err).filter(keep);
      // Only the rows that will be printed pay for a title.
      const rows = all.slice(0, limit);
      attachTitles(rows);

      if (flags.has('--json')) {
        out(
          JSON.stringify(
            rows.map((s) => ({
              sessionId: s.sessionId,
              title: s.title,
              titleKind: s.titleKind,
              account: s.accountLabel,
              projectPath: s.project,
              transcriptPath: s.transcriptPath,
              lastActive: s.lastTimestamp
                ? new Date(s.lastTimestamp).toISOString()
                : null,
              promptCount: s.promptCount,
              firstPrompt: s.firstDisplay,
            })),
            null,
            2,
          ),
        );
        return rows.length > 0 ? 0 : 1;
      }
      if (rows.length === 0) {
        err(
          target !== null
            ? `No sessions with project path ${tildify(target)}`
            : 'No sessions found',
        );
        return 1;
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
      return 0;
    }

    case 'show':
    case 'resume': {
      const { flags, positional } = parseArgs(rest, []);
      // `resume` keeps stdout for the command alone — help included.
      const say = cmd === 'resume' ? err : out;
      if (flags.has('--help')) {
        say(USAGE);
        return 0;
      }
      const query = positional.join(' ').trim();
      if (!query) {
        err(`${cmd}: give a session title or the start of a session id`);
        return 2;
      }
      const accounts = deps.accounts();
      // A full id cannot be a title match, so only that one transcript is
      // read; anything else needs every title.
      const full = isFullSessionId(query);
      const sessions = loadSessions(accounts, err);
      attachTitles(
        full
          ? sessions.filter(
              (s) => s.sessionId.toLowerCase() === query.toLowerCase(),
            )
          : sessions,
      );
      const matches = matchSessions(query, sessions);
      if (matches.length === 0) {
        err(`No session matches "${query}" (see: codev session list)`);
        return 1;
      }

      if (cmd === 'show') {
        const ids = matches.map((s) => identityOf(s, accounts, deps.anchorDir()));
        if (flags.has('--json')) {
          out(
            JSON.stringify(
              ids.map((id, i) => ({
                ...id,
                lastActive: matches[i].lastTimestamp
                  ? new Date(matches[i].lastTimestamp).toISOString()
                  : null,
                promptCount: matches[i].promptCount,
              })),
              null,
              2,
            ),
          );
          return 0;
        }
        if (matches.length > 1) {
          out(`${matches.length} sessions match "${query}":`);
          out('');
        }
        ids.forEach((id, i) => {
          if (i > 0) out('');
          printIdentity(id, matches[i], out);
        });
        return 0;
      }

      const picked = pickOne(matches);
      if (picked.ok === false) {
        err(
          `${matches.length} sessions match "${query}" — not guessing. Resume one by id:`,
        );
        printRows(matches, err);
        return 2;
      }
      const s = picked.session;
      const id = identityOf(s, accounts, deps.anchorDir());
      if (!id.transcriptPath) {
        err(
          `Cannot resume ${s.sessionId}: its transcript is gone (Claude Code removes old ones).`,
        );
        return 1;
      }
      if (!id.resumeCommand) {
        err(`Cannot resume: "${s.sessionId}" is not a usable session id.`);
        return 1;
      }
      let isDir = false;
      try {
        isDir = fs.statSync(id.projectPath).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        err(
          `Cannot resume ${s.sessionId}: its project path no longer exists (${id.projectPath || 'unknown'}).`,
        );
        return 1;
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

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      out(USAGE);
      return 0;

    default:
      err(`Unknown command: ${cmd}\n`);
      err(USAGE);
      return 2;
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
