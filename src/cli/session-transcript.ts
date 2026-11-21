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
 * Hand a file's lines to `visit` from the LAST one back, reading the file
 * backwards in chunks, until `visit` returns true or the file is done. A
 * transcript can be hundreds of MB and what is wanted is almost always in
 * its last chunk. Lines are cut on the newline byte, so a multi-byte
 * character split by a chunk boundary is never decoded in halves.
 */
export const scanLinesBackward = (
  file: string,
  visit: (line: string) => boolean,
  chunkBytes = TAIL_CHUNK,
): void => {
  const fd = fs.openSync(file, 'r');
  try {
    let end = fs.fstatSync(fd).size;
    // The tail of a line whose beginning lies before what has been read, as
    // the chunks it spans (in file order). They are joined ONCE, when the
    // line's start is finally found: joining on every chunk would copy a
    // 200 MB line two hundred times.
    let pending: Buffer[] = [];
    const cast = (parts: Buffer[]) => parts as unknown as Uint8Array[];
    while (end > 0) {
      const start = Math.max(0, end - chunkBytes);
      const chunk = Buffer.alloc(end - start);
      // Casts: this repo's @types/node and TS lib disagree on Buffer vs Uint8Array.
      fs.readSync(fd, chunk as unknown as Uint8Array, 0, chunk.length, start);
      end = start;
      // `pending` never contains a newline, so the first one — if any — is in
      // this chunk. Before it: the rest of a line that began even earlier.
      const nl = start > 0 ? chunk.indexOf(10) : -1;
      if (start > 0 && nl < 0) {
        pending.unshift(chunk); // still the same line
        continue;
      }
      const whole = Buffer.concat(cast([chunk.subarray(nl + 1), ...pending]));
      pending = start > 0 ? [chunk.subarray(0, nl)] : [];
      const lines = whole.toString('utf-8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (visit(lines[i])) return;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
};

/** The last `n` messages of a transcript, oldest first. */
export const readLastMessages = (
  file: string,
  n: number,
  chunkBytes = TAIL_CHUNK,
): TranscriptMessage[] => {
  const out: TranscriptMessage[] = [];
  if (n <= 0) return out;
  scanLinesBackward(
    file,
    (line) => {
      const m = messageFromLine(line);
      if (m) out.unshift(m);
      return out.length >= n;
    },
    chunkBytes,
  );
  return out;
};

/** A line's own top-level `timestamp` in epoch ms, or 0. Pure. */
export const timestampOfLine = (line: string): number => {
  // Cheap reject first: lines without the key are most bookkeeping records.
  if (!line.includes('"timestamp"')) return 0;
  try {
    const r = JSON.parse(line);
    // Top level only: a tool result can quote another record's timestamp.
    const t =
      r && typeof r === 'object' && typeof r.timestamp === 'string'
        ? Date.parse(r.timestamp)
        : NaN;
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
};

/**
 * When the session last DID something: the timestamp of the transcript's last
 * record that carries one, in epoch ms; 0 when none does or the file cannot
 * be read.
 *
 * Not the last line: a transcript usually ends in bookkeeping records with no
 * timestamp — the last line of 21 of 40 real transcripts on 2026-11-21 was a
 * `cost-state`, `bridge-session` or `artifact-comment-monitor` record, and
 * `custom-title` / `agent-name` records sit there too. Every user,
 * assistant and system record has one, so the scan stops within a few lines.
 */
export const readLastActivity = (
  file: string,
  chunkBytes = TAIL_CHUNK,
): number => {
  let found = 0;
  try {
    scanLinesBackward(
      file,
      (line) => {
        found = timestampOfLine(line);
        return found > 0;
      },
      chunkBytes,
    );
  } catch {
    return 0;
  }
  return found;
};
