/**
 * "Which session am I?" — for a command run from inside a Claude Code session
 * (`codev session self`).
 *
 * What exists to go on, checked on Claude Code 2.1.329 on 2026-11-20:
 *
 * - every running session writes `<config dir>/sessions/<its pid>.json`
 *   (`pid`, `sessionId`, `cwd`, `procStart`, `name`, `status`, …) under ITS
 *   OWN account's config dir, so the directory the file is in names the
 *   account. `procStart` is the process start as `ps -o lstart=` prints it in
 *   UTC — an exact match proves the file belongs to the process now holding
 *   that pid, not to an earlier one that had the same number;
 * - a child process of the session also gets `CLAUDE_CODE_SESSION_ID` in its
 *   environment. It says nothing about the account, and whether it follows a
 *   `/branch` (which gives the same process a new session id) was not tested.
 *
 * So the registration is the answer and the environment variable a second
 * opinion: walk up from this process, and the nearest ancestor that owns a
 * registration is the session. Nothing here guesses — a registration that
 * cannot be tied to its process is not used, and two that both can are a
 * refusal.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { IdentityAccount, isSessionId } from './session-identity';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** `ps -o lstart=` under TZ=UTC, whitespace-normalised. */
  startUtc: string;
  /** Executable path or name. */
  command: string;
}

export interface Registration {
  pid: number;
  sessionId: string;
  cwd: string;
  /** '' when the file has none (older Claude Code). */
  procStart: string;
  /** The session's name as Claude Code itself holds it; '' when unnamed. */
  name: string;
  status: string;
  /** `interactive`, …; '' when the file has none. */
  kind: string;
  /** Epoch ms; 0 when the file has none. */
  startedAt: number;
  /** Epoch ms of the registration's last write; 0 when the file has none. */
  updatedAt: number;
  accountLabel: string;
  accountDir: string;
}

/** How a registration was tied to the ancestor process. */
export type SelfProof = 'process-start' | 'environment';

export type SelfResult =
  | {
      ok: true;
      registration: Registration;
      proof: SelfProof;
      /** null when the environment carries no session id. */
      environmentAgrees: boolean | null;
    }
  | { ok: false; reason: 'not-in-session' | 'ambiguous'; detail: string };

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Why this registration may be trusted for this process, or null. Pure. */
export const proofFor = (
  reg: Registration,
  proc: ProcessInfo,
  envSessionId: string | undefined,
): SelfProof | null => {
  if (reg.procStart) {
    // The file states a start time: it either matches or it is someone else's.
    return squash(reg.procStart) === squash(proc.startUtc)
      ? 'process-start'
      : null;
  }
  // An older registration has no start time. The process being called
  // `claude` proves nothing — a leftover file of an earlier process whose pid
  // a NEW claude now holds would pass that test and name the wrong session.
  // Only the environment naming the same session ties it to this process.
  if (envSessionId && reg.sessionId === envSessionId) return 'environment';
  return null;
};

/**
 * Pick the session from the ancestor chain (nearest first). Pure: the
 * registrations for a pid come from `registrationsFor`.
 */
export const resolveSelf = (
  ancestors: ProcessInfo[],
  registrationsFor: (pid: number) => Registration[],
  envSessionId?: string,
): SelfResult => {
  for (const proc of ancestors) {
    const proven = registrationsFor(proc.pid)
      .map((reg) => ({ reg, proof: proofFor(reg, proc, envSessionId) }))
      .filter((x): x is { reg: Registration; proof: SelfProof } => !!x.proof);
    if (proven.length === 0) continue;
    // One pid registered under two accounts: at most one can be live. The
    // environment may say which; otherwise nobody can.
    let chosen = proven;
    if (proven.length > 1) {
      chosen = proven.filter((x) => x.reg.sessionId === envSessionId);
      if (chosen.length !== 1) {
        return {
          ok: false,
          reason: 'ambiguous',
          detail: `process ${proc.pid} is registered as a session under ${proven.length} accounts (${proven.map((x) => x.reg.accountLabel).join(', ')})`,
        };
      }
    }
    return {
      ok: true,
      registration: chosen[0].reg,
      proof: chosen[0].proof,
      environmentAgrees: envSessionId
        ? chosen[0].reg.sessionId === envSessionId
        : null,
    };
  }
  return {
    ok: false,
    reason: 'not-in-session',
    detail:
      'no parent process is a registered Claude Code session — run this from inside one',
  };
};

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** Parse one `ps -o pid=,ppid=,lstart=,comm=` line. Pure. */
export const parsePsLine = (line: string): ProcessInfo | null => {
  // pid ppid Dow Mon DD HH:MM:SS YYYY command…
  const m = line.match(
    /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+?)\s*$/,
  );
  if (!m) return null;
  return {
    pid: Number(m[1]),
    ppid: Number(m[2]),
    startUtc: squash(m[3]),
    command: m[4],
  };
};

/** This process's ancestors, nearest first (the parent, its parent, …). */
export const readAncestors = (fromPid = process.ppid): ProcessInfo[] => {
  const out: ProcessInfo[] = [];
  let pid = fromPid;
  // 32 levels is far beyond any real chain; the cap only stops a loop.
  for (let i = 0; i < 32 && pid > 1; i++) {
    let line: string;
    try {
      line = execFileSync(
        'ps',
        ['-o', 'pid=,ppid=,lstart=,comm=', '-p', String(pid)],
        {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          // The registration's procStart is UTC, in the C locale's format.
          env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
        },
      );
    } catch {
      break; // the process is gone
    }
    const info = parsePsLine(line.split('\n')[0] || '');
    if (!info) break;
    out.push(info);
    pid = info.ppid;
  }
  return out;
};

/** One parsed `sessions/<pid>.json`, or null when it is not a session's. Pure. */
export const registrationFrom = (
  raw: unknown,
  pid: number,
  account: IdentityAccount,
): Registration | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // A file that names no session (only a peer token, seen on 2.1.329) or
  // another pid than its own file name is not a registration.
  if (r.pid !== pid || !isSessionId(r.sessionId)) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return {
    pid,
    sessionId: r.sessionId,
    cwd: str(r.cwd),
    procStart: str(r.procStart),
    name: str(r.name),
    status: str(r.status),
    kind: str(r.kind),
    startedAt: num(r.startedAt),
    updatedAt: num(r.updatedAt),
    accountLabel: account.label,
    accountDir: account.dir,
  };
};

const readRegistrationFile = (
  account: IdentityAccount,
  pid: number,
): Registration | null => {
  try {
    return registrationFrom(
      JSON.parse(
        fs.readFileSync(
          path.join(account.dir, 'sessions', `${pid}.json`),
          'utf-8',
        ),
      ),
      pid,
      account,
    );
  } catch {
    return null; // no file for this pid under this account, or not JSON
  }
};

/** `sessions/<pid>.json` of every account that has one for this pid. */
export const readRegistrations = (
  accounts: IdentityAccount[],
  pid: number,
): Registration[] =>
  accounts
    .map((account) => readRegistrationFile(account, pid))
    .filter((r): r is Registration => r !== null);

/**
 * Every `sessions/<pid>.json` of every account — running or not: Claude Code
 * leaves the file of a process that died without cleaning up. `isLive` says
 * which are running.
 */
export const readAllRegistrations = (
  accounts: IdentityAccount[],
): Registration[] => {
  const out: Registration[] = [];
  for (const account of accounts) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(account.dir, 'sessions'));
    } catch {
      continue; // an account that never ran a session has no directory
    }
    for (const name of names) {
      const m = name.match(/^(\d+)\.json$/);
      if (!m) continue;
      const reg = readRegistrationFile(account, Number(m[1]));
      if (reg) out.push(reg);
    }
  }
  return out;
};

/**
 * The given processes as `ps` sees them now, keyed by pid; a pid that is not
 * running is absent. One `ps` call for all of them.
 */
export const readProcesses = (pids: number[]): Map<number, ProcessInfo> => {
  const found = new Map<number, ProcessInfo>();
  if (pids.length === 0) return found;
  const ps = (list: number[]): { text: string; failed: boolean } => {
    try {
      return {
        text: execFileSync(
          'ps',
          ['-o', 'pid=,ppid=,lstart=,comm=', '-p', list.join(',')],
          {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
          },
        ),
        failed: false,
      };
    } catch (e) {
      // `ps` exits 1 when a pid is not running, and still prints the others.
      return { text: String((e as { stdout?: unknown }).stdout ?? ''), failed: true };
    }
  };
  let { text, failed } = ps(pids);
  // A pid macOS cannot have (`process id too large`) fails the WHOLE call
  // with nothing printed: ask one pid at a time rather than report every
  // session as stopped because of one odd file name.
  if (failed && !text.trim() && pids.length > 1) {
    text = pids.map((pid) => ps([pid]).text).join('\n');
  }
  for (const line of text.split('\n')) {
    const info = parsePsLine(line);
    if (info) found.set(info.pid, info);
  }
  return found;
};

/**
 * Is the process this registration describes still running? Pure.
 *
 * The pid being alive is not enough: pids are reused, and a leftover file of
 * a dead session would then pass for a running one. The registration's
 * `procStart` must match the process's start exactly. An older file without
 * one is NOT counted: the process being a `claude` executable proves nothing
 * when another session may hold the reused pid — the same rule as `proofFor`,
 * which `self` can still satisfy through the environment.
 */
export const isLive = (
  reg: Registration,
  proc: ProcessInfo | undefined,
): boolean => {
  if (!proc || proc.pid !== reg.pid) return false;
  return !!reg.procStart && squash(reg.procStart) === squash(proc.startUtc);
};

/** The registrations whose process is running now. */
export const liveRegistrations = (
  accounts: IdentityAccount[],
  processes: (pids: number[]) => Map<number, ProcessInfo> = readProcesses,
): Registration[] => {
  const all = readAllRegistrations(accounts);
  const procs = processes([...new Set(all.map((r) => r.pid))]);
  return all.filter((r) => isLive(r, procs.get(r.pid)));
};
