/**
 * Auto-memory sharing: point a non-anchor account's memory at the anchor's.
 *
 * Claude Code keeps auto-memory per project, under
 * `<config dir>/projects/<slug>/memory/`, so two accounts on one machine keep
 * two separate trees for the same repository. `autoMemoryDirectory` in any
 * settings scope relocates it, and `--settings` is a scope, so a launcher can
 * redirect a non-anchor account per launch without touching either account's
 * settings file — and without writing anything into the repository.
 *
 * The slug rule, measured against Claude Code 2.1.276 on 2026-09-18:
 *
 * - the key is the **git common directory's parent**, so every worktree and
 *   every subdirectory of one repository share one memory. Verified on disk
 *   against a real linked worktree: it reports the MAIN repository's `.git`,
 *   and only the main repository's slug exists under `projects/`, with no
 *   second one for the worktree's own path;
 * - outside a git repository the key is the directory itself;
 * - the slug is that absolute path with every non-alphanumeric byte replaced
 *   by `-`, case preserved (`/Users/g/git/codev` → `-Users-g-git-codev`).
 *
 * What is NOT shared: the session transcript. Claude Code still writes it to
 * the launching account's own `projects/<slug>/` (confirmed by probe — the
 * slug directory is created for the transcript, with no `memory/` inside it),
 * which is what keeps CodeV's per-account session attribution working.
 */
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

const GIT_DISCOVERY_VARS = [
  'GIT_DIR',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
] as const;

/**
 * `process.env` with those removed — DELETED, never set to '': an empty
 * `GIT_DIR` is not an unset one, git reads it as "the git dir is ''" and fails,
 * which would send every lookup down the working-directory fallback.
 */
const envWithoutGitDiscovery = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of GIT_DISCOVERY_VARS) delete env[k];
  return env;
};

/** The directory Claude Code keys this project's auto-memory on. */
export const memoryProjectRoot = (cwd: string): string => {
  const start = path.resolve(cwd);
  try {
    const out = execFileSync(
      'git',
      ['-C', start, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
        // A launching shell that exports any of these would key the memory to
        // a different repository, or suppress discovery so the two
        // implementations fall back to different paths.
        env: envWithoutGitDiscovery(),
      },
    ).trim();
    // `.../repo/.git` → `.../repo`. A linked worktree reports the MAIN
    // repository's git dir, which is exactly why worktrees share memory.
    if (out) return path.dirname(out);
  } catch {
    // Not a repository (or no git) — the directory itself is the key.
  }
  return start;
};

/**
 * Absolute path → the `projects/` directory name Claude Code uses for it.
 *
 * Two properties of this rule are inherited, not chosen, because the whole
 * point is to name the directory Claude Code itself will use:
 *
 * - **it collides.** `/tmp/a-b` and `/tmp/a/b` both become `-tmp-a-b`, so they
 *   share one memory. That is already true for a single account today; a
 *   collision-free key here would just name a directory Claude Code never reads.
 * - **it counts UTF-16 code units, not characters.** Measured 2026-09-18 by
 *   running a real session in `…/x/😀/y`: Claude Code named the directory
 *   `…-x----y`, four dashes — the surrogate pair counts twice. `sed` counts
 *   characters and produced three, so the shell twin used to disagree outside
 *   the Basic Multilingual Plane; it now normalises with `perl`, which can
 *   count code units, and the agreement test covers an astral path.
 */
export const memorySlug = (root: string): string =>
  root.replace(/[^a-zA-Z0-9]/g, '-');

/** The anchor account's memory directory for the project `cwd` belongs to. */
export const anchorMemoryDir = (anchorDir: string, cwd: string): string =>
  path.join(
    anchorDir,
    'projects',
    memorySlug(memoryProjectRoot(cwd)),
    'memory',
  );

/** The settings payload that relocates auto-memory to `dir`. */
export const memorySettingsJson = (dir: string): string =>
  JSON.stringify({ autoMemoryDirectory: dir });

/**
 * Where CodeV keeps the generated settings files, one per project slug.
 *
 * A FILE rather than the inline JSON the shell dispatcher uses, because
 * CodeV's own launches embed the command in an AppleScript string and two of
 * the four terminals do not escape it: Ghostty's `initial input:"…"` and
 * cmux's `--command "…"` interpolate it raw, so a JSON payload's double
 * quotes would end the string and the launch would fail. (iTerm2 and
 * Terminal.app do escape — the split is why this is a file and not a
 * quoting fix.) A path under `~/.config/codev` has no quotes in it at all.
 */
export const memorySettingsDir = (): string =>
  path.join(os.homedir(), '.config', 'codev', 'memory-settings');

export const memorySettingsPath = (cwd: string): string =>
  path.join(memorySettingsDir(), `${memorySlug(memoryProjectRoot(cwd))}.json`);

/**
 * Write the settings file for this project and return the `--settings <path>`
 * argument, or '' when anything fails — a launch must never be blocked by
 * memory sharing, it just falls back to the account's own memory.
 */
export const memorySettingsArg = (anchorDir: string, cwd: string): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    const file = memorySettingsPath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Temp + rename: two launches for one repository race otherwise, and a
    // reader catching the truncated moment gets unparseable settings.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, memorySettingsJson(anchorMemoryDir(anchorDir, cwd)));
    fs.renameSync(tmp, file);
    // Single-quoted: the slug is alphanumerics and dashes, but the home
    // directory in front of it is not (`/Users/John Doe`). Single quotes are
    // what the CLAUDE_CONFIG_DIR prefix beside this already uses, and they
    // survive every terminal — including the two that embed the command in an
    // AppleScript double-quoted string without escaping it.
    return ` --settings '${file.replace(/'/g, "'\\''")}'`;
  } catch (err) {
    console.error('[memory-dir] could not write the settings file:', err);
    return '';
  }
};

/**
 * The same rule as a shell function, for the generated `accounts.sh`.
 *
 * A second implementation of one rule, which is a defect generator unless the
 * two are pinned together — `memory-dir.test.ts` runs this function under zsh
 * and asserts it agrees with `anchorMemoryDir` for a table of paths, including
 * a real repository, a subdirectory, a linked worktree and a non-repository.
 *
 * Inline JSON is safe here: the dispatcher runs in a plain shell with no
 * AppleScript layer in between.
 */
export const memoryShellHelper = (anchorDir: string): string =>
  [
    '# --- shared auto-memory (Settings > Accounts > Sharing) ---',
    '# Echoes the --settings payload that points this launch at the anchor',
    "# account's memory for the current project: the git common dir's parent,",
    '# or the working directory outside a repository.',
    '_codev_memory_settings() {',
    '  local root slug',
    // `env -u`, not `VAR=`: an EMPTY GIT_DIR is not an unset one — git fails
    // outright on it and both sides would silently take the $PWD fallback.
    '  root=$(env -u GIT_DIR -u GIT_COMMON_DIR -u GIT_CEILING_DIRECTORIES \\',
    '    -u GIT_DISCOVERY_ACROSS_FILESYSTEM \\',
    '    git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)',
    '  if [ -n "$root" ]; then root="${root%/*}"; else root="$PWD"; fi',
    // `tr` first: a newline would otherwise survive as a line separator (perl
    // is line-based here) and land raw inside the JSON string.
    //
    // Then perl, not sed, because the replacement count has to be UTF-16 code
    // UNITS to match Claude Code — one dash for a BMP character, two for an
    // astral one. `sed` counts characters and got `😀` wrong. perl ships with
    // macOS, which is the only platform CodeV runs on.
    '  slug=$(printf \'%s\' "$root" | tr \'\\n\' \'-\' |',
    '    perl -CSD -pe \'s/([^a-zA-Z0-9])/"-" x (ord($1) > 0xFFFF ? 2 : 1)/ge\')',
    `  printf '{"autoMemoryDirectory":"%s/projects/%s/memory"}' ${JSON.stringify(anchorDir)} "$slug"`,
    '}',
  ].join('\n');
