import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  lastMessages,
  messageFromLine,
  messageFromRecord,
  readLastMessages,
} from './session-transcript';

// Shapes follow real transcript records read on 2026-11-20 (key order
// included); every value is invented.
const SID = '11111111-aaaa-4aaa-8aaa-000000000001';
const AT = '2026-11-01T10:00:00.000Z';

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  parentUuid: null,
  isSidechain: false,
  promptId: 'p1',
  type: 'user',
  message: { role: 'user', content },
  uuid: '00000000-0000-4000-8000-00000000abcd',
  timestamp: AT,
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/Users/dev/git/acme-app',
  sessionId: SID,
  version: '2.1.329',
  gitBranch: 'main',
  ...extra,
});

const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({
  parentUuid: 'x',
  isSidechain: false,
  message: {
    model: 'claude-test',
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content,
  },
  requestId: 'req_1',
  type: 'assistant',
  uuid: '00000000-0000-4000-8000-00000000dcba',
  timestamp: AT,
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/Users/dev/git/acme-app',
  sessionId: SID,
  version: '2.1.329',
  gitBranch: 'main',
  ...extra,
});

describe('messageFromRecord', () => {
  it('takes a typed prompt and an assistant text block', () => {
    expect(messageFromRecord(user('fix the billing bug'))).toEqual({
      role: 'user',
      timestamp: AT,
      text: 'fix the billing bug',
    });
    expect(
      messageFromRecord(assistant([{ type: 'text', text: 'Done — two files.' }])),
    ).toEqual({ role: 'assistant', timestamp: AT, text: 'Done — two files.' });
  });

  it('keeps the text of a prompt that also carries an image', () => {
    expect(
      messageFromRecord(
        user([
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'text', text: 'what is wrong here?' },
        ]),
      )?.text,
    ).toBe('what is wrong here?');
  });

  it('skips tool calls, tool results and thinking', () => {
    expect(
      messageFromRecord(
        assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      ),
    ).toBeNull();
    expect(
      messageFromRecord(
        assistant([{ type: 'thinking', thinking: 'let me think', signature: 'sig' }]),
      ),
    ).toBeNull();
    expect(
      messageFromRecord(
        user([{ tool_use_id: 't1', type: 'tool_result', content: 'a.txt' }], {
          toolUseResult: { stdout: 'a.txt' },
        }),
      ),
    ).toBeNull();
  });

  it('skips what the harness wrote in the user’s name', () => {
    expect(messageFromRecord(user('ok', { isMeta: true }))).toBeNull();
    expect(messageFromRecord(user('summary…', { isCompactSummary: true }))).toBeNull();
    expect(messageFromRecord(user('sub-agent prompt', { isSidechain: true }))).toBeNull();
    expect(
      messageFromRecord(user('<local-command-stdout>Set model</local-command-stdout>')),
    ).toBeNull();
    expect(
      messageFromRecord(user('<task-notification>\n<task-id>x</task-id>')),
    ).toBeNull();
    expect(
      messageFromRecord(user('<system-reminder>\nnote\n</system-reminder>')),
    ).toBeNull();
  });

  it('removes a reminder block but keeps what the user typed around it', () => {
    expect(
      messageFromRecord(
        user('please continue\n<system-reminder>\nnote\n</system-reminder>'),
      )?.text,
    ).toBe('please continue');
    // A slash command the user typed is theirs.
    expect(
      messageFromRecord(user('<command-name>/rename</command-name>'))?.text,
    ).toBe('<command-name>/rename</command-name>');
  });

  it('ignores every other record type and anything that is not a record', () => {
    expect(
      messageFromRecord({ type: 'custom-title', customTitle: 'x', sessionId: SID }),
    ).toBeNull();
    expect(messageFromRecord({ type: 'user' })).toBeNull();
    expect(messageFromRecord(null)).toBeNull();
    expect(messageFromLine('{"type":"user","message":{"content":"cut off')).toBeNull();
    expect(messageFromLine('')).toBeNull();
  });
});

describe('last N', () => {
  const lines = [
    JSON.stringify(user('one')),
    JSON.stringify(assistant([{ type: 'thinking', thinking: 't', signature: 's' }])),
    JSON.stringify(assistant([{ type: 'text', text: 'two' }])),
    'garbage line',
    JSON.stringify(assistant([{ type: 'tool_use', id: 't', name: 'Read', input: {} }])),
    JSON.stringify(user([{ tool_use_id: 't', type: 'tool_result', content: 'x' }])),
    JSON.stringify(assistant([{ type: 'text', text: 'three — héllo 😀' }])),
    JSON.stringify(user('four')),
  ];
  const texts = (ms: { text: string }[]) => ms.map((m) => m.text);

  it('counts messages, not lines, and returns them oldest first', () => {
    expect(texts(lastMessages(lines, 2))).toEqual(['three — héllo 😀', 'four']);
    expect(texts(lastMessages(lines, 3))).toEqual(['two', 'three — héllo 😀', 'four']);
    expect(texts(lastMessages(lines, 99))).toEqual([
      'one',
      'two',
      'three — héllo 😀',
      'four',
    ]);
    expect(lastMessages(lines, 0)).toEqual([]);
  });

  describe('from a file, read backwards', () => {
    let tmp: string;
    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-tail-'));
    });
    afterEach(() => {
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('gives the same answer for any chunk size — including ones that split a line or a character', () => {
      const file = path.join(tmp, 't.jsonl');
      fs.writeFileSync(file, lines.join('\n') + '\n');
      for (const chunk of [1, 3, 50, 700, 1 << 20]) {
        for (const n of [1, 2, 3, 99]) {
          expect(readLastMessages(file, n, chunk)).toEqual(lastMessages(lines, n));
        }
      }
    });

    it('handles a file with no trailing newline, and an empty one', () => {
      const file = path.join(tmp, 't.jsonl');
      fs.writeFileSync(file, lines.join('\n'));
      expect(texts(readLastMessages(file, 1, 16))).toEqual(['four']);
      fs.writeFileSync(file, '');
      expect(readLastMessages(file, 5)).toEqual([]);
    });
  });
});
