/**
 * Claude Code session history reader
 * Reads session metadata from ~/.claude/cache/session-metadata.db
 */

import * as path from 'path';
import * as os from 'os';

// Use the same Database import pattern as vscode-based-ide-utility.ts
const Database = require('better-sqlite3');

export interface ClaudeSession {
  sessionId: string;
  project: string;         // full path, e.g. /Users/grimmer/git/fred-ff
  projectName: string;     // folder name, e.g. fred-ff
  firstUserMessage: string;
  firstTimestamp: string;
  lastTimestamp: string;
  messageCount: number;
  totalTokens: number;
  modelsUsed: string;
  isActive: boolean;       // whether a claude process is running for this session
}

const getSessionDbPath = (): string => {
  return path.join(os.homedir(), '.claude', 'cache', 'session-metadata.db');
};

/**
 * Read Claude Code sessions from session-metadata.db
 * Sorted by last_timestamp descending (most recent first)
 */
export const readClaudeSessions = (limit = 100): ClaudeSession[] => {
  const dbPath = getSessionDbPath();

  try {
    const fs = require('fs');
    if (!fs.existsSync(dbPath)) {
      console.log('Claude session DB not found:', dbPath);
      return [];
    }

    const db = new Database(dbPath, { readonly: true });

    const rows = db
      .prepare(
        `SELECT session_id, project, first_user_message, first_timestamp,
                last_timestamp, message_count, total_tokens, models_used
         FROM session_metadata
         ORDER BY last_timestamp DESC
         LIMIT ?`
      )
      .all(limit);

    db.close();

    return rows.map((row: any) => ({
      sessionId: row.session_id,
      project: row.project,
      projectName: path.basename(row.project),
      firstUserMessage: row.first_user_message || '',
      firstTimestamp: row.first_timestamp || '',
      lastTimestamp: row.last_timestamp || '',
      messageCount: row.message_count || 0,
      totalTokens: row.total_tokens || 0,
      modelsUsed: row.models_used || '',
      isActive: false, // will be set by detectActiveSessions
    }));
  } catch (error) {
    console.error('Error reading Claude sessions:', error);
    return [];
  }
};

/**
 * Search Claude Code sessions using FTS5 index
 */
export const searchClaudeSessions = (query: string, limit = 50): ClaudeSession[] => {
  const dbPath = getSessionDbPath();

  try {
    const fs = require('fs');
    if (!fs.existsSync(dbPath)) return [];

    const db = new Database(dbPath, { readonly: true });

    // FTS5 search on first_user_message
    // Also search project name via LIKE
    const rows = db
      .prepare(
        `SELECT session_id, project, first_user_message, first_timestamp,
                last_timestamp, message_count, total_tokens, models_used
         FROM session_metadata
         WHERE session_id IN (
           SELECT session_id FROM session_fts WHERE session_fts MATCH ?
         ) OR project LIKE ?
         ORDER BY last_timestamp DESC
         LIMIT ?`
      )
      .all(query, `%${query}%`, limit);

    db.close();

    return rows.map((row: any) => ({
      sessionId: row.session_id,
      project: row.project,
      projectName: path.basename(row.project),
      firstUserMessage: row.first_user_message || '',
      firstTimestamp: row.first_timestamp || '',
      lastTimestamp: row.last_timestamp || '',
      messageCount: row.message_count || 0,
      totalTokens: row.total_tokens || 0,
      modelsUsed: row.models_used || '',
      isActive: false,
    }));
  } catch (error) {
    console.error('Error searching Claude sessions:', error);
    return [];
  }
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
      // Match --resume <session-id> pattern
      const match = line.match(/--resume\s+([a-f0-9-]{36})/);
      if (match) {
        activeIds.add(match[1]);
      }
    }
  } catch {
    // pgrep returns exit code 1 if no matches, which is fine
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
    const switchScript = `
      set targetTty to do shell script "ps -o tty= -p ${activePid} 2>/dev/null || echo ''"
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
      end if
    `;
    exec(`osascript -e '${switchScript.replace(/'/g, "'\\''")}'`, (error: any) => {
      if (error) {
        console.error('Error switching to iTerm2 session:', error);
      }
    });
  } else {
    // Open new tab and run claude --resume
    const command = `cd "${projectPath}" && claude --resume ${sessionId}`;
    const launchScript = `
      tell application "iTerm2"
        activate
        tell current window
          create tab with default profile
          tell current session
            write text "${command}"
          end tell
        end tell
      end tell
    `;
    exec(`osascript -e '${launchScript.replace(/'/g, "'\\''")}'`, (error: any) => {
      if (error) {
        console.error('Error launching iTerm2 session:', error);
      }
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
