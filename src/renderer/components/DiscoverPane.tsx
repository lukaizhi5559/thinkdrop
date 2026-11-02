import React, { useState, useEffect, useRef, useCallback } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

/**
 * DiscoverPane — aggregated skills/MCP search across marketplace sources.
 * Rows come from `skill:discover-search` (agentskillshub live index + bundled
 * catalog + agenticskills scrape). `+` opens an inline action menu:
 *   Plan it  → resolve the doc URL → skill:plan-build (planning-mode pipeline)
 *   Install  → resolve the doc URL → skill:install-from-url (skills only)
 *   Open     → shell:open-url the source page
 */

interface DiscoverRow {
  id: string;
  name: string;
  description: string;
  kind: 'skill' | 'mcp' | string;
  source: string;
  repoFull?: string;
  pageUrl?: string;
  rawUrl?: string;
  avatarUrl?: string;
  stars?: number;
  grade?: string | null;
}

interface DiscoverPaneProps {
  onGoResults?: () => void;
  onContentResize?: () => void;
}

const SOURCE_LABEL: Record<string, string> = {
  agentskillshub: 'AgentSkillsHub',
  library: 'Library',
  agenticskills: 'AgenticSkills',
};

const KIND_STYLE: Record<string, { label: string; color: string }> = {
  skill: { label: 'SKILL', color: '#a78bfa' },
  mcp:   { label: 'MCP',   color: '#22d3ee' },
};

const _btn = (color = '#abafb8'): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 3,
  padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
  color, fontSize: '0.62rem', fontWeight: 600, whiteSpace: 'nowrap',
});

function _fmtStars(n?: number): string {
  if (!n) return '';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k★`;
  return `${n}★`;
}

function Avatar({ row }: { row: DiscoverRow }) {
  const [err, setErr] = useState(false);
  if (!row.avatarUrl || err) {
    return (
      <div style={{
        width: 26, height: 26, borderRadius: 7, flexShrink: 0,
        background: 'rgba(139,92,246,0.14)', border: '1px solid rgba(139,92,246,0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#a78bfa', fontSize: '0.68rem', fontWeight: 700,
      }}>
        {(row.name || '?')[0].toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={row.avatarUrl}
      width={26} height={26}
      onError={() => setErr(true)}
      style={{ borderRadius: 7, flexShrink: 0, background: 'rgba(255,255,255,0.06)' }}
      alt=""
    />
  );
}

export default function DiscoverPane({ onGoResults, onContentResize }: DiscoverPaneProps) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<DiscoverRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sourceHealth, setSourceHealth] = useState<Record<string, boolean>>({});
  const reqSeq = useRef(0);

  const search = useCallback(async (q: string) => {
    const seq = ++reqSeq.current;
    setLoading(true);
    const res = await ipcRenderer?.invoke('skill:discover-search', { query: q }).catch(() => null);
    if (seq !== reqSeq.current) return; // stale response — a newer query owns the list
    setLoading(false);
    if (res?.ok) {
      setRows(res.rows || []);
      setSourceHealth(res.sources || {});
    } else if (res) {
      setNote(res.error || 'Search failed');
      setTimeout(() => setNote(null), 4000);
    }
  }, []);

  // Debounced live search; empty query → featured (top-starred) rows.
  useEffect(() => {
    const t = setTimeout(() => search(query.trim()), query.trim() ? 350 : 0);
    return () => clearTimeout(t);
  }, [query, search]);

  const onContentResizeRef = useRef(onContentResize);
  onContentResizeRef.current = onContentResize;
  useEffect(() => {
    const t = setTimeout(() => onContentResizeRef.current?.(), 60);
    return () => clearTimeout(t);
  }, [rows, menuFor, note]);

  // Resolve the row to a document URL (rawUrl shortcut, else skill:resolve-doc).
  const _docUrl = async (row: DiscoverRow): Promise<string | null> => {
    if (row.rawUrl) return row.rawUrl;
    const res = await ipcRenderer?.invoke('skill:resolve-doc', { row }).catch(() => null);
    return res?.ok ? res.url : null;
  };

  const planIt = async (row: DiscoverRow) => {
    setMenuFor(null); setBusyId(row.id);
    const url = await _docUrl(row);
    if (!url) {
      setBusyId(null);
      setNote(`No skill doc found for ${row.name}`);
      setTimeout(() => setNote(null), 4000);
      return;
    }
    const res = await ipcRenderer?.invoke('skill:plan-build', { url }).catch(() => null);
    setBusyId(null);
    if (res?.ok) {
      onGoResults?.();
    } else {
      setNote(res?.error || 'Could not start plan build');
      setTimeout(() => setNote(null), 4000);
    }
  };

  const install = async (row: DiscoverRow) => {
    setMenuFor(null); setBusyId(row.id);
    const url = await _docUrl(row);
    if (!url) {
      setBusyId(null);
      setNote(`No skill doc found for ${row.name}`);
      setTimeout(() => setNote(null), 4000);
      return;
    }
    ipcRenderer?.send('skill:install-from-url', { url });
    setBusyId(null);
    setNote(`Installing ${row.name}…`);
    setTimeout(() => setNote(null), 4000);
  };

  const open = (row: DiscoverRow) => {
    setMenuFor(null);
    if (row.pageUrl) ipcRenderer?.send('shell:open-url', row.pageUrl);
  };

  const kindStyle = (k: string) => KIND_STYLE[k] || { label: (k || 'tool').toUpperCase(), color: '#9ca3af' };
  const activeSources = Object.entries(sourceHealth).filter(([, ok]) => ok).map(([k]) => SOURCE_LABEL[k] || k);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Search box */}
      <div style={{ position: 'relative' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round"
          style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search for skills / MCPs…"
          style={{
            width: '100%', boxSizing: 'border-box',
            background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8, color: '#e5e7eb', fontSize: '0.78rem',
            padding: '8px 30px 8px 30px', outline: 'none',
          }}
        />
        {loading && (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2.4" strokeLinecap="round"
            style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', animation: 'spin 1s linear infinite' }}>
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
        )}
      </div>

      {/* Source strip + notice */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 14 }}>
        <span style={{ fontSize: '0.58rem', color: '#4b5563' }}>
          {query ? `${rows.length} result${rows.length === 1 ? '' : 's'}` : 'Featured'}
          {activeSources.length ? ` · ${activeSources.join(' · ')}` : ''}
        </span>
        {note && <span style={{ fontSize: '0.62rem', color: '#fbbf24', marginLeft: 'auto' }}>{note}</span>}
      </div>

      {/* Result rows */}
      {rows.map(row => {
        const ks = kindStyle(row.kind);
        const busy = busyId === row.id;
        return (
          <div key={row.id} style={{
            display: 'flex', alignItems: 'center', gap: 9,
            padding: '8px 10px', borderRadius: 8,
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
            position: 'relative',
          }}>
            <Avatar row={row} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <span style={{
                  color: '#e5e7eb', fontSize: '0.72rem', fontWeight: 600,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {row.name}
                </span>
                <span style={{
                  fontSize: '0.54rem', fontWeight: 700, letterSpacing: '0.06em',
                  color: ks.color, background: `${ks.color}1f`,
                  border: `1px solid ${ks.color}44`, borderRadius: 4, padding: '0 4px', flexShrink: 0,
                }}>
                  {ks.label}
                </span>
                {!!row.stars && <span style={{ fontSize: '0.56rem', color: '#6b7280', flexShrink: 0 }}>{_fmtStars(row.stars)}</span>}
              </div>
              {row.description && (
                <div style={{
                  fontSize: '0.62rem', color: '#9ca3af', marginTop: 2,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {row.description}
                </div>
              )}
              <div style={{ fontSize: '0.54rem', color: '#4b5563', marginTop: 2 }}>
                {SOURCE_LABEL[row.source] || row.source}
                {row.repoFull ? ` · ${row.repoFull}` : ''}
              </div>
            </div>

            {/* Add menu */}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                onClick={() => setMenuFor(menuFor === row.id ? null : row.id)}
                disabled={busy}
                title="Add this skill"
                style={{ ..._btn('#818cf8'), opacity: busy ? 0.5 : 1, padding: '4px 9px', fontSize: '0.72rem' }}
              >
                {busy ? '…' : '+'}
              </button>
              {menuFor === row.id && (
                <div style={{
                  position: 'absolute', right: 0, top: '110%', zIndex: 20, minWidth: 128,
                  borderRadius: 8, overflow: 'hidden',
                  background: 'rgba(17,22,34,0.98)', border: '1px solid rgba(148,163,184,0.3)',
                  boxShadow: '0 10px 32px rgba(0,0,0,0.55)',
                }}>
                  <button onClick={() => planIt(row)} style={_menuItem()}>
                    <span style={{ color: '#22d3ee' }}>Plan it</span>
                    <span style={{ color: '#4b5563', fontSize: '0.55rem' }}>via planning mode</span>
                  </button>
                  {row.kind === 'skill' && (
                    <button onClick={() => install(row)} style={_menuItem()}>
                      <span style={{ color: '#a78bfa' }}>Install</span>
                      <span style={{ color: '#4b5563', fontSize: '0.55rem' }}>direct</span>
                    </button>
                  )}
                  {row.pageUrl && (
                    <button onClick={() => open(row)} style={_menuItem()}>
                      <span style={{ color: '#9ca3af' }}>Open</span>
                      <span style={{ color: '#4b5563', fontSize: '0.55rem' }}>source page</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {!loading && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '28px 10px', color: '#4b5563', fontSize: '0.7rem' }}>
          {query ? 'No matches — try a different query' : 'No sources reachable'}
        </div>
      )}

      {/* Click-away to close the add menu */}
      {menuFor && (
        <div
          onClick={() => setMenuFor(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 10 }}
        />
      )}
    </div>
  );
}

const _menuItem = (): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
  width: '100%', textAlign: 'left', padding: '8px 12px',
  border: 'none', background: 'transparent',
  fontSize: '0.68rem', fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
});
