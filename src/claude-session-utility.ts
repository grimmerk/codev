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

/**
 * Read Claude Code sessions from ~/.claude/history.jsonl
 * Deduplicates by session ID, keeps first prompt display text,
 * uses latest timestamp for sorting (newest first).
 */
export const readClaudeSessions = (limit = 100): ClaudeSession[] => {
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

    const sessions = Array.from(bySession.values())
      .sort((a, b) => b.lastTimestamp - a.lastTimestamp)
      .slice(0, limit)
      .map((s) => ({
        sessionId: s.sessionId,
        project: s.project,
        projectName: path.basename(s.project) || s.project,
        firstUserMessage: s.firstDisplay,
        lastTimestamp: s.lastTimestamp,
        messageCount: s.promptCount,
        isActive: false,
      }));

    return sessions;
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
  const lowerQuery = query.toLowerCase();

  return allSessions
    .filter((s) =>
      s.projectName.toLowerCase().includes(lowerQuery) ||
      s.firstUserMessage.toLowerCase().includes(lowerQuery) ||
      s.project.toLowerCase().includes(lowerQuery)
    )
    .slice(0, limit);
};

/**
 * Detect active Claude Code sessions by checking running processes
 * Returns a Set of active session IDs
 */
export const detectActiveSessions = (): Set<string> => {
  const activeIds = new Set<string>();

  try {
    const { execSync } = require('child_process');
    const output = execSync('pgrep -af "claude"', { encoding: 'utf-8', timeout: 3000 });

    for (const line of output.split('\n')) {
      const match = line.match(/--resume\s+([a-f0-9-]{36})/);
      if (match) {
        activeIds.add(match[1]);
      }
    }
  } catch {
    // pgrep returns exit code 1 if no matches
  }

  return activeIds;
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
): void => {
  const { exec } = require('child_process');

  if (isActive && activePid) {
    // Try to switch to existing iTerm2 tab via tty matching
    const tmpScript = '/tmp/codev-iterm-switch.scpt';
    const switchScript = `set targetTty to do shell script "ps -o tty= -p ${activePid} 2>/dev/null || echo ''"
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
    // Open new tab and run claude --resume
    const command = `cd "${projectPath}" && claude --resume ${sessionId}`;
    const tmpScript = '/tmp/codev-iterm-launch.scpt';
    const launchScript = `tell application "iTerm2"
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
