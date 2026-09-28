'use strict';

/**
 * screen-output.cjs — Canonical contract for GhostLayer "screen output".
 *
 * The screen is an output surface of its own (separate from the UnifiedOverlay
 * panel). Any producer — the stategraph, command-service skills, the thought
 * engine, monitors — POSTs a ScreenOutput to main.js's overlay-control server
 * (`POST /screen/display` on OVERLAY_CONTROL_PORT, default 3010) and main
 * forwards it to the ghost window over `ghostlayer:display`.
 *
 * Schema-first: each `kind` renders through a deterministic component in the
 * renderer. `scene` is the lone generative escape hatch — LLM-produced
 * html/css/js that the renderer draws inside a sandboxed iframe, never raw
 * into the DOM.
 *
 * This module is the single source of truth for the wire shape. The renderer
 * mirrors it in `src/renderer/components/screen/types.ts` — keep them in sync.
 *
 * Lifecycle fields apply to every kind:
 *   durationMs — auto-dismiss after N ms (per-kind default when omitted; 0 = sticky)
 *   dismiss    — 'auto' | 'manual' (manual waits for /screen/clear)
 *   blocking   — lift click-through while displayed (alerts)
 *   priority   — stacking order; alerts > deck > text > effect, etc.
 *   position   — 'center' | 'top' | 'bottom' | 'banner' | 'fullscreen'
 *   scrim      — 'none' | 'dim' | 'blur' | 'black' | 'white'
 *   opacity    — scrim opacity (dim only)
 *   mood       — emotional tint; resolves accent + default animate + emoji
 *   animate    — animate.css names: 'fadeIn' or { in, idle, out }
 *   emoji      — accent emoji rendered alongside content (any kind)
 */

const KINDS = ['text', 'image', 'chart', 'effect', 'emoji', 'alert', 'deck', 'scene', 'three'];

const POSITIONS = ['center', 'top', 'bottom', 'banner', 'fullscreen'];
const SCRIMS = ['none', 'dim', 'blur', 'black', 'white'];
const MOODS = ['neutral', 'warm', 'happy', 'sad', 'alert', 'playful', 'calm'];
const SEVERITIES = ['info', 'warn', 'block'];
const EFFECTS = ['rain', 'snow', 'confetti', 'fireworks', 'emoji-rain'];
const CHART_TYPES = ['pie', 'donut', 'bar', 'line', 'area', 'stat'];
const FITS = ['contain', 'cover'];
const FONT_SIZES = ['md', 'lg', 'xl', 'hero'];
const TRANSITIONS = ['slide', 'fade', 'zoom'];
const DISMISS = ['auto', 'manual'];
// three kind: preset WebGL scenes rendered by ThreeScreen (bundled three.js).
// Deterministic presets — generative 3D stays behind the 'scene' escape hatch.
const THREE_SCENES = ['starfield', 'particles', 'wave', 'cube', 'knot', 'globe'];
// Vendor libraries a generated scene may request — served locally by
// /screen/vendor/<lib> so sandboxed scenes never fetch remote code.
const SCENE_LIBS = ['three'];

/**
 * Mood → visual defaults. `accent` tints borders/glows/accents in the renderer;
 * `emoji` is the default glyph when the payload omits one; `animate` supplies
 * entrance/idle/exit when the payload omits them. Speed names are animate.css
 * utility modifiers (slow/slower/fast/faster).
 */
const MOOD_MAP = {
  neutral: { accent: '#94a3b8', emoji: null,  animate: { in: 'fadeIn',      idle: null,         out: 'fadeOut' },      speed: null },
  warm:    { accent: '#fbbf24', emoji: '🙂', animate: { in: 'fadeIn',      idle: null,         out: 'fadeOut' },      speed: 'slow' },
  happy:   { accent: '#facc15', emoji: '😄', animate: { in: 'bounceIn',    idle: 'pulse',      out: 'fadeOut' },      speed: null },
  sad:     { accent: '#93c5fd', emoji: '💙', animate: { in: 'fadeIn',      idle: null,         out: 'fadeOut' },      speed: 'slower' },
  alert:   { accent: '#f87171', emoji: '⚠️', animate: { in: 'fadeIn',      idle: 'heartBeat',  out: 'fadeOut' },      speed: 'fast' },
  playful: { accent: '#f472b6', emoji: '😜', animate: { in: 'jackInTheBox', idle: 'wobble',     out: 'fadeOut' },      speed: null },
  calm:    { accent: '#34d399', emoji: '😌', animate: { in: 'fadeIn',      idle: null,         out: 'fadeOut' },      speed: 'slower' },
};

/** Per-kind defaults applied when the payload omits lifecycle fields. */
const KIND_DEFAULTS = {
  text:   { position: 'center',     scrim: 'dim',  durationMs: 12000, priority: 20, fontSize: 'xl' },
  image:  { position: 'center',     scrim: 'dim',  durationMs: 15000, priority: 30, fit: 'contain' },
  chart:  { position: 'center',     scrim: 'dim',  durationMs: 0,     priority: 30 },
  effect: { position: 'fullscreen', scrim: 'none', durationMs: 10000, priority: 10 },
  emoji:  { position: 'center',     scrim: 'none', durationMs: 6000,  priority: 15 },
  alert:  { position: 'fullscreen', scrim: 'black', durationMs: 0,    priority: 90, severity: 'warn' },
  deck:   { position: 'fullscreen', scrim: 'blur', durationMs: 0,     priority: 40 },
  scene:  { position: 'fullscreen', scrim: 'none', durationMs: 0,     priority: 50 },
  three:  { position: 'fullscreen', scrim: 'none', durationMs: 15000, priority: 15 },
};

/** Max accepted sizes — defensive clamps for a localhost trust boundary. */
const MAX_TEXT_LEN = 20000;
const MAX_TITLE_LEN = 500;
const MAX_DATAURL_BYTES = 15 * 1024 * 1024; // ~15MB
const MAX_SLIDES = 40;
const MAX_CHART_ROWS = 500;
const MAX_GENERATED_BYTES = 256 * 1024; // scene html/css/js each

let _seq = 0;
function _genId() { return `so_${Date.now().toString(36)}_${(++_seq).toString(36)}`; }

function _str(v, max) {
  if (typeof v !== 'string' || !v) return null;
  return v.slice(0, max);
}
function _num(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}
function _oneOf(v, list) {
  return list.includes(v) ? v : null;
}
function _animate(v) {
  if (typeof v === 'string') return v ? { in: v.slice(0, 60) } : null;
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of ['in', 'idle', 'out']) {
      if (typeof v[k] === 'string' && v[k]) out[k] = v[k].slice(0, 60);
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}
function _slide(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = {};
  if (raw.title) s.title = _str(raw.title, MAX_TITLE_LEN);
  if (raw.body) s.body = _str(raw.body, MAX_TEXT_LEN);
  if (Array.isArray(raw.bullets)) s.bullets = raw.bullets.slice(0, 20).map(b => _str(b, 1000)).filter(Boolean);
  if (raw.image) s.image = _str(raw.image, 2048);
  if (raw.chart && typeof raw.chart === 'object') s.chart = _chart(raw.chart);
  return Object.keys(s).length ? s : null;
}
function _chart(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c = {};
  c.type = _oneOf(raw.type, CHART_TYPES) || 'pie';
  c.data = Array.isArray(raw.data) ? raw.data.slice(0, MAX_CHART_ROWS) : [];
  if (raw.xKey) c.xKey = _str(raw.xKey, 100);
  if (raw.yKey) c.yKey = _str(raw.yKey, 100);
  if (raw.label) c.label = _str(raw.label, MAX_TITLE_LEN);
  return c;
}
function _scene(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const s = {};
  if (raw.name) s.name = _str(raw.name, 100);
  // Generated markup — rendered in a sandboxed iframe, never the parent DOM.
  // Strip external script/link loads so generated scenes stay self-contained.
  const stripRemote = (t) => String(t)
    .replace(/<script[^>]*\ssrc\s*=\s*["'][^"']*["'][^>]*>/gi, '')
    .replace(/<link[^>]*\shref\s*=\s*["'][^"']*["'][^>]*>/gi, '')
    .replace(/file:\/\//gi, '');
  if (raw.html) s.html = stripRemote(_str(raw.html, MAX_GENERATED_BYTES));
  if (raw.css) s.css = _str(raw.css, MAX_GENERATED_BYTES);
  if (raw.js) s.js = _str(raw.js, MAX_GENERATED_BYTES);
  // Vendor-lib allowlist — the renderer injects
  // <script src="/screen/vendor/<lib>"> tags locally; generated markup never
  // names remote sources (stripRemote above). 'three' is the only lib today.
  if (Array.isArray(raw.libs)) {
    const libs = raw.libs.map(l => _oneOf(l, SCENE_LIBS)).filter(Boolean).slice(0, 3);
    if (libs.length) s.libs = libs;
  }
  return Object.keys(s).length ? s : null;
}
function _three(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = {};
  t.scene = _oneOf(raw.scene, THREE_SCENES) || 'starfield';
  // Optional accent override (hex); renderer falls back to the mood accent.
  if (typeof raw.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(raw.color)) t.color = raw.color;
  t.speed = _num(raw.speed, 0, 2) ?? 1;
  // 0.1–1 particle/geometry density multiplier; default 0.5.
  t.density = _num(raw.density, 0.1, 1) ?? 0.5;
  if (raw.text) t.text = _str(raw.text, MAX_TITLE_LEN);
  return t;
}

/**
 * Normalize/validate a raw payload into a ScreenOutput.
 * Returns { ok: true, output } or { ok: false, error }.
 * Never throws on bad input — producers get a clean 400 instead of a crash.
 */
function normalizeScreenOutput(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'payload must be an object' };
  const kind = _oneOf(raw.kind, KINDS);
  if (!kind) return { ok: false, error: `kind must be one of: ${KINDS.join(', ')}` };

  const mood = _oneOf(raw.mood, MOODS) || 'neutral';
  const moodDef = MOOD_MAP[mood];
  const d = KIND_DEFAULTS[kind];

  const out = {
    id: _str(raw.id, 100) || _genId(),
    kind,
    mood,
    // Cross-cutting: mood supplies defaults the payload may override.
    emoji: _str(raw.emoji, 16) || moodDef.emoji,
    animate: _animate(raw.animate) || { ...moodDef.animate },
    animateSpeed: _oneOf(raw.animateSpeed, ['slow', 'slower', 'fast', 'faster']) || moodDef.speed,
    title: _str(raw.title, MAX_TITLE_LEN),
    position: _oneOf(raw.position, POSITIONS) || d.position,
    scrim: _oneOf(raw.scrim, SCRIMS) || d.scrim,
    opacity: _num(raw.opacity, 0, 1) ?? (d.scrim === 'dim' ? 0.45 : 0.6),
    durationMs: _num(raw.durationMs, 0, 10 * 60 * 1000) ?? d.durationMs,
    dismiss: _oneOf(raw.dismiss, DISMISS) || 'auto',
    blocking: raw.blocking === true,
    // interactive — capture pointer input only while the cursor is over the
    // item's content (wheel scroll, swipe nav). Unlike `blocking` it does NOT
    // capture the full window and carries no backdrop-dismiss semantics.
    interactive: raw.interactive === true,
    priority: _num(raw.priority, 0, 100) ?? d.priority,
    createdAt: Date.now(),
  };

  switch (kind) {
    case 'text': {
      out.text = _str(raw.text, MAX_TEXT_LEN);
      if (!out.text && !out.title) return { ok: false, error: 'text kind requires text or title' };
      out.fontSize = _oneOf(raw.fontSize, FONT_SIZES) || d.fontSize;
      // fit: 'auto' shrinks to fit then scrolls if still overflowing;
      // 'scroll' forces marquee-style auto-scroll for long passages.
      out.fit = _oneOf(raw.fit, ['auto', 'scroll']) || 'auto';
      break;
    }
    case 'image': {
      out.url = _str(raw.url, 2048);
      out.path = _str(raw.path, 2048);
      out.dataUrl = _str(raw.dataUrl, MAX_DATAURL_BYTES);
      out.caption = _str(raw.caption, MAX_TITLE_LEN);
      out.fit = _oneOf(raw.fit, FITS) || d.fit;
      if (!out.url && !out.path && !out.dataUrl) return { ok: false, error: 'image kind requires url, path, or dataUrl' };
      if (out.url && !/^https?:\/\//i.test(out.url)) return { ok: false, error: 'image url must be http(s) — use path for local files' };
      break;
    }
    case 'chart': {
      out.chart = _chart(raw.chart);
      if (!out.chart || !out.chart.data.length) return { ok: false, error: 'chart kind requires chart.data (non-empty array)' };
      break;
    }
    case 'effect': {
      out.effect = _oneOf(raw.effect, EFFECTS);
      if (!out.effect) return { ok: false, error: `effect kind requires effect: ${EFFECTS.join(', ')}` };
      // 0–1 particle density/speed multiplier; default 0.5.
      out.intensity = _num(raw.intensity, 0.05, 1) ?? 0.5;
      break;
    }
    case 'emoji': {
      if (!out.emoji) return { ok: false, error: 'emoji kind requires an emoji' };
      out.text = _str(raw.text, MAX_TEXT_LEN); // optional caption
      break;
    }
    case 'alert': {
      out.severity = _oneOf(raw.severity, SEVERITIES) || d.severity;
      out.text = _str(raw.text, MAX_TEXT_LEN);
      if (!out.text && !out.title) return { ok: false, error: 'alert kind requires text or title' };
      break;
    }
    case 'deck': {
      const rawDeck = raw.deck && typeof raw.deck === 'object' ? raw.deck : {};
      const slides = Array.isArray(rawDeck.slides) ? rawDeck.slides.map(_slide).filter(Boolean) : [];
      if (!slides.length) return { ok: false, error: 'deck kind requires deck.slides (non-empty)' };
      out.deck = {
        slides: slides.slice(0, MAX_SLIDES),
        transition: _oneOf(rawDeck.transition, TRANSITIONS) || 'fade',
        slideMs: _num(rawDeck.slideMs, 1000, 120000) ?? 5000,
        controls: rawDeck.controls === true,
      };
      break;
    }
    case 'scene': {
      out.scene = _scene(raw.scene);
      // js-only scenes are valid — the harness supplies the markup shell
      // (three.js scenes are typically a lone module script).
      if (!out.scene || (!out.scene.name && !out.scene.html && !out.scene.js)) {
        return { ok: false, error: 'scene kind requires scene.name (registered), scene.html, or scene.js (generated)' };
      }
      break;
    }
    case 'three': {
      out.three = _three(raw.three || {});
      if (!out.three) return { ok: false, error: `three kind requires three.scene: ${THREE_SCENES.join(', ')}` };
      break;
    }
  }

  return { ok: true, output: out };
}

module.exports = {
  normalizeScreenOutput,
  KINDS,
  POSITIONS,
  SCRIMS,
  MOODS,
  MOOD_MAP,
  SEVERITIES,
  EFFECTS,
  CHART_TYPES,
  THREE_SCENES,
  KIND_DEFAULTS,
};
