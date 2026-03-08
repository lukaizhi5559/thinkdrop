import React from 'react';
import SkillStore from './SkillStore';

// ── Types ─────────────────────────────────────────────────────────────────────

export type TabId = 'results' | 'queue' | 'cron' | 'skills' | 'store';

export type QueueStatus = 'waiting' | 'planning' | 'building' | 'testing' | 'skill_building' | 'done' | 'error';

// ── Prompt Queue types (serial stategraph runner) ─────────────────────────────
export type PQStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';
export interface PromptQueueItem {
  id: string;
  prompt: string;
  selectedText: string;
  responseLanguage: string | null;
  status: PQStatus;
  createdAt: number;
  startedAt: number | null;
  doneAt: number | null;
  error: string | null;
}
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
  stored: boolean;       // whether keytar has a value
  preview?: string;      // first 8 chars of stored value for masked display
}
export interface OAuthConnection {
  provider: string;      // 'google' | 'github' | 'microsoft'
  connected: boolean;    // whether a valid token is stored in keytar
  tokenKey: string;      // keytar key, e.g. 'oauth:google:gmail.daily.summary'
  scopes?: string;       // space-separated OAuth scopes
  accountHint?: string;  // e.g. email address for display
}
export type SkillStatus = 'ok' | 'missing_secrets' | 'needs_auth' | 'error';
export interface SkillItem {
  name: string;         // dot-notation: gmail.daily.summary
  filePath: string;     // ~/.thinkdrop/skills/<name>/index.cjs
  trigger: string;
  schedule: string;
  description?: string;
  secrets: SkillSecret[];
  oauthConnections?: OAuthConnection[];
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
  lastError?: string;
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

export function StoreIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke={active ? '#a78bfa' : '#6b7280'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>
    </svg>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

export function TabBar({ active, onSelect, queueCount, cronCount, unreadTabs }: {
  active: TabId;
  onSelect: (tab: TabId) => void;
  queueCount: number;
  cronCount: number;
  unreadTabs?: Set<TabId>;
}) {
  const tabs: { id: TabId; label: string; icon: React.ReactNode; badge?: number; activeColor: string }[] = [
    { id: 'results', label: 'Results', icon: <ResultsIcon active={active === 'results'} />, activeColor: '#60a5fa' },
    { id: 'queue',   label: 'Queue',   icon: <QueueIcon   active={active === 'queue'}   />, badge: queueCount, activeColor: '#a78bfa' },
    { id: 'cron',    label: 'Cron',    icon: <CronIcon    active={active === 'cron'}    />, badge: cronCount,  activeColor: '#34d399' },
    { id: 'skills',  label: 'Skills',  icon: <SkillsIcon  active={active === 'skills'}  />, activeColor: '#f97316' },
    { id: 'store',   label: 'Store',   icon: <StoreIcon   active={active === 'store'}   />, activeColor: '#a78bfa' },
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
            {item.status === 'error' && item.lastError && (
              <span style={{ color: '#f87171', fontSize: '0.62rem', lineHeight: 1.4, wordBreak: 'break-word', maxWidth: 220 }}
                title={item.lastError}>
                ⚠ {item.lastError.length > 60 ? item.lastError.slice(0, 60) + '…' : item.lastError}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button onClick={() => onRerun(item)} title="Run now"
            style={{ padding: '4px 7px', borderRadius: 5, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.25)', color: '#93c5fd' }}>
            {/* Replay / re-run icon — circular arrow */}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-4.57"/>
            </svg>
          </button>
          <button onClick={() => onToggle(item)} title={item.status === 'paused' ? 'Resume' : 'Pause'}
            style={{ padding: '4px 7px', borderRadius: 5, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: item.status === 'paused' ? 'rgba(74,222,128,0.1)' : 'rgba(245,158,11,0.1)',
              border: item.status === 'paused' ? '1px solid rgba(74,222,128,0.25)' : '1px solid rgba(245,158,11,0.25)',
              color: item.status === 'paused' ? '#4ade80' : '#fbbf24' }}>
            {item.status === 'paused' ? (
              /* Play triangle for resume */
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <polygon points="5,3 19,12 5,21"/>
              </svg>
            ) : (
              /* Two bars for pause */
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>
              </svg>
            )}
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
  needs_auth:      { label: 'Needs auth',      color: '#60a5fa', bg: 'rgba(96,165,250,0.04)',  border: 'rgba(96,165,250,0.18)',  dot: '#3b82f6' },
  error:           { label: 'Error',           color: '#f87171', bg: 'rgba(248,113,113,0.04)', border: 'rgba(248,113,113,0.18)', dot: '#ef4444' },
};

const OAUTH_PROVIDER_META: Record<string, { label: string; color: string }> = {
  google:     { label: 'Google',              color: '#4285F4' },
  github:     { label: 'GitHub',              color: '#e5e7eb' },
  microsoft:  { label: 'Microsoft',           color: '#00a4ef' },
  facebook:   { label: 'Facebook / Meta',     color: '#1877F2' },
  twitter:    { label: 'Twitter / X',         color: '#1DA1F2' },
  linkedin:   { label: 'LinkedIn',            color: '#0A66C2' },
  slack:      { label: 'Slack',               color: '#4A154B' },
  notion:     { label: 'Notion',              color: '#e5e7eb' },
  spotify:    { label: 'Spotify',             color: '#1DB954' },
  dropbox:    { label: 'Dropbox',             color: '#0061FF' },
  discord:    { label: 'Discord',             color: '#5865F2' },
  zoom:       { label: 'Zoom',                color: '#2D8CFF' },
  atlassian:  { label: 'Atlassian (Jira)',    color: '#0052CC' },
  salesforce: { label: 'Salesforce',          color: '#00A1E0' },
  hubspot:    { label: 'HubSpot',             color: '#FF7A59' },
};

// ── Known scopes per provider: { value, label, description } ─────────────────
const OAUTH_KNOWN_SCOPES: Record<string, { value: string; label: string; desc: string }[]> = {
  google: [
    { value: 'https://www.googleapis.com/auth/userinfo.email',   label: 'Email (identity)',  desc: 'Read your email address' },
    { value: 'https://www.googleapis.com/auth/userinfo.profile', label: 'Profile',           desc: 'Read your basic profile' },
    { value: 'https://www.googleapis.com/auth/gmail.readonly',   label: 'Gmail read-only',   desc: 'Read (but not send) Gmail messages' },
    { value: 'https://www.googleapis.com/auth/gmail.modify',     label: 'Gmail read+write',  desc: 'Read and modify Gmail messages' },
    { value: 'https://www.googleapis.com/auth/gmail.send',       label: 'Gmail send',        desc: 'Send email on your behalf' },
    { value: 'https://www.googleapis.com/auth/calendar.readonly',label: 'Calendar read',     desc: 'Read calendar events' },
    { value: 'https://www.googleapis.com/auth/calendar',         label: 'Calendar read+write',desc: 'Read and write calendar events' },
    { value: 'https://www.googleapis.com/auth/drive.readonly',   label: 'Drive read',        desc: 'Read files in Google Drive' },
    { value: 'https://www.googleapis.com/auth/drive',            label: 'Drive read+write',  desc: 'Read and write Google Drive files' },
    { value: 'https://www.googleapis.com/auth/spreadsheets',     label: 'Sheets',            desc: 'Read and write Google Sheets' },
    { value: 'https://www.googleapis.com/auth/documents',        label: 'Docs',              desc: 'Read and write Google Docs' },
    { value: 'https://www.googleapis.com/auth/youtube.readonly', label: 'YouTube read',      desc: 'Read YouTube data' },
  ],
  github: [
    { value: 'read:user',   label: 'Read user',    desc: 'Read your public profile' },
    { value: 'user:email',  label: 'Email',        desc: 'Read your email addresses' },
    { value: 'repo',        label: 'Repos (full)', desc: 'Read and write repositories' },
    { value: 'public_repo', label: 'Public repos', desc: 'Read and write public repos only' },
    { value: 'gist',        label: 'Gists',        desc: 'Create and update gists' },
    { value: 'read:org',    label: 'Read org',     desc: 'Read organization info' },
    { value: 'workflow',    label: 'Workflows',    desc: 'Update GitHub Actions workflows' },
  ],
  microsoft: [
    { value: 'openid',              label: 'OpenID',          desc: 'Basic sign-in' },
    { value: 'profile',             label: 'Profile',         desc: 'Read your profile' },
    { value: 'email',               label: 'Email (identity)',desc: 'Read your email address' },
    { value: 'offline_access',      label: 'Offline access',  desc: 'Keep you signed in (refresh token)' },
    { value: 'Mail.Read',           label: 'Mail read',       desc: 'Read your email' },
    { value: 'Mail.ReadWrite',      label: 'Mail read+write', desc: 'Read and modify your email' },
    { value: 'Mail.Send',           label: 'Mail send',       desc: 'Send email on your behalf' },
    { value: 'Calendars.Read',      label: 'Calendar read',   desc: 'Read calendar events' },
    { value: 'Calendars.ReadWrite', label: 'Calendar read+write', desc: 'Read and write calendar events' },
    { value: 'Files.Read',          label: 'Files read',      desc: 'Read OneDrive files' },
    { value: 'Files.ReadWrite',     label: 'Files read+write',desc: 'Read and write OneDrive files' },
    { value: 'Contacts.ReadWrite',  label: 'Contacts',        desc: 'Read and write contacts' },
    { value: 'ChannelMessage.Send', label: 'Teams messages',  desc: 'Send Teams channel messages' },
  ],
  slack: [
    { value: 'openid',           label: 'OpenID',         desc: 'Basic sign-in' },
    { value: 'profile',          label: 'Profile',        desc: 'Read your Slack profile' },
    { value: 'email',            label: 'Email',          desc: 'Read your email address' },
    { value: 'chat:write',       label: 'Send messages',  desc: 'Post messages in channels' },
    { value: 'channels:read',    label: 'Read channels',  desc: 'List public channels' },
    { value: 'channels:history', label: 'Channel history',desc: 'Read messages in channels' },
    { value: 'users:read',       label: 'Read users',     desc: 'List workspace users' },
    { value: 'files:write',      label: 'Upload files',   desc: 'Upload files to Slack' },
    { value: 'reactions:write',  label: 'Add reactions',  desc: 'Add emoji reactions' },
  ],
  github_read: [],
  spotify: [
    { value: 'user-read-email',          label: 'Email',           desc: 'Read your email address' },
    { value: 'user-read-private',        label: 'Private info',    desc: 'Read subscription and country' },
    { value: 'playlist-read-private',    label: 'Read playlists',  desc: 'Read your playlists' },
    { value: 'playlist-modify-public',   label: 'Edit public playlists', desc: 'Create/edit public playlists' },
    { value: 'playlist-modify-private',  label: 'Edit private playlists', desc: 'Create/edit private playlists' },
    { value: 'user-library-read',        label: 'Read library',    desc: 'Read saved tracks/albums' },
    { value: 'user-library-modify',      label: 'Edit library',    desc: 'Save/remove tracks' },
    { value: 'user-top-read',            label: 'Top artists/tracks', desc: 'Read top listening data' },
  ],
  discord: [
    { value: 'identify', label: 'Identity',     desc: 'Read your username and avatar' },
    { value: 'email',    label: 'Email',         desc: 'Read your email address' },
    { value: 'guilds',   label: 'Servers',       desc: 'List servers you belong to' },
    { value: 'guilds.join', label: 'Join servers', desc: 'Add you to a server' },
    { value: 'messages.read', label: 'Read messages', desc: 'Read DMs (limited)' },
  ],
  dropbox: [
    { value: 'account_info.read',  label: 'Account info',   desc: 'Read your account details' },
    { value: 'files.content.read', label: 'Read files',     desc: 'Read files and folders' },
    { value: 'files.content.write',label: 'Write files',    desc: 'Create and edit files' },
    { value: 'sharing.read',       label: 'Read shares',    desc: 'Read shared links' },
    { value: 'sharing.write',      label: 'Create shares',  desc: 'Create shared links' },
  ],
  zoom: [
    { value: 'user:read',           label: 'User info',       desc: 'Read your profile' },
    { value: 'meeting:read',        label: 'Read meetings',   desc: 'List and read meetings' },
    { value: 'meeting:write',       label: 'Write meetings',  desc: 'Create and update meetings' },
    { value: 'recording:read',      label: 'Read recordings', desc: 'Access cloud recordings' },
  ],
  atlassian: [
    { value: 'read:me',                        label: 'Identity',         desc: 'Read your profile' },
    { value: 'offline_access',                 label: 'Offline access',   desc: 'Keep signed in' },
    { value: 'read:jira-work',                 label: 'Read Jira work',   desc: 'Read Jira issues/projects' },
    { value: 'write:jira-work',                label: 'Write Jira work',  desc: 'Create/update Jira issues' },
    { value: 'read:jira-user',                 label: 'Read Jira users',  desc: 'Read Jira user info' },
    { value: 'read:confluence-content.all',    label: 'Read Confluence',  desc: 'Read Confluence pages' },
    { value: 'write:confluence-content',       label: 'Write Confluence', desc: 'Create/edit Confluence pages' },
  ],
  salesforce: [
    { value: 'openid',         label: 'OpenID',       desc: 'Basic sign-in' },
    { value: 'profile',        label: 'Profile',      desc: 'Read your profile' },
    { value: 'email',          label: 'Email',        desc: 'Read your email' },
    { value: 'api',            label: 'API access',   desc: 'Access Salesforce APIs' },
    { value: 'refresh_token',  label: 'Refresh token',desc: 'Stay signed in' },
    { value: 'chatter_api',    label: 'Chatter API',  desc: 'Access Chatter' },
  ],
  hubspot: [
    { value: 'crm.objects.contacts.read',  label: 'Read contacts',  desc: 'Read CRM contacts' },
    { value: 'crm.objects.contacts.write', label: 'Write contacts', desc: 'Create/update contacts' },
    { value: 'crm.objects.deals.read',     label: 'Read deals',     desc: 'Read CRM deals' },
    { value: 'crm.objects.deals.write',    label: 'Write deals',    desc: 'Create/update deals' },
    { value: 'crm.objects.companies.read', label: 'Read companies', desc: 'Read CRM companies' },
    { value: 'content',                    label: 'Content',        desc: 'Access website/blog content' },
  ],
  linkedin: [
    { value: 'openid',        label: 'OpenID',       desc: 'Basic sign-in' },
    { value: 'profile',       label: 'Profile',      desc: 'Read your name and photo' },
    { value: 'email',         label: 'Email',        desc: 'Read your email address' },
    { value: 'w_member_social', label: 'Post',       desc: 'Post on your behalf' },
    { value: 'r_liteprofile', label: 'Lite profile', desc: 'Read basic profile info' },
  ],
  facebook: [
    { value: 'email',          label: 'Email',          desc: 'Read your email address' },
    { value: 'public_profile', label: 'Public profile', desc: 'Read your public profile' },
    { value: 'pages_read_engagement', label: 'Read pages', desc: 'Read Page engagement data' },
    { value: 'pages_manage_posts',    label: 'Manage page posts', desc: 'Create posts on Pages' },
  ],
  twitter: [
    { value: 'tweet.read',     label: 'Read tweets',   desc: 'Read tweets and timelines' },
    { value: 'tweet.write',    label: 'Write tweets',  desc: 'Post tweets on your behalf' },
    { value: 'users.read',     label: 'Read users',    desc: 'Read user profiles' },
    { value: 'offline.access', label: 'Offline access',desc: 'Keep signed in (refresh token)' },
    { value: 'follows.read',   label: 'Read follows',  desc: 'Read who you follow' },
    { value: 'dm.read',        label: 'Read DMs',      desc: 'Read direct messages' },
  ],
  notion: [
    { value: '', label: 'Full access', desc: 'Notion uses a single token scope — all permissions set in the integration settings on notion.so' },
  ],
};

function OAuthConnectRow({ conn, skillName, onConnect, onScopesChange }: {
  conn: OAuthConnection;
  skillName: string;
  onConnect: (skillName: string, provider: string, tokenKey: string, scopes?: string) => void;
  onScopesChange: (skillName: string, provider: string, scopes: string) => void;
}) {
  const [connecting, setConnecting] = React.useState(false);
  const [scopeOpen, setScopeOpen] = React.useState(false);
  const meta = OAUTH_PROVIDER_META[conn.provider] || { label: conn.provider, color: '#9ca3af' };
  const knownScopes = OAUTH_KNOWN_SCOPES[conn.provider] || [];

  // Parse currently active scopes into a Set for checkbox state
  const activeScopes = React.useMemo(
    () => new Set((conn.scopes || '').split(/\s+/).filter(Boolean)),
    [conn.scopes]
  );
  const [selectedScopes, setSelectedScopes] = React.useState<Set<string>>(activeScopes);
  // Sync when conn.scopes changes from parent (after skills:list refresh)
  React.useEffect(() => {
    setSelectedScopes(new Set((conn.scopes || '').split(/\s+/).filter(Boolean)));
  }, [conn.scopes]);

  const handleConnect = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConnecting(true);
    const scopeStr = [...selectedScopes].join(' ');
    onConnect(skillName, conn.provider, conn.tokenKey, scopeStr || conn.scopes);
    setTimeout(() => setConnecting(false), 45000);
  };

  const handleScopeToggle = (scopeValue: string) => {
    if (!scopeValue) return; // notion single-scope case
    setSelectedScopes(prev => {
      const next = new Set(prev);
      if (next.has(scopeValue)) { next.delete(scopeValue); } else { next.add(scopeValue); }
      return next;
    });
  };

  const handleScopesSave = (e: React.MouseEvent) => {
    e.stopPropagation();
    const scopeStr = [...selectedScopes].join(' ');
    onScopesChange(skillName, conn.provider, scopeStr);
    setScopeOpen(false);
  };

  const hasChanges = [...selectedScopes].sort().join(' ') !== [...activeScopes].sort().join(' ');

  // Scopes to display in summary (unknown scopes not in catalog shown as-is)
  const catalogValues = new Set(knownScopes.map(s => s.value));
  const unknownActive = [...activeScopes].filter(s => !catalogValues.has(s));

  return (
    <div style={{
      borderRadius: 7,
      background: conn.connected ? 'rgba(74,222,128,0.04)' : 'rgba(255,255,255,0.03)',
      border: conn.connected ? '1px solid rgba(74,222,128,0.2)' : '1px solid rgba(255,255,255,0.08)',
      overflow: 'hidden',
    }}>
      {/* ── Main row ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Provider dot */}
          <div style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: meta.color, flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: '0.65rem', color: '#d1d5db', fontWeight: 600 }}>
              {meta.label} OAuth
            </div>
            {conn.connected && conn.accountHint && (
              <div style={{ fontSize: '0.58rem', color: '#6b7280', marginTop: 1 }}>{conn.accountHint}</div>
            )}
            {/* Scope summary — click to edit */}
            {knownScopes.length > 0 && (
              <button
                onClick={e => { e.stopPropagation(); setScopeOpen(o => !o); }}
                style={{
                  marginTop: 3, padding: '1px 5px', borderRadius: 3, fontSize: '0.54rem', cursor: 'pointer',
                  background: scopeOpen ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)',
                  border: scopeOpen ? '1px solid rgba(99,102,241,0.4)' : '1px solid rgba(255,255,255,0.1)',
                  color: scopeOpen ? '#a5b4fc' : '#6b7280',
                  fontFamily: 'ui-monospace,monospace', display: 'flex', alignItems: 'center', gap: 4,
                }}
              >
                <span>{[...activeScopes].length} scope{[...activeScopes].length !== 1 ? 's' : ''}</span>
                <span style={{ opacity: 0.6 }}>{scopeOpen ? '▲' : '▼'} edit</span>
              </button>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {conn.connected && (
            <span style={{ fontSize: '0.55rem', color: '#4ade80', background: 'rgba(74,222,128,0.1)', padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(74,222,128,0.2)' }}>
              ✓ connected
            </span>
          )}
          <button
            onClick={handleConnect}
            disabled={connecting}
            style={{
              padding: '4px 10px', borderRadius: 5, fontSize: '0.62rem', cursor: connecting ? 'wait' : 'pointer', fontWeight: 600, flexShrink: 0,
              background: connecting ? 'rgba(255,255,255,0.04)' : conn.connected ? 'rgba(255,255,255,0.06)' : 'rgba(66,133,244,0.12)',
              border: connecting ? '1px solid rgba(255,255,255,0.08)' : conn.connected ? '1px solid rgba(255,255,255,0.12)' : '1px solid rgba(66,133,244,0.35)',
              color: connecting ? '#4b5563' : conn.connected ? '#9ca3af' : '#93bbff',
            }}
          >
            {connecting ? 'Opening…' : conn.connected ? 'Reconnect' : 'Connect'}
          </button>
        </div>
      </div>

      {/* ── Scope editor panel ── */}
      {scopeOpen && (
        <div
          onClick={e => e.stopPropagation()}
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '8px 10px', background: 'rgba(0,0,0,0.2)' }}
        >
          <div style={{ fontSize: '0.58rem', color: '#6b7280', marginBottom: 6 }}>
            Select the permissions this skill needs. Changes apply on next Connect.
            {conn.connected && <span style={{ color: '#f59e0b' }}> You'll need to Reconnect for scope changes to take effect.</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {knownScopes.map(scope => (
              <label
                key={scope.value || 'notion-full'}
                style={{ display: 'flex', alignItems: 'flex-start', gap: 7, cursor: scope.value ? 'pointer' : 'default', padding: '3px 0' }}
              >
                <input
                  type="checkbox"
                  checked={scope.value ? selectedScopes.has(scope.value) : true}
                  disabled={!scope.value}
                  onChange={() => handleScopeToggle(scope.value)}
                  style={{ marginTop: 2, accentColor: meta.color, flexShrink: 0 }}
                />
                <div>
                  <span style={{ fontSize: '0.62rem', color: '#d1d5db', fontWeight: 600 }}>{scope.label}</span>
                  <span style={{ fontSize: '0.57rem', color: '#4b5563', marginLeft: 5 }}>{scope.desc}</span>
                  {scope.value && (
                    <div style={{ fontSize: '0.52rem', color: '#374151', fontFamily: 'ui-monospace,monospace', marginTop: 1 }}>{scope.value}</div>
                  )}
                </div>
              </label>
            ))}
            {unknownActive.map(s => (
              <label key={s} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, cursor: 'pointer', padding: '3px 0' }}>
                <input
                  type="checkbox"
                  checked={selectedScopes.has(s)}
                  onChange={() => handleScopeToggle(s)}
                  style={{ marginTop: 2, accentColor: meta.color, flexShrink: 0 }}
                />
                <div>
                  <span style={{ fontSize: '0.62rem', color: '#9ca3af' }}>{s}</span>
                  <span style={{ fontSize: '0.57rem', color: '#4b5563', marginLeft: 5 }}>custom scope</span>
                </div>
              </label>
            ))}
          </div>
          {hasChanges && (
            <button
              onClick={handleScopesSave}
              style={{
                marginTop: 8, padding: '4px 12px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer', fontWeight: 600,
                background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)', color: '#a5b4fc',
              }}
            >
              Save scope changes
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SkillItemCard({ item, onSaveSecret, onOpenCode, onOAuthConnect, onScopesChange, onDelete }: {
  item: SkillItem;
  onSaveSecret: (skillName: string, key: string, value: string) => void;
  onOpenCode: (filePath: string) => void;
  onOAuthConnect: (skillName: string, provider: string, tokenKey: string, scopes?: string) => void;
  onScopesChange: (skillName: string, provider: string, scopes: string) => void;
  onDelete: (skillName: string) => void;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [secretValues, setSecretValues] = React.useState<Record<string, string>>({});
  const [savedKeys, setSavedKeys] = React.useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const cfg = SKILL_STATUS_CONFIG[item.status];
  const missingCount = item.secrets.filter(s => !s.stored).length;
  const unconnectedOAuth = (item.oauthConnections || []).filter(c => !c.connected).length;
  const totalMissing = missingCount + unconnectedOAuth;

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
              {totalMissing > 0 && (
                <span style={{ fontSize: '0.58rem', color: '#f59e0b', background: 'rgba(245,158,11,0.08)', padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(245,158,11,0.2)', flexShrink: 0 }}>
                  {totalMissing} {totalMissing === 1 ? 'action' : 'actions'} needed
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

          {/* Delete button — two-step confirm */}
          {!confirmDelete ? (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
              title="Delete skill"
              style={{ padding: '4px 7px', borderRadius: 5, cursor: 'pointer', flexShrink: 0, background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)', color: '#f87171', display: 'flex', alignItems: 'center' }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
              </svg>
            </button>
          ) : (
            <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 5, padding: '3px 6px' }}>
              <span style={{ fontSize: '0.58rem', color: '#f87171', whiteSpace: 'nowrap' }}>Delete?</span>
              <button onClick={(e) => { e.stopPropagation(); onDelete(item.name); }} style={{ padding: '2px 6px', borderRadius: 4, cursor: 'pointer', fontSize: '0.58rem', fontWeight: 700, background: 'rgba(239,68,68,0.25)', border: '1px solid rgba(239,68,68,0.5)', color: '#fca5a5' }}>Yes</button>
              <button onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }} style={{ padding: '2px 6px', borderRadius: 4, cursor: 'pointer', fontSize: '0.58rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#6b7280' }}>No</button>
            </div>
          )}

          {/* Chevron */}
          <span style={{ color: '#4b5563', fontSize: '0.55rem', flexShrink: 0 }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* ── Expanded: OAuth + secrets form ── */}
      {expanded && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>

          {/* Description */}
          {item.description && (
            <div style={{ fontSize: '0.63rem', color: '#9ca3af', lineHeight: 1.5, marginBottom: 2 }}>
              {item.description}
            </div>
          )}

          {/* ── OAuth connections ── */}
          {(item.oauthConnections || []).length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: '0.58rem', color: '#4b5563', marginBottom: 1 }}>
                OAuth — authenticate once, skill uses the stored token automatically.
              </div>
              {(item.oauthConnections || []).map(conn => (
                <OAuthConnectRow
                  key={conn.provider}
                  conn={conn}
                  skillName={item.name}
                  onConnect={onOAuthConnect}
                  onScopesChange={onScopesChange}
                />
              ))}
            </div>
          )}

          {/* ── API key secrets ── */}
          {item.secrets.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: '0.58rem', color: '#4b5563' }}>
                API keys — stored securely in keytar, never on disk as plain text.
              </div>
              {item.secrets.map(secret => {
                const isSaved = savedKeys.has(secret.key);
                const maskedCurrent = secret.stored && secret.preview
                  ? secret.preview + '••••••••'
                  : secret.stored ? '••••••••' : null;
                return (
                  <div key={secret.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
                          ✓ updated
                        </span>
                      )}
                      {!secret.stored && !isSaved && (
                        <span style={{ fontSize: '0.55rem', color: '#f59e0b', background: 'rgba(245,158,11,0.08)', padding: '1px 5px', borderRadius: 3, border: '1px solid rgba(245,158,11,0.2)' }}>
                          not set
                        </span>
                      )}
                    </div>
                    {maskedCurrent && !isSaved && (
                      <div style={{ fontSize: '0.6rem', color: '#6b7280', fontFamily: 'ui-monospace,monospace', letterSpacing: '0.02em' }}>
                        {maskedCurrent}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input
                        type="password"
                        placeholder={secret.stored ? 'Replace value…' : 'Enter value…'}
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
              })}
            </div>
          )}

          {item.secrets.length === 0 && (item.oauthConnections || []).length === 0 && (
            <div style={{ fontSize: '0.65rem', color: '#4b5563', fontStyle: 'italic' }}>No secrets required.</div>
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

export function SkillsTab({ items, onSaveSecret, onOpenCode, onUploadSkill, onOAuthConnect, onScopesChange, onDelete }: {
  items: SkillItem[];
  onSaveSecret: (skillName: string, key: string, value: string) => void;
  onOpenCode: (filePath: string) => void;
  onUploadSkill?: () => void;
  onOAuthConnect: (skillName: string, provider: string, tokenKey: string, scopes?: string) => void;
  onScopesChange: (skillName: string, provider: string, scopes: string) => void;
  onDelete: (skillName: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Upload Skill header button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 2 }}>
        <button
          onClick={onUploadSkill}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 10px', borderRadius: 6, fontSize: '0.62rem', cursor: 'pointer', fontWeight: 600,
            background: 'rgba(249,115,22,0.1)', border: '1px solid rgba(249,115,22,0.3)', color: '#fb923c',
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="17 8 12 3 7 8"/>
            <line x1="12" y1="3" x2="12" y2="15"/>
          </svg>
          Upload Skill
        </button>
      </div>

      {items.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '28px 16px', gap: 10, opacity: 0.5 }}>
          <SkillsIcon active={false} />
          <span style={{ color: '#6b7280', fontSize: '0.72rem', textAlign: 'center', lineHeight: 1.6 }}>
            No skills installed yet.<br/>Built skills appear here with their env and secrets.
          </span>
        </div>
      ) : (
        items.map(item => (
          <SkillItemCard key={item.name} item={item} onSaveSecret={onSaveSecret} onOpenCode={onOpenCode} onOAuthConnect={onOAuthConnect} onScopesChange={onScopesChange} onDelete={onDelete} />
        ))
      )}
    </div>
  );
}

// ── Prompt Queue section (serial stategraph runner) ───────────────────────────

function useElapsedPQ(startedAt: number | null, active: boolean) {
  const [elapsed, setElapsed] = React.useState(startedAt ? Date.now() - startedAt : 0);
  React.useEffect(() => {
    if (!active || !startedAt) return;
    const t = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    return () => clearInterval(t);
  }, [active, startedAt]);
  return elapsed;
}

function PromptQueueItemCard({ item, onCancel }: { item: PromptQueueItem; onCancel: (id: string) => void }) {
  const isRunning = item.status === 'running';
  const elapsed = useElapsedPQ(item.startedAt, isRunning);
  const elapsedSec = Math.floor(elapsed / 1000);
  const elapsedStr = elapsedSec < 60 ? `${elapsedSec}s` : `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`;
  const preview = item.prompt.length > 90 ? item.prompt.slice(0, 90) + '…' : item.prompt;

  const statusColor = isRunning ? '#60a5fa' : '#9ca3af';
  const statusBg   = isRunning ? 'rgba(96,165,250,0.06)' : 'rgba(255,255,255,0.03)';
  const statusBorder = isRunning ? 'rgba(96,165,250,0.18)' : 'rgba(255,255,255,0.07)';
  const statusLabel = isRunning ? 'Running' : 'Waiting';

  return (
    <div style={{ borderRadius: 9, backgroundColor: statusBg, border: `1px solid ${statusBorder}`, padding: '10px 12px', transition: 'all 0.15s' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9 }}>
        <div style={{ flexShrink: 0, paddingTop: 2 }}>
          {isRunning ? (
            <div style={{ position: 'relative', width: 14, height: 14 }}>
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${statusColor}20` }} />
              <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${statusColor}`, borderTopColor: 'transparent', borderRightColor: 'transparent', animation: 'spin 0.9s linear infinite' }} />
              <div style={{ position: 'absolute', inset: '3px', borderRadius: '50%', backgroundColor: statusColor, opacity: 0.7 }} />
            </div>
          ) : (
            <div style={{ width: 10, height: 10, borderRadius: '50%', border: `1.5px solid ${statusColor}`, marginTop: 2 }} />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.71rem', color: '#d1d5db', lineHeight: 1.45 }}>{preview}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.6rem', color: statusColor, fontWeight: 600, background: statusBg, padding: '1px 5px', borderRadius: 3, border: `1px solid ${statusBorder}` }}>
              {statusLabel}
            </span>
            {isRunning && (
              <span style={{ fontSize: '0.6rem', color: statusColor, fontFamily: 'ui-monospace,monospace', opacity: 0.85 }}>{elapsedStr}</span>
            )}
          </div>
        </div>
        {item.status === 'pending' && (
          <button
            onClick={() => onCancel(item.id)}
            style={{ padding: '3px 8px', borderRadius: 5, fontSize: '0.62rem', cursor: 'pointer', flexShrink: 0,
              background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}
          >✕</button>
        )}
      </div>
    </div>
  );
}

export function PromptQueueSection({ items, onCancel }: {
  items: PromptQueueItem[];
  onCancel: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontSize: '0.62rem', color: '#4b5563', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', padding: '0 2px 2px' }}>
        Prompt Queue — {items.length} item{items.length > 1 ? 's' : ''}
      </div>
      {items.map(item => (
        <PromptQueueItemCard key={item.id} item={item} onCancel={onCancel} />
      ))}
    </div>
  );
}

// ── Store tab ─────────────────────────────────────────────────────────────────

export function StoreTab({ initialSearch, onBuildSkill }: {
  initialSearch?: string;
  onBuildSkill?: () => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      <SkillStore
        initialSearch={initialSearch || ''}
        onBuildSkill={onBuildSkill || (() => {})}
      />
    </div>
  );
}
