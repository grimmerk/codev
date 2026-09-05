/**
 * What is actually running, and what it costs (issue #94; the LIVE half of
 * the saved-lists screen, issue #145).
 *
 * Two sources that do not agree, joined:
 *
 * - `ps` — every `claude` process the OS knows about, with memory, tty and
 *   uptime. Ground truth for "is it running", knows nothing about sessions.
 * - `~/.claude/sessions/<pid>.json` — Claude Code's own pid → sessionId
 *   registration. Knows the session, but is written at start and cleaned up
 *   on a best-effort basis, so it can be stale (pid dead) or missing (pid
 *   alive, no file). Measured 2026-09-05 on 33 real sessions: one of each.
 *
 * Saving "what is open" straight from the registration would therefore omit
 * one session and store one ghost — which is why this join exists rather
 * than a filter over the registrations. The pure pieces (`parsePsOutput`,
 * `isSessionProcess`, `joinLiveSessions`) are unit-tested against captured
 * output; `collectLiveSessions` wires them to the OS.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { getScannableAccounts } from './accounts';

export interface ClaudeProcess {
  pid: number;
  /** Resident set size in KB, as `ps` reports it on macOS. */
  rssKb: number;
  /** `null` when `ps` prints `??` — no controlling terminal. */
  tty: string | null;
  uptimeSec: number;
  args: string;
}

export interface SessionRegistration {
  pid: number;
  sessionId: string;
  cwd: string;
  entrypoint: string;
  accountLabel: string;
  accountDir: string;
  /** The anchor (~/.claude) account shows no account badge. */
  accountIsAnchor?: boolean;
}

export interface LiveSession {
  pid: number;
  /** Null for a running process no registration or argument identifies. */
  sessionId: string | null;
  cwd: string | null;
  rssKb: number;
  tty: string | null;
  uptimeSec: number;
  /** False when found only by `ps` — invisible to every registration-based view. */
  registered: boolean;
  entrypoint?: string;
  accountLabel?: string;
  accountIsAnchor?: boolean;
}

export interface LiveSessionsReport {
  live: LiveSession[];
  /** Registered pids whose process is gone — a stale file, shown as a ghost by anything that trusts it. */
  staleRegistrations: { pid: number; sessionId: string; cwd: string }[];
  totalRssKb: number;
  measuredAt: number;
}

/** `[[dd-]hh:]mm:ss` as `ps -o etime` prints it. */
export const parseEtime = (s: string): number => {
  const m = s.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, d, h, min, sec] = m;
  return (
    (d ? Number(d) * 86400 : 0) +
    (h ? Number(h) * 3600 : 0) +
    Number(min) * 60 +
    Number(sec)
  );
};

/** Output of `ps -Ao pid=,rss=,tty=,etime=,args=`, one process per line. */
export const parsePsOutput = (out: string): ClaudeProcess[] => {
  const procs: ClaudeProcess[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      rssKb: Number(m[2]),
      tty: m[3] === '??' ? null : m[3],
      uptimeSec: parseEtime(m[4]),
      args: m[5].trim(),
    });
  }
  return procs;
};

/**
 * Subcommands that run under the `claude` binary but are not a session:
 * the background daemon and its pty hosts / spares, MCP serving, installers.
 * Measured 2026-09-05: four of the five "unregistered claude processes" were
 * these, which is how a count of orphans came out as 5 instead of 1.
 */
const NON_SESSION_SUBCOMMANDS = new Set([
  'daemon',
  'bg-pty-host',
  'bg-spare',
  'mcp',
  'update',
  'doctor',
  'install',
  'plugin',
  'plugins',
  'auth',
  'login',
  'logout',
  'config',
  'setup-token',
  'migrate-installer',
  'agents',
]);

/**
 * Flag-style invocations that run the `claude` binary without opening a
 * session: version / help / updater / MCP serving / the app helper. They
 * run in a terminal (so they have a tty) and exit within seconds, but a
 * `ps` taken in that window would otherwise count them as live.
 */
const NON_SESSION_FLAGS = new Set([
  // Print mode: a non-interactive one-shot, not something to list or save.
  '--print',
  '-p',
  '--version',
  '-v',
  '--help',
  '-h',
  '--update',
  '--install',
  '--mcp-serve',
  '--helper',
]);

const isClaudeBinary = (token: string): boolean =>
  path.basename(token) === 'claude' ||
  /\/share\/claude\/versions\/[^/]+$/.test(token) ||
  /ClaudeCode\.app\/Contents\/MacOS\/claude$/.test(token);

/**
 * Options that take a value, so the token after them is not an option even
 * when the walk below is looking for one. A value that itself starts with
 * `-` is not consumed — `-r -p x` is a print run, not a resume of "-p".
 */
const VALUE_FLAGS = new Set([
  '-n',
  '--name',
  '-r',
  '--resume',
  '--session-id',
  '--model',
  '--add-dir',
  '--settings',
  '--mcp-config',
  '--permission-mode',
  '--agent',
  '--effort',
]);

/** A `claude` process that is (or could be) an interactive session. */
export const isSessionProcess = (p: ClaudeProcess): boolean => {
  const tokens = p.args.split(/\s+/);
  if (!tokens[0] || !isClaudeBinary(tokens[0])) return false;
  const first = tokens[1];
  if (first && !first.startsWith('-') && NON_SESSION_SUBCOMMANDS.has(first)) {
    return false;
  }
  // Walk the leading option sequence: a one-shot flag anywhere in it makes
  // the whole invocation a one-shot (`claude -c -p "query"` is print mode).
  // The first positional token — a prompt — ends the walk, so words inside
  // a prompt can never be mistaken for flags.
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('-')) break;
    if (NON_SESSION_FLAGS.has(t)) return false;
    const next = tokens[i + 1];
    if (VALUE_FLAGS.has(t) && next && !next.startsWith('-')) i++;
  }
  return true;
};

/** `--resume <id>` / `-r <id>` / `--session-id <id>` on the command line. */
export const sessionIdFromArgs = (args: string): string | null => {
  const m = args.match(
    /(?:--resume|-r|--session-id)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
  );
  return m ? m[1] : null;
};

/**
 * Join `ps` against the registrations.
 *
 * A process counts as live when it is a session process AND is either
 * registered or attached to a terminal. The tty requirement is what keeps the
 * daemon's helpers out: they are `claude` binaries too, but nothing a person
 * is typing into. VS Code sessions have no tty but are always registered.
 */
export const joinLiveSessions = (
  procs: ClaudeProcess[],
  regs: SessionRegistration[],
  now = Date.now(),
): LiveSessionsReport => {
  const byPid = new Map<number, ClaudeProcess>();
  for (const p of procs) byPid.set(p.pid, p);
  const regByPid = new Map<number, SessionRegistration>();
  for (const r of regs) regByPid.set(r.pid, r);

  const live: LiveSession[] = [];
  for (const p of procs) {
    if (!isSessionProcess(p)) continue;
    const reg = regByPid.get(p.pid);
    if (!reg && p.tty === null) continue;
    live.push({
      pid: p.pid,
      sessionId: reg?.sessionId ?? sessionIdFromArgs(p.args),
      cwd: reg?.cwd ?? null,
      rssKb: p.rssKb,
      tty: p.tty,
      uptimeSec: p.uptimeSec,
      registered: !!reg,
      entrypoint: reg?.entrypoint,
      accountLabel: reg?.accountLabel,
      accountIsAnchor: reg?.accountIsAnchor,
    });
  }
  live.sort((a, b) => b.rssKb - a.rssKb);

  const staleRegistrations = regs
    .filter((r) => !byPid.has(r.pid))
    .map((r) => ({ pid: r.pid, sessionId: r.sessionId, cwd: r.cwd }));

  return {
    live,
    staleRegistrations,
    totalRssKb: live.reduce((sum, s) => sum + s.rssKb, 0),
    measuredAt: now,
  };
};

/** Every account's `sessions/<pid>.json`, as written by Claude Code. */
export const readSessionRegistrations = (): SessionRegistration[] => {
  const regs: SessionRegistration[] = [];
  for (const account of getScannableAccounts()) {
    const dir = path.join(account.dir, 'sessions');
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
        if (
          typeof data?.pid !== 'number' ||
          typeof data?.sessionId !== 'string'
        ) {
          continue;
        }
        // The filename is the pid Claude Code keys the registration by. A
        // body that names a different pid is a file that does not describe
        // the process it is filed under — skip it rather than attribute a
        // live process to the wrong session.
        if (data.pid !== Number(file.slice(0, -5))) continue;
        regs.push({
          pid: data.pid,
          sessionId: data.sessionId,
          cwd: typeof data.cwd === 'string' ? data.cwd : '',
          entrypoint:
            typeof data.entrypoint === 'string' ? data.entrypoint : 'cli',
          accountLabel: account.label,
          accountDir: account.dir,
          accountIsAnchor: account.isAnchor,
        });
      } catch {
        // one unreadable registration must not hide the others
      }
    }
  }
  return regs;
};

const execFileP = (
  file: string,
  args: string[],
  timeout: number,
): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: 'utf-8', timeout, maxBuffer: 4 * 1024 * 1024 },
      (err: unknown, stdout: string) => resolve(err ? '' : stdout || ''),
    );
  });

/**
 * `ps -A` on a machine deep in swap took 250–500ms in measurement and can
 * exceed a short timeout right after the app returns from the background —
 * and a timed-out `ps` looks exactly like "no processes at all", which the
 * join would then report as every session dead and every registration stale
 * (seen live as "● 0 live ⚠33"). Generous timeout, and an empty result is
 * treated as a failure, never as an answer.
 */
const PS_TIMEOUT_MS = 15000;

/** Working directory of one process, for the unregistered ones only. */
const lsofCwd = async (pid: number): Promise<string | null> => {
  const out = await execFileP(
    'lsof',
    ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
    2000,
  );
  const m = out.match(/^n(.+)$/m);
  return m ? m[1] : null;
};

export interface CollectDeps {
  ps?: () => Promise<string>;
  readRegistrations?: () => SessionRegistration[];
  cwdOf?: (pid: number) => Promise<string | null>;
}

export const collectLiveSessions = async (
  deps: CollectDeps = {},
): Promise<LiveSessionsReport> => {
  const ps =
    deps.ps ??
    (() =>
      execFileP('ps', ['-Ao', 'pid=,rss=,tty=,etime=,args='], PS_TIMEOUT_MS));
  const readRegs = deps.readRegistrations ?? readSessionRegistrations;
  const cwdOf = deps.cwdOf ?? lsofCwd;

  const procs = parsePsOutput(await ps());
  // A process table is never empty — `ps` lists at least itself — so an empty
  // parse means the call failed or timed out. Report that rather than a
  // fabricated "nothing is running".
  if (procs.length === 0) throw new Error('ps returned no processes');
  const report = joinLiveSessions(procs, readRegs());
  // `lsof` costs a spawn per process, so only the unregistered ones pay it —
  // a handful at most, and without a cwd their row would name nothing.
  await Promise.all(
    report.live
      .filter((s) => !s.registered && !s.cwd)
      .map(async (s) => {
        s.cwd = await cwdOf(s.pid);
      }),
  );
  return report;
};
