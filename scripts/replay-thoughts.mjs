#!/usr/bin/env node
/**
 * replay-thoughts.mjs — offline tuning for the Thought/Trigger engine.
 *
 * Copies the real user_memory.duckdb to a temp file (the running service holds
 * a single-writer lock; recent uncheckpointed WAL rows won't be included — stop
 * the service first for a complete replay), then replays episodic captures
 * through ThoughtService.upsert and reports when thoughts would cross τ.
 *
 * Usage:
 *   node scripts/replay-thoughts.mjs [--hours 72] [--limit 500] [--tau 1.0]
 *      [--sim 0.72] [--entity-sim 0.60] [--decay 0.35]
 *
 * Env overrides work too: THOUGHT_MATCH_SIM, THOUGHT_MATCH_SIM_ENTITY,
 * THOUGHT_DECAY_D, THOUGHT_TRIGGER_SCORE.
 *
 * NOTE: this replays *raw* episodic rows as screen_capture candidates using
 * window title + OCR snippet as the summary — no LLM extraction. That makes
 * matches noisier than production (extraction would sharpen summaries), so
 * treat the output as an upper bound on trigger frequency.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DB = path.join(ROOT, 'mcp-services/thinkdrop-user-memory-service/data/user_memory.duckdb');

// ── args ──────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']);
    return acc;
  }, [])
);
const HOURS = Number(args.hours) || 72;
const LIMIT = Number(args.limit) || 500;
if (args.tau) process.env.THOUGHT_TRIGGER_SCORE = args.tau;
if (args.sim) process.env.THOUGHT_MATCH_SIM = args.sim;
if (args['entity-sim']) process.env.THOUGHT_MATCH_SIM_ENTITY = args['entity-sim'];
if (args.decay) process.env.THOUGHT_DECAY_D = args.decay;
const TAU = parseFloat(process.env.THOUGHT_TRIGGER_SCORE || '1.0');

// ── copy DB to temp (avoids the live service's writer lock) ─────────────────
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'thoughts-replay-')), 'replay.duckdb');
for (const suffix of ['', '.wal']) {
  if (fs.existsSync(SRC_DB + suffix)) fs.copyFileSync(SRC_DB + suffix, tmpDb + suffix);
}
process.env.DB_PATH = tmpDb;
console.log(`[replay] copied DB → ${tmpDb}`);

// ── import service modules AFTER DB_PATH is set ────────────────────────────
const svcDir = path.join(ROOT, 'mcp-services/thinkdrop-user-memory-service/src/services');
const { getDatabaseService } = await import(pathToFileURL(path.join(svcDir, 'database.js')).href);
const { getThoughtService } = await import(pathToFileURL(path.join(svcDir, 'thoughts.js')).href);
const db = getDatabaseService();
const thoughts = getThoughtService();
await db.initialize();

// ── load episodic window ────────────────────────────────────────────────────
const rows = await db.query(`
  SELECT id, created_at, metadata, source_text, extracted_text
  FROM episodic_memory
  WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '${HOURS}' HOUR
  ORDER BY created_at ASC
  LIMIT ${LIMIT}
`);
console.log(`[replay] ${rows.length} episodic rows in last ${HOURS}h\n`);

const parseMeta = (m) => { try { return typeof m === 'string' ? JSON.parse(m) : (m || {}); } catch { return {}; } };

// ── replay ──────────────────────────────────────────────────────────────────
let candidates = 0, reinforced = 0, inserted = 0, triggers = 0;
const triggerLog = [];

for (const r of rows) {
  const meta = parseMeta(r.metadata);
  const app = meta.appName || meta.app || 'unknown';
  const title = meta.windowTitle || '';
  const ocr = (meta.ocrText || meta.ocr_text || r.extracted_text || r.source_text || '')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
  if (ocr.length < 20 && !title) continue;

  const summary = [title, ocr].filter(Boolean).join(' — ').slice(0, 300);
  const res = await thoughts.upsert({
    input: 'screen_capture',
    summary,
    entityNames: [app],
    actionNames: [],
    sourceIds: [r.id],
    userId: 'local_user',
    traceWeight: 0.35,
  });
  candidates++;
  if (res.matched) reinforced++; else inserted++;

  const t = res.thought;
  if (t && t.status === 'thought' && t.score >= TAU) {
    triggers++;
    triggerLog.push({
      at: r.created_at, id: t.id, score: t.score,
      summary: (t.summary || '').slice(0, 90),
      traces: (t.reinforcements || []).length,
    });
  }
}

// ── report ──────────────────────────────────────────────────────────────────
const { thoughts: open } = await thoughts.list({ userId: 'local_user', all: true, limit: 500 });
console.log(`\n═══ replay report ═══`);
console.log(`candidates: ${candidates}  →  ${inserted} new + ${reinforced} reinforced`);
console.log(`open thoughts: ${open.length}  |  would-be triggers (score ≥ ${TAU}): ${triggers}`);
if (triggerLog.length) {
  console.log(`\nTrigger points:`);
  for (const t of triggerLog.slice(0, 30)) {
    console.log(`  ${t.at}  score=${t.score.toFixed(2)}  traces=${t.traces}  ${t.summary}`);
  }
}
console.log(`\nTop open thoughts:`);
for (const t of open.slice(0, 15)) {
  console.log(`  ${t.score.toFixed(2)}  [${t.input}] ${(t.summary || '').slice(0, 90)}`);
}

process.exit(0);
