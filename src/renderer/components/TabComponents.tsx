import React from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TabId = 'results' | 'queue' | 'cron';

export type QueueStatus = 'waiting' | 'planning' | 'building' | 'testing' | 'done' | 'error';
export interface QueueItem {
  id: string;
  prompt: string;
  status: QueueStatus;
  createdAt: number;
  updatedAt?: number;
  error?: string;
  projectName?: string;
}

export type CronStatus = 'active' | 'idle' | 'paused' | 'error';
export interface CronItem {
  id: string;
  label: string;
  schedule: string;
  nextRun?: string;
  lastRun?: string;
  status: CronStatus;
  plistLabel?: string;
}

// ── Tab bar icons ─────────────────────────────────────────────────────────────

export function ResultsIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke={active ? '#60a5fa' : '#6b7280'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  );
}

export function QueueIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke={active ? '#a78bfa' : '#6b7280'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6"/>
      <line x1="8" y1="12" x2="21" y2="12"/>
      <line x1="8" y1="18" x2="21" y2="18"/>
      <line x1="3" y1="6" x2="3.01" y2="6"/>
      <line x1="3" y1="12" x2="3.01" y2="12"/>
      <line x1="3" y1="18" x2="3.01" y2="18"/>
    </svg>
  );
}

export function CronIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke={active ? '#34d399' : '#6b7280'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

export function TabBar({ active, onSelect, queueCount, cronCount }: {
  active: TabId;
  onSelect: (tab: TabId) => void;
  queueCount: number;
  cronCount: number;
}) {
  const tabs: { id: TabId; label: string; icon: React.ReactNode; badge?: number; activeColor: string }[] = [
    { id: 'results', label: 'Results', icon: <ResultsIcon active={active === 'results'} />, activeColor: '#60a5fa' },
    { id: 'queue',   label: 'Queue',   icon: <QueueIcon   active={active === 'queue'}   />, badge: queueCount, activeColor: '#a78bfa' },
    { id: 'cron',    label: 'Cron',    icon: <CronIcon    active={active === 'cron'}    />, badge: cronCount,  activeColor: '#34d399' },
  ];

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2,
      padding: '0 8px',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      backgroundColor: 'rgba(0,0,0,0.15)',
      flexShrink: 0,
    }}>
      {tabs.map(tab => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 10px',
              border: 'none', background: 'none', cursor: 'pointer',
              borderBottom: isActive ? `2px solid ${tab.activeColor}` : '2px solid transparent',
              marginBottom: -1,
              color: isActive ? tab.activeColor : '#6b7280',
              fontSize: '0.7rem', fontWeight: isActive ? 600 : 400,
              transition: 'all 0.15s',
              position: 'relative',
            }}
            title={tab.label}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge != null && tab.badge > 0 && (
              <span style={{
                fontSize: '0.58rem', fontWeight: 700, minWidth: 14, height: 14,
                borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 3px',
                backgroundColor: isActive ? tab.activeColor : 'rgba(255,255,255,0.15)',
                color: isActive ? '#0f0f0f' : '#9ca3af',
              }}>{tab.badge}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Queue tab ─────────────────────────────────────────────────────────────────

const QUEUE_STATUS_CONFIG: Record<QueueStatus, { label: string; color: string; bg: string; border: string; spin?: boolean }> = {
  waiting:  { label: 'Waiting',  color: '#9ca3af', bg: 'rgba(255,255,255,0.03)',  border: 'rgba(255,255,255,0.07)' },
  planning: { label: 'Planning', color: '#60a5fa', bg: 'rgba(96,165,250,0.06)',   border: 'rgba(96,165,250,0.18)',  spin: true },
  building: { label: 'Building', color: '#a78bfa', bg: 'rgba(167,139,250,0.06)',  border: 'rgba(167,139,250,0.18)', spin: true },
  testing:  { label: 'Testing',  color: '#f59e0b', bg: 'rgba(245,158,11,0.06)',   border: 'rgba(245,158,11,0.18)',  spin: true },
  done:     { label: 'Done',     color: '#4ade80', bg: 'rgba(74,222,128,0.06)',    border: 'rgba(74,222,128,0.18)' },
  error:    { label: 'Error',    color: '#f87171', bg: 'rgba(248,113,113,0.06)',   border: 'rgba(248,113,113,0.18)' },
};

function QueueItemCard({ item, onRerun, onCancel }: {
  item: QueueItem;
  onRerun: (item: QueueItem) => void;
  onCancel: (item: QueueItem) => void;
}) {
  const cfg = QUEUE_STATUS_CONFIG[item.status];
  const isActive = item.status === 'planning' || item.status === 'building' || item.status === 'testing';
  const preview = item.prompt.length > 90 ? item.prompt.slice(0, 90) + '…' : item.prompt;
  const diff = Date.now() - item.createdAt;
  const timeAgo = diff < 60000 ? `${Math.round(diff / 1000)}s ago`
    : diff < 3600000 ? `${Math.round(diff / 60000)}m ago`
    : `${Math.round(diff / 3600000)}h ago`;

  return (
    <div style={{ borderRadius: 9, padding: '10px 12px', backgroundColor: cfg.bg, border: `1px solid ${cfg.border}`, transition: 'all 0.15s' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <div style={{ flexShrink: 0, paddingTop: 3 }}>
          {cfg.spin ? (
            <div style={{ width: 10, height: 10, borderRadius: '50%', border: `2px solid ${cfg.color}`, borderTopColor: 'transparent', animation: 'spin 0.8s linear infinite' }} />
          ) : (
            <div style={{ width: 10, height: 10, borderRadius: '50%',
              backgroundColor: (item.status === 'done' || item.status === 'error') ? cfg.color : 'transparent',
              border: `1.5px solid ${cfg.color}`,
            }} />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          {item.projectName && (
            <span style={{ fontSize: '0.6rem', color: '#a78bfa', fontFamily: 'ui-monospace,monospace',
              background: 'rgba(167,139,250,0.12)', padding: '1px 5px', borderRadius: 3,
              border: '1px solid rgba(167,139,250,0.2)', marginBottom: 4, display: 'inline-block' }}>
              {item.projectName}
            </span>
          )}
          <div style={{ fontSize: '0.71rem', color: '#d1d5db', lineHeight: 1.45, marginTop: item.projectName ? 4 : 0 }}>{preview}</div>
          {item.error && (
            <div style={{ marginTop: 4, fontSize: '0.66rem', color: '#f87171', lineHeight: 1.4 }}>{item.error}</div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <span style={{ fontSize: '0.6rem', color: cfg.color, fontWeight: 600,
              background: cfg.bg, padding: '1px 5px', borderRadius: 3, border: `1px solid ${cfg.border}` }}>
              {cfg.label}
            </span>
            <span style={{ fontSize: '0.6rem', color: '#4b5563' }}>{timeAgo}</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 }}>
          {item.status === 'error' && (
            <button onClick={() => onRerun(item)} style={{
              padding: '3px 8px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer', fontWeight: 600,
              background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.3)', color: '#a78bfa',
            }}>↺ Rerun</button>
          )}
          {isActive && (
            <button onClick={() => onCancel(item)} style={{
              padding: '3px 8px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer',
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171',
            }}>✕</button>
          )}
        </div>
      </div>
    </div>
  );
}

export function QueueTab({ items, onRerun, onCancel }: {
  items: QueueItem[];
  onRerun: (item: QueueItem) => void;
  onCancel: (item: QueueItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '36px 16px', gap: 10, opacity: 0.5 }}>
        <QueueIcon active={false} />
        <span style={{ color: '#6b7280', fontSize: '0.72rem', textAlign: 'center', lineHeight: 1.6 }}>
          No tasks in queue.<br/>Prompts to ThinkDrop will appear here.
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map(item => (
        <QueueItemCard key={item.id} item={item} onRerun={onRerun} onCancel={onCancel} />
      ))}
    </div>
  );
}

// ── Cron tab ──────────────────────────────────────────────────────────────────

const CRON_STATUS_CONFIG: Record<CronStatus, { label: string; color: string; dotColor: string }> = {
  active:  { label: 'Active',  color: '#4ade80', dotColor: '#22c55e' },
  idle:    { label: 'Idle',    color: '#9ca3af', dotColor: '#4b5563' },
  paused:  { label: 'Paused', color: '#f59e0b', dotColor: '#d97706' },
  error:   { label: 'Error',  color: '#f87171', dotColor: '#ef4444' },
};

function CronItemCard({ item, onToggle, onDelete, onRerun }: {
  item: CronItem;
  onToggle: (item: CronItem) => void;
  onDelete: (item: CronItem) => void;
  onRerun: (item: CronItem) => void;
}) {
  const cfg = CRON_STATUS_CONFIG[item.status];
  return (
    <div style={{ borderRadius: 9, padding: '10px 12px',
      backgroundColor: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <div style={{ flexShrink: 0, paddingTop: 3 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: cfg.dotColor,
            boxShadow: item.status === 'active' ? `0 0 6px ${cfg.dotColor}` : 'none' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{ fontSize: '0.72rem', color: '#e5e7eb', fontWeight: 600,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.label}
            </span>
            <span style={{ fontSize: '0.6rem', color: cfg.color, background: 'rgba(255,255,255,0.05)',
              padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(255,255,255,0.08)', flexShrink: 0 }}>
              {cfg.label}
            </span>
          </div>
          <div style={{ fontSize: '0.65rem', color: '#6b7280', display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              {item.schedule}
            </span>
            {item.nextRun && <span style={{ color: '#4b5563' }}>Next: {item.nextRun}</span>}
            {item.lastRun && <span style={{ color: '#374151' }}>Last: {item.lastRun}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button onClick={() => onRerun(item)} title="Run now"
            style={{ padding: '3px 7px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer',
              background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#93c5fd' }}>
            ▶
          </button>
          <button onClick={() => onToggle(item)} title={item.status === 'paused' ? 'Resume' : 'Pause'}
            style={{ padding: '3px 7px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer',
              background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', color: '#fbbf24' }}>
            {item.status === 'paused' ? '⏵' : '⏸'}
          </button>
          <button onClick={() => onDelete(item)} title="Delete"
            style={{ padding: '3px 7px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer',
              background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}>
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

export function CronTab({ items, onToggle, onDelete, onRerun }: {
  items: CronItem[];
  onToggle: (item: CronItem) => void;
  onDelete: (item: CronItem) => void;
  onRerun: (item: CronItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: '36px 16px', gap: 10, opacity: 0.5 }}>
        <CronIcon active={false} />
        <span style={{ color: '#6b7280', fontSize: '0.72rem', textAlign: 'center', lineHeight: 1.6 }}>
          No scheduled tasks.<br/>Queue tasks with schedules appear here.
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map(item => (
        <CronItemCard key={item.id} item={item} onToggle={onToggle} onDelete={onDelete} onRerun={onRerun} />
      ))}
    </div>
  );
}
