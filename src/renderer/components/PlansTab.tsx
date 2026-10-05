import React from 'react';

/**
 * PlansTab.tsx — Planning Mode plan list
 *
 * Layout per plan row:
 *   [ status-icon ] - <Untitled | plan name/title>            <created date>
 *   [ continue ] [ run ] [ delete ] [ expand ]
 *
 * Search/filter mirrors QueueTaskCard's QueueFilterBar: sticky search input,
 * collapsible time + status chips, match counts, persisted filter selections.
 *
 * IPC:
 *   invoke 'plan:list'          → { plans: PlanSummary[] }
 *   invoke 'plan:run'           → { ok, blockers? }
 *   invoke 'plan:run-cancel'    → { ok }
 *   invoke 'plan:delete'        → { ok }
 *   invoke 'plan:rename'        → { ok, planName }
 *   send   'planning:set'       → pin planning mode (continue thread)
 *   on     'plan:updated' / 'plan:status' / 'plan:task_progress' / 'plan:complete'
 */

const ipcRenderer = (window as any).electron?.ipcRenderer;

export interface PlanTaskSummary {
  num: number;
  title: string;
  status: string;
  mode: string;
  auth: string;
  agents: string[];
  doneWhen?: string | null;
  result?: string;
}

export interface PlanSummary {
  planId: string;
  file: string;
  title: string;
  name: string | null;
  status: string;
  created: string;
  originalPrompt: string;
  isTaskPlan: boolean;
  tasks: PlanTaskSummary[];
}

// ── Status presentation (SVG icons — no emoji, matching tab-bar style) ────────

const _si = { width: 11, height: 11, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const PencilIcon = () => (<svg {..._si}><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>);
const CheckCircleIcon = () => (<svg {..._si}><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>);
const PlayIcon = () => (<svg {..._si} fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21"/></svg>);
const CheckIcon = () => (<svg {..._si}><polyline points="20 6 9 17 4 12"/></svg>);
const XCircleIcon = () => (<svg {..._si}><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>);
const StopIcon = () => (<svg {..._si}><rect x="6" y="6" width="12" height="12" rx="1"/></svg>);
const CircleIcon = () => (<svg {..._si}><circle cx="12" cy="12" r="9"/></svg>);

const STATUS_META: Record<string, { Icon: React.ComponentType; color: string; label: string }> = {
  drafting:  { Icon: PencilIcon,      color: '#22d3ee', label: 'Drafting' },
  ready:     { Icon: CheckCircleIcon, color: '#4ade80', label: 'Ready' },
  running:   { Icon: PlayIcon,        color: '#60a5fa', label: 'Running' },
  done:      { Icon: CheckIcon,       color: '#4ade80', label: 'Done' },
  failed:    { Icon: XCircleIcon,     color: '#f87171', label: 'Failed' },
  cancelled: { Icon: StopIcon,        color: '#abafb8', label: 'Cancelled' },
};

/** Map a task's stored "**Status**" value (e.g. '⬜ pending', '✅ done') to an icon. */
function _taskStatusIcon(status: string) {
  const s = (status || '').toLowerCase();
  if (s.includes('done') || s.includes('complete')) return <CheckIcon />;
  if (s.includes('fail') || s.includes('error')) return <XCircleIcon />;
  if (s.includes('run') || s.includes('progress')) return <PlayIcon />;
  if (s.includes('skip') || s.includes('cancel')) return <StopIcon />;
  return <CircleIcon />;
}

const STATUS_ORDER = ['drafting', 'ready', 'running', 'done', 'failed', 'cancelled'] as const;
type StatusBucket = typeof STATUS_ORDER[number];

type TimeKey = '1d' | '1w' | '1m' | 'range';
const TIME_CHIPS: { id: TimeKey; label: string; ms: number }[] = [
  { id: '1d', label: '1d', ms: 24 * 60 * 60 * 1000 },
  { id: '1w', label: 'W',  ms: 7 * 24 * 60 * 60 * 1000 },
  { id: '1m', label: 'M',  ms: 30 * 24 * 60 * 60 * 1000 },
];

const FILTER_LS_KEY = 'td.plans.filters.v1';
interface PlanFilters { timeKey: TimeKey | null; rangeFrom: string; rangeTo: string; statusSel: 'all' | StatusBucket[]; }
const DEFAULT_FILTERS: PlanFilters = { timeKey: null, rangeFrom: '', rangeTo: '', statusSel: 'all' };

function _loadFilters(): PlanFilters {
  try {
    const p = JSON.parse(localStorage.getItem(FILTER_LS_KEY) || '');
    return {
      timeKey: p.timeKey ?? null,
      rangeFrom: p.rangeFrom ?? '',
      rangeTo: p.rangeTo ?? '',
      statusSel: p.statusSel === 'all' || Array.isArray(p.statusSel) ? p.statusSel : 'all',
    };
  } catch { return { ...DEFAULT_FILTERS }; }
}

function _matchesSearch(p: PlanSummary, q: string): boolean {
  if (!q) return true;
  return (p.title || '').toLowerCase().includes(q)
    || (p.name || '').toLowerCase().includes(q)
    || (p.originalPrompt || '').toLowerCase().includes(q)
    || p.tasks.some(t => (t.title || '').toLowerCase().includes(q)
      || t.agents.some(a => a.toLowerCase().includes(q)));
}

function _matchesTime(p: PlanSummary, timeKey: TimeKey | null, from: string, to: string): boolean {
  if (!timeKey) return true;
  const ts = new Date(p.created).getTime();
  if (isNaN(ts)) return true;
  if (timeKey === 'range') {
    if (from && ts < new Date(from + 'T00:00:00').getTime()) return false;
    if (to && ts > new Date(to + 'T23:59:59.999').getTime()) return false;
    return true;
  }
  const chip = TIME_CHIPS.find(c => c.id === timeKey);
  return chip ? ts >= Date.now() - chip.ms : true;
}

// ── Small shared bits ─────────────────────────────────────────────────────────

const _chipStyle = (active: boolean, color: string): React.CSSProperties => ({
  padding: '2px 7px', borderRadius: 20, fontSize: '0.63rem', fontWeight: 500,
  cursor: 'pointer', border: `1px solid ${active ? color : 'rgba(255,255,255,0.08)'}`,
  background: active ? `${color}22` : 'transparent',
  color: active ? color : '#abafb8', transition: 'all 0.1s',
  flexShrink: 0, whiteSpace: 'nowrap',
});

const _iconBtn = (color = '#abafb8'): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  padding: '4px 7px', borderRadius: 5, cursor: 'pointer',
  background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
  color, fontSize: '0.62rem', gap: 3, transition: 'background 0.15s',
});

function _fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const sameDay = d >= today;
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Plan card ─────────────────────────────────────────────────────────────────

function PlanCard({ plan, onContinue, onRun, onCancelRun, onDelete, runState }: {
  plan: PlanSummary;
  onContinue: (p: PlanSummary) => void;
  onRun: (p: PlanSummary) => void;
  onCancelRun: (p: PlanSummary) => void;
  onDelete: (p: PlanSummary) => void;
  runState?: { status: string } | null;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  const [nameDraft, setNameDraft] = React.useState('');
  const [confirmDel, setConfirmDel] = React.useState(false);
  const meta = STATUS_META[plan.status] || STATUS_META.drafting;
  const isRunning = plan.status === 'running' || runState?.status === 'running';
  const runnable = plan.isTaskPlan && plan.tasks.length > 0 && !isRunning;
  const doneCount = plan.tasks.filter(t => t.status.includes('done')).length;

  React.useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const _commitRename = () => {
    const v = nameDraft.trim();
    setRenaming(false);
    if (v && ipcRenderer) ipcRenderer.invoke('plan:rename', { planFile: plan.file, planName: v });
  };

  return (
    <div style={{
      border: `1px solid ${isRunning ? 'rgba(96,165,250,0.35)' : 'rgba(255,255,255,0.08)'}`,
      borderRadius: 9, padding: '8px 10px', marginBottom: 8,
      background: 'rgba(255,255,255,0.03)',
    }}>
      {/* Header row: status icon · name · date */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <span style={{ fontSize: '0.8rem', flexShrink: 0, color: meta.color, display: 'flex' }}><meta.Icon /></span>
        {renaming ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={e => setNameDraft(e.target.value)}
            onBlur={_commitRename}
            onKeyDown={e => { if (e.key === 'Enter') _commitRename(); if (e.key === 'Escape') setRenaming(false); }}
            placeholder="history.project.plan"
            style={{
              flex: 1, minWidth: 0, background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(34,211,238,0.4)', borderRadius: 5,
              color: '#e5e7eb', fontSize: '0.72rem', padding: '3px 6px', outline: 'none',
            }}
          />
        ) : (
          <button
            onClick={() => { setNameDraft(plan.name || ''); setRenaming(true); }}
            title={plan.name ? `Rename ${plan.name}` : 'Click to name (dot-syntax)'}
            style={{
              flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 'none',
              cursor: 'text', padding: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: plan.name ? '#22d3ee' : '#e5e7eb', fontSize: '0.74rem', fontWeight: 600,
            }}
          >
            {plan.name || plan.title || 'Untitled'}
            {!plan.name && <span style={{ color: '#6b7280', fontWeight: 400 }}> · Untitled</span>}
          </button>
        )}
        <span style={{ fontSize: '0.6rem', color: '#6b7280', flexShrink: 0 }}>{_fmtDate(plan.created)}</span>
      </div>

      {/* Progress strip when tasks exist */}
      {plan.tasks.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5 }}>
          <div style={{ flex: 1, height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
            <div style={{
              width: `${(doneCount / plan.tasks.length) * 100}%`, height: '100%',
              background: meta.color, transition: 'width 0.3s',
            }} />
          </div>
          <span style={{ fontSize: '0.58rem', color: '#9ca3af', flexShrink: 0 }}>
            {doneCount}/{plan.tasks.length} tasks · {meta.label}
          </span>
        </div>
      )}

      {/* Action row — Continue left; edit/run/delete/expand right-aligned */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 7 }}>
        <button onClick={() => onContinue(plan)} title="Continue planning this thread" style={_iconBtn('#22d3ee')}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          Continue
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
          <button onClick={() => ipcRenderer?.send('plan:open-editor', { planFile: plan.file })}
            title="Open plan file in editor" style={_iconBtn('#a5b4fc')}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
            </svg>
          </button>
          {isRunning ? (
            <button onClick={() => onCancelRun(plan)} title="Cancel this plan run" style={_iconBtn('#f87171')}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <rect x="6" y="6" width="12" height="12" rx="1"/>
              </svg>
              Stop
            </button>
          ) : (
            <button onClick={() => onRun(plan)} disabled={!runnable}
              title={runnable ? 'Run this plan' : plan.isTaskPlan ? 'No tasks to run' : 'Legacy plan format — run from queue card'}
              style={{ ..._iconBtn('#4ade80'), opacity: runnable ? 1 : 0.4, cursor: runnable ? 'pointer' : 'default' }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <polygon points="6 3 20 12 6 21"/>
              </svg>
              Run
            </button>
          )}
          {confirmDel ? (
            <button onClick={() => { setConfirmDel(false); onDelete(plan); }} title="Confirm delete"
              style={{ ..._iconBtn('#f87171'), background: 'rgba(248,113,113,0.18)', border: '1px solid rgba(248,113,113,0.4)', fontWeight: 600 }}>
              Sure?
            </button>
          ) : (
            <button onClick={() => setConfirmDel(true)} title="Delete this plan" style={_iconBtn('#f87171')}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          )}
          <button onClick={() => setExpanded(x => !x)} title={expanded ? 'Collapse' : 'Expand tasks'}
            style={_iconBtn()}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
              style={{ transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Expanded task list */}
      {expanded && (
        <div style={{ marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 7 }}>
          {plan.originalPrompt && (
            <div style={{ fontSize: '0.62rem', color: '#6b7280', marginBottom: 6, fontStyle: 'italic' }}>
              “{plan.originalPrompt.slice(0, 140)}{plan.originalPrompt.length > 140 ? '…' : ''}”
            </div>
          )}
          {plan.tasks.length === 0 && (
            <div style={{ fontSize: '0.64rem', color: '#6b7280' }}>
              {plan.isTaskPlan ? 'No tasks parsed.' : 'Legacy single-pass plan — tasks live in ## Steps.'}
            </div>
          )}
          {plan.tasks.map(t => (
            <div key={t.num} style={{
              display: 'flex', alignItems: 'flex-start', gap: 7, padding: '4px 0',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
            }}>
              <span style={{ flexShrink: 0, color: '#9ca3af', display: 'flex', marginTop: 1 }}>{_taskStatusIcon(t.status)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.66rem', color: '#e5e7eb', fontWeight: 500 }}>{t.title}</div>
                <div style={{ fontSize: '0.58rem', color: '#6b7280', marginTop: 1 }}>
                  {t.agents.join(' · ') || 'auto'} · {t.mode}
                  {t.auth !== 'none-required' && t.auth !== 'unknown' ? ` · ${t.auth}` : t.auth === 'unknown' ? ' · auth?' : ''}
                </div>
                {t.result && (
                  <div style={{ fontSize: '0.58rem', color: '#9ca3af', marginTop: 2 }}>{t.result.slice(0, 140)}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main tab ──────────────────────────────────────────────────────────────────

export function PlansTab({ onContinuePlanning }: {
  /** Pin planning mode for a plan and switch the overlay to the prompt/results view. */
  onContinuePlanning?: (plan: PlanSummary) => void;
}) {
  const [plans, setPlans] = React.useState<PlanSummary[]>([]);
  const [runStates, setRunStates] = React.useState<Record<string, { status: string }>>({});
  const [search, setSearch] = React.useState('');
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [filters, setFilters] = React.useState<PlanFilters>(_loadFilters);
  const [notice, setNotice] = React.useState<string | null>(null);
  const { timeKey, rangeFrom, rangeTo, statusSel } = filters;

  const refresh = React.useCallback(async () => {
    if (!ipcRenderer) return;
    try {
      const [listRes, runsRes] = await Promise.all([
        ipcRenderer.invoke('plan:list'),
        ipcRenderer.invoke('plan:runs').catch(() => ({ runs: [] })),
      ]);
      setPlans(listRes?.plans || []);
      const rs: Record<string, { status: string }> = {};
      for (const r of (runsRes?.runs || [])) rs[r.planId] = { status: r.status };
      setRunStates(rs);
    } catch (_) {}
  }, []);

  React.useEffect(() => {
    refresh();
    if (!ipcRenderer) return;
    const tok = 'PlansTab-refresh';
    const onEvt = () => refresh();
    ipcRenderer.on('plan:updated', onEvt, tok);
    ipcRenderer.on('plan:status', onEvt, tok);
    ipcRenderer.on('plan:task_progress', onEvt, tok);
    ipcRenderer.on('plan:complete', onEvt, tok);
    return () => {
      ['plan:updated', 'plan:status', 'plan:task_progress', 'plan:complete']
        .forEach(ch => ipcRenderer.removeListenerByToken?.(ch, tok));
    };
  }, [refresh]);

  // Persist filter selections (search text intentionally not persisted)
  React.useEffect(() => {
    try { localStorage.setItem(FILTER_LS_KEY, JSON.stringify({ timeKey, rangeFrom, rangeTo, statusSel })); } catch {}
  }, [timeKey, rangeFrom, rangeTo, statusSel]);

  const bucketCounts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of STATUS_ORDER) c[s] = 0;
    for (const p of plans) c[p.status in c ? p.status : 'drafting']++;
    return c;
  }, [plans]);

  const visible = React.useMemo(() => plans.filter(p =>
    (statusSel === 'all' || statusSel.includes(p.status as StatusBucket))
    && _matchesTime(p, timeKey, rangeFrom, rangeTo)
    && _matchesSearch(p, search.toLowerCase().trim())
  ), [plans, statusSel, timeKey, rangeFrom, rangeTo, search]);

  const isCustomized = timeKey !== DEFAULT_FILTERS.timeKey || statusSel !== 'all' || !!search;

  const _onContinue = (p: PlanSummary) => {
    ipcRenderer?.send('planning:set', { active: true, planId: p.planId, planName: p.name, planFile: p.file });
    onContinuePlanning?.(p);
  };

  const _onRun = async (p: PlanSummary) => {
    const res = await ipcRenderer?.invoke('plan:run', { planFile: p.file });
    if (res?.ok === false && res.blockers?.length) {
      setNotice(`Plan blocked — sign in needed: ${res.blockers.map((b: { agentId: string }) => b.agentId).join(', ')}`);
      setTimeout(() => setNotice(null), 6000);
    } else if (res?.ok === false) {
      setNotice(res.error || 'Could not start plan');
      setTimeout(() => setNotice(null), 6000);
    }
    refresh();
  };

  const _onCancelRun = async (p: PlanSummary) => {
    await ipcRenderer?.invoke('plan:run-cancel', { planId: p.planId });
    refresh();
  };

  const _onDelete = async (p: PlanSummary) => {
    await ipcRenderer?.invoke('plan:delete', { planFile: p.file, planId: p.planId });
    refresh();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Sticky filter bar — same structure as QueueTaskCard.QueueFilterBar */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 6, margin: '-16px -16px 0',
        backgroundColor: 'rgba(23,23,23,0.96)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 16px 6px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#abafb8" strokeWidth="2"
              strokeLinecap="round" strokeLinejoin="round"
              style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input type="text" placeholder="Search plans…"
              value={search} onChange={e => setSearch(e.target.value)}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '5px 26px 5px 26px',
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)',
                borderRadius: 7, color: '#e5e7eb', fontSize: '0.74rem', outline: 'none',
              }}
              onFocus={e => { e.currentTarget.style.borderColor = 'rgba(34,211,238,0.5)'; }}
              onBlur={e => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.09)'; }}
            />
            {search && (
              <button onClick={() => setSearch('')}
                style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
                  background: 'none', border: 'none', cursor: 'pointer', color: '#abafb8', fontSize: '0.7rem', padding: 2 }}>
                ✕
              </button>
            )}
          </div>
          <button onClick={() => setFiltersOpen(o => !o)} title={filtersOpen ? 'Hide filters' : 'Show filters'}
            style={{
              position: 'relative', padding: '5px 8px', borderRadius: 6, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: filtersOpen ? 'rgba(34,211,238,0.15)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${filtersOpen ? 'rgba(34,211,238,0.3)' : 'rgba(255,255,255,0.09)'}`,
              color: filtersOpen ? '#22d3ee' : '#abafb8', transition: 'background 0.15s',
            }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
            </svg>
            {isCustomized && (
              <span style={{ position: 'absolute', top: 2, right: 2, width: 5, height: 5, borderRadius: '50%', backgroundColor: '#22d3ee' }} />
            )}
          </button>
        </div>

        {!filtersOpen && (
          <button onClick={() => setFiltersOpen(true)}
            style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            title="Show filters">
            <span style={{ fontSize: '0.6rem', color: '#abafb8' }}>
              {!timeKey ? 'All time' : timeKey === 'range' ? 'Date range' : timeKey} · {statusSel === 'all' ? 'All' : statusSel.map(b => STATUS_META[b]?.label || b).join(' + ')} · {visible.length}/{plans.length}
            </span>
          </button>
        )}

        {filtersOpen && (<>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
            {TIME_CHIPS.map(c => (
              <button key={c.id} onClick={() => setFilters(f => ({ ...f, timeKey: f.timeKey === c.id ? null : c.id }))}
                style={_chipStyle(timeKey === c.id, '#22d3ee')}>
                {c.label}
              </button>
            ))}
            <button onClick={() => setFilters(f => ({ ...f, timeKey: f.timeKey === 'range' ? null : 'range' }))}
              title="Pick a date range"
              style={{ ..._chipStyle(timeKey === 'range', '#22d3ee'), display: 'flex', alignItems: 'center' }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
              </svg>
            </button>
            {timeKey === 'range' && (
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input type="date" value={rangeFrom} onChange={e => setFilters(f => ({ ...f, rangeFrom: e.target.value }))}
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 5, color: '#e5e7eb', fontSize: '0.62rem', padding: '2px 4px', colorScheme: 'dark', outline: 'none' }} />
                <input type="date" value={rangeTo} onChange={e => setFilters(f => ({ ...f, rangeTo: e.target.value }))}
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 5, color: '#e5e7eb', fontSize: '0.62rem', padding: '2px 4px', colorScheme: 'dark', outline: 'none' }} />
              </div>
            )}
            <div style={{ marginLeft: 'auto' }}>
              <button onClick={() => { setFilters({ ...DEFAULT_FILTERS }); setSearch(''); }} title="Clear all filters"
                style={{ padding: '3px 6px', borderRadius: 5, cursor: 'pointer', display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', color: '#9ca3af' }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                </svg>
              </button>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={() => setFilters(f => ({ ...f, statusSel: 'all' }))} style={_chipStyle(statusSel === 'all', '#22d3ee')}>All</button>
            {STATUS_ORDER.map(b => {
              const active = statusSel !== 'all' && statusSel.includes(b);
              return (
                <button key={b}
                  onClick={() => setFilters(f => {
                    const sel = f.statusSel === 'all' ? [] : f.statusSel;
                    const next = sel.includes(b) ? sel.filter(x => x !== b) : [...sel, b];
                    return { ...f, statusSel: next.length === 0 ? 'all' : next };
                  })}
                  style={_chipStyle(active, STATUS_META[b].color)}>
                  {STATUS_META[b].label} {bucketCounts[b]}
                </button>
              );
            })}
          </div>
          <div style={{ color: '#4b5563', fontSize: '0.62rem' }}>
            {visible.length} of {plans.length} plan{plans.length !== 1 ? 's' : ''}
          </div>
        </>)}
      </div>

      {notice && (
        <div style={{ fontSize: '0.64rem', color: '#fbbf24', padding: '6px 2px 0' }}>{notice}</div>
      )}

      {/* Plan list */}
      <div style={{ paddingTop: 8 }}>
        {visible.length === 0 && (
          <div style={{ textAlign: 'center', padding: '28px 12px', color: '#6b7280', fontSize: '0.7rem' }}>
            {plans.length === 0
              ? 'No plans yet — say "let\'s plan …" or tap the plan icon next to the input.'
              : 'No plans match the current filters.'}
          </div>
        )}
        {visible.map(p => (
          <PlanCard key={p.planId} plan={p}
            onContinue={_onContinue}
            onRun={_onRun}
            onCancelRun={_onCancelRun}
            onDelete={_onDelete}
            runState={runStates[p.planId] || null} />
        ))}
      </div>
    </div>
  );
}

export default PlansTab;
