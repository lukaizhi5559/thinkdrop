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
  // image kind — img element that actually loaded (naturalWidth>0 catches
  // broken hotlinks that still leave an <img> in the DOM)
  hasImg: () => [...document.querySelectorAll('img')].some(i => i.complete && i.naturalWidth > 0),
  imgCount: () => [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth > 0).length,
  // scene kind — sandboxed iframe + render heartbeat (the canvas inside the
  // opaque iframe is unreachable; the frame posts 'td-scene-rendered' which
  // SceneScreen records as data-scene-status on its wrapper)
  sceneIframe: () => [...document.querySelectorAll('iframe')].some(f => (f.getAttribute('sandbox') || '').includes('allow-scripts')),
  sceneStatus: () => document.querySelector('[data-scene-status]')?.getAttribute('data-scene-status') || null,
  // Wheel/swipe input — dispatch a wheel event on the topmost element at the
  // viewport center so it bubbles through the deck/text handlers like a real
  // trackpad event. (JS dispatch can't prove OS-level capture, but it does
  // exercise the handler + nav logic end to end.)
  dispatchWheel: (arg) => {
    const { dx, dy } = typeof arg === 'string' ? JSON.parse(arg) : (arg || {});
    const els = document.elementsFromPoint(innerWidth / 2, innerHeight / 2);
    if (!els.length) return false;
    // Dispatch down the whole hit-test stack — elementFromPoint can land on a
    // sibling overlay div above the deck/text card, in which case the event
    // never enters the card's subtree. Dispatching on every element at the
    // point mirrors what a real event does (and the deck debounces repeats).
    for (const el of els) {
      el.dispatchEvent(new WheelEvent('wheel', { deltaX: dx || 0, deltaY: dy || 0, bubbles: true, cancelable: true }));
    }
    return els.length;
  },
  // Manual-scroll offset on a scrolling text card — the text div's computed
  // translateY (negative while scrolling; |v| = px offset)
  textScrollOffset: () => {
    const el = [...document.querySelectorAll('div')].find(d => (d.style.whiteSpace || '') === 'pre-wrap');
    if (!el) return null;
    const t = getComputedStyle(el).transform;
    return t && t !== 'none' ? Math.abs(new DOMMatrixReadOnly(t).m42) : 0;
  },
  // ESC affordance — the per-display chip (data-esc-badge carries the id)
  escBadge: () => !!document.querySelector('[data-esc-badge]'),
  escBadgeClick: () => {
    const b = document.querySelector('[data-esc-badge]');
    if (!b) return false;
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  },
  // Arrow-key nav — main turns global keys into ghostlayer:display-nav →
  // ScreenStage re-dispatches these DOM events. Dispatch directly to
  // exercise the component handlers end-to-end below the shortcut layer.
  domNav: (arg) => {
    const dir = typeof arg === 'string' ? arg : '';
    if (dir === 'up' || dir === 'down') {
      window.dispatchEvent(new CustomEvent('screen:text-scroll', { detail: { dir } }));
    } else {
      window.dispatchEvent(new CustomEvent('screen:deck-nav', { detail: { dir: dir === 'left' ? 'prev' : 'next' } }));
    }
    return true;
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

    // Auto-advance decks can flip past slide 1 during the paint wait — read
    // the counter first (300ms settle), then take the generic wait.
    let c0 = null;
    let earlyTextOk = false;
    if (ex.autoAdvance) {
      await sleep(300);
      c0 = await probe(page, 'counter');
      earlyTextOk = ex.text == null || (await probe(page, 'hasText', ex.text));
    }

    // wait for content to paint (chart lazy-loads antv; three lazy-loads three.js)
    const waitMs = (ex.canvas || ex.webgl || ex.sceneRendered) ? 9000 : 3000;
    await sleep((ex.canvas || ex.webgl || ex.sceneRendered) ? waitMs : 1200);

    if (ex.text != null && !(earlyTextOk || (await probe(page, 'hasText', ex.text))))
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
    if (ex.img && !(await probe(page, 'hasImg')))
      out.failures.push('no loaded <img> rendered (naturalWidth=0 or absent)');
    if (ex.minImgs && (await probe(page, 'imgCount')) < ex.minImgs)
      out.failures.push(`expected ≥${ex.minImgs} loaded imgs, got ${await probe(page, 'imgCount')}`);
    if (ex.sceneIframe && !(await probe(page, 'sceneIframe')))
      out.failures.push('no sandboxed scene iframe rendered');
    if (ex.sceneRendered) {
      let st = null;
      for (let i = 0; i < 20 && st !== 'rendered'; i++) { await sleep(700); st = await probe(page, 'sceneStatus'); }
      if (st !== 'rendered') out.failures.push(`scene never reported rendered (status=${st})`);
    }

    if (ex.autoAdvance) {
      if (c0 == null) c0 = await probe(page, 'counter');
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
    // Trackpad swipe → slide nav (controls deck, deltaX)
    if (ex.swipe) {
      const before = await probe(page, 'counter');
      if (!(await probe(page, 'dispatchWheel', { dx: ex.swipe, dy: 0 }))) {
        out.failures.push('no element at viewport center for wheel dispatch');
      } else {
        await sleep(800);
        const after = await probe(page, 'counter');
        const dir = ex.swipe > 0 ? 1 : -1;
        if (!after || !before || after[0] !== before[0] + dir) {
          out.failures.push(`swipe dx=${ex.swipe} did not move counter (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
        }
      }
    }
    // Trackpad scroll → manual text offset (scrolling text card, deltaY)
    if (ex.textWheel) {
      const before = await probe(page, 'textScrollOffset');
      if (!(await probe(page, 'dispatchWheel', { dx: 0, dy: 400 }))) {
        out.failures.push('no element at viewport center for wheel dispatch');
      } else {
        await sleep(600);
        const after = await probe(page, 'textScrollOffset');
        if (after == null || after <= (before || 0) + 10) {
          out.failures.push(`wheel scroll did not move text offset (${before} → ${after})`);
        }
      }
    }
    // Arrow-key scroll → same manual path via the DOM nav event
    if (ex.arrowText) {
      const before = await probe(page, 'textScrollOffset');
      await probe(page, 'domNav', 'down');
      await sleep(400);
      const after = await probe(page, 'textScrollOffset');
      if (after == null || after <= (before || 0) + 10) {
        out.failures.push(`Down arrow did not move text offset (${before} → ${after})`);
      }
    }
    // Arrow-key slide nav via the DOM nav event
    if (ex.arrowDeck) {
      const before = await probe(page, 'counter');
      await probe(page, 'domNav', 'right');
      await sleep(700);
      const after = await probe(page, 'counter');
      if (!after || !before || after[0] !== before[0] + 1) {
        out.failures.push(`Right arrow did not move counter (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
      }
    }
    // ESC badge — every display carries the exit chip; optionally click it
    if (ex.escBadge && !(await probe(page, 'escBadge'))) {
      out.failures.push('no ESC badge rendered');
    }
    if (ex.escBadgeClick) {
      if (!(await probe(page, 'escBadgeClick'))) out.failures.push('no ESC badge to click');
      else {
        await sleep(1500);
        if (!(await probe(page, 'stageEmpty'))) out.failures.push('ESC badge click did not clear the display');
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
