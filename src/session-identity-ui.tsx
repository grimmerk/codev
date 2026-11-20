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
  /** The rendered row, not the session: see `sessionRowKey`. */
  rowKey: string;
}

/**
 * What makes a RENDERED Sessions row unique. One session id can be on screen
 * more than once — a pinned copy and the row itself, or several running
 * processes with the same id (a resumed copy, a /branch parent and child) —
 * so the id alone is not a key. The list's React key and the inline details
 * panel both use this, so they cannot disagree about which row is which.
 */
export const sessionRowKey = (session: any): string =>
  `${session.__pinnedRow ? 'pin:' : ''}${session.__live ? `live:${session.__live.pid}:` : ''}${session.sessionId}`;

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
    rowKey: sessionRowKey(session),
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
const FOCUS_RING = 'inset 0 0 0 1px #007fd4';
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
        : key === 'title' && identity.titleKind === 'unknown'
          ? 'captured earlier — may be auto-generated'
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
  /** Highlighted row (the overlay drives this; inline leaves it unset). */
  activeIndex?: number;
  /** A row was hovered or took keyboard focus. */
  onActiveIndex?: (i: number) => void;
}> = ({ identity, onCopy, activeIndex, onActiveIndex }) => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // Where the pointer last was, to tell a real move from a scroll under it.
  const pointer = useRef({ x: -1, y: -1 });
  return (
    <div>
      {detailRows(identity).map((row, i) => {
        const empty = !row.value;
        const activate = () => {
          if (empty) return;
          onCopy(row.label, row.value);
          setCopiedKey(row.key);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopiedKey(null), 1200);
        };
        return (
          <div
            key={row.key}
            role="button"
            aria-disabled={empty}
            // A real focus target, so the button role is honest: Enter and
            // Space copy. A row with nothing to copy is skipped.
            tabIndex={empty ? -1 : 0}
            data-detail-row={i}
            // Focus must be visible. The overlay shows it as the active-row
            // highlight (onActiveIndex); the inline host has no highlight, so
            // there the row gets a ring — set on focus and cleared on blur,
            // as terminal-tab.tsx does. Only the keyboard can focus a row
            // (a click does not move focus), so this never shows on a click.
            onFocus={(e) => {
              if (onActiveIndex) onActiveIndex(i);
              else e.currentTarget.style.boxShadow = FOCUS_RING;
            }}
            onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                activate();
              }
            }}
            data-tip={empty ? undefined : `Click to copy the ${row.label.toLowerCase()}`}
            // A click copies without moving focus: inline, it stays in the
            // search box; in the overlay, on the row the keyboard is on.
            onMouseDown={(e) => e.preventDefault()}
            // Overlay only (it passes onActiveIndex): the pointer moves keyboard
            // focus, so the highlighted row IS the focused one and Enter
            // copies what is highlighted. Real movement only — a row that
            // scrolls under a resting pointer must not take focus back from
            // the arrow keys. Inline, hovering never touches focus.
            onMouseMove={(e) => {
              if (!onActiveIndex || empty) return;
              const { clientX: x, clientY: y } = e;
              const moved = pointer.current.x !== x || pointer.current.y !== y;
              pointer.current = { x, y };
              if (moved && document.activeElement !== e.currentTarget) {
                e.currentTarget.focus({ preventScroll: true });
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              activate();
            }}
            style={{
              display: 'flex',
              gap: '10px',
              padding: '3px 8px',
              borderRadius: '4px',
              cursor: empty ? 'default' : 'pointer',
              backgroundColor: i === activeIndex ? ACTIVE_BG : 'transparent',
              outline: 'none',
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
}> = ({ identity, onCopy }) => {
  // A row near the bottom of the list would open its panel below the fold.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    panelRef.current?.scrollIntoView({ block: 'nearest' });
  }, [identity.sessionId]);
  return (
  <div
    ref={panelRef}
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
      click a line to copy · ⌘↑ or Esc closes · ⌘I for keyboard access
    </div>
  </div>
  );
};

// --- HOST B: overlay --------------------------------------------------------

const SessionDetailOverlay: FC<{
  identity: SessionIdentity;
  onCopy: (label: string, value: string) => void;
  onClose: () => void;
}> = ({ identity, onCopy, onClose }) => {
  const rows = detailRows(identity);
  const [active, setActive] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Keyboard focus sits on a ROW (the rows are the buttons); the highlight
  // follows it through the rows' onFocus.
  const focusRow = (i: number) =>
    dialogRef.current
      ?.querySelector<HTMLElement>(`[data-detail-row="${i}"]`)
      ?.focus();
  /** The next row that has something to copy, wrapping around. */
  const step = (delta: number) => {
    for (let n = 1; n <= rows.length; n++) {
      const next = (active + delta * n + rows.length * n) % rows.length;
      if (rows[next].value) {
        focusRow(next);
        return;
      }
    }
  };
  // On open: the first row that can be copied, else the dialog itself.
  useEffect(() => {
    const first = rows.findIndex((r) => r.value);
    if (first >= 0) focusRow(first);
    else dialogRef.current?.focus();
    // Once per opened session — not on every highlight change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.sessionId]);
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
        role="dialog"
        aria-modal="true"
        aria-label="Session details"
        tabIndex={-1}
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Tab') {
            // Keep focus inside the dialog: Tab walks the rows like ↑↓.
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape' || (e.metaKey && (e.key === 'i' || e.key === 'I'))) {
            e.preventDefault();
            onClose();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            step(1);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            step(-1);
          }
          // Enter / Space are handled by the focused row itself.
        }}
        style={{
          ...PANEL_STYLE,
          marginTop: '90px',
          width: 'min(640px, calc(100vw - 40px))',
          padding: '8px',
          // Long paths wrap; in a short window the rows must scroll inside
          // the dialog instead of running off the bottom. Moving focus with
          // the keyboard scrolls the focused row into view.
          maxHeight: 'calc(100vh - 110px)',
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ fontSize: '11px', color: DIM, padding: '2px 8px 6px' }}>
          Session details — click a line to copy (↑↓ or Tab · Enter copies · Esc)
        </div>
        <SessionDetail
          identity={identity}
          onCopy={onCopy}
          activeIndex={active}
          onActiveIndex={setActive}
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
// Only one menu is ever open, so a fixed prefix is unique.
const menuItemId = (i: number): string => `codev-session-menu-item-${i}`;

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
        aria-label="Session actions"
        // Focus stays on the menu; this tells assistive tech which item the
        // arrow keys are on.
        aria-activedescendant={active >= 0 ? menuItemId(active) : undefined}
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
            <div key={i} role="separator" style={{ borderTop: '1px solid #3a3a3a', margin: '4px 2px' }} />
          ) : (
            <div
              key={i}
              id={menuItemId(i)}
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
  // The menu and the overlay take their own keys while they hold focus. They
  // can lose it without closing — the window is hidden and shown again, and
  // the app puts focus back in the search box — so the search box's handler
  // has to know they are open (see handleKey).
  const layerOpenRef = useRef({ menu: false, overlay: false });
  layerOpenRef.current = { menu: !!menu, overlay: !!overlay };
  // HOST C: is the expanded row actually on screen in THIS render? `inlineFor`
  // sets it while the rows are built. A panel whose row is gone — filtered
  // out by a search, folded, dropped by a refresh, another tab — must not
  // keep taking Esc and ⌘↑, so the keys check this and the effect below
  // drops the state. Derived from what was rendered, not a second copy of it.
  const inlineShownRef = useRef(false);
  inlineShownRef.current = false;
  useEffect(() => {
    if (inline && !inlineShownRef.current) setInline(null);
  });

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
      // A menu or overlay that is open but no longer focused: Esc reaching
      // the search box closes it (topmost first) instead of falling through
      // to the app's own Esc, which would hide the window with the layer
      // still open behind it.
      if (e.key === 'Escape' && !e.metaKey) {
        if (layerOpenRef.current.menu) {
          e.preventDefault();
          closeMenu();
          return true;
        }
        if (layerOpenRef.current.overlay) { // HOST B
          e.preventDefault();
          closeOverlay();
          return true;
        }
      }
      // HOST C: an open inline panel takes Esc and ⌘↑ before anything else.
      if (inlineRef.current && inlineShownRef.current) {
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
    [closeMenu, closeOverlay, copy, fetchIdentity, notify, openInline, openOverlay],
  );

  /** HOST C: place right after a row; renders only under the expanded one. */
  const inlineFor = (target: IdentityTarget | null): ReactNode => {
    if (!target || !inline || inline.rowKey !== target.rowKey) return null;
    inlineShownRef.current = true;
    return <SessionDetailInline identity={inline.identity} onCopy={copy} />;
  };

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
