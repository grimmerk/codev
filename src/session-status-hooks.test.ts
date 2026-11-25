import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_SCRIPT } from './session-status-hooks';

// The status hook is a bash script that Claude Code runs on every prompt,
// stop and permission request, and waits for. These tests run the real
// script with /bin/bash (3.2 on macOS, 5.x on the Linux CI runner) in a
// throw-away HOME.
let home: string;
let script: string;

const statusDir = () => path.join(home, '.claude', 'codev-status');
const run = (input: object | string, env: Record<string, string> = {}) =>
  execFileSync('/bin/bash', [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env },
  });
const status = (sid: string) =>
  JSON.parse(fs.readFileSync(path.join(statusDir(), `${sid}.json`), 'utf-8'));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-hook-'));
  script = path.join(home, 'hook.sh');
  fs.writeFileSync(script, HOOK_SCRIPT, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('codev-status-hook.sh', () => {
  it('writes the status of each event with the time and the cwd', () => {
    // Claude Code's field order: session_id, transcript_path, cwd, …, hook_event_name, prompt.
    const base = { session_id: 's1', transcript_path: '/t.jsonl', cwd: '/Users/a/my proj ü' };
    const cases: [string, string][] = [
      ['UserPromptSubmit', 'working'],
      ['SubagentStart', 'working'],
      ['Stop', 'idle'],
      ['PermissionRequest', 'needs-attention'],
      ['Notification', 'unknown'],
    ];
    for (const [event, want] of cases) {
      const before = Math.floor(Date.now() / 1000);
      run({ ...base, hook_event_name: event, prompt: 'say "cwd":"/elsewhere"' });
      const s = status('s1');
      expect(s.status).toBe(want);
      expect(s.cwd).toBe('/Users/a/my proj ü');
      expect(s.timestamp).toBeGreaterThanOrEqual(before);
      expect(s.timestamp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
    }
    // The temp file was renamed into place, not left behind.
    expect(fs.readdirSync(statusDir()).sort()).toEqual(['s1.json']);
  });

  it('removes the status file at SessionEnd, and writes nothing without a session id', () => {
    run({ session_id: 's2', cwd: '/p', hook_event_name: 'Stop' });
    expect(fs.existsSync(path.join(statusDir(), 's2.json'))).toBe(true);
    run({ session_id: 's2', cwd: '/p', hook_event_name: 'SessionEnd' });
    expect(fs.existsSync(path.join(statusDir(), 's2.json'))).toBe(false);
    run({ cwd: '/p', hook_event_name: 'Stop' });
    expect(fs.readdirSync(statusDir())).toEqual([]);
  });

  it('indexes a VS Code session once', () => {
    const vs = { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' };
    run({ session_id: 's3', cwd: '/v', hook_event_name: 'UserPromptSubmit' }, vs);
    run({ session_id: 's3', cwd: '/v', hook_event_name: 'Stop' }, vs);
    const lines = fs
      .readFileSync(path.join(statusDir(), 'vscode-sessions.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([{ sessionId: 's3', cwd: '/v', timestamp: expect.any(Number) }]);
  });

  it('starts no process but date and mv once the status directory exists', () => {
    // Claude Code waits for this hook on every prompt, and on a machine short
    // of memory each process start costs hundreds of ms: the old script's
    // ~20 starts (cat; grep, head and cut per field; sed, mkdir) passed its 5 s
    // timeout. A PATH holding only date and mv makes any other command fail.
    fs.mkdirSync(statusDir(), { recursive: true });
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    for (const cmd of ['date', 'mv']) {
      const real = execFileSync('/bin/bash', ['-c', `command -v ${cmd}`]).toString().trim();
      fs.symlinkSync(real, path.join(bin, cmd));
    }
    run({ session_id: 's4', cwd: '/q', hook_event_name: 'UserPromptSubmit' }, { PATH: bin });
    expect(status('s4')).toMatchObject({ status: 'working', cwd: '/q' });
  });
});
