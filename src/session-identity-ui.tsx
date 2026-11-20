/**
 * Sessions tab: everything about ONE session's identity — the right-click
 * copy menu, ⌘⇧C, and the detail view.
 *
 * `switcher-ui.tsx` only calls `useSessionIdentityUi` and places what it
 * returns; all state lives here. The values come from the main process
 * (`getSessionIdentity`), which uses the same resolver as `codev session`.
 *
 * The detail view is ONE component (`SessionDetail`) in TWO hosts, kept so
 * the owner can try both and delete one:
 *   - HOST B `SessionDetailOverlay` — a modal over the list (⌘I)
 *   - HOST C `SessionDetailInline`  — expands under the row (⌘↓, ⌘↑ closes)
 * Removing a host = deleting its component, its state and the lines tagged
 * with its name in the hook below.
 *
 * The menu is drawn in the page rather than with a native `Menu.popup`: in
 * menu-bar mode the window hides itself on blur, and a native menu may take
 * focus away from it.
 */
import { FC, ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import {
  IDENTITY_FIELDS,
  IdentityFieldKey,
  identityFieldValue,
  SessionIdentity,
} from './cli/session-identity-fields';
import { truncateMiddle } from './session-search';

/** What the row knows about its session — enough to ask main for the rest. */
export interface IdentityTarget {
  sessionId: string;
  project: string;
  accountLabel?: string;
  /** The title the row shows (a saved list may have captured it). */
  fallbackTitle?: string;
  /** Distinguishes a pinned copy of a row from the row itself. */
  rowKey: string;
}

/** Build the target from a Sessions-tab row; null for a row with no session id. */
export const identityTargetOf = (
  session: any,
  titles: Record<string, string>,
): IdentityTarget | null => {
  if (!session || session.__liveOrphan || !session.sessionId) return null;
  return {
    sessionId: session.sessionId,
    project: session.project || '',
    accountLabel: session.accountLabel ?? session.__listMember?.accountLabel,
    fallbackTitle: titles[session.sessionId] || session.__listMember?.title,
    rowKey: `${session.__pinnedRow ? 'pin:' : ''}${session.sessionId}`,
  };
};

const PANEL_STYLE = {
  background: '#252526',
  border: '1px solid #454545',
  borderRadius: '8px',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
  outline: 'none',
} as const;
const ACTIVE_BG = '#094771';
const TEXT = '#e9e9e9';
const DIM = '#888';
const MONO = 'Menlo, Monaco, "Courier New", monospace';

const EMPTY_NOTE: Partial<Record<IdentityFieldKey, string>> = {
  title: 'no title',
  transcriptPath: 'not found',
  resumeCommand: 'not available',
};

// ---------------------------------------------------------------------------
// The detail component — shared by both hosts
// ---------------------------------------------------------------------------

type DetailRow = { key: string; label: string; value: string; note?: string };

const detailRows = (identity: SessionIdentity): DetailRow[] => {
  const rows: DetailRow[] = IDENTITY_FIELDS.map(({ key, label }) => ({
    key,
    label,
    value: identityFieldValue(identity, key),
    note:
      key === 'title' && identity.titleKind === 'ai'
        ? 'auto-generated — not a /rename name'
        : key === 'transcriptPath' && identity.transcriptOutsideProjectSlug
          ? "not under this project's own directory"
          : undefined,
  }));
  // Account sits after the id: it is shown and copyable, but is not one of
  // the menu's copy actions.
  rows.splice(2, 0, {
    key: 'account',
    label: 'Account',
    value: identity.account,
  });
  return rows;
};

const SessionDetail: FC<{
  identity: SessionIdentity;
  onCopy: (label: string, value: string) => void;
  /** Keyboard-highlighted row (the overlay drives this; inline leaves it unset). */
  activeIndex?: number;
  onHoverIndex?: (i: number) => void;
}> = ({ identity, onCopy, activeIndex, onHoverIndex }) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <div>
      {detailRows(identity).map((row, i) => {
        const empty = !row.value;
        return (
          <div
            key={row.key}
            role="button"
            aria-disabled={empty}
            data-tip={empty ? undefined : `Click to copy the ${row.label.toLowerCase()}`}
            // Keep focus where it is (the search box, or the overlay).
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => onHoverIndex?.(i)}
            onClick={(e) => {
              e.stopPropagation();
              if (empty) return;
              onCopy(row.label, row.value);
              setCopiedKey(row.key);
              if (timer.current) clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopiedKey(null), 1200);
            }}
            style={{
              display: 'flex',
              gap: '10px',
              padding: '3px 8px',
              borderRadius: '4px',
              cursor: empty ? 'default' : 'pointer',
              backgroundColor: i === activeIndex ? ACTIVE_BG : 'transparent',
            }}
          >
            <span style={{ width: '104px', flexShrink: 0, color: DIM, fontSize: '11px', paddingTop: '1px' }}>
              {row.label}
            </span>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                color: empty ? '#666' : TEXT,
                fontSize: '11px',
                fontFamily: row.key === 'title' || row.key === 'account' ? undefined : MONO,
                wordBreak: 'break-all',
                whiteSpace: 'pre-wrap',
              }}
            >
              {empty ? `(${EMPTY_NOTE[row.key as IdentityFieldKey] ?? 'none'})` : row.value}
              {row.note && <span style={{ color: '#c89030', fontFamily: 'inherit' }}>{`  — ${row.note}`}</span>}
            </span>
            <span style={{ width: '46px', flexShrink: 0, textAlign: 'right', color: '#66BB6A', fontSize: '10px' }}>
              {copiedKey === row.key ? 'copied' : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
};

// --- HOST C: inline, under the row -----------------------------------------

const SessionDetailInline: FC<{
  identity: SessionIdentity;
  onCopy: (label: string, value: string) => void;
}> = ({ identity, onCopy }) => (
  <div
    style={{
      margin: '0 4px 4px 27px',
      padding: '4px 0',
      borderLeft: '2px solid #3a6d7a',
      backgroundColor: 'rgba(255, 255, 255, 0.03)',
      borderRadius: '0 4px 4px 0',
    }}
  >
    <SessionDetail identity={identity} onCopy={onCopy} />
    <div style={{ color: '#666', fontSize: '10px', padding: '2px 8px 0' }}>
      click a line to copy · ⌘↑ or Esc closes
    </div>
  </div>
);

// --- HOST B: overlay --------------------------------------------------------

const SessionDetailOverlay: FC<{
  identity: SessionIdentity;
  onCopy: (label: string, value: string) => void;
  onClose: () => void;
}> = ({ identity, onCopy, onClose }) => {
  const rows = detailRows(identity);
  const [active, setActive] = useState(0);
  const step = (delta: number) =>
    setActive((i) => {
      // Skip rows with nothing to copy.
      for (let n = 1; n <= rows.length; n++) {
        const next = (i + delta * n + rows.length * n) % rows.length;
        if (rows[next].value) return next;
      }
      return i;
    });
  return (
    <div
      data-settings-panel
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.45)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
      }}
    >
      <div
        tabIndex={0}
        ref={(el) => el?.focus()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape' || (e.metaKey && (e.key === 'i' || e.key === 'I'))) {
            e.preventDefault();
            onClose();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            step(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            step(-1);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const row = rows[active];
            if (row?.value) onCopy(row.label, row.value);
          }
        }}
        style={{ ...PANEL_STYLE, marginTop: '90px', width: 'min(640px, calc(100vw - 40px))', padding: '8px' }}
      >
        <div style={{ fontSize: '11px', color: DIM, padding: '2px 8px 6px' }}>
          Session details — click a line to copy (↑↓ · Enter copies · Esc)
        </div>
        <SessionDetail
          identity={identity}
          onCopy={onCopy}
          activeIndex={active}
          onHoverIndex={setActive}
        />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// The right-click menu
// ---------------------------------------------------------------------------

type MenuItem =
  | { kind: 'action'; label: string; preview?: string; hint?: string; disabled?: boolean; run: () => void }
  | { kind: 'separator' };

const MENU_WIDTH = 360;

const SessionContextMenu: FC<{
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}> = ({ x, y, items, onClose }) => {
  const actionable = items
    .map((item, i) => (item.kind === 'action' && !item.disabled ? i : -1))
    .filter((i) => i >= 0);
  const [active, setActive] = useState(actionable[0] ?? -1);
  const move = (delta: number) => {
    if (actionable.length === 0) return;
    const at = actionable.indexOf(active);
    setActive(actionable[(at + delta + actionable.length) % actionable.length]);
  };
  // A menu left open while the window hides would still be there on return.
  useEffect(() => {
    window.addEventListener('blur', onClose);
    return () => window.removeEventListener('blur', onClose);
  }, [onClose]);
  const height = items.reduce((h, it) => h + (it.kind === 'separator' ? 9 : 26), 12);
  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_WIDTH - 8));
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 8));
  return (
    <div
      data-settings-panel
      // The backdrop: any click or right-click outside the menu closes it.
      onClick={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1100 }}
    >
      <div
        role="menu"
        tabIndex={0}
        ref={(el) => el?.focus()}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            move(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            move(-1);
          } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const item = items[active];
            if (item?.kind === 'action' && !item.disabled) item.run();
          }
        }}
        style={{ ...PANEL_STYLE, position: 'fixed', left, top, width: MENU_WIDTH, padding: '6px' }}
      >
        {items.map((item, i) =>
          item.kind === 'separator' ? (
            <div key={i} style={{ borderTop: '1px solid #3a3a3a', margin: '4px 2px' }} />
          ) : (
            <div
              key={i}
              role="menuitem"
              aria-disabled={item.disabled}
              onMouseEnter={() => { if (!item.disabled) setActive(i); }}
              onClick={() => { if (!item.disabled) item.run(); }}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: '10px',
                padding: '4px 8px',
                borderRadius: '4px',
                cursor: item.disabled ? 'default' : 'pointer',
                backgroundColor: i === active ? ACTIVE_BG : 'transparent',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{ color: item.disabled ? '#666' : TEXT, fontSize: '12px', flexShrink: 0 }}>
                {item.label}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  textAlign: 'right',
                  color: item.disabled ? '#555' : DIM,
                  fontSize: '10px',
                  fontFamily: item.hint ? undefined : MONO,
                }}
              >
                {item.hint ?? item.preview ?? ''}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// The hook switcher-ui.tsx uses
// ---------------------------------------------------------------------------

export const useSessionIdentityUi = (opts: {
  /** Short confirmation line (the app's banner). */
  notify: (message: string) => void;
  /** Give keyboard focus back to the search box. */
  restoreFocus: () => void;
}) => {
  const { notify, restoreFocus } = opts;
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: IdentityTarget;
    identity: SessionIdentity;
  } | null>(null);
  const [overlay, setOverlay] = useState<SessionIdentity | null>(null); // HOST B
  const [inline, setInline] = useState<{ rowKey: string; identity: SessionIdentity } | null>(null); // HOST C
  const inlineRef = useRef(inline);
  inlineRef.current = inline;

  const fetchIdentity = useCallback(
    async (target: IdentityTarget): Promise<SessionIdentity | null> => {
      try {
        const identity = await window.electronAPI.getSessionIdentity(
          target.sessionId,
          target.project,
          target.accountLabel,
          target.fallbackTitle,
        );
        if (!identity) notify('Could not read this session’s details');
        return identity;
      } catch {
        notify('Could not read this session’s details');
        return null;
      }
    },
    [notify],
  );

  const copy = useCallback(
    (label: string, value: string) => {
      if (!value) return;
      window.electronAPI
        .copyText(value)
        .then((ok) =>
          notify(ok ? `Copied ${label.toLowerCase()}: ${truncateMiddle(value, 90)}` : `Could not copy the ${label.toLowerCase()}`),
        )
        .catch(() => notify(`Could not copy the ${label.toLowerCase()}`));
    },
    [notify],
  );

  const closeMenu = useCallback(() => {
    setMenu(null);
    restoreFocus();
  }, [restoreFocus]);

  const closeOverlay = useCallback(() => { // HOST B
    setOverlay(null);
    restoreFocus();
  }, [restoreFocus]);

  const openOverlay = useCallback( // HOST B
    async (target: IdentityTarget) => {
      const identity = await fetchIdentity(target);
      if (identity) setOverlay(identity);
    },
    [fetchIdentity],
  );

  const openInline = useCallback( // HOST C
    async (target: IdentityTarget) => {
      const identity = await fetchIdentity(target);
      if (identity) setInline({ rowKey: target.rowKey, identity });
    },
    [fetchIdentity],
  );

  /** Row `onContextMenu`. */
  const openMenu = useCallback(
    async (e: { preventDefault: () => void; clientX: number; clientY: number }, target: IdentityTarget | null) => {
      e.preventDefault();
      if (!target) return;
      const { clientX: x, clientY: y } = e;
      const identity = await fetchIdentity(target);
      if (identity) setMenu({ x, y, target, identity });
    },
    [fetchIdentity],
  );

  /**
   * Search-box `onKeyDown`, called before the box's own handling. Returns true
   * when the key was one of ours. `target` is the keyboard-selected row, or
   * null when no row is explicitly selected.
   *   ⌘⇧C  copy the reference (title + full id)
   *   ⌘I   details overlay (HOST B)
   *   ⌘↓   details under the row (HOST C); ⌘↑ / Esc closes
   */
  const handleKey = useCallback(
    (
      e: {
        key: string;
        metaKey: boolean;
        shiftKey: boolean;
        ctrlKey: boolean;
        altKey: boolean;
        preventDefault: () => void;
      },
      target: IdentityTarget | null,
    ): boolean => {
      // HOST C: an open inline panel takes Esc and ⌘↑ before anything else.
      if (inlineRef.current) {
        const closing =
          (e.key === 'Escape' && !e.metaKey) ||
          (e.key === 'ArrowUp' && e.metaKey && !e.shiftKey && !e.ctrlKey && !e.altKey);
        if (closing) {
          e.preventDefault();
          setInline(null);
          return true;
        }
      }
      if (!e.metaKey || e.ctrlKey || e.altKey) return false;
      const key = e.key.toLowerCase();
      const ours =
        (e.shiftKey && key === 'c') ||
        (!e.shiftKey && key === 'i') ||
        (!e.shiftKey && e.key === 'ArrowDown');
      if (!ours) return false;
      e.preventDefault();
      if (!target) {
        notify('Select a session first (↑↓ or hover)');
        return true;
      }
      if (e.shiftKey && key === 'c') {
        fetchIdentity(target).then((identity) => {
          if (identity) copy('Reference', identity.reference);
        });
      } else if (key === 'i') {
        openOverlay(target); // HOST B
      } else if (inlineRef.current?.rowKey === target.rowKey) {
        setInline(null); // HOST C: ⌘↓ again on the open row closes it
      } else {
        openInline(target); // HOST C
      }
      return true;
    },
    [copy, fetchIdentity, notify, openInline, openOverlay],
  );

  /** HOST C: place right after a row; renders only under the expanded one. */
  const inlineFor = (target: IdentityTarget | null): ReactNode =>
    target && inline && inline.rowKey === target.rowKey ? (
      <SessionDetailInline identity={inline.identity} onCopy={copy} />
    ) : null;

  const menuItems = (): MenuItem[] => {
    if (!menu) return [];
    const { identity, target } = menu;
    const items: MenuItem[] = IDENTITY_FIELDS.map(({ key, label }) => {
      const value = identityFieldValue(identity, key);
      return {
        kind: 'action' as const,
        label: `Copy ${label.toLowerCase()}`,
        preview: value ? truncateMiddle(value, 42) : `(${EMPTY_NOTE[key] ?? 'none'})`,
        disabled: !value,
        run: () => {
          copy(label, value);
          closeMenu();
        },
      };
    });
    items.push(
      { kind: 'separator' },
      {
        kind: 'action',
        label: 'Show details', // HOST B
        hint: '⌘I',
        run: () => {
          setMenu(null);
          setOverlay(identity);
        },
      },
      {
        kind: 'action',
        label: 'Show details under the row', // HOST C
        hint: '⌘↓',
        run: () => {
          setInline({ rowKey: target.rowKey, identity });
          closeMenu();
        },
      },
      // ── Future session actions go below this line ──────────────────────
      // "Hide session" (docs/session-finding-plan.md §4.3) belongs here: add
      // a separator and an action item; the menu needs nothing else.
    );
    return items;
  };

  /** Render once, at the top level of the Sessions tab. */
  const layer: ReactNode = (
    <>
      {menu && (
        <SessionContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={closeMenu} />
      )}
      {overlay && ( // HOST B
        <SessionDetailOverlay identity={overlay} onCopy={copy} onClose={closeOverlay} />
      )}
    </>
  );

  return { openMenu, handleKey, inlineFor, layer };
};
