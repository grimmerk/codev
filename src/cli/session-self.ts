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

/** `sessions/<pid>.json` of every account that has one for this pid. */
export const readRegistrations = (
  accounts: IdentityAccount[],
  pid: number,
): Registration[] => {
  const out: Registration[] = [];
  for (const account of accounts) {
    try {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(account.dir, 'sessions', `${pid}.json`),
          'utf-8',
        ),
      );
      if (!raw || raw.pid !== pid || !isSessionId(raw.sessionId)) continue;
      out.push({
        pid,
        sessionId: raw.sessionId,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        procStart: typeof raw.procStart === 'string' ? raw.procStart : '',
        name: typeof raw.name === 'string' ? raw.name : '',
        status: typeof raw.status === 'string' ? raw.status : '',
        accountLabel: account.label,
        accountDir: account.dir,
      });
    } catch {
      // No file for this pid under this account, or not JSON.
    }
  }
  return out;
};
