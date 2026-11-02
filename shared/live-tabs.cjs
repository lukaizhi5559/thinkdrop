// shared/live-tabs.cjs — live video-tab resolution.
//
// Single definition of "which open tab is the video the user means", used by
// comms-graph (compile-time arg bake) and stategraph (runtime plan guard).
// Resolution is skill-driven: callers apply it only to video.agent steps that
// need a live tab — it never reads prompt text.
//
// Binding order (media signals first — a paused tab on a video host still
// counts, but a playing tab anywhere beats a video-host guess):
//   1. Tab flagged `playing` by the extension media probe on a video host
//   2. Any `playing` tab
//   3. A session on a known video host
//   4. ext:default only when its own URL is a video host
// ext:bg:* extraction tabs are never picked — they're ours, not the user's.

'use strict';

const VIDEO_HOST_RX = /(?:youtube\.com|youtu\.be|vimeo\.com|rumble\.com|tiktok\.com|dailymotion\.com|twitch\.tv|facebook\.com\/(?:watch|.*\/videos)|netflix\.com|hulu\.com|disneyplus\.com)/i;

const isVideoHost = (u) => VIDEO_HOST_RX.test(String(u || ''));

const tabUrl = (s) => String((s && (s.url || s.pageUrl)) || '');

/**
 * Is this sessionId a background/extraction lane, never a live user tab?
 * `ext:bg:*` tabs are our background workers; the engine-side extraction
 * session is named `video_extract`. A planner that emits one of these as a
 * watch target must be corrected — stripping it lets resolution re-pick.
 */
function isBackgroundSession(sessionId) {
  const s = String(sessionId || '');
  return s.startsWith('ext:bg:') || s === 'video_extract' || s === 'ext:video_extract';
}

/** SessionId usable as a live-watch target: ext:* and not a bg lane. */
function isLiveWatchSession(sessionId) {
  const s = String(sessionId || '');
  return s.startsWith('ext:') && !isBackgroundSession(s);
}

/** video.agent actions that may bind a live tab when the URL is absent. */
const LIVE_VIDEO_ACTIONS = new Set(['watch_video', 'watch_from_page', 'watch_live']);

/**
 * Does this video.agent step want live-tab resolution?
 * find_and_watch / query-based discovery is deliberately excluded — a "find
 * me a video" request must not bind whatever tab happens to be open.
 */
function wantsLiveTab(step) {
  if (!step || step.skill !== 'video.agent') return false;
  const action = (step.args && step.args.action) || 'watch_video';
  if (!LIVE_VIDEO_ACTIONS.has(action)) return false;
  const a = step.args || {};
  return !(a.videoUrl || a.pageUrl);
}

/**
 * Pick the live video tab from extension sessions.
 * @param {Array} sessions — decorated ext sessions ({sessionId,url,playing,title})
 * @returns {{sessionId:string,url:string,title:string}|null}
 */
function pickVideoTab(sessions) {
  const usable = (sessions || []).filter(
    s => s && s.sessionId && !String(s.sessionId).startsWith('ext:bg:')
  );
  const pick = usable.find(s => s.playing && isVideoHost(tabUrl(s)))
    || usable.find(s => s.playing)
    || usable.find(s => isVideoHost(tabUrl(s)))
    || usable.find(s => s.sessionId === 'ext:default' && isVideoHost(tabUrl(s)))
    || null;
  if (!pick) return null;
  return { sessionId: pick.sessionId, url: tabUrl(pick) || null, title: pick.title || null };
}

/**
 * Compact planner-facing description of open tabs ("[LIVE TABS ...]") so the
 * stepgen sees real URLs instead of inventing them.
 */
function liveTabsContext(sessions, maxTabs = 8) {
  if (!sessions || !sessions.length) return null;
  const lines = sessions.slice(0, maxTabs).map(s => {
    const u = tabUrl(s).slice(0, 140);
    if (!u) return null;
    return `- ${s.sessionId}${s.playing ? ' [PLAYING]' : ''}: ${u}${s.title ? ` — "${String(s.title).slice(0, 80)}"` : ''}`;
  }).filter(Boolean);
  return lines.length ? `[LIVE TABS — browser extension sessions the user has open]\n${lines.join('\n')}` : null;
}

module.exports = { VIDEO_HOST_RX, isVideoHost, tabUrl, LIVE_VIDEO_ACTIONS, wantsLiveTab, pickVideoTab, liveTabsContext, isBackgroundSession, isLiveWatchSession };
