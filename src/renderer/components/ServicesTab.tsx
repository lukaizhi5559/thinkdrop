/**
 * ServicesTab — mcp-services + externals control panel.
 *
 * Rows from services:list IPC (serviceManager × shared/service-registry.cjs):
 * status dot, tier badge, port, RSS/CPU, uptime-or-last-hit. Coldable rows get
 * a warm/auto/off mode selector (gate :3030); warm/protected rows get on/off
 * (protected confirms before off). Every row: restart, expandable log tail,
 * and "Report issue" → the same issues.jsonl feed IssuesTab lists.
 * Ollama section lists resident models with an unload action.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface ServiceRow {
  id: string;
  label: string;
  port: number;
  tier: 'warm' | 'protected' | 'coldable' | 'external';
  mode: 'warm' | 'auto' | 'off';
  state: 'warm' | 'cold' | 'spawning' | 'off' | 'down';
  healthy: boolean;
  uptime: number | null;
  pid: number | null;
  rssMb: number | null;
  cpu: number | null;
  lastReq: number | null;
  reqs: number | null;
  version: string | null;
  gatePresent: boolean;
}

interface OllamaModel { name: string; sizeGb: number; expiresAt: string | null }

const TIER_STYLE: Record<string, { label: string; color: string; border: string; bg: string }> = {
  protected: { label: 'guardian',  color: '#f59e0b', border: 'rgba(245,158,11,0.3)',  bg: 'rgba(245,158,11,0.07)' },
  warm:      { label: 'warm',      color: '#7dd3fc', border: 'rgba(56,189,248,0.25)', bg: 'rgba(56,189,248,0.06)' },
  coldable:  { label: 'on-demand', color: '#c4b5fd', border: 'rgba(167,139,250,0.3)', bg: 'rgba(167,139,250,0.07)' },
  external:  { label: 'external',  color: '#9ca3af', border: 'rgba(255,255,255,0.15)',bg: 'rgba(255,255,255,0.03)' },
};

function statusDot(s: ServiceRow) {
  if (s.mode === 'off' || s.state === 'off') return '#6b7280';
  if (s.state === 'spawning') return '#fbbf24';
  if (s.state === 'cold') return '#a78bfa';
  return s.healthy ? '#4ade80' : '#f87171';
}
function statusLabel(s: ServiceRow) {
  if (s.mode === 'off' || s.state === 'off') return 'off';
  if (s.state === 'spawning') return 'starting…';
  if (s.state === 'cold') return 'sleeping';
  return s.healthy ? 'up' : 'down';
}

function _fmtUptime(secs: number | null) {
  if (secs == null) return '';
  if (secs < 120) return `${secs}s`;
  if (secs < 7200) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
}
function _fmtAgo(ts: number | null) {
  if (!ts) return 'never';
  const d = Date.now() - ts;
  if (d < 60000) return `${Math.max(1, Math.round(d / 1000))}s ago`;
  if (d < 3600000) return `${Math.round(d / 60000)}m ago`;
  return `${Math.round(d / 3600000)}h ago`;
}

function ServiceCard({ svc, busy, onMode, onRestart, onReport }: {
  svc: ServiceRow;
  busy: boolean;
  onMode: (id: string, mode: string) => void;
  onRestart: (id: string) => void;
  onReport: (id: string) => void;
}) {
  const [showLogs, setShowLogs] = useState(false);
  const [logText, setLogText] = useState('');
  const [reported, setReported] = useState(false);
  const tier = TIER_STYLE[svc.tier] || TIER_STYLE.warm;
  const dot = statusDot(svc);

  const toggleLogs = async () => {
    if (!showLogs) {
      const res = await ipcRenderer?.invoke?.('services:logs', { id: svc.id, lines: 120 });
      setLogText(res?.text || '(log file empty or missing)');
    }
    setShowLogs(v => !v);
  };

  const report = async () => {
    await onReport(svc.id);
    setReported(true);
    setTimeout(() => setReported(false), 2500);
  };

  const setMode = (mode: string) => {
    if (mode === 'off' && svc.tier === 'protected') {
      const ok = window.confirm(
        `${svc.label} is on the guardian path (screen monitoring / rule judging).\n\n` +
        `Turning it off disables protection until you turn it back on. Continue?`
      );
      if (!ok) return;
    }
    onMode(svc.id, mode);
  };

  return (
    <div style={{
      borderRadius: 9,
      backgroundColor: svc.mode === 'off' ? 'rgba(255,255,255,0.02)' : tier.bg,
      border: `1px solid ${svc.mode === 'off' ? 'rgba(255,255,255,0.08)' : tier.border}`,
      overflow: 'hidden', opacity: svc.mode === 'off' ? 0.65 : 1,
    }}>
      <div style={{ padding: '9px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: dot, flexShrink: 0 }} />
          <div style={{ color: '#e5e7eb', fontSize: '0.76rem', fontWeight: 600, flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {svc.label}
          </div>
          <span style={{
            fontSize: '0.56rem', fontWeight: 700, textTransform: 'uppercase', flexShrink: 0,
            color: tier.color, padding: '1px 6px', borderRadius: 4,
            backgroundColor: 'rgba(0,0,0,0.25)', border: `1px solid ${tier.border}`,
          }}>{tier.label}</span>
        </div>

        <div style={{ color: '#9ca3af', fontSize: '0.62rem', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span>:{svc.port}</span>
          <span style={{ color: dot }}>{statusLabel(svc)}</span>
          {svc.rssMb != null && <span>{svc.rssMb}MB</span>}
          {svc.cpu != null && svc.cpu > 0 && <span>{svc.cpu}% cpu</span>}
          {svc.uptime != null && <span>up {_fmtUptime(svc.uptime)}</span>}
          {svc.tier === 'coldable' && svc.lastReq != null && (
            <span>last hit {_fmtAgo(svc.lastReq)}{svc.reqs ? ` · ${svc.reqs} reqs` : ''}</span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7 }}>
          {svc.tier === 'coldable' && svc.gatePresent ? (
            <select
              value={svc.mode}
              disabled={busy}
              onChange={(e) => setMode(e.target.value)}
              style={{
                fontSize: '0.62rem', fontWeight: 600, padding: '2px 4px', borderRadius: 5,
                color: '#d1d5db', backgroundColor: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.12)', cursor: 'pointer',
              }}
            >
              <option value="auto">auto · sleep till needed</option>
              <option value="warm">warm · always on</option>
              <option value="off">off</option>
            </select>
          ) : svc.tier !== 'external' ? (
            <select
              value={svc.mode === 'off' ? 'off' : 'warm'}
              disabled={busy}
              onChange={(e) => setMode(e.target.value)}
              style={{
                fontSize: '0.62rem', fontWeight: 600, padding: '2px 4px', borderRadius: 5,
                color: '#d1d5db', backgroundColor: 'rgba(255,255,255,0.05)',
                border: '1px solid rgba(255,255,255,0.12)', cursor: 'pointer',
              }}
            >
              <option value="warm">on</option>
              <option value="off">off</option>
            </select>
          ) : (
            <span style={{ fontSize: '0.6rem', color: '#6b7280' }}>read-only</span>
          )}

          {svc.tier !== 'external' && (
            <ActionBtn label={busy ? '…' : '⟳ restart'} onClick={() => onRestart(svc.id)} disabled={busy} />
          )}
          <ActionBtn label={showLogs ? '▾ hide logs' : '▸ logs'} onClick={toggleLogs} />
          <button
            onClick={report}
            disabled={busy}
            style={{
              marginLeft: 'auto', padding: '3px 9px', borderRadius: 6, fontSize: '0.62rem',
              fontWeight: 600, cursor: 'pointer',
              color: reported ? '#4ade80' : '#fbbf24',
              backgroundColor: reported ? 'rgba(74,222,128,0.08)' : 'rgba(245,158,11,0.07)',
              border: `1px solid ${reported ? 'rgba(74,222,128,0.3)' : 'rgba(245,158,11,0.25)'}`,
            }}
          >
            {reported ? '✓ logged' : '⚑ report'}
          </button>
        </div>

        {showLogs && (
          <pre style={{
            marginTop: 8, padding: '8px 10px', borderRadius: 6,
            backgroundColor: 'rgba(0,0,0,0.35)',
            fontSize: '0.6rem', lineHeight: 1.5, color: '#9ca3af',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            maxHeight: 200, overflowY: 'auto',
          }}>{logText}</pre>
        )}
      </div>
    </div>
  );
}

function ActionBtn({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '3px 9px', borderRadius: 6, fontSize: '0.62rem', fontWeight: 600, cursor: 'pointer',
        color: '#7dd3fc', backgroundColor: 'rgba(56,189,248,0.07)',
        border: '1px solid rgba(56,189,248,0.22)',
      }}
    >{label}</button>
  );
}

export function ServicesTab() {
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [gatePresent, setGatePresent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await ipcRenderer?.invoke?.('services:list');
      if (!mounted.current) return;
      setServices(Array.isArray(res?.services) ? res.services : []);
      setGatePresent(!!res?.gatePresent);
      const om = await ipcRenderer?.invoke?.('services:ollamaModels');
      if (mounted.current) setModels(Array.isArray(om?.models) ? om.models : []);
    } catch { /* keep last */ }
    if (mounted.current) setLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    load();
    const t = setInterval(() => load(true), 5000);
    return () => { mounted.current = false; clearInterval(t); };
  }, [load]);

  const onMode = async (id: string, mode: string) => {
    setBusyId(id);
    await ipcRenderer?.invoke?.('services:setMode', { id, mode });
    await load(true);
    setBusyId(null);
  };
  const onRestart = async (id: string) => {
    setBusyId(id);
    await ipcRenderer?.invoke?.('services:restart', { id });
    setTimeout(() => load(true), 1200);
    setBusyId(null);
  };
  const onReport = async (id: string) => {
    await ipcRenderer?.invoke?.('services:reportIssue', { id });
  };
  const onUnload = async (name: string) => {
    await ipcRenderer?.invoke?.('services:unloadModel', { name });
    setTimeout(() => load(true), 800);
  };

  const order: Record<string, number> = { protected: 0, warm: 1, coldable: 2, external: 3 };
  const sorted = [...services].sort((a, b) => (order[a.tier] - order[b.tier]) || a.port - b.port);
  const offCount = services.filter(s => s.mode === 'off' || s.state === 'off').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: '#e5e7eb', fontSize: '0.82rem', fontWeight: 700 }}>Services</div>
          <div style={{ color: '#9ca3af', fontSize: '0.64rem', marginTop: 1 }}>
            {gatePresent
              ? 'On-demand services sleep until called — warm pins them, off disables them.'
              : 'Gate not running — on-demand controls hidden. Restart with --gate to enable.'}
          </div>
        </div>
        {offCount > 0 && (
          <span style={{
            fontSize: '0.6rem', fontWeight: 700, color: '#fbbf24', padding: '2px 8px',
            borderRadius: 5, backgroundColor: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.3)',
          }}>{offCount} off</span>
        )}
        <button onClick={() => load()} style={{
          padding: '4px 10px', borderRadius: 6, fontSize: '0.66rem', fontWeight: 600,
          color: '#7dd3fc', backgroundColor: 'rgba(56,189,248,0.08)',
          border: '1px solid rgba(56,189,248,0.25)', cursor: 'pointer',
        }}>↻ Refresh</button>
      </div>

      {loading && services.length === 0 ? (
        <div style={{ color: '#9ca3af', fontSize: '0.72rem', padding: '14px 0', textAlign: 'center' }}>Loading…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {sorted.map(svc => (
            <ServiceCard
              key={svc.id} svc={svc} busy={busyId === svc.id}
              onMode={onMode} onRestart={onRestart} onReport={onReport}
            />
          ))}

          {/* Ollama models */}
          <div style={{
            borderRadius: 9, padding: '9px 12px',
            backgroundColor: 'rgba(255,255,255,0.02)',
            border: '1px solid rgba(255,255,255,0.1)',
          }}>
            <div style={{ color: '#e5e7eb', fontSize: '0.72rem', fontWeight: 600 }}>Ollama models</div>
            {models.length === 0 ? (
              <div style={{ color: '#6b7280', fontSize: '0.62rem', marginTop: 4 }}>No models resident — they load on first use and evict when idle.</div>
            ) : models.map(m => (
              <div key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                <span style={{ fontSize: '0.66rem', color: '#d1d5db', fontFamily: 'monospace', flex: 1 }}>{m.name}</span>
                <span style={{ fontSize: '0.6rem', color: '#9ca3af' }}>{m.sizeGb}GB</span>
                <button onClick={() => onUnload(m.name)} style={{
                  padding: '2px 8px', borderRadius: 5, fontSize: '0.6rem', fontWeight: 600, cursor: 'pointer',
                  color: '#f87171', backgroundColor: 'rgba(248,113,113,0.07)',
                  border: '1px solid rgba(248,113,113,0.25)',
                }}>unload</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default ServicesTab;
