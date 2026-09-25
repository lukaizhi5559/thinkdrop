import React from 'react';
import type { ScreenChart, ScreenOutput } from './types';
import { MOOD_ACCENT } from './types';

/**
 * ChartScreen — hand-rolled SVG charts for kind:'chart'.
 *
 * No chart library: pie/donut render as SVG arc paths, bar/line/area as
 * scaled geometry inside a viewBox, 'stat' as a single big number card.
 * x/y values resolve via xKey/yKey with fallbacks (first string key for
 * labels, first numeric key for values). Mood supplies the primary accent;
 * multi-slice charts get a generated palette derived from it.
 */

const PALETTE = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#fb923c'];

interface Row { label: string; value: number }

function resolveRows(chart: ScreenChart): Row[] {
  const data = chart.data || [];
  if (!data.length) return [];
  const first = data[0];
  // Primitive rows: treat the array itself as values.
  if (typeof first === 'number') {
    return data.map((v, i) => ({ label: `${i + 1}`, value: Number(v) || 0 }));
  }
  if (typeof first !== 'object' || first === null) return [];
  const keys = Object.keys(first);
  const yKey = chart.yKey && keys.includes(chart.yKey)
    ? chart.yKey
    : keys.find(k => typeof first[k] === 'number');
  const xKey = chart.xKey && keys.includes(chart.xKey)
    ? chart.xKey
    : keys.find(k => typeof first[k] === 'string' && k !== yKey);
  if (!yKey) return [];
  return data
    .map(d => ({ label: String(xKey ? d[xKey] : ''), value: Number(d[yKey]) || 0 }))
    .filter(r => Number.isFinite(r.value));
}

function fmt(n: number): string {
  return Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(Math.round(n * 100) / 100);
}

// Arc path for a pie/donut slice.
function arcPath(cx: number, cy: number, r: number, r0: number, a0: number, a1: number): string {
  const p = (rad: number, a: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  if (r0 <= 0) {
    return `M ${cx},${cy} L ${p(r, a0)} A ${r},${r} 0 ${large} 1 ${p(r, a1)} Z`;
  }
  return `M ${p(r, a0)} A ${r},${r} 0 ${large} 1 ${p(r, a1)} L ${p(r0, a1)} A ${r0},${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

export function ChartScreen({ output }: { output: ScreenOutput }) {
  const chart = output.chart;
  const accent = MOOD_ACCENT[output.mood] || '#60a5fa';
  if (!chart) return null;
  const rows = resolveRows(chart);
  if (!rows.length) {
    return (
      <Card title={output.title} accent={accent}>
        <div style={{ color: '#94a3b8', fontSize: 18 }}>No chartable data</div>
      </Card>
    );
  }

  const W = 640, H = 400;
  const body = (() => {
    switch (chart.type) {
      case 'pie':
      case 'donut':
        return <Pie rows={rows} donut={chart.type === 'donut'} accent={accent} w={W} h={H} label={chart.label} />;
      case 'bar':
        return <Bars rows={rows} accent={accent} w={W} h={H} />;
      case 'line':
      case 'area':
        return <LineArea rows={rows} area={chart.type === 'area'} accent={accent} w={W} h={H} />;
      case 'stat':
        return <Stat rows={rows} accent={accent} label={chart.label} />;
      default:
        return null;
    }
  })();

  return <Card title={output.title || chart.label} accent={accent} wide>{body}</Card>;
}

// ── Chart primitives ────────────────────────────────────────────────────────

function Pie({ rows, donut, accent, w, h, label }: { rows: Row[]; donut: boolean; accent: string; w: number; h: number; label?: string }) {
  const total = rows.reduce((s, r) => s + Math.max(0, r.value), 0) || 1;
  const cx = w * 0.36, cy = h / 2, r = Math.min(w, h) * 0.38, r0 = donut ? r * 0.55 : 0;
  let a = -Math.PI / 2;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', maxWidth: 640, height: 'auto' }}>
      {rows.map((row, i) => {
        const frac = Math.max(0, row.value) / total;
        const a1 = a + frac * Math.PI * 2;
        const d = arcPath(cx, cy, r, r0, a, a1 - 0.02);
        a = a1;
        return <path key={i} d={d} fill={i === 0 ? accent : PALETTE[i % PALETTE.length]} opacity={0.92} />;
      })}
      {donut && label && (
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="middle"
          fill="#f3f4f6" fontSize={26} fontWeight={700} fontFamily="system-ui">{label}</text>
      )}
      {rows.map((row, i) => {
        const y = h / 2 - (rows.length - 1) * 14 + i * 28;
        return (
          <g key={i}>
            <rect x={w * 0.68} y={y - 10} width={14} height={14} rx={3}
              fill={i === 0 ? accent : PALETTE[i % PALETTE.length]} />
            <text x={w * 0.68 + 22} y={y + 2} fill="#e5e7eb" fontSize={15} fontFamily="system-ui">
              {row.label} · {fmt(row.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function Bars({ rows, accent, w, h }: { rows: Row[]; accent: string; w: number; h: number }) {
  const pad = { l: 56, r: 16, t: 24, b: 44 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const max = Math.max(...rows.map(r => r.value), 1);
  const bw = Math.min(64, (iw / rows.length) * 0.6);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', maxWidth: 640, height: 'auto' }}>
      {[0, 0.5, 1].map(f => {
        const y = pad.t + ih * (1 - f);
        return (
          <g key={f}>
            <line x1={pad.l} y1={y} x2={w - pad.r} y2={y} stroke="#374151" strokeWidth={1} />
            <text x={pad.l - 8} y={y + 4} textAnchor="end" fill="#9ca3af" fontSize={12} fontFamily="system-ui">
              {fmt(max * f)}
            </text>
          </g>
        );
      })}
      {rows.map((row, i) => {
        const x = pad.l + (iw / rows.length) * (i + 0.5) - bw / 2;
        const bh = Math.max(2, (Math.max(0, row.value) / max) * ih);
        const y = pad.t + ih - bh;
        return (
          <g key={i}>
            <rect x={x} y={y} width={bw} height={bh} rx={6}
              fill={i === 0 ? accent : PALETTE[i % PALETTE.length]} opacity={0.9} />
            <text x={x + bw / 2} y={y - 8} textAnchor="middle" fill="#e5e7eb" fontSize={13}
              fontWeight={600} fontFamily="system-ui">{fmt(row.value)}</text>
            <text x={x + bw / 2} y={h - pad.b + 20} textAnchor="middle" fill="#9ca3af" fontSize={13}
              fontFamily="system-ui">
              {row.label.length > 10 ? row.label.slice(0, 9) + '…' : row.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function LineArea({ rows, area, accent, w, h }: { rows: Row[]; area: boolean; accent: string; w: number; h: number }) {
  const pad = { l: 56, r: 16, t: 24, b: 44 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const max = Math.max(...rows.map(r => r.value), 1);
  const min = Math.min(0, ...rows.map(r => r.value));
  const span = max - min || 1;
  const px = (i: number) => pad.l + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const py = (v: number) => pad.t + ih * (1 - (v - min) / span);
  const pts = rows.map((r, i) => `${px(i)},${py(r.value)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', maxWidth: 640, height: 'auto' }}>
      {[0, 0.5, 1].map(f => {
        const y = pad.t + ih * (1 - f);
        return (
          <g key={f}>
            <line x1={pad.l} y1={y} x2={w - pad.r} y2={y} stroke="#374151" strokeWidth={1} />
            <text x={pad.l - 8} y={y + 4} textAnchor="end" fill="#9ca3af" fontSize={12} fontFamily="system-ui">
              {fmt(min + span * f)}
            </text>
          </g>
        );
      })}
      {area && (
        <polygon
          points={`${px(0)},${pad.t + ih} ${pts} ${px(rows.length - 1)},${pad.t + ih}`}
          fill={accent} opacity={0.22}
        />
      )}
      <polyline points={pts} fill="none" stroke={accent} strokeWidth={3}
        strokeLinejoin="round" strokeLinecap="round" />
      {rows.map((r, i) => (
        <circle key={i} cx={px(i)} cy={py(r.value)} r={4} fill={accent} />
      ))}
      {rows.map((r, i) => rows.length <= 12 && (
        <text key={i} x={px(i)} y={h - pad.b + 20} textAnchor="middle" fill="#9ca3af"
          fontSize={12} fontFamily="system-ui">
          {r.label.length > 8 ? r.label.slice(0, 7) + '…' : r.label}
        </text>
      ))}
    </svg>
  );
}

function Stat({ rows, accent, label }: { rows: Row[]; accent: string; label?: string }) {
  const v = rows[0]?.value ?? 0;
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        fontSize: 110, fontWeight: 800, color: accent, lineHeight: 1,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        textShadow: `0 0 40px ${accent}55`,
      }}>
        {fmt(v)}
      </div>
      {(label || rows[0]?.label) && (
        <div style={{
          marginTop: 14, fontSize: 22, color: '#9ca3af', fontWeight: 600,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          {label || rows[0].label}
        </div>
      )}
    </div>
  );
}

// ── Shared card chrome ──────────────────────────────────────────────────────

function Card({ title, accent, wide, children }: {
  title?: string | null; accent: string; wide?: boolean; children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: '32px 40px',
        borderRadius: 24,
        background: 'rgba(10,14,22,0.78)',
        border: `1px solid ${accent}44`,
        boxShadow: `0 24px 80px rgba(0,0,0,0.55), 0 0 60px ${accent}22`,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        maxWidth: wide ? '80vw' : '70vw',
      }}
    >
      {title && (
        <div style={{
          color: accent, fontSize: 24, fontWeight: 700, marginBottom: 18,
          fontFamily: 'system-ui, -apple-system, sans-serif', letterSpacing: '0.02em',
        }}>
          {title}
        </div>
      )}
      {children}
    </div>
  );
}
