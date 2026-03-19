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

  try {
    const output = await execPromise(
      'ps aux | grep -E "[c]laude" | grep -v "Claude.app" | grep -v "claude-history" | grep -v "ClaudeHistory" | grep -v "node"'
    );
    if (!output) {
      cachedActiveMap = activeMap;
      activeCacheTimestamp = now;
      return activeMap;
    }

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;

      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (!pid) continue;

      const resumeMatch = line.match(/--resume\s+([a-f0-9-]{36})/);
      if (resumeMatch) {
        activeMap.set(resumeMatch[1], pid);
        continue;
      }

      if (line.includes('claude')) {
        const cwdOutput = await execPromise(`lsof -p ${pid} -Fn 2>/dev/null | grep "^n/" | head -1`);
        const cwdMatch = cwdOutput.match(/^n(.+)$/m);
        if (cwdMatch) {
          const cwd = cwdMatch[1];
          const allSessions = readClaudeSessions(500);
          const match = allSessions.find((s) => s.project === cwd);
          if (match) {
            activeMap.set(match.sessionId, pid);
          }
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
export const openSession = (
  sessionId: string,
  projectPath: string,
  isActive: boolean,
  activePid?: number,
  terminalApp: string = 'iterm2',
  terminalMode: string = 'tab',
): void => {
  switch (terminalApp) {
    case 'cmux':
      openSessionInCmux(sessionId, projectPath, isActive, activePid);
      break;
    case 'ghostty':
      openSessionInGhostty(sessionId, projectPath);
      break;
    case 'iterm2':
    default:
      openSessionInITerm2(sessionId, projectPath, isActive, activePid, terminalMode);
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
): void => {
  const { exec } = require('child_process');

  if (isActive && activePid) {
    // Try to switch to existing iTerm2 tab via tty matching
    const tmpScript = '/tmp/codev-iterm-switch.scpt';
    const switchScript = `set targetTty to do shell script "ps -o tty= -p ${activePid} 2>/dev/null | tr -d '[:space:]'"
if targetTty is not "" then
  tell application "iTerm2"
    activate
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s ends with targetTty then
            select s
            select t
            set index of w to 1
            return "found"
          end if
        end repeat
      end repeat
    end repeat
    return "not found"
  end tell
else
  tell application "iTerm2" to activate
end if`;
    fs.writeFileSync(tmpScript, switchScript);
    exec(`osascript ${tmpScript}`, (error: any) => {
      if (error) {
        console.error('Error switching to iTerm2 session:', error);
      }
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
    const encodedProject = session.project.replace(/\//g, '-');
    const jsonlPath = path.join(claudeDir, encodedProject, `${session.sessionId}.jsonl`);

    if (!fs.existsSync(jsonlPath)) return;

    // Run title grep and branch tail in parallel for each file
    const [titleOutput, branchOutput] = await Promise.all([
      execPromise(`grep "custom-title" "${jsonlPath}" 2>/dev/null | tail -1`),
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
    const encodedProject = session.project.replace(/\//g, '-');
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
 * Limited on macOS — no tab-level switching, no new-tab command.
 * Copies resume command to clipboard and activates Ghostty.
 */
export const openSessionInGhostty = (
  sessionId: string,
  projectPath: string,
): void => {
  const { exec } = require('child_process');
  copyResumeCommand(sessionId, projectPath);
  exec('osascript -e \'tell application "Ghostty" to activate\'');
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
    // Get all workspace IDs, then check each one's cwd via sidebar-state
    exec(`${CMUX_CLI} list-workspaces 2>/dev/null`, { encoding: 'utf-8', timeout: 3000, maxBuffer: 1024 * 1024 },
      async (error: any, stdout: string) => {
        if (error || !stdout) {
          copyResumeCommand(sessionId, projectPath);
          exec('osascript -e \'tell application "cmux" to activate\'');
          return;
        }

        const wsIds = stdout.match(/workspace:\d+/g) || [];
        console.log('[cmux] found workspaces:', wsIds.length);

        // Check each workspace's cwd via sidebar-state
        const execPromise = (cmd: string): Promise<string> =>
          new Promise((resolve) => {
            exec(cmd, { encoding: 'utf-8', timeout: 2000 }, (_e: any, out: string) => resolve(out || ''));
          });

        for (const wsId of wsIds) {
          const state = await execPromise(`${CMUX_CLI} sidebar-state --workspace ${wsId} 2>/dev/null`);
          const cwdMatch = state.match(/^cwd=(.+)$/m);
          if (cwdMatch && cwdMatch[1] === projectPath) {
            console.log('[cmux] matched workspace by cwd:', wsId, cwdMatch[1]);
            exec(`${CMUX_CLI} select-workspace --workspace ${wsId}`);
            exec('osascript -e \'tell application "cmux" to activate\'');
            return;
          }
        }

        console.log('[cmux] no workspace cwd match, activating cmux');
        exec('osascript -e \'tell application "cmux" to activate\'');
      }
    );
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
