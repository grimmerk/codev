/**
 * Pure composition of the Sessions list (no fs, no electron, no React) so the
 * browse-state matrix is unit-testable.
 *
 * Everything the Sessions tab renders is one function of state: which rows
 * appear, in which group, in which order. That decision used to live inline in
 * `switcher-ui.tsx`, where the only way to check it was to run the app — and
 * it is exactly where the bugs have been (PR #136 needed five rounds of live
 * testing, all of them list/index interactions).
 *
 * The three browse states are independent, which is what makes the matrix
 * worth testing rather than eyeballing:
 *
 * - `isSearching`  — search shows everything, ungrouped.
 * - `pinnedOnly`   — scope: non-pinned rows drop out, search included.
 * - `pinnedCollapsed` — grouping: collapsed UNGROUPS (pins fall back to their
 *   chronological slot with a ★) rather than hiding, so no combination of
 *   states can make a pinned session invisible.
 *
 * Used by: `switcher-ui.tsx`.
 */

import { isMinorSession } from './session-search';

/** A session row. Deliberately loose — the renderer's rows carry enrichment. */
export interface ListViewSession {
  sessionId: string;
  project?: string;
  projectName?: string;
  lastTimestamp?: number;
  messageCount?: number;
  isActive?: boolean;
  activePid?: number;
  accountLabel?: string;
  // Rows also carry renderer-side enrichment this module never reads; `any`
  // keeps the consuming JSX compiling exactly as it did when rows were `any[]`.
  [key: string]: any;
}

export interface PinRecord {
  pinnedAt?: string;
  cwd?: string;
  accountLabel?: string;
}

export interface BuildListViewArgs {
  /** The list to render: the full timeline while browsing, results while searching. Recency-sorted. */
  sessions: ListViewSession[];
  /** Every loaded session — the first source used to resolve a pin to a real row. */
  allSessions: ListViewSession[];
  /** Pins resolved by id from the main-side cache because they fall outside `allSessions`. */
  extraPinnedSessions: ListViewSession[];
  pins: Record<string, PinRecord>;
  hidden: string[];
  /** sessionId -> pid for sessions detected as running. */
  activePids: Record<string, number>;
  /** Renderer-side enrichment the junk predicate needs. */
  hasCustomTitle: (sessionId: string) => boolean;
  hasPrLink: (sessionId: string) => boolean;
  isSearching: boolean;
  pinnedOnly: boolean;
  pinnedCollapsed: boolean;
  minorsExpanded: boolean;
  /** Folding waits for the first active-session detection (never fold a just-started session). */
  activeDetectionReady: boolean;
}

export interface ListView {
  /** Every pin as a row, recency-ordered — the zone's content, and the pinned-only list. */
  pinnedRows: ListViewSession[];
  /** The subset actually rendered as a zone (empty unless grouping is on). */
  visiblePinnedRows: ListViewSession[];
  majorSessions: ListViewSession[];
  minorSessions: ListViewSession[];
  /** Flattened render order; row indexes elsewhere in the UI are indexes into this. */
  displayedSessions: ListViewSession[];
  /** Index the expanded minor-group header sits above. */
  minorFoldHeaderIndex: number;
  /** How many folded rows got there by an explicit hide rather than the junk predicate. */
  hiddenMinorCount: number;
  pinnedOnlyActive: boolean;
  groupPinned: boolean;
  /** Grouping is meaningless while searching or scoped to pins — the header hides its arrow. */
  canGroupPins: boolean;
}

/** Resolve one pin to a real row, or synthesize a placeholder from the pin record. */
const resolvePinnedRow = (
  id: string,
  info: PinRecord,
  pinnedById: Map<string, ListViewSession>,
  activePids: Record<string, number>,
): ListViewSession => {
  // A pin can be momentarily unresolvable (VS Code sessions are absent from
  // history.jsonl until the closed-scan merges them in) or permanently so
  // (transcript cleaned up). Without the placeholder the zone count flaps on
  // every tab switch.
  const s = pinnedById.get(id) ?? {
    sessionId: id,
    project: info.cwd || '',
    projectName:
      (info.cwd || '').split('/').filter(Boolean).pop() || id.slice(0, 8),
    firstUserMessage: '',
    lastUserMessage: '',
    lastTimestamp: 0,
    // undefined, not 0: the row renders '… msgs' instead of a misleading
    // '0 msgs' while the session is unresolved (or permanently gone).
    messageCount: undefined,
    isActive: false,
    accountLabel: info.accountLabel,
  };
  return {
    ...s,
    __pinnedRow: true,
    __pinnedAt: info.pinnedAt || '',
    isActive: s.sessionId in activePids || s.isActive,
    activePid: activePids[s.sessionId] ?? s.activePid,
  };
};

export const buildSessionListView = ({
  sessions,
  allSessions,
  extraPinnedSessions,
  pins,
  hidden,
  activePids,
  hasCustomTitle,
  hasPrLink,
  isSearching,
  pinnedOnly,
  pinnedCollapsed,
  minorsExpanded,
  activeDetectionReady,
}: BuildListViewArgs): ListView => {
  const hiddenSet = new Set(hidden);
  const hasPins = Object.keys(pins).length > 0;
  const pinnedOnlyActive = pinnedOnly && hasPins;
  const groupPinned = !isSearching && !pinnedOnlyActive && !pinnedCollapsed;
  const canGroupPins = !isSearching && !pinnedOnlyActive;

  // C1: fold minor (junk) sessions while browsing; searching shows everything.
  // Minors keep their recency order but render below the fold row at the end.
  // A user-hidden session is forced into the fold regardless of its stats.
  const majorSessions: ListViewSession[] = [];
  const minorSessions: ListViewSession[] = [];
  for (const s of sessions) {
    const isPinned = !!pins[s.sessionId];
    if (pinnedOnlyActive && !isPinned) continue;
    // Lifted into the zone — no second copy in the timeline (user verdict:
    // the duplicate was more noise than signal).
    if (groupPinned && isPinned) continue;
    const minor =
      !isSearching &&
      // An ungrouped pin must never fold into the minor group: pinning is an
      // explicit "keep this", and a pinned session can still be a short
      // untitled one that the junk predicate would happily fold away.
      !isPinned &&
      (hiddenSet.has(s.sessionId) ||
        (activeDetectionReady &&
          isMinorSession(s, hasCustomTitle(s.sessionId), hasPrLink(s.sessionId))));
    (minor ? minorSessions : majorSessions).push(s);
  }
  // Manually hidden sessions may be titled/long — keep the fold label honest.
  const hiddenMinorCount = minorSessions.filter((s) =>
    hiddenSet.has(s.sessionId),
  ).length;

  // Pinned rows come from the loaded list when available, else from the by-id
  // fetch, else a placeholder.
  const pinnedById = new Map<string, ListViewSession>();
  for (const s of allSessions) {
    if (pins[s.sessionId]) pinnedById.set(s.sessionId, s);
  }
  for (const s of extraPinnedSessions) {
    if (pins[s.sessionId] && !pinnedById.has(s.sessionId)) {
      pinnedById.set(s.sessionId, s);
    }
  }
  const pinnedRows = Object.entries(pins)
    .map(([id, info]) => resolvePinnedRow(id, info, pinnedById, activePids))
    // Recency first, like every other list in the app. The previous pinnedAt
    // ASC order (chosen so a new pin appended at the bottom instead of
    // reshuffling rows under the cursor) buried the session touched five
    // minutes ago beneath months-old pins; the hover-suppression added in
    // PR #136 already absorbs the layout movement that ordering was avoiding.
    // Unresolved placeholders carry lastTimestamp 0 and sink to the bottom,
    // where pinnedAt DESC puts the newest pin first among them.
    .sort(
      (a, b) =>
        (b.lastTimestamp || 0) - (a.lastTimestamp || 0) ||
        String(b.__pinnedAt || '').localeCompare(String(a.__pinnedAt || '')),
    );

  const visiblePinnedRows = groupPinned && pinnedRows.length > 0 ? pinnedRows : [];

  // A pin older than the loaded window exists ONLY in pinnedRows. The zone
  // renders it while grouping is on; once ungrouped it would vanish from both
  // places, so append it to the timeline instead. The loaded list is the top-N
  // by recency, so anything outside it is older than every row already there
  // and belongs at the bottom.
  const timelineIds = new Set<string>();
  for (const s of majorSessions) timelineIds.add(s.sessionId);
  for (const s of minorSessions) timelineIds.add(s.sessionId);
  const ungroupedPins =
    !groupPinned && !pinnedOnlyActive && !isSearching
      ? pinnedRows.filter((s) => !timelineIds.has(s.sessionId))
      : [];
  const timelineRows = [...majorSessions, ...ungroupedPins];

  const displayedSessions =
    pinnedOnlyActive && !isSearching
      ? // Same reason: scope to the resolved pin set rather than filtering
        // `sessions`, which would silently drop the out-of-window ones.
        pinnedRows
      : [
          ...visiblePinnedRows,
          ...(minorsExpanded
            ? [...timelineRows, ...minorSessions]
            : timelineRows),
        ];

  return {
    pinnedRows,
    visiblePinnedRows,
    majorSessions,
    minorSessions,
    displayedSessions,
    minorFoldHeaderIndex: visiblePinnedRows.length + timelineRows.length,
    hiddenMinorCount,
    pinnedOnlyActive,
    groupPinned,
    canGroupPins,
  };
};
