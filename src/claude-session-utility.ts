/**
 * Claude Code session history reader
 * Primary source: ~/.claude/history.jsonl (real-time, append-only log)
 * Fallback enrichment: ~/.claude/cache/session-metadata.db (cached metadata)
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getCurrentIDEBundleId } from './vscode-based-ide-utility';
import {
  CodevAccount,
  getAccounts,
  getScannableAccounts,
  getProjectsDir,
  getAccountByLabel,
} from './accounts';
import {
  compileQuery,
  findPromptMatch,
  isEmptyQuery,
  parseQuery,
  PromptMatch,
  promptNeedles,
  sessionRepos,
} from './session-search';
import {
  EnrichmentState,
  getEnrichmentCachePath,
  minePrRefs,
  readEnrichmentCacheFile,
  writeEnrichmentCacheFile,
} from './enrichment-cache';
import { readSessionRegistrations } from './live-sessions';

export interface ClaudeSession {
  sessionId: string;
  project: string;         // full path, e.g. /Users/grimmer/git/fred-ff
  projectName: string;     // folder name, e.g. fred-ff
  firstUserMessage: string;
  lastUserMessage: string;
  lastAssistantMessage?: string; // only loaded for active sessions
  lastTimestamp: number;    // unix ms
  messageCount: number;
  isActive: boolean;       // whether a claude process is running for this session
  activePid?: number;
  terminalApp?: string;    // detected terminal: 'iterm2', 'cmux', 'ghostty', 'vscode', etc.
  entrypoint?: string;     // 'cli', 'claude-vscode', etc.
  accountLabel?: string; // codev multi-account: which account this session belongs to
  accountDir?: string; // that account's config dir (session data + enrichment root)
  accountConfigDirEnv?: string | null; // CLAUDE_CONFIG_DIR to set at resume (null = default)
  accountIsAnchor?: boolean; // anchor (~/.claude) account => no CLAUDE_CONFIG_DIR at launch
}

export interface ActiveSessionResult {
  activeMap: Map<string, number>;      // sessionId -> pid (all active sessions)
  vscodeSessions: ClaudeSession[];     // VS Code sessions not in history.jsonl
  entrypoints: Map<string, string>;    // sessionId -> entrypoint ('cli', 'claude-vscode')
}

interface HistoryLine {
  sessionId?: string;
  display?: string;
  timestamp?: number;
  project?: string;
}

interface SessionAccum {
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

const getHistoryPath = (dir: string): string => {
  return path.join(dir, 'history.jsonl');
};

// Cache for parsed sessions to avoid re-reading history.jsonl on every keystroke
let cachedSessions: ClaudeSession[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000; // refresh cache after 5 seconds

// All user prompts per session, same rebuild lifecycle as cachedSessions.
// Main-process-only: searched here, never shipped over IPC (~MBs of text).
let promptsBySession: Map<string, string[]> = new Map();

// Cache for active session detection to avoid spawning processes on every keystroke
let cachedActiveMap: Map<string, number> | null = null;
let cachedVSCodeSessions: ClaudeSession[] | null = null;
let cachedEntrypoints: Map<string, string> | null = null;
let activeCacheTimestamp = 0;
const ACTIVE_CACHE_TTL_MS = 5000;

// Cache for custom titles
let cachedCustomTitles: Map<string, string> | null = null;

export const invalidateSessionCache = () => {
  // Persist what the last scan found BEFORE anything is cleared: a debounced
  // write still pending would otherwise fire after the clear and replace the
  // disk cache with `sessions: {}` — and the flush itself reads the maps
  // below, so it must run before they are reset, not merely before the file
  // state is. Flushing also cancels the timer.
  flushEnrichmentCache();
  cachedSessions = null;
  cachedActiveMap = null;
  cachedVSCodeSessions = null;
  cachedEntrypoints = null;
  cachedCustomTitles = null;
  cachedBranches = null;
  cachedPRLinks = null;
  cachedRecaps = null;
  cachedPRRefs = null;
  enrichedFileState.clear();
  prRefBytes.clear();
  // The disk cache is still valid (freshness is per file, by mtime+size);
  // reload it on the next scan rather than paying a cold scan.
  enrichmentLoadedFromDisk = false;
};

/**
 * Read Claude Code sessions from ~/.claude/history.jsonl
 * Deduplicates by session ID, keeps first prompt display text,
 * uses latest timestamp for sorting (newest first).
 */
export const readClaudeSessions = (limit = 100): ClaudeSession[] => {
  const now = Date.now();
  if (cachedSessions && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedSessions.slice(0, limit);
  }

  // Multi-account: scan every configured account's history.jsonl and merge.
  // sessionIds are UUIDs (unique across accounts), so no cross-account dedupe.
  const bySession = new Map<string, SessionAccum>();
  const prompts = new Map<string, string[]>();

  // Per-account try/catch: one unreadable/corrupt history must not hide the
  // sessions of every other account.
  for (const account of getScannableAccounts()) {
    try {
      const historyPath = getHistoryPath(account.dir);
      if (!fs.existsSync(historyPath)) continue;

      const content = fs.readFileSync(historyPath, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const raw: HistoryLine = JSON.parse(line);
          if (!raw.sessionId) continue;

          if (raw.display) {
            const list = prompts.get(raw.sessionId);
            if (list) list.push(raw.display);
            else prompts.set(raw.sessionId, [raw.display]);
          }

          const existing = bySession.get(raw.sessionId);
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
            bySession.set(raw.sessionId, {
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
        } catch {
          // skip malformed lines
        }
      }
    } catch (error) {
      console.error(
        `Error reading Claude sessions for ${account.label}:`,
        error,
      );
    }
  }

  // Unified timeline: sort the MERGED set by recency (newest first) so both
  // accounts interleave by lastTimestamp. The account badge disambiguates.
  const allSessions = Array.from(bySession.values())
    .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
    .map((s) => ({
      sessionId: s.sessionId,
      project: s.project,
      projectName: path.basename(s.project) || s.project,
      firstUserMessage: s.firstDisplay,
      lastUserMessage: s.lastDisplay,
      lastTimestamp: s.lastTimestamp,
      messageCount: s.promptCount,
      isActive: false,
      accountLabel: s.accountLabel,
      accountDir: s.accountDir,
      accountConfigDirEnv: s.accountConfigDirEnv,
      accountIsAnchor: s.accountIsAnchor,
    }));

  cachedSessions = allSessions;
  promptsBySession = prompts;
  cacheTimestamp = now;
  return allSessions.slice(0, limit);
};

export interface SessionSearchMatch extends PromptMatch {
  isLastPrompt: boolean;
}

export interface SessionSearchResult {
  sessions: ClaudeSession[];
  /** sessionId -> where the match sits inside the prompt list (when in a prompt). */
  snippets: Record<string, SessionSearchMatch>;
}

/**
 * Full search across ALL sessions (not just the ~100 the UI loads) and ALL
 * user prompts (not just first/last) — fixes issue #131. Sessions come back
 * newest-first; prompt text stays in this process (only snippets cross IPC).
 *
 * The query language (issue #140) is judged here with the SAME matcher the
 * renderer runs, over everything this process knows: prompts, project, and
 * the enrichment caches (title, branch, PR badge, recap, and the PR
 * references the assistant mentioned) — which the persisted cache and the
 * background scan fill for every session, not just the loaded window. The
 * one kind of term this side cannot judge is `is:` (the ps join and the pin
 * store live in the renderer), so it is left out here and the renderer
 * applies it to whatever comes back.
 */
export const searchClaudeSessions = (
  query: string,
  limit = 100,
): SessionSearchResult => {
  const parsed = parseQuery(query);
  if (isEmptyQuery(parsed)) return { sessions: [], snippets: {} };
  ensureEnrichmentLoaded();
  const matcher = compileQuery({ ...parsed, is: [] });
  const needles = promptNeedles(parsed);

  // Recency-sorted full set; also (re)builds promptsBySession when stale.
  const allSessions = readClaudeSessions(Number.MAX_SAFE_INTEGER);
  const sessions: ClaudeSession[] = [];
  const snippets: Record<string, SessionSearchMatch> = {};

  for (const s of allSessions) {
    const id = s.sessionId;
    const sessionPrompts = promptsBySession.get(id) || [];
    const title = cachedCustomTitles?.get(id);
    const branch = cachedBranches?.get(id);
    const prLink = cachedPRLinks?.get(id);
    const recap = cachedRecaps?.get(id)?.text;
    const refs = cachedPRRefs?.get(id);
    const repos = sessionRepos(prLink?.prUrl, refs);
    const text = [
      s.projectName,
      s.project,
      sessionPrompts.join('\n'),
      title,
      branch,
      prLink ? `PR #${prLink.prNumber} ${prLink.prUrl}` : '',
      recap,
      refs?.join(' '),
    ]
      .filter(Boolean)
      .join('\n');
    if (
      !matcher.test({
        sessionId: id,
        text,
        title,
        branch,
        project: `${s.projectName} ${s.project}`,
        account: s.accountLabel,
        recap,
        prompts: sessionPrompts,
        hasPr: !!prLink,
        lastTimestamp: s.lastTimestamp,
        repos,
      })
    ) {
      continue;
    }

    sessions.push(s);
    const match = findPromptMatch(
      sessionPrompts,
      needles,
      parsed.prRefs,
      repos,
    );
    if (match) {
      snippets[id] = {
        ...match,
        isLastPrompt: match.promptIndex === sessionPrompts.length - 1,
      };
    }
    if (sessions.length >= limit) break;
  }
  return { sessions, snippets };
};

/** Look up full session records by id from the cached full set (any account). */
export const getSessionsByIds = (ids: string[]): ClaudeSession[] => {
  if (ids.length === 0) return [];
  const want = new Set(ids);
  return readClaudeSessions(Number.MAX_SAFE_INTEGER).filter((s) =>
    want.has(s.sessionId),
  );
};

/**
 * Detect active Claude Code sessions by checking running processes.
 * Returns a Map of session ID -> PID.
 *
 * Detection strategy:
 * 1. Find all claude processes via `ps aux | grep claude`
 * 2. For processes with `--resume <id>` or `-r <id>`, extract the session ID directly
 * 3. For processes with just `-r` (no ID), check the process's open files
 *    to find which project directory it's working in, then look up the latest
 *    session for that project from history.jsonl
 */
/**
 * Detect which terminal app a process is running in by walking parent process tree.
 * Returns 'iterm2', 'cmux', 'ghostty', 'terminal', or 'unknown'.
 */
export const detectTerminalApp = async (pid: number): Promise<string> => {
  const { exec } = require('child_process');
  const execPromise = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { encoding: 'utf-8', timeout: 2000 }, (_e: any, out: string) => resolve(out || ''));
    });

  let currentPid = pid;
  for (let i = 0; i < 20; i++) {
    const comm = (await execPromise(`ps -o comm= -p ${currentPid} 2>/dev/null`)).trim();
    if (!comm) break;

    const commLower = comm.toLowerCase();
    // CodeV's embedded terminal (node-pty runs under Electron)
    if (commLower.includes('codev')) return 'codev';
    // Check if this Electron process is CodeV by inspecting command line
    if (commLower.includes('electron')) {
      const cmdline = (await execPromise(`ps -o command= -p ${currentPid} 2>/dev/null`)).trim();
      if (cmdline.toLowerCase().includes('codev')) return 'codev';
    }
    if (commLower.includes('iterm') || commLower.includes('iterm2')) return 'iterm2';
    if (commLower.includes('cmux')) return 'cmux';
    if (commLower.includes('ghostty')) return 'ghostty';
    if (commLower.includes('terminal.app') || (commLower === 'terminal')) return 'terminal';

    const ppid = parseInt((await execPromise(`ps -o ppid= -p ${currentPid} 2>/dev/null`)).trim(), 10);
    if (!ppid || ppid <= 1) break;
    currentPid = ppid;
  }
  return 'unknown';
};

/**
 * iTerm2 cross-reference: refine PID-session mapping using terminal TTY + tab name.
 * For processes that were mapped via cwd fallback (no UUID/title in args),
 * check if iTerm2 tab name contains a custom title that can identify the session.
 * Only runs when iTerm2 is detected and there are ambiguous same-cwd mappings.
 */
const refineDetectionWithITerm2 = async (
  activeMap: Map<string, number>,
  claimedSessionIds: Set<string>,
  cwdProcesses: { pid: number; line: string }[],
  allSessions: ClaudeSession[],
  execPromise: (cmd: string) => Promise<string>,
): Promise<void> => {
  // Only worth running if there are cwd-fallback processes
  if (cwdProcesses.length === 0) return;

  // Quick check: is iTerm2 running at all?
  const itermCheck = await execPromise('pgrep -x iTerm2 2>/dev/null');
  if (!itermCheck.trim()) return;

  // All cwd processes are potential iTerm2 candidates (we'll verify via TTY matching)
  const iterm2Pids = cwdProcesses.map(p => p.pid);

  // Get all iTerm2 sessions' TTY + tab name via AppleScript
  const tmpScript = '/tmp/codev-iterm-detect.scpt';
  fs.writeFileSync(tmpScript, `tell application "iTerm2"
  set results to ""
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set results to results & (tty of s) & "|||" & (name of s) & "\\n"
      end repeat
    end repeat
  end repeat
  return results
end tell`);
  const itermOutput = await execPromise(`osascript ${tmpScript} 2>/dev/null`);
  try { fs.unlinkSync(tmpScript); } catch {}
  if (!itermOutput.trim()) return;

  // Parse iTerm2 sessions: [{tty, name}, ...]
  const itermSessions: { tty: string; name: string }[] = [];
  for (const line of itermOutput.split('\n')) {
    const parts = line.split('|||');
    if (parts.length === 2 && parts[0].trim()) {
      itermSessions.push({ tty: parts[0].trim(), name: parts[1].trim() });
    }
  }
  if (itermSessions.length === 0) return;

  // Cross-reference: for each iTerm2 claude PID, find its TTY → match iTerm2 tab → extract title → find session
  // Load custom titles lazily per-cwd to avoid scanning all sessions
  const titleCache = new Map<string, Map<string, string>>(); // cwd → (sessionId → title)

  const getTitlesForCwd = async (cwd: string): Promise<Map<string, string>> => {
    if (titleCache.has(cwd)) return titleCache.get(cwd)!;
    const titles = new Map<string, string>();
    const candidates = allSessions.filter(s => s.project === cwd);
    const encodedProject = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    await Promise.all(candidates.map(async (session) => {
      const jsonlPath = path.join(
        getProjectsDir(session.accountDir),
        encodedProject,
        `${session.sessionId}.jsonl`,
      );
      if (!fs.existsSync(jsonlPath)) return;
      const out = await execPromise(`grep '"type":"custom-title"' "${jsonlPath}" 2>/dev/null | tail -1`);
      try {
        const parsed = JSON.parse(out.trim());
        const title = (parsed.customTitle || '').replace(/^"|"$/g, '').trim();
        if (title) titles.set(session.sessionId, title);
      } catch {}
    }));
    titleCache.set(cwd, titles);
    return titles;
  };

  for (const pid of iterm2Pids) {
    const ttyOutput = (await execPromise(`ps -o tty= -p ${pid} 2>/dev/null`)).trim();
    if (!ttyOutput) continue;

    // Find iTerm2 session with matching TTY
    const itermSession = itermSessions.find(s => s.tty.endsWith(ttyOutput));
    if (!itermSession) continue;

    // Get cwd for this PID to load relevant custom titles
    const cwdOutput = await execPromise(`lsof -p ${pid} -Fn 2>/dev/null | grep "^n/" | head -1`);
    const cwdMatch = cwdOutput.match(/^n(.+)$/m);
    if (!cwdMatch) continue;
    const cwd = cwdMatch[1];

    // Load custom titles for same-cwd sessions only
    const sessionTitles = await getTitlesForCwd(cwd);
    if (sessionTitles.size === 0) continue;

    // Try to match tab name against custom titles
    const tabName = itermSession.name;
    for (const [sessionId, title] of sessionTitles) {
      if (title && tabName.includes(title) && !claimedSessionIds.has(sessionId)) {
        // Found a match — check if this PID was previously mapped to a different session
        const currentSessionId = [...activeMap.entries()].find(([, p]) => p === pid)?.[0];
        if (currentSessionId && currentSessionId !== sessionId) {
          // Remove old mapping
          activeMap.delete(currentSessionId);
          claimedSessionIds.delete(currentSessionId);
          console.log(`[cross-ref] corrected PID ${pid}: ${currentSessionId} → ${sessionId} (tab: "${tabName}")`);
        }
        activeMap.set(sessionId, pid);
        claimedSessionIds.add(sessionId);
        break;
      }
    }
  }
};

/**
 * cmux cross-reference: refine PID-session mapping using per-surface TTY + title from tree output.
 * Same concept as iTerm2 cross-reference but uses cmux CLI instead of AppleScript.
 * Requires cmux build with TTY support in tree output (tty= field in surface lines).
 */
const refineDetectionWithCmux = async (
  activeMap: Map<string, number>,
  claimedSessionIds: Set<string>,
  cwdProcesses: { pid: number; line: string }[],
  allSessions: ClaudeSession[],
  execPromise: (cmd: string) => Promise<string>,
): Promise<void> => {
  if (cwdProcesses.length === 0) return;

  // Quick check: is cmux running?
  const cmuxCheck = await execPromise('pgrep -x cmux 2>/dev/null');
  if (!cmuxCheck.trim()) return;

  // Get tree output with TTY info
  const treeOutput = await execPromise(`${CMUX_CLI} tree --all 2>/dev/null`);
  if (!treeOutput.trim()) return;

  // Parse surfaces with TTY: look for "tty=ttysNNN" in surface lines
  const cmuxSurfaces: { tty: string; title: string }[] = [];
  for (const line of treeOutput.split('\n')) {
    const surfaceMatch = line.match(/surface (surface:\d+)/);
    if (!surfaceMatch) continue;
    const ttyMatch = line.match(/tty=(\S+)/);
    if (!ttyMatch) continue;
    const titleMatch = line.match(/\[terminal\]\s+"(.+?)"\s*(\[|◀|tty=|$)/);
    cmuxSurfaces.push({
      tty: ttyMatch[1],
      title: titleMatch ? titleMatch[1] : '',
    });
  }
  if (cmuxSurfaces.length === 0) return;

  // Load custom titles lazily per-cwd
  const titleCache = new Map<string, Map<string, string>>();

  const getTitlesForCwd = async (cwd: string): Promise<Map<string, string>> => {
    if (titleCache.has(cwd)) return titleCache.get(cwd)!;
    const titles = new Map<string, string>();
    const candidates = allSessions.filter(s => s.project === cwd);
    const encodedProject = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    await Promise.all(candidates.map(async (session) => {
      const jsonlPath = path.join(
        getProjectsDir(session.accountDir),
        encodedProject,
        `${session.sessionId}.jsonl`,
      );
      if (!fs.existsSync(jsonlPath)) return;
      const out = await execPromise(`grep '"type":"custom-title"' "${jsonlPath}" 2>/dev/null | tail -1`);
      try {
        const parsed = JSON.parse(out.trim());
        const title = (parsed.customTitle || '').replace(/^"|"$/g, '').trim();
        if (title) titles.set(session.sessionId, title);
      } catch {}
    }));
    titleCache.set(cwd, titles);
    return titles;
  };

  // Cross-reference: for each cwd-fallback PID, match TTY → cmux surface → title → session
  for (const { pid } of cwdProcesses) {
    const ttyOutput = (await execPromise(`ps -o tty= -p ${pid} 2>/dev/null`)).trim();
    if (!ttyOutput) continue;

    const cmuxSurface = cmuxSurfaces.find(s => s.tty.endsWith(ttyOutput));
    if (!cmuxSurface) continue;

    const cwdOutput = await execPromise(`lsof -p ${pid} -Fn 2>/dev/null | grep "^n/" | head -1`);
    const cwdMatch = cwdOutput.match(/^n(.+)$/m);
    if (!cwdMatch) continue;
    const cwd = cwdMatch[1];

    const sessionTitles = await getTitlesForCwd(cwd);
    if (sessionTitles.size === 0) continue;

    const tabName = cmuxSurface.title;
    for (const [sessionId, title] of sessionTitles) {
      if (title && tabName.includes(title) && !claimedSessionIds.has(sessionId)) {
        const currentSessionId = [...activeMap.entries()].find(([, p]) => p === pid)?.[0];
        if (currentSessionId && currentSessionId !== sessionId) {
          activeMap.delete(currentSessionId);
          claimedSessionIds.delete(currentSessionId);
          console.log(`[cross-ref-cmux] corrected PID ${pid}: ${currentSessionId} → ${sessionId} (surface: "${tabName}")`);
        }
        activeMap.set(sessionId, pid);
        claimedSessionIds.add(sessionId);
        break;
      }
    }
  }
};

/**
 * Cross-reference disambiguation for PIDs with same-cwd ambiguity.
 * Groups by terminal type to avoid redundant pgrep/AppleScript/CLI calls.
 * Only runs for PIDs where sessionId didn't match history.jsonl AND multiple same-cwd sessions exist.
 */
const crossRefDisambiguate = async (
  needsCrossRef: { pid: number; cwd: string; candidates: ClaudeSession[] }[],
  activeMap: Map<string, number>,
  execPromise: (cmd: string) => Promise<string>,
): Promise<void> => {
  // Detect terminal for each PID in parallel, then group
  const byTerminal: Record<string, { pid: number; cwd: string; candidates: ClaudeSession[] }[]> = {};
  const terminals = await Promise.all(needsCrossRef.map(item => detectTerminalApp(item.pid)));
  for (let i = 0; i < needsCrossRef.length; i++) {
    const terminal = terminals[i];
    if (!byTerminal[terminal]) byTerminal[terminal] = [];
    byTerminal[terminal].push(needsCrossRef[i]);
  }

  // Load custom titles lazily per-cwd (shared across terminals)
  const titleCache = new Map<string, Map<string, string>>();
  const getTitlesForCwd = async (cwd: string): Promise<Map<string, string>> => {
    if (titleCache.has(cwd)) return titleCache.get(cwd)!;
    const titles = new Map<string, string>();
    const encodedProject = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    // Scan every account's projects dir — the session may live under any account.
    for (const account of getScannableAccounts()) {
      const projectDir = path.join(getProjectsDir(account.dir), encodedProject);
      if (!fs.existsSync(projectDir)) continue;
      const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      await Promise.all(jsonlFiles.map(async (file) => {
        const sessionId = file.replace('.jsonl', '');
        const out = await execPromise(`grep '"type":"custom-title"' "${path.join(projectDir, file)}" 2>/dev/null | tail -1`);
        try {
          const parsed = JSON.parse(out.trim());
          const title = (parsed.customTitle || '').replace(/^"|"$/g, '').trim();
          if (title) titles.set(sessionId, title);
        } catch {}
      }));
    }
    titleCache.set(cwd, titles);
    return titles;
  };

  // Run iTerm2 and cmux cross-reference in parallel (different PID sets, no conflict)
  const crossRefTasks: Promise<void>[] = [];

  // iTerm2: one AppleScript call, then match each PID's TTY
  if (byTerminal['iterm2']?.length) {
    crossRefTasks.push((async () => {
      const itermCheck = await execPromise('pgrep -x iTerm2 2>/dev/null');
      if (!itermCheck.trim()) return;
      const tmpScript = '/tmp/codev-iterm-detect.scpt';
      fs.writeFileSync(tmpScript, `tell application "iTerm2"
  set results to ""
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set results to results & (tty of s) & "|||" & (name of s) & "\\n"
      end repeat
    end repeat
  end repeat
  return results
end tell`);
      const itermOutput = await execPromise(`osascript ${tmpScript} 2>/dev/null`);
      try { fs.unlinkSync(tmpScript); } catch {}
      if (!itermOutput.trim()) return;

      const itermSessions: { tty: string; name: string }[] = [];
      for (const line of itermOutput.split('\n')) {
        const parts = line.split('|||');
        if (parts.length === 2 && parts[0].trim()) {
          itermSessions.push({ tty: parts[0].trim(), name: parts[1].trim() });
        }
      }

      for (const item of byTerminal['iterm2']) {
        const ttyOutput = (await execPromise(`ps -o tty= -p ${item.pid} 2>/dev/null`)).trim();
        if (!ttyOutput) continue;
        const itermSession = itermSessions.find(s => s.tty.endsWith(ttyOutput));
        if (!itermSession) continue;

        const sessionTitles = await getTitlesForCwd(item.cwd);
        const tabName = itermSession.name;
        for (const [sessionId, title] of sessionTitles) {
          if (title && tabName.includes(title) && !activeMap.has(sessionId)) {
            activeMap.set(sessionId, item.pid);
            break;
          }
        }
      }
    })());
  }

  // cmux: one tree --all call, then match each PID's TTY
  if (byTerminal['cmux']?.length) {
    crossRefTasks.push((async () => {
      const cmuxCheck = await execPromise('pgrep -x cmux 2>/dev/null');
      if (!cmuxCheck.trim()) return;
      const treeOutput = await execPromise(`${CMUX_CLI} tree --all 2>/dev/null`);
      if (!treeOutput.trim()) return;

      const cmuxSurfaces: { tty: string; title: string }[] = [];
      for (const line of treeOutput.split('\n')) {
        if (!line.match(/surface (surface:\d+)/)) continue;
        const ttyMatch = line.match(/tty=(\S+)/);
        if (!ttyMatch) continue;
        const titleMatch = line.match(/\[terminal\]\s+"(.+?)"\s*(\[|◀|tty=|$)/);
        cmuxSurfaces.push({ tty: ttyMatch[1], title: titleMatch ? titleMatch[1] : '' });
      }

      for (const item of byTerminal['cmux']) {
        const ttyOutput = (await execPromise(`ps -o tty= -p ${item.pid} 2>/dev/null`)).trim();
        if (!ttyOutput) continue;
        const cmuxSurface = cmuxSurfaces.find(s => s.tty.endsWith(ttyOutput));
        if (!cmuxSurface) continue;

        const sessionTitles = await getTitlesForCwd(item.cwd);
        const tabName = cmuxSurface.title;
        for (const [sessionId, title] of sessionTitles) {
          if (title && tabName.includes(title) && !activeMap.has(sessionId)) {
            activeMap.set(sessionId, item.pid);
            break;
          }
        }
      }
    })());
  }

  // Terminal.app: similar to iTerm2 but window → tab (no session layer)
  if (byTerminal['terminal']?.length) {
    crossRefTasks.push((async () => {
      const termCheck = await execPromise('pgrep -x Terminal 2>/dev/null');
      if (!termCheck.trim()) return;
      const tmpScript = '/tmp/codev-terminal-detect.scpt';
      fs.writeFileSync(tmpScript, `tell application "Terminal"
  set results to ""
  repeat with w in windows
    repeat with t in tabs of w
      set results to results & (tty of t) & "|||" & (custom title of t) & linefeed
    end repeat
  end repeat
  return results
end tell`);
      const termOutput = await execPromise(`osascript ${tmpScript} 2>/dev/null`);
      try { fs.unlinkSync(tmpScript); } catch {}
      if (!termOutput.trim()) return;

      const termTabs: { tty: string; title: string }[] = [];
      for (const line of termOutput.split('\n')) {
        const parts = line.split('|||');
        if (parts.length === 2 && parts[0].trim()) {
          termTabs.push({ tty: parts[0].trim(), title: parts[1].trim() });
        }
      }

      for (const item of byTerminal['terminal']) {
        const ttyOutput = (await execPromise(`ps -o tty= -p ${item.pid} 2>/dev/null`)).trim();
        if (!ttyOutput) continue;
        const termTab = termTabs.find(s => s.tty.endsWith(ttyOutput));
        if (!termTab) continue;

        const sessionTitles = await getTitlesForCwd(item.cwd);
        const tabName = termTab.title;
        for (const [sessionId, title] of sessionTitles) {
          if (title && tabName.includes(title) && !activeMap.has(sessionId)) {
            activeMap.set(sessionId, item.pid);
            break;
          }
        }
      }
    })());
  }

  await Promise.all(crossRefTasks);

  // Ghostty + unknown terminals: cwd fallback (no async work, runs after cross-ref)
  for (const [terminal, items] of Object.entries(byTerminal)) {
    if (terminal === 'iterm2' || terminal === 'cmux' || terminal === 'terminal' || terminal === 'codev') continue;
    for (const item of items) {
      const fallback = item.candidates.find(s => !activeMap.has(s.sessionId));
      if (fallback) {
        activeMap.set(fallback.sessionId, item.pid);
      }
    }
  }
};

/**
 * Extract user-visible text from a message content array, skipping IDE context blocks.
 * Shared by active session reader + closed session scanner.
 */
const extractUserText = (content: any): string => {
  if (typeof content === 'string') return content.trim().slice(0, 200);
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && block?.text) {
        const t = block.text.trim();
        if (t.startsWith('<ide_')) continue;
        return t.slice(0, 200);
      }
    }
  }
  return '';
};

/**
 * Parse user messages from JSONL lines. Returns first user text found.
 * Shared parser used by both head (first prompt) and tail (last prompt) readers.
 */
const parseUserMessageFromLines = (lines: string[], fromEnd = false): string => {
  const iter = fromEnd ? [...lines].reverse() : lines;
  for (const line of iter) {
    if (!line.includes('"type":"user"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.role === 'user') {
        const text = extractUserText(entry.message.content);
        if (text) return text;
      }
    } catch {}
  }
  return '';
};

/**
 * Parse last assistant text from JSONL lines (shared with loadLastAssistantResponses pattern).
 */
const parseAssistantMessageFromLines = (lines: string[]): string => {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"type":"assistant"')) continue;
    try {
      const obj = JSON.parse(lines[i]);
      const content = obj?.message?.content;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        if (content[j]?.type === 'text' && content[j]?.text?.trim()) {
          return content[j].text.trim();
        }
      }
    } catch {}
  }
  return '';
};

/**
 * Read VS Code session info using head/tail (async, parallel).
 * Single tail read extracts both last user prompt AND last assistant message,
 * avoiding duplicate reads with loadLastAssistantResponses().
 */
const readVSCodeSessionFromJSONL = async (
  sessionId: string,
  cwdOrJsonlPath: string,
  execPromise: (cmd: string) => Promise<string>,
  isJsonlPath = false,
): Promise<{
  firstUserMessage: string;
  lastUserMessage: string;
  lastAssistantMessage: string;
  lastTimestamp: number;
  messageCount: number;
  cwd: string; // actual cwd read from JSONL content
}> => {
  const result = { firstUserMessage: '', lastUserMessage: '', lastAssistantMessage: '', lastTimestamp: 0, messageCount: 0, cwd: '' };
  let jsonlPath: string;
  if (isJsonlPath) {
    jsonlPath = cwdOrJsonlPath;
  } else {
    const encodedProject = cwdOrJsonlPath.replace(/[^a-zA-Z0-9-]/g, '-');
    const claudeDir = path.join(os.homedir(), '.claude', 'projects');
    jsonlPath = path.join(claudeDir, encodedProject, `${sessionId}.jsonl`);
  }

  if (!fs.existsSync(jsonlPath)) return result;

  // Parallel: head for first prompt, tail for last prompt + assistant, grep -c for count
  const [headOutput, tailOutput, countOutput] = await Promise.all([
    execPromise(`head -n 20 "${jsonlPath}"`),
    execPromise(`tail -n 100 "${jsonlPath}"`),
    execPromise(`grep -c '"type":"user"' "${jsonlPath}" 2>/dev/null`),
  ]);

  const headLines = headOutput.split('\n').filter(Boolean);
  const tailLines = tailOutput.split('\n').filter(Boolean);

  result.firstUserMessage = parseUserMessageFromLines(headLines);
  result.lastUserMessage = parseUserMessageFromLines(tailLines, true);
  result.lastAssistantMessage = parseAssistantMessageFromLines(tailLines);
  result.messageCount = parseInt(countOutput.trim(), 10) || 0;

  // Extract actual cwd from JSONL entries (head lines have it in user/assistant messages)
  for (const line of headLines) {
    if (!line.includes('"cwd"')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.cwd) { result.cwd = entry.cwd; break; }
    } catch {}
  }

  // Get timestamp from tail (convert ISO string to unix ms if needed)
  for (let i = tailLines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(tailLines[i]);
      if (entry.timestamp) {
        result.lastTimestamp = typeof entry.timestamp === 'string'
          ? new Date(entry.timestamp).getTime()
          : entry.timestamp;
        break;
      }
    } catch {}
  }
  return result;
};

// Cache for closed VS Code sessions scan
let cachedClosedVSCode: ClaudeSession[] | null = null;
let closedVSCodeTimestamp = 0;
const CLOSED_VSCODE_CACHE_TTL_MS = 30000; // 30s — less frequent than active detection

/**
 * Scan ~/.claude/projects/ for closed VS Code sessions.
 * Reads first 4KB of each JSONL to check entrypoint, then uses head/tail
 * to extract first/last user prompt (shared algorithm with loadLastAssistantResponses).
 *
 * Uses hooks index (vscode-sessions.jsonl) to skip already-known files.
 * Skips active sessions (caller should filter by activeMap).
 *
 * Benchmark: ~50ms for 218 files (4KB read per file).
 */
export const scanClosedVSCodeSessions = async (
  activeSessionIds: Set<string>,
  vsCodeIndex: Map<string, string>,
): Promise<ClaudeSession[]> => {
  const now = Date.now();
  if (cachedClosedVSCode && (now - closedVSCodeTimestamp) < CLOSED_VSCODE_CACHE_TTL_MS) {
    return cachedClosedVSCode.filter(s => !activeSessionIds.has(s.sessionId));
  }

  const { exec } = require('child_process');
  const execPromise = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { encoding: 'utf-8', timeout: 5000, maxBuffer: 1024 * 1024 }, (err: any, stdout: string) => {
        resolve(err ? '' : stdout);
      });
    });

  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return [];

  // Phase 1: Identify VS Code session files
  // Use hooks index for known sessions, scan remaining files
  const vsCodeFiles: { sessionId: string; cwd: string; jsonlPath: string }[] = [];

  // Add known sessions from hooks index
  for (const [sessionId, cwd] of vsCodeIndex) {
    if (activeSessionIds.has(sessionId)) continue;
    const encodedProject = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    const jsonlPath = path.join(claudeDir, encodedProject, `${sessionId}.jsonl`);
    if (fs.existsSync(jsonlPath)) {
      vsCodeFiles.push({ sessionId, cwd, jsonlPath });
    }
  }

  // Scan remaining JSONL files not in hooks index
  const knownIds = new Set(vsCodeIndex.keys());
  const dirs = fs.readdirSync(claudeDir);
  for (const dir of dirs) {
    const dirPath = path.join(claudeDir, dir);
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
    } catch { continue; }
    const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const sessionId = f.replace('.jsonl', '');
      if (knownIds.has(sessionId) || activeSessionIds.has(sessionId)) continue;
      // Read first 4KB to check entrypoint
      const filePath = path.join(dirPath, f);
      try {
        const fd = fs.openSync(filePath, 'r');
        let chunk: string;
        try {
          const buf = new Uint8Array(4096);
          const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
          chunk = Buffer.from(buf.buffer, 0, bytesRead).toString('utf-8');
        } finally {
          fs.closeSync(fd);
        }
        if (chunk.includes('"entrypoint":"claude-vscode"') || chunk.includes('"entrypoint": "claude-vscode"')) {
          // cwd will be read from JSONL content (directory name decode is lossy)
          vsCodeFiles.push({ sessionId, cwd: '', jsonlPath: filePath });
        }
      } catch {}
    }
  }

  // Phase 2: Read first/last prompt + assistant for each session using head/tail (parallel)
  // Uses readVSCodeSessionFromJSONL (shared with active session detection)
  const sessions: ClaudeSession[] = [];
  const promises = vsCodeFiles.map(async ({ sessionId, cwd, jsonlPath }) => {
    // For scanned files (not from hooks index), pass jsonlPath directly to avoid lossy cwd decode
    const useJsonlPath = !vsCodeIndex.has(sessionId);
    const info = await readVSCodeSessionFromJSONL(
      sessionId, useJsonlPath ? jsonlPath : cwd, execPromise, useJsonlPath,
    );
    // Use actual cwd from JSONL content, fall back to hooks index cwd
    const actualCwd = info.cwd || cwd;
    sessions.push({
      sessionId,
      project: actualCwd,
      projectName: path.basename(actualCwd) || actualCwd,
      firstUserMessage: info.firstUserMessage,
      lastUserMessage: info.lastUserMessage,
      lastAssistantMessage: info.lastAssistantMessage,
      lastTimestamp: info.lastTimestamp,
      messageCount: info.messageCount,
      isActive: false,
      entrypoint: 'claude-vscode',
    });
  });

  await Promise.all(promises);
  sessions.sort((a, b) => b.lastTimestamp - a.lastTimestamp);

  cachedClosedVSCode = sessions;
  closedVSCodeTimestamp = now;
  return sessions.filter(s => !activeSessionIds.has(s.sessionId));
};

export const detectActiveSessions = async (): Promise<ActiveSessionResult> => {
  const now = Date.now();
  if (cachedActiveMap && (now - activeCacheTimestamp) < ACTIVE_CACHE_TTL_MS) {
    return {
      activeMap: cachedActiveMap,
      vscodeSessions: cachedVSCodeSessions || [],
      entrypoints: cachedEntrypoints || new Map(),
    };
  }

  const activeMap = new Map<string, number>();
  const entrypoints = new Map<string, string>();
  const vscodeSessions: ClaudeSession[] = [];
  const vscodeReadPromises: Promise<void>[] = [];
  const needsCrossRef: { pid: number; cwd: string; candidates: ClaudeSession[] }[] = [];

  const { exec } = require('child_process');
  const execPromise = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { encoding: 'utf-8', timeout: 3000, maxBuffer: 1024 * 1024 }, (err: any, stdout: string) => {
        resolve(err ? '' : stdout);
      });
    });

  try {
    // Primary: read ~/.claude/sessions/<PID>.json for direct PID → sessionId mapping.
    // These files are created on session start and deleted on session exit.
    // Claude Code also runs concurrentSessionCleanup() to remove stale files.
    const allSessions = readClaudeSessions(500);
    // Multi-account: scan every configured account's sessions/ dir for PID files.
    let anySessionsDir = false;
    for (const account of getScannableAccounts()) {
      const sessionsDir = path.join(account.dir, 'sessions');
      if (!fs.existsSync(sessionsDir)) continue;
      anySessionsDir = true;
      const files = fs.readdirSync(sessionsDir).filter(f => /^\d+\.json$/.test(f));

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
          const data = JSON.parse(content);
          const pid = data.pid as number;
          const sessionId = data.sessionId as string;
          const cwd = data.cwd as string;
          const entrypoint = (data.entrypoint as string) || 'cli';
          if (!pid || !sessionId) continue;

          // Verify process is still alive
          try { process.kill(pid, 0); } catch {
            console.log(`[detect-active] PID ${pid} (${sessionId}) not alive, skipping`);
            continue;
          }

          entrypoints.set(sessionId, entrypoint);

          if (entrypoint === 'claude-vscode') {
            // VS Code sessions: not in history.jsonl, add directly
            activeMap.set(sessionId, pid);
            // Queue async JSONL read (head/tail in parallel)
            const startedAt = data.startedAt;
            vscodeReadPromises.push(
              readVSCodeSessionFromJSONL(sessionId, cwd, execPromise).then((info) => {
                vscodeSessions.push({
                  sessionId,
                  project: cwd,
                  projectName: path.basename(cwd) || cwd,
                  firstUserMessage: info.firstUserMessage,
                  lastUserMessage: info.lastUserMessage,
                  lastAssistantMessage: info.lastAssistantMessage,
                  lastTimestamp: info.lastTimestamp || startedAt || 0,
                  messageCount: info.messageCount,
                  isActive: true,
                  activePid: pid,
                  entrypoint,
                });
              })
            );
          } else {
            // CLI sessions: match against history.jsonl
            const knownSession = allSessions.find(s => s.sessionId === sessionId);
            if (knownSession) {
              activeMap.set(sessionId, pid);
            } else if (cwd) {
              // sessionId not in history — find session by cwd
              console.log(`[detect-active] PID ${pid} sessionId ${sessionId} not in history.jsonl, trying cwd match (${cwd})`);
              const cwdCandidates = allSessions.filter(s => s.project === cwd && !activeMap.has(s.sessionId));
              if (cwdCandidates.length === 1) {
                activeMap.set(cwdCandidates[0].sessionId, pid);
              } else if (cwdCandidates.length > 1) {
                // Multiple same-cwd candidates — queue for cross-reference
                needsCrossRef.push({ pid, cwd, candidates: cwdCandidates });
              } else {
                console.log(`[detect-active] PID ${pid} sessionId ${sessionId}: no cwd match found`);
              }
            } else {
              console.log(`[detect-active] PID ${pid} sessionId ${sessionId}: not in history and no cwd`);
            }
          }
        } catch (err) {
          console.error(`[detect-active] Error processing session file ${file}:`, err);
        }
      }
    }

    // Read VS Code session JSONLs in parallel (head/tail)
    if (vscodeReadPromises.length > 0) {
      await Promise.all(vscodeReadPromises);
    }

    // Cross-reference for PIDs with same-cwd ambiguity.
    // Group by terminal to avoid redundant pgrep/AppleScript/CLI calls.
    if (needsCrossRef.length > 0) {
      await crossRefDisambiguate(needsCrossRef, activeMap, execPromise);
    }

    // Fallback: if no account had a sessions/ dir (old Claude Code versions)
    if (!anySessionsDir) {
      await detectActiveSessionsLegacy(activeMap);
    }
  } catch (err) {
    console.error('[detect-active] Error in detectActiveSessions:', err);
  }

  cachedActiveMap = activeMap;
  cachedVSCodeSessions = vscodeSessions;
  cachedEntrypoints = entrypoints;
  activeCacheTimestamp = now;
  return { activeMap, vscodeSessions, entrypoints };
};

/**
 * Legacy detection for old Claude Code versions without ~/.claude/sessions/.
 * Uses ps aux + regex for --resume UUID, lsof for cwd matching.
 */
const detectActiveSessionsLegacy = async (activeMap: Map<string, number>): Promise<void> => {
  const { exec } = require('child_process');
  const execPromise = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { encoding: 'utf-8', timeout: 3000 }, (err: any, stdout: string) => {
        resolve(err ? '' : stdout);
      });
    });

  const claimedSessionIds = new Set<string>();

  const output = await execPromise(
    'ps aux | grep -E "[c]laude" | grep -v "Claude.app" | grep -v "claude-history" | grep -v "ClaudeHistory"'
  );
  if (!output) return;

  const cwdProcesses: { pid: number; line: string }[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parseInt(parts[1], 10);
    if (!pid) continue;

    const resumeMatch = line.match(/(?:--resume|-r)\s+([a-f0-9-]{36})/);
    if (resumeMatch) {
      activeMap.set(resumeMatch[1], pid);
      claimedSessionIds.add(resumeMatch[1]);
      continue;
    }

    if (line.includes('claude')) {
      cwdProcesses.push({ pid, line });
    }
  }

  const allSessions = readClaudeSessions(500);
  for (const { pid } of cwdProcesses) {
    const cwdOutput = await execPromise(`lsof -p ${pid} -Fn 2>/dev/null | grep "^n/" | head -1`);
    const cwdMatch = cwdOutput.match(/^n(.+)$/m);
    if (cwdMatch) {
      const cwd = cwdMatch[1];
      const match = allSessions.find((s) => s.project === cwd && !claimedSessionIds.has(s.sessionId));
      if (match) {
        activeMap.set(match.sessionId, pid);
        claimedSessionIds.add(match.sessionId);
      }
    }
  }
};

/**
 * codev multi-account: look up which account a session belongs to (via the
 * cached session list, which tags each session with its config dir) and return
 * the CLAUDE_CONFIG_DIR to prefix at resume — or null for the default account.
 */
const getResumeConfigDirEnv = (
  sessionId: string,
  accountLabel?: string,
): string | null => {
  const s = readClaudeSessions(Number.MAX_SAFE_INTEGER).find(
    (x) => x.sessionId === sessionId,
  );
  if (s) return s.accountConfigDirEnv;
  // Not in any history (a /branch child, a pruned history): trust the label
  // a saved list captured, or the resume lands under the anchor account and
  // never finds its transcript. Strict lookup — a label no account carries
  // (renamed, removed) is rejected by the launch paths before they get here.
  const account = accountLabel ? findAccountByLabel(accountLabel) : undefined;
  return account ? account.configDirEnv : null;
};

/** The account with exactly this label, or undefined — never a fallback. */
export const findAccountByLabel = (label: string): CodevAccount | undefined =>
  getAccounts().find((a) => a.label === label);

/**
 * A project path safe to embed in the launch commands. Every terminal
 * launcher interpolates the path into a double-quoted shell string and, for
 * Ghostty and Terminal.app, into an AppleScript string literal; a path
 * carrying a quote, a backslash, `$`, a backtick or a line break could end
 * either literal. Real project paths never contain these, so refusing them
 * costs nothing and closes the hole for every caller — the saved-list file
 * and history.jsonl are both plain files a user (or a stray tool) can edit.
 */
export const isSafeLaunchPath = (p: unknown): p is string =>
  typeof p === 'string' && p.length > 0 && !/["\\$`\n\r\u0000]/.test(p);

/**
 * Build `command claude --resume <id>`, prefixed with CLAUDE_CONFIG_DIR when the
 * session belongs to a non-default account so it resumes under the right account.
 */
const buildResumeCommand = (
  sessionId: string,
  accountLabel?: string,
): string => {
  const configDir = getResumeConfigDirEnv(sessionId, accountLabel);
  // Single-quote the value: some terminal injections (Ghostty `initial input`)
  // don't escape the command, so a double-quoted prefix would break their
  // AppleScript string. Single quotes are safe across all terminals + handle spaces.
  // Escape single quotes (e.g. /Users/O'Brien/…) so the single-quoted prefix
  // stays well-formed: ' becomes '\'' .
  const prefix = configDir
    ? `CLAUDE_CONFIG_DIR='${configDir.replace(/'/g, "'\\''")}' `
    : '';
  // `command claude` bypasses the accounts.sh `claude` dispatcher. CodeV has
  // already resolved the exact account (the prefix, or none for the anchor), so
  // the shell must NOT re-route a bare `claude` to a configured non-default
  // global-default (§2e) — that would resume an anchor-account session under the
  // wrong account. Every terminal here runs the string through a shell, so the
  // `command` builtin is available.
  return `${prefix}command claude --resume ${sessionId}`;
};

/**
 * Open a Claude Code session in the configured terminal.
 */
export const openSession = async (
  sessionId: string,
  projectPath: string,
  isActive: boolean,
  activePid?: number,
  terminalApp: string = 'iterm2',
  terminalMode: string = 'tab',
  customTitle?: string,
  accountLabel?: string,
): Promise<void> => {
  let effectiveTerminal = terminalApp;

  // For active sessions, auto-detect which terminal they're running in
  if (isActive && activePid) {
    const detected = await detectTerminalApp(activePid);
    if (detected !== 'unknown') {
      effectiveTerminal = detected;
      console.log(`[openSession] auto-detected terminal: ${detected} for pid ${activePid}`);
    }
  }

  // Check if this is an active VS Code session — switch via URI handler
  // Always pass projectPath so the correct VS Code window gets focused first
  const entrypoint = cachedEntrypoints?.get(sessionId);
  if (isActive && entrypoint === 'claude-vscode') {
    openSessionInVSCode(sessionId, projectPath, true);
    return;
  }

  switch (effectiveTerminal) {
    case 'vscode':
      // User selected VS Code as launch terminal — open project first, then resume
      openSessionInVSCode(sessionId, projectPath);
      return;
    case 'codev':
      // Session is in CodeV's embedded terminal — notify renderer to switch to Term tab
      openSessionInCodeV(sessionId);
      break;
    case 'cmux':
      openSessionInCmux(
        sessionId,
        projectPath,
        isActive,
        activePid,
        customTitle,
        accountLabel,
      );
      break;
    case 'ghostty':
      openSessionInGhostty(
        sessionId,
        projectPath,
        isActive,
        terminalMode,
        customTitle,
        accountLabel,
      );
      break;
    case 'terminal':
      openSessionInTerminalApp(
        sessionId,
        projectPath,
        isActive,
        activePid,
        terminalMode,
        customTitle,
        accountLabel,
      );
      break;
    case 'iterm2':
    default:
      openSessionInITerm2(
        sessionId,
        projectPath,
        isActive,
        activePid,
        terminalMode,
        customTitle,
        accountLabel,
      );
      break;
  }
};

/**
 * Open a Claude Code session in iTerm2
 * If the session is already active, switch to its tab
 * Otherwise, open a new tab and run claude --resume
 */
/**
 * Refresh session preview: reads tail -n 100 to extract both last user message
 * and last assistant message in a single read. Used by status handler for
 * real-time updates without duplicate file reads.
 */
export const refreshSessionPreview = async (
  sessions: { sessionId: string; project: string; accountDir?: string }[]
): Promise<Map<string, { lastUserMessage: string; lastAssistantMessage: string }>> => {
  const { exec } = require('child_process');
  const execPromise = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { encoding: 'utf-8', timeout: 5000, maxBuffer: 10 * 1024 * 1024 }, (err: any, stdout: string) => {
        resolve(err ? '' : stdout);
      });
    });

  const results = new Map<string, { lastUserMessage: string; lastAssistantMessage: string }>();
  const promises = sessions.map(async (session) => {
    const encodedProject = session.project.replace(/[^a-zA-Z0-9-]/g, '-');
    const jsonlPath = path.join(
      getProjectsDir(session.accountDir),
      encodedProject,
      `${session.sessionId}.jsonl`,
    );
    if (!fs.existsSync(jsonlPath)) return;

    const output = await execPromise(`tail -n 100 "${jsonlPath}"`);
    if (!output.trim()) return;

    const lines = output.split('\n').filter(Boolean);
    const lastUserMessage = parseUserMessageFromLines(lines, true);
    const lastAssistantMessage = parseAssistantMessageFromLines(lines);

    if (lastUserMessage || lastAssistantMessage) {
      results.set(session.sessionId, { lastUserMessage, lastAssistantMessage });
    }
  });

  await Promise.all(promises);
  return results;
};

/**
 * Callback for opening sessions in CodeV's embedded terminal.
 * Set by main.ts to avoid circular dependency.
 */
let codevTerminalCallback: ((sessionId: string) => void) | null = null;

export const setCodevTerminalCallback = (cb: (sessionId: string) => void) => {
  codevTerminalCallback = cb;
};

/**
 * Callback for launching a new claude session in CodeV's embedded terminal.
 * Set by main.ts — sends cd + claude command to the PTY, then switches to Term tab.
 */
let launchInCodevTerminalCallback: ((projectPath: string) => void) | null = null;

export const setLaunchInCodevTerminalCallback = (cb: (projectPath: string) => void) => {
  launchInCodevTerminalCallback = cb;
};

/**
 * Run a shell command in a terminal app (new tab or window).
 * Shared by session resume and new session launch.
 * For Ghostty: `claudeCmd` is the bare command (no cd), projectPath sets initial working directory.
 * For others: `fullCommand` is the full command string (cd + claude).
 */
// One script file per launch. A fixed name was fine while launches were one
// click apart; opening a saved list runs several a few hundred ms apart, and
// each callback deletes its file, so a shared name could delete the script
// osascript was about to read.
let launchScriptSeq = 0;
const launchScriptPath = (name: string): string =>
  path.join(os.tmpdir(), `codev-${name}-${process.pid}-${++launchScriptSeq}.scpt`);

export const runCommandInTerminal = (
  fullCommand: string,
  claudeCmd: string,
  projectPath: string,
  terminalApp: string = 'iterm2',
  terminalMode: string = 'tab',
): void => {
  const { exec } = require('child_process');

  switch (terminalApp) {
    case 'ghostty': {
      const tmpScript = launchScriptPath('ghostty-launch');
      const launchScript = terminalMode === 'window'
        ? `tell application "Ghostty"
  set cfg to new surface configuration from {initial working directory:"${projectPath}", initial input:"${claudeCmd}\\n"}
  new window with configuration cfg
  activate
end tell`
        : `tell application "Ghostty"
  set cfg to new surface configuration from {initial working directory:"${projectPath}", initial input:"${claudeCmd}\\n"}
  if (count windows) > 0 then
    activate
    new tab in front window with configuration cfg
  else
    new window with configuration cfg
    activate
  end if
end tell`;
      fs.writeFileSync(tmpScript, launchScript);
      exec(`osascript ${tmpScript}`, { encoding: 'utf-8', timeout: 5000 }, (error: any) => {
        if (error) console.error('[runCommandInTerminal] ghostty error:', error.message);
        try { fs.unlinkSync(tmpScript); } catch {}
      });
      break;
    }
    case 'terminal': {
      const tmpScript = launchScriptPath('terminal-launch');
      const escapedCommand = fullCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const launchScript = terminalMode === 'window'
        ? `set wasRunning to (do shell script "pgrep -x Terminal >/dev/null 2>&1 && echo 1 || echo 0")
tell application "Terminal"
  if wasRunning is "0" then
    activate
    delay 0.3
    do script "${escapedCommand}" in front window
  else
    do script "${escapedCommand}"
    activate
  end if
end tell`
        : `tell application "Terminal"
  activate
  if (count of windows) > 0 then
    tell application "System Events"
      keystroke "t" using command down
    end tell
    delay 0.3
    do script "${escapedCommand}" in front window
  else
    do script "${escapedCommand}"
    activate
  end if
end tell`;
      fs.writeFileSync(tmpScript, launchScript);
      exec(`osascript ${tmpScript}`, { encoding: 'utf-8', timeout: 5000 }, (error: any) => {
        if (error) console.error('[runCommandInTerminal] Terminal.app error:', error.message);
        try { fs.unlinkSync(tmpScript); } catch {}
      });
      break;
    }
    case 'cmux': {
      const launchInCmux = () => {
        const cmuxCmd = `${CMUX_CLI} new-workspace --cwd "${projectPath}" --command "${claudeCmd}"`;
        console.log('[cmux] launch cmd:', cmuxCmd);
        exec(cmuxCmd,
          { encoding: 'utf-8', timeout: 5000 },
          (error: any, stdout: string, stderr: string) => {
            console.log('[cmux] launch result:', { error: error?.message, stdout, stderr });
            if (error) {
              console.error('cmux new-workspace failed:', error.message);
            } else {
              const wsMatch = stdout.match(/workspace:\d+/);
              if (wsMatch) {
                exec(`${CMUX_CLI} select-workspace --workspace ${wsMatch[0]}`);
              }
              exec('osascript -e \'tell application "cmux" to activate\'');
            }
          }
        );
      };
      exec('pgrep -x cmux', (error: any) => {
        if (error) {
          console.log('[cmux] not running, launching...');
          exec('open -a cmux');
          let attempts = 0;
          const waitForCmux = () => {
            attempts++;
            exec(`${CMUX_CLI} tree 2>/dev/null`, { timeout: 2000 }, (err: any) => {
              if (!err) {
                console.log(`[cmux] ready after ${attempts * 500}ms`);
                launchInCmux();
              } else if (attempts < 10) {
                setTimeout(waitForCmux, 500);
              } else {
                console.error('[cmux] timed out waiting for cmux');
              }
            });
          };
          setTimeout(waitForCmux, 500);
        } else {
          launchInCmux();
        }
      });
      break;
    }
    case 'iterm2':
    default: {
      const tmpScript = launchScriptPath('iterm-launch');
      const escapedCommand = fullCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const launchScript = terminalMode === 'window'
        ? `set wasRunning to (do shell script "pgrep -x iTerm2 >/dev/null 2>&1 && echo 1 || echo 0")
tell application "iTerm2"
  if wasRunning is "0" then
    activate
    delay 0.3
    tell current session of current window
      write text "${escapedCommand}"
    end tell
  else
    set newWindow to (create window with default profile)
    tell current session of newWindow
      write text "${escapedCommand}"
    end tell
    activate
  end if
end tell`
        : `tell application "iTerm2"
  activate
  tell current window
    create tab with default profile
    tell current session
      write text "${escapedCommand}"
    end tell
  end tell
end tell`;
      fs.writeFileSync(tmpScript, launchScript);
      exec(`osascript ${tmpScript}`, (error: any) => {
        if (error) console.error('[runCommandInTerminal] iTerm2 error:', error.message);
        try { fs.unlinkSync(tmpScript); } catch {}
      });
      break;
    }
  }
};

/**
 * Launch a new Claude Code session (not resume) in the specified terminal.
 * Fire-and-forget: opens terminal, cd's to project, runs `claude`.
 */
export const launchNewClaudeSession = (
  projectPath: string,
  terminalApp: string = 'iterm2',
  terminalMode: string = 'tab',
  accountLabel?: string,
): void => {
  if (terminalApp === 'vscode') {
    const { execFile } = require('child_process');
    if (isVSCodeProjectOpen(projectPath)) {
      // Project already open → instant
      execFile('open', ['vscode://anthropic.claude-code/open']);
      return;
    }
    // Launch VS Code, poll for extension ready, then open new session
    const bundleId = getCurrentIDEBundleId();
    execFile('open', ['-b', bundleId, projectPath], (error: any) => {
      if (error) {
        console.error('[launchNewClaudeSession] failed to open VS Code:', error);
        return;
      }
      waitForVSCodeExtensionReady(projectPath).then(() => {
        execFile('open', ['vscode://anthropic.claude-code/open']);
      });
    });
    return;
  }
  if (terminalApp === 'codev') {
    // Embedded terminal spawns the user's shell; the account override isn't
    // threaded through it yet (the 2c-lite picker targets external terminals).
    if (accountLabel) {
      console.log(
        '[launchNewClaudeSession] account override ignored for codev terminal:',
        accountLabel,
      );
    }
    if (launchInCodevTerminalCallback) {
      launchInCodevTerminalCallback(projectPath);
    }
    return;
  }
  // No accountLabel: bare `claude` → the accounts.sh dispatcher → the user's
  // global default (2e). With an explicit account (2c-lite picker): bypass the
  // dispatcher via `command claude` + explicit env, like buildResumeCommand.
  let claudeCmd = 'claude';
  if (accountLabel) {
    const account = getAccountByLabel(accountLabel);
    if (account?.label !== accountLabel) {
      // Stale/unknown label (e.g. the account was removed after the picker
      // loaded) — getAccountByLabel falls back to the default account, so
      // abort instead of silently launching a different identity.
      console.error(
        '[launchNewClaudeSession] unknown account label, aborting:',
        accountLabel,
      );
      return;
    }
    // Explicit pick of the default account: clear any inherited
    // CLAUDE_CONFIG_DIR too (matches the generated accounts.sh launchers).
    claudeCmd = account.configDirEnv
      ? `CLAUDE_CONFIG_DIR='${account.configDirEnv.replace(/'/g, "'\\''")}' command claude`
      : 'env -u CLAUDE_CONFIG_DIR claude';
  }
  // Pass claudeCmd as the 2nd arg too — Ghostty/cmux build their launch
  // scripts from it (iTerm2/Terminal.app use fullCommand), so the account
  // env prefix must be present in both.
  runCommandInTerminal(`cd "${projectPath}" && ${claudeCmd}`, claudeCmd, projectPath, terminalApp, terminalMode);
};

/**
 * Check if VS Code has a specific project open by reading IDE lock files.
 * Lock files are created by Claude Code extension per VS Code window.
 * Returns true if a lock file with matching workspaceFolders + alive PID exists.
 */
const isVSCodeProjectOpen = (projectPath: string): boolean => {
  const ideDir = path.join(os.homedir(), '.claude', 'ide');
  if (!fs.existsSync(ideDir)) return false;
  try {
    for (const file of fs.readdirSync(ideDir)) {
      if (!file.endsWith('.lock')) continue;
      try {
        const content = JSON.parse(fs.readFileSync(path.join(ideDir, file), 'utf-8'));
        if (!content.pid || !content.workspaceFolders) continue;
        const hasFolder = content.workspaceFolders.some((f: string) => f === projectPath);
        if (!hasFolder) continue;
        // Verify PID is alive
        try { process.kill(content.pid, 0); return true; } catch { /* dead PID */ }
      } catch {}
    }
  } catch {}
  return false;
};

/**
 * Poll IDE lock files until a matching project appears (extension ready).
 * Resolves when lock file with matching workspaceFolders + alive PID is found,
 * or after timeout (fallback).
 */
const waitForVSCodeExtensionReady = (projectPath: string, timeoutMs = 5000, intervalMs = 250): Promise<void> => {
  return new Promise((resolve) => {
    // Quick check — maybe it's already ready
    if (isVSCodeProjectOpen(projectPath)) { resolve(); return; }

    // If IDE lock dir doesn't exist, lock file mechanism may not be available
    // Fall back to fixed 2s delay instead of waiting 8s
    const ideDir = path.join(os.homedir(), '.claude', 'ide');
    if (!fs.existsSync(ideDir)) {
      setTimeout(resolve, 2000);
      return;
    }

    const startTime = Date.now();
    const timer = setInterval(() => {
      if (isVSCodeProjectOpen(projectPath) || Date.now() - startTime > timeoutMs) {
        clearInterval(timer);
        resolve();
      }
    }, intervalMs);
  });
};

/**
 * Open a Claude Code session in VS Code via URI handler.
 * - Active sessions: instant switch via URI handler.
 * - Active + project open: focus window + URI handler (instant switch).
 * - Active + project not open: just open -b (let VS Code restore handle the session tab).
 * - Closed + project open: focus window + 500ms delay + URI handler.
 * - Closed + project not open: open -b + poll extension ready + 500ms delay + URI handler.
 */
export const openSessionInVSCode = (sessionId: string, projectPath?: string, isActiveSession = false): void => {
  const { execFile } = require('child_process');
  const uri = `vscode://anthropic.claude-code/open?session=${sessionId}`;

  if (!projectPath) {
    execFile('open', [uri], (error: any) => {
      if (error) console.error('[openSessionInVSCode] failed:', error);
    });
    return;
  }

  // Check if VS Code already has this project open (extension ready)
  if (isVSCodeProjectOpen(projectPath)) {
    // Focus the correct window, then URI handler after short delay
    const bundleId = getCurrentIDEBundleId();
    execFile('open', ['-b', bundleId, projectPath], () => {
      setTimeout(() => {
        execFile('open', [uri]);
      }, 500);
    });
    return;
  }

  // Project not open → need to open it
  const bundleId = getCurrentIDEBundleId();
  execFile('open', ['-b', bundleId, projectPath], (error: any) => {
    if (error) {
      console.error('[openSessionInVSCode] failed to open project:', error);
      return;
    }

    if (isActiveSession) {
      // Active session: VS Code restore will reopen the session tab automatically.
      // Don't fire URI handler — it would create a duplicate.
      return;
    }

    // Closed session: poll for extension ready, then URI handler to resume
    // Extra 1.5s delay after extension ready to let VS Code finish restoring
    // session tabs (avoids duplicate if tab was restored by VS Code)
    waitForVSCodeExtensionReady(projectPath).then(() => {
      setTimeout(() => {
        execFile('open', [uri]);
      }, 1500);
    });
  });
};

/**
 * "Open" a session that's running in CodeV's embedded terminal.
 * Switches to the Terminal tab instead of opening an external terminal.
 */
export const openSessionInCodeV = (sessionId: string): void => {
  if (codevTerminalCallback) {
    codevTerminalCallback(sessionId);
  }
};

export const openSessionInITerm2 = (
  sessionId: string,
  projectPath: string,
  isActive: boolean,
  activePid?: number,
  terminalMode: string = 'tab',
  customTitle?: string,
  accountLabel?: string,
): void => {
  const { exec } = require('child_process');

  if (isActive && activePid) {
    // Three-layer matching for iTerm2 switch:
    // 1. tty matching (most precise — works when PID-session mapping is correct)
    // 2. title matching (works when session has /rename title)
    // 3. fallback: just activate iTerm2
    const titleMatch = customTitle
      ? `
        -- Layer 2: title matching (fallback for same-cwd sessions)
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if name of s contains "${customTitle.replace(/"/g, '\\"')}" then
                select s
                select t
                set index of w to 1
                return "found-by-title"
              end if
            end repeat
          end repeat
        end repeat`
      : '';

    const tmpScript = '/tmp/codev-iterm-switch.scpt';
    const switchScript = `tell application "iTerm2"
  activate
  ${titleMatch ? `-- Layer 1: title matching (most precise for same-cwd sessions)
  ${titleMatch.trim()}` : ''}
  -- Layer 2: tty matching (fallback)
  set targetTty to do shell script "ps -o tty= -p ${activePid} 2>/dev/null | tr -d '[:space:]'"
  if targetTty is not "" then
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s ends with targetTty then
            select s
            select t
            set index of w to 1
            return "found-by-tty"
          end if
        end repeat
      end repeat
    end repeat
  end if
  return "not found"
end tell`;
    console.log(`[iTerm2] switch: pid=${activePid}, customTitle=${customTitle || 'none'}`);
    fs.writeFileSync(tmpScript, switchScript);
    exec(`osascript ${tmpScript}`, { encoding: 'utf-8' }, (error: any, stdout: string) => {
      console.log(`[iTerm2] switch result: ${(stdout || '').trim()}`, error?.message || '');
      try { fs.unlinkSync(tmpScript); } catch {}
    });
  } else {
    const resumeCmd = buildResumeCommand(sessionId, accountLabel);
    runCommandInTerminal(`cd "${projectPath}" && ${resumeCmd}`, resumeCmd, projectPath, 'iterm2', terminalMode);
  }
};

/**
 * Load custom titles for a list of sessions.
 * Reads each session's JSONL file and greps for "custom-title" entries.
 * Returns a map of sessionId -> customTitle.
 */
export interface PRLinkInfo {
  prNumber: number;
  prUrl: string;
}

/**
 * The one-line "where we are, what's next" recap Claude Code writes into the
 * transcript (`"type":"system","subtype":"away_summary"`) when you come back
 * to an unfocused terminal. Measured 2026-09-05: 65 of 66 non-trivial
 * sessions carry one; the misses are ≤29-line stubs that never reached the
 * three turns it needs. It can be switched off in /config, so it is a
 * primary source with a fallback, never the only one.
 */
export interface RecapInfo {
  text: string;
  /** ISO time it was written — a recap never repeats back-to-back, so it can lag the session's last turn. */
  at: string;
}

export interface SessionEnrichment {
  titles: Map<string, string>;
  branches: Map<string, string>;
  prLinks: Map<string, PRLinkInfo>;
  recaps: Map<string, RecapInfo>;
}

// Cache for branches, PR links, recaps and mined PR references
let cachedBranches: Map<string, string> | null = null;
let cachedPRLinks: Map<string, PRLinkInfo> | null = null;
let cachedRecaps: Map<string, RecapInfo> | null = null;
let cachedPRRefs: Map<string, string[]> | null = null;

// Per-file enrichment scan state: a transcript unchanged since its last scan
// (same mtime+size) is never re-grepped — the stat check IS the freshness
// test. Replaces the 5s wall-clock TTL, which broke once a full scan took
// longer than the TTL itself: the just-written cache was already stale, so
// every popup interaction kicked off another multi-second full rescan.
const enrichedFileState = new Map<string, { mtimeMs: number; size: number }>();
// How far the PR-reference miner has read each transcript (whole lines).
// Transcripts are append-only, so the next pass reads only what was added.
const prRefBytes = new Map<string, number>();
// Serialize scans: concurrent callers queue up and then mostly hit the
// accumulated cache (correct even when they pass different session sets).
let enrichmentQueue: Promise<void> = Promise.resolve();

// --- Persisted cache (issue #134) ---
// Everything above is written to ~/.config/codev/enrichment-cache.json a few
// seconds after a scan changed it, and read back on the first scan of the
// next run, so a launch starts warm: the stat check alone decides what to
// re-read. A cache, not a store — a bad file is a cold start, never a refusal.
let enrichmentLoadedFromDisk = false;
let enrichmentCacheDirty = false;
let enrichmentSaveTimer: ReturnType<typeof setTimeout> | null = null;
const ENRICHMENT_SAVE_DEBOUNCE_MS = 3000;

const currentEnrichmentState = (): EnrichmentState => ({
  fileState: enrichedFileState,
  titles: (cachedCustomTitles ??= new Map()),
  branches: (cachedBranches ??= new Map()),
  prLinks: (cachedPRLinks ??= new Map()),
  recaps: (cachedRecaps ??= new Map()),
  prRefs: (cachedPRRefs ??= new Map()),
  prRefBytes,
});

const ensureEnrichmentLoaded = (): void => {
  if (enrichmentLoadedFromDisk) return;
  enrichmentLoadedFromDisk = true;
  const t0 = Date.now();
  const disk = readEnrichmentCacheFile(getEnrichmentCachePath());
  const mem = currentEnrichmentState();
  // In-memory wins: it is at least as fresh as anything on disk.
  const fill = <K, V>(into: Map<K, V>, from: Map<K, V>) => {
    for (const [k, v] of from) if (!into.has(k)) into.set(k, v);
  };
  fill(mem.fileState, disk.fileState);
  fill(mem.titles, disk.titles);
  fill(mem.branches, disk.branches);
  fill(mem.prLinks, disk.prLinks);
  fill(mem.recaps, disk.recaps);
  fill(mem.prRefs, disk.prRefs);
  fill(mem.prRefBytes, disk.prRefBytes);
  if (disk.fileState.size > 0) {
    console.log(
      `[enrichment] cache loaded: ${disk.fileState.size} sessions in ${Date.now() - t0}ms`,
    );
  }
};

/** Write the cache now if anything changed since the last write. */
export const flushEnrichmentCache = (): void => {
  if (enrichmentSaveTimer) {
    clearTimeout(enrichmentSaveTimer);
    enrichmentSaveTimer = null;
  }
  if (!enrichmentCacheDirty) return;
  enrichmentCacheDirty = false;
  try {
    // Sessions gone from history leave the cache with them.
    const keep = new Set(
      readClaudeSessions(Number.MAX_SAFE_INTEGER).map((s) => s.sessionId),
    );
    writeEnrichmentCacheFile(getEnrichmentCachePath(), currentEnrichmentState(), keep);
  } catch (err) {
    console.error('[enrichment] cache write failed:', err);
  }
};

const scheduleEnrichmentSave = (): void => {
  enrichmentCacheDirty = true;
  if (enrichmentSaveTimer) return;
  enrichmentSaveTimer = setTimeout(() => {
    enrichmentSaveTimer = null;
    flushEnrichmentCache();
  }, ENRICHMENT_SAVE_DEBOUNCE_MS);
};

// Mine PR references from `[from, size)` of a transcript, whole lines only,
// in 4MB chunks with a yield between them so a 65MB cold pass never holds
// the event loop for long. Returns the offset just past the last complete
// line, which is where the next pass starts. Byte-level carry, so a
// multi-byte character split by a chunk boundary is neither mangled nor
// counted twice.
const PR_MINE_CHUNK_BYTES = 4 * 1024 * 1024;
const minePrRefsFromFile = async (
  filePath: string,
  from: number,
  size: number,
  seen: Set<string>,
): Promise<{ refs: string[]; scannedTo: number } | null> => {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const refs: string[] = [];
    let pos = from;
    let carry: Buffer = Buffer.alloc(0);
    while (pos < size) {
      const len = Math.min(PR_MINE_CHUNK_BYTES, size - pos);
      const buf = Buffer.alloc(len);
      // Cast: this @types/node version mistypes Buffer vs ArrayBufferView.
      const { bytesRead } = await fh.read(buf as unknown as Uint8Array, 0, len, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      // Casts: same @types/node Buffer-vs-Uint8Array mismatch as above.
      const chunk = Buffer.concat([carry, buf.subarray(0, bytesRead)] as unknown as Uint8Array[]);
      const lastNl = chunk.lastIndexOf(0x0a);
      if (lastNl === -1) {
        carry = chunk;
        continue;
      }
      refs.push(...minePrRefs(chunk.toString('utf-8', 0, lastNl + 1), seen));
      carry = Buffer.from(chunk.subarray(lastNl + 1) as unknown as Uint8Array);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { refs, scannedTo: pos - carry.length };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
};

// Run per-session async work in bounded batches. ~100 sessions × several
// exec() greps each used to spawn hundreds of concurrent processes at once,
// starving the biggest (busiest) transcripts into the exec timeout — whose
// errors resolve to '' — which is why titles/branches vanished at random.
const runInBatches = async <T>(
  items: T[],
  batchSize: number,
  worker: (item: T) => Promise<void>,
): Promise<void> => {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(worker));
  }
};

// Read the last `bytes` of a file without spawning a process. Async so the
// main process event loop is never blocked by transcript reads.
const readTailUtf8 = async (
  filePath: string,
  bytes: number,
): Promise<string | null> => {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const size = (await fh.stat()).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    // Cast: this @types/node version mistypes Buffer vs ArrayBufferView.
    await fh.read(buf as unknown as Uint8Array, 0, len, size - len);
    return buf.toString('utf-8');
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
};

export const loadSessionEnrichment = async (
  sessions: ClaudeSession[],
): Promise<SessionEnrichment> => {
  ensureEnrichmentLoaded();
  // Accumulator maps persist across calls; scans only fill/refresh entries.
  const titles = (cachedCustomTitles ??= new Map());
  const branches = (cachedBranches ??= new Map());
  const prLinks = (cachedPRLinks ??= new Map());
  const recaps = (cachedRecaps ??= new Map());
  const prRefs = (cachedPRRefs ??= new Map());

  const { execFile } = require('child_process');
  // Shell-free (no interpolated paths anywhere near a shell). Resolves null
  // on real failures (timeout/spawn) so they are distinguishable from
  // no-match: grep exits 1 for "no match", a successful empty read.
  const grepFileP = (
    pattern: string,
    filePath: string,
  ): Promise<string | null> =>
    new Promise((resolve) => {
      execFile(
        'grep',
        [pattern, filePath],
        { encoding: 'utf-8', timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
        (err: any, stdout: string) => {
          if (err && err.code !== 1) resolve(null);
          else resolve(stdout || '');
        },
      );
    });
  const lastLine = (out: string): string => {
    const lines = out.trim().split('\n');
    return lines[lines.length - 1] || '';
  };

  const scan = async () => {
    let changed = false;
    // Re-scan only transcripts that are new or changed since their last scan.
    const toScan: {
      session: ClaudeSession;
      jsonlPath: string;
      mtimeMs: number;
      size: number;
    }[] = [];
    for (const session of sessions) {
      const encodedProject = session.project.replace(/[^a-zA-Z0-9-]/g, '-');
      const jsonlPath = path.join(
        getProjectsDir(session.accountDir),
        encodedProject,
        `${session.sessionId}.jsonl`,
      );
      let stat: fs.Stats;
      try {
        stat = fs.statSync(jsonlPath);
      } catch {
        continue;
      }
      const prev = enrichedFileState.get(session.sessionId);
      // A file whose miner pass failed has state but no offset; it is
      // re-read rather than skipped forever.
      if (
        prev &&
        prev.mtimeMs === stat.mtimeMs &&
        prev.size === stat.size &&
        prRefBytes.has(session.sessionId)
      ) {
        continue;
      }
      toScan.push({
        session,
        jsonlPath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    }

    await runInBatches(
      toScan,
      25,
      async ({ session, jsonlPath, mtimeMs, size }) => {
        // Title, ai-title, and PR-link greps run in parallel; the branch comes
        // from an in-process tail read (~256KB reaches far beyond the old
        // 50-line window — an active session's tail is often tool output with
        // no gitBranch field: measured tail -5 hit 0, tail -20 hit 12).
        const [titleOutput, aiTitleOutput, prLinkOutput, recapOutput, tailOutput] =
          await Promise.all([
            grepFileP('"type":"custom-title"', jsonlPath),
            grepFileP('"type":"ai-title"', jsonlPath),
            grepFileP('"type":"pr-link"', jsonlPath),
            grepFileP('"subtype":"away_summary"', jsonlPath),
            readTailUtf8(jsonlPath, 256 * 1024),
          ]);

        // Priority: custom-title > ai-title
        if (titleOutput) {
          try {
            const parsed = JSON.parse(lastLine(titleOutput));
            const title = (parsed.customTitle || '')
              .replace(/^"|"$/g, '')
              .trim();
            if (title) {
              titles.set(session.sessionId, title);
            }
          } catch {}
        }
        if (!titles.has(session.sessionId) && aiTitleOutput) {
          try {
            const parsed = JSON.parse(lastLine(aiTitleOutput));
            const title = (parsed.aiTitle || '').trim();
            if (title) {
              titles.set(session.sessionId, title);
            }
          } catch {}
        }

        if (tailOutput) {
          const all = [...tailOutput.matchAll(/"gitBranch":"([^"]*)"/g)];
          const branch = all.length > 0 ? all[all.length - 1][1] : '';
          if (branch && branch !== 'HEAD') {
            branches.set(session.sessionId, branch);
          } else if (branch === 'HEAD') {
            // Explicit detached HEAD: drop the stale branch. A tail with NO
            // gitBranch line at all keeps the old value on purpose — it is
            // usually transient tool output (measured), not a branch change.
            branches.delete(session.sessionId);
          }
        }

        if (prLinkOutput) {
          try {
            const parsed = JSON.parse(lastLine(prLinkOutput));
            if (parsed.prNumber && parsed.prUrl) {
              prLinks.set(session.sessionId, {
                prNumber: parsed.prNumber,
                prUrl: parsed.prUrl,
              });
            }
          } catch {}
        }

        if (recapOutput) {
          try {
            const parsed = JSON.parse(lastLine(recapOutput));
            // The line ends with a UI hint that is not part of the summary.
            const text = String(parsed.content || '')
              .replace(/\s*\(disable recaps in \/config\)\s*$/, '')
              .trim();
            if (text) {
              recaps.set(session.sessionId, {
                text,
                at: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
              });
            }
          } catch {
            // A malformed recap line is skipped; the session keeps its
            // previous recap, if any.
          }
        }

        // PR references the assistant mentioned (issue #140): incremental
        // from the last offset; from the start when the file shrank (a
        // rewritten transcript), in which case the old references go too.
        const id = session.sessionId;
        const prevBytes = prRefBytes.get(id) ?? 0;
        const from = prevBytes <= size ? prevBytes : 0;
        const known = from === 0 ? [] : (prRefs.get(id) ?? []);
        const mined = await minePrRefsFromFile(jsonlPath, from, size, new Set(known));
        if (mined) {
          const all = [...known, ...mined.refs];
          if (all.length > 0) prRefs.set(id, all);
          else prRefs.delete(id);
          prRefBytes.set(id, mined.scannedTo);
        }

        // Mark fresh ONLY when every read succeeded — a timed-out or failed
        // pass stays unrecorded so the next call retries it.
        if (
          titleOutput !== null &&
          aiTitleOutput !== null &&
          prLinkOutput !== null &&
          recapOutput !== null &&
          tailOutput !== null
        ) {
          enrichedFileState.set(id, { mtimeMs, size });
          changed = true;
        }
      },
    );
    if (changed) scheduleEnrichmentSave();
  };

  enrichmentQueue = enrichmentQueue.then(scan, scan);
  await enrichmentQueue;
  return { titles, branches, prLinks, recaps };
};

/**
 * One pass over EVERY session in history (issue #140, "one background full
 * scan"), in small chunks with a pause between them so foreground calls —
 * which share the scan queue — interleave rather than wait. With the
 * persisted cache this is a stat pass on the second launch; the first one
 * reads every transcript once. Runs at most once per process.
 */
let backgroundScanStarted = false;
export const runBackgroundEnrichmentScan = async (
  opts: { chunk?: number; pauseMs?: number } = {},
): Promise<{ sessions: number; ms: number } | null> => {
  if (backgroundScanStarted) return null;
  backgroundScanStarted = true;
  const chunk = opts.chunk ?? 10;
  const pauseMs = opts.pauseMs ?? 400;
  const t0 = Date.now();
  const all = readClaudeSessions(Number.MAX_SAFE_INTEGER);
  for (let i = 0; i < all.length; i += chunk) {
    await loadSessionEnrichment(all.slice(i, i + chunk));
    await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
  }
  const ms = Date.now() - t0;
  console.log(`[enrichment] background scan: ${all.length} sessions in ${ms}ms`);
  return { sessions: all.length, ms };
};

/**
 * Where a session's transcript is, or null when no account has it. Tries the
 * account history knows the session by, then the account a saved list
 * captured, then every account — a `/branch` child is in no history yet.
 */
export const findTranscriptPath = (
  sessionId: string,
  project: string,
  accountLabel?: string,
): string | null => {
  if (!/^[0-9a-f-]+$/i.test(sessionId)) return null;
  const encodedProject = project.replace(/[^a-zA-Z0-9-]/g, '-');
  const known = readClaudeSessions(Number.MAX_SAFE_INTEGER).find(
    (s) => s.sessionId === sessionId,
  );
  const dirs = new Set(
    [
      known?.accountDir,
      accountLabel ? getAccountByLabel(accountLabel).dir : undefined,
      ...getScannableAccounts().map((a) => a.dir),
    ].filter((d): d is string => !!d),
  );
  for (const dir of dirs) {
    const p = path.join(getProjectsDir(dir), encodedProject, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
  }
  return null;
};

export interface OpenListMember {
  sessionId: string;
  project: string;
  accountLabel?: string;
  title?: string;
}

export interface OpenListMembersResult {
  opened: string[];
  skipped: { sessionId: string; reason: string }[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Sessions a list-open is launching right now. A second invocation that
// overlaps the first (the renderer disables the button, but the IPC does not
// know that) must not launch the same session again before it registers.
const membersInFlight = new Set<string>();

const runningSessionIds = (): Set<string> => {
  const running = new Set<string>();
  for (const reg of readSessionRegistrations()) {
    try {
      process.kill(reg.pid, 0);
      running.add(reg.sessionId);
    } catch {
      // dead pid: a stale registration, not a running session
    }
  }
  return running;
};

/**
 * Resume the members of a saved list that are not running (issue #145:
 * after a reboot, after closing everything to reclaim memory, or to move the
 * set to another terminal app). The renderer already dropped the running
 * ones by the ps join; the registrations are checked again here because the
 * renderer's report can be seconds old. Launches are staggered — twenty
 * osascripts in one tick is rough on the terminal app — and a member whose
 * project folder or transcript is gone is reported, not launched (`cd` would
 * fail and `claude --resume` would then look in the wrong project).
 */
export const openSessionListMembers = async (
  members: OpenListMember[],
  terminalApp: string,
  terminalMode: string,
  staggerMs = 700,
): Promise<OpenListMembersResult> => {
  const result: OpenListMembersResult = { opened: [], skipped: [] };
  for (const m of members) {
    const id = m.sessionId;
    const skip = (reason: string) => result.skipped.push({ sessionId: id, reason });
    // Re-read per launch: the previous launch may have registered by now.
    if (runningSessionIds().has(id) || membersInFlight.has(id)) {
      skip('already running');
      continue;
    }
    if (!m.project || !fs.existsSync(m.project)) {
      skip('project folder missing');
      continue;
    }
    if (!isSafeLaunchPath(m.project)) {
      skip('unsafe project path');
      continue;
    }
    if (m.accountLabel && !findAccountByLabel(m.accountLabel)) {
      skip(`unknown account "${m.accountLabel}"`);
      continue;
    }
    if (!findTranscriptPath(id, m.project, m.accountLabel)) {
      skip('transcript missing');
      continue;
    }
    // Claimed BEFORE the stagger wait: an overlapping call arriving during
    // the wait must see this session as taken.
    membersInFlight.add(id);
    try {
      if (result.opened.length > 0) await sleep(staggerMs);
      await openSession(
        id,
        m.project,
        false,
        undefined,
        terminalApp,
        terminalMode,
        m.title,
        m.accountLabel,
      );
      result.opened.push(id);
    } finally {
      // Long enough for the new process to write its registration.
      setTimeout(() => membersInFlight.delete(id), 10000);
    }
  }
  return result;
};

/**
 * Load last assistant response for active sessions.
 * Uses tail -n 100 to read the end of the JSONL file (fast even on 80MB files).
 * Benchmark: 100 sessions parallel via Promise.all = ~150ms. tail -n 100 finds same hit rate as -n 200.
 * Returns a map of sessionId -> last assistant text.
 */
export const loadLastAssistantResponses = async (
  sessions: ClaudeSession[]
): Promise<Map<string, string>> => {
  const { exec } = require('child_process');
  const execPromise = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { encoding: 'utf-8', timeout: 5000, maxBuffer: 10 * 1024 * 1024 }, (err: any, stdout: string) => {
        resolve(err ? '' : stdout);
      });
    });

  const responses = new Map<string, string>();
  await runInBatches(sessions, 25, async (session) => {
    const encodedProject = session.project.replace(/[^a-zA-Z0-9-]/g, '-');
    const jsonlPath = path.join(
      getProjectsDir(session.accountDir),
      encodedProject,
      `${session.sessionId}.jsonl`,
    );

    if (!fs.existsSync(jsonlPath)) return;

    const output = await execPromise(`tail -n 100 "${jsonlPath}" | grep '"type":"assistant"' | tail -1`);
    if (!output.trim()) return;

    try {
      const obj = JSON.parse(output.trim());
      const content = obj?.message?.content;
      if (!Array.isArray(content)) return;

      // Find last text block in the assistant message (search from end)
      for (let i = content.length - 1; i >= 0; i--) {
        if (content[i]?.type === 'text' && content[i]?.text) {
          const text = content[i].text.trim();
          if (text) {
            responses.set(session.sessionId, text);
            return;
          }
        }
      }
    } catch {
      // skip parse errors
    }
  });

  return responses;
};

/**
 * Open a Claude Code session in Ghostty.
 * Full AppleScript support: working directory matching, focus, new tab with command.
 */
export const openSessionInGhostty = (
  sessionId: string,
  projectPath: string,
  isActive: boolean,
  terminalMode: string = 'tab',
  customTitle?: string,
  accountLabel?: string,
): void => {
  const { exec } = require('child_process');

  if (isActive) {
    // Two-layer matching: title first (precise), then cwd fallback
    const titleMatch = customTitle
      ? `
  -- Layer 1: title matching
  repeat with w in windows
    repeat with t in tabs of w
      repeat with term in terminals of t
        if name of term contains "${customTitle.replace(/"/g, '\\"')}" then
          focus term
          return "found-by-title"
        end if
      end repeat
    end repeat
  end repeat`
      : '';

    const tmpScript = '/tmp/codev-ghostty-switch.scpt';
    const switchScript = `tell application "Ghostty"
  activate
  ${titleMatch}
  -- Layer 2: cwd matching (fallback)
  repeat with w in windows
    repeat with t in tabs of w
      repeat with term in terminals of t
        if working directory of term is "${projectPath}" then
          focus term
          return "found-by-cwd"
        end if
      end repeat
    end repeat
  end repeat
  return "not found"
end tell`;
    console.log(`[ghostty] switch: customTitle=${customTitle || 'none'}`);
    fs.writeFileSync(tmpScript, switchScript);
    exec(`osascript ${tmpScript}`, { encoding: 'utf-8', timeout: 5000 }, (error: any, stdout: string) => {
      const result = (stdout || '').trim();
      console.log('[ghostty] switch result:', result);
      if (result === 'not found') {
        copyResumeCommand(sessionId, projectPath, accountLabel);
      }
      try { fs.unlinkSync(tmpScript); } catch {}
    });
  } else {
    const resumeCmd = buildResumeCommand(sessionId, accountLabel);
    runCommandInTerminal(`cd "${projectPath}" && ${resumeCmd}`, resumeCmd, projectPath, 'ghostty', terminalMode);
  }
};

/**
 * Open a Claude Code session in macOS Terminal.app.
 * Similar to iTerm2 but simpler structure: window → tab (no session layer).
 * TTY matching works via `tty of tab`. Uses `do script` for command execution.
 */
export const openSessionInTerminalApp = (
  sessionId: string,
  projectPath: string,
  isActive: boolean,
  activePid?: number,
  terminalMode: string = 'tab',
  customTitle?: string,
  accountLabel?: string,
): void => {
  const { exec } = require('child_process');

  if (isActive && activePid) {
    // Two-layer matching: title first, then TTY
    const titleMatch = customTitle
      ? `
  -- Layer 1: title matching
  repeat with w in windows
    repeat with t in tabs of w
      if custom title of t contains "${customTitle.replace(/"/g, '\\"')}" then
        set selected tab of w to t
        set index of w to 1
        return "found-by-title"
      end if
    end repeat
  end repeat`
      : '';

    const tmpScript = '/tmp/codev-terminal-switch.scpt';
    const switchScript = `tell application "Terminal"
  activate
  ${titleMatch}
  -- Layer 2: TTY matching
  set targetTty to do shell script "ps -o tty= -p ${activePid} 2>/dev/null | tr -d '[:space:]'"
  if targetTty is not "" then
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t ends with targetTty then
          set selected tab of w to t
          set index of w to 1
          return "found-by-tty"
        end if
      end repeat
    end repeat
  end if
  return "not found"
end tell`;
    console.log(`[Terminal.app] switch: pid=${activePid}, customTitle=${customTitle || 'none'}`);
    fs.writeFileSync(tmpScript, switchScript);
    exec(`osascript ${tmpScript}`, { encoding: 'utf-8', timeout: 5000 }, (error: any, stdout: string) => {
      console.log(`[Terminal.app] switch result: ${(stdout || '').trim()}`, error?.message || '');
      try { fs.unlinkSync(tmpScript); } catch {}
    });
  } else {
    const resumeCmd = buildResumeCommand(sessionId, accountLabel);
    runCommandInTerminal(`cd "${projectPath}" && ${resumeCmd}`, resumeCmd, projectPath, 'terminal', terminalMode);
  }
};

/**
 * Open a Claude Code session in cmux.
 * Requires cmux socket mode set to 'automation' or 'allowAll'.
 * Falls back to clipboard if socket access denied.
 */
const CMUX_CLI = '/Applications/cmux.app/Contents/Resources/bin/cmux';

export const openSessionInCmux = (
  sessionId: string,
  projectPath: string,
  isActive: boolean,
  activePid?: number,
  customTitle?: string,
  accountLabel?: string,
): void => {
  const { exec } = require('child_process');
  const command = `cd "${projectPath}" && ${buildResumeCommand(sessionId, accountLabel)}`;

  console.log('[cmux] openSession:', { sessionId, projectPath, isActive, activePid, customTitle });
  if (isActive) {
    // NOTE: cmux has AppleScript dictionary with terminal.workingDirectory and focus,
    // but testing shows count windows returns 0 — AppleScript interface may be buggy.
    // Using CLI (sidebar-state + tree) approach instead.
    //
    // Three-layer matching (same concept as iTerm2):
    // Layer 1: Title matching — match /rename custom title against surface titles in tree output
    // Layer 2: TTY matching — match process TTY against surface tty= field (requires cmux v0.63+)
    // Layer 3: CWD fallback — sidebar-state cwd/focused_cwd, then project name in surface title
    const execPromise = (cmd: string): Promise<string> =>
      new Promise((resolve) => {
        exec(cmd, { encoding: 'utf-8', timeout: 3000, maxBuffer: 1024 * 1024 }, (_e: any, out: string) => resolve(out || ''));
      });

    const selectAndActivate = async (wsId: string, surfaceId?: string) => {
      // select-workspace must come first — focus-panel only works on the active workspace
      await execPromise(`${CMUX_CLI} select-workspace --workspace ${wsId}`);
      if (surfaceId) {
        await execPromise(`${CMUX_CLI} focus-panel --panel ${surfaceId} --workspace ${wsId}`);
      }
      exec('osascript -e \'tell application "cmux" to activate\'');
    };

    (async () => {
      // Single tree --all call for title matching, project name fallback, and workspace ID extraction.
      const treeOutput = await execPromise(`${CMUX_CLI} tree --all 2>/dev/null`);
      if (!treeOutput) {
        copyResumeCommand(sessionId, projectPath, accountLabel);
        exec('osascript -e \'tell application "cmux" to activate\'');
        return;
      }

      // Parse tree into workspace→surface structure for precise matching.
      // Each workspace line is followed by its surface lines.
      const treeLines = treeOutput.split('\n');
      let currentWorkspace: string | null = null;
      const parsedTree: { wsId: string; surfaces: { surfaceId: string; title: string; tty: string }[] }[] = [];
      for (const line of treeLines) {
        const wsMatch = line.match(/workspace (workspace:\d+)/);
        if (wsMatch) {
          currentWorkspace = wsMatch[1];
          parsedTree.push({ wsId: currentWorkspace, surfaces: [] });
        }
        const surfaceMatch = line.match(/surface (surface:\d+)/);
        if (surfaceMatch && parsedTree.length > 0) {
          const titleMatch = line.match(/\[terminal\]\s+"(.+?)"\s*(\[|◀|tty=|$)/);
          const ttyMatch = line.match(/tty=(\S+)/);
          parsedTree[parsedTree.length - 1].surfaces.push({
            surfaceId: surfaceMatch[1],
            title: titleMatch ? titleMatch[1] : line,
            tty: ttyMatch ? ttyMatch[1] : '',
          });
        }
      }

      // Layer 1: Title matching (most precise for same-cwd + multi-tab)
      if (customTitle) {
        const titleLower = customTitle.toLowerCase();
        for (const ws of parsedTree) {
          for (const surface of ws.surfaces) {
            if (surface.title.toLowerCase().includes(titleLower)) {
              console.log('[cmux] matched surface by title:', surface.surfaceId, 'in', ws.wsId);
              await selectAndActivate(ws.wsId, surface.surfaceId);
              return;
            }
          }
        }
      }

      // Layer 2: TTY matching (precise, even without /rename — requires cmux v0.63+ with tty= in tree)
      if (activePid) {
        const ttyOutput = (await execPromise(`ps -o tty= -p ${activePid} 2>/dev/null`)).trim();
        if (ttyOutput) {
          for (const ws of parsedTree) {
            for (const surface of ws.surfaces) {
              if (surface.tty && surface.tty.endsWith(ttyOutput)) {
                console.log('[cmux] matched surface by TTY:', surface.surfaceId, 'in', ws.wsId, 'tty=', surface.tty);
                await selectAndActivate(ws.wsId, surface.surfaceId);
                return;
              }
            }
          }
        }
      }

      // Layer 3a: CWD matching via sidebar-state (parallel)
      const wsIds = parsedTree.map(w => w.wsId);
      if (wsIds.length > 0) {
        const cwdResults = await Promise.all(wsIds.map(async (wsId: string) => {
          const state = await execPromise(`${CMUX_CLI} sidebar-state --workspace ${wsId} 2>/dev/null`);
          const cwdMatch = state.match(/^cwd=(.+)$/m);
          const focusedCwdMatch = state.match(/^focused_cwd=(.+)$/m);
          return { wsId, cwd: cwdMatch?.[1], focusedCwd: focusedCwdMatch?.[1] };
        }));

        const cwdHit = cwdResults.find((r: any) => r.cwd === projectPath || r.focusedCwd === projectPath);
        if (cwdHit) {
          console.log('[cmux] matched workspace by cwd:', cwdHit.wsId);
          await selectAndActivate(cwdHit.wsId);
          return;
        }
      }

      // Layer 3b: Project name fallback from parsed tree (surface title contains folder name)
      const projectName = path.basename(projectPath);
      if (projectName && projectName !== path.basename(os.homedir())) {
        const projectNameLower = projectName.toLowerCase();
        for (const ws of parsedTree) {
          for (const surface of ws.surfaces) {
            if (surface.title.toLowerCase().includes(projectNameLower)) {
              console.log('[cmux] matched by surface title (project name):', surface.surfaceId, 'in', ws.wsId);
              await selectAndActivate(ws.wsId, surface.surfaceId);
              return;
            }
          }
        }
      }

      console.log('[cmux] no match found, activating cmux');
      exec('osascript -e \'tell application "cmux" to activate\'');
    })();
  } else {
    const resumeCmd = buildResumeCommand(sessionId, accountLabel);
    runCommandInTerminal(`cd "${projectPath}" && ${resumeCmd}`, resumeCmd, projectPath, 'cmux');
  }
};

/**
 * Copy resume command to clipboard (fallback for unsupported terminals)
 */
export const copyResumeCommand = (
  sessionId: string,
  projectPath: string,
  accountLabel?: string,
): string => {
  const command = `cd "${projectPath}" && ${buildResumeCommand(sessionId, accountLabel)}`;
  const { execFileSync } = require('child_process');
  execFileSync('pbcopy', { input: command });
  return command;
};
