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
