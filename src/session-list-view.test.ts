import { describe, expect, it } from 'vitest';

import {
  buildSessionListView,
  BuildListViewArgs,
  mergeSessionsById,
} from './session-list-view';

// Recency-sorted, like the real list. `old` sits outside the loaded window on
// purpose (see `outOfWindowPin`), and `junk` satisfies the minor predicate.
const recent = { sessionId: 'recent', lastTimestamp: 500, messageCount: 40 };
const middle = { sessionId: 'middle', lastTimestamp: 300, messageCount: 20 };
const junk = { sessionId: 'junk', lastTimestamp: 200, messageCount: 1 };
const outOfWindowPin = {
  sessionId: 'old',
  lastTimestamp: 10,
  messageCount: 90,
};

const at = (iso: string) => ({ pinnedAt: iso, cwd: '/tmp/proj' });

const build = (over: Partial<BuildListViewArgs> = {}) =>
  buildSessionListView({
    sessions: [recent, middle, junk],
    allSessions: [recent, middle, junk],
    extraPinnedSessions: [],
    pins: {},
    hidden: [],
    activePids: {},
    hasCustomTitle: () => false,
    hasPrLink: () => false,
    isSearching: false,
    pinnedOnly: false,
    pinnedCollapsed: false,
    minorsExpanded: false,
    activeDetectionReady: true,
    ...over,
  });

const ids = (rows: { sessionId: string }[]) => rows.map((r) => r.sessionId);

describe('buildSessionListView — grouping', () => {
  it('grouped: pins render in the zone and leave no duplicate in the timeline', () => {
    const v = build({ pins: { middle: at('2026-01-01T00:00:00Z') } });
    expect(ids(v.visiblePinnedRows)).toEqual(['middle']);
    expect(ids(v.majorSessions)).toEqual(['recent']); // junk folded
    expect(ids(v.displayedSessions)).toEqual(['middle', 'recent']);
    expect(v.groupPinned).toBe(true);
  });

  it('ungrouped: pins fall back into the timeline instead of disappearing', () => {
    const v = build({
      pins: { middle: at('2026-01-01T00:00:00Z') },
      pinnedCollapsed: true,
    });
    expect(v.visiblePinnedRows).toEqual([]);
    // Still exactly once, and back in its chronological slot.
    expect(ids(v.displayedSessions)).toEqual(['recent', 'middle']);
    expect(v.groupPinned).toBe(false);
  });

  it('orders the zone by recency, newest pin first among unresolved rows', () => {
    const v = build({
      pins: {
        middle: at('2026-01-01T00:00:00Z'), // pinned first, but older activity
        recent: at('2026-06-01T00:00:00Z'),
        ghostA: at('2026-02-01T00:00:00Z'), // unresolvable -> lastTimestamp 0
        ghostB: at('2026-03-01T00:00:00Z'),
      },
    });
    expect(ids(v.pinnedRows)).toEqual(['recent', 'middle', 'ghostB', 'ghostA']);
    // An unresolved pin still renders as a row, with no misleading msg count.
    expect(v.pinnedRows[3].messageCount).toBeUndefined();
  });
});

describe('buildSessionListView — pinned-only scope', () => {
  it('drops every non-pinned row while browsing', () => {
    const v = build({
      pins: { middle: at('2026-01-01T00:00:00Z') },
      pinnedOnly: true,
    });
    expect(ids(v.displayedSessions)).toEqual(['middle']);
    expect(v.pinnedOnlyActive).toBe(true);
    expect(v.canGroupPins).toBe(false); // grouping is meaningless in this scope
  });

  it('scopes search results to pins too', () => {
    const v = build({
      sessions: [recent, middle], // as if both matched the query
      pins: { middle: at('2026-01-01T00:00:00Z') },
      pinnedOnly: true,
      isSearching: true,
    });
    expect(ids(v.displayedSessions)).toEqual(['middle']);
  });

  it('is inert with no pins, so the scope can never blank the list', () => {
    const v = build({ pinnedOnly: true });
    expect(v.pinnedOnlyActive).toBe(false);
    expect(ids(v.displayedSessions)).toEqual(['recent', 'middle']);
  });
});

describe('buildSessionListView — invariants across the whole matrix', () => {
  const pins = { old: at('2026-01-01T00:00:00Z') };
  const args = {
    pins,
    // `old` is outside the loaded list; only the by-id fetch resolves it.
    extraPinnedSessions: [outOfWindowPin],
  };

  it('a pin outside the loaded window appears exactly once in every mode', () => {
    const modes: Partial<BuildListViewArgs>[] = [
      {},
      { pinnedCollapsed: true },
      { pinnedOnly: true },
      { minorsExpanded: true },
      { pinnedCollapsed: true, minorsExpanded: true },
    ];
    for (const mode of modes) {
      const shown = ids(build({ ...args, ...mode }).displayedSessions);
      expect(shown.filter((id) => id === 'old')).toEqual(['old']);
    }
  });

  it('never folds a pinned session away as a minor session', () => {
    // `junk` would fold on its own stats (1 msg, untitled, no PR, closed).
    const v = build({
      pins: { junk: at('2026-01-01T00:00:00Z') },
      pinnedCollapsed: true,
    });
    expect(ids(v.minorSessions)).toEqual([]);
    expect(ids(v.displayedSessions)).toContain('junk');
  });

  it('places the minor-fold header directly after the last timeline row', () => {
    const v = build({ ...args, pinnedCollapsed: true, minorsExpanded: true });
    // recent, middle, then the out-of-window pin, then the fold header.
    expect(ids(v.displayedSessions)).toEqual([
      'recent',
      'middle',
      'old',
      'junk',
    ]);
    expect(v.minorFoldHeaderIndex).toBe(3);
    expect(v.displayedSessions[v.minorFoldHeaderIndex].sessionId).toEqual(
      v.minorSessions[0].sessionId,
    );
  });

  it('counts explicitly hidden rows separately from junk-predicate ones', () => {
    const v = build({ hidden: ['middle'] });
    expect(ids(v.minorSessions)).toEqual(['middle', 'junk']);
    expect(v.hiddenMinorCount).toBe(1);
  });

  it('shows an out-of-window pin that only the widened search set could match', () => {
    // The renderer widens its search candidates with mergeSessionsById, so a
    // hit on such a pin's title/branch arrives here inside `sessions`.
    const v = build({
      ...args,
      sessions: [outOfWindowPin],
      isSearching: true,
      pinnedOnly: true,
    });
    expect(ids(v.displayedSessions)).toEqual(['old']);
  });
});

describe('buildSessionListView — live scope', () => {
  const active = {
    sessionId: 'active',
    lastTimestamp: 400,
    messageCount: 3,
    isActive: true,
  };
  const orphan = {
    sessionId: 'pid:4242',
    projectName: 'orphan',
    lastTimestamp: 0,
    __liveOrphan: true,
  };

  it('keeps only running sessions, appends orphans, and never folds a running one', () => {
    const v = build({
      // `junk` has 1 msg and no title — it would fold while browsing.
      sessions: [recent, active, junk],
      activePids: { junk: 77 },
      liveOnly: true,
      liveOrphans: [orphan],
    });
    expect(v.liveOnlyActive).toBe(true);
    expect(ids(v.displayedSessions)).toEqual(['active', 'junk', 'pid:4242']);
    expect(v.minorSessions).toEqual([]);
    expect(v.canGroupPins).toBe(false);
  });

  it('never shows a synthetic row for a session a real row already covers', () => {
    // The renderer synthesizes a row for a live id the list did not know;
    // one render later the by-id fetch may have produced the real row.
    const synthetic = { sessionId: 'active', lastTimestamp: 0, __live: {} };
    const v = build({
      sessions: [active, recent],
      liveOnly: true,
      liveOrphans: [synthetic, orphan],
    });
    expect(ids(v.displayedSessions)).toEqual(['active', 'pid:4242']);
    expect(v.displayedSessions[0].messageCount).toBe(3); // the real row won
  });

  it('recognises liveness from the live report, not only from the active map', () => {
    const v = build({
      sessions: [recent, middle],
      liveOnly: true,
      liveBySession: {
        middle: {
          pid: 1,
          rssKb: 1,
          tty: 'ttys001',
          uptimeSec: 1,
          registered: false,
        },
      },
    });
    expect(ids(v.displayedSessions)).toEqual(['middle']);
  });

  it('drops orphans while searching and outranks the pinned scope', () => {
    const v = build({
      sessions: [active, middle],
      pins: { middle: at('2026-01-01T00:00:00Z') },
      pinnedOnly: true,
      liveOnly: true,
      liveOrphans: [orphan],
      isSearching: true,
    });
    expect(v.pinnedOnlyActive).toBe(false);
    expect(ids(v.displayedSessions)).toEqual(['active']);
  });
});

describe('buildSessionListView — saved-list scope', () => {
  const memberOf = (sessionId: string, over: Record<string, unknown> = {}) => ({
    sessionId,
    project: '/p/' + sessionId,
    projectName: sessionId + '-proj',
    pinned: false,
    lastTimestamp: 1,
    ...over,
  });
  const list = {
    id: 'L1',
    name: 'tuesday',
    createdAt: '2026-09-05T00:00:00Z',
    // Captured order is deliberately NOT recency order.
    members: [
      memberOf('middle'),
      memberOf('gone', { lastUserMessage: 'last words' }),
      memberOf('old'),
    ],
  };

  it('renders members in captured order, resolving rows from the list, the by-id fetch, or the capture itself', () => {
    const v = build({
      viewingList: list,
      extraListSessions: [outOfWindowPin],
    });
    expect(v.listViewActive).toBe(true);
    expect(ids(v.displayedSessions)).toEqual(['middle', 'gone', 'old']);
    const [m, g, o] = v.displayedSessions;
    expect(m.messageCount).toBe(20); // the loaded row
    expect(o.messageCount).toBe(90); // the by-id row
    // The placeholder carries what was captured, with no fake message count.
    expect(g.messageCount).toBeUndefined();
    expect(g.projectName).toBe('gone-proj');
    expect(g.lastUserMessage).toBe('last words');
    expect(g.__listMember?.sessionId).toBe('gone');
  });

  it('narrows to the matched members while searching but keeps captured order', () => {
    const v = build({
      viewingList: list,
      sessions: [outOfWindowPin, middle], // as if the query matched these two
      isSearching: true,
    });
    expect(ids(v.displayedSessions)).toEqual(['middle', 'old']);
  });

  it('outranks both the live and the pinned scope', () => {
    const v = build({
      viewingList: list,
      liveOnly: true,
      pinnedOnly: true,
      pins: { recent: at('2026-01-01T00:00:00Z') },
    });
    expect(v.liveOnlyActive).toBe(false);
    expect(v.pinnedOnlyActive).toBe(false);
    expect(ids(v.displayedSessions)).toEqual(['middle', 'gone', 'old']);
  });

  it('marks a member as active from the active map even for a placeholder', () => {
    const v = build({ viewingList: list, activePids: { gone: 99 } });
    const g = v.displayedSessions.find((s) => s.sessionId === 'gone');
    expect(g?.isActive).toBe(true);
    expect(g?.activePid).toBe(99);
  });
});

describe('mergeSessionsById', () => {
  it('appends only rows the primary list does not already have', () => {
    const merged = mergeSessionsById(
      [recent, middle],
      [middle, outOfWindowPin],
    );
    expect(ids(merged)).toEqual(['recent', 'middle', 'old']);
  });

  it('returns the primary list unchanged when there is nothing to add', () => {
    const primary = [recent, middle];
    // Identity, not just equality: a keystroke must not churn array identity.
    expect(mergeSessionsById(primary, [])).toBe(primary);
    expect(mergeSessionsById(primary, [recent])).toBe(primary);
  });
});
