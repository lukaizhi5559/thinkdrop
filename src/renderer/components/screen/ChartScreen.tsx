import React, { Suspense, lazy } from 'react';
import type { ScreenChart, ScreenOutput } from './types';
import { MOOD_ACCENT } from './types';

/**
 * ChartScreen — dispatcher for kind:'chart'.
 *
 * pie/donut/bar/line/area render through AntChart (lazy-loaded so the antv
 * bundle only ships when a chart displays); 'stat' stays a custom
 * big-number card. When `output.blocking` is set the chart is interactive —
 * the ghost window captures input — so we show an exit hint; ScreenStage
 * handles backdrop-click and Esc dismissal.
 */

const AntChart = lazy(() => import('./AntChart'));

interface Row { label: string; value: number }

export function resolveRows(chart: ScreenChart): Row[] {
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

  const interactive = output.blocking === true;
  const body = chart.type === 'stat'
    ? <Stat rows={rows} accent={accent} label={chart.label} />
    : (
      <Suspense fallback={
        <div style={{ color: '#94a3b8', fontSize: 15, padding: '60px 120px', fontFamily: 'system-ui' }}>
          Loading chart…
        </div>
      }>
        <div style={{ width: 680, maxWidth: '72vw' }}>
          <AntChart chart={chart} accent={accent} rows={rows} />
        </div>
      </Suspense>
    );

  return (
    <Card title={output.title || chart.label} accent={accent} wide>
      {body}
      {interactive && (
        <div style={{
          marginTop: 16, textAlign: 'center', fontSize: 13, color: '#9ca3af',
          fontFamily: 'system-ui, -apple-system, sans-serif', fontWeight: 500,
        }}>
          Interactive — click outside or press <b style={{ color: accent }}>Esc</b> to exit
        </div>
      )}
    </Card>
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

function Card({ title, accent, wide, children }: {
  title?: string | null; accent: string; wide?: boolean; children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: '32px 40px',
        borderRadius: 24,
        background: 'rgba(10,14,22,0.82)',
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
