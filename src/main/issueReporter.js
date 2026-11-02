'use strict';
/**
 * issueReporter.js — local issue store for ThinkDrop-internal failures.
 *
 * When an infrastructure failure surfaces (dead/hung MCP service, open
 * circuit breaker, hung agent registry), the SystemFailureCard's "Report
 * issue" action records the incident here so an engineer can review it later
 * from the Issues surface (slideout drawer → Issues).
 *
 * Storage: append-only JSONL at ~/.thinkdrop/issues/issues.jsonl — one record
 * per line, tolerant of partial reads, no schema migration needed. `dismiss`
 * rewrites the file (records are few).
 *
 * GitHub filing is intentionally not wired yet — the record shape carries
 * everything a `fileOnGitHub(id)` step will need later (title, summary,
 * detail bundle, app version).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ISSUES_DIR = path.join(os.homedir(), '.thinkdrop', 'issues');
const ISSUES_FILE = path.join(ISSUES_DIR, 'issues.jsonl');
const MAX_KEPT = 500; // trim oldest beyond this on write

function _appVersion() {
  try { return require('electron').app?.getVersion?.() || null; } catch (_) { return null; }
}

// Cheap secret redaction for anything user/LLM-authored that lands in detail.
// Local file only — but issues are meant to be pasted/filed later, so scrub
// obvious token material at write time.
const _SECRET_RES = [
  /\b(Bearer|token|api[_-]?key|apikey|password|passwd|secret|authorization)\s*[=:]\s*[^\s,;"']+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
function _redact(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (typeof value === 'string') {
    let out = value;
    for (const re of _SECRET_RES) out = out.replace(re, (m) => m.includes('=') || m.includes(':')
      ? m.replace(/[=:]\s*[^\s,;"']+/, '$1 [redacted]')
      : '[redacted]');
    return out.slice(0, 8000);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(v => _redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).slice(0, 60)) {
      if (/token|secret|password|passwd|api[_-]?key|authorization|cookie/i.test(k)) { out[k] = '[redacted]'; continue; }
      out[k] = _redact(value[k], depth + 1);
    }
    return out;
  }
  return value;
}

function _readAll() {
  if (!fs.existsSync(ISSUES_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(ISSUES_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* skip corrupt line */ }
  }
  return out;
}

function _writeAll(records) {
  fs.mkdirSync(ISSUES_DIR, { recursive: true });
  const kept = records.slice(-MAX_KEPT);
  fs.writeFileSync(ISSUES_FILE, kept.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/**
 * recordIssue({ title, summary, detail }) → { ok, issueId }
 * detail is sanitized (secret keys/values redacted) before persisting.
 */
function recordIssue({ title, summary, detail } = {}) {
  const id = `iss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    ts: new Date().toISOString(),
    title: String(title || 'ThinkDrop issue').slice(0, 200),
    summary: String(summary || '').slice(0, 2000),
    detail: _redact(detail && typeof detail === 'object' ? detail : {}),
    status: 'recorded',
    app: { version: _appVersion(), platform: process.platform, arch: process.arch },
  };
  try {
    fs.mkdirSync(ISSUES_DIR, { recursive: true });
    fs.appendFileSync(ISSUES_FILE, JSON.stringify(record) + '\n', 'utf8');
    // Opportunistic trim so the file can't grow unbounded.
    const all = _readAll();
    if (all.length > MAX_KEPT) _writeAll(all);
    return { ok: true, issueId: id };
  } catch (err) {
    console.error('[IssueReporter] record failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/** listIssues() → newest-first array of records. */
function listIssues() {
  return _readAll().reverse();
}

/** dismissIssue(id) → mark a record dismissed (kept for audit, hidden in UI). */
function dismissIssue(id) {
  const all = _readAll();
  const rec = all.find(r => r.id === id);
  if (!rec) return { ok: false, error: 'not found' };
  rec.status = 'dismissed';
  rec.dismissedAt = new Date().toISOString();
  _writeAll(all);
  return { ok: true };
}

module.exports = { recordIssue, listIssues, dismissIssue, ISSUES_FILE };
