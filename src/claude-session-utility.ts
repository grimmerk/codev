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

export const detectActiveSessions = async (): Promise<Map<string, number>> => {
  const now = Date.now();
  if (cachedActiveMap && (now - activeCacheTimestamp) < ACTIVE_CACHE_TTL_MS) {
    return cachedActiveMap;
  }

  const { exec } = require('child_process');
  const execPromise = (cmd: string): Promise<string> =>
    new Promise((resolve) => {
      exec(cmd, { encoding: 'utf-8', timeout: 3000 }, (err: any, stdout: string) => {
        resolve(err ? '' : stdout);
      });
    });

  const activeMap = new Map<string, number>();
  // Track which session IDs are already claimed to avoid duplicate assignment
  const claimedSessionIds = new Set<string>();

  try {
    const output = await execPromise(
      'ps aux | grep -E "[c]laude" | grep -v "Claude.app" | grep -v "claude-history" | grep -v "ClaudeHistory" | grep -v "node"'
    );
    if (!output) {
      cachedActiveMap = activeMap;
      activeCacheTimestamp = now;
      return activeMap;
    }

    // First pass: handle processes with explicit --resume <id>
    const cwdProcesses: { pid: number; line: string }[] = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;

      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (!pid) continue;

      const resumeMatch = line.match(/--resume\s+([a-f0-9-]{36})/);
      if (resumeMatch) {
        activeMap.set(resumeMatch[1], pid);
        claimedSessionIds.add(resumeMatch[1]);
        continue;
      }

      if (line.includes('claude')) {
        cwdProcesses.push({ pid, line });
      }
    }

    // Second pass: handle claude -r processes (no explicit session ID)
    // Use lsof to find cwd, then match to unclaimed sessions
    const allSessions = readClaudeSessions(500);
    for (const { pid } of cwdProcesses) {
      const cwdOutput = await execPromise(`lsof -p ${pid} -Fn 2>/dev/null | grep "^n/" | head -1`);
      const cwdMatch = cwdOutput.match(/^n(.+)$/m);
      if (cwdMatch) {
        const cwd = cwdMatch[1];
        // Find the first unclaimed session with this cwd
        const match = allSessions.find((s) => s.project === cwd && !claimedSessionIds.has(s.sessionId));
        if (match) {
          activeMap.set(match.sessionId, pid);
          claimedSessionIds.add(match.sessionId);
        }
      }
    }
  } catch {
    // ignore
  }

  cachedActiveMap = activeMap;
  activeCacheTimestamp = now;
  return activeMap;
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
      openSessionInCmux(sessionId, projectPath, isActive, activePid);
      break;
    case 'ghostty':
      openSessionInGhostty(sessionId, projectPath, isActive, terminalMode);
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
): void => {
  const { exec } = require('child_process');

  if (isActive) {
    // Switch to existing terminal by matching working directory
    const tmpScript = '/tmp/codev-ghostty-switch.scpt';
    const switchScript = `tell application "Ghostty"
  activate
  repeat with w in windows
    repeat with t in tabs of w
      repeat with term in terminals of t
        if working directory of term is "${projectPath}" then
          focus term
          return "found"
        end if
      end repeat
    end repeat
  end repeat
  return "not found"
end tell`;
    fs.writeFileSync(tmpScript, switchScript);
    exec(`osascript ${tmpScript}`, { encoding: 'utf-8', timeout: 5000 }, (error: any, stdout: string) => {
      const result = (stdout || '').trim();
      console.log('[ghostty] switch result:', result);
      if (result !== 'found') {
        // Fallback: clipboard + activate
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
): void => {
  const { exec } = require('child_process');
  const command = `cd "${projectPath}" && claude --resume ${sessionId}`;

  console.log('[cmux] openSession:', { sessionId, projectPath, isActive, activePid });
  if (isActive) {
    // NOTE: cmux has AppleScript dictionary with terminal.workingDirectory and focus,
    // but testing shows count windows returns 0 — AppleScript interface may be buggy.
    // Using CLI (sidebar-state + tree) approach instead.
    const execPromise = (cmd: string): Promise<string> =>
      new Promise((resolve) => {
        exec(cmd, { encoding: 'utf-8', timeout: 3000, maxBuffer: 1024 * 1024 }, (_e: any, out: string) => resolve(out || ''));
      });

    (async () => {
      const wsListOutput = await execPromise(`${CMUX_CLI} list-workspaces 2>/dev/null`);
      if (!wsListOutput) {
        copyResumeCommand(sessionId, projectPath);
        exec('osascript -e \'tell application "cmux" to activate\'');
        return;
      }

      const wsIds = wsListOutput.match(/workspace:\d+/g) || [];

      // Pass 1: parallel sidebar-state cwd match
      const cwdResults = await Promise.all(wsIds.map(async (wsId: string) => {
        const state = await execPromise(`${CMUX_CLI} sidebar-state --workspace ${wsId} 2>/dev/null`);
        const cwdMatch = state.match(/^cwd=(.+)$/m);
        const focusedCwdMatch = state.match(/^focused_cwd=(.+)$/m);
        return { wsId, cwd: cwdMatch?.[1], focusedCwd: focusedCwdMatch?.[1] };
      }));

      const cwdHit = cwdResults.find((r: any) => r.cwd === projectPath || r.focusedCwd === projectPath);
      if (cwdHit) {
        console.log('[cmux] matched workspace by cwd:', cwdHit.wsId);
        exec(`${CMUX_CLI} select-workspace --workspace ${cwdHit.wsId}`);
        exec('osascript -e \'tell application "cmux" to activate\'');
        return;
      }

      // Pass 2: tree surface title match
      const projectName = path.basename(projectPath);
      if (projectName && projectName !== path.basename(os.homedir())) {
        const treeOutput = await execPromise(`${CMUX_CLI} tree --all 2>/dev/null`);
        const treeLines = treeOutput.split('\n');
        let currentWorkspace: string | null = null;
        for (const line of treeLines) {
          const wsMatch = line.match(/workspace (workspace:\d+)/);
          if (wsMatch) currentWorkspace = wsMatch[1];
          const surfaceMatch = line.match(/surface (surface:\d+)/);
          if (surfaceMatch && currentWorkspace && line.toLowerCase().includes(projectName.toLowerCase())) {
            console.log('[cmux] matched by tree surface title:', currentWorkspace);
            exec(`${CMUX_CLI} select-workspace --workspace ${currentWorkspace}`);
            exec('osascript -e \'tell application "cmux" to activate\'');
            return;
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
