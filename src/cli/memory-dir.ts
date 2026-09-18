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

/** The directory Claude Code keys this project's auto-memory on. */
export const memoryProjectRoot = (cwd: string): string => {
  const start = path.resolve(cwd);
  try {
    const out = execFileSync(
      'git',
      ['-C', start, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    // `.../repo/.git` → `.../repo`. A linked worktree reports the MAIN
    // repository's git dir, which is exactly why worktrees share memory.
    if (out) return path.dirname(out);
  } catch {
    // Not a repository (or no git) — the directory itself is the key.
  }
  return start;
};

/** Absolute path → the `projects/` directory name Claude Code uses for it. */
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
    fs.writeFileSync(file, memorySettingsJson(anchorMemoryDir(anchorDir, cwd)));
    return ` --settings ${file}`;
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
    '  root=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)',
    '  if [ -n "$root" ]; then root="${root%/*}"; else root="$PWD"; fi',
    "  slug=$(printf '%s' \"$root\" | sed 's/[^a-zA-Z0-9]/-/g')",
    `  printf '{"autoMemoryDirectory":"%s/projects/%s/memory"}' ${JSON.stringify(anchorDir)} "$slug"`,
    '}',
  ].join('\n');
