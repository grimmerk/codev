/**
 * Reading the conversation out of a transcript: the last N things the user
 * and the assistant actually SAID, for `codev session view`.
 *
 * Record shapes, counted over 150 real transcripts on 2026-11-20:
 *
 * - `type: "user"`, `message.content` is a string (876) or an array of blocks
 *   — `tool_result` (4,439), `text` (90), `image` + `text` (4). A tool result
 *   is the harness answering the model, not the user speaking.
 * - `type: "assistant"`, `message.content` is always an array holding ONE
 *   kind of block: `tool_use` (4,439), `thinking` (3,035) or `text` (1,385).
 * - flags on user records: `isMeta` (270), `isCompactSummary` (11); and
 *   `isSidechain` on both for sub-agent traffic.
 * - a user string may be something the harness wrote on the user's behalf:
 *   `<local-command-stdout>`, `<local-command-caveat>`, `<bash-stdout>`,
 *   `<task-notification>`, or a whole `<system-reminder>`.
 *
 * So "text only" here means: string content and `text` blocks; nothing from
 * tool calls, tool results, thinking or images; no meta, sidechain or
 * compaction-summary records; no harness-written wrappers.
 */
import * as fs from 'fs';

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  /** ISO time from the record, '' when it has none. */
  timestamp: string;
  text: string;
}

// A user "message" that is entirely one of these was written by the harness.
const HARNESS_WRAPPERS =
  /^\s*<(local-command-caveat|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|task-notification)[\s>]/;

const stripReminders = (text: string): string =>
  text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && b.type === 'text' && typeof b.text === 'string',
    )
    .map((b) => b.text)
    .join('\n');
};

/** The spoken text of one parsed record, or null when it carries none. Pure. */
export const messageFromRecord = (record: unknown): TranscriptMessage | null => {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  if (r.type !== 'user' && r.type !== 'assistant') return null;
  if (r.isSidechain || r.isMeta || r.isCompactSummary) return null;
  const message = r.message as { content?: unknown } | undefined;
  if (!message || typeof message !== 'object') return null;
  const raw = textOf(message.content);
  if (r.type === 'user' && HARNESS_WRAPPERS.test(raw)) return null;
  const text = stripReminders(raw);
  if (!text) return null;
  return {
    role: r.type,
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : '',
    text,
  };
};

/** One transcript line → a message, or null (malformed lines included). */
export const messageFromLine = (line: string): TranscriptMessage | null => {
  // Cheap reject before parsing: most lines are tool traffic, some of them
  // megabytes long, and neither kind of block we want is in them.
  if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) {
    return null;
  }
  try {
    return messageFromRecord(JSON.parse(line));
  } catch {
    return null;
  }
};

/** The last `n` messages among `lines`, oldest first. Pure. */
export const lastMessages = (lines: string[], n: number): TranscriptMessage[] => {
  const out: TranscriptMessage[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const m = messageFromLine(lines[i]);
    if (m) out.unshift(m);
  }
  return out;
};

const TAIL_CHUNK = 1024 * 1024;

/**
 * The last `n` messages of a transcript, oldest first, read BACK from the end
 * of the file in chunks — a transcript can be hundreds of MB and the answer is
 * almost always in its last one. Lines are cut on the newline byte, so a
 * multi-byte character split by a chunk boundary is never decoded in halves.
 */
export const readLastMessages = (
  file: string,
  n: number,
  chunkBytes = TAIL_CHUNK,
): TranscriptMessage[] => {
  const out: TranscriptMessage[] = [];
  if (n <= 0) return out;
  const fd = fs.openSync(file, 'r');
  try {
    let end = fs.fstatSync(fd).size;
    // The start of a line whose beginning lies before what has been read.
    let pending: Buffer = Buffer.alloc(0);
    while (end > 0 && out.length < n) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      // Casts: this repo's @types/node and TS lib disagree on Buffer vs Uint8Array.
      fs.readSync(fd, chunk as unknown as Uint8Array, 0, chunk.length, start);
      const buf = Buffer.concat([chunk, pending] as unknown as Uint8Array[]);
      let from = 0;
      if (start > 0) {
        const nl = buf.indexOf(10);
        if (nl < 0) {
          // No line boundary yet: the whole buffer is part of one line.
          pending = buf;
          end = start;
          continue;
        }
        pending = buf.subarray(0, nl);
        from = nl + 1;
      } else {
        pending = Buffer.alloc(0);
      }
      const lines = buf.toString('utf-8', from).split('\n');
      for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
        const m = messageFromLine(lines[i]);
        if (m) out.unshift(m);
      }
      end = start;
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
};
