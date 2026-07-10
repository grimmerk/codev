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

import * as os from 'os';

import * as manager from './account-manager';
import * as share from './share-manager';
import type { ShareItemKey, ShareState } from './share-manager';

const USAGE = `codev account — manage CodeV multi-account registry

Usage:
  codev account list                 List configured accounts
  codev account add <label> [--dir D] [--anchor-name N]
                                     Register a new account (default dir ~/.claude-<label>);
                                     on the first-ever add, N names your existing
                                     ~/.claude account (default: main — or primary
                                     when the new account itself is named main)
  codev account default <label>      Set which account bare \`claude\` resolves to
  codev account remove <label>       Unregister an account (leaves its dir on disk)
  codev account rename <old> <new>   Rename an account's label (folder is not moved)
  codev account share <name>         Sharing status (claude-md / skills / commands)
  codev account share <name> <item> --link|--copy [--entry E]
                                     Share the anchor's <item> into <name>
                                     (link = stay in sync; copy = independent fork)
  codev account unshare <name> <item> [--entry E] [--restore-backup|--keep-copy]
                                     Remove the link (source untouched);
                                     --restore-backup = undo a share that displaced
                                     own content; --keep-copy = keep a real copy
  codev account sync-settings <name> <key...>
                                     Copy settings.json keys from the anchor
                                     (allowed: statusLine, model, effortLevel, theme)
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

function assertShareItem(item: string): asserts item is ShareItemKey {
  if (!(share.SHARE_ITEMS as string[]).includes(item)) {
    throw new Error(
      `Unknown item "${item}" — one of: ${share.SHARE_ITEMS.join(', ')}`,
    );
  }
}

const tildify = (p: string): string =>
  p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p;

function describeShareState(s: ShareState): string {
  switch (s.kind) {
    case 'none':
      return 'none';
    case 'own':
      return 'own (not shared)';
    case 'linked':
      return `linked → ${tildify(s.to)}`;
    case 'broken-link':
      return `BROKEN link → ${tildify(s.to)}`;
    case 'mixed':
      return `mixed (${s.linked.length} linked: ${s.linked.join(', ')}; ${s.own.length} own)`;
  }
}

function printShareStatus(name: string): void {
  const status = share.shareStatusFor(name);
  console.log(`Sharing status for "${name}" (source = anchor ~/.claude):`);
  for (const item of share.SHARE_ITEMS) {
    const st = status[item];
    const backups = st.backups.length
      ? `   [${st.backups.length} backup${st.backups.length > 1 ? 's' : ''}]`
      : '';
    console.log(
      `  ${item.padEnd(10)} ${describeShareState(st.state)}${backups}`,
    );
  }
  console.log(
    "  share with: codev account share <name> <item> --link (or --copy); plugins/settings keys via 'sync-settings'",
  );
}

function printList(): void {
  const accounts = manager.listAccounts();
  if (accounts.length === 0) {
    console.log(
      'No accounts configured yet. Add one with: codev account add <label>',
    );
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
      a.isAnchor ? 'anchor ~/.claude' : `CLAUDE_CONFIG_DIR=${a.dir}`,
    ];
    console.log(`  ${star} ${a.label.padEnd(pad)}  ${who}`);
    console.log(`      ${tags.join('  ')}`);
  }
  console.log("  ('*' = bare 'claude' resolves here)");
}

function main(): number {
  const argv = process.argv.slice(2);
  // Installed form is `codev account <cmd>`; the dev form `yarn account <cmd>`
  // passes <cmd> directly. Accept both.
  if (argv[0] === 'account') argv.shift();
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'list':
    case 'ls':
      printList();
      return 0;

    case 'add': {
      const dir = getFlag(rest, '--dir');
      const anchorName = getFlag(rest, '--anchor-name');
      // Skip tokens consumed by flags so `add --dir /foo work` still picks
      // `work` as the label (not `/foo`).
      const skip = new Set<number>();
      for (const flag of ['--dir', '--anchor-name']) {
        const i = rest.indexOf(flag);
        if (i >= 0) skip.add(i + 1);
      }
      const label = rest.find((a, i) => !a.startsWith('-') && !skip.has(i));
      const wasFresh = manager.readRegistry().accounts.length === 0;
      const acct = manager.addAccount(label as string, { dir, anchorName });
      console.log(`✓ Added "${acct.label}"  (${acct.dir})`);
      if (wasFresh && !acct.isAnchor) {
        const anchor = manager.listAccounts().find((x) => x.isAnchor);
        if (anchor) {
          console.log(
            `  Your existing ~/.claude login is registered as "${anchor.label}" (change: codev account rename ${anchor.label} <new>)`,
          );
        }
      }
      if (!acct.loggedIn) {
        console.log(
          `  Log in with:  claude ${acct.label}   (or claude-${acct.label})`,
        );
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

    case 'rename': {
      const [oldLabel, newLabel] = rest;
      manager.renameAccount(oldLabel, newLabel);
      console.log(`✓ Renamed "${oldLabel}" → "${newLabel}" (folder unchanged)`);
      // A plain `source ~/.zshrc` adds the new functions but does NOT unset
      // the old claude-<oldLabel> in the current shell — recommend a new one.
      console.log(
        `  → open a NEW shell (sourcing would keep the old claude-${oldLabel} defined here)`,
      );
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

    case 'share': {
      const entry = getFlag(rest, '--entry');
      const skip = new Set<number>();
      const ei = rest.indexOf('--entry');
      if (ei >= 0) skip.add(ei + 1);
      const positional = rest.filter(
        (a, i) => !a.startsWith('-') && !skip.has(i),
      );
      const [name, item] = positional;
      if (!name) {
        console.error('share: <name> is required');
        return 1;
      }
      if (!item) {
        printShareStatus(name);
        return 0;
      }
      assertShareItem(item);
      const wantLink = rest.includes('--link');
      const wantCopy = rest.includes('--copy');
      if (wantLink === wantCopy) {
        // neither, or ambiguously both
        console.error(
          'share: pass exactly one of --link (stay in sync) or --copy (fork)',
        );
        return 1;
      }
      const mode = wantCopy ? ('copy' as const) : ('link' as const);
      const r = share.shareFor(name, item, mode, entry);
      console.log(
        `✓ ${mode === 'link' ? 'Linked' : 'Copied'} ${item}${entry ? `/${entry}` : ''} → ${r.target}`,
      );
      if (r.backedUpTo) {
        console.log(
          `  previous content backed up: ${r.backedUpTo} (unshare --restore-backup undoes this)`,
        );
      }
      console.log('  new Claude Code sessions pick this up immediately');
      return 0;
    }

    case 'unshare': {
      const entry = getFlag(rest, '--entry');
      const skip = new Set<number>();
      const ei = rest.indexOf('--entry');
      if (ei >= 0) skip.add(ei + 1);
      const positional = rest.filter(
        (a, i) => !a.startsWith('-') && !skip.has(i),
      );
      const [name, item] = positional;
      if (!name || !item) {
        console.error('unshare: <name> and <item> are required');
        return 1;
      }
      assertShareItem(item);
      const r = share.unshareFor(
        name,
        item,
        {
          restoreBackup: rest.includes('--restore-backup'),
          keepCopy: rest.includes('--keep-copy'),
        },
        entry,
      );
      console.log(`✓ Unshared ${item}${entry ? `/${entry}` : ''}`);
      if (r.restoredFrom) {
        console.log(`  restored your previous content from ${r.restoredFrom}`);
      } else if (rest.includes('--keep-copy')) {
        console.log('  kept an independent copy of the shared content');
      } else {
        console.log(
          '  the source is untouched — share --link again to re-attach',
        );
      }
      return 0;
    }

    case 'sync-settings': {
      const [name, ...keys] = rest.filter((a) => !a.startsWith('-'));
      if (!name || keys.length === 0) {
        console.error(
          `sync-settings: <name> and at least one key are required (allowed: ${share.SYNCABLE_SETTINGS_KEYS.join(', ')})`,
        );
        return 1;
      }
      const r = share.syncSettingsFor(name, keys);
      if (r.copied.length) {
        console.log(`✓ Copied from the anchor: ${r.copied.join(', ')}`);
      }
      if (r.missingInSource.length) {
        console.log(
          `  not set on the anchor (skipped): ${r.missingInSource.join(', ')}`,
        );
      }
      console.log('  applies to NEW Claude Code sessions of that account');
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
