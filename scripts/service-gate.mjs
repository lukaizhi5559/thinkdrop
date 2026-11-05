#!/usr/bin/env node
// service-gate.mjs — demand-spawn supervisor for ThinkDrop's coldable services.
//
// Owns each coldable service's PUBLIC port (shared/service-registry.cjs),
// spawns the real service on an internal port (public + 20000) on first
// non-health connection, proxies bytes, and SIGTERMs it after IDLE_MS idle.
//
// Modes (persisted ~/.thinkdrop/service-modes.json, toggled via :3030 admin):
//   auto — cold until first request, idle-reaped (default)
//   warm — spawned + pinned, never idle-reaped
//   off  — synthetic 503 {gate:'off'}; callers fail fast honestly
//
// Admin API (127.0.0.1:3030):
//   GET  /gate.status          → per-service {mode, state, pid, lastReq, reqs}
//   POST /gate.mode {id,mode}  → auto|warm|off
//
// Env: SERVICE_IDLE_MS (default 15min), SERVICE_GATE=1 marker for children.
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { coldable } = require('../shared/service-registry.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'logs');
const IDLE_MS = parseInt(process.env.SERVICE_IDLE_MS || '900000', 10);
const INTERNAL_BASE = 20000;
const ADMIN_PORT = parseInt(process.env.SERVICE_GATE_ADMIN_PORT || '3030', 10);
const MODES_FILE = process.env.THINKDROP_SERVICE_MODES
  || path.join(os.homedir(), '.thinkdrop', 'service-modes.json');

const SERVICES = coldable();

const state = new Map(); // port → {proc, lastReq, spawning, mode, reqs, spawnedAt}
const log = (msg) => {
  const line = `[service-gate] ${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(path.join(LOG_DIR, 'service-gate.log'), line);
};

// ── Mode persistence ────────────────────────────────────────────────────────
function loadModes() {
  try { return JSON.parse(fs.readFileSync(MODES_FILE, 'utf8')) || {}; }
  catch (_) { return {}; }
}
function persistModes() {
  try {
    const modes = loadModes();
    for (const svc of SERVICES) modes[svc.id] = state.get(svc.port).mode;
    fs.mkdirSync(path.dirname(MODES_FILE), { recursive: true });
    fs.writeFileSync(MODES_FILE, JSON.stringify(modes, null, 2));
  } catch (e) { log(`modes persist failed: ${e.message}`); }
}

function _cmdFor(svc) {
  // Absolute-in-service-dir cmd (venv/bin/python) if it exists, else altCmd.
  if (svc.cmd.includes('/')) {
    const p = path.join(ROOT, svc.dir, svc.cmd);
    if (fs.existsSync(p)) return svc.cmd;
    return svc.altCmd || 'python3';
  }
  return svc.cmd;
}

function spawnBackend(svc) {
  const st = state.get(svc.port);
  if (st.spawning) return st.spawning;
  const internal = svc.port + INTERNAL_BASE;
  const out = fs.openSync(path.join(LOG_DIR, `${svc.id}.log`), 'a');
  const env = {
    ...process.env,
    PORT: String(internal),
    SERVICE_GATE: '1',
    ...(svc.heap ? { NODE_OPTIONS: `--max-old-space-size=${svc.heap}` } : {}),
    ...Object.fromEntries(Object.entries(svc.env || {}).map(([k, v]) => [k, path.isAbsolute(v) ? v : path.join(ROOT, v)])),
  };
  log(`${svc.id}: spawning (internal :${internal})`);
  const proc = spawn(_cmdFor(svc), [svc.entry], {
    cwd: path.join(ROOT, svc.dir), env, stdio: ['ignore', out, out],
  });
  fs.closeSync(out);
  st.spawnedAt = Date.now();
  const ready = new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = () => {
      if (!proc.exitCode && proc.pid) {
        const t = net.connect(internal, '127.0.0.1');
        t.once('connect', () => { t.destroy(); resolve(proc); });
        t.once('error', () => { t.destroy(); Date.now() < deadline ? setTimeout(poll, 150) : reject(new Error('listen timeout')); });
      } else reject(new Error(`exited code ${proc.exitCode}`));
    };
    poll();
  });
  proc.on('exit', (code) => {
    if (state.get(svc.port)?.proc === proc) {
      const s = state.get(svc.port);
      s.proc = null; s.spawning = null; s.spawnedAt = 0;
    }
    log(`${svc.id}: exited (code ${code}) → cold`);
  });
  st.proc = proc;
  st.spawning = ready.then(r => { st.spawning = null; return r; })
                    .catch(e => { st.spawning = null; st.proc = null; throw e; });
  return st.spawning;
}

function ensureBackend(svc) {
  const st = state.get(svc.port);
  if (st.proc && !st.proc.killed) return Promise.resolve(st.proc);
  return spawnBackend(svc);
}

function stopBackend(svc, why) {
  const st = state.get(svc.port);
  if (st.proc && !st.proc.killed) {
    log(`${svc.id}: SIGTERM (${why})`);
    try { st.proc.kill('SIGTERM'); } catch (_) {}
  }
}

// Paths that look like health/liveness probes — the gate answers them
// directly so periodic pollers don't keep every coldable permanently warm.
const HEALTH_PATH_RE = /^(GET|HEAD) \/(health|service\.health|status|ping)\b/i;

function syntheticReply(client, svc, kind) {
  const off = kind === 'off';
  const body = JSON.stringify(off
    ? { status: 'off', gate: 'off', service: svc.id, version: 'mcp.v1' }
    : { status: 'up', gate: 'cold', service: svc.id, version: 'mcp.v1' });
  client.end(
    `HTTP/1.1 ${off ? 503 : 200} ${off ? 'Service Unavailable' : 'OK'}\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n` + body
  );
}

const savedModes = loadModes();
for (const svc of SERVICES) {
  const mode = ['auto', 'warm', 'off'].includes(savedModes[svc.id]) ? savedModes[svc.id] : 'auto';
  state.set(svc.port, { proc: null, lastReq: 0, spawning: null, mode, reqs: 0, spawnedAt: 0 });
  const internal = svc.port + INTERNAL_BASE;
  net.createServer((client) => {
    const st = state.get(svc.port);
    client.once('data', (first) => {
      const head = first.slice(0, 64).toString('latin1');
      if (st.mode === 'off') { syntheticReply(client, svc, 'off'); return; }
      if (HEALTH_PATH_RE.test(head)) { syntheticReply(client, svc, 'cold'); return; }
      st.lastReq = Date.now(); st.reqs++;
      ensureBackend(svc).then(() => {
        const back = net.connect(internal, '127.0.0.1');
        back.once('connect', () => {
          back.write(first);
          client.pipe(back); back.pipe(client);
        });
        back.on('error', () => client.destroy());
        client.on('error', () => back.destroy());
      }).catch((e) => {
        log(`${svc.id}: spawn failed — ${e.message}`);
        client.destroy();
      });
    });
    client.setTimeout(30000, () => client.destroy());
  }).listen(svc.port, '127.0.0.1', () => log(`gate listening :${svc.port} → ${svc.id} (${mode})`))
    .on('error', (e) => log(`gate :${svc.port} FAILED to bind — ${e.message} (is ${svc.id} already running warm?)`));
}

// Warm-pinned services spawn at boot so they're up before the first request.
for (const svc of SERVICES) {
  if (state.get(svc.port).mode === 'warm') ensureBackend(svc).catch(e => log(`${svc.id}: warm-boot spawn failed — ${e.message}`));
}

// Idle reaper — only 'auto' services with zero requests for IDLE_MS go cold.
setInterval(() => {
  const now = Date.now();
  for (const svc of SERVICES) {
    const st = state.get(svc.port);
    if (st.mode === 'auto' && st.proc && !st.spawning && now - st.lastReq > IDLE_MS) {
      stopBackend(svc, `idle ${Math.round((now - st.lastReq) / 60000)}m`);
    }
  }
}, 30000).unref();

// ── Admin API on :3030 ─────────────────────────────────────────────────────
const admin = http.createServer((req, res) => {
  const send = (code, obj) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) });
    res.end(b);
  };
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/gate.status') {
    const out = {};
    for (const svc of SERVICES) {
      const st = state.get(svc.port);
      out[svc.id] = {
        port: svc.port,
        mode: st.mode,
        state: st.mode === 'off' ? 'off' : (st.proc && !st.proc.killed ? 'warm' : (st.spawning ? 'spawning' : 'cold')),
        pid: st.proc?.pid || null,
        spawnedAt: st.spawnedAt || null,
        lastReq: st.lastReq || null,
        reqs: st.reqs,
      };
    }
    return send(200, { status: 'ok', services: out });
  }
  if (req.method === 'POST' && url.pathname === '/gate.mode') {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      try {
        const { id, mode } = JSON.parse(raw || '{}');
        const svc = SERVICES.find(s => s.id === id);
        if (!svc) return send(404, { status: 'error', error: `unknown service ${id}` });
        if (!['auto', 'warm', 'off'].includes(mode)) return send(400, { status: 'error', error: 'mode must be auto|warm|off' });
        const st = state.get(svc.port);
        st.mode = mode;
        if (mode === 'off') stopBackend(svc, 'mode→off');
        if (mode === 'warm') ensureBackend(svc).catch(e => log(`${svc.id}: warm spawn failed — ${e.message}`));
        if (mode === 'auto') st.lastReq = Date.now(); // fresh idle window
        persistModes();
        log(`${svc.id}: mode → ${mode}`);
        return send(200, { status: 'ok', id, mode });
      } catch (e) { return send(400, { status: 'error', error: e.message }); }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/gate.restart') {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(raw || '{}');
        const svc = SERVICES.find(s => s.id === id);
        if (!svc) return send(404, { status: 'error', error: `unknown service ${id}` });
        const st = state.get(svc.port);
        if (st.mode === 'off') return send(409, { status: 'error', error: 'service is off — set a mode first' });
        stopBackend(svc, 'restart');
        const restarted = ensureBackend(svc);
        st.lastReq = Date.now();
        restarted.then(() => log(`${svc.id}: restarted`), e => log(`${svc.id}: restart spawn failed — ${e.message}`));
        return send(200, { status: 'ok', id });
      } catch (e) { return send(400, { status: 'error', error: e.message }); }
    });
    return;
  }
  send(404, { status: 'error', error: 'not found' });
});
admin.listen(ADMIN_PORT, '127.0.0.1', () => log(`admin api :${ADMIN_PORT} (/gate.status /gate.mode)`));
admin.on('error', (e) => log(`admin :${ADMIN_PORT} FAILED — ${e.message}`));

function shutdown() {
  for (const svc of SERVICES) { const st = state.get(svc.port); try { st.proc?.kill('SIGTERM'); } catch (_) {} }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
log(`service-gate up — ${SERVICES.length} coldable ports, idle=${IDLE_MS / 60000}m`);
