/**
 * The persisted half of session enrichment (issue #134) and the PR-reference
 * miner (issue #140, plan §4.6).
 *
 * Enrichment — custom title, branch, PR badge, recap, and now the PR
 * references the assistant mentioned — is derived from each transcript by a
 * scan keyed on the file's mtime and size. Within a run that key makes the
 * scan incremental; across runs nothing survived, so every launch paid one
 * full cold scan (~4s on the reference machine) before titles appeared. This
 * module writes the scan state and its results to one JSON file so the next
 * launch starts warm and the stat check alone decides what to re-read.
 *
 * It is a CACHE, not a store: nothing in it is the only copy of anything, so
 * a bad read is answered by starting cold rather than by refusing to write —
 * the opposite of the authority rule the marks and lists stores live by.
 *
 * Pure pieces (`serializeEnrichment`, `deserializeEnrichment`,
 * `minePrRefs`) are unit-tested; the file layer is two small wrappers over
 * the shared atomic writer.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { writeStoreFile } from './atomic-json-store';
import { isImageMarkerHash } from './session-search';

export const ENRICHMENT_CACHE_VERSION = 1;

export interface CachedSessionEnrichment {
  mtimeMs: number;
  size: number;
  title?: string;
  branch?: string;
  prLink?: { prNumber: number; prUrl: string };
  recap?: { text: string; at: string };
  /** Canonical PR references the assistant mentioned: `owner/repo#N` or `#N`, lowercased. */
  prRefs?: string[];
  /** How far the miner has read (whole lines only); the next pass starts here. */
  prRefsScannedBytes?: number;
}

export interface EnrichmentCacheFile {
  version: number;
  sessions: Record<string, CachedSessionEnrichment>;
}

/** What the scanner keeps in memory; the cache file is a projection of it. */
export interface EnrichmentState {
  fileState: Map<string, { mtimeMs: number; size: number }>;
  titles: Map<string, string>;
  branches: Map<string, string>;
  prLinks: Map<string, { prNumber: number; prUrl: string }>;
  recaps: Map<string, { text: string; at: string }>;
  prRefs: Map<string, string[]>;
  /** sessionId -> bytes of the transcript already mined for PR references. */
  prRefBytes: Map<string, number>;
}

/**
 * Project the in-memory state onto the file shape. Only sessions with scan
 * state are written — a value with no state would be re-scanned anyway. The
 * optional `keep` set prunes sessions that no longer exist in history, so a
 * deleted session does not sit in the cache forever.
 */
export const serializeEnrichment = (
  state: EnrichmentState,
  keep?: Set<string>,
): EnrichmentCacheFile => {
  const sessions: Record<string, CachedSessionEnrichment> = {};
  for (const [id, fileState] of state.fileState) {
    if (keep && !keep.has(id)) continue;
    const entry: CachedSessionEnrichment = { ...fileState };
    const title = state.titles.get(id);
    if (title) entry.title = title;
    const branch = state.branches.get(id);
    if (branch) entry.branch = branch;
    const prLink = state.prLinks.get(id);
    if (prLink) entry.prLink = prLink;
    const recap = state.recaps.get(id);
    if (recap) entry.recap = recap;
    const refs = state.prRefs.get(id);
    if (refs && refs.length > 0) entry.prRefs = refs;
    const bytes = state.prRefBytes.get(id);
    if (bytes !== undefined && bytes > 0) entry.prRefsScannedBytes = bytes;
    sessions[id] = entry;
  }
  return { version: ENRICHMENT_CACHE_VERSION, sessions };
};

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/**
 * Load a cache file into fresh maps. Forgiving per entry — one malformed
 * session is dropped, the rest load — and empty on a version mismatch or
 * anything that is not the expected shape, which simply means a cold scan.
 */
export const deserializeEnrichment = (raw: unknown): EnrichmentState => {
  const state: EnrichmentState = {
    fileState: new Map(),
    titles: new Map(),
    branches: new Map(),
    prLinks: new Map(),
    recaps: new Map(),
    prRefs: new Map(),
    prRefBytes: new Map(),
  };
  if (!raw || typeof raw !== 'object') return state;
  const file = raw as Partial<EnrichmentCacheFile>;
  if (file.version !== ENRICHMENT_CACHE_VERSION) return state;
  if (!file.sessions || typeof file.sessions !== 'object') return state;
  for (const [id, entry] of Object.entries(file.sessions)) {
    if (!id || !entry || typeof entry !== 'object') continue;
    const e = entry as Partial<CachedSessionEnrichment>;
    if (!isFiniteNumber(e.mtimeMs) || !isFiniteNumber(e.size)) continue;
    state.fileState.set(id, { mtimeMs: e.mtimeMs, size: e.size });
    if (typeof e.title === 'string' && e.title) state.titles.set(id, e.title);
    if (typeof e.branch === 'string' && e.branch)
      state.branches.set(id, e.branch);
    if (
      e.prLink &&
      typeof e.prLink === 'object' &&
      isFiniteNumber(e.prLink.prNumber) &&
      typeof e.prLink.prUrl === 'string'
    ) {
      state.prLinks.set(id, {
        prNumber: e.prLink.prNumber,
        prUrl: e.prLink.prUrl,
      });
    }
    if (
      e.recap &&
      typeof e.recap === 'object' &&
      typeof e.recap.text === 'string' &&
      e.recap.text
    ) {
      state.recaps.set(id, {
        text: e.recap.text,
        at: typeof e.recap.at === 'string' ? e.recap.at : '',
      });
    }
    if (Array.isArray(e.prRefs)) {
      const refs = e.prRefs.filter(
        (r): r is string => typeof r === 'string' && !!r,
      );
      if (refs.length > 0) state.prRefs.set(id, refs);
    }
    // A cursor is only usable as a whole-line byte offset inside the file
    // it was recorded for: an integer in (0, size]. Anything else (a hand
    // edit, a truncated write) is dropped so mining restarts at zero rather
    // than skipping bytes or failing to allocate a chunk.
    if (
      Number.isInteger(e.prRefsScannedBytes) &&
      (e.prRefsScannedBytes as number) > 0 &&
      (e.prRefsScannedBytes as number) <= e.size
    ) {
      state.prRefBytes.set(id, e.prRefsScannedBytes as number);
    }
  }
  return state;
};

// ---------------------------------------------------------------------------
// PR-reference mining
// ---------------------------------------------------------------------------

/**
 * Mining runs IN PROCESS over whole lines, not through grep. Measured on the
 * largest transcript on the reference machine (65MB): a fixed-string grep
 * takes 0.03s, but `grep -oE` with this alternation takes 4.0s — 130× —
 * which is not something to pay on every scan of a live session. Reading
 * lines here lets the miner skip the 70% of bytes that are not assistant
 * records at all, and — because a transcript is append-only — resume from
 * the byte it stopped at last time (`prRefsScannedBytes`), so the steady
 * state reads only what was appended.
 *
 * Forms: the GitHub URL (pull or issues), `owner/repo#N`, and `#N` with a
 * non-word character before it. `&#N` is excluded so HTML entities are not
 * read as references; a leading zero is excluded so `#0` is not.
 */
export const PR_REF_RE =
  /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:pull|issues)\/([1-9][0-9]*)|([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)|(?:^|[^A-Za-z0-9&#])#([1-9][0-9]*)/gi;

/**
 * The words the assistant actually wrote in one JSONL record, or null when
 * the line is not an assistant record: its text blocks and the inputs of
 * its tool calls (a commit message, a `gh pr comment` body). Not thinking,
 * not the signature blobs, and never a user record — prompts and, far more
 * often, tool results such as a `gh pr list`: a session that merely listed
 * twenty PRs did not work on them.
 *
 * Parsed, not pattern-matched, because the record layout does not put the
 * top-level `type` first: on the reference machine an assistant record
 * reads `{"parentUuid":…,"isSidechain":false,"message":{…,"type":"message",
 * "role":"assistant",…},"type":"assistant",…}` — the first `"type":"` on the
 * line belongs to the message. An earlier version keyed on that and mined
 * nothing at all from 91 real transcripts; its hand-made fixture had passed.
 * The cheap `includes` keeps the parse off the ~70% of bytes that cannot be
 * assistant records.
 */
export const assistantTextOfLine = (line: string): string | null => {
  if (!line.includes('"type":"assistant"')) return null;
  let rec: {
    type?: unknown;
    message?: { content?: unknown };
  };
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!rec || rec.type !== 'assistant') return null;
  const content = rec.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: unknown; text?: unknown; input?: unknown };
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'tool_use' && b.input !== undefined) {
      parts.push(
        typeof b.input === 'string' ? b.input : JSON.stringify(b.input),
      );
    }
  }
  return parts.join('\n');
};

/**
 * Canonical references the ASSISTANT wrote in `text` (one or more whole
 * JSONL lines): `owner/repo#N` when the form carried a repo, `#N` otherwise,
 * lowercased, deduplicated against `seen`, in first-seen order.
 */
export const minePrRefs = (
  text: string,
  seen = new Set<string>(),
): string[] => {
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    const said = assistantTextOfLine(line);
    if (!said) continue;
    PR_REF_RE.lastIndex = 0;
    for (let m = PR_REF_RE.exec(said); m; m = PR_REF_RE.exec(said)) {
      // The bare form's match starts at the delimiter before the `#` (if any).
      if (m[5] && isImageMarkerHash(said, m.index + m[0].indexOf('#')))
        continue;
      const canonical = (
        m[1] ? `${m[1]}#${m[2]}` : m[3] ? `${m[3]}#${m[4]}` : `#${m[5]}`
      ).toLowerCase();
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// File layer
// ---------------------------------------------------------------------------

const CACHE_FILENAME = 'enrichment-cache.json';

export const getEnrichmentCachePath = (): string =>
  path.join(os.homedir(), '.config', 'codev', CACHE_FILENAME);

/** Read the cache; any failure is a cold start, never an error. */
export const readEnrichmentCacheFile = (filePath: string): EnrichmentState => {
  try {
    return deserializeEnrichment(
      JSON.parse(fs.readFileSync(filePath, 'utf-8')),
    );
  } catch {
    return deserializeEnrichment(null);
  }
};

export const writeEnrichmentCacheFile = (
  filePath: string,
  state: EnrichmentState,
  keep?: Set<string>,
): void => writeStoreFile(filePath, serializeEnrichment(state, keep));
