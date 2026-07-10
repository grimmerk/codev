import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getShareState,
  listBackups,
  shareItem,
  syncSettingsKeys,
  unshareItem,
} from './share-manager';

// Real-fs integration tests under a per-test tmpdir — the engine is
// path-based precisely so it can be exercised against actual symlinks.
let root: string;
let anchorDir: string;
let accountDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codev-share-'));
  anchorDir = path.join(root, 'anchor');
  accountDir = path.join(root, 'account');
  fs.mkdirSync(anchorDir, { recursive: true });
  fs.mkdirSync(accountDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (p: string, content: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

describe('shareItem / getShareState', () => {
  it('links a file and reports linked with the resolved target', () => {
    const source = path.join(anchorDir, 'CLAUDE.md');
    const target = path.join(accountDir, 'CLAUDE.md');
    write(source, 'global rules');

    const r = shareItem(source, target, 'link');
    expect(r.backedUpTo).toBeUndefined();
    expect(fs.readFileSync(target, 'utf-8')).toBe('global rules');
    expect(getShareState(target)).toEqual({ kind: 'linked', to: source });
  });

  it('backs up an existing own file before linking (never silent overwrite)', () => {
    const source = path.join(anchorDir, 'CLAUDE.md');
    const target = path.join(accountDir, 'CLAUDE.md');
    write(source, 'anchor version');
    write(target, 'my own version');

    const r = shareItem(source, target, 'link');
    expect(r.backedUpTo).toBeDefined();
    expect(fs.readFileSync(r.backedUpTo as string, 'utf-8')).toBe(
      'my own version',
    );
    expect(getShareState(target).kind).toBe('linked');
    expect(listBackups(target)).toHaveLength(1);
  });

  it('copy mode forks: mutating the copy does not touch the source', () => {
    const source = path.join(anchorDir, 'skills');
    const target = path.join(accountDir, 'skills');
    write(path.join(source, 'my-skill', 'SKILL.md'), 'v1');

    shareItem(source, target, 'copy');
    expect(getShareState(target).kind).toBe('own');
    fs.writeFileSync(path.join(target, 'my-skill', 'SKILL.md'), 'forked');
    expect(
      fs.readFileSync(path.join(source, 'my-skill', 'SKILL.md'), 'utf-8'),
    ).toBe('v1');
  });

  it('links a whole dir and recognizes a pre-existing hand-made link', () => {
    const source = path.join(anchorDir, 'skills');
    const target = path.join(accountDir, 'skills');
    write(path.join(source, 'a', 'SKILL.md'), 'x');
    // hand-made link (what the user already has on their machine)
    fs.symlinkSync(source, target);

    expect(getShareState(target)).toEqual({ kind: 'linked', to: source });
    // re-sharing over an existing link replaces the pointer, no backup needed
    const r = shareItem(source, target, 'link');
    expect(r.backedUpTo).toBeUndefined();
    expect(getShareState(target).kind).toBe('linked');
  });

  it('reports mixed for a real dir containing per-entry links', () => {
    const source = path.join(anchorDir, 'skills');
    const target = path.join(accountDir, 'skills');
    write(path.join(source, 'shared-skill', 'SKILL.md'), 'x');
    write(path.join(target, 'private-skill', 'SKILL.md'), 'y');
    shareItem(
      path.join(source, 'shared-skill'),
      path.join(target, 'shared-skill'),
      'link',
    );

    const state = getShareState(target);
    expect(state.kind).toBe('mixed');
    if (state.kind === 'mixed') {
      expect(state.linked).toEqual(['shared-skill']);
      expect(state.own).toEqual(['private-skill']);
    }
  });

  it('detects a broken link', () => {
    const source = path.join(anchorDir, 'CLAUDE.md');
    const target = path.join(accountDir, 'CLAUDE.md');
    write(source, 'x');
    shareItem(source, target, 'link');
    fs.rmSync(source);
    expect(getShareState(target)).toEqual({
      kind: 'broken-link',
      to: source,
    });
  });
});

describe('unshareItem', () => {
  it('plain unlink removes the pointer and leaves the source intact', () => {
    const source = path.join(anchorDir, 'CLAUDE.md');
    const target = path.join(accountDir, 'CLAUDE.md');
    write(source, 'keep me');
    shareItem(source, target, 'link');

    unshareItem(target);
    expect(getShareState(target).kind).toBe('none');
    expect(fs.readFileSync(source, 'utf-8')).toBe('keep me');
  });

  it('restore-backup is a true undo of a share that displaced own content', () => {
    const source = path.join(anchorDir, 'CLAUDE.md');
    const target = path.join(accountDir, 'CLAUDE.md');
    write(source, 'anchor version');
    write(target, 'my own version');
    shareItem(source, target, 'link');

    const r = unshareItem(target, { restoreBackup: true });
    expect(r.restoredFrom).toBeDefined();
    expect(getShareState(target).kind).toBe('own');
    expect(fs.readFileSync(target, 'utf-8')).toBe('my own version');
    expect(listBackups(target)).toHaveLength(0); // consumed
  });

  it('keep-copy materializes the shared content as an own copy', () => {
    const source = path.join(anchorDir, 'skills');
    const target = path.join(accountDir, 'skills');
    write(path.join(source, 'a', 'SKILL.md'), 'shared');
    shareItem(source, target, 'link');

    unshareItem(target, { keepCopy: true });
    expect(getShareState(target).kind).toBe('own');
    expect(fs.readFileSync(path.join(target, 'a', 'SKILL.md'), 'utf-8')).toBe(
      'shared',
    );
    // now independent
    fs.writeFileSync(path.join(target, 'a', 'SKILL.md'), 'mine');
    expect(fs.readFileSync(path.join(source, 'a', 'SKILL.md'), 'utf-8')).toBe(
      'shared',
    );
  });

  it('a failed restore-backup leaves the link untouched', () => {
    const source = path.join(anchorDir, 'CLAUDE.md');
    const target = path.join(accountDir, 'CLAUDE.md');
    write(source, 'x');
    shareItem(source, target, 'link'); // no own content displaced → no backup

    expect(() => unshareItem(target, { restoreBackup: true })).toThrow(
      /No .*backup/,
    );
    // validation happens BEFORE unlinking — the share is still intact
    expect(getShareState(target)).toEqual({ kind: 'linked', to: source });
  });

  it('rapid re-shares get unique backup names (1s timestamp collision)', () => {
    const source = path.join(anchorDir, 'CLAUDE.md');
    const target = path.join(accountDir, 'CLAUDE.md');
    write(source, 'anchor');
    write(target, 'own v1');
    shareItem(source, target, 'link');
    unshareItem(target);
    write(target, 'own v2');
    shareItem(source, target, 'link'); // same second → must not clobber bak 1

    expect(listBackups(target)).toHaveLength(2);
  });

  it("refuses to unshare the account's own real file", () => {
    const target = path.join(accountDir, 'CLAUDE.md');
    write(target, 'own');
    expect(() => unshareItem(target)).toThrow(/own file/);
  });
});

describe('syncSettingsKeys', () => {
  it('copies allowlisted keys and reports missing ones', () => {
    const src = path.join(anchorDir, 'settings.json');
    const dst = path.join(accountDir, 'settings.json');
    write(
      src,
      JSON.stringify({
        statusLine: { type: 'command', command: 'x' },
        hooks: {},
      }),
    );
    write(dst, JSON.stringify({ theme: 'dark', hooks: { keep: true } }));

    const r = syncSettingsKeys(src, dst, ['statusLine', 'model']);
    expect(r.copied).toEqual(['statusLine']);
    expect(r.missingInSource).toEqual(['model']);
    const out = JSON.parse(fs.readFileSync(dst, 'utf-8'));
    expect(out.statusLine.command).toBe('x');
    expect(out.theme).toBe('dark'); // untouched
    expect(out.hooks).toEqual({ keep: true }); // untouched
  });

  it('fails with an actionable message on malformed settings JSON', () => {
    const src = path.join(anchorDir, 'settings.json');
    const dst = path.join(accountDir, 'settings.json');
    write(src, '{}');
    write(dst, '{not json');
    expect(() => syncSettingsKeys(src, dst, ['statusLine'])).toThrow(
      /Malformed JSON in .*settings\.json/,
    );
  });

  it('rejects non-allowlisted keys (hooks stay per-account)', () => {
    const src = path.join(anchorDir, 'settings.json');
    const dst = path.join(accountDir, 'settings.json');
    write(src, '{}');
    expect(() => syncSettingsKeys(src, dst, ['hooks'])).toThrow(
      /not a syncable key/,
    );
  });
});
