#!/usr/bin/env node
/**
 * Summarize CodeV's switch timing log (src/switch-timing.ts writes it).
 *
 *   node scripts/switch-timing-summary.js [--redact] [--all] [--sort=n|p90] [file ...]
 *
 * With no file it reads ~/.config/codev/switch-timing.jsonl.1 (the rotated
 * file, if any) and then ~/.config/codev/switch-timing.jsonl.
 *
 * Prints p50 / p90 per step and for the total, for all switches and grouped
 * by kind, terminal, branch, account and (for switches to a running
 * session) how the terminal was decided, with one line of process-listing
 * counters from the newest record that has them; a per-session table (the 20 with
 * the most switches; `--all` for every one, `--sort=p90` for the slowest
 * first); then the total against machine load. Plain Node, no dependencies.
 * A line that is not a record is counted and skipped; a missing or empty
 * file is reported, not an error. Version 1 lines, which did not name their
 * session, count everywhere except the per-session table. A switch that
 * did not complete — its command timed out, was killed by its timeout or
 * failed — and one handed to an app the log does not follow are counted,
 * and left out of the percentiles of the steps that end at the exit.
 *
 * The log names sessions: id, title, account label and project path. A
 * title is the user's `/rename` name or, without one, the summary of the
 * conversation that Claude Code generated. That is the owner's own data on
 * the owner's machine — but the output of this script gets pasted into
 * issues. `--redact` replaces every one of those with a placeholder
 * (session-1, account-1, ~/project-1) that is stable for a given log, so
 * two runs over the same file can be compared.
 *
 * Everything printed that came from the log or the command line passes
 * through `safeText` first: a title is free text, and a terminal obeys
 * escape sequences.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Steps in path order; `total` is what the user waited. */
const STEPS = ['clickToIpc', 'settings', 'detect', 'build', 'spawn', 'run', 'main', 'total'];

/** Steps that end at the command's exit: they mean something only for a switch that completed. */
const NEEDS_EXIT = new Set(['run', 'main', 'total']);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * A record with no end-to-end time: flagged `untimed` by the writer (no
 * command was started and awaited — mostly the paths handed to VS Code,
 * Claude Desktop or the embedded terminal), or, on a line written before
 * the flag existed, recognisable by the tool of those paths.
 */
const isUntimed = (r) => r.untimed === true || r.tool === 'open' || r.tool === 'pty';

/**
 * Did the switch complete, with its command seen to exit normally? Not when
 * it timed out (no exit was seen), was killed by its timeout (the wait is
 * real, the switch did not happen), failed, or is untimed.
 */
const completed = (r) =>
  r.timedOut !== true && r.killed !== true && r.ok !== false && !isUntimed(r);

/**
 * One step of one record, or null when it has no measured value. Only a
 * completed switch has one for the steps that end at the exit — whatever
 * the line says: a deadline or a kill is not the duration of a switch.
 */
const stepValue = (r, step) => {
  if (NEEDS_EXIT.has(step) && !completed(r)) return null;
  const v = r.ms ? r.ms[step] : null;
  return isNum(v) ? v : null;
};

/**
 * The p-th percentile (0–100) by linear interpolation between the two
 * nearest ranks — the same definition as numpy's default. Null for no data.
 */
const percentile = (values, p) => {
  const xs = values.filter(isNum).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
};

/** Pearson's r over the pairs where both values are numbers; null under 3 pairs or no variance. */
const pearson = (pairs) => {
  const ps = pairs.filter(([x, y]) => isNum(x) && isNum(y));
  const n = ps.length;
  if (n < 3) return null;
  const mx = ps.reduce((s, [x]) => s + x, 0) / n;
  const my = ps.reduce((s, [, y]) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of ps) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
};

/** Fields read as text: grouped on, compared, or printed. */
const TEXT_FIELDS = [
  'ts',
  'via',
  'kind',
  'terminal',
  'configured',
  'tool',
  'branch',
  'order',
  'sessionId',
  'sid',
  'title',
  'account',
  'project',
  'tty',
  'ttySrc',
  'detectSrc',
];

/** Status flags: compared with `=== true` / `=== false`, so they must be booleans. */
const FLAG_FIELDS = ['ok', 'timedOut', 'killed', 'untimed'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * `listings` (since 1.0.100): absent or null on a line that did not record
 * it, else `{ n, failed, last }` where `last` is null or
 * `{ reason, ms, path }`. It is printed, so it is held to its shape like
 * the text fields.
 */
const isListings = (v) =>
  v === undefined ||
  v === null ||
  (isPlainObject(v) &&
    isNum(v.n) &&
    isNum(v.failed) &&
    (v.last === undefined ||
      v.last === null ||
      (isPlainObject(v.last) &&
        typeof v.last.reason === 'string' &&
        isNum(v.last.ms) &&
        typeof v.last.path === 'string')));

/**
 * A line this script can summarize: an object whose `ms` is an object,
 * whose text fields are each a string, null or absent, and whose status
 * flags are each a boolean, null or absent. One rule for all of them: a
 * field of the wrong type makes the whole line malformed, rather than each
 * use having to defend itself (`String()` of an object with a broken
 * `toString` throws; `killed: "true"` would read as "not killed"). Numbers
 * need no such rule: every numeric read goes through `isNum`.
 */
const isRecord = (r) =>
  isPlainObject(r) &&
  isPlainObject(r.ms) &&
  TEXT_FIELDS.every((k) => r[k] === undefined || r[k] === null || typeof r[k] === 'string') &&
  FLAG_FIELDS.every((k) => r[k] === undefined || r[k] === null || typeof r[k] === 'boolean') &&
  isListings(r.listings);

/** Records from JSONL text. A line that is not a record (see `isRecord`) is skipped and counted. */
const parseLines = (text) => {
  const records = [];
  let malformed = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (isRecord(r)) records.push(r);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
};

/** `n` is how many records had the step: it can be fewer than the group. */
const stat = (records, step) => {
  const xs = records.map((r) => stepValue(r, step)).filter(isNum);
  return { n: xs.length, p50: percentile(xs, 50), p90: percentile(xs, 90) };
};

const stepStats = (records) => {
  const out = {};
  for (const step of STEPS) out[step] = stat(records, step);
  return out;
};

const groupBy = (records, keyOf) => {
  const groups = new Map();
  for (const r of records) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, rs]) => ({ key, n: rs.length, steps: stepStats(rs) }));
};

const UNKNOWN = '(unknown)';
const NO_ACCOUNT = '(none)';

/** Lines written before 1.0.100 have no `detectSrc`: they always walked the process tree. */
const NO_DETECT_SRC = '(not recorded)';

/**
 * The process-listing counters of the newest record that has them (by
 * `ts`; a later line wins a tie). They count since the app started, so the
 * newest record holds the latest state of the run that wrote it. Null when
 * no record has the field.
 */
const newestListings = (records) => {
  let best = null;
  for (const r of records) {
    if (!isPlainObject(r.listings)) continue;
    if (!best || String(r.ts ?? '') >= String(best.ts ?? '')) best = r;
  }
  return best ? best.listings : null;
};

/** A record that names its session (version 2 on). */
const namesSession = (r) => typeof r.sessionId === 'string' && r.sessionId !== '';

/**
 * The account a record carries. Every account has a label, the anchor
 * included, so a v2 record without one is a row that had no account (or
 * named one that no longer exists) — not the anchor. A v1 record never said.
 */
const accountOf = (r) =>
  typeof r.account === 'string' && r.account ? r.account : namesSession(r) ? NO_ACCOUNT : UNKNOWN;

/** `tty×5 cwd×2`: how often each branch found the tab, most frequent first. */
const branchMix = (records) => {
  const counts = new Map();
  for (const r of records) {
    const b = typeof r.branch === 'string' && r.branch ? r.branch : 'unknown';
    counts.set(b, (counts.get(b) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([b, n]) => `${b}×${n}`)
    .join(' ');
};

const distinct = (values) => [...new Set(values.filter((v) => typeof v === 'string' && v))];

/**
 * One row per session, from the records that name one. Title, account and
 * project are the latest seen (a session can be renamed); terminals are
 * every one it was switched to.
 */
const sessionRows = (records, sort = 'n') => {
  const groups = new Map();
  for (const r of records) {
    if (!namesSession(r)) continue;
    if (!groups.has(r.sessionId)) groups.set(r.sessionId, []);
    groups.get(r.sessionId).push(r);
  }
  const rows = [...groups.entries()].map(([sessionId, rs]) => {
    const last = (key) => {
      for (let i = rs.length - 1; i >= 0; i--) {
        if (typeof rs[i][key] === 'string' && rs[i][key]) return rs[i][key];
      }
      return null;
    };
    const total = stat(rs, 'total');
    const run = stat(rs, 'run');
    return {
      sessionId,
      title: last('title'),
      account: accountOf(rs[rs.length - 1]),
      project: last('project'),
      terminals: distinct(rs.map((r) => r.terminal)),
      ttys: distinct(rs.map((r) => r.tty)),
      n: rs.length,
      totalN: total.n,
      totalP50: total.p50,
      totalP90: total.p90,
      runN: run.n,
      runP50: run.p50,
      runP90: run.p90,
      branches: branchMix(rs),
    };
  });
  const byN = (a, b) => b.n - a.n || (b.totalP90 ?? -1) - (a.totalP90 ?? -1);
  const byP90 = (a, b) => (b.totalP90 ?? -1) - (a.totalP90 ?? -1) || b.n - a.n;
  return rows.sort(sort === 'p90' ? byP90 : byN);
};

/**
 * The same records with every session id, title, account label and project
 * path replaced by a placeholder. Numbered in order of first appearance, so
 * the same log always gives the same names, and one session, account or
 * path keeps one name across all its lines. A missing value stays missing:
 * "this session had no title" is a finding, not content.
 */
const redactRecords = (records) => {
  const namer = (prefix) => {
    const seen = new Map();
    return (v) => {
      if (typeof v !== 'string' || v === '') return v ?? null;
      if (!seen.has(v)) seen.set(v, `${prefix}${seen.size + 1}`);
      return seen.get(v);
    };
  };
  const session = namer('session-');
  const account = namer('account-');
  const project = namer('~/project-');
  return records.map((r) => {
    const out = { ...r };
    if ('sessionId' in r) out.sessionId = session(r.sessionId);
    if ('sid' in r) out.sid = typeof r.sid === 'string' && r.sid ? 'redacted' : r.sid;
    if ('title' in r) {
      out.title =
        typeof r.title === 'string' && r.title
          ? `title of ${namesSession(r) ? out.sessionId : 'a session'}`
          : null;
    }
    if ('account' in r) out.account = account(r.account);
    if ('project' in r) out.project = project(r.project);
    return out;
  });
};

/** 1-minute load per core: comparable across machines. */
const loadPerCore = (r) =>
  Array.isArray(r.load) && isNum(r.load[0]) && isNum(r.ncpu) && r.ncpu > 0 ? r.load[0] / r.ncpu : null;

const LOAD_BUCKETS = [
  { label: 'load/core < 0.5', lo: 0, hi: 0.5 },
  { label: 'load/core 0.5–1', lo: 0.5, hi: 1 },
  { label: 'load/core 1–2', lo: 1, hi: 2 },
  { label: 'load/core ≥ 2', lo: 2, hi: Infinity },
];

const summarize = (records, opts = {}) => {
  const total = (r) => stepValue(r, 'total');
  const run = (r) => stepValue(r, 'run');
  const load1 = (r) => (Array.isArray(r.load) ? r.load[0] : null);
  // Of each switch's total, the part spent inside the external command.
  const runShare = records
    .filter((r) => isNum(run(r)) && isNum(total(r)) && total(r) > 0)
    .map((r) => run(r) / total(r));
  return {
    count: records.length,
    // Disjoint, in this order of precedence, so the four counts and the
    // completed switches add up to `count`: the writer marks a killed
    // switch `ok: false` too, and a launch that failed before its command
    // started is also untimed.
    timedOut: records.filter((r) => r.timedOut === true).length,
    killed: records.filter((r) => r.timedOut !== true && r.killed === true).length,
    failed: records.filter((r) => r.timedOut !== true && r.killed !== true && r.ok === false).length,
    untimed: records.filter(
      (r) => r.timedOut !== true && r.killed !== true && r.ok !== false && isUntimed(r),
    ).length,
    slow: records.filter((r) => isNum(total(r)) && total(r) > 1000).length,
    all: stepStats(records),
    byKind: groupBy(records, (r) => String(r.kind ?? 'unknown')),
    byTerminal: groupBy(records, (r) => String(r.terminal ?? 'unknown')),
    byBranch: groupBy(records, (r) => String(r.branch ?? 'unknown')),
    byAccount: groupBy(records, accountOf),
    // Running sessions only: a resume detects nothing.
    byDetectSrc: groupBy(
      records.filter((r) => r.kind === 'switch'),
      (r) => (typeof r.detectSrc === 'string' && r.detectSrc ? r.detectSrc : NO_DETECT_SRC),
    ),
    listings: newestListings(records),
    sessions: sessionRows(records, opts.sort),
    unnamed: records.filter((r) => !namesSession(r)).length,
    runShareP50: percentile(runShare, 50),
    load: {
      buckets: LOAD_BUCKETS.map((b) => {
        const rs = records.filter((r) => {
          const l = loadPerCore(r);
          return l !== null && l >= b.lo && l < b.hi;
        });
        // `records` is the bucket's size; `n` (from `stat`) is how many had a total.
        return { label: b.label, records: rs.length, ...stat(rs, 'total') };
      }),
      rTotalVsLoad1: pearson(records.map((r) => [load1(r), total(r)])),
      rTotalVsCpuPct: pearson(records.map((r) => [r.cpuPct, total(r)])),
      rRunVsLoad1: pearson(records.map((r) => [load1(r), run(r)])),
    },
  };
};

// --- printing ---

// C0 controls, DEL, C1 controls, the two Unicode line separators, and the
// bidirectional controls: the overrides and isolates, and the three marks
// (Arabic letter mark U+061C, left-to-right U+200E, right-to-left U+200F).
// ESC and CSI start the sequences a terminal obeys (move the cursor, set
// the window title, write the clipboard); a line break forges a row; a
// bidi control reorders one.
const UNSAFE_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * Any value as text that is safe to print: the characters above are
 * removed. The one way a value from the log or the command line reaches
 * the terminal — `renderTable` applies it to every cell, and the few lines
 * printed outside a table use it directly.
 */
const safeText = (v) => String(v ?? '').replace(UNSAFE_CHARS, '');

/** Length in code points: what `clip` and the column widths count. */
const textLength = (s) => Array.from(s).length;

/** At most `w` code points, the last an ellipsis when cut. Never splits a surrogate pair. */
const clip = (s, w) => {
  const chars = Array.from(String(s));
  return chars.length > w ? `${chars.slice(0, Math.max(0, w - 1)).join('')}…` : chars.join('');
};

/**
 * Rows of cells as aligned text. Each column is as wide as its widest cell,
 * so nothing is cut to fit: a cell that must be short is clipped by its
 * caller, on purpose. `align[i]` is 'r' for a right-aligned column. The last
 * column is not padded.
 */
const renderTable = (headers, rows, align = []) => {
  const all = [headers, ...rows].map((row) => row.map(safeText));
  // A loop, not `Math.max(...)`: the rows are as many as the log has
  // sessions, and a call takes only so many arguments.
  const widths = headers.map(() => 0);
  for (const row of all) {
    for (let i = 0; i < widths.length; i++) {
      widths[i] = Math.max(widths[i], textLength(row[i] ?? ''));
    }
  }
  return all
    .map((row) => {
      const cells = row.map((cell, i) => {
        const gap = ' '.repeat(Math.max(0, widths[i] - textLength(cell)));
        if (align[i] === 'r') return gap + cell;
        return i === row.length - 1 ? cell : cell + gap;
      });
      return `  ${cells.join('  ')}`.replace(/\s+$/, '');
    })
    .join('\n');
};

const fmt = (v) => (v === null || v === undefined ? '—' : v.toFixed(v < 10 ? 1 : 0));

/**
 * `p50/p90`, followed by `(k)` when only k of the group's n records had the
 * step — a resume has no `detect`, a timed-out switch no `total` — so a
 * percentile is never read as covering records it does not.
 */
const statCell = (s, groupN) => {
  if (s.n === 0) return '—';
  return `${fmt(s.p50)}/${fmt(s.p90)}${s.n !== groupN ? ` (${s.n})` : ''}`;
};

const stepTable = (title, label, groups) =>
  [
    title,
    renderTable(
      [label, 'n', ...STEPS],
      groups.map((g) => [g.key, String(g.n), ...STEPS.map((s) => statCell(g.steps[s], g.n))]),
      ['l', 'r', ...STEPS.map(() => 'r')],
    ),
  ].join('\n');

/** Sessions shown unless `--all`. */
const SESSION_ROWS_DEFAULT = 20;
const SESSION_ID_MIN = 8;
const TITLE_MAX = 40;

/**
 * `~/rest` for a path at or under the home directory. Under means past a
 * separator: `/Users/al-work` is not inside `/Users/al`.
 */
const tildePath = (p, home) => {
  const h = String(home || '').replace(/\/+$/, '');
  if (!h) return p;
  if (p === h) return '~';
  return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
};

/**
 * A short label per session id: the first 8 characters, or as many more as
 * it takes for no two of the given ids to share a label. A placeholder from
 * `--redact` is already short and is its own label — `session-10` and
 * `session-11` must not be cut to the same thing.
 */
const sessionLabels = (ids, redacted) => {
  if (redacted) return new Map(ids.map((id) => [id, id]));
  let longest = SESSION_ID_MIN;
  for (const id of ids) longest = Math.max(longest, id.length);
  for (let len = SESSION_ID_MIN; len <= longest; len++) {
    const labels = ids.map((id) => id.slice(0, len));
    if (new Set(labels).size === new Set(ids).size) return new Map(ids.map((id, i) => [id, labels[i]]));
  }
  return new Map(ids.map((id) => [id, id]));
};

const sessionTable = (s, opts) => {
  const shown = opts.all ? s.sessions : s.sessions.slice(0, SESSION_ROWS_DEFAULT);
  const lines = [
    `By session (${shown.length} of ${s.sessions.length}, sorted by ${
      opts.sort === 'p90' ? 'p90 total' : 'switches'
    }${s.unnamed ? `; ${s.unnamed} older record(s) do not name a session` : ''})`,
  ];
  if (shown.length === 0) return lines.concat('  (no record names its session)').join('\n');
  // Labels are unique among ALL sessions, so a row means the same with and without --all.
  const labels = sessionLabels(
    s.sessions.map((row) => row.sessionId),
    !!opts.redact,
  );
  const home = opts.home ?? os.homedir();
  lines.push(
    renderTable(
      ['session', 'n', 'total p50/p90', 'run p50/p90', 'terminal', 'account', 'branches', 'title · project'],
      shown.map((row) => [
        labels.get(row.sessionId),
        String(row.n),
        statCell({ n: row.totalN, p50: row.totalP50, p90: row.totalP90 }, row.n),
        statCell({ n: row.runN, p50: row.runP50, p90: row.runP90 }, row.n),
        row.terminals.join(',') || '—',
        row.account,
        row.branches,
        // Cleaned before it is clipped, so the 40 are 40 visible characters.
        `${clip(safeText(row.title || '(no title)'), TITLE_MAX)} · ${
          row.project ? tildePath(safeText(row.project), home) : '—'
        }`,
      ]),
      ['l', 'r', 'r', 'r'],
    ),
  );
  if (shown.length < s.sessions.length) lines.push('  … --all lists every session');
  return lines.join('\n');
};

/**
 * One line from the newest record that carries the counters: how many
 * process listings terminal detection ran since the app started, how many
 * failed, and why the last one did (timeout, error <code>, empty), how long
 * it ran and for whom (badge, switch, crossref).
 */
const listingsLine = (l) =>
  `Process listings since the app started: ${l.n}, failed ${l.failed}` +
  (l.last
    ? ` (last: ${safeText(l.last.reason)}, ${Math.round(l.last.ms)} ms, ${safeText(l.last.path)})`
    : '');

const formatReport = (summary, malformed = 0, opts = {}) => {
  if (summary.count === 0) {
    return `No switch records${malformed ? ` (${malformed} malformed line(s) skipped)` : ''}.`;
  }
  const s = summary;
  const r = (v) => (v === null ? '— (too few records, or no variance)' : v.toFixed(2));
  return [
    ...(opts.redact
      ? ['Redacted: session ids, titles, account labels and project paths are placeholders.']
      : []),
    `${s.count} switches · ${s.slow} over 1 s · ${s.timedOut} timed out · ${s.killed} killed by their timeout · ${s.failed} failed · ${s.untimed} not timed end to end` +
      (malformed ? ` · ${malformed} malformed line(s) skipped` : ''),
    'Cells are p50/p90 in ms. Steps: clickToIpc (renderer → main), settings, detect',
    '(which terminal), build (script text), spawn (write + start), run (the external',
    'command), main (IPC → done), total (click → done).',
    'n is the records in the row. A cell ending in (k) is over only k of them: the',
    'rest have no value for that step. A resume does not detect. run, main and total',
    'are over completed switches only. The other four kinds in the first line are left',
    'out, and each switch is counted in one of them at most: timed out, else killed,',
    'else failed, else not timed end to end (no command was started and awaited:',
    'mostly switches handed to VS Code, Claude Desktop or the embedded terminal).',
    '',
    stepTable('All', '', [{ key: 'all', n: s.count, steps: s.all }]),
    '',
    stepTable('By kind', 'kind', s.byKind),
    '',
    stepTable('By terminal', 'terminal', s.byTerminal),
    '',
    stepTable('By branch', 'branch', s.byBranch),
    '',
    stepTable('By account', 'account', s.byAccount),
    '',
    stepTable(
      'Switches to a running session, by how the terminal was decided (cache: a known answer reused; ps: one process listing; none: no detection, the switch had no pid; not recorded: before 1.0.100, two ps per level)',
      'detectSrc',
      s.byDetectSrc,
    ),
    ...(s.listings ? [listingsLine(s.listings)] : []),
    '',
    sessionTable(s, opts),
    '',
    `Share of the total spent inside the external command (run / total), p50: ${
      s.runShareP50 === null ? '—' : `${(s.runShareP50 * 100).toFixed(0)}%`
    }`,
    '',
    'Total vs load (1-minute load average per core)',
    renderTable(
      ['', 'n', 'total p50/p90'],
      s.load.buckets.map((b) => [b.label, String(b.records), statCell(b, b.records)]),
      ['l', 'r', 'r'],
    ),
    `  Pearson r, total vs 1-min load: ${r(s.load.rTotalVsLoad1)}`,
    `  Pearson r, run   vs 1-min load: ${r(s.load.rRunVsLoad1)}`,
    `  Pearson r, total vs CPU %     : ${r(s.load.rTotalVsCpuPct)}`,
  ].join('\n');
};

const defaultFiles = () => {
  const base = path.join(os.homedir(), '.config', 'codev', 'switch-timing.jsonl');
  return [`${base}.1`, base];
};

/**
 * The files' text, and the inputs that gave none, by position in `files`:
 * `missing` do not exist; `unreadable` exist and could not be read (no
 * permission, a directory), with the error code. The two are different
 * findings: a log that is not there has nothing to add, one that could not
 * be read makes the report incomplete.
 */
const readFiles = (files) => {
  let text = '';
  const missing = [];
  const unreadable = [];
  files.forEach((f, index) => {
    try {
      text += `${fs.readFileSync(f, 'utf-8')}\n`;
    } catch (err) {
      if (err && err.code === 'ENOENT') missing.push(index);
      else unreadable.push({ index, code: (err && err.code) || 'error' });
    }
  });
  return { text, missing, unreadable };
};

/** A line on the report itself, so a pasted copy says it too. */
const incompleteNote = (unreadable) =>
  unreadable.length > 0
    ? `Incomplete: ${unreadable.length} input file(s) exist but could not be read.`
    : null;

/** Flags and files from the command line; an unknown flag is an error, not a file name. */
const parseArgs = (argv) => {
  const opts = { redact: false, all: false, sort: 'n', files: [], bad: [] };
  for (const a of argv) {
    if (a === '--redact') opts.redact = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--sort=n' || a === '--sort=p90') opts.sort = a.slice('--sort='.length);
    else if (a.startsWith('--')) opts.bad.push(a);
    else opts.files.push(a);
  }
  return opts;
};

const main = (argv) => {
  const opts = parseArgs(argv);
  if (opts.bad.length > 0) {
    console.error(`unknown option: ${safeText(opts.bad.join(' '))}`);
    console.error('usage: switch-timing-summary.js [--redact] [--all] [--sort=n|p90] [file ...]');
    process.exitCode = 2;
    return;
  }
  const explicit = opts.files.length > 0;
  const files = explicit ? opts.files : defaultFiles();
  const { text, missing, unreadable } = readFiles(files);
  // A path can name a project or a user: a redacted run says which input, not where it is.
  const nameOf = (index) => (opts.redact ? `input ${index + 1}` : safeText(files[index]));
  // The rotated file is optional; only a file the user named is worth a note when absent.
  if (explicit) for (const i of missing) console.error(`cannot read ${nameOf(i)}: no such file`);
  // A file that is there and cannot be read is always worth one: the default
  // run would otherwise print one half of the log as if it were all of it.
  for (const u of unreadable) {
    console.error(`cannot read ${nameOf(u.index)} (${safeText(u.code)}): the report is incomplete`);
  }
  const note = incompleteNote(unreadable);
  if (note) {
    console.log(note);
    process.exitCode = 1;
  }
  const { records, malformed } = parseLines(text);
  const shown = opts.redact ? redactRecords(records) : records;
  console.log(formatReport(summarize(shown, opts), malformed, opts));
};

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  percentile,
  pearson,
  parseLines,
  summarize,
  formatReport,
  stepStats,
  sessionRows,
  sessionLabels,
  branchMix,
  redactRecords,
  readFiles,
  parseArgs,
  safeText,
  clip,
  tildePath,
  renderTable,
  STEPS,
};
