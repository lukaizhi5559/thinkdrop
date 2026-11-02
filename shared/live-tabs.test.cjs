'use strict';
/**
 * live-tabs.test.cjs — live video-tab resolution + video.agent/screen.capture
 * contract coverage (the "watch this video" fix).
 *
 * Run from repo root: node shared/live-tabs.test.cjs
 */

const LT = require('./live-tabs.cjs');
const { validatePlanSteps } = require('./skill-contracts.cjs');

let _passed = 0, _failed = 0;
const _failures = [];
function it(label, fn) {
  try { fn(); _passed++; console.log(`  ✅ ${label}`); }
  catch (e) { _failed++; _failures.push(label); console.log(`  ❌ ${label}\n     ${e.message}`); }
}
function section(l) { console.log(`\n${'─'.repeat(72)}\n  ${l}\n${'─'.repeat(72)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'mismatch'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// ── pickVideoTab binding order ──────────────────────────────────────────────
section('pickVideoTab');

it('playing tab on video host wins', () => {
  const s = LT.pickVideoTab([
    { sessionId: 'ext:default', url: 'https://github.com', playing: false },
    { sessionId: 'ext:yt', url: YT, playing: true },
  ]);
  eq(s.sessionId, 'ext:yt');
});

it('any playing tab beats idle video-host tab', () => {
  const s = LT.pickVideoTab([
    { sessionId: 'ext:a', url: YT, playing: false },
    { sessionId: 'ext:b', url: 'https://vimeo.com/12345', playing: true },
  ]);
  eq(s.sessionId, 'ext:b');
});

it('video-host session picked when nothing is playing', () => {
  const s = LT.pickVideoTab([
    { sessionId: 'ext:default', url: 'https://news.ycombinator.com', playing: false },
    { sessionId: 'ext:other', url: 'https://vimeo.com/999', playing: false },
  ]);
  eq(s.sessionId, 'ext:other');
});

it('ext:default picked only when its URL is a video host', () => {
  const s = LT.pickVideoTab([
    { sessionId: 'ext:default', url: YT, playing: false },
    { sessionId: 'ext:other', url: 'https://example.com', playing: false },
  ]);
  eq(s.sessionId, 'ext:default');
});

it('returns null when no video signal exists', () => {
  assert(LT.pickVideoTab([
    { sessionId: 'ext:default', url: 'https://github.com', playing: false },
  ]) === null, 'expected null for non-video tabs');
});

it('never picks ext:bg: extraction tabs', () => {
  const s = LT.pickVideoTab([
    { sessionId: 'ext:bg:video_extract', url: YT, playing: true },
  ]);
  assert(s === null, 'bg extraction tab must never be picked');
});

it('uses pageUrl when url absent', () => {
  const s = LT.pickVideoTab([
    { sessionId: 'ext:x', pageUrl: YT, playing: false },
  ]);
  eq(s.sessionId, 'ext:x');
});

// ── wantsLiveTab — skill-driven trigger, not prompt text ────────────────────
section('wantsLiveTab');

it('watch_video with no URL wants live resolution', () => {
  assert(LT.wantsLiveTab({ skill: 'video.agent', args: { action: 'watch_video' } }));
});
it('watch_live with no URL wants live resolution', () => {
  assert(LT.wantsLiveTab({ skill: 'video.agent', args: { action: 'watch_live' } }));
});
it('watch_from_page with no URL wants live resolution', () => {
  assert(LT.wantsLiveTab({ skill: 'video.agent', args: { action: 'watch_from_page' } }));
});
it('video.agent with no action defaults to watch_video → wants live', () => {
  assert(LT.wantsLiveTab({ skill: 'video.agent', args: {} }));
});
it('already-bound URL does NOT want live resolution', () => {
  assert(!LT.wantsLiveTab({ skill: 'video.agent', args: { action: 'watch_video', videoUrl: YT } }));
});
it('pageUrl-bound step does NOT want live resolution', () => {
  assert(!LT.wantsLiveTab({ skill: 'video.agent', args: { action: 'watch_from_page', pageUrl: YT } }));
});
it('find_and_watch NEVER binds a live tab', () => {
  assert(!LT.wantsLiveTab({ skill: 'video.agent', args: { action: 'find_and_watch', query: 'pasta' } }));
});
it('find_and_watch_tutorial NEVER binds a live tab', () => {
  assert(!LT.wantsLiveTab({ skill: 'video.agent', args: { action: 'find_and_watch_tutorial', query: 'pasta' } }));
});
it('non-video skills never want live resolution', () => {
  assert(!LT.wantsLiveTab({ skill: 'web.crawl', args: {} }));
  assert(!LT.wantsLiveTab({ skill: 'browser.act', args: { action: 'navigate' } }));
});

// ── contract validation ─────────────────────────────────────────────────────
section('validatePlanSteps — video.agent / screen.capture');

it('watch_video with no videoUrl passes strict validation', () => {
  const v = validatePlanSteps([{ skill: 'video.agent', args: { action: 'watch_video' } }], { strict: true });
  assert(v.ok, JSON.stringify(v.violations));
});

it('watch_live with only liveTab+sessionId passes strict validation', () => {
  const v = validatePlanSteps([{ skill: 'video.agent', args: { action: 'watch_live', liveTab: true, sessionId: 'ext:default' } }], { strict: true });
  assert(v.ok, JSON.stringify(v.violations));
});

it('watch_from_page with pageUrl passes', () => {
  const v = validatePlanSteps([{ skill: 'video.agent', args: { action: 'watch_from_page', pageUrl: YT } }], { strict: true });
  assert(v.ok, JSON.stringify(v.violations));
});

it('find_and_watch with query passes', () => {
  const v = validatePlanSteps([{ skill: 'video.agent', args: { action: 'find_and_watch', platform: 'youtube', query: 'pasta', goal: 'learn' } }], { strict: true });
  assert(v.ok, JSON.stringify(v.violations));
});

it('missing action is rejected', () => {
  const v = validatePlanSteps([{ skill: 'video.agent', args: { videoUrl: YT } }], { strict: true });
  assert(!v.ok, 'action should be required');
});

it('unknown args on video.agent are flagged', () => {
  const v = validatePlanSteps([{ skill: 'video.agent', args: { action: 'watch_video', bogus: 1 } }], { strict: true });
  assert(v.violations.some(x => x.field === 'bogus'), 'expected bogus-arg violation');
});

it('screen.capture validates — no longer unknown', () => {
  const v = validatePlanSteps([{ skill: 'screen.capture', args: {} }], { strict: true });
  assert(v.ok, JSON.stringify(v.violations));
});

it('screen.capture accepts timeoutMs', () => {
  const v = validatePlanSteps([{ skill: 'screen.capture', args: { timeoutMs: 5000 } }], { strict: true });
  assert(v.ok, JSON.stringify(v.violations));
});

// ── isBackgroundSession / isLiveWatchSession (the ext:bg:video_extract bug) ──
section('session sanitizers');

it('ext:bg:* ids are background', () => {
  assert(LT.isBackgroundSession('ext:bg:video_extract'));
  assert(LT.isBackgroundSession('ext:bg:nav_lane'));
});

it('engine extraction id is background', () => {
  assert(LT.isBackgroundSession('video_extract'));
  assert(LT.isBackgroundSession('ext:video_extract'));
});

it('ext:default and user ext:* ids are not background', () => {
  assert(!LT.isBackgroundSession('ext:default'));
  assert(!LT.isBackgroundSession('ext:yt'));
  assert(!LT.isBackgroundSession(null) && !LT.isBackgroundSession(undefined));
});

it('isLiveWatchSession accepts only ext:* non-bg', () => {
  assert(LT.isLiveWatchSession('ext:default'));
  assert(LT.isLiveWatchSession('ext:video_agent'));
  assert(!LT.isLiveWatchSession('ext:bg:video_extract'));
  assert(!LT.isLiveWatchSession('nylas.agent'));
  assert(!LT.isLiveWatchSession('video_extract'));
});

console.log(`\n${'─'.repeat(72)}\n  ${_passed} passed, ${_failed} failed${ _failures.length ? ' — ' + _failures.join(', ') : '' }\n`);
process.exit(_failed ? 1 : 0);
