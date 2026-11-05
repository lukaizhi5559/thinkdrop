/**
 * ServiceOffBanner — slim persistent notice when ThinkDrop services are off.
 *
 * The Services panel controls service modes, but a user shouldn't have to
 * open it to discover why search stopped working. Polls services:list lightly
 * (30s, quiet) and renders a one-line banner when anything is 'off' — or a
 * warm/protected service is unexpectedly down. Click → Services tab.
 */
import { useEffect, useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;
const POLL_MS = 30000;

export function ServiceOffBanner({ onOpen }: { onOpen: () => void }) {
  const [offCount, setOffCount] = useState(0);
  const [downCount, setDownCount] = useState(0);

  useEffect(() => {
    let live = true;
    const check = async () => {
      try {
        const res = await ipcRenderer?.invoke?.('services:list');
        if (!live || !Array.isArray(res?.services)) return;
        const off = res.services.filter((s: any) => s.mode === 'off' || s.state === 'off').length;
        const down = res.services.filter((s: any) =>
          (s.tier === 'warm' || s.tier === 'protected') && s.mode !== 'off' && s.state !== 'off' && !s.healthy
        ).length;
        setOffCount(off);
        setDownCount(down);
      } catch { /* overlay IPC not ready — skip */ }
    };
    check();
    const t = setInterval(check, POLL_MS);
    return () => { live = false; clearInterval(t); };
  }, []);

  if (offCount + downCount === 0) return null;
  const parts = [];
  if (offCount) parts.push(`${offCount} off`);
  if (downCount) parts.push(`${downCount} down`);

  return (
    <button
      onClick={onOpen}
      style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 12px', border: 'none', cursor: 'pointer', textAlign: 'left',
        backgroundColor: 'rgba(245,158,11,0.1)',
        borderBottom: '1px solid rgba(245,158,11,0.25)',
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: '#fbbf24', flexShrink: 0 }} />
      <span style={{ color: '#fbbf24', fontSize: '0.64rem', fontWeight: 600, flex: 1 }}>
        {parts.join(' · ')} — some features may not work
      </span>
      <span style={{ color: '#7dd3fc', fontSize: '0.62rem', fontWeight: 600 }}>Services →</span>
    </button>
  );
}

export default ServiceOffBanner;
