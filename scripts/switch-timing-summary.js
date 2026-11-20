#!/usr/bin/env node
/**
 * Summarize CodeV's switch timing log (src/switch-timing.ts writes it).
 *
 *   node scripts/switch-timing-summary.js [file ...]
 *
 * With no argument it reads ~/.config/codev/switch-timing.jsonl.1 (the
 * rotated file, if any) and then ~/.config/codev/switch-timing.jsonl.
 *
 * Prints p50 / p90 per step and for the total, for all switches and grouped
 * by kind, terminal and branch; then the total against machine load. Plain
 * Node, no dependencies. A line that is not a record is counted and skipped;
 * a missing or empty file is reported, not an error.
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

const summarize = (records) => {
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

const formatReport = (summary, malformed = 0) => {
  if (summary.count === 0) {
    return `No switch records${malformed ? ` (${malformed} malformed line(s) skipped)` : ''}.`;
  }
  const s = summary;
  const r = (v) => (v === null ? '— (too few records, or no variance)' : v.toFixed(2));
  return [
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

const main = (argv) => {
  const explicit = argv.length > 0;
  const files = explicit ? argv : defaultFiles();
  const { text, missing } = readFiles(files);
  // The rotated file is optional; only a file the user named is worth a note.
  if (explicit) for (const f of missing) console.error(`cannot read ${f}`);
  const { records, malformed } = parseLines(text);
  console.log(formatReport(summarize(records), malformed));
};

if (require.main === module) main(process.argv.slice(2));

module.exports = { percentile, pearson, parseLines, summarize, formatReport, stepStats, STEPS };
