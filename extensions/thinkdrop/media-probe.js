// media-probe.js — content script reporting media playback state to the
// ThinkDrop service worker. Watches navigator.mediaSession.playbackState plus
// real <video>/<audio> element play/pause/ended events (playbackState alone is
// unreliable — many players never register a media session). State is relayed
// only on CHANGE so the WS stays quiet on ordinary pages.
(function () {
  if (window.top !== window) return; // top frame only — iframe players share state anyway

  let lastState = null;
  let lastSent = 0;
  let pollTimer = null;

  function mediaElements() {
    try { return Array.from(document.querySelectorAll('video, audio')); } catch (_) { return []; }
  }

  function computeState() {
    const els = mediaElements();
    const playing = els.some(el => !el.paused && !el.ended && el.readyState > 1);
    const sess = (navigator.mediaSession && navigator.mediaSession.playbackState) || 'none';
    if (playing || sess === 'playing') return 'playing';
    if (els.some(el => !el.ended && el.currentTime > 0) || sess === 'paused') return 'paused';
    return els.length ? 'idle' : 'none';
  }

  function mediaTitle() {
    try {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      return (md && md.title) || document.title || null;
    } catch (_) { return document.title || null; }
  }

  function report(force) {
    const state = computeState();
    const now = Date.now();
    // Heartbeat re-report — a video playing since before a service restart
    // never fires a change event, so resend every ~25s while media is present.
    if (!force && state === lastState && (now - lastSent < 20000 || state === 'none')) return;
    lastState = state;
    lastSent = now;
    try {
      chrome.runtime.sendMessage({
        type: 'media.playing',
        url: location.href,
        title: document.title,
        mediaTitle: mediaTitle(),
        state,
      });
    } catch (_) { /* SW waking — next poll retries */ }
  }

  // Element events cover transitions promptly; the 3s poll covers players that
  // swap elements or only update mediaSession (plus initial page state).
  const EVENTS = ['play', 'pause', 'ended', 'emptied'];
  const observer = new MutationObserver(() => {
    for (const el of mediaElements()) {
      if (el.__tdProbe) continue;
      el.__tdProbe = true;
      EVENTS.forEach(ev => el.addEventListener(ev, () => report(), { passive: true }));
    }
    report();
  });

  function start() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    pollTimer = setInterval(() => report(), 3000);
    report(true);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
