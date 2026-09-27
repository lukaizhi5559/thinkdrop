#!/usr/bin/env node
/* latency-report.cjs — Stage 7 latency gate.
 *
 * Reads driver result JSONs, buckets PASSING entries by `intent|statusClass`,
 * computes p50/p90/p95/max per bucket, compares against a budget table, and
 * exits non-zero on breach. Failed entries are a correctness signal, not a
 * latency sample, so they are excluded from stats (still reported).
 *
 * Usage:
 *   node latency-report.cjs results/stage5-automate-run{1,2,3}.json
 *   node latency-report.cjs --budgets budgets.json results/*.json
 *
 * Budget keys: "<intent>|<statusClass>" where statusClass is
 * 'awaiting-approval' | 'done' | 'other'. "_default|<class>" applies when no
 * intent-specific budget exists. Buckets with n < MIN_GATE_N are reported but
 * not gated (percentiles are meaningless below ~10 samples).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MIN_GATE_N = 10;

const DEFAULT_BUDGETS = {
  'command_automate|done':              { p50: 15000, p95: 45000 },
  'command_automate|awaiting-approval': { p50: 60000, p95: 120000 },
  'web_search|done':                    { p50: 60000, p95: 120000 },
  'memory_retrieve|done':               { p50: 15000, p95: 45000 },
  'general_quick|done':                 { p50: 10000, p95: 30000 },
  'memory_quick|done':                  { p50: 10000, p95: 30000 },
  'memory_store|done':                  { p50: 10000, p95: 30000 },
  '_default|done':                      { p50: 30000, p95: 90000 },
  '_default|awaiting-approval':         { p50: 60000, p95: 120000 },
};

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function statusClass(status) {
  if (status === 'awaiting-approval') return 'awaiting-approval';
  if (status === 'done') return 'done';
  return 'other';
}

const argv = process.argv.slice(2);
let budgetsFile = null;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--budgets') { budgetsFile = argv[++i]; continue; }
  files.push(argv[i]);
}
if (!files.length) {
  console.error('usage: latency-report.cjs [--budgets file.json] <results.json> [...]');
  process.exit(2);
}
const budgets = budgetsFile ? JSON.parse(fs.readFileSync(budgetsFile, 'utf8')) : DEFAULT_BUDGETS;

const buckets = new Map(); // key -> { lat: [], comms: [], ids: [] }
const failedEntries = [];
let totalPass = 0, totalEntries = 0;

for (const f of files) {
  const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const r of doc.results || []) {
    totalEntries++;
    const intent = r.graphIntent?.intent || r.commsIntent || 'unknown';
    const cls = statusClass(r.status);
    const key = `${intent}|${cls}`;
    if (!r.pass) { failedEntries.push({ id: r.id, run: doc.run, status: r.status, ms: r.totalMs }); continue; }
    totalPass++;
    if (typeof r.totalMs !== 'number') continue;
    let b = buckets.get(key);
    if (!b) { b = { lat: [], comms: [], ids: [] }; buckets.set(key, b); }
    b.lat.push(r.totalMs);
    if (typeof r.commsLatencyMs === 'number') b.comms.push(r.commsLatencyMs);
    b.ids.push(r.id);
  }
}

const fmt = (ms) => ms == null ? '  -  ' : `${(ms / 1000).toFixed(1)}s`;
let breaches = [];

console.log(`\n${'═'.repeat(78)}\n  LATENCY REPORT — ${files.length} run(s), ${totalPass}/${totalEntries} passing\n${'═'.repeat(78)}`);
console.log(`  ${'bucket'.padEnd(46)} ${'n'.padStart(3)} ${'p50'.padStart(8)} ${'p90'.padStart(8)} ${'p95'.padStart(8)} ${'max'.padStart(8)}   budget`);

const keys = [...buckets.keys()].sort();
for (const key of keys) {
  const b = buckets.get(key);
  b.lat.sort((a, c) => a - c);
  b.comms.sort((a, c) => a - c);
  const n = b.lat.length;
  const p50 = pct(b.lat, 50), p90 = pct(b.lat, 90), p95 = pct(b.lat, 95), max = b.lat[n - 1];
  const budget = budgets[key] || budgets[`_default|${key.split('|')[1]}`] || null;
  const gated = n >= MIN_GATE_N && budget;
  let flag = '';
  if (budget && n >= MIN_GATE_N) {
    if (p50 > budget.p50) { breaches.push(`${key}: p50 ${p50}ms > budget ${budget.p50}ms`); flag = ' ✗p50'; }
    if (p95 > budget.p95) { breaches.push(`${key}: p95 ${p95}ms > budget ${budget.p95}ms`); flag += ' ✗p95'; }
  } else if (budget) {
    flag = ' (n<10, report-only)';
  }
  const btxt = budget ? `${fmt(budget.p50)}/${fmt(budget.p95)}` : 'none';
  console.log(`  ${key.padEnd(46)} ${String(n).padStart(3)} ${fmt(p50).padStart(8)} ${fmt(p90).padStart(8)} ${fmt(p95).padStart(8)} ${fmt(max).padStart(8)}   ${btxt}${flag}`);
}

// comms dispatch latency (driver-side measure of comms.process)
const allComms = [];
for (const b of buckets.values()) allComms.push(...b.comms);
if (allComms.length) {
  allComms.sort((a, c) => a - c);
  console.log(`\n  comms.process latency (all): n=${allComms.length} p50=${fmt(pct(allComms, 50))} p95=${fmt(pct(allComms, 95))} max=${fmt(allComms[allComms.length - 1])}`);
}

if (failedEntries.length) {
  console.log(`\n  excluded failures (${failedEntries.length}):`);
  for (const e of failedEntries.slice(0, 10)) console.log(`    run${e.run} ${e.id}: ${e.status} ${e.ms}ms`);
}

console.log(`\n${'─'.repeat(78)}`);
if (breaches.length) {
  console.log('  LATENCY GATE: FAIL');
  breaches.forEach(b => console.log(`    ✗ ${b}`));
  process.exit(1);
} else {
  console.log('  LATENCY GATE: PASS');
  process.exit(0);
}
