/**
 * perfCounters — dev-only render/IPC counters for diagnosing renderer churn.
 *
 * Enable either way:
 *   - localStorage.setItem('TD_PERF', '1') then reload, or
 *   - append ?tdperf=1 to the dev-server URL.
 *
 * Every 5s a `[TD_PERF] name:count ...` line logs the deltas and resets —
 * quiet periods log nothing. `perfRender('Name')` is called during render (not
 * a hook — safe to call unconditionally in the component body).
 * `perfGauge('key', n)` reports a point-in-time value (e.g. ipcBus handlers).
 */
import { ipcHandlerCount } from './ipcBus';

const _enabled = (() => {
  try {
    return typeof window !== 'undefined' &&
      (window.localStorage?.getItem('TD_PERF') === '1' ||
        /[?&]tdperf=1/.test(window.location?.search || ''));
  } catch {
    return false;
  }
})();

const _counts = new Map<string, number>();
const _gauges = new Map<string, () => number>();
let _timer: ReturnType<typeof setInterval> | null = null;

function _ensureTimer() {
  if (_timer) return;
  _timer = setInterval(() => {
    const parts: string[] = [];
    for (const [k, v] of _counts) {
      if (v > 0) parts.push(`${k}:${v}`);
    }
    _counts.clear();
    for (const [k, fn] of _gauges) {
      try { parts.push(`${k}=${fn()}`); } catch (_) { /* ignore */ }
    }
    if (parts.length > 0) console.log(`[TD_PERF] ${parts.join(' ')}`);
  }, 5000);
}

export function perfCount(name: string, by = 1): void {
  if (!_enabled) return;
  _counts.set(name, (_counts.get(name) || 0) + by);
  _ensureTimer();
}

/** Call once per render in a component body — counts renders per 5s window. */
export function perfRender(componentName: string): void {
  perfCount(`render.${componentName}`);
}

/** Register a live gauge (e.g. current ipcBus handler count for a channel). */
export function perfGauge(name: string, get: () => number): void {
  if (!_enabled) return;
  _gauges.set(name, get);
  _ensureTimer();
}

/** Convenience: register ipcBus channel handler-count gauges once. */
let _ipcGaugesRegistered = false;
export function perfGaugeIpcChannels(channels: string[]): void {
  if (!_enabled || _ipcGaugesRegistered) return;
  _ipcGaugesRegistered = true;
  for (const ch of channels) {
    perfGauge(`ipc.${ch}`, () => ipcHandlerCount(ch));
  }
}
