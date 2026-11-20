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
 * by kind, terminal, branch and account; a per-session table (the 20 with
 * the most switches; `--all` for every one, `--sort=p90` for the slowest
 * first); then the total against machine load. Plain Node, no dependencies.
 * A line that is not a record is counted and skipped; a missing or empty
 * file is reported, not an error. Version 1 lines, which did not name their
 * session, count everywhere except the per-session table.
 *
 * The log names sessions: id, title, account label and project path. That
 * is the owner's own data on the owner's machine — but the output of this
 * script gets pasted into issues. `--redact` replaces every one of those
 * with a placeholder (session-1, account-1, ~/project-1) that is stable
 * for a given log, so two runs over the same file can be compared.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Steps in path order; `total` is what the user waited. */
const STEPS = ['clickToIpc', 'settings', 'detect', 'build', 'spawn', 'run', 'main', 'total'];

/**
 * The p-th percentile (0–100) by linear interpolation between the two
 * nearest ranks — the same definition as numpy's default. Null for no data.
 */
const percentile = (values, p) => {
  const xs = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
};

/** Pearson's r over the pairs where both values are numbers; null under 3 pairs or no variance. */
const pearson = (pairs) => {
  const ps = pairs.filter(
    ([x, y]) => typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y),
  );
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

/** Records from JSONL text. Anything that is not an object with an `ms` object is skipped and counted. */
const parseLines = (text) => {
  const records = [];
  let malformed = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === 'object' && r.ms && typeof r.ms === 'object') records.push(r);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { records, malformed };
};

const stepStats = (records) => {
  const out = {};
  for (const step of STEPS) {
    const xs = records.map((r) => r.ms[step]).filter((v) => typeof v === 'number' && Number.isFinite(v));
    out[step] = { n: xs.length, p50: percentile(xs, 50), p90: percentile(xs, 90) };
  }
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

/** A record that names its session (version 2 on). */
const namesSession = (r) => typeof r.sessionId === 'string' && r.sessionId !== '';

/**
 * The account a record belongs to. A v2 record with no label is the anchor
 * account (it carries none); a v1 record never said.
 */
const accountOf = (r) =>
  typeof r.account === 'string' && r.account ? r.account : namesSession(r) ? '(anchor)' : UNKNOWN;

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
  const num = (xs) => xs.filter((v) => typeof v === 'number' && Number.isFinite(v));
  const rows = [...groups.entries()].map(([sessionId, rs]) => {
    const last = (key) => {
      for (let i = rs.length - 1; i >= 0; i--) {
        if (typeof rs[i][key] === 'string' && rs[i][key]) return rs[i][key];
      }
      return null;
    };
    const totals = num(rs.map((r) => r.ms.total));
    const runs = num(rs.map((r) => r.ms.run));
    return {
      sessionId,
      title: last('title'),
      account: accountOf(rs[rs.length - 1]),
      project: last('project'),
      terminals: distinct(rs.map((r) => r.terminal)),
      ttys: distinct(rs.map((r) => r.tty)),
      n: rs.length,
      totalP50: percentile(totals, 50),
      totalP90: percentile(totals, 90),
      runP50: percentile(runs, 50),
      runP90: percentile(runs, 90),
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
  Array.isArray(r.load) && typeof r.load[0] === 'number' && typeof r.ncpu === 'number' && r.ncpu > 0
    ? r.load[0] / r.ncpu
    : null;

const LOAD_BUCKETS = [
  { label: 'load/core < 0.5', lo: 0, hi: 0.5 },
  { label: 'load/core 0.5–1', lo: 0.5, hi: 1 },
  { label: 'load/core 1–2', lo: 1, hi: 2 },
  { label: 'load/core ≥ 2', lo: 2, hi: Infinity },
];

const summarize = (records, opts = {}) => {
  const total = (r) => r.ms.total;
  // Of each switch's total, the part spent inside the external command.
  const runShare = records
    .filter((r) => typeof r.ms.run === 'number' && typeof r.ms.total === 'number' && r.ms.total > 0)
    .map((r) => r.ms.run / r.ms.total);
  return {
    count: records.length,
    timedOut: records.filter((r) => r.timedOut === true).length,
    failed: records.filter((r) => r.ok === false).length,
    slow: records.filter((r) => typeof r.ms.total === 'number' && r.ms.total > 1000).length,
    all: stepStats(records),
    byKind: groupBy(records, (r) => String(r.kind ?? 'unknown')),
    byTerminal: groupBy(records, (r) => String(r.terminal ?? 'unknown')),
    byBranch: groupBy(records, (r) => String(r.branch ?? 'unknown')),
    byAccount: groupBy(records, accountOf),
    sessions: sessionRows(records, opts.sort),
    unnamed: records.filter((r) => !namesSession(r)).length,
    runShareP50: percentile(runShare, 50),
    load: {
      buckets: LOAD_BUCKETS.map((b) => {
        const rs = records.filter((r) => {
          const l = loadPerCore(r);
          return l !== null && l >= b.lo && l < b.hi;
        });
        const xs = rs.map(total);
        return { label: b.label, n: rs.length, p50: percentile(xs, 50), p90: percentile(xs, 90) };
      }),
      rTotalVsLoad1: pearson(records.map((r) => [Array.isArray(r.load) ? r.load[0] : null, total(r)])),
      rTotalVsCpuPct: pearson(records.map((r) => [r.cpuPct, total(r)])),
      rRunVsLoad1: pearson(records.map((r) => [Array.isArray(r.load) ? r.load[0] : null, r.ms.run])),
    },
  };
};

const fmt = (v) => (v === null || v === undefined ? '—' : v.toFixed(v < 10 ? 1 : 0));
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);

const stepTable = (title, groups) => {
  const lines = [title];
  lines.push(`  ${pad('', 16)}${padL('n', 5)}  ${STEPS.map((s) => padL(s, 13)).join('')}`);
  for (const g of groups) {
    const cells = STEPS.map((s) => padL(`${fmt(g.steps[s].p50)}/${fmt(g.steps[s].p90)}`, 13)).join('');
    lines.push(`  ${pad(g.key, 16)}${padL(g.n, 5)}  ${cells}`);
  }
  return lines.join('\n');
};

/** Sessions shown unless `--all`. */
const SESSION_ROWS_DEFAULT = 20;

const clip = (s, w) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);

const sessionTable = (s, opts) => {
  const home = os.homedir();
  const shown = opts.all ? s.sessions : s.sessions.slice(0, SESSION_ROWS_DEFAULT);
  const lines = [
    `By session (${shown.length} of ${s.sessions.length}, sorted by ${
      opts.sort === 'p90' ? 'p90 total' : 'switches'
    }${s.unnamed ? `; ${s.unnamed} older record(s) do not name a session` : ''})`,
  ];
  if (shown.length === 0) return lines.concat('  (no record names its session)').join('\n');
  lines.push(
    `  ${pad('session', 10)}${padL('n', 4)}  ${padL('total p50/p90', 14)}  ${padL('run p50/p90', 12)}  ${pad('terminal', 10)}${pad('account', 12)}${pad('branches', 24)}title · project`,
  );
  for (const row of shown) {
    const id = /^session-\d+$/.test(row.sessionId) ? row.sessionId : row.sessionId.slice(0, 8);
    const project = row.project
      ? row.project.startsWith(home) ? `~${row.project.slice(home.length)}` : row.project
      : '—';
    lines.push(
      `  ${pad(clip(id, 9), 10)}${padL(row.n, 4)}  ${padL(`${fmt(row.totalP50)}/${fmt(row.totalP90)}`, 14)}  ${padL(
        `${fmt(row.runP50)}/${fmt(row.runP90)}`,
        12,
      )}  ${pad(clip(row.terminals.join(',') || '—', 9), 10)}${pad(clip(row.account, 11), 12)}${pad(
        clip(row.branches, 23),
        24,
      )}${clip(row.title || '(no title)', 40)} · ${project}`,
    );
  }
  if (shown.length < s.sessions.length) lines.push('  … --all lists every session');
  return lines.join('\n');
};

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
    `${s.count} switches · ${s.slow} over 1 s · ${s.timedOut} timed out · ${s.failed} failed` +
      (malformed ? ` · ${malformed} malformed line(s) skipped` : ''),
    'Cells are p50/p90 in ms. Steps: clickToIpc (renderer → main), settings, detect',
    '(which terminal), build (script text), spawn (write + start), run (the external',
    'command), main (IPC → done), total (click → done).',
    '',
    stepTable('All', [{ key: 'all', n: s.count, steps: s.all }]),
    '',
    stepTable('By kind', s.byKind),
    '',
    stepTable('By terminal', s.byTerminal),
    '',
    stepTable('By branch', s.byBranch),
    '',
    stepTable('By account', s.byAccount),
    '',
    sessionTable(s, opts),
    '',
    `Share of the total spent inside the external command (run / total), p50: ${
      s.runShareP50 === null ? '—' : `${(s.runShareP50 * 100).toFixed(0)}%`
    }`,
    '',
    'Total vs load (1-minute load average per core)',
    ...s.load.buckets.map(
      (b) => `  ${pad(b.label, 18)}${padL(b.n, 5)}  p50 ${padL(fmt(b.p50), 6)}  p90 ${padL(fmt(b.p90), 6)}`,
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

const readFiles = (files) => {
  let text = '';
  const missing = [];
  for (const f of files) {
    try {
      text += `${fs.readFileSync(f, 'utf-8')}\n`;
    } catch {
      missing.push(f);
    }
  }
  return { text, missing };
};

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
    console.error(`unknown option: ${opts.bad.join(' ')}`);
    console.error('usage: switch-timing-summary.js [--redact] [--all] [--sort=n|p90] [file ...]');
    process.exitCode = 2;
    return;
  }
  const explicit = opts.files.length > 0;
  const files = explicit ? opts.files : defaultFiles();
  const { text, missing } = readFiles(files);
  // The rotated file is optional; only a file the user named is worth a note.
  if (explicit) for (const f of missing) console.error(`cannot read ${f}`);
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
  branchMix,
  redactRecords,
  parseArgs,
  STEPS,
};
