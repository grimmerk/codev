/**
 * CodeV multi-account registry reader.
 *
 * Source of truth: ~/.config/codev/accounts.json (also consumed by the shell
 * integration at ~/.config/codev/accounts.sh). When the registry is absent we
 * fall back to a single default account (~/.claude), so single-account users
 * keep today's exact behavior and see no new UI.
 *
 * Key nuance (see docs/multi-account-support-design.md §3.4): the DEFAULT account
 * uses NO CLAUDE_CONFIG_DIR — its .claude.json is at ~/.claude.json (HOME), while
 * its dir contents live in ~/.claude/. Extra accounts are fully self-contained in
 * ~/.claude-<label>/. So:
 *   - dir           = where session data lives (history.jsonl/projects/sessions) — always set
 *   - configDirEnv  = CLAUDE_CONFIG_DIR to set at launch — null for the default account
 *   - identityFile  = .claude.json path — ~/.claude.json for default, <dir>/.claude.json otherwise
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

export interface CodevAccount {
  label: string;
  dir: string; // config dir for session scanning (anchor account: ~/.claude)
  configDirEnv: string | null; // CLAUDE_CONFIG_DIR at launch; null => anchor account (unset)
  identityFile: string; // .claude.json path (HOME for the anchor, <dir>/.claude.json otherwise)
  // The anchor is the ~/.claude account — distinct from the GLOBAL DEFAULT
  // (registry `defaultAccount`, what bare `claude` opens). Historically this
  // field was called `isDefault`, which conflated the two concepts.
  isAnchor: boolean;
  email?: string;
  org?: string;
  subscription?: string;
  loggedIn?: boolean;
}

/** Shape of an entry in accounts.json (all optional — we coerce/validate). */
interface RawAccount {
  label?: string;
  dir?: string;
  configDirEnv?: string | null;
  identityFile?: string;
  isAnchor?: boolean;
  email?: string;
  org?: string;
  subscription?: string;
  loggedIn?: boolean;
}

interface RawRegistry {
  accounts?: RawAccount[];
  defaultAccount?: string;
}

const REGISTRY_PATH = path.join(
  os.homedir(),
  '.config',
  'codev',
  'accounts.json',
);

const expandHome = (p: string): string =>
  p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;

const makeAnchorAccount = (): CodevAccount => ({
  label: 'default',
  dir: path.join(os.homedir(), '.claude'),
  configDirEnv: null,
  identityFile: path.join(os.homedir(), '.claude.json'),
  isAnchor: true,
});

let cached: CodevAccount[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5000;

export const invalidateAccountsCache = (): void => {
  cached = null;
};

/**
 * All configured accounts. Always returns at least one (the default).
 * Cached for 5s to avoid re-reading the registry on every keystroke.
 */
export const getAccounts = (): CodevAccount[] => {
  const now = Date.now();
  if (cached && now - cacheTimestamp < CACHE_TTL_MS) {
    return cached;
  }

  let accounts: CodevAccount[];
  try {
    if (!fs.existsSync(REGISTRY_PATH)) {
      accounts = [makeAnchorAccount()];
    } else {
      const raw = JSON.parse(
        fs.readFileSync(REGISTRY_PATH, 'utf-8'),
      ) as RawRegistry;
      const list: RawAccount[] = Array.isArray(raw?.accounts)
        ? raw.accounts
        : [];
      accounts = list.map((a: RawAccount): CodevAccount => {
        const dir = expandHome(
          String(a.dir || path.join(os.homedir(), '.claude')),
        );
        // If the flag is omitted (partial hand-written entry), infer from the
        // dir itself — ~/.claude IS the anchor by definition. Never infer
        // from defaultAccount: that's the dispatcher target, a different
        // concept (and would misroute once the default is a non-anchor).
        const isAnchor =
          a.isAnchor ??
          (path.resolve(dir) === path.join(os.homedir(), '.claude'));
        const configDirEnv =
          a.configDirEnv === null || a.configDirEnv === undefined
            ? isAnchor
              ? null
              : dir
            : expandHome(String(a.configDirEnv));
        const identityFile = a.identityFile
          ? expandHome(String(a.identityFile))
          : isAnchor
            ? path.join(os.homedir(), '.claude.json')
            : path.join(dir, '.claude.json');
        return {
          label: String(a.label || 'default'),
          dir,
          configDirEnv,
          identityFile,
          isAnchor,
          email: a.email,
          org: a.org,
          subscription: a.subscription,
          loggedIn: a.loggedIn,
        };
      });
      if (accounts.length === 0) {
        accounts = [makeAnchorAccount()];
      }
    }
  } catch (error) {
    console.error('Error reading codev accounts registry:', error);
    accounts = [makeAnchorAccount()];
  }

  cached = accounts;
  cacheTimestamp = now;
  return accounts;
};

/**
 * Accounts whose config dir actually exists on disk — i.e. worth scanning for
 * sessions. A registered-but-not-yet-logged-in account (dir missing) is skipped.
 */
export const getScannableAccounts = (): CodevAccount[] =>
  getAccounts().filter((a) => {
    try {
      return fs.existsSync(a.dir);
    } catch {
      return false;
    }
  });

/** Look up an account by label (falls back to the anchor account). */
export const getAccountByLabel = (label: string | undefined): CodevAccount => {
  const accounts = getAccounts();
  return (
    accounts.find((a) => a.label === label) ||
    accounts.find((a) => a.isAnchor) ||
    accounts[0]
  );
};

/** True when more than one account is configured (used to gate account UI). */
export const isMultiAccount = (): boolean => getAccounts().length > 1;

/**
 * A session's transcripts live under its account's config dir (`<dir>/projects`).
 * Falls back to ~/.claude for sessions without an account tag (e.g. VS Code).
 */
export const getProjectsDir = (accountDir?: string): string =>
  path.join(accountDir || path.join(os.homedir(), '.claude'), 'projects');
