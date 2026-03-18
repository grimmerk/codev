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
  lastTimestamp: number;    // unix ms
  messageCount: number;
  isActive: boolean;       // whether a claude process is running for this session
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

export const invalidateSessionCache = () => {
  cachedSessions = null;
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
      const searchTarget = `${s.projectName} ${s.project} ${s.firstUserMessage}`.toLowerCase();
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
export const detectActiveSessions = (): Map<string, number> => {
  const activeMap = new Map<string, number>();

  try {
    const { execSync } = require('child_process');
    // Get all claude processes (filter out grep itself and non-CLI processes)
    let output: string;
    try {
      output = execSync(
        'ps aux | grep -E "[c]laude" | grep -v "Claude.app" | grep -v "claude-history" | grep -v "ClaudeHistory" | grep -v "node"',
        { encoding: 'utf-8', timeout: 3000 }
      );
    } catch {
      return activeMap;
    }
    console.log('[detectActiveSessions] found processes:', output.trim().split('\n').length);

    for (const line of output.split('\n')) {
      if (!line.trim()) continue;

      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[1], 10);
      if (!pid) continue;

      // Try to extract session ID from --resume <id>
      const resumeMatch = line.match(/--resume\s+([a-f0-9-]{36})/);
      if (resumeMatch) {
        console.log(`[detectActiveSessions] found --resume session: ${resumeMatch[1]}, pid: ${pid}`);
        activeMap.set(resumeMatch[1], pid);
        continue;
      }
      console.log(`[detectActiveSessions] claude process without --resume ID, pid: ${pid}, cmd: ${line.slice(line.indexOf('claude')).substring(0, 80)}`);

      // Check if this is a claude -r or claude process (without explicit session ID)
      if (line.includes('claude')) {
        // Try to find session ID by checking the process's working directory
        // via lsof, then matching to latest session in history.jsonl
        try {
          const cwdOutput = execSync(`lsof -p ${pid} -Fn 2>/dev/null | grep "^n/" | head -1`, {
            encoding: 'utf-8',
            timeout: 2000,
          });
          const cwdMatch = cwdOutput.match(/^n(.+)$/m);
          if (cwdMatch) {
            const cwd = cwdMatch[1];
            console.log(`[detectActiveSessions] pid ${pid} cwd: ${cwd}`);
            // Find the latest session for this project path from history
            const allSessions = readClaudeSessions(500);
            const match = allSessions.find((s) => s.project === cwd);
            if (match) {
              console.log(`[detectActiveSessions] matched session: ${match.sessionId} for cwd: ${cwd}`);
              activeMap.set(match.sessionId, pid);
            } else {
              console.log(`[detectActiveSessions] no session match for cwd: ${cwd}`);
            }
          }
        } catch {
          // lsof might fail, skip
        }
      }
    }
  } catch {
    // ps/grep returns exit code 1 if no matches
  }

  return activeMap;
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

  console.log(`[openSessionInITerm2] sessionId=${sessionId}, isActive=${isActive}, activePid=${activePid}`);
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
 * Copy resume command to clipboard (fallback for unsupported terminals)
 */
export const copyResumeCommand = (sessionId: string, projectPath: string): string => {
  const command = `cd "${projectPath}" && claude --resume ${sessionId}`;
  const { execSync } = require('child_process');
  execSync(`echo "${command}" | pbcopy`);
  return command;
};
