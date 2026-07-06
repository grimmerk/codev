#!/usr/bin/env node
/**
 * `codev account` — manage CodeV's multi-account registry from the terminal.
 *
 * Run (dev):  yarn account <cmd> [args]
 * e.g.        yarn account list
 *             yarn account add work
 *             yarn account default work
 *             yarn account remove work
 *
 * It mutates ~/.config/codev/accounts.json and regenerates
 * ~/.config/codev/accounts.sh via the shared manager (src/cli/account-manager.ts),
 * so the shell integration and CodeV stay in sync. Distribution as a real
 * `codev account` binary on PATH is wired up in Batch 2b.
 */

import * as manager from './account-manager';

const USAGE = `codev account — manage CodeV multi-account registry

Usage:
  codev account list                 List configured accounts
  codev account add <label> [--dir D] Register a new account (default dir ~/.claude-<label>)
  codev account default <label>      Set which account bare \`claude\` resolves to
  codev account remove <label>       Unregister an account (leaves its dir on disk)
  codev account regenerate           Rewrite ~/.config/codev/accounts.sh from the registry
  codev account show                 Print the generated accounts.sh (dry run, writes nothing)
  codev account install              Add the source line to ~/.zshrc (idempotent)
  codev account uninstall            Remove the ~/.zshrc block (keeps registry + dir)
  codev account help                 Show this help

After add/default/remove: open a new shell or \`source ~/.zshrc\` to pick up changes.`;

function reloadHint(): void {
  console.log('  → open a new shell or run: source ~/.zshrc');
}

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printList(): void {
  const accounts = manager.listAccounts();
  if (accounts.length === 0) {
    console.log('No accounts configured yet. Add one with: codev account add <label>');
    return;
  }
  const pad = Math.max(...accounts.map((a) => a.label.length), 5);
  console.log(`codev accounts (registry: ${manager.REGISTRY_PATH})`);
  for (const a of accounts) {
    const star = a.isCurrentDefault ? '*' : ' ';
    const who = a.loggedIn
      ? a.email || '(logged in)'
      : '(not logged in — run: claude ' + a.label + ')';
    const tags = [
      a.isDefault ? 'anchor ~/.claude' : `CLAUDE_CONFIG_DIR=${a.dir}`,
    ];
    console.log(`  ${star} ${a.label.padEnd(pad)}  ${who}`);
    console.log(`      ${tags.join('  ')}`);
  }
  console.log("  ('*' = bare 'claude' resolves here)");
}

function main(): number {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'list':
    case 'ls':
      printList();
      return 0;

    case 'add': {
      const label = rest.find((a) => !a.startsWith('-'));
      const dir = getFlag(rest, '--dir');
      const a = manager.addAccount(label as string, { dir });
      console.log(`✓ Added "${a.label}"  (${a.dir})`);
      if (!a.loggedIn) {
        console.log(`  Log in with:  claude ${a.label}   (or claude-${a.label})`);
      }
      reloadHint();
      return 0;
    }

    case 'default': {
      const label = rest[0];
      manager.setDefault(label);
      console.log(`✓ bare 'claude' now resolves to "${label}"`);
      reloadHint();
      return 0;
    }

    case 'remove':
    case 'rm': {
      const label = rest[0];
      const newDefault = manager.removeAccount(label);
      console.log(`✓ Unregistered "${label}" (its dir is left on disk)`);
      if (newDefault) console.log(`  default account is now "${newDefault}"`);
      reloadHint();
      return 0;
    }

    case 'regenerate':
    case 'regen': {
      const p = manager.regenerate();
      console.log(`✓ Regenerated ${p}`);
      reloadHint();
      return 0;
    }

    case 'show':
    case 'preview':
      // Print what accounts.sh WOULD contain — a dry run, writes nothing.
      process.stdout.write(manager.generateAccountsSh(manager.readRegistry()));
      return 0;

    case 'install': {
      const r = manager.installShellHook();
      console.log(
        r.changed
          ? `✓ Added CodeV source block to ${r.path}`
          : `• ${r.path} already sources CodeV accounts (no change)`,
      );
      reloadHint();
      return 0;
    }

    case 'uninstall': {
      const r = manager.uninstallShellHook();
      console.log(
        r.changed
          ? `✓ Removed CodeV block from ${r.path} (registry + dirs kept)`
          : `• No CodeV block found in ${r.path} (no change)`,
      );
      return 0;
    }

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE);
      return 0;

    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(USAGE);
      return 1;
  }
}

try {
  process.exit(main());
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}
