/** One row per task — grouped from plan-check items, used by the feed
 *  checklist card's compact mode. */
export interface TaskRow {
  taskIndex: number;
  /** Short imperative summary of what the task does (plan task title). */
  title: string;
  /** Aggregate status across the task's step/agent items. */
  status: 'ready' | 'needs-agent' | 'needs-steps' | 'failed' | 'running';
  /** Blocking/attention labels merged for non-ready rows. */
  notes: string[];
}

export interface CheckItem {
  id?: string;
  kind?: string;
  label?: string;
  status?: string;
  taskNum?: number;
  detail?: string;
  agentId?: string;
}

/** Group plan-check items into one row per task. Items carry `taskNum`
 *  (1-based, shared/plan-check.cjs) and `detail` (the task title).
 *  `running` marks the task the live run is on (taskNum). */
export function summarizeTasks(items: CheckItem[], runningTask?: number | null): TaskRow[] {
  const byTask = new Map<number, TaskRow>();
  const row = (idx: number): TaskRow => {
    let r = byTask.get(idx);
    if (!r) {
      r = { taskIndex: idx, title: `Task ${idx}`, status: 'ready', notes: [] };
      byTask.set(idx, r);
    }
    return r;
  };

  for (const it of items || []) {
    const idx = typeof it.taskNum === 'number' ? it.taskNum : 0;
    const r = row(idx);
    if (it.detail && idx > 0) r.title = it.detail;
    if (it.status === 'pending' || it.status === 'warn') {
      if (r.status === 'ready') r.status = 'needs-steps';
      if (it.label) r.notes.push(it.label);
    } else if (it.status === 'issue') {
      r.status = it.agentId ? 'needs-agent' : 'failed';
      if (it.label) r.notes.push(it.label);
    }
  }

  const tasks = [...byTask.values()].sort((a, b) => a.taskIndex - b.taskIndex);
  if (typeof runningTask === 'number') {
    const r = tasks.find(t => t.taskIndex === runningTask);
    if (r) r.status = 'running';
  }
  return tasks;
}

export function allReady(tasks: TaskRow[]): boolean {
  return tasks.length > 0 && tasks.every(t => t.status === 'ready' || t.status === 'running');
}

export function statusIcon(status: TaskRow['status']): { glyph: string; color: string } {
  switch (status) {
    case 'ready':       return { glyph: '✓', color: '#4ade80' };
    case 'running':     return { glyph: '◔', color: '#60a5fa' };
    case 'needs-steps': return { glyph: '◔', color: '#fbbf24' };
    case 'needs-agent': return { glyph: '⚠', color: '#fbbf24' };
    case 'failed':      return { glyph: '✕', color: '#f87171' };
  }
}

/** Row renderer. `compact` = the tight readiness-strip variant. */
export function TaskRows({ tasks, compact }: { tasks: TaskRow[]; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 2 : 4 }}>
      {tasks.map(t => {
        const icon = statusIcon(t.status);
        return (
          <div
            key={t.taskIndex}
            title={t.notes.length ? t.notes.join('\n') : t.title}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
              fontSize: compact ? 11.5 : 12,
              fontFamily: 'system-ui, -apple-system, sans-serif',
              lineHeight: compact ? '18px' : '20px',
            }}
          >
            <span style={{ color: icon.color, fontWeight: 800, flexShrink: 0, width: 12, textAlign: 'center' }}>
              {icon.glyph}
            </span>
            <span style={{ color: '#94a3b8', flexShrink: 0 }}>Task {t.taskIndex}</span>
            <span style={{
              color: t.status === 'ready' ? '#cbd5e1' : '#e5e7eb',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}>
              — {t.title}
            </span>
          </div>
        );
      })}
      {tasks.length === 0 && (
        <div style={{ color: '#64748b', fontSize: 11.5, fontStyle: 'italic', padding: '2px 0' }}>
          Drafting — tasks appear as they're planned.
        </div>
      )}
    </div>
  );
}
