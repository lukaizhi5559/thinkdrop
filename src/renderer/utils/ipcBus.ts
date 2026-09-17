/**
 * ipcBus — shared per-channel IPC dispatcher.
 *
 * Problem: every `window.electron.ipcRenderer.on(channel, fn)` call adds a real
 * listener to Electron's ipcRenderer EventEmitter, which warns at 11 listeners
 * per channel. Components mounted once per queue task (AutomationProgress) used
 * a unique preload token per instance, so N mounted cards = N real listeners
 * per channel — the preload's token dedup only guards same-token re-registration.
 *
 * Fix: one real ipcRenderer listener per channel for the window's lifetime that
 * fans out to per-token handlers held in a plain JS Map. Component mount/unmount
 * churn never touches the real emitter, so the per-channel listener count stays
 * at 1 no matter how many instances subscribe.
 *
 * The single underlying listener is intentionally never removed — it is bounded
 * at exactly one per channel and lives as long as the window.
 */

type IpcHandler = (data: any) => void;

const _handlers = new Map<string, Map<string, IpcHandler>>();
const _wired = new Set<string>();

function _ipcRenderer() {
  return (window as any).electron?.ipcRenderer;
}

export function ipcOn(channel: string, token: string, handler: IpcHandler): void {
  let chMap = _handlers.get(channel);
  if (!chMap) {
    chMap = new Map();
    _handlers.set(channel, chMap);
  }
  chMap.set(token, handler);
  if (_wired.has(channel)) return;
  const ipc = _ipcRenderer();
  if (!ipc?.on) return;
  _wired.add(channel);
  ipc.on(channel, (data: any) => {
    const subs = _handlers.get(channel);
    if (!subs) return;
    for (const fn of subs.values()) {
      try { fn(data); } catch (_) { /* one bad handler must not break fanout */ }
    }
  });
}

export function ipcOff(channel: string, token: string): void {
  _handlers.get(channel)?.delete(token);
}
