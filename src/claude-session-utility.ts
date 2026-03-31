/**
 * Claude Code session history reader
 * Primary source: ~/.claude/history.jsonl (real-time, append-only log)
 * Fallback enrichment: ~/.claude/cache/session-metadata.db (cached metadata)
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

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
  terminalApp?: string;    // detected terminal: 'iterm2', 'cmux', 'ghostty', etc.
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
}

const getHistoryPath = (): string => {
  return path.join(os.homedir(), '.claude', 'history.jsonl');
};

// Cache for parsed sessions to avoid re-reading history.jsonl on every keystroke
let cachedSessions: ClaudeSession[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000; // refresh cache after 5 seconds

// Cache for active session detection to avoid spawning processes on every keystroke
let cachedActiveMap: Map<string, number> | null = null;
let activeCacheTimestamp = 0;
const ACTIVE_CACHE_TTL_MS = 5000;

// Cache for custom titles
let cachedCustomTitles: Map<string, string> | null = null;
let titlesCacheTimestamp = 0;

export const invalidateSessionCache = () => {
  cachedSessions = null;
  cachedActiveMap = null;
  cachedCustomTitles = null;
  cachedBranches = null;
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

  const historyPath = getHistoryPath();

  try {
    if (!fs.existsSync(historyPath)) {
      console.log('Claude history.jsonl not found:', historyPath);
      return [];
    }

    const content = fs.readFileSync(historyPath, 'utf-8');
    const bySession = new Map<string, SessionAccum>();

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const raw: HistoryLine = JSON.parse(line);
        if (!raw.sessionId) continue;

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
          });
        }
      } catch {
        // skip malformed lines
      }
    }

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
      }));

    cachedSessions = allSessions;
    cacheTimestamp = now;
    return allSessions.slice(0, limit);
  } catch (error) {
    console.error('Error reading Claude sessions:', error);
    return [];
  }
};

/**
 * Search Claude Code sessions by project name or first message
 */
export const searchClaudeSessions = (query: string, limit = 50): ClaudeSession[] => {
  const allSessions = readClaudeSessions(500);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return allSessions.slice(0, limit);

  return allSessions
    .filter((s) => {
      const searchTarget = `${s.projectName} ${s.project} ${s.firstUserMessage} ${s.lastUserMessage}`.toLowerCase();
      return words.every((word) => searchTarget.includes(word));
    })
    .slice(0, limit);
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
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const titleCache = new Map<string, Map<string, string>>(); // cwd → (sessionId → title)

  const getTitlesForCwd = async (cwd: string): Promise<Map<string, string>> => {
    if (titleCache.has(cwd)) return titleCache.get(cwd)!;
    const titles = new Map<string, string>();
    const candidates = allSessions.filter(s => s.project === cwd);
    const encodedProject = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    await Promise.all(candidates.map(async (session) => {
      const jsonlPath = path.join(claudeDir, encodedProject, `${session.sessionId}.jsonl`);
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
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const titleCache = new Map<string, Map<string, string>>();

  const getTitlesForCwd = async (cwd: string): Promise<Map<string, string>> => {
    if (titleCache.has(cwd)) return titleCache.get(cwd)!;
    const titles = new Map<string, string>();
    const candidates = allSessions.filter(s => s.project === cwd);
    const encodedProject = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    await Promise.all(candidates.map(async (session) => {
      const jsonlPath = path.join(claudeDir, encodedProject, `${session.sessionId}.jsonl`);
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
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  const titleCache = new Map<string, Map<string, string>>();
  const getTitlesForCwd = async (cwd: string): Promise<Map<string, string>> => {
    if (titleCache.has(cwd)) return titleCache.get(cwd)!;
    const titles = new Map<string, string>();
    const encodedProject = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    const projectDir = path.join(claudeDir, encodedProject);
    if (!fs.existsSync(projectDir)) { titleCache.set(cwd, titles); return titles; }
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

  await Promise.all(crossRefTasks);

  // Ghostty + unknown terminals: cwd fallback (no async work, runs after cross-ref)
  for (const [terminal, items] of Object.entries(byTerminal)) {
    if (terminal === 'iterm2' || terminal === 'cmux') continue;
    for (const item of items) {
      const fallback = item.candidates.find(s => !activeMap.has(s.sessionId));
      if (fallback) {
        activeMap.set(fallback.sessionId, item.pid);
      }
    }
  }
};

export const detectActiveSessions = async (): Promise<Map<string, number>> => {
  const now = Date.now();
  if (cachedActiveMap && (now - activeCacheTimestamp) < ACTIVE_CACHE_TTL_MS) {
    return cachedActiveMap;
  }

  const activeMap = new Map<string, number>();
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
    const sessionsDir = path.join(os.homedir(), '.claude', 'sessions');
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir).filter(f => /^\d+\.json$/.test(f));
      const allSessions = readClaudeSessions(500);

      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(sessionsDir, file), 'utf-8');
          const data = JSON.parse(content);
          const pid = data.pid as number;
          const sessionId = data.sessionId as string;
          const cwd = data.cwd as string;
          const entrypoint = data.entrypoint as string;
          if (!pid || !sessionId) continue;

          // Skip non-terminal sessions (VS Code, Claude Desktop) — can't switch to them
          if (entrypoint && entrypoint !== 'cli') continue;

          // Verify process is still alive
          try { process.kill(pid, 0); } catch { continue; }

          // Try direct sessionId match against history.jsonl
          const knownSession = allSessions.find(s => s.sessionId === sessionId);
          if (knownSession) {
            activeMap.set(sessionId, pid);
          } else if (cwd) {
            // sessionId not in history — find session by cwd
            const cwdCandidates = allSessions.filter(s => s.project === cwd && !activeMap.has(s.sessionId));
            if (cwdCandidates.length === 1) {
              activeMap.set(cwdCandidates[0].sessionId, pid);
            } else if (cwdCandidates.length > 1) {
              // Multiple same-cwd candidates — queue for cross-reference
              needsCrossRef.push({ pid, cwd, candidates: cwdCandidates });
            }
          }
        } catch {
          // skip malformed files
        }
      }

      // Cross-reference for PIDs with same-cwd ambiguity.
      // Group by terminal to avoid redundant pgrep/AppleScript/CLI calls.
      if (needsCrossRef.length > 0) {
        await crossRefDisambiguate(needsCrossRef, activeMap, execPromise);
      }
    }

    // Fallback: if sessions/ directory doesn't exist (old Claude Code versions)
    if (!fs.existsSync(sessionsDir)) {
      await detectActiveSessionsLegacy(activeMap);
    }
  } catch {
    // ignore
  }

  cachedActiveMap = activeMap;
  activeCacheTimestamp = now;
  return activeMap;
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
    'ps aux | grep -E "[c]laude" | grep -v "Claude.app" | grep -v "claude-history" | grep -v "ClaudeHistory" | grep -v "node"'
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

  switch (effectiveTerminal) {
    case 'cmux':
      openSessionInCmux(sessionId, projectPath, isActive, activePid, customTitle);
      break;
    case 'ghostty':
      openSessionInGhostty(sessionId, projectPath, isActive, terminalMode, customTitle);
      break;
    case 'iterm2':
    default:
      openSessionInITerm2(sessionId, projectPath, isActive, activePid, terminalMode, customTitle);
      break;
  }
};

/**
 * Open a Claude Code session in iTerm2
 * If the session is already active, switch to its tab
 * Otherwise, open a new tab and run claude --resume
 */
export const openSessionInITerm2 = (
  sessionId: string,
  projectPath: string,
  isActive: boolean,
  activePid?: number,
  terminalMode: string = 'tab',
  customTitle?: string,
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
    // Open new tab or window and run claude --resume
    const command = `cd "${projectPath}" && claude --resume ${sessionId}`;
    const tmpScript = '/tmp/codev-iterm-launch.scpt';
    const launchScript = terminalMode === 'window'
      ? `tell application "iTerm2"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "${command.replace(/"/g, '\\"')}"
  end tell
end tell`
      : `tell application "iTerm2"
  activate
  tell current window
    create tab with default profile
    tell current session
      write text "${command.replace(/"/g, '\\"')}"
    end tell
  end tell
end tell`;
    fs.writeFileSync(tmpScript, launchScript);
    exec(`osascript ${tmpScript}`, (error: any) => {
      if (error) {
        console.error('Error launching iTerm2 session:', error);
      }
      try { fs.unlinkSync(tmpScript); } catch {}
    });
  }
};

/**
 * Load custom titles for a list of sessions.
 * Reads each session's JSONL file and greps for "custom-title" entries.
 * Returns a map of sessionId -> customTitle.
 */
export interface SessionEnrichment {
  titles: Map<string, string>;
  branches: Map<string, string>;
}

// Cache for branches
let cachedBranches: Map<string, string> | null = null;

export const loadSessionEnrichment = async (sessions: ClaudeSession[]): Promise<SessionEnrichment> => {
  const now = Date.now();
  if (cachedCustomTitles && cachedBranches && (now - titlesCacheTimestamp) < CACHE_TTL_MS) {
    return { titles: cachedCustomTitles, branches: cachedBranches };
  }

  const { exec } = require('child_process');
  const execPromise = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { encoding: 'utf-8', timeout: 3000 }, (err: any, stdout: string) => {
        resolve(err ? '' : stdout);
      });
    });

  const titles = new Map<string, string>();
  const branches = new Map<string, string>();
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  const promises = sessions.map(async (session) => {
    const encodedProject = session.project.replace(/[^a-zA-Z0-9-]/g, '-');
    const jsonlPath = path.join(claudeDir, encodedProject, `${session.sessionId}.jsonl`);

    if (!fs.existsSync(jsonlPath)) return;

    // Run title grep and branch tail in parallel for each file
    const [titleOutput, branchOutput] = await Promise.all([
      execPromise(`grep '"type":"custom-title"' "${jsonlPath}" 2>/dev/null | tail -1`),
      execPromise(`tail -n 5 "${jsonlPath}" 2>/dev/null | grep -o '"gitBranch":"[^"]*"' | tail -1`),
    ]);

    if (titleOutput.trim()) {
      try {
        const parsed = JSON.parse(titleOutput.trim());
        const title = (parsed.customTitle || '').replace(/^"|"$/g, '').trim();
        if (title) {
          titles.set(session.sessionId, title);
        }
      } catch {}
    }

    if (branchOutput.trim()) {
      const match = branchOutput.match(/"gitBranch":"([^"]*)"/);
      if (match && match[1] && match[1] !== 'HEAD') {
        branches.set(session.sessionId, match[1]);
      }
    }
  });

  await Promise.all(promises);

  cachedCustomTitles = titles;
  cachedBranches = branches;
  titlesCacheTimestamp = now;
  return { titles, branches };
};

/**
 * Load last assistant response for active sessions.
 * Uses tail -n 200 to read the end of the JSONL file (fast even on 80MB files: ~19ms).
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
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  const promises = sessions.map(async (session) => {
    const encodedProject = session.project.replace(/[^a-zA-Z0-9-]/g, '-');
    const jsonlPath = path.join(claudeDir, encodedProject, `${session.sessionId}.jsonl`);

    if (!fs.existsSync(jsonlPath)) return;

    const output = await execPromise(`tail -n 200 "${jsonlPath}" | grep '"type":"assistant"' | tail -1`);
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

  await Promise.all(promises);
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
        copyResumeCommand(sessionId, projectPath);
      }
      try { fs.unlinkSync(tmpScript); } catch {}
    });
  } else {
    // Launch new tab with command via surface configuration
    // Use initial working directory for cd, and initialInput to type the resume command
    const tmpScript = '/tmp/codev-ghostty-launch.scpt';
    const resumeCmd = `claude --resume ${sessionId}`;
    const launchScript = terminalMode === 'window'
      ? `tell application "Ghostty"
  activate
  set cfg to new surface configuration from {initial working directory:"${projectPath}", initial input:"${resumeCmd}\\n"}
  new window with configuration cfg
end tell`
      : `tell application "Ghostty"
  activate
  set cfg to new surface configuration from {initial working directory:"${projectPath}", initial input:"${resumeCmd}\\n"}
  if (count windows) > 0 then
    new tab in front window with configuration cfg
  else
    new window with configuration cfg
  end if
end tell`;
    fs.writeFileSync(tmpScript, launchScript);
    exec(`osascript ${tmpScript}`, { encoding: 'utf-8', timeout: 5000 }, (error: any) => {
      if (error) {
        console.error('[ghostty] launch error:', error.message);
        // Fallback: clipboard
        copyResumeCommand(sessionId, projectPath);
      }
      try { fs.unlinkSync(tmpScript); } catch {}
    });
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
): void => {
  const { exec } = require('child_process');
  const command = `cd "${projectPath}" && claude --resume ${sessionId}`;

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
        copyResumeCommand(sessionId, projectPath);
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
    // Launch new workspace with command
    const cmuxCmd = `${CMUX_CLI} new-workspace --cwd "${projectPath}" --command "claude --resume ${sessionId}"`;
    console.log('[cmux] launch cmd:', cmuxCmd);
    exec(cmuxCmd,
      { encoding: 'utf-8', timeout: 5000 },
      (error: any, stdout: string, stderr: string) => {
        console.log('[cmux] launch result:', { error: error?.message, stdout, stderr });
        if (error) {
          console.error('cmux new-workspace failed, falling back to clipboard:', error.message);
          copyResumeCommand(sessionId, projectPath);
          exec('osascript -e \'tell application "cmux" to activate\'');
        } else {
          // Select the newly created workspace and activate cmux
          const wsMatch = stdout.match(/workspace:\d+/);
          if (wsMatch) {
            exec(`${CMUX_CLI} select-workspace --workspace ${wsMatch[0]}`);
          }
          exec('osascript -e \'tell application "cmux" to activate\'');
        }
      }
    );
  }
};

/**
 * Copy resume command to clipboard (fallback for unsupported terminals)
 */
export const copyResumeCommand = (sessionId: string, projectPath: string): string => {
  const command = `cd "${projectPath}" && claude --resume ${sessionId}`;
  const { execSync } = require('child_process');
  execSync(`echo "${command}" | pbcopy`);
  return command;
};
