/**
 * CodeV multi-account registry manager (shared).
 *
 * The SINGLE source of truth for:
 *   1. reading/writing  ~/.config/codev/accounts.json  (the registry), and
 *   2. generating       ~/.config/codev/accounts.sh    (the shell integration).
 *
 * Consumed by BOTH the standalone `codev account` CLI (src/cli/codev-account.ts)
 * and — later — CodeV's Electron main process (Accounts UI, Batch 2b). Keeping
 * one generator here avoids two implementations drifting apart. The reader in
 * src/accounts.ts consumes the same accounts.json.
 *
 * Account model (docs/multi-account-support-design.md §3.4):
 *   - DEFAULT account = ~/.claude, launched with NO CLAUDE_CONFIG_DIR
 *                       (its .claude.json is at ~/.claude.json, HOME level).
 *   - EXTRA accounts   = ~/.claude-<label>, launched with CLAUDE_CONFIG_DIR=<dir>
 *                       (self-contained, <dir>/.claude.json).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RegistryAccount {
  label: string;
  dir: string; // config dir (session data lives under <dir>/projects, /sessions)
  identityFile: string; // .claude.json path
  configDirEnv: string | null; // CLAUDE_CONFIG_DIR at launch; null => default account
  isDefault: boolean; // the anchor ~/.claude account (HOME .claude.json)
  email?: string;
  org?: string;
  subscription?: string;
  loggedIn?: boolean;
}

export interface Registry {
  version: number;
  defaultAccount?: string; // label bare `claude` resolves to
  accounts: RegistryAccount[];
}

type Identity = Partial<Pick<RegistryAccount, 'email' | 'org' | 'loggedIn'>>;

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'codev');
export const REGISTRY_PATH = path.join(CONFIG_DIR, 'accounts.json');
export const ACCOUNTS_SH_PATH = path.join(CONFIG_DIR, 'accounts.sh');
export const ZSHRC_PATH = path.join(os.homedir(), '.zshrc');

const ZSHRC_BEGIN = '# >>> codev accounts >>>';
const ZSHRC_END = '# <<< codev accounts <<<';

// Labels become shell function names + case branches, so keep them safe.
const LABEL_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const expandHome = (p: string): string =>
  typeof p === 'string' && p.startsWith('~')
    ? path.join(os.homedir(), p.slice(1))
    : p;

const defaultDir = (): string => path.join(os.homedir(), '.claude');

/** Absolute path under $HOME → `$HOME/…` for generated shell (expands at runtime). */
const toShellPath = (p: string): string => {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep)
    ? '$HOME' + p.slice(home.length)
    : p;
};

/** Absolute path under $HOME → `~/…` for human-readable display. */
const toTildePath = (p: string): string => {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep)
    ? '~' + p.slice(home.length)
    : p;
};

/** Is this dir the special DEFAULT account (~/.claude, HOME .claude.json)? */
const isDefaultDir = (dir: string): boolean =>
  path.resolve(expandHome(dir)) === defaultDir();

// Registry dirs get embedded (double-quoted) into the generated accounts.sh and
// into `case` patterns. Reject shell-dangerous characters so a hand-edited
// registry or a crafted `--dir` can't inject code when accounts.sh is sourced.
const SHELL_UNSAFE_DIR = /["`$\\\r\n;|&<>()]/;
const assertSafeDir = (dir: string): void => {
  if (SHELL_UNSAFE_DIR.test(dir)) {
    throw new Error(
      `Unsafe shell characters in account dir "${dir}" (quotes, $, backticks, ; | & < > ( ) are not allowed)`,
    );
  }
};

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// registry read / write
// ---------------------------------------------------------------------------

export function readRegistry(): Registry {
  if (!fs.existsSync(REGISTRY_PATH)) {
    // No hardcoded default — the first added account becomes the default, and
    // resolveDefaultLabel falls back to the anchor. Avoids a dangling reference.
    return { version: 1, accounts: [] };
  }
  const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8')) as Registry;
  if (!raw.version) raw.version = 1;
  if (!Array.isArray(raw.accounts)) raw.accounts = [];
  return raw;
}

export function writeRegistry(reg: Registry): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n', 'utf-8');
}

/** Best-effort identity from an account's .claude.json (email/org/loggedIn). */
export function readIdentity(identityFile: string): Identity {
  try {
    const j = JSON.parse(fs.readFileSync(expandHome(identityFile), 'utf-8'));
    const o = j.oauthAccount || {};
    return stripUndefined({
      email: o.emailAddress,
      org: o.organizationName,
      loggedIn: o.emailAddress ? true : undefined,
    });
  } catch {
    return {};
  }
}

/** Label bare `claude` maps to (defaultAccount if valid, else the anchor). */
export function resolveDefaultLabel(reg: Registry): string | undefined {
  const accounts = reg.accounts || [];
  if (
    reg.defaultAccount &&
    accounts.some((a) => a.label === reg.defaultAccount)
  ) {
    return reg.defaultAccount;
  }
  const anchor = accounts.find((a) => a.isDefault) || accounts[0];
  return anchor ? anchor.label : undefined;
}

// ---------------------------------------------------------------------------
// accounts.sh generation (the ONE generator)
// ---------------------------------------------------------------------------

/**
 * Full command that launches an account's claude, bypassing the claude()
 * dispatcher. `env` runs the real binary (no shell-function recursion) and lets
 * us set — or explicitly unset — CLAUDE_CONFIG_DIR.
 */
function launchCmd(account: RegistryAccount | undefined): string {
  if (!account || !account.configDirEnv) {
    // Default/anchor account: unset CLAUDE_CONFIG_DIR so a stray exported value
    // can't hijack it (§3.4).
    return 'env -u CLAUDE_CONFIG_DIR claude ';
  }
  return `env CLAUDE_CONFIG_DIR="${toShellPath(expandHome(account.configDirEnv))}" claude `;
}

/** Render the accounts.sh contents from a registry object. Pure function. */
export function generateAccountsSh(reg: Registry): string {
  const accounts = reg.accounts || [];
  accounts.forEach((a) => assertSafeDir(expandHome(a.dir)));
  const defaultLabel = resolveDefaultLabel(reg);
  const defaultAccount = accounts.find((a) => a.label === defaultLabel);
  const pad = Math.max(0, ...accounts.map((a) => a.label.length));

  const L: string[] = [];
  L.push(
    '# CodeV multi-account shell integration — GENERATED FILE (safe to delete).',
  );
  L.push('# Source of truth: ~/.config/codev/accounts.json');
  L.push(
    '# Regenerated by `codev account` / CodeV — manual edits here will be lost.',
  );
  L.push(
    '# To uninstall: `codev account uninstall` (removes the ~/.zshrc block).',
  );
  L.push('#');
  L.push(
    '# Model: one Claude Code config dir per account (CLAUDE_CONFIG_DIR).',
  );
  L.push(
    '#   - DEFAULT account: NO CLAUDE_CONFIG_DIR (config at ~/.claude.json + ~/.claude/).',
  );
  L.push(
    '#   - EXTRA accounts:  CLAUDE_CONFIG_DIR=<dir>, fully self-contained.',
  );
  L.push('#');
  L.push('# Usage:');
  L.push(
    `#   claude              -> ${defaultLabel || '(none)'} (default account)`,
  );
  L.push('#   claude <account> …  -> that account   (e.g. claude work -r)');
  L.push('#   claude-<account> …  -> equivalent function form');
  L.push(
    '#   claude-whoami       -> which account bare `claude` resolves to here',
  );
  L.push('#   claude-accounts     -> list configured accounts');
  L.push(
    '# All native flags pass through, e.g. `claude work -r`, `claude-work mcp list`.',
  );
  L.push('');
  L.push('# --- per-account launchers (full passthrough via "$@") ---');
  for (const a of accounts) {
    L.push(`claude-${a.label}() { ${launchCmd(a)}"$@"; }`);
  }
  L.push('');
  L.push(
    '# --- dispatcher: `claude <account> [args...]`, else the default account ---',
  );
  L.push(
    '# `env` runs the real claude binary, bypassing this function (no recursion).',
  );
  L.push('claude() {');
  L.push('  case "$1" in');
  for (const a of accounts) {
    L.push(`    ${a.label}) shift; ${launchCmd(a)}"$@" ;;`);
  }
  L.push(`    *) ${launchCmd(defaultAccount)}"$@" ;;`);
  L.push('  esac');
  L.push('}');
  L.push('');
  L.push(
    '# claude-whoami: which account THIS shell resolves to (via CLAUDE_CONFIG_DIR).',
  );
  L.push('claude-whoami() {');
  L.push('  local dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}" label');
  L.push('  case "$dir" in');
  for (const a of accounts) {
    const marker = a.label === defaultLabel ? ' (default)' : '';
    L.push(
      `    "${toShellPath(expandHome(a.dir))}") label="${a.label}${marker}" ;;`,
    );
  }
  L.push('    *) label="(unregistered)" ;;');
  L.push('  esac');
  L.push('  echo "codev account     : $label"');
  L.push(
    '  echo "CLAUDE_CONFIG_DIR : ${CLAUDE_CONFIG_DIR:-<unset → ~/.claude>}"',
  );
  L.push('  command claude auth status 2>/dev/null');
  L.push('}');
  L.push('');
  L.push('# claude-accounts: list configured accounts.');
  L.push('claude-accounts() {');
  L.push(
    `  echo "codev accounts (bare 'claude' = ${defaultLabel || 'none'}):"`,
  );
  for (const a of accounts) {
    const star = a.label === defaultLabel ? '*' : ' ';
    L.push(`  echo "  ${star} ${a.label.padEnd(pad)}   ${toTildePath(a.dir)}"`);
  }
  L.push(
    '  echo "  identity: run claude-whoami, or claude <acct> auth status"',
  );
  L.push('}');
  L.push('');
  return L.join('\n');
}

export function regenerate(reg?: Registry): string {
  const r = reg || readRegistry();
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNTS_SH_PATH, generateAccountsSh(r), 'utf-8');
  return ACCOUNTS_SH_PATH;
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

export function addAccount(
  label: string,
  opts: { dir?: string } = {},
): RegistryAccount {
  if (!label) throw new Error('add: <label> is required');
  if (!LABEL_RE.test(label)) {
    throw new Error(
      `Invalid label "${label}" — use a letter followed by letters/digits/-/_`,
    );
  }
  const reg = readRegistry();
  if (reg.accounts.some((a) => a.label === label)) {
    throw new Error(`Account "${label}" already exists`);
  }
  const dir = expandHome(
    opts.dir || path.join(os.homedir(), `.claude-${label}`),
  );
  assertSafeDir(dir);
  const isDefault = isDefaultDir(dir);
  const identityFile = isDefault
    ? path.join(os.homedir(), '.claude.json')
    : path.join(dir, '.claude.json');
  const entry: RegistryAccount = {
    label,
    dir,
    identityFile,
    configDirEnv: isDefault ? null : dir,
    isDefault,
    loggedIn: false,
    ...readIdentity(identityFile),
  };
  reg.accounts.push(entry);
  // Set the global default only if the current one doesn't name a real account
  // (fresh registry, or a stale/dangling reference) — never clobber a valid one.
  if (!reg.accounts.some((a) => a.label === reg.defaultAccount)) {
    reg.defaultAccount = label;
  }
  writeRegistry(reg);
  regenerate(reg);
  return entry;
}

export function removeAccount(label: string): string | undefined {
  const reg = readRegistry();
  const idx = reg.accounts.findIndex((a) => a.label === label);
  if (idx < 0) throw new Error(`No account "${label}"`);
  if (reg.accounts.length === 1) {
    throw new Error('Refusing to remove the only configured account');
  }
  if (reg.accounts[idx].isDefault) {
    throw new Error(
      `"${label}" is the anchor (~/.claude) account and can't be unregistered`,
    );
  }
  reg.accounts.splice(idx, 1);
  if (reg.defaultAccount === label) {
    const anchor = reg.accounts.find((a) => a.isDefault) || reg.accounts[0];
    reg.defaultAccount = anchor.label;
  }
  writeRegistry(reg);
  regenerate(reg);
  return reg.defaultAccount;
}

export function setDefault(label: string): void {
  const reg = readRegistry();
  if (!reg.accounts.some((a) => a.label === label)) {
    throw new Error(`No account "${label}"`);
  }
  reg.defaultAccount = label;
  writeRegistry(reg);
  regenerate(reg);
}

export interface ListedAccount extends RegistryAccount {
  isCurrentDefault: boolean;
}

/** Registry accounts enriched with live identity + a current-default flag. */
export function listAccounts(): ListedAccount[] {
  const reg = readRegistry();
  const defaultLabel = resolveDefaultLabel(reg);
  return reg.accounts.map((a) => ({
    ...a,
    ...readIdentity(a.identityFile),
    isCurrentDefault: a.label === defaultLabel,
  }));
}

// ---------------------------------------------------------------------------
// shell hook install / uninstall (the ~/.zshrc source block)
// ---------------------------------------------------------------------------

export function isShellHookInstalled(): boolean {
  try {
    return fs.readFileSync(ZSHRC_PATH, 'utf-8').includes(ZSHRC_BEGIN);
  } catch {
    return false;
  }
}

export function installShellHook(): { changed: boolean; path: string } {
  regenerate();
  if (isShellHookInstalled()) return { changed: false, path: ZSHRC_PATH };
  const block = [
    '',
    ZSHRC_BEGIN,
    '[ -f "$HOME/.config/codev/accounts.sh" ] && source "$HOME/.config/codev/accounts.sh"',
    ZSHRC_END,
    '',
  ].join('\n');
  fs.appendFileSync(ZSHRC_PATH, block, 'utf-8');
  return { changed: true, path: ZSHRC_PATH };
}

export function uninstallShellHook(): { changed: boolean; path: string } {
  let content: string;
  try {
    content = fs.readFileSync(ZSHRC_PATH, 'utf-8');
  } catch {
    return { changed: false, path: ZSHRC_PATH };
  }
  if (!content.includes(ZSHRC_BEGIN)) {
    return { changed: false, path: ZSHRC_PATH };
  }
  const re = new RegExp(`\\n?${ZSHRC_BEGIN}[\\s\\S]*?${ZSHRC_END}\\n?`, 'g');
  fs.writeFileSync(ZSHRC_PATH, content.replace(re, '\n'), 'utf-8');
  return { changed: true, path: ZSHRC_PATH };
}
