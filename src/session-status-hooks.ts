/**
 * Session Status Hooks — manages Claude Code hook configuration
 * for detecting session status (working/idle/needs-attention).
 *
 * Hooks write status files to ~/.claude/codev-status/{sessionId}.json
 * CodeV watches this directory via fs.watch for real-time updates.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const STATUS_DIR = path.join(CLAUDE_DIR, 'codev-status');
const HOOK_SCRIPT_PATH = path.join(CLAUDE_DIR, 'codev-status-hook.sh');
const HOOK_MARKER = 'codev-status-hook';

const HOOK_EVENTS = [
  'Stop',
  'UserPromptSubmit',
  'PermissionRequest',
  'SubagentStart',
  'SessionEnd',
];

const VSCODE_INDEX_PATH = path.join(STATUS_DIR, 'vscode-sessions.jsonl');

const HOOK_SCRIPT = `#!/bin/bash
# CodeV session status hook — writes status for CodeV to watch
# Auto-managed by CodeV. Do not edit manually.
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
EVENT=$(echo "$INPUT" | grep -o '"hook_event_name":"[^"]*"' | head -1 | cut -d'"' -f4)
CWD=$(echo "$INPUT" | grep -o '"cwd":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$SESSION_ID" ]; then exit 0; fi

STATUS_DIR="$HOME/.claude/codev-status"
mkdir -p "$STATUS_DIR"

# Track VS Code sessions in index file (for CodeV to discover closed sessions)
if [ "$CLAUDE_CODE_ENTRYPOINT" = "claude-vscode" ]; then
  VS_MARKER="$STATUS_DIR/.vs-$SESSION_ID"
  if [ ! -f "$VS_MARKER" ]; then
    touch "$VS_MARKER"
    SAFE_CWD_VS=$(echo "$CWD" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
    echo "{\\"sessionId\\":\\"$SESSION_ID\\",\\"cwd\\":\\"$SAFE_CWD_VS\\",\\"timestamp\\":$(date +%s)}" >> "$STATUS_DIR/vscode-sessions.jsonl"
  fi
fi

case "$EVENT" in
  UserPromptSubmit|SubagentStart) STATUS="working" ;;
  Stop)                          STATUS="idle" ;;
  PermissionRequest)             STATUS="needs-attention" ;;
  SessionEnd)
    rm -f "$STATUS_DIR/$SESSION_ID.json"
    rm -f "$STATUS_DIR/.vs-$SESSION_ID"
    exit 0 ;;
  *)                             STATUS="unknown" ;;
esac

# Escape CWD for JSON (handle backslashes and double quotes)
SAFE_CWD=$(echo "$CWD" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
# Atomic write via temp file + mv
TMPFILE="$STATUS_DIR/.$SESSION_ID.tmp"
echo "{\\"status\\":\\"$STATUS\\",\\"timestamp\\":$(date +%s),\\"cwd\\":\\"$SAFE_CWD\\"}" > "$TMPFILE"
mv -f "$TMPFILE" "$STATUS_DIR/$SESSION_ID.json"
`;

/**
 * Install hooks into ~/.claude/settings.json (idempotent, merges with existing)
 */
export const installHooks = (): void => {
  // Create hook script
  fs.mkdirSync(path.dirname(HOOK_SCRIPT_PATH), { recursive: true });
  fs.writeFileSync(HOOK_SCRIPT_PATH, HOOK_SCRIPT, { mode: 0o755 });

  // Create status directory
  fs.mkdirSync(STATUS_DIR, { recursive: true });

  // Read existing settings — abort if file exists but can't be parsed (don't overwrite)
  let settings: any = {};
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    }
  } catch {
    // Can't parse existing file — don't risk overwriting user's settings
    return;
  }

  if (!settings.hooks) settings.hooks = {};

  let modified = false;

  for (const event of HOOK_EVENTS) {
    if (!settings.hooks[event]) settings.hooks[event] = [];

    // Check if our hook is already installed
    const hasOurHook = settings.hooks[event].some((entry: any) =>
      entry.hooks?.some((h: any) => h.command === HOOK_SCRIPT_PATH)
    );

    if (!hasOurHook) {
      settings.hooks[event].push({
        matcher: '',
        hooks: [{ type: 'command', command: HOOK_SCRIPT_PATH, timeout: 5 }],
      });
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  }
};

/**
 * Remove our hooks from ~/.claude/settings.json
 */
export const removeHooks = (): void => {
  // Remove hook script
  try { fs.unlinkSync(HOOK_SCRIPT_PATH); } catch {}

  // Remove status files
  try {
    if (fs.existsSync(STATUS_DIR)) {
      for (const f of fs.readdirSync(STATUS_DIR)) {
        fs.unlinkSync(path.join(STATUS_DIR, f));
      }
      fs.rmdirSync(STATUS_DIR);
    }
  } catch {}

  // Remove our entries from settings.json
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return;
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    if (!settings.hooks) return;

    let modified = false;
    for (const event of HOOK_EVENTS) {
      if (!settings.hooks[event]) continue;
      const before = settings.hooks[event].length;
      settings.hooks[event] = settings.hooks[event].filter((entry: any) =>
        !entry.hooks?.some((h: any) => h.command === HOOK_SCRIPT_PATH)
      );
      if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
      }
      if (settings.hooks[event]?.length !== before) modified = true;
    }

    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    if (modified) {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
    }
  } catch {}
};

/**
 * Check if our hooks are currently installed
 */
export const isHooksInstalled = (): boolean => {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return false;
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
    if (!settings.hooks) return false;

    // Check if at least one of our events has our hook
    return HOOK_EVENTS.some(event =>
      settings.hooks[event]?.some((entry: any) =>
        entry.hooks?.some((h: any) => h.command === HOOK_SCRIPT_PATH)
      )
    );
  } catch {
    return false;
  }
};

export type SessionStatus = 'working' | 'idle' | 'needs-attention' | 'unknown' | null;

/**
 * Read VS Code session index (written by hooks when CLAUDE_CODE_ENTRYPOINT=claude-vscode).
 * Returns a Map of sessionId -> cwd.
 */
export const readVSCodeIndex = (): Map<string, string> => {
  const index = new Map<string, string>();
  try {
    if (!fs.existsSync(VSCODE_INDEX_PATH)) return index;
    const content = fs.readFileSync(VSCODE_INDEX_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId && entry.cwd) {
          index.set(entry.sessionId, entry.cwd);
        }
      } catch {}
    }
  } catch {}
  return index;
};

export interface StatusEntry {
  status: SessionStatus;
  timestamp: number; // unix seconds from status file
}

/**
 * Read all status files from codev-status directory
 */
export const readAllStatuses = (): Map<string, StatusEntry> => {
  const statuses = new Map<string, StatusEntry>();
  try {
    if (!fs.existsSync(STATUS_DIR)) return statuses;
    for (const file of fs.readdirSync(STATUS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const sessionId = file.replace('.json', '');
      try {
        const content = JSON.parse(fs.readFileSync(path.join(STATUS_DIR, file), 'utf-8'));
        statuses.set(sessionId, {
          status: content.status as SessionStatus,
          timestamp: content.timestamp || 0,
        });
      } catch {}
    }
  } catch {}
  return statuses;
};

/**
 * Watch the status directory for changes.
 * Returns a cleanup function to stop watching.
 */
export const watchStatusDir = (
  onChange: (statuses: Map<string, StatusEntry>) => void,
): (() => void) => {
  fs.mkdirSync(STATUS_DIR, { recursive: true });

  // Debounce: fs.watch on macOS fires 3-6 times per file change
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = fs.watch(STATUS_DIR, { persistent: false }, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      onChange(readAllStatuses());
    }, 50);
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };
};

/**
 * Scan active sessions' JSONL files to determine initial status
 * (for sessions started before CodeV or before hooks were installed).
 * Reads last ~50 lines of each session's JSONL to check:
 * - Pending AskUserQuestion tool use → needs-attention
 * - Last assistant message with stop_reason "end_turn" → idle
 * - Otherwise → working
 */
export const scanInitialStatuses = async (
  activeSessions: { sessionId: string; project: string }[],
): Promise<Map<string, SessionStatus>> => {
  const { execFile } = require('child_process');
  const tailFile = (filePath: string): Promise<string> =>
    new Promise((resolve) => {
      execFile('tail', ['-n', '50', filePath], { encoding: 'utf-8', timeout: 3000 }, (err: any, stdout: string) => {
        resolve(err ? '' : stdout);
      });
    });

  const statuses = new Map<string, SessionStatus>();
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');

  const startTime = Date.now();

  await Promise.all(activeSessions.map(async (session) => {
    // Already have a status file? Skip.
    const statusFile = path.join(STATUS_DIR, `${session.sessionId}.json`);
    if (fs.existsSync(statusFile)) return;

    // Find JSONL file
    const encodedProject = session.project.replace(/[^a-zA-Z0-9-]/g, '-');
    const jsonlPath = path.join(claudeDir, encodedProject, `${session.sessionId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) return;

    // Read last 50 lines
    const tail = await tailFile(jsonlPath);
    if (!tail.trim()) return;

    const lines = tail.trim().split('\n');

    // Walk backwards to find last assistant message
    let status: SessionStatus = 'working';
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);

        // Check for pending AskUserQuestion
        if (entry.type === 'assistant' && entry.message?.content) {
          const toolUses = entry.message.content
            .filter((c: any) => c.type === 'tool_use' && c.name === 'AskUserQuestion')
            .map((c: any) => c.id);

          if (toolUses.length > 0) {
            // Check if any AskUserQuestion lacks a ToolResult
            const toolResults = new Set<string>();
            for (let j = i + 1; j < lines.length; j++) {
              try {
                const r = JSON.parse(lines[j]);
                if (r.type === 'tool_result' || (r.type === 'user' && r.message?.content)) {
                  const contents = Array.isArray(r.message?.content) ? r.message.content : [];
                  for (const c of contents) {
                    if (c.type === 'tool_result') toolResults.add(c.tool_use_id);
                  }
                }
              } catch {}
            }
            const pending = toolUses.some((id: string) => !toolResults.has(id));
            if (pending) {
              status = 'needs-attention';
              break;
            }
          }

          // Last assistant message with no pending tools → idle
          // (stop_reason may be null/undefined in some JSONL entries)
          status = 'idle';
          break;
        }
      } catch {}
    }

    statuses.set(session.sessionId, status);
  }));

  const elapsed = Date.now() - startTime;
  if (elapsed > 10) {
    console.log(`[session-status] Initial scan: ${activeSessions.length} sessions in ${elapsed}ms`);
  }

  return statuses;
};

/**
 * Clean up stale status files for sessions that are no longer active.
 * Call on startup to prevent accumulation from crashed sessions or missing SessionEnd hooks.
 */
export const cleanupStaleStatuses = (activeSessionIds: Set<string>): void => {
  try {
    if (!fs.existsSync(STATUS_DIR)) return;
    for (const file of fs.readdirSync(STATUS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const sessionId = file.replace('.json', '');
      if (!activeSessionIds.has(sessionId)) {
        try { fs.unlinkSync(path.join(STATUS_DIR, file)); } catch {}
      }
    }
  } catch {}
};

/**
 * Write a status file for a session (used to persist JSONL-scanned statuses).
 */
export const writeStatusFile = (sessionId: string, status: string): void => {
  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    const tmpFile = path.join(STATUS_DIR, `.codev-${sessionId}.tmp`);
    const targetFile = path.join(STATUS_DIR, `${sessionId}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ status, timestamp: Math.floor(Date.now() / 1000), cwd: '' }));
    fs.renameSync(tmpFile, targetFile);
  } catch {}
};

export { STATUS_DIR, HOOK_SCRIPT_PATH };
