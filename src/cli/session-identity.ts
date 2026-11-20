/**
 * Session identity: the handful of facts that name one Claude Code session —
 * title, full id, account, project path, transcript path, resume command.
 *
 * ONE implementation, two consumers: CodeV's main process (the Sessions tab's
 * copy menu and detail view) and the `codev session` CLI. It lives under
 * `src/cli/` and imports nothing from Electron (only fs, path and its
 * siblings `memory-dir` and `session-identity-fields`), because the CLI is
 * compiled on its own with `tsc` and run through the app binary as plain Node.
 *
 * Where a transcript lives — measured 2026-11-20 on a two-account machine
 * (363 transcripts), NOT inherited from the memory rule in `memory-dir.ts`:
 *
 * - `projects/<slug>/<sessionId>.jsonl`, where the slug is the session's own
 *   working directory with every non-alphanumeric UTF-16 unit turned into `-`.
 *   Auto-MEMORY is keyed on the git common dir's parent; transcripts are not.
 *   2 of 2 sessions started in a repository subdirectory and 18 of 18
 *   non-fork sessions started in a linked worktree sat under their own cwd's
 *   slug — none under the main repository's.
 * - The 17 transcripts that were NOT under the slug of the first `cwd` they
 *   record were all `/branch` forks: a fork copies its parent's records, so
 *   its first `cwd` is the parent's. The file sits where the fork was made.
 * - `history.jsonl`'s `project` named the transcript's directory for 280 of
 *   280 sessions that still had a transcript, so the history project is the
 *   right key and the cwd slug the right first guess.
 *
 * The lookup below still checks the file exists instead of trusting the rule,
 * and — for reading, not for resuming — falls back to looking in every slug
 * directory, which covers what the sample could not: a project path that has
 * since become a symlink, or a slug Claude Code shortened.
 */
import * as fs from 'fs';
import * as path from 'path';

import { memorySettingsArg } from './memory-dir';
import {
  formatReference,
  matchesSessionId,
  SessionIdentity,
  TitleKind,
} from './session-identity-fields';

export * from './session-identity-fields';

// ---------------------------------------------------------------------------
// Accounts and history
// ---------------------------------------------------------------------------

/** What this module needs to know about an account (a `CodevAccount` fits). */
export interface IdentityAccount {
  label: string;
  /** Config dir: `history.jsonl` and `projects/` live here. */
  dir: string;
  /** CLAUDE_CONFIG_DIR at launch; null for the anchor (`~/.claude`) account. */
  configDirEnv: string | null;
  isAnchor: boolean;
  shareMemoryWithAnchor?: boolean;
}

/** One session as `history.jsonl` knows it, tagged with its account. */
export interface HistorySession {
  sessionId: string;
  project: string;
  firstDisplay: string;
  lastDisplay: string;
  firstTimestamp: number;
  lastTimestamp: number;
  promptCount: number;
  accountLabel: string;
  accountDir: string;
  accountConfigDirEnv: string | null;
  accountIsAnchor: boolean;
}

export interface HistoryScan {
  /** Insertion order = first appearance; callers sort. */
  sessions: Map<string, HistorySession>;
  /** Every prompt of a session, in file order. */
  prompts: Map<string, string[]>;
  /** Epoch ms per prompt, parallel to `prompts`. */
  promptTimes: Map<string, number[]>;
}

interface HistoryLine {
  sessionId?: string;
  display?: string;
  timestamp?: number;
  project?: string;
}

/** Fold one account's `history.jsonl` text into the scan. Pure. */
export const foldHistoryText = (
  scan: HistoryScan,
  content: string,
  account: IdentityAccount,
): void => {
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let raw: HistoryLine;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // skip malformed lines
    }
    if (!raw || !raw.sessionId) continue;

    if (raw.display) {
      const list = scan.prompts.get(raw.sessionId);
      if (list) list.push(raw.display);
      else scan.prompts.set(raw.sessionId, [raw.display]);
      const times = scan.promptTimes.get(raw.sessionId);
      const at = typeof raw.timestamp === 'number' ? raw.timestamp : 0;
      if (times) times.push(at);
      else scan.promptTimes.set(raw.sessionId, [at]);
    }

    const existing = scan.sessions.get(raw.sessionId);
    if (existing) {
      existing.promptCount++;
      if (raw.timestamp && raw.timestamp > existing.lastTimestamp) {
        existing.lastTimestamp = raw.timestamp;
        existing.lastDisplay = raw.display || existing.lastDisplay;
      }
      if (raw.timestamp && raw.timestamp < existing.firstTimestamp) {
        existing.firstDisplay = raw.display || existing.firstDisplay;
        existing.firstTimestamp = raw.timestamp;
      }
    } else {
      scan.sessions.set(raw.sessionId, {
        sessionId: raw.sessionId,
        project: raw.project || '',
        firstDisplay: raw.display || '',
        lastDisplay: raw.display || '',
        firstTimestamp: raw.timestamp || 0,
        lastTimestamp: raw.timestamp || 0,
        promptCount: 1,
        accountLabel: account.label,
        accountDir: account.dir,
        accountConfigDirEnv: account.configDirEnv,
        accountIsAnchor: account.isAnchor,
      });
    }
  }
};

/**
 * Read every account's `history.jsonl` and merge. Session ids are UUIDs, so
 * there is no cross-account dedupe. One unreadable history must not hide the
 * sessions of every other account, hence the per-account catch.
 */
export const scanHistories = (
  accounts: IdentityAccount[],
  onError: (label: string, error: unknown) => void = () => undefined,
): HistoryScan => {
  const scan: HistoryScan = {
    sessions: new Map(),
    prompts: new Map(),
    promptTimes: new Map(),
  };
  for (const account of accounts) {
    try {
      const historyPath = path.join(account.dir, 'history.jsonl');
      if (!fs.existsSync(historyPath)) continue;
      foldHistoryText(scan, fs.readFileSync(historyPath, 'utf-8'), account);
    } catch (error) {
      onError(account.label, error);
    }
  }
  return scan;
};

// ---------------------------------------------------------------------------
// Transcript location
// ---------------------------------------------------------------------------

/** A session id safe to put in a file name and in a shell command. */
export const isSessionId = (id: unknown): id is string =>
  typeof id === 'string' && /^[0-9a-f][0-9a-f-]*$/i.test(id);

/** Directory path → the `projects/` directory name its transcripts use. */
export const transcriptSlug = (dir: string): string =>
  dir.replace(/[^a-zA-Z0-9]/g, '-');

const realPathOrSelf = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * The slug directories worth trying for a project path, best first: the path
 * as recorded, then its symlink-resolved form (Claude Code keys on the
 * physical cwd). `resolve` is injectable so the rule is testable without a
 * real symlink.
 */
export const transcriptSlugCandidates = (
  project: string,
  resolve: (p: string) => string = realPathOrSelf,
): string[] => {
  if (!project) return [];
  const out = [transcriptSlug(project)];
  const physical = transcriptSlug(resolve(project));
  if (!out.includes(physical)) out.push(physical);
  return out;
};

export interface TranscriptLocation {
  path: string;
  /** The account config dir it was found under. */
  accountDir: string;
  /**
   * True when it was NOT under the project's own slug — found only by looking
   * in every slug directory. Readable, but `claude --resume` run from the
   * project path may not find it.
   */
  outsideProjectSlug: boolean;
}

/**
 * Which slug directories of an account hold a given session's transcript —
 * read once per account (one `readdir` per slug directory) and then answered
 * from memory. The fallback below needs it for EVERY session that is not
 * under its own slug, and most of those have no transcript at all (552 of 832
 * history sessions on the reference machine), so asking the disk per session
 * would be hundreds of directory walks that all come back empty.
 */
export interface TranscriptIndex {
  slugsFor: (accountDir: string, sessionId: string) => string[];
}

export const createTranscriptIndex = (): TranscriptIndex => {
  const byAccount = new Map<string, Map<string, string[]>>();
  const read = (accountDir: string): Map<string, string[]> => {
    const ids = new Map<string, string[]>();
    const projects = path.join(accountDir, 'projects');
    let slugs: string[] = [];
    try {
      slugs = fs.readdirSync(projects);
    } catch {
      // No projects/ under this account: nothing to index.
    }
    for (const slug of slugs) {
      let files: string[];
      try {
        files = fs.readdirSync(path.join(projects, slug));
      } catch {
        continue; // not a directory
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const id = f.slice(0, -'.jsonl'.length);
        const at = ids.get(id);
        if (at) at.push(slug);
        else ids.set(id, [slug]);
      }
    }
    return ids;
  };
  return {
    slugsFor: (accountDir, sessionId) => {
      let ids = byAccount.get(accountDir);
      if (!ids) {
        ids = read(accountDir);
        byAccount.set(accountDir, ids);
      }
      return ids.get(sessionId) ?? [];
    },
  };
};

/**
 * Find `<sessionId>.jsonl`. `accountDirs` is tried in order, so put the
 * account the session is known by first. With `scanAllSlugs`, a miss on the
 * project's own slugs falls back to every directory under `projects/` — pass
 * a `TranscriptIndex` there instead of `true` when locating many sessions, so
 * the directories are read once.
 */
export const locateTranscript = (
  accountDirs: string[],
  project: string,
  sessionId: string,
  opts: { scanAllSlugs?: boolean | TranscriptIndex } = {},
): TranscriptLocation | null => {
  if (!isSessionId(sessionId)) return null;
  const file = `${sessionId}.jsonl`;
  const dirs = [...new Set(accountDirs.filter(Boolean))];
  const slugs = transcriptSlugCandidates(project);
  for (const accountDir of dirs) {
    for (const slug of slugs) {
      const p = path.join(accountDir, 'projects', slug, file);
      if (fs.existsSync(p)) {
        return { path: p, accountDir, outsideProjectSlug: false };
      }
    }
  }
  if (!opts.scanAllSlugs) return null;
  const index =
    opts.scanAllSlugs === true ? createTranscriptIndex() : opts.scanAllSlugs;
  for (const accountDir of dirs) {
    for (const slug of index.slugsFor(accountDir, sessionId)) {
      if (slugs.includes(slug)) continue;
      // The index is a snapshot and may be kept for a while: a file it lists
      // can have been deleted or moved since. Never return one that is gone.
      const p = path.join(accountDir, 'projects', slug, file);
      if (!fs.existsSync(p)) continue;
      return { path: p, accountDir, outsideProjectSlug: true };
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

export interface SessionTitle {
  title: string;
  kind: TitleKind;
}

export const NO_TITLE: SessionTitle = { title: '', kind: 'none' };

export const CUSTOM_TITLE_MARKER = '"type":"custom-title"';
export const AI_TITLE_MARKER = '"type":"ai-title"';

const parseJson = (line: string | undefined): Record<string, unknown> => {
  if (!line) return {};
  try {
    const o = JSON.parse(line);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
};

/**
 * The title from a transcript's LAST `custom-title` record and LAST `ai-title`
 * record (either may be missing). Custom wins; an empty custom title falls
 * through to the generated one.
 */
export const titleFromRecords = (
  lastCustomTitleLine?: string,
  lastAiTitleLine?: string,
): SessionTitle => {
  const custom = String(parseJson(lastCustomTitleLine).customTitle || '')
    .replace(/^"|"$/g, '')
    .trim();
  if (custom) return { title: custom, kind: 'custom' };
  const ai = String(parseJson(lastAiTitleLine).aiTitle || '').trim();
  if (ai) return { title: ai, kind: 'ai' };
  return NO_TITLE;
};

const TITLE_SCAN_CHUNK = 4 * 1024 * 1024;
// A title record is a few hundred bytes; this much either side of a marker
// always holds the whole line.
const TITLE_LINE_REACH = 8192;

/** The whole line around byte `pos`, or null when it is longer than a title record can be. */
const lineAround = (fd: number, size: number, pos: number): string | null => {
  const from = Math.max(0, pos - TITLE_LINE_REACH);
  const to = Math.min(size, pos + TITLE_LINE_REACH);
  const buf = Buffer.alloc(to - from);
  // Cast: this repo's @types/node and TS lib disagree on Buffer vs Uint8Array.
  fs.readSync(fd, buf as unknown as Uint8Array, 0, buf.length, from);
  const rel = pos - from;
  const start = buf.lastIndexOf(10, rel);
  const end = buf.indexOf(10, rel);
  if ((start < 0 && from > 0) || (end < 0 && to < size)) return null;
  return buf.toString('utf-8', start + 1, end < 0 ? buf.length : end);
};

/**
 * A transcript's title, read by scanning BACK from the end of the file.
 *
 * Claude Code re-writes the `custom-title` record as a session goes on (one
 * 255 MB transcript carried 2,727 of them), so the last one is almost always
 * in the final chunk and the read stops there. Only a session that was never
 * renamed is read to its start, which is what proves there is no custom title
 * in front of a generated one.
 *
 * Why not `grep`: measured 2026-11-20, macOS's own `/usr/bin/grep` needs
 * ~1.5 s per 255 MB and 40 s for 200 transcripts, where this takes ~0.55 s
 * for all 363 (5.3 GB). A candidate is only accepted once its whole line
 * parses as a record of that type — the marker also occurs, unescaped, inside
 * longer records that merely embed one.
 */
export const readTranscriptTitle = (
  file: string,
  chunkBytes = TITLE_SCAN_CHUNK,
): SessionTitle => {
  // Each chunk is read a little past its end, so a marker cut by the chunk
  // boundary is still seen whole by the chunk in front of it.
  const overlap = Math.max(CUSTOM_TITLE_MARKER.length, AI_TITLE_MARKER.length);
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return NO_TITLE;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.allocUnsafe(chunkBytes + overlap);
    /** Last line in `view` that really is a record of this type. */
    const lastRecord = (
      view: Buffer,
      viewStart: number,
      marker: string,
      type: string,
    ): string | undefined => {
      let p = view.lastIndexOf(marker);
      while (p >= 0) {
        const line = lineAround(fd, size, viewStart + p);
        if (line && parseJson(line).type === type) return line;
        p = p > 0 ? view.lastIndexOf(marker, p - 1) : -1;
      }
      return undefined;
    };
    // The LAST record of each type decides, exactly as `titleFromRecords`
    // says: an empty last custom title falls through to the generated one —
    // an earlier, non-empty custom title does not come back.
    let customLine: string | undefined;
    let aiLine: string | undefined;
    for (let end = size; end > 0; ) {
      const start = Math.max(0, end - chunkBytes);
      const len = Math.min(size, end + overlap) - start;
      fs.readSync(fd, buf as unknown as Uint8Array, 0, len, start);
      const view = buf.subarray(0, len);
      customLine ??= lastRecord(view, start, CUSTOM_TITLE_MARKER, 'custom-title');
      if (customLine && titleFromRecords(customLine).kind === 'custom') break;
      aiLine ??= lastRecord(view, start, AI_TITLE_MARKER, 'ai-title');
      if (customLine && aiLine) break;
      end = start;
    }
    return titleFromRecords(customLine, aiLine);
  } catch {
    return NO_TITLE;
  } finally {
    fs.closeSync(fd);
  }
};

/** Titles for a set of transcripts; a file without one is absent from the result. */
export const readTranscriptTitles = (
  files: string[],
): Map<string, SessionTitle> => {
  const titles = new Map<string, SessionTitle>();
  for (const file of files) {
    const t = readTranscriptTitle(file);
    if (t.kind !== 'none') titles.set(file, t);
  }
  return titles;
};

// ---------------------------------------------------------------------------
// Matching a query (a title, or the start of an id) to sessions
// ---------------------------------------------------------------------------

export interface Matchable {
  sessionId: string;
  title: string;
}

/** A query that can only be an id: it is one, in full. */
export const isFullSessionId = (q: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    q.trim(),
  );

/**
 * Every session the query could mean. Never picks among them:
 *
 * - a full id matches that one session and nothing else;
 * - otherwise the result is the UNION of sessions whose id starts with the
 *   query (`matchesSessionId`: four or more hex characters, the same rule as
 *   the Sessions tab's search — `1` is not an id prefix) and sessions whose
 *   title equals it, ignoring case — a title can look like hex, so neither
 *   reading is dropped;
 * - only when both are empty does a title that merely CONTAINS the query
 *   count, so typing part of a name still finds it.
 *
 * Titles are not unique (`/branch` siblings share theirs), so more than one
 * result is normal; `pickOne` is what refuses to choose.
 */
export const matchSessions = <T extends Matchable>(
  query: string,
  sessions: T[],
): T[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  if (isFullSessionId(q)) {
    return sessions.filter((s) => s.sessionId.toLowerCase() === q);
  }
  const strong = sessions.filter(
    (s) =>
      matchesSessionId(s.sessionId, q) || s.title.trim().toLowerCase() === q,
  );
  if (strong.length > 0) return strong;
  return sessions.filter((s) => s.title.toLowerCase().includes(q));
};

export type Picked<T> =
  | { ok: true; session: T }
  | { ok: false; reason: 'none' | 'ambiguous'; matches: T[] };

/** Exactly one match, or a refusal — the guard in front of `resume`. */
export const pickOne = <T>(matches: T[]): Picked<T> => {
  if (matches.length === 1) return { ok: true, session: matches[0] };
  return {
    ok: false,
    reason: matches.length === 0 ? 'none' : 'ambiguous',
    matches,
  };
};

// ---------------------------------------------------------------------------
// Resume command
// ---------------------------------------------------------------------------

/** POSIX single-quoting: safe for any byte, in every shell and terminal. */
export const shellQuote = (s: string): string =>
  `'${s.replace(/'/g, "'\\''")}'`;

/**
 * ` --settings <file>` when this account shares the anchor's auto-memory, else
 * ''. Anchor accounts get nothing: their memory IS the shared copy. Writes the
 * per-project settings file as a side effect (see `memorySettingsArg`).
 */
export const memoryArgFor = (
  account: IdentityAccount | undefined,
  anchorDir: string,
  projectPath: string,
): string =>
  account && !account.isAnchor && account.shareMemoryWithAnchor && projectPath
    ? memorySettingsArg(anchorDir, projectPath)
    : '';

/**
 * The command that resumes a session under its own account:
 * - another account: `CLAUDE_CONFIG_DIR='<dir>' command claude --resume <id>`
 * - the anchor: `env -u CLAUDE_CONFIG_DIR claude --resume <id>`
 * The single place this command is spelled; CodeV's `buildResumeCommand` and
 * the CLI both end here.
 */
export const formatResumeCommand = (
  sessionId: string,
  configDirEnv: string | null | undefined,
  memoryArg = '',
): string => {
  // Both forms bypass the accounts.sh `claude` dispatcher. The exact account
  // is already resolved, so the shell must NOT re-route a bare `claude` to a
  // configured non-default global-default (§2e) — that would resume an
  // anchor-account session under the wrong account.
  if (!configDirEnv) {
    // The anchor is "CLAUDE_CONFIG_DIR unset", never an explicit ~/.claude
    // (that reads ~/.claude/.claude.json and looks logged out — design doc
    // §3.4). Unset it rather than leave it alone: a shell started inside
    // another account's session inherits that account's value, and Claude
    // Code would then look there and report "No conversation found" (#172).
    // `env` runs the binary from PATH, so it skips the dispatcher function
    // as `command` does; it is how the dispatcher itself launches the anchor.
    return `env -u CLAUDE_CONFIG_DIR claude${memoryArg} --resume ${sessionId}`;
  }
  // Single-quote the value: some terminal injections (Ghostty `initial input`)
  // don't escape the command, so a double-quoted prefix would break their
  // AppleScript string. Single quotes are safe across all terminals + handle
  // spaces; a quote inside the path (/Users/O'Brien/…) becomes '\''.
  // `command claude`: every consumer runs the string through a shell, so the
  // builtin is available.
  return `CLAUDE_CONFIG_DIR=${shellQuote(configDirEnv)} command claude${memoryArg} --resume ${sessionId}`;
};

/**
 * The line a person pastes into ANY terminal: go to the project, then resume.
 * The path is single-quoted, so a space, `$`, a quote or a backtick in it
 * cannot change what the line does. No project → no `cd`.
 */
export const cdAndResume = (
  projectPath: string,
  resumeCommand: string,
): string =>
  projectPath
    ? `cd ${shellQuote(projectPath)} && ${resumeCommand}`
    : resumeCommand;

// ---------------------------------------------------------------------------
// The identity itself
// ---------------------------------------------------------------------------

export interface IdentityInput {
  sessionId: string;
  project: string;
  /** The account the session belongs to, when known. */
  account: IdentityAccount | undefined;
  /** Shown when `account` is unknown. */
  accountLabel?: string;
  /** Config dirs to look for the transcript in, best first. */
  accountDirs: string[];
  /** Title already known, or a reader given the transcript path. */
  title: SessionTitle | ((transcriptPath: string) => SessionTitle);
  /**
   * Used when the transcript carries no title (or is gone). Reported with
   * kind `unknown`: whoever captured it may have captured a generated title.
   */
  fallbackTitle?: string;
  /** Reuse one index when resolving many sessions. */
  transcriptIndex?: TranscriptIndex;
  /** The inner resume command; defaults to `formatResumeCommand`. */
  resumeCommand?: string;
  anchorDir: string;
}

/** Assemble the identity. The only I/O is the transcript lookup and `title`. */
export const resolveSessionIdentity = (input: IdentityInput): SessionIdentity => {
  const { sessionId, project, account } = input;
  const found = locateTranscript(input.accountDirs, project, sessionId, {
    scanAllSlugs: input.transcriptIndex ?? true,
  });
  let title =
    typeof input.title === 'function'
      ? found
        ? input.title(found.path)
        : NO_TITLE
      : input.title;
  if (title.kind === 'none' && input.fallbackTitle?.trim()) {
    // The row or a saved list captured it; whether it was a /rename name or
    // a generated title is no longer knowable, so it is not called either.
    title = { title: input.fallbackTitle.trim(), kind: 'unknown' };
  }
  const inner = !isSessionId(sessionId)
    ? ''
    : (input.resumeCommand ??
      formatResumeCommand(
        sessionId,
        account?.configDirEnv ?? null,
        memoryArgFor(account, input.anchorDir, project),
      ));
  return {
    title: title.title,
    titleKind: title.kind,
    sessionId,
    account: account?.label ?? input.accountLabel ?? '',
    projectPath: project,
    transcriptPath: found ? found.path : null,
    transcriptOutsideProjectSlug: !!found?.outsideProjectSlug,
    resumeCommand: inner ? cdAndResume(project, inner) : '',
    reference: formatReference(title.title, sessionId),
  };
};
