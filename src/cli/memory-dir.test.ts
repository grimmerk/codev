import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  anchorMemoryDir,
  memoryProjectRoot,
  memorySettingsJson,
  memoryShellHelper,
  memorySlug,
} from './memory-dir';

const ANCHOR = '/Users/probe/.claude';

let base: string;
let repo: string;
let subdir: string;
let worktree: string;
let plain: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

beforeAll(() => {
  // realpath: macOS tmpdirs are symlinked, and git reports the resolved path
  // while `path.resolve` does not — a test artefact, not a product rule.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memdir-')));
  repo = path.join(base, 'repo');
  subdir = path.join(repo, 'src', 'deep');
  worktree = path.join(base, 'repo-wt');
  plain = path.join(base, 'not-a-repo');
  fs.mkdirSync(subdir, { recursive: true });
  fs.mkdirSync(plain, { recursive: true });
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'probe@example.com');
  git(repo, 'config', 'user.name', 'probe');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'root');
  git(repo, 'worktree', 'add', '-q', '--detach', worktree);
});

afterAll(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe('memorySlug', () => {
  it('replaces every non-alphanumeric byte and keeps case', () => {
    expect(memorySlug('/Users/g/git/codev')).toBe('-Users-g-git-codev');
    // A path that already contains a dash-heavy segment doubles up, exactly as
    // Claude Code's own directories do.
    expect(memorySlug('/private/tmp/-Users-g/x')).toBe(
      '-private-tmp--Users-g-x',
    );
  });
});

describe('memoryProjectRoot', () => {
  it('is the repository root from the root, a subdirectory, or a worktree', () => {
    expect(memoryProjectRoot(repo)).toBe(repo);
    expect(memoryProjectRoot(subdir)).toBe(repo);
    // The case the whole feature rests on: a linked worktree keys on the MAIN
    // repository, so both share one memory.
    expect(memoryProjectRoot(worktree)).toBe(repo);
  });

  it('falls back to the directory itself outside a repository', () => {
    expect(memoryProjectRoot(plain)).toBe(plain);
  });
});

describe('the shell helper agrees with the TypeScript rule', () => {
  // One rule, two implementations (TypeScript for CodeV's own launches, shell
  // for the generated accounts.sh dispatcher). Pin them together or they drift.
  const runHelper = (cwd: string): string => {
    const script = path.join(base, 'helper.sh');
    fs.writeFileSync(
      script,
      `${memoryShellHelper(ANCHOR)}\n_codev_memory_settings\n`,
    );
    return execFileSync('zsh', [script], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  };

  it('produces the same payload for a repo, a subdirectory, a worktree and a plain directory', () => {
    for (const cwd of [repo, subdir, worktree, plain]) {
      expect(runHelper(cwd), `cwd=${cwd}`).toBe(
        memorySettingsJson(anchorMemoryDir(ANCHOR, cwd)),
      );
    }
  });

  it('emits valid JSON naming a directory under the anchor account', () => {
    const parsed = JSON.parse(runHelper(repo));
    expect(parsed.autoMemoryDirectory).toBe(
      `${ANCHOR}/projects/${memorySlug(repo)}/memory`,
    );
  });
});
