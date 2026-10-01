import { Pie, Bar, Line, Area } from '@ant-design/charts';
import type { ScreenChart } from './types';

/**
 * AntChart — interactive charts via @ant-design/charts (antv/g2).
 *
 * Lazy-loaded by ChartScreen so the ~1MB antv bundle only ships when a
 * chart actually displays. All charts consume normalized {label, value}
 * rows (ChartScreen's resolveRows does key-fallback resolution upstream).
 * Dark styling to match the glass card chrome; mood accent is the primary
 * series color.
 */

export interface AntChartProps {
  chart: ScreenChart;
  accent: string;
  rows: { label: string; value: number }[];
  /** Real display height — scales the plot area to the screen it's on. */
  height: number;
}

const PALETTE = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#fb923c'];

const AXIS_STYLE = {
  labelFill: '#e5e7eb',
  labelFontSize: 13,
  titleFill: '#9ca3af',
  gridStroke: '#374151',
  gridLineDash: [3, 4] as number[],
};

/** Compact number format — 83,165 / 1.7T / 38.2B so labels stay readable
 *  at overlay distances. Applied to labels, axes, and the donut total. */
function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return String(Math.round(n * 100) / 100);
}

const TOOLTIP_CSS = `
.g2-tooltip {
  background: rgba(10, 14, 22, 0.94) !important;
  color: #e5e7eb !important;
  border: 1px solid rgba(148, 163, 184, 0.35) !important;
  border-radius: 8px !important;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5) !important;
  font-family: system-ui, -apple-system, sans-serif !important;
}
.g2-tooltip-title { color: #94a3b8 !important; }
.g2-tooltip-list-item-value, .g2-tooltip-list-item { color: #e5e7eb !important; }
`;

export default function AntChart({ chart, accent, rows, height }: AntChartProps) {
  const data = rows.map(r => ({ label: r.label || '(none)', value: r.value }));
  const palette = [accent, ...PALETTE.filter(c => c !== accent)];
  const reduceMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const anim = (cfg: any) => (reduceMotion ? false : { enter: cfg });

  // antv tooltips render DOM inside the container — one style tag covers
  // every chart instance mounted under this component.
  const tooltipCss = <style>{TOOLTIP_CSS}</style>;
  const xAxisCfg = {
    labelFill: AXIS_STYLE.labelFill,
    labelFontSize: AXIS_STYLE.labelFontSize,
    labelAutoRotate: true,   // long labels tilt instead of colliding
    labelAutoHide: true,     // and overflow ticks drop before overlapping
    labelAutoEllipsis: true,
  };
  const yAxisCfg = {
    labelFill: AXIS_STYLE.labelFill,
    labelFontSize: AXIS_STYLE.labelFontSize,
    labelFormatter: (v: any) => fmt(Number(v)),
    grid: true,
    gridStroke: AXIS_STYLE.gridStroke,
    gridLineDash: AXIS_STYLE.gridLineDash,
  };
  const tooltipCfg = {
    title: 'label',
    items: [{ channel: 'y', valueFormatter: (v: any) => fmt(Number(v)) }],
  };

  switch (chart.type) {
    case 'pie':
    case 'donut': {
      const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
      return (
        <>
          {tooltipCss}
          <Pie
            data={data}
            angleField="value"
            colorField="label"
            innerRadius={chart.type === 'donut' ? 0.6 : 0}
            height={height}
            legend={{ color: { position: 'right', itemLabelFill: '#e5e7eb', itemLabelFontSize: 14 } }}
            label={{ text: (d: any) => fmt(d.value), position: 'outside', fill: '#e5e7eb', fontSize: 13 }}
            scale={{ color: { range: palette } }}
            tooltip={tooltipCfg}
            animate={anim({ type: 'waveIn', duration: 600 })}
            annotations={chart.type === 'donut' ? [{
              type: 'text',
              style: {
                text: fmt(total),
                x: '50%', y: '50%',
                fontSize: 30, fontWeight: 800, fill: '#f3f4f6',
                textAlign: 'center', textBaseline: 'middle',
                fontFamily: 'system-ui, -apple-system, sans-serif',
              },
            }] : undefined}
          />
        </>
      );
    }
    case 'bar': {
      return (
        <>
          {tooltipCss}
          <Bar
            data={data}
            xField="label"
            yField="value"
            height={height}
            colorField="label"
            scale={{ color: { range: palette } }}
            legend={false}
            axis={{ x: xAxisCfg, y: yAxisCfg }}
            label={{ text: (d: any) => fmt(d.value), position: 'right', fill: '#e5e7eb', fontSize: 13 }}
            tooltip={tooltipCfg}
            animate={anim({ type: 'growInX', duration: 500 })}
          />
        </>
      );
    }
    case 'line':
    case 'area': {
      const Cmp = chart.type === 'area' ? Area : Line;
      return (
        <>
          {tooltipCss}
          <Cmp
            data={data}
            xField="label"
            yField="value"
            height={height}
            smooth
            point={{ size: 4, shape: 'circle' }}
            style={chart.type === 'area' ? { fill: `${accent}33`, line: { stroke: accent, lineWidth: 3 } } : { stroke: accent, lineWidth: 3 }}
            axis={{ x: xAxisCfg, y: yAxisCfg }}
            tooltip={tooltipCfg}
            animate={anim({ type: 'fadeIn', duration: 500 })}
          />
        </>
      );
    }
    default:
      return null;
  }
}
