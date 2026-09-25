'use strict';
/**
 * check-services.cjs — Stage 0 preflight: health-check every service the
 * pipeline depends on, in dependency order, plus the ws:4000 LLM backend.
 * Exits non-zero if any required service is down.
 *
 *   node tests/e2e/check-services.cjs [--json]
 */
const http = require('http');

const SERVICES = [
  // name, port, path, required?
  ['user-memory',        3001, '/health', true],
  ['web-search',         3002, '/health', true],
  ['conversation',       3004, '/health', true],
  ['coreference',        3006, '/health', true],
  ['command-service',    3007, '/health', true],
  ['screen-intelligence',3008, '/health', true],
  ['phi4',               3009, '/health', true],
  ['personality',        3012, '/health', true],
  ['comms-graph',        3015, '/health', true],
  ['main-stub',          3010, '/health', true],
  ['backend-llm',        4000, '/health', true],
];

function ping(port, p, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method: 'GET', timeout: timeoutMs }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ up: res.statusCode < 500, ms: Date.now() - t0, status: res.statusCode, json });
      });
    });
    req.on('error', e => resolve({ up: false, ms: Date.now() - t0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false, ms: Date.now() - t0, error: `timeout ${timeoutMs}ms` }); });
    req.end();
  });
}

(async () => {
  const wantJson = process.argv.includes('--json');
  let fails = 0;
  const rows = [];
  for (const [name, port, path, required] of SERVICES) {
    const r = await ping(port, path);
    const ok = r.up;
    if (!ok && required) fails++;
    rows.push({ name, port, ok, ms: r.ms, status: r.status, error: r.error });
    if (!wantJson) {
      const mark = ok ? '✅' : required ? '❌' : '⚠️ ';
      console.log(`  ${mark} ${name.padEnd(20)} :${port}  ${ok ? `${r.ms}ms` : r.error || `HTTP ${r.status}`}`);
    }
  }
  if (wantJson) console.log(JSON.stringify(rows, null, 2));
  if (fails) { console.error(`\n✖ ${fails} required service(s) down`); process.exit(1); }
  if (!wantJson) console.log('\n  all required services healthy');
  process.exit(0);
})();
