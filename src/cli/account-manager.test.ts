import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import {
  generateAccountsSh,
  resolveDefaultLabel,
  type Registry,
} from './account-manager';

const HOME = os.homedir();

/** A representative two-account registry (personal default + work extra). */
function reg(overrides: Partial<Registry> = {}): Registry {
  return {
    version: 1,
    defaultAccount: 'personal',
    accounts: [
      {
        label: 'personal',
        dir: path.join(HOME, '.claude'),
        identityFile: path.join(HOME, '.claude.json'),
        configDirEnv: null,
        isDefault: true,
      },
      {
        label: 'work',
        dir: path.join(HOME, '.claude-work'),
        identityFile: path.join(HOME, '.claude-work', '.claude.json'),
        configDirEnv: path.join(HOME, '.claude-work'),
        isDefault: false,
      },
    ],
    ...overrides,
  };
}

describe('generateAccountsSh', () => {
  it('launches the default account with NO CLAUDE_CONFIG_DIR', () => {
    const sh = generateAccountsSh(reg());
    expect(sh).toContain('claude-personal() { command claude "$@"; }');
  });

  it('launches an extra account with CLAUDE_CONFIG_DIR ($HOME-relative)', () => {
    const sh = generateAccountsSh(reg());
    expect(sh).toContain(
      'claude-work() { CLAUDE_CONFIG_DIR="$HOME/.claude-work" command claude "$@"; }',
    );
  });

  it('adds a dispatcher case per account', () => {
    const sh = generateAccountsSh(reg());
    expect(sh).toContain('personal) shift; command claude "$@" ;;');
    expect(sh).toContain(
      'work) shift; CLAUDE_CONFIG_DIR="$HOME/.claude-work" command claude "$@" ;;',
    );
  });

  it('routes the dispatcher fallback (*) to the current defaultAccount', () => {
    // defaultAccount = personal (the no-env anchor)
    expect(generateAccountsSh(reg())).toContain('*) command claude "$@" ;;');
    // defaultAccount = work -> bare `claude` must set work's config dir
    expect(generateAccountsSh(reg({ defaultAccount: 'work' }))).toContain(
      '*) CLAUDE_CONFIG_DIR="$HOME/.claude-work" command claude "$@" ;;',
    );
  });

  it('maps each account dir back to its label in claude-whoami', () => {
    const sh = generateAccountsSh(reg());
    expect(sh).toContain('"$HOME/.claude") label="personal (default)" ;;');
    expect(sh).toContain('"$HOME/.claude-work") label="work" ;;');
  });

  it('emits syntactically valid shell (bash -n)', () => {
    const sh = generateAccountsSh(reg());
    const file = path.join(os.tmpdir(), `codev-accounts-${process.pid}.sh`);
    writeFileSync(file, sh);
    expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
  });
});

describe('resolveDefaultLabel', () => {
  it('returns defaultAccount when it names a real account', () => {
    expect(resolveDefaultLabel(reg({ defaultAccount: 'work' }))).toBe('work');
  });

  it('falls back to the isDefault anchor when defaultAccount is missing', () => {
    expect(resolveDefaultLabel(reg({ defaultAccount: undefined }))).toBe(
      'personal',
    );
  });

  it('falls back to the isDefault anchor when defaultAccount is unknown', () => {
    expect(resolveDefaultLabel(reg({ defaultAccount: 'ghost' }))).toBe(
      'personal',
    );
  });
});
