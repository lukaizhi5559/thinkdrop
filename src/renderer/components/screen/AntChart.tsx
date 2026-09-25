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
}

const PALETTE = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#fb923c'];

const AXIS_STYLE = {
  labelFill: '#e5e7eb',
  labelFontSize: 13,
  titleFill: '#9ca3af',
  gridStroke: '#374151',
  gridLineDash: [3, 4] as number[],
};

export default function AntChart({ chart, accent, rows }: AntChartProps) {
  const data = rows.map(r => ({ label: r.label || '(none)', value: r.value }));
  const palette = [accent, ...PALETTE.filter(c => c !== accent)];
  const height = 380;

  switch (chart.type) {
    case 'pie':
    case 'donut': {
      return (
        <Pie
          data={data}
          angleField="value"
          colorField="label"
          innerRadius={chart.type === 'donut' ? 0.6 : 0}
          height={height}
          legend={{ color: { position: 'right', itemLabelFill: '#e5e7eb', itemLabelFontSize: 14 } }}
          label={{ text: 'value', position: 'outside', fill: '#e5e7eb', fontSize: 13 }}
          scale={{ color: { range: palette } }}
          tooltip={{ title: 'label' }}
          animate={{ enter: { type: 'waveIn', duration: 600 } }}
        />
      );
    }
    case 'bar': {
      return (
        <Bar
          data={data}
          xField="label"
          yField="value"
          height={height}
          colorField="label"
          scale={{ color: { range: palette } }}
          legend={false}
          axis={{
            x: { labelFill: AXIS_STYLE.labelFill, labelFontSize: AXIS_STYLE.labelFontSize },
            y: { labelFill: AXIS_STYLE.labelFill, grid: true, gridStroke: AXIS_STYLE.gridStroke, gridLineDash: AXIS_STYLE.gridLineDash },
          }}
          label={{ text: 'value', position: 'right', fill: '#e5e7eb', fontSize: 13 }}
          animate={{ enter: { type: 'growInX', duration: 500 } }}
        />
      );
    }
    case 'line':
    case 'area': {
      const Cmp = chart.type === 'area' ? Area : Line;
      return (
        <Cmp
          data={data}
          xField="label"
          yField="value"
          height={height}
          smooth
          point={{ size: 4, shape: 'circle' }}
          style={chart.type === 'area' ? { fill: `${accent}33`, line: { stroke: accent, lineWidth: 3 } } : { stroke: accent, lineWidth: 3 }}
          axis={{
            x: { labelFill: AXIS_STYLE.labelFill, labelFontSize: AXIS_STYLE.labelFontSize },
            y: { labelFill: AXIS_STYLE.labelFill, grid: true, gridStroke: AXIS_STYLE.gridStroke, gridLineDash: AXIS_STYLE.gridLineDash },
          }}
          animate={{ enter: { type: 'fadeIn', duration: 500 } }}
        />
      );
    }
    default:
      return null;
  }
}
