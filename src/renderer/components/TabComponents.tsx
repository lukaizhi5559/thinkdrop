import React from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TabId = 'results' | 'queue' | 'cron' | 'skills';

export type QueueStatus = 'waiting' | 'planning' | 'building' | 'testing' | 'skill_building' | 'done' | 'error';
export interface ReviewRound {
  round: number;
  verdict: 'pass' | 'pass-with-warnings' | 'fail';
  score: number | null;
  blockers: string[];
  patches: string[];
}
export interface QueueItem {
  id: string;
  prompt: string;
  status: QueueStatus;
  createdAt: number;
  updatedAt?: number;
  error?: string;
  projectName?: string;
  rounds?: ReviewRound[];
  skillName?: string;
  skillSecrets?: string[];
}

export interface SkillSecret {
  key: string;
  stored: boolean; // whether keytar has a value
}
export type SkillStatus = 'ok' | 'missing_secrets' | 'error';
export interface SkillItem {
  name: string;         // dot-notation: gmail.daily.summary
  filePath: string;     // ~/.thinkdrop/skills/<name>/index.cjs
  trigger: string;
  schedule: string;
  secrets: SkillSecret[];
  status: SkillStatus;
  projectId?: string;
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

export function SkillsIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke={active ? '#f97316' : '#6b7280'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
    </svg>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

export function TabBar({ active, onSelect, queueCount, cronCount, skillsCount, unreadTabs }: {
  active: TabId;
  onSelect: (tab: TabId) => void;
  queueCount: number;
  cronCount: number;
  skillsCount?: number;
  unreadTabs?: Set<TabId>;
}) {
  const tabs: { id: TabId; label: string; icon: React.ReactNode; badge?: number; activeColor: string }[] = [
    { id: 'results', label: 'Results', icon: <ResultsIcon active={active === 'results'} />, activeColor: '#60a5fa' },
    { id: 'queue',   label: 'Queue',   icon: <QueueIcon   active={active === 'queue'}   />, badge: queueCount, activeColor: '#a78bfa' },
    { id: 'cron',    label: 'Cron',    icon: <CronIcon    active={active === 'cron'}    />, badge: cronCount,  activeColor: '#34d399' },
    { id: 'skills',  label: 'Skills',  icon: <SkillsIcon  active={active === 'skills'}  />, activeColor: '#f97316' },
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
            {!isActive && unreadTabs?.has(tab.id) && (
              <span style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                backgroundColor: tab.activeColor,
                boxShadow: `0 0 5px ${tab.activeColor}`,
                animation: 'unread-pulse 2s ease-in-out infinite',
              }} />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Queue tab ─────────────────────────────────────────────────────────────────

const QUEUE_STATUS_CONFIG: Record<QueueStatus, { label: string; color: string; bg: string; border: string; spin?: boolean }> = {
  waiting:       { label: 'Waiting',       color: '#9ca3af', bg: 'rgba(255,255,255,0.03)',  border: 'rgba(255,255,255,0.07)' },
  planning:      { label: 'Planning',      color: '#60a5fa', bg: 'rgba(96,165,250,0.06)',   border: 'rgba(96,165,250,0.18)',  spin: true },
  building:      { label: 'Building',      color: '#a78bfa', bg: 'rgba(167,139,250,0.06)',  border: 'rgba(167,139,250,0.18)', spin: true },
  testing:       { label: 'Testing',       color: '#f59e0b', bg: 'rgba(245,158,11,0.06)',   border: 'rgba(245,158,11,0.18)',  spin: true },
  skill_building:{ label: 'Building Skill',color: '#2dd4bf', bg: 'rgba(45,212,191,0.06)',   border: 'rgba(45,212,191,0.18)', spin: true },
  done:          { label: 'Done',          color: '#4ade80', bg: 'rgba(74,222,128,0.06)',    border: 'rgba(74,222,128,0.18)' },
  error:         { label: 'Error',         color: '#f87171', bg: 'rgba(248,113,113,0.06)',   border: 'rgba(248,113,113,0.18)' },
};

const ROUND_VERDICT_COLOR: Record<string, string> = {
  'pass': '#4ade80',
  'pass-with-warnings': '#f59e0b',
  'fail': '#f87171',
};

function useElapsed(createdAt: number, active: boolean) {
  const [elapsed, setElapsed] = React.useState(Date.now() - createdAt);
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setElapsed(Date.now() - createdAt), 1000);
    return () => clearInterval(t);
  }, [active, createdAt]);
  return elapsed;
}

function QueueItemCard({ item, onRerun, onCancel }: {
  item: QueueItem;
  onRerun: (item: QueueItem) => void;
  onCancel: (item: QueueItem) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const cfg = QUEUE_STATUS_CONFIG[item.status];
  const isActive = item.status === 'planning' || item.status === 'building' || item.status === 'testing' || item.status === 'skill_building';
  const preview = item.prompt.length > 90 ? item.prompt.slice(0, 90) + '…' : item.prompt;
  const elapsed = useElapsed(item.createdAt, isActive);
  const elapsedSec = Math.floor(elapsed / 1000);
  const elapsedStr = elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
  const diff = Date.now() - item.createdAt;
  const timeAgo = diff < 60000 ? `${Math.round(diff / 1000)}s ago`
    : diff < 3600000 ? `${Math.round(diff / 60000)}m ago`
    : `${Math.round(diff / 3600000)}h ago`;
  const rounds = item.rounds || [];
  const hasRounds = rounds.length > 0;
  const lastRound = hasRounds ? rounds[rounds.length - 1] : null;

  return (
    <div style={{ borderRadius: 9, backgroundColor: cfg.bg, border: `1px solid ${cfg.border}`, transition: 'all 0.15s', overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          <div style={{ flexShrink: 0, paddingTop: 2 }}>
            {cfg.spin ? (
              <div style={{ position: 'relative', width: 14, height: 14 }}>
                <div style={{
                  position: 'absolute', inset: 0, borderRadius: '50%',
                  border: `2px solid ${cfg.color}20`,
                }} />
                <div style={{
                  position: 'absolute', inset: 0, borderRadius: '50%',
                  border: `2px solid ${cfg.color}`,
                  borderTopColor: 'transparent',
                  borderRightColor: 'transparent',
                  animation: 'spin 0.9s linear infinite',
                }} />
                <div style={{
                  position: 'absolute', inset: '3px', borderRadius: '50%',
                  backgroundColor: cfg.color,
                  opacity: 0.7,
                }} />
              </div>
            ) : (
              <div style={{ width: 10, height: 10, borderRadius: '50%',
                backgroundColor: (item.status === 'done' || item.status === 'error') ? cfg.color : 'transparent',
                border: `1.5px solid ${cfg.color}`,
                marginTop: 2,
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
            {(item.status === 'planning' || item.status === 'building' || item.status === 'testing') && (
              <div style={{ fontSize: '0.58rem', color: '#4b5563', marginTop: 3, fontStyle: 'italic' }}>
                Building your project — this typically takes 2–5 minutes
              </div>
            )}
            {item.status === 'skill_building' && (
              <div style={{ fontSize: '0.58rem', color: '#2dd4bf', marginTop: 3, fontStyle: 'italic', opacity: 0.8 }}>
                Generating production skill file…
              </div>
            )}
            {item.status === 'done' && item.skillName && (
              <div style={{ marginTop: 5 }}>
                <div style={{ fontSize: '0.62rem', color: '#4ade80', fontFamily: 'ui-monospace,monospace', marginBottom: 3 }}>
                  ✓ {item.skillName}.skill.cjs
                </div>
                {item.skillSecrets && item.skillSecrets.length > 0 && (
                  <div style={{ fontSize: '0.6rem', color: '#6b7280', lineHeight: 1.5 }}>
                    <span style={{ color: '#4b5563' }}>Env vars needed: </span>
                    {item.skillSecrets.map((s, i) => (
                      <span key={s} style={{ color: '#f59e0b', fontFamily: 'ui-monospace,monospace', fontSize: '0.58rem' }}>
                        {s}{i < item.skillSecrets!.length - 1 ? ', ' : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
            {item.error && (
              <div style={{ marginTop: 4, fontSize: '0.66rem', color: '#f87171', lineHeight: 1.4 }}>{item.error}</div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.6rem', color: cfg.color, fontWeight: 600,
                background: cfg.bg, padding: '1px 5px', borderRadius: 3, border: `1px solid ${cfg.border}` }}>
                {cfg.label}
              </span>
              {isActive && (
                <span style={{ fontSize: '0.6rem', color: cfg.color, fontFamily: 'ui-monospace,monospace', opacity: 0.85 }}>
                  {elapsedStr}
                </span>
              )}
              {isActive && lastRound && (
                <span style={{ fontSize: '0.6rem', color: '#9ca3af' }}>
                  R{lastRound.round}
                  {lastRound.score != null && <> · <span style={{ color: ROUND_VERDICT_COLOR[lastRound.verdict] || '#9ca3af' }}>{lastRound.score}</span></>}
                </span>
              )}
              {!isActive && <span style={{ fontSize: '0.6rem', color: '#4b5563' }}>{timeAgo}</span>}
              {hasRounds && (
                <button onClick={() => setExpanded(e => !e)} style={{
                  marginLeft: 'auto', padding: '1px 6px', borderRadius: 4, fontSize: '0.58rem',
                  cursor: 'pointer', background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)', color: '#6b7280',
                }}>{expanded ? '▲ Hide' : `▼ ${rounds.length} round${rounds.length > 1 ? 's' : ''}`}</button>
              )}
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
      {expanded && hasRounds && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '8px 12px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rounds.map(r => {
            const vc = ROUND_VERDICT_COLOR[r.verdict] || '#9ca3af';
            return (
              <div key={r.round} style={{ fontSize: '0.64rem', color: '#d1d5db' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ color: '#6b7280', fontFamily: 'ui-monospace,monospace', fontSize: '0.6rem' }}>R{r.round}</span>
                  <span style={{ color: vc, fontWeight: 600, fontSize: '0.6rem' }}>{r.verdict}</span>
                  {r.score != null && <span style={{ color: '#6b7280', fontSize: '0.6rem' }}>score {r.score}</span>}
                </div>
                {r.blockers.length > 0 && (
                  <div style={{ paddingLeft: 10, borderLeft: `2px solid rgba(248,113,113,0.3)`, marginBottom: 3 }}>
                    {r.blockers.map((b, i) => (
                      <div key={i} style={{ color: '#fca5a5', lineHeight: 1.45, fontSize: '0.62rem', marginBottom: 1 }}>⚠ {b}</div>
                    ))}
                  </div>
                )}
                {r.patches.length > 0 && (
                  <div style={{ paddingLeft: 10, borderLeft: `2px solid rgba(96,165,250,0.3)` }}>
                    {r.patches.map((p, i) => (
                      <div key={i} style={{ color: '#93c5fd', lineHeight: 1.45, fontSize: '0.62rem', marginBottom: 1 }}>→ {p}</div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function QueueTab({ items, onRerun, onCancel }: {
  items: QueueItem[];
  onRerun: (item: QueueItem) => void;
  onCancel: (item: QueueItem) => void;
}) {
  return (
    <>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes unread-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.7); } }
      `}</style>
      {items.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '36px 16px', gap: 10, opacity: 0.5 }}>
          <QueueIcon active={false} />
          <span style={{ color: '#6b7280', fontSize: '0.72rem', textAlign: 'center', lineHeight: 1.6 }}>
            No tasks in queue.<br/>Complex prompts are planned here in the background.
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {items.map(item => (
            <QueueItemCard key={item.id} item={item} onRerun={onRerun} onCancel={onCancel} />
          ))}
        </div>
      )}
    </>
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

// ── Skills tab ────────────────────────────────────────────────────────────────

const SKILL_STATUS_CONFIG: Record<SkillStatus, { label: string; color: string; bg: string; border: string; dot: string }> = {
  ok:              { label: 'Ready',           color: '#4ade80', bg: 'rgba(74,222,128,0.04)',  border: 'rgba(74,222,128,0.16)',  dot: '#22c55e' },
  missing_secrets: { label: 'Missing secrets', color: '#f59e0b', bg: 'rgba(245,158,11,0.04)',  border: 'rgba(245,158,11,0.18)',  dot: '#f59e0b' },
  error:           { label: 'Error',           color: '#f87171', bg: 'rgba(248,113,113,0.04)', border: 'rgba(248,113,113,0.18)', dot: '#ef4444' },
};

function SkillItemCard({ item, onSaveSecret, onOpenCode }: {
  item: SkillItem;
  onSaveSecret: (skillName: string, key: string, value: string) => void;
  onOpenCode: (filePath: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [secretValues, setSecretValues] = React.useState<Record<string, string>>({});
  const [savedKeys, setSavedKeys] = React.useState<Set<string>>(new Set());
  const cfg = SKILL_STATUS_CONFIG[item.status];
  const missingCount = item.secrets.filter(s => !s.stored).length;

  const handleSave = (key: string) => {
    const val = (secretValues[key] || '').trim();
    if (!val) return;
    onSaveSecret(item.name, key, val);
    setSavedKeys(prev => new Set(prev).add(key));
    setSecretValues(prev => ({ ...prev, [key]: '' }));
  };

  return (
    <div style={{ borderRadius: 9, overflow: 'hidden', backgroundColor: cfg.bg, border: `1px solid ${cfg.border}`, transition: 'all 0.15s' }}>

      {/* ── Header: click anywhere to toggle secrets form ── */}
      <div style={{ padding: '10px 12px', cursor: 'pointer', userSelect: 'none' }} onClick={() => setExpanded(e => !e)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>

          {/* Status dot */}
          <div style={{
            width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
            backgroundColor: cfg.dot,
            boxShadow: item.status === 'ok' ? `0 0 5px ${cfg.dot}` : 'none',
          }} />

          {/* Name + status badge */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.72rem', color: '#e5e7eb', fontWeight: 600, fontFamily: 'ui-monospace,monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.name}
              </span>
              <span style={{ fontSize: '0.58rem', color: cfg.color, background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 3, border: `1px solid ${cfg.border}`, flexShrink: 0 }}>
                {cfg.label}
              </span>
              {missingCount > 0 && (
                <span style={{ fontSize: '0.58rem', color: '#f59e0b', background: 'rgba(245,158,11,0.08)', padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(245,158,11,0.2)', flexShrink: 0 }}>
                  {missingCount} secret{missingCount > 1 ? 's' : ''} missing
                </span>
              )}
            </div>
            {item.trigger && (
              <div style={{ fontSize: '0.6rem', color: '#6b7280', marginTop: 2, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                "{item.trigger}"
              </div>
            )}
          </div>

          {/* Open code button */}
          <button
            onClick={(e) => { e.stopPropagation(); onOpenCode(item.filePath); }}
            title="Open skill code"
            style={{ padding: '4px 7px', borderRadius: 5, cursor: 'pointer', flexShrink: 0, background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.2)', color: '#60a5fa', display: 'flex', alignItems: 'center' }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>
            </svg>
          </button>

          {/* Chevron */}
          <span style={{ color: '#4b5563', fontSize: '0.55rem', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Expanded: secrets/env form ── */}
      {expanded && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: '0.6rem', color: '#6b7280', marginBottom: 2 }}>
            Secrets stored securely in keytar — never saved to disk as plain text.
          </div>

          {item.secrets.length === 0 ? (
            <div style={{ fontSize: '0.65rem', color: '#4b5563', fontStyle: 'italic' }}>No secrets required.</div>
          ) : (
            item.secrets.map(secret => {
              const isSaved = savedKeys.has(secret.key);
              return (
                <div key={secret.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {/* Key label + stored badge */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: '0.65rem', color: '#d1d5db', fontFamily: 'ui-monospace,monospace', fontWeight: 600 }}>
                      {secret.key}
                    </span>
                    {secret.stored && !isSaved && (
                      <span style={{ fontSize: '0.55rem', color: '#4ade80', background: 'rgba(74,222,128,0.1)', padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(74,222,128,0.2)' }}>
                        ✓ stored
                      </span>
                    )}
                    {isSaved && (
                      <span style={{ fontSize: '0.55rem', color: '#4ade80', background: 'rgba(74,222,128,0.1)', padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(74,222,128,0.2)' }}>
                        ✓ saved
                      </span>
                    )}
                    {!secret.stored && !isSaved && (
                      <span style={{ fontSize: '0.55rem', color: '#f59e0b', background: 'rgba(245,158,11,0.08)', padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(245,158,11,0.2)' }}>
                        not set
                      </span>
                    )}
                  </div>
                  {/* Value input + Save */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input
                      type="password"
                      placeholder={secret.stored ? '••••••••  (update)' : 'Enter value…'}
                      value={secretValues[secret.key] || ''}
                      onChange={e => setSecretValues(prev => ({ ...prev, [secret.key]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') handleSave(secret.key); }}
                      onClick={e => e.stopPropagation()}
                      style={{
                        flex: 1, padding: '5px 8px', borderRadius: 5, fontSize: '0.65rem',
                        background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                        color: '#e5e7eb', outline: 'none', fontFamily: 'ui-monospace,monospace',
                      }}
                    />
                    <button
                      onClick={(e) => { e.stopPropagation(); handleSave(secret.key); }}
                      disabled={!(secretValues[secret.key] || '').trim()}
                      style={{
                        padding: '5px 10px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer', fontWeight: 600, flexShrink: 0,
                        background: (secretValues[secret.key] || '').trim() ? 'rgba(249,115,22,0.15)' : 'rgba(255,255,255,0.04)',
                        border: (secretValues[secret.key] || '').trim() ? '1px solid rgba(249,115,22,0.35)' : '1px solid rgba(255,255,255,0.08)',
                        color: (secretValues[secret.key] || '').trim() ? '#fb923c' : '#4b5563',
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              );
            })
          )}

          {/* Schedule line */}
          {item.schedule && item.schedule !== 'on_demand' && (
            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 5, fontSize: '0.6rem', color: '#6b7280' }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
              <span style={{ fontFamily: 'ui-monospace,monospace', color: '#34d399' }}>{item.schedule}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SkillsTab({ items, onSaveSecret, onOpenCode }: {
  items: SkillItem[];
  onSaveSecret: (skillName: string, key: string, value: string) => void;
  onOpenCode: (filePath: string) => void;
}) {
  if (items.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '36px 16px', gap: 10, opacity: 0.5 }}>
        <SkillsIcon active={false} />
        <span style={{ color: '#6b7280', fontSize: '0.72rem', textAlign: 'center', lineHeight: 1.6 }}>
          No skills installed yet.<br/>Built skills appear here with their env and secrets.
        </span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map(item => (
        <SkillItemCard key={item.name} item={item} onSaveSecret={onSaveSecret} onOpenCode={onOpenCode} />
      ))}
    </div>
  );
}
