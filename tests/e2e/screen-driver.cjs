#!/usr/bin/env node
/* screen-driver.cjs — GhostLayer ScreenStage E2E.
 *
 * Exercises the real "screen as an output" pipeline end-to-end: POST a
 * ScreenOutput to main's /screen/display (port 3010, same endpoint the
 * stategraph/skills/monitors use), then assert the rendered DOM inside the
 * live ghostlayer window over CDP.
 *
 * Requires the app running:  yarn dev  (electron with --remote-debugging-port=9222)
 *
 * Usage: NODE_PATH=$(npm root -g) node tests/e2e/screen-driver.cjs
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const OVERLAY = 'http://127.0.0.1:3010';
const CDP = 'http://127.0.0.1:9222';
const RESULTS_DIR = path.join(__dirname, 'results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function post(urlPath, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port: 3010, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 8000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(raw) }); } catch (_) { resolve({ status: res.statusCode, raw }); } });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

// DOM probes run inside the ghostlayer page
const probes = {
  hasText: (needle) => document.body.innerText.toLowerCase().includes(String(needle).toLowerCase()),
  hasCanvas: () => !!document.querySelector('canvas'),
  webgl: () => [...document.querySelectorAll('canvas')].some(c => {
    try { return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (_) { return false; }
  }),
  counter: () => (document.body.innerText.match(/(\d+)\s*\/\s*(\d+)/) || []).slice(1, 3).map(Number),
  scrollAnimating: () => [...document.querySelectorAll('div')].some(d => (d.getAnimations?.() || []).some(a => a.playState === 'running')),
  tag: (tag) => { const el = document.querySelector(tag); return el ? el.textContent : null; },
  blockingOverlay: () => [...document.querySelectorAll('div')].some(d => {
    const s = getComputedStyle(d);
    return (s.position === 'fixed' || s.position === 'absolute') && s.pointerEvents === 'auto'
      && d.offsetWidth >= innerWidth * 0.9 && d.offsetHeight >= innerHeight * 0.9;
  }),
  stageEmpty: () => ![...document.querySelectorAll('div')].some(d => {
    const s = getComputedStyle(d);
    return s.position === 'fixed' && parseInt(s.zIndex) === 99997 && d.children.length > 0;
  }),
  navClick: (side) => {
    const zones = [...document.querySelectorAll('div')].filter(d =>
      getComputedStyle(d).pointerEvents === 'auto' && (d.textContent === '›' || d.textContent === '‹'));
    const z = zones.find(d => side === 'right' ? d.textContent === '›' : d.textContent === '‹');
    if (z) { z.click(); return true; }
    return false;
  },
  clickDone: () => {
    const b = [...document.querySelectorAll('div')].find(d => d.textContent.trim().startsWith('Done'));
    if (b) { b.click(); return true; }
    return false;
  },
};

async function probe(page, name, arg) {
  try { return await page.evaluate(`(${probes[name].toString()})(${JSON.stringify(arg ?? '')})`); }
  catch (_) { return null; }
}

async function main() {
  const fixtureFile = process.argv[2] || path.join(__dirname, 'fixtures', 'screen-outputs.json');
  const fixtures = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));

  const browser = await chromium.connectOverCDP(CDP);
  let page = null;
  for (const c of browser.contexts()) {
    for (const p of c.pages()) {
      if (p.url().includes('mode=ghostlayer')) { page = p; break; }
    }
    if (page) break;
  }
  if (!page) { console.error('no ghostlayer page found on :9222 — is yarn dev running?'); process.exit(2); }
  console.log(`CDP attached — ghostlayer page: ${page.url()}`);

  const results = [];
  for (const fx of fixtures) {
    const t0 = Date.now();
    process.stdout.write(`  ${fx.id}  ${fx.desc ? `(${fx.desc.slice(0, 50)})` : ''} `);
    const out = { id: fx.id, pass: false, failures: [], ms: 0 };
    const ex = fx.expect || {};

    const r = await post('/screen/display', fx.payload);
    out.httpStatus = r.status;

    if (ex.httpStatus === 400) {
      if (r.status === 400 && r.json?.error) out.pass = true;
      else out.failures.push(`expected 400, got ${r.status}`);
      results.push(out); console.log(out.pass ? '✅' : '❌', `${Date.now() - t0}ms`);
      out.failures.forEach(f => console.log(`        ${f}`));
      continue;
    }
    if (r.status !== 200) { out.failures.push(`display POST → ${r.status} ${r.error || ''}`); }

    // wait for content to paint (chart lazy-loads antv; three lazy-loads three.js)
    const waitMs = (ex.canvas || ex.webgl) ? 9000 : 3000;
    await sleep((ex.canvas || ex.webgl) ? waitMs : 1200);

    if (ex.text != null && !(await probe(page, 'hasText', ex.text)))
      out.failures.push(`text "${String(ex.text).slice(0, 50)}" not in DOM`);
    if (ex.text2 != null && !(await probe(page, 'hasText', ex.text2)))
      out.failures.push(`text "${ex.text2}" not in DOM`);
    if (ex.canvas && !(await probe(page, 'hasCanvas')))
      out.failures.push('no <canvas> rendered');
    if (ex.webgl && !(await probe(page, 'webgl')))
      out.failures.push('no canvas with a live WebGL/WebGL2 context');
    if (ex.emoji && !(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(await page.evaluate(() => document.body.innerText))))
      out.failures.push('no emoji glyph rendered');
    if (ex.strong && (await probe(page, 'tag', 'strong')) !== ex.strong)
      out.failures.push(`<strong> not rendered ("${ex.strong}")`);
    if (ex.em && (await probe(page, 'tag', 'em')) !== ex.em)
      out.failures.push(`<em> not rendered ("${ex.em}")`);
    if (ex.scrolling && !(await probe(page, 'scrollAnimating')))
      out.failures.push('no running scroll animation on text');
    if (ex.blockingScrim && !(await probe(page, 'blockingOverlay')))
      out.failures.push('no blocking overlay element');

    if (ex.autoAdvance) {
      const c0 = await probe(page, 'counter');
      if (!c0 || c0[0] !== 1) out.failures.push(`counter expected 1/N, got ${JSON.stringify(c0)}`);
      else {
        let adv = null;
        for (let i = 0; i < 14 && !adv; i++) { await sleep(400); const c = await probe(page, 'counter'); if (c && c[0] >= 2) adv = c; }
        if (!adv) out.failures.push(`counter never advanced (still ${JSON.stringify(await probe(page, 'counter'))})`);
      }
    }
    if (ex.navRight) {
      if (!(await probe(page, 'navClick', 'right'))) out.failures.push('no right nav zone to click');
      else {
        await sleep(700);
        if (!(await probe(page, 'hasText', ex.navRight))) out.failures.push(`nav click did not reach "${ex.navRight}"`);
      }
    }

    if (ex.goneAfter) {
      await sleep(ex.goneAfter);
      if (!(await probe(page, 'stageEmpty'))) out.failures.push('stage not empty after auto-dismiss');
    } else {
      await post('/screen/clear', {});
      await sleep(1200);
      if (!(await probe(page, 'stageEmpty'))) out.failures.push('stage not empty after /screen/clear');
    }

    out.ms = Date.now() - t0;
    out.pass = out.failures.length === 0;
    results.push(out);
    console.log(`${out.pass ? '✅' : '❌'} ${out.ms}ms`);
    out.failures.forEach(f => console.log(`        ${f}`));
  }

  const passN = results.filter(r => r.pass).length;
  const outFile = path.join(RESULTS_DIR, 'screen-outputs.json');
  fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
  console.log(`\n${'─'.repeat(72)}\n  SUMMARY screen-outputs: ${passN}/${results.length} passed\n${'─'.repeat(72)}`);
  results.filter(r => !r.pass).forEach(r => console.log(`    ❌ ${r.id}: ${r.failures[0]}`));
  process.exit(results.length - passN ? 1 : 0);
}

main().catch(e => { console.error('driver failed:', e); process.exit(2); });
