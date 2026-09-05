/**
 * One small JSON file as a store: authoritative reads, atomic writes, and a
 * directory watch — shared by `session-marks.ts` (pins / hidden) and
 * `session-lists.ts` (saved session lists).
 *
 * The rule that matters here is the AUTHORITY invariant, and it lives in one
 * place on purpose. Every store has a forgiving `normalize` that coerces
 * anything into a valid value so a partly-corrupt file still renders; that is
 * right for display and wrong for authority, because a read-modify-write
 * would write the coerced result back for real and erase the original. PR
 * #137 spent four review rounds narrowing that check for the marks store —
 * each round found one more way normalization could differ — before settling
 * on "normalization must be a no-op". A second store re-deriving that rule
 * would re-derive it wrong, so both stores call this one.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * A read plus whether its result is authoritative.
 *
 * `known: false` means the contents are UNKNOWN, not empty. Callers that act
 * on emptiness — clearing a stored preference, broadcasting a change, writing
 * back — must not act on an unknown read, or a transient filesystem failure
 * destroys user state that is still perfectly intact on disk.
 */
export interface StoreRead<T> {
  value: T;
  known: boolean;
}

/** Stable JSON — object keys sorted, so key ORDER can never fake a difference. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([x], [y]) =>
            x < y ? -1 : x > y ? 1 : 0,
          ),
        )
      : val,
  );

/**
 * Is a parsed value a store we may treat as AUTHORITATIVE?
 *
 * The invariant is simply **normalization must be a no-op**. Comparing the
 * whole normalized result against the input has no narrower case left to
 * miss, and it tracks the store's `normalize` automatically instead of
 * restating its rules beside it.
 *
 * Deliberately strict: a file this build would rewrite in ANY way — including
 * one carrying a field a future version added, or a bare `{}` — is refused
 * rather than silently rewritten. Refusing costs one lost action; rewriting
 * costs the user's data.
 */
export const isAuthoritativeRead = (
  raw: unknown,
  normalized: unknown,
): boolean => canonical(raw) === canonical(normalized);

export const readStoreResult = <T>(
  filePath: string,
  normalize: (raw: unknown) => T,
  empty: () => T,
): StoreRead<T> => {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const value = normalize(raw);
    return { value, known: isAuthoritativeRead(raw, value) };
  } catch (err) {
    // A missing file IS authoritative: no store yet means nothing stored yet,
    // which is simply the first run. Anything else — permissions, IO,
    // malformed JSON — leaves the real contents unknown.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { value: empty(), known: code === 'ENOENT' };
  }
};

export const writeStoreFile = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // temp + rename so a crash mid-write can't corrupt the store. Owner-only
  // permissions: the lists store carries conversation snippets.
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
};

/**
 * Read-modify-write that REFUSES to write when the store could not be read.
 *
 * Every mutation is read-modify-write over the whole file, so a read that
 * silently degrades to the empty value turns the next change into a full
 * overwrite. A missing file is still fine — ENOENT is authoritative — so the
 * first-ever write creates the store as usual.
 *
 * Returns the resulting value with `known: true` when the write happened, or
 * the unknown read (`known: false`) when it was refused and nothing was
 * touched.
 */
export const mutateStoreFile = <T>(
  filePath: string,
  normalize: (raw: unknown) => T,
  empty: () => T,
  mutate: (value: T) => T,
): StoreRead<T> => {
  const read = readStoreResult(filePath, normalize, empty);
  if (!read.known) return read;
  const next = mutate(read.value);
  writeStoreFile(filePath, next);
  return { value: next, known: true };
};

/**
 * Watch a store file for changes. Watches the parent DIRECTORY: the
 * rename-based write replaces the file inode, which would detach a plain file
 * watcher. Events for sibling files (other stores, our own .tmp) are filtered
 * out by name.
 *
 * Never broadcasts an unknown read. Announcing "the store is now empty"
 * because the file could not be parsed would push every listener into acting
 * on state that is still intact on disk; staying silent leaves them on the
 * last thing actually seen.
 */
export const watchStoreFile = <T>(
  filePath: string,
  read: (filePath: string) => StoreRead<T>,
  onChange: (value: T) => void,
  onError?: (err: Error) => void,
): (() => void) => {
  const dir = path.dirname(filePath);
  const filename = path.basename(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Debounce: fs.watch on macOS fires several times per change
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const watcher = fs.watch(dir, { persistent: false }, (_event, changed) => {
    if (changed && changed !== filename) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const result = read(filePath);
      if (!result.known) return;
      onChange(result.value);
    }, 50);
  });

  watcher.on('error', (err: Error) => {
    // A dead watcher must not crash the main process (unhandled 'error'
    // would) — close it and let the owner decide whether to recreate.
    try {
      watcher.close();
    } catch {
      // already closed by the OS; nothing left to release
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    onError?.(err);
  });

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    watcher.close();
  };
};
