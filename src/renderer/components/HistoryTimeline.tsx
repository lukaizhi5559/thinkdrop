/**
 * HistoryTimeline — conversation-history drill-down on the GhostLayer.
 * Opened by ⇧R-hold + ⌥R double-tap (main.js `history:view`); the overlay
 * hides while it's up.
 *
 * Three levels (the AVM-style drill):
 *   days   — AntV Column over all history + built-in slider navigator
 *   hours  — 24 hourly bars for the clicked day (zero-filled)
 *   list   — message list for the clicked hour; row click → history:jump
 *            (overlay reopens paged to that point, strip closes)
 *
 * The AntV chart lazy-loads so the resident ghost window stays light.
 */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

const Column = React.lazy(() =>
  import('@ant-design/charts').then(m => ({ default: m.Column }))
);

interface Bucket { day: string; count: number; }   // `day` = bucket label regardless of granularity
interface PreviewMsg { role: string; content: string; created_at: string; }
type Level = 'days' | 'hours' | 'list';

const STRIP_H = 196;
const LIST_STRIP_H = 260;
const STRIP_MIN_H = 140;
const STRIP_MAX_H = 520;

function _fmtDay(day: string) {
  const d = new Date(`${day}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function _fmtHour(label: string) {
  const d = new Date(label);
  return d.toLocaleTimeString(undefined, { hour: 'numeric' });
}
const _shortLabel = (label: string) => {
  if (label.includes('T')) return _fmtHour(label);
  const d = new Date(`${label}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
// Axis formatters per level — days stay ISO 'YYYY-MM-DD', hours read '2 PM'.
const _dayAxis = (s: string) => (s.includes('T') ? s.slice(0, 10) : s);
const _hourAxis = (s: string) => _fmtHour(s);

/* Shared chart config — dark strip, click → onBarClick(bucket label). */
function HistoryChart({ data, onBarClick, slider, xFormatter, chartH }: {
  data: { label: string; count: number }[];
  onBarClick: (label: string) => void;
  slider?: boolean;
  xFormatter: (s: string) => string;
  chartH: number;
}) {
  const config = useMemo(() => ({
    data,
    xField: 'label',
    yField: 'count',
    height: Math.max(60, chartH),
    autoFit: true,
    columnStyle: { fill: '#60a5fa', radiusTopLeft: 2, radiusTopRight: 2 },
    axis: {
      x: { labelFontSize: 10, labelFill: 'rgba(255,255,255,0.45)', labelAutoRotate: false, labelAutoHide: true, labelFormatter: (t: any) => xFormatter(String(t)) },
      y: { label: false, grid: false },
    },
    tooltip: {
      title: (d: any) => _shortLabel(d?.label || ''),
      items: [{ field: 'count', name: 'messages' }],
    },
    ...(slider ? { slider: { x: { labelFormatter: (v: any) => xFormatter(String(v)) } } } : {}),
  }), [data, slider, xFormatter, chartH]);

  return (
    <Column
      {...config}
      onReady={({ chart }: any) => {
        chart.on('element:click', (ev: any) => {
          const label = ev?.data?.data?.label ?? ev?.data?.label;
          if (label) onBarClick(label);
        });
      }}
    />
  );
}
const LazyChart = React.memo(HistoryChart);

export default function HistoryTimeline({ onClose }: { onClose: () => void }) {
  const [level, setLevel] = useState<Level>('days');
  const [selDay, setSelDay] = useState<string | null>(null);
  const [selHour, setSelHour] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const [messages, setMessages] = useState<PreviewMsg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stripH, setStripH] = useState(STRIP_H);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const reqSeq = useRef(0);

  // Fetch buckets whenever level/selection changes.
  useEffect(() => {
    const seq = ++reqSeq.current;
    let args: any;
    if (level === 'days') args = { bucket: 'day' };
    else if (level === 'hours' && selDay) {
      args = { bucket: 'hour', startDate: `${selDay}T00:00:00.000Z`, endDate: `${selDay}T23:59:59.999Z` };
    } else if (level === 'list' && selHour) {
      const end = new Date(new Date(selHour).getTime() + 3600000 - 1);
      args = { startDate: `${selHour}:00.000Z`, endDate: end.toISOString(), limit: 50 };
      ipcRenderer?.invoke('history:messages', args)
        .then((res: any) => { if (reqSeq.current === seq) setMessages(res?.messages || []); })
        .catch((e: any) => { if (reqSeq.current === seq) setError(e?.message || 'history unavailable'); });
      return;
    } else return;
    setBuckets(null);
    ipcRenderer?.invoke('history:histogram', args)
      .then((res: any) => { if (reqSeq.current === seq) setBuckets(res?.buckets || []); })
      .catch((e: any) => { if (reqSeq.current === seq) setError(e?.message || 'history unavailable'); });
  }, [level, selDay, selHour]);

  const onDayClick = useCallback((label: string) => {
    setSelDay(label); setSelHour(null); setMessages(null); setLevel('hours');
  }, []);
  const onHourClick = useCallback((label: string) => {
    setSelHour(label); setMessages(null); setLevel('list');
    setStripH(h => Math.max(h, LIST_STRIP_H));
  }, []);
  const back = useCallback(() => {
    if (level === 'list') { setLevel('hours'); setSelHour(null); setMessages(null); }
    else if (level === 'hours') { setLevel('days'); setSelDay(null); }
  }, [level]);

  const chartData = useMemo(() => {
    if (!buckets) return [];
    if (level === 'hours') {
      // Zero-fill all 24 hours so the axis is always 00–23.
      const byHour = new Map(buckets.map(b => [b.day, b.count]));
      return Array.from({ length: 24 }, (_, h) => {
        const label = `${selDay}T${String(h).padStart(2, '0')}:00`;
        return { label, count: byHour.get(label) || 0 };
      });
    }
    return buckets.map(b => ({ label: b.day, count: b.count }));
  }, [buckets, level, selDay]);

  const jumpTo = useCallback((createdAt?: string) => {
    const end = selHour
      ? new Date(new Date(selHour).getTime() + 3600000 - 1).toISOString()
      : (createdAt || `${selDay}T23:59:59.999Z`);
    ipcRenderer?.send('history:jump', { endDate: end });
  }, [selDay, selHour]);

  // Top-edge drag — resize the strip between STRIP_MIN/MAX_H.
  const onGrabDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startH: stripH };
    setDragging(true);
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setStripH(Math.min(STRIP_MAX_H, Math.max(STRIP_MIN_H, d.startH + (d.startY - ev.clientY))));
    };
    const onUp = () => {
      dragRef.current = null;
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [stripH]);

  const crumb = level === 'days' ? 'All time'
    : level === 'hours' ? _fmtDay(selDay!)
    : `${_fmtDay(selDay!)} · ${_fmtHour(selHour!)}`;

  return (
    <div
      style={{
        position: 'fixed', left: 0, right: 0, bottom: 0, height: stripH,
        pointerEvents: 'auto', display: 'flex', flexDirection: 'column',
        backgroundColor: 'rgba(10,14,22,0.94)',
        borderTop: '1px solid rgba(96,165,250,0.28)',
        boxShadow: '0 -8px 40px rgba(0,0,0,0.55)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        transition: dragging ? 'none' : 'height 0.18s ease',
        userSelect: dragging ? 'none' : 'auto',
        zIndex: 50,
      }}
    >
      {/* drag-to-resize grab zone — 10px + visible handle pill */}
      <div
        onMouseDown={onGrabDown}
        title="Drag to resize"
        style={{
          height: 10, marginTop: -2, cursor: 'ns-resize', flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: 40, height: 3, borderRadius: 2,
            backgroundColor: dragging ? 'rgba(147,197,253,0.7)' : 'rgba(255,255,255,0.22)',
          }}
        />
      </div>
      {/* header + breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px 2px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ color: '#e5e7eb', fontSize: 12.5, fontWeight: 600 }}>Conversation History</span>
          {level !== 'days' && (
            <button
              type="button"
              onClick={back}
              style={{ background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: 11, padding: 0 }}
            >‹ back</button>
          )}
          <span style={{ color: '#6b7280', fontSize: 10.5 }}>
            {crumb}{buckets ? ` · ${buckets.reduce((s, b) => s + b.count, 0).toLocaleString()} messages` : ''}
            {level === 'days' ? ' · click a day to drill' : level === 'hours' ? ' · click an hour' : ' · click a message to jump'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#4b5563', fontSize: 10 }}>⇧R+⌥R ×2 or Esc to close</span>
          <button
            type="button" onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 2 }}
            title="Close history"
          >✕</button>
        </div>
      </div>

      {/* body */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, margin: '0 16px 8px' }}>
        {/* chart (kept at every level — context on the left when listing) */}
        <div style={{ flex: 1, minWidth: 0, opacity: level === 'list' ? 0.55 : 1 }}>
          {error && <div style={{ color: '#f87171', fontSize: 11, padding: 12 }}>history unavailable — {error}</div>}
          {buckets && !buckets.length && !error && level !== 'list' && (
            <div style={{ color: '#6b7280', fontSize: 11, padding: 16 }}>
              {level === 'hours' ? 'No messages this day.' : 'No conversation history yet.'}
            </div>
          )}
          {(level !== 'list' || buckets) && chartData.length > 0 && (
            <Suspense fallback={<div style={{ color: '#4b5563', fontSize: 11, padding: 16 }}>loading chart…</div>}>
              <LazyChart
                data={chartData}
                slider={level === 'days'}
                xFormatter={level === 'days' ? _dayAxis : _hourAxis}
                chartH={stripH - 100}
                onBarClick={level === 'days' ? onDayClick : level === 'hours' ? onHourClick : () => {}}
              />
            </Suspense>
          )}
        </div>

        {/* message list — hour level */}
        {level === 'list' && (
          <div style={{ width: 380, marginLeft: 14, overflowY: 'auto', borderLeft: '1px solid rgba(255,255,255,0.08)', paddingLeft: 12 }}>
            {messages === null && <div style={{ color: '#4b5563', fontSize: 11, padding: 12 }}>loading…</div>}
            {messages && !messages.length && <div style={{ color: '#6b7280', fontSize: 11, padding: 12 }}>No messages this hour.</div>}
            {messages?.map((m, i) => (
              <div
                key={i}
                onClick={() => jumpTo(m.created_at)}
                style={{
                  display: 'flex', gap: 6, marginBottom: 6, padding: '4px 6px', borderRadius: 5,
                  cursor: 'pointer', fontSize: 10.5, lineHeight: 1.4,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(96,165,250,0.12)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <span style={{ color: m.role === 'user' ? '#60a5fa' : '#a78bfa', flexShrink: 0, fontWeight: 600, width: 22 }}>
                  {m.role === 'user' ? 'you' : 'ai'}
                </span>
                <div style={{ minWidth: 0 }}>
                  <span style={{ color: '#4b5563', fontSize: 9.5, marginRight: 5 }}>
                    {new Date(m.created_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                  </span>
                  <span style={{ color: '#d1d5db', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as any, overflow: 'hidden' }}>
                    {m.content}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
