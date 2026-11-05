'use strict';

/**
 * serviceManager.js — main-process control + observability for mcp-services.
 *
 * list()       — registry × live state: health probe, pid, RSS/CPU, gate mode,
 *                last-hit, uptime
 * setMode()    — coldable → gate admin :3030; warm/protected → kill or spawn;
 *                every mode persisted to ~/.thinkdrop/service-modes.json so
 *                shared/service-availability.cjs and the gate agree
 * restart()    — kill by port, respawn per registry (env, NODE_OPTIONS heap,
 *                stdout → logs/<logFile>), record in .service-pids
 * logs()       — tail logs/<logFile>
 * ollamaModels()/unloadModel() — GET /api/ps, POST /api/generate keep_alive:0
 * reportIssue()— bundle service info + last-40-log-lines into issueReporter
 *
 * Fail-soft everywhere: a missing gate or dead probe never throws to the UI.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { REGISTRY, get: getSvc } = require('../../shared/service-registry.cjs');
const { MODES_FILE } = require('../../shared/service-availability.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG_DIR = path.join(ROOT, 'logs');
const PIDS_FILE = path.join(ROOT, '.service-pids');
const GATE_ADMIN = `http://127.0.0.1:${process.env.SERVICE_GATE_ADMIN_PORT || 3030}`;

// ── tiny helpers ────────────────────────────────────────────────────────────
function getJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve({ code: res.statusCode, body: JSON.parse(raw) }); } catch (_) { resolve({ code: res.statusCode, body: null }); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function postJson(url, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body); req.end();
  });
}

function exec(cmd, args, timeoutMs = 2000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? '' : stdout.trim());
    });
  });
}

function readPids() {
  try {
    const out = {};
    for (const line of fs.readFileSync(PIDS_FILE, 'utf8').split('\n')) {
      const m = line.match(/^([^:]+):(\d+)/);
      if (m) out[m[1]] = parseInt(m[2], 10);
    }
    return out;
  } catch (_) { return {}; }
}

function writePid(id, pid) {
  const pids = readPids();
  pids[id] = pid;
  fs.writeFileSync(PIDS_FILE, Object.entries(pids).map(([k, v]) => `${k}:${v}`).join('\n') + '\n');
}

function loadModes() {
  try { return JSON.parse(fs.readFileSync(MODES_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}
function saveMode(id, mode) {
  try {
    const modes = loadModes();
    modes[id] = mode;
    fs.mkdirSync(path.dirname(MODES_FILE), { recursive: true });
    fs.writeFileSync(MODES_FILE, JSON.stringify(modes, null, 2));
  } catch (_) {}
}

async function pidOnPort(port) {
  const out = await exec('lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN']);
  const pid = parseInt(out.split('\n')[0], 10);
  return Number.isFinite(pid) ? pid : null;
}

async function procStats(pid) {
  if (!pid) return { rssMb: null, cpu: null };
  const out = await exec('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)]);
  const m = out.match(/(\d+)\s+([\d.]+)/);
  return m ? { rssMb: Math.round(parseInt(m[1], 10) / 1024), cpu: parseFloat(m[2]) } : { rssMb: null, cpu: null };
}

async function probeHealth(svc) {
  const paths = [svc.healthPath, '/service.health', '/health', '/api/version'].filter((p, i, a) => p && a.indexOf(p) === i);
  const t0 = Date.now();
  for (const p of paths) {
    const r = await getJson(`http://127.0.0.1:${svc.port}${p}`);
    if (r && r.code === 200) return { up: true, latencyMs: Date.now() - t0, body: r.body };
  }
  return { up: false, body: null };
}

async function gateStatus() {
  const r = await getJson(`${GATE_ADMIN}/gate.status`, 1200);
  return r?.body?.services || null;
}

// ── spawn / kill ────────────────────────────────────────────────────────────
function _spawnCmd(svc) {
  if (svc.cmd && svc.cmd.includes('/')) {
    const p = path.join(ROOT, svc.dir, svc.cmd);
    if (fs.existsSync(p)) return svc.cmd;
    return svc.altCmd || 'python3';
  }
  return svc.cmd || 'node';
}

function spawnService(svc) {
  const logFile = path.join(LOG_DIR, svc.logFile || `${svc.id}.log`);
  const out = fs.openSync(logFile, 'a');
  const env = {
    ...process.env,
    PORT: String(svc.port),
    ...(svc.heap ? { NODE_OPTIONS: `--max-old-space-size=${svc.heap}` } : {}),
    ...Object.fromEntries(Object.entries(svc.env || {}).map(([k, v]) => [k, path.isAbsolute(v) ? v : path.join(ROOT, v)])),
  };
  const proc = spawn(_spawnCmd(svc), [svc.entry], {
    cwd: path.join(ROOT, svc.dir), env, stdio: ['ignore', out, out], detached: true,
  });
  fs.closeSync(out);
  proc.unref();
  writePid(svc.id, proc.pid);
  return proc.pid;
}

async function killService(svc) {
  const pid = await pidOnPort(svc.port);
  if (!pid) return false;
  try { process.kill(pid, 'SIGTERM'); } catch (_) { return false; }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!(await pidOnPort(svc.port))) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  try { process.kill(pid, 'SIGKILL'); } catch (_) {}
  return true;
}

// ── public API ──────────────────────────────────────────────────────────────
async function list() {
  const gate = await gateStatus();
  const modes = loadModes();
  const pids = readPids();
  const rows = await Promise.all(REGISTRY.map(async (svc) => {
    const g = gate?.[svc.id];
    const isColdable = svc.tier === 'coldable';
    const health = svc.port ? await probeHealth(svc) : { up: false, body: null };
    // For gate-owned coldables the PUBLIC port is the gate's own socket — its
    // synthetic 200 must not read as "backend up", and its pid/RSS is the
    // gate's, not the service's. Backend state comes from /gate.status.
    const backendUp = isColdable && g ? g.state === 'warm'
                    : isColdable && !g ? health.up
                    : health.up;
    const pid = g ? g.pid
              : (isColdable ? (backendUp ? await pidOnPort(svc.port) : null)
                            : (backendUp ? await pidOnPort(svc.port) : (pids[svc.id] || null)));
    const { rssMb, cpu } = await procStats(backendUp ? pid : null);
    const mode = isColdable ? (g?.mode || modes[svc.id] || 'auto')
               : (modes[svc.id] || 'warm');
    const state = svc.tier === 'external' ? (backendUp ? 'warm' : 'down')
              : g ? g.state
              : (mode === 'off' ? 'off' : (backendUp ? 'warm' : 'down'));
    return {
      id: svc.id, label: svc.label, port: svc.port, tier: svc.tier,
      mode, state,
      healthy: backendUp,
      uptime: health.body?.uptime != null ? Math.round(health.body.uptime) : null,
      pid, rssMb, cpu,
      lastReq: g?.lastReq || null,
      reqs: g?.reqs ?? null,
      spawnedAt: g?.spawnedAt || null,
      gatePresent: gate !== null,
      version: health.body?.version || null,
    };
  }));
  return { ok: true, services: rows, gatePresent: gate !== null };
}

async function setMode(id, mode) {
  const svc = getSvc(id);
  if (!svc) return { ok: false, error: `unknown service ${id}` };
  if (svc.tier === 'external') return { ok: false, error: 'external service — not managed' };
  if (!['auto', 'warm', 'off'].includes(mode)) return { ok: false, error: 'mode must be auto|warm|off' };

  if (svc.tier === 'coldable' && (await gateStatus())) {
    const r = await postJson(`${GATE_ADMIN}/gate.mode`, { id, mode });
    if (!r || r.status !== 'ok') return { ok: false, error: r?.error || 'gate refused' };
    saveMode(id, mode);
    return { ok: true, id, mode };
  }

  // No gate — treat coldable like a normal service.
  if (mode === 'off') {
    await killService(svc);
    saveMode(id, 'off');
    return { ok: true, id, mode };
  }
  if (mode === 'warm' || mode === 'auto') {
    if (!(await pidOnPort(svc.port))) spawnService(svc);
    saveMode(id, svc.tier === 'coldable' ? 'warm' : 'warm');
    return { ok: true, id, mode };
  }
  return { ok: false, error: 'unreachable' };
}

async function restart(id) {
  const svc = getSvc(id);
  if (!svc) return { ok: false, error: `unknown service ${id}` };
  if (svc.tier === 'external') return { ok: false, error: 'external service — not managed' };
  if (svc.tier === 'coldable' && (await gateStatus())) {
    const r = await postJson(`${GATE_ADMIN}/gate.restart`, { id });
    if (!r || r.status !== 'ok') return { ok: false, error: r?.error || 'gate refused' };
    if (loadModes()[id] === 'off') saveMode(id, 'auto');
    return { ok: true, id };
  }
  await killService(svc);
  await new Promise(r => setTimeout(r, 400));
  const pid = spawnService(svc);
  saveMode(id, 'warm');
  return { ok: true, id, pid };
}

async function logs(id, lines = 120) {
  const svc = getSvc(id);
  if (!svc) return { ok: false, error: `unknown service ${id}` };
  const file = path.join(LOG_DIR, svc.logFile || `${svc.id}.log`);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const tail = raw.split('\n').slice(-Math.min(lines, 400)).join('\n');
    return { ok: true, file: svc.logFile, text: tail.slice(-65536) };
  } catch (_) {
    return { ok: true, file: svc.logFile, text: '' };
  }
}

async function ollamaModels() {
  const r = await getJson('http://127.0.0.1:11434/api/ps', 2000);
  const models = (r?.body?.models || []).map(m => ({
    name: m.name, sizeGb: Math.round((m.size || 0) / 1e9 * 100) / 100,
    expiresAt: m.expires_at || null,
  }));
  return { ok: true, models };
}

async function unloadModel(name) {
  const r = await postJson('http://127.0.0.1:11434/api/generate', { model: name, keep_alive: 0 }, 10000);
  return { ok: r !== null, name };
}

async function reportIssue(id, note = '') {
  const svc = getSvc(id);
  if (!svc) return { ok: false, error: `unknown service ${id}` };
  const tail = (await logs(id, 40)).text || '';
  try {
    const { recordIssue } = require('./issueReporter');
    return recordIssue({
      title: `${svc.label} — manual report`,
      summary: note || `Service issue reported from the Services panel (${svc.id}, port ${svc.port}).`,
      detail: {
        infra: { service: svc.id, signature: 'services-panel' },
        port: svc.port, tier: svc.tier,
        logs: tail.slice(-8000),
      },
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { list, setMode, restart, logs, ollamaModels, unloadModel, reportIssue };
