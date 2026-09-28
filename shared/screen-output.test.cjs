'use strict';
/**
 * screen-output.test.cjs — normalizeScreenOutput contract coverage.
 *
 * Run from repo root: node shared/screen-output.test.cjs
 */

const { normalizeScreenOutput, KINDS, MOOD_MAP } = require('./screen-output.cjs');

let _passed = 0, _failed = 0;
const _failures = [];
function it(label, fn) {
  try { fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; _failures.push(label); console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function section(l) { console.log(`\n${'─'.repeat(72)}\n  ${l}\n${'─'.repeat(72)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }

// ── Envelope ─────────────────────────────────────────────────────────────────
section('envelope');

it('rejects non-object payloads', () => {
  assert(normalizeScreenOutput(null).ok === false);
  assert(normalizeScreenOutput('text').ok === false);
  assert(normalizeScreenOutput([]).ok === false);
});

it('rejects unknown kinds', () => {
  const r = normalizeScreenOutput({ kind: 'hologram' });
  assert(r.ok === false && /kind/.test(r.error));
});

it('accepts every declared kind shape', () => {
  for (const kind of KINDS) assert(typeof kind === 'string' && kind.length > 0);
});

it('auto-generates an id and stamps createdAt', () => {
  const r = normalizeScreenOutput({ kind: 'text', text: 'hi' });
  assert(r.ok && /^so_/.test(r.output.id) && r.output.createdAt > 0);
});

it('honors a producer-supplied id', () => {
  const r = normalizeScreenOutput({ id: 'thought-7', kind: 'text', text: 'hi' });
  assert(r.ok && r.output.id === 'thought-7');
});

// ── Lifecycle defaults ───────────────────────────────────────────────────────
section('lifecycle defaults');

it('text defaults: center / dim scrim / 12s / priority 20 / xl', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'text', text: 'hi' });
  assert(o.position === 'center' && o.scrim === 'dim' && o.durationMs === 12000
    && o.priority === 20 && o.fontSize === 'xl' && o.dismiss === 'auto' && o.blocking === false);
});

it('text fit field: scroll passes, unknown → auto, default auto', () => {
  assert(normalizeScreenOutput({ kind: 'text', text: 'hi', fit: 'scroll' }).output.fit === 'scroll');
  assert(normalizeScreenOutput({ kind: 'text', text: 'hi', fit: 'warp' }).output.fit === 'auto');
  assert(normalizeScreenOutput({ kind: 'text', text: 'hi' }).output.fit === 'auto');
});

it('effect defaults: fullscreen / no scrim / 10s / intensity 0.5', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'effect', effect: 'rain' });
  assert(o.position === 'fullscreen' && o.scrim === 'none' && o.durationMs === 10000 && o.intensity === 0.5);
});

it('effect intensity: clamps to 0.05–1', () => {
  assert(normalizeScreenOutput({ kind: 'effect', effect: 'snow', intensity: 5 }).output.intensity === 1);
  assert(normalizeScreenOutput({ kind: 'effect', effect: 'snow', intensity: 0 }).output.intensity === 0.05);
});

it('alert defaults: black scrim / sticky / highest priority', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'alert', text: 'halt' });
  assert(o.scrim === 'black' && o.durationMs === 0 && o.priority === 90 && o.severity === 'warn');
});

it('clamps durationMs and opacity into range', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'text', text: 'x', durationMs: 9e9, opacity: 7 });
  assert(o.durationMs === 600000 && o.opacity === 1);
});

it('blocking stays false unless explicitly true', () => {
  assert(normalizeScreenOutput({ kind: 'alert', text: 'x' }).output.blocking === false);
  assert(normalizeScreenOutput({ kind: 'alert', text: 'x', blocking: true }).output.blocking === true);
  assert(normalizeScreenOutput({ kind: 'alert', text: 'x', blocking: 'yes' }).output.blocking === false);
});

// ── Mood / emoji / animate ───────────────────────────────────────────────────
section('mood / emoji / animate');

it('mood supplies accent defaults: happy → bounceIn + pulse + 😄', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'text', text: 'x', mood: 'happy' });
  assert(o.mood === 'happy' && o.emoji === '😄'
    && o.animate.in === 'bounceIn' && o.animate.idle === 'pulse' && o.animate.out === 'fadeOut');
});

it('payload emoji overrides the mood default', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'text', text: 'x', mood: 'happy', emoji: '🚀' });
  assert(o.emoji === '🚀');
});

it('neutral mood yields no emoji', () => {
  assert(normalizeScreenOutput({ kind: 'text', text: 'x' }).output.emoji === null);
});

it('unknown mood falls back to neutral', () => {
  assert(normalizeScreenOutput({ kind: 'text', text: 'x', mood: 'ecstatic' }).output.mood === 'neutral');
});

it('animate accepts a string shorthand', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'text', text: 'x', animate: 'tada' });
  assert(o.animate.in === 'tada' && o.animate.idle === undefined);
});

it('animate accepts the {in,idle,out} object', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'text', text: 'x', animate: { in: 'fadeIn', idle: 'pulse', out: 'zoomOut' } });
  assert(o.animate.in === 'fadeIn' && o.animate.idle === 'pulse' && o.animate.out === 'zoomOut');
});

// ── Kind validation ──────────────────────────────────────────────────────────
section('per-kind validation');

it('text requires text or title', () => {
  assert(normalizeScreenOutput({ kind: 'text' }).ok === false);
  assert(normalizeScreenOutput({ kind: 'text', title: 'just a title' }).ok === true);
});

it('image requires a source; rejects non-http urls', () => {
  assert(normalizeScreenOutput({ kind: 'image' }).ok === false);
  assert(normalizeScreenOutput({ kind: 'image', url: 'file:///etc/passwd' }).ok === false);
  assert(normalizeScreenOutput({ kind: 'image', url: 'https://x.com/a.png' }).ok === true);
  assert(normalizeScreenOutput({ kind: 'image', path: '/Users/me/a.png' }).ok === true);
});

it('chart requires non-empty data and a known type', () => {
  assert(normalizeScreenOutput({ kind: 'chart' }).ok === false);
  assert(normalizeScreenOutput({ kind: 'chart', chart: { type: 'pie', data: [] } }).ok === false);
  const { output: o } = normalizeScreenOutput({ kind: 'chart', chart: { type: 'pie', data: [{ k: 'a', v: 1 }] } });
  assert(o.chart.type === 'pie' && o.chart.data.length === 1);
});

it('chart type defaults to pie when unknown', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'chart', chart: { type: 'hologram', data: [1] } });
  assert(o.chart.type === 'pie');
});

it('effect requires a known effect name', () => {
  assert(normalizeScreenOutput({ kind: 'effect' }).ok === false);
  assert(normalizeScreenOutput({ kind: 'effect', effect: 'plasma' }).ok === false);
  assert(normalizeScreenOutput({ kind: 'effect', effect: 'fireworks' }).ok === true);
});

it('emoji kind requires an emoji (or a mood default)', () => {
  assert(normalizeScreenOutput({ kind: 'emoji' }).ok === false);
  assert(normalizeScreenOutput({ kind: 'emoji', emoji: '🙂' }).ok === true);
  assert(normalizeScreenOutput({ kind: 'emoji', mood: 'warm' }).output.emoji === '🙂');
});

it('deck requires non-empty slides; slides are normalized', () => {
  assert(normalizeScreenOutput({ kind: 'deck', deck: { slides: [] } }).ok === false);
  const { output: o } = normalizeScreenOutput({
    kind: 'deck',
    deck: { slides: [{ title: 'One', bullets: ['a', 'b'] }, { nope: 1 }, 'junk', { body: 'two' }] },
  });
  assert(o.deck.slides.length === 2 && o.deck.transition === 'fade' && o.deck.slideMs === 5000);
});

it('scene requires a name or generated html', () => {
  assert(normalizeScreenOutput({ kind: 'scene' }).ok === false);
  assert(normalizeScreenOutput({ kind: 'scene', scene: { name: 'rain-3d' } }).ok === true);
  assert(normalizeScreenOutput({ kind: 'scene', scene: { html: '<div>hi</div>' } }).ok === true);
});

it('scene strips remote script/link loads and file:// refs', () => {
  const { output: o } = normalizeScreenOutput({
    kind: 'scene',
    scene: {
      html: '<div>x</div><script src="https://evil.example/x.js"></script><img src="file:///etc/hosts">',
      css: 'body{color:red}',
      js: 'console.log(1)',
    },
  });
  assert(!/script\s+src=/i.test(o.scene.html), 'remote script tag must be stripped');
  assert(!/file:\/\//i.test(o.scene.html), 'file:// refs must be stripped');
  assert(o.scene.js === 'console.log(1)');
});

it('scene accepts js-only payloads and normalizes the libs allowlist', () => {
  const { output: o } = normalizeScreenOutput({
    kind: 'scene', scene: { js: 'return { tick(t){} }', libs: ['three'] },
  });
  assert(o.scene.js.length > 0 && o.scene.libs[0] === 'three');
  // Unknown/missing libs drop out; non-array libs ignored.
  const { output: o2 } = normalizeScreenOutput({
    kind: 'scene', scene: { js: 'x=1', libs: ['three', 'evil-lib', 'three'] },
  });
  assert(o2.scene.libs.length === 2 && o2.scene.libs.every(l => l === 'three'));
  const { output: o3 } = normalizeScreenOutput({ kind: 'scene', scene: { js: 'x=1', libs: 'three' } });
  assert(o3.scene.libs === undefined);
});

it('three defaults to starfield when scene omitted or unknown', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'three' });
  assert(o.three.scene === 'starfield' && o.three.speed === 1 && o.three.density === 0.5);
  const { output: o2 } = normalizeScreenOutput({ kind: 'three', three: { scene: 'hologram' } });
  assert(o2.three.scene === 'starfield');
  assert(normalizeScreenOutput({ kind: 'three', three: { scene: 'knot' } }).ok === true);
});

it('three clamps speed/density and validates color', () => {
  const { output: o } = normalizeScreenOutput({
    kind: 'three', three: { scene: 'wave', speed: 99, density: 0, color: 'red', text: 'hi' },
  });
  assert(o.three.speed === 2 && o.three.density === 0.1);
  assert(o.three.color === undefined && o.three.text === 'hi');
  assert(normalizeScreenOutput({ kind: 'three', three: { color: '#a3f' } }).output.three.color === '#a3f');
});

// ── Safety clamps ────────────────────────────────────────────────────────────
section('safety clamps');

it('caps absurd text length', () => {
  const { output: o } = normalizeScreenOutput({ kind: 'text', text: 'x'.repeat(50000) });
  assert(o.text.length === 20000);
});

it('caps deck slide count', () => {
  const slides = Array.from({ length: 100 }, (_, i) => ({ title: `s${i}` }));
  const { output: o } = normalizeScreenOutput({ kind: 'deck', deck: { slides } });
  assert(o.deck.slides.length === 40);
});

// ── Interactive flag ─────────────────────────────────────────────────────────
section('interactive flag');

it('interactive defaults false, honors true, independent of blocking', () => {
  assert(normalizeScreenOutput({ kind: 'text', text: 'hi' }).output.interactive === false);
  assert(normalizeScreenOutput({ kind: 'text', text: 'hi', interactive: true }).output.interactive === true);
  const { output: o } = normalizeScreenOutput({ kind: 'deck', deck: { slides: [{ title: 'a' }] }, interactive: true });
  assert(o.interactive === true && o.blocking === false);
});

// ── inferScreenOutput routing vocabulary ────────────────────────────────────
section('inferScreenOutput');

it('tolerates doubled/dropped articles before "screen"', () => {
  const { SCREEN_OUTPUT_RE } = require('./text-patterns.cjs');
  assert(SCREEN_OUTPUT_RE.test('show a person running on the my screen'));
  assert(SCREEN_OUTPUT_RE.test('show hello on screen'));
  assert(SCREEN_OUTPUT_RE.test('display https://x.org/a.png on the my screen'));
});

it('no-kind concrete subjects default to image; abstract/data stay text', () => {
  const { inferScreenOutput } = require('./text-patterns.cjs');
  assert(inferScreenOutput('show a person running on the my screen').kind === 'image');
  assert(inferScreenOutput('show a person running on the my screen').content === 'person running');
  assert(inferScreenOutput('show me a summary of my day on the screen').kind === null);
  assert(inferScreenOutput('show me exodus 2 on my screen').kind === null);
  assert(inferScreenOutput('show a 3d starfield on my screen').kind === 'three');
});

it('scripture refs match SCRIPTURE_REF_RE', () => {
  const { SCRIPTURE_REF_RE } = require('./text-patterns.cjs');
  assert(SCRIPTURE_REF_RE.test('exodus 2') && SCRIPTURE_REF_RE.test('john 3:16') && SCRIPTURE_REF_RE.test('psalm 23'));
  assert(!SCRIPTURE_REF_RE.test('a person running') && !SCRIPTURE_REF_RE.test('chapter 2 of the report'));
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(72)}`);
console.log(`  ${_passed} passed, ${_failed} failed`);
if (_failures.length) _failures.forEach(f => console.log(`   - ${f}`));
console.log('═'.repeat(72));
process.exit(_failed ? 1 : 0);
