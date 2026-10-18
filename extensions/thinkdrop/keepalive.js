// keepalive.js — content script that holds a persistent port to the ThinkDrop
// service worker. A connected port is itself SW liveness: while any page has
// this script, Chrome keeps the worker alive, so ws.onclose fires instantly
// when the command service restarts (fast 1s reconnect instead of waiting on
// a deferred 30s alarm). When the SW dies, our retry connect() is itself a
// wake event — a dead worker gets woken by any open page with no user click.
(function () {
  if (window.top !== window) return; // one port per tab — skip iframes

  let port = null;
  let retryMs = 2000;
  const RETRY_MAX = 15000;

  function connect() {
    try {
      port = chrome.runtime.connect({ name: 'td-keepalive' });
    } catch (_) {
      schedule();
      return;
    }
    retryMs = 2000;
    port.onDisconnect.addListener(() => {
      port = null;
      schedule();
    });
  }

  function schedule() {
    setTimeout(connect, retryMs);
    retryMs = Math.min(RETRY_MAX, retryMs * 2);
  }

  connect();
})();
