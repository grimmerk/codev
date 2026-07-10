/**
 * Cross-account sharing engine (Batch 3).
 *
 * Shares the anchor account's global files with other accounts via symlinks
 * (stay in sync) or copies (fork). Mechanism verified live: Claude Code
 * follows symlinks for `skills/<name>` entries, whole `skills/`/`commands/`
 * dirs, and the global `CLAUDE.md` (design doc §5).
 *
 * Policy (§5):
 *   - NEVER silently overwrite: an existing real file/dir is renamed to a
 *     timestamped `.codev-bak-*` sibling before linking/copying — which also
 *     makes unshare fully reversible (restore-backup).
 *   - Per item, three choices: link (sync) / copy (fork) / skip.
 *   - `.claude.json`, session data, and `plugins/` are deliberately NOT
 *     shareable (identity, live-written state, per-account install registry
 *     with absolute paths). Plugins' need is covered by sync-settings
 *     (`enabledPlugins` stays per-account).
 *
 * Core functions are PATH-BASED (no registry coupling) so they get real-fs
 * integration tests under os.tmpdir(); thin registry-aware wrappers sit at
 * the bottom.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getSettingsPath, readRegistry } from './account-manager';
import type { RegistryAccount } from './account-manager';

export type ShareItemKey = 'claude-md' | 'skills' | 'commands';

export const SHARE_ITEMS: ShareItemKey[] = ['claude-md', 'skills', 'commands'];

/** Relative path of a share item inside a config dir. */
const itemRelPath = (item: ShareItemKey): string =>
  item === 'claude-md' ? 'CLAUDE.md' : item;

export type ShareState =
  | { kind: 'none' } // target doesn't exist
  | { kind: 'own' } // the account's own real file/dir
  | { kind: 'linked'; to: string } // symlink (to = resolved target)
  | { kind: 'broken-link'; to: string } // symlink whose target is gone
  | { kind: 'mixed'; linked: string[]; own: string[] }; // dir with per-entry links

export interface ShareStatus {
  state: ShareState;
  backups: string[]; // newest first, absolute paths
}

// ---------------------------------------------------------------------------
// path-based core (tmpdir-testable)
// ---------------------------------------------------------------------------

/** Timestamped backup sibling: `<target>.codev-bak-<ts>` (uniquified — the
 * timestamp has 1s precision, so rapid re-shares get a numeric suffix). */
const backupName = (targetPath: string): string => {
  const base = `${targetPath}.codev-bak-${new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)}`;
  let candidate = base;
  let i = 1;
  while (fs.existsSync(candidate)) candidate = `${base}-${i++}`;
  return candidate;
};

/** Existing backups for a target, newest first. */
export function listBackups(targetPath: string): string[] {
  const parent = path.dirname(targetPath);
  const prefix = `${path.basename(targetPath)}.codev-bak-`;
  try {
    return fs
      .readdirSync(parent)
      .filter((n) => n.startsWith(prefix))
      .sort()
      .reverse()
      .map((n) => path.join(parent, n));
  } catch {
    return [];
  }
}

export function getShareState(targetPath: string): ShareState {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(targetPath);
  } catch {
    return { kind: 'none' };
  }
  if (st.isSymbolicLink()) {
    const to = fs.readlinkSync(targetPath);
    const resolved = path.resolve(path.dirname(targetPath), to);
    return fs.existsSync(resolved)
      ? { kind: 'linked', to: resolved }
      : { kind: 'broken-link', to: resolved };
  }
  if (st.isDirectory()) {
    // Distinguish an own dir from one with per-entry links inside.
    const linked: string[] = [];
    const own: string[] = [];
    for (const entry of fs.readdirSync(targetPath)) {
      if (entry.startsWith('.')) continue;
      try {
        (fs.lstatSync(path.join(targetPath, entry)).isSymbolicLink()
          ? linked
          : own
        ).push(entry);
      } catch {
        /* races are fine — status is advisory */
      }
    }
    if (linked.length > 0) return { kind: 'mixed', linked, own };
  }
  return { kind: 'own' };
}

export function getShareStatus(targetPath: string): ShareStatus {
  return { state: getShareState(targetPath), backups: listBackups(targetPath) };
}

/**
 * Share source → target. `link` keeps the account in sync (one file, both
 * ways); `copy` forks. An existing real target is renamed to a `.codev-bak-*`
 * sibling first (never `ln -sf`, never silent overwrite); an existing symlink
 * is just replaced (a pointer needs no backup).
 */
export function shareItem(
  sourcePath: string,
  targetPath: string,
  mode: 'link' | 'copy',
): { backedUpTo?: string } {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source does not exist: ${sourcePath}`);
  }
  if (path.resolve(sourcePath) === path.resolve(targetPath)) {
    throw new Error('Source and target are the same path');
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  let backedUpTo: string | undefined;
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(targetPath);
  } catch {
    /* target absent */
  }
  if (st) {
    if (st.isSymbolicLink()) {
      fs.unlinkSync(targetPath);
    } else {
      backedUpTo = backupName(targetPath);
      fs.renameSync(targetPath, backedUpTo);
    }
  }

  if (mode === 'link') {
    fs.symlinkSync(sourcePath, targetPath);
  } else {
    fs.cpSync(sourcePath, targetPath, { recursive: true });
  }
  return { backedUpTo };
}

/**
 * Unshare a linked target. Zero data loss by itself (a symlink is just a
 * pointer; the source stays intact — re-linking restores it any time).
 *   - default: remove the link (target becomes absent)
 *   - restoreBackup: additionally restore the newest `.codev-bak-*` sibling
 *     (true undo of the share that created it)
 *   - keepCopy: replace the link with a real copy of the shared content
 */
export function unshareItem(
  targetPath: string,
  opts: { restoreBackup?: boolean; keepCopy?: boolean } = {},
): { restoredFrom?: string } {
  if (opts.restoreBackup && opts.keepCopy) {
    throw new Error('restoreBackup and keepCopy are mutually exclusive');
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(targetPath);
  } catch {
    throw new Error(`Not shared (nothing at ${targetPath})`);
  }
  if (!st.isSymbolicLink()) {
    throw new Error(
      `Not a link: ${targetPath} is the account's own file/dir — nothing to unshare`,
    );
  }
  const resolved = path.resolve(
    path.dirname(targetPath),
    fs.readlinkSync(targetPath),
  );

  // Validate the requested replacement BEFORE removing the link, so a failed
  // restore/keep-copy leaves the share untouched instead of half-undone.
  let newestBackup: string | undefined;
  if (opts.keepCopy && !fs.existsSync(resolved)) {
    throw new Error(`Link target is gone, nothing to copy: ${resolved}`);
  }
  if (opts.restoreBackup) {
    [newestBackup] = listBackups(targetPath);
    if (!newestBackup) {
      throw new Error(`No .codev-bak-* backup found for ${targetPath}`);
    }
  }

  fs.unlinkSync(targetPath);
  if (opts.keepCopy) {
    fs.cpSync(resolved, targetPath, { recursive: true });
    return {};
  }
  if (opts.restoreBackup && newestBackup) {
    fs.renameSync(newestBackup, targetPath);
    return { restoredFrom: newestBackup };
  }
  return {};
}

// ---------------------------------------------------------------------------
// settings per-key sync
// ---------------------------------------------------------------------------

/** Keys that make sense to copy across accounts. Hooks are installed per-dir
 * by CodeV; enabledPlugins belongs to each account's plugin state;
 * permissions are security-sensitive — all deliberately excluded. */
export const SYNCABLE_SETTINGS_KEYS = [
  'statusLine',
  'model',
  'effortLevel',
  'theme',
] as const;

export function syncSettingsKeys(
  sourceSettingsPath: string,
  targetSettingsPath: string,
  keys: string[],
): { copied: string[]; missingInSource: string[] } {
  for (const k of keys) {
    if (!(SYNCABLE_SETTINGS_KEYS as readonly string[]).includes(k)) {
      throw new Error(
        `"${k}" is not a syncable key (allowed: ${SYNCABLE_SETTINGS_KEYS.join(', ')})`,
      );
    }
  }
  const readJson = (p: string): Record<string, unknown> => {
    if (!fs.existsSync(p)) return {};
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch (e) {
      throw new Error(`Malformed JSON in ${p}: ${(e as Error).message}`);
    }
  };
  const source = readJson(sourceSettingsPath);
  const target = readJson(targetSettingsPath);
  const copied: string[] = [];
  const missingInSource: string[] = [];
  for (const k of keys) {
    if (source[k] === undefined) {
      missingInSource.push(k);
    } else {
      target[k] = source[k];
      copied.push(k);
    }
  }
  fs.mkdirSync(path.dirname(targetSettingsPath), { recursive: true });
  fs.writeFileSync(
    targetSettingsPath,
    JSON.stringify(target, null, 2) + '\n',
    'utf-8',
  );
  return { copied, missingInSource };
}

// ---------------------------------------------------------------------------
// registry-aware wrappers
// ---------------------------------------------------------------------------

function requireAccounts(label: string): {
  account: RegistryAccount;
  anchor: RegistryAccount;
} {
  const reg = readRegistry();
  const account = reg.accounts.find((a) => a.label === label);
  if (!account) throw new Error(`No account "${label}"`);
  const anchor = reg.accounts.find((a) => a.isAnchor);
  if (!anchor) throw new Error('No anchor (~/.claude) account registered');
  if (account.isAnchor) {
    throw new Error(
      'That IS the anchor account — sharing goes from the anchor to others',
    );
  }
  return { account, anchor };
}

const expand = (p: string): string =>
  p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;

export function itemPathsFor(
  label: string,
  item: ShareItemKey,
  entry?: string,
): { source: string; target: string } {
  if (!SHARE_ITEMS.includes(item)) {
    throw new Error(
      `Unknown share item "${item}" — one of: ${SHARE_ITEMS.join(', ')}`,
    );
  }
  const { account, anchor } = requireAccounts(label);
  const rel = itemRelPath(item);
  if (entry) {
    if (item === 'claude-md') {
      throw new Error('--entry only applies to skills/commands');
    }
    if (entry.includes('/') || entry.startsWith('.') || entry.startsWith('-')) {
      throw new Error(
        `Invalid entry name "${entry}" (a leading "-" usually means misordered flags)`,
      );
    }
    return {
      source: path.join(expand(anchor.dir), rel, entry),
      target: path.join(expand(account.dir), rel, entry),
    };
  }
  return {
    source: path.join(expand(anchor.dir), rel),
    target: path.join(expand(account.dir), rel),
  };
}

/** Per-item status for an account (target side), plus the anchor source. */
export function shareStatusFor(
  label: string,
): Record<ShareItemKey, ShareStatus & { source: string; target: string }> {
  const out = {} as Record<
    ShareItemKey,
    ShareStatus & { source: string; target: string }
  >;
  for (const item of SHARE_ITEMS) {
    const { source, target } = itemPathsFor(label, item);
    out[item] = { ...getShareStatus(target), source, target };
  }
  return out;
}

export function shareFor(
  label: string,
  item: ShareItemKey,
  mode: 'link' | 'copy',
  entry?: string,
): { backedUpTo?: string; source: string; target: string } {
  const { source, target } = itemPathsFor(label, item, entry);
  // Per-entry sharing needs the parent to be a REAL dir on the target side —
  // if the whole dir is already linked, entries are implicitly shared.
  if (entry) {
    const parentState = getShareState(path.dirname(target));
    if (parentState.kind === 'linked') {
      throw new Error(
        `The whole ${item} dir is already linked — per-entry sharing doesn't apply`,
      );
    }
  }
  return { ...shareItem(source, target, mode), source, target };
}

export function unshareFor(
  label: string,
  item: ShareItemKey,
  opts: { restoreBackup?: boolean; keepCopy?: boolean } = {},
  entry?: string,
): { restoredFrom?: string; target: string } {
  const { target } = itemPathsFor(label, item, entry);
  return { ...unshareItem(target, opts), target };
}

export function syncSettingsFor(
  label: string,
  keys: string[],
): { copied: string[]; missingInSource: string[] } {
  const { account, anchor } = requireAccounts(label);
  return syncSettingsKeys(
    getSettingsPath(anchor),
    getSettingsPath(account),
    keys,
  );
}
