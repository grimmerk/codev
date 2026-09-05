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
 * The browse states are independent, which is what makes the matrix worth
 * testing rather than eyeballing:
 *
 * - `isSearching`  — search shows everything, ungrouped.
 * - `pinnedOnly`   — scope: non-pinned rows drop out, search included.
 * - `pinnedCollapsed` — grouping: collapsed UNGROUPS (pins fall back to their
 *   chronological slot with a ★) rather than hiding, so no combination of
 *   states can make a pinned session invisible.
 * - `liveOnly`     — scope: only sessions with a running process (issue #94),
 *   plus rows for running processes no session explains.
 * - `viewingList`  — scope: the members of one saved list (issue #145), in the
 *   order they were captured, resolved to live rows where possible.
 *
 * Scopes are exclusive and ranked: a saved list beats live, live beats pins.
 * The renderer turns the others off when it turns one on; ranking here is
 * what keeps a stale flag from ever blanking the list.
 *
 * Used by: `switcher-ui.tsx`.
 */

import type { SessionList, SessionListMember } from './session-lists';
import { isMinorSession } from './session-search';

/**
 * A session row as the Sessions tab renders it. Every field the renderer reads
 * is declared; the index signature is `unknown` so anything undeclared has to
 * be narrowed at the use site rather than silently typed as `any`.
 */
export interface ListViewSession {
  sessionId: string;
  project?: string;
  projectName?: string;
  firstUserMessage?: string;
  lastUserMessage?: string;
  lastTimestamp?: number;
  messageCount?: number;
  isActive?: boolean;
  activePid?: number;
  accountLabel?: string;
  accountIsAnchor?: boolean;
  /** `claude-vscode` for sessions launched from the VS Code extension. */
  entrypoint?: string;
  /** Set on rows lifted out of the pin store (zone rows and placeholders). */
  __pinnedRow?: boolean;
  __pinnedAt?: string;
  /** Set on rows lifted out of a saved list: what was captured about them. */
  __listMember?: SessionListMember;
  /** A running `claude` process that no session row explains (live scope only). */
  __liveOrphan?: boolean;
  /** Process facts carried by a synthetic live row (its own process, not a lookup by id). */
  __live?: LiveRowInfo;
  /** A second process on a session the list already shows (a resumed copy, a /branch pair). */
  __liveExtra?: boolean;
  [key: string]: unknown;
}

export interface PinRecord {
  pinnedAt?: string;
  cwd?: string;
  accountLabel?: string;
}

/** Process facts for one running session, keyed by sessionId in the renderer. */
export interface LiveRowInfo {
  pid: number;
  rssKb: number;
  tty: string | null;
  uptimeSec: number;
  registered: boolean;
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
  /** Live scope (issue #94). Optional so existing callers and tests need no change. */
  liveOnly?: boolean;
  /** sessionId -> process facts, from the live-sessions report. */
  liveBySession?: Record<string, LiveRowInfo>;
  /**
   * Rows synthesized for running processes that have no session row to carry
   * them: no id at all (`__liveOrphan`, not resumable) or an id the loaded
   * list does not know (resumable). The live scope must list every process
   * the chip counted, so these are appended after the real rows.
   */
  liveOrphans?: ListViewSession[];
  /** Saved-list scope (issue #145). */
  viewingList?: SessionList | null;
  /** List members resolved by id because they fall outside `allSessions`. */
  extraListSessions?: ListViewSession[];
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
  liveOnlyActive: boolean;
  listViewActive: boolean;
  groupPinned: boolean;
  /** Grouping is meaningless while searching or inside any scope — the header hides its arrow. */
  canGroupPins: boolean;
}

/**
 * Union two row lists by sessionId, first list wins.
 *
 * Used to widen the search candidate set. A pin outside the loaded window
 * exists only in the by-id fetch, and its title / branch / PR link live in
 * renderer-side enrichment that the main-side prompt search cannot see — so
 * without this, a query matching only those fields finds nothing even though
 * the very same pin is visible while browsing. Returns `primary` unchanged
 * when there is nothing to add, so a keystroke does not churn array identity.
 */
export const mergeSessionsById = (
  primary: ListViewSession[],
  extra: ListViewSession[],
): ListViewSession[] => {
  if (extra.length === 0) return primary;
  const seen = new Set(primary.map((s) => s.sessionId));
  const added = extra.filter((s) => !seen.has(s.sessionId));
  return added.length === 0 ? primary : [...primary, ...added];
};

/** Resolve one pin to a real row, or synthesize a placeholder from the pin record. */
const resolvePinnedRow = (
  id: string,
  info: PinRecord,
  pinnedById: Map<string, ListViewSession>,
  activePids: Record<string, number>,
  liveBySession: Record<string, LiveRowInfo>,
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
    ...activeFrom(s, activePids, liveBySession),
  };
};

/**
 * Is this session running, and under which pid? Two sources: the
 * registration-based detection (`activePids`) and the `ps` join
 * (`liveBySession`). Either marks it running; for the PID the join wins,
 * because it is the fresher of the two — the detection's pid map is cached
 * and can name a process that has since been replaced by another on the
 * same session, and switching to a dead pid fails. The join exists in the
 * first place because the detection cannot see a running session that has
 * no history row yet — a fresh `/branch` child before its first prompt — and
 * a row wrongly marked inactive RESUMES on click, spawning a second process
 * for the same session. Seen live.
 */
const activeFrom = (
  s: ListViewSession,
  activePids: Record<string, number>,
  liveBySession: Record<string, LiveRowInfo>,
): { isActive: boolean; activePid: number | undefined } => ({
  isActive:
    s.sessionId in activePids || s.sessionId in liveBySession || !!s.isActive,
  activePid:
    liveBySession[s.sessionId]?.pid ?? activePids[s.sessionId] ?? s.activePid,
});

/** Apply `activeFrom` to a timeline row, allocating only when it changes something. */
const withLiveState = (
  s: ListViewSession,
  activePids: Record<string, number>,
  liveBySession: Record<string, LiveRowInfo>,
): ListViewSession => {
  if (!(s.sessionId in liveBySession) && !(s.sessionId in activePids)) return s;
  const next = activeFrom(s, activePids, liveBySession);
  if (next.isActive === !!s.isActive && next.activePid === s.activePid)
    return s;
  return { ...s, ...next };
};

/**
 * Resolve one saved-list member to a real row, or synthesize one from what
 * was captured. Unlike a pin placeholder this one is rich: the list stored
 * the project, the last messages and the recap precisely so a member whose
 * transcript is gone still reads as the session it was.
 */
const resolveMemberRow = (
  member: SessionListMember,
  byId: Map<string, ListViewSession>,
  activePids: Record<string, number>,
  liveBySession: Record<string, LiveRowInfo>,
): ListViewSession => {
  const s = byId.get(member.sessionId) ?? {
    sessionId: member.sessionId,
    project: member.project,
    projectName: member.projectName,
    firstUserMessage: '',
    lastUserMessage: member.lastUserMessage || '',
    lastTimestamp: member.lastTimestamp,
    messageCount: undefined,
    isActive: false,
    accountLabel: member.accountLabel,
  };
  return {
    ...s,
    __listMember: member,
    ...activeFrom(s, activePids, liveBySession),
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
  liveOnly = false,
  liveBySession = {},
  liveOrphans = [],
  viewingList = null,
  extraListSessions = [],
}: BuildListViewArgs): ListView => {
  const hiddenSet = new Set(hidden);
  const hasPins = Object.keys(pins).length > 0;
  const listViewActive = !!viewingList;
  const liveOnlyActive = !listViewActive && liveOnly;
  const pinnedOnlyActive =
    !listViewActive && !liveOnlyActive && pinnedOnly && hasPins;
  const inScope = listViewActive || liveOnlyActive || pinnedOnlyActive;
  const groupPinned = !isSearching && !inScope && !pinnedCollapsed;
  const canGroupPins = !isSearching && !inScope;
  const isLive = (s: ListViewSession) =>
    !!s.isActive || s.sessionId in activePids || s.sessionId in liveBySession;

  // C1: fold minor (junk) sessions while browsing; searching shows everything.
  // Minors keep their recency order but render below the fold row at the end.
  // A user-hidden session is forced into the fold regardless of its stats.
  const majorSessions: ListViewSession[] = [];
  const minorSessions: ListViewSession[] = [];
  for (const raw of sessions) {
    // Timeline rows get the same running-state rule as pins and list
    // members, so a row that is live only per the ps join shows its dot and
    // switches (rather than resumes) on click.
    const s = withLiveState(raw, activePids, liveBySession);
    const isPinned = !!pins[s.sessionId];
    if (pinnedOnlyActive && !isPinned) continue;
    if (liveOnlyActive && !isLive(s)) continue;
    // Lifted into the zone — no second copy in the timeline (user verdict:
    // the duplicate was more noise than signal).
    if (groupPinned && isPinned) continue;
    const minor =
      !isSearching &&
      // A running session is never junk, whatever its stats say — and a
      // scope that asked for running sessions must show every one of them.
      !liveOnlyActive &&
      // A saved list renders its members, not `sessions`; a fold computed
      // from `sessions` would render under members it has nothing to do
      // with, and hide the "this list is empty" message.
      !listViewActive &&
      // An ungrouped pin must never fold into the minor group: pinning is an
      // explicit "keep this", and a pinned session can still be a short
      // untitled one that the junk predicate would happily fold away.
      !isPinned &&
      (hiddenSet.has(s.sessionId) ||
        (activeDetectionReady &&
          isMinorSession(
            s,
            hasCustomTitle(s.sessionId),
            hasPrLink(s.sessionId),
          )));
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
    .map(([id, info]) =>
      resolvePinnedRow(id, info, pinnedById, activePids, liveBySession),
    )
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

  const visiblePinnedRows =
    groupPinned && pinnedRows.length > 0 ? pinnedRows : [];

  // A pin older than the loaded window exists ONLY in pinnedRows. The zone
  // renders it while grouping is on; once ungrouped it would vanish from both
  // places, so append it to the timeline instead. The loaded list is the top-N
  // by recency, so anything outside it is older than every row already there
  // and belongs at the bottom.
  const timelineIds = new Set<string>();
  for (const s of majorSessions) timelineIds.add(s.sessionId);
  for (const s of minorSessions) timelineIds.add(s.sessionId);
  const ungroupedPins =
    !groupPinned && !inScope && !isSearching
      ? pinnedRows.filter((s) => !timelineIds.has(s.sessionId))
      : [];
  const timelineRows = [...majorSessions, ...ungroupedPins];

  let displayedSessions: ListViewSession[];
  if (listViewActive && viewingList) {
    // Captured order, not recency: a list is a snapshot, and reshuffling it
    // by activity would hide what it was a snapshot OF. Searching narrows to
    // the members the query matched (the renderer widens its candidates with
    // the by-id rows, same as pins) but keeps the captured order.
    const byId = new Map<string, ListViewSession>();
    for (const s of allSessions) byId.set(s.sessionId, s);
    for (const s of extraListSessions) {
      if (!byId.has(s.sessionId)) byId.set(s.sessionId, s);
    }
    const matched = isSearching
      ? new Set(sessions.map((s) => s.sessionId))
      : null;
    displayedSessions = viewingList.members
      .filter((m) => !matched || matched.has(m.sessionId))
      .map((m) => resolveMemberRow(m, byId, activePids, liveBySession));
  } else if (liveOnlyActive) {
    // Synthetic rows have nothing a query could match, so they step aside
    // while searching rather than sitting under every result as noise. A
    // synthetic row is dropped only when a real row already represents the
    // SAME process — same id and same pid (or no pid at all): the renderer
    // builds them from a snapshot that can lag the loaded list by one
    // render. A second process on the same id is a different row and stays.
    const shownPid = new Map<string, number | undefined>();
    for (const s of majorSessions) shownPid.set(s.sessionId, s.activePid);
    const covered = (s: ListViewSession) =>
      shownPid.has(s.sessionId) &&
      (s.__live?.pid === undefined ||
        s.__live.pid === shownPid.get(s.sessionId));
    displayedSessions = isSearching
      ? majorSessions
      : [...majorSessions, ...liveOrphans.filter((s) => !covered(s))];
  } else if (pinnedOnlyActive && !isSearching) {
    // Same reason: scope to the resolved pin set rather than filtering
    // `sessions`, which would silently drop the out-of-window ones.
    displayedSessions = pinnedRows;
  } else {
    displayedSessions = [
      ...visiblePinnedRows,
      ...(minorsExpanded ? [...timelineRows, ...minorSessions] : timelineRows),
    ];
  }

  return {
    pinnedRows,
    visiblePinnedRows,
    majorSessions,
    minorSessions,
    displayedSessions,
    minorFoldHeaderIndex: visiblePinnedRows.length + timelineRows.length,
    hiddenMinorCount,
    pinnedOnlyActive,
    liveOnlyActive,
    listViewActive,
    groupPinned,
    canGroupPins,
  };
};
