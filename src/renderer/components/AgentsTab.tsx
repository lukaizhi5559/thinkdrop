import React, { useState, useEffect } from 'react';
import type { AgentItem, AgentSkill } from './TabComponents';
import { TrainingPanel } from './TrainingPanel';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface AgentsTabProps {
  items: AgentItem[];
  onRefresh: () => void;
}

// Agent category colors
const categoryColors: Record<string, string> = {
  'Social & Communication': '#3b82f6',
  'Entertainment & Media': '#8b5cf6',
  'Commerce & Finance': '#10b981',
  'Creation & Contribution': '#f59e0b',
  'Consumption & Discovery': '#6b7280',
  'Interactive Entertainment': '#ec4899',
  'Utility': '#64748b',
};

// Status indicator colors
const statusColors: Record<string, string> = {
  pending: '#6b7280',
  learning: '#f59e0b',
  learned: '#10b981',
  needs_training: '#f97316',
};

const statusLabels: Record<string, string> = {
  pending: 'Pending',
  learning: 'Indexing…',
  learned: 'Indexed',
  needs_training: 'Needs scan',
};

// Favicon fetch with fallback
function AgentIcon({ domain, name, size = 32 }: { domain: string; name: string; size?: number }) {
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const radius = Math.round(size * 0.22);

  useEffect(() => {
    if (!domain || error) return;
    
    // Try to fetch favicon from Google's service (reliable)
    const faviconUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
    
    const img = new Image();
    img.onload = () => setIconUrl(faviconUrl);
    img.onerror = () => setError(true);
    img.src = faviconUrl;
  }, [domain, error]);

  if (iconUrl && !error) {
    return (
      <img 
        src={iconUrl} 
        alt={name}
        style={{ 
          width: size, 
          height: size, 
          borderRadius: radius,
          objectFit: 'cover',
          backgroundColor: 'rgba(255,255,255,0.1)'
        }}
        onError={() => setError(true)}
      />
    );
  }

  const svgSize = Math.round(size * 0.5);

  // Fallback: CPU/chip outline SVG — no emoji
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: radius,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(245,158,11,0.12)',
      border: '1px solid rgba(245,158,11,0.2)',
    }}>
      <svg width={svgSize} height={svgSize} viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="9" width="6" height="6" rx="1"/>
        <rect x="4" y="4" width="16" height="16" rx="2"/>
        <line x1="9" y1="4" x2="9" y2="2"/>
        <line x1="12" y1="4" x2="12" y2="2"/>
        <line x1="15" y1="4" x2="15" y2="2"/>
        <line x1="9" y1="20" x2="9" y2="22"/>
        <line x1="12" y1="20" x2="12" y2="22"/>
        <line x1="15" y1="20" x2="15" y2="22"/>
        <line x1="4" y1="9" x2="2" y2="9"/>
        <line x1="4" y1="12" x2="2" y2="12"/>
        <line x1="4" y1="15" x2="2" y2="15"/>
        <line x1="20" y1="9" x2="22" y2="9"/>
        <line x1="20" y1="12" x2="22" y2="12"/>
        <line x1="20" y1="15" x2="22" y2="15"/>
      </svg>
    </div>
  );
}

const SKILL_ERROR_MESSAGES: Record<string, string> = {
  no_locator: 'No selector found — try rescanning',
  no_domain_map: 'Not yet scanned — run Learn first',
  skill_not_found: 'Skill file missing',
  no_start_url: 'No URL configured for this agent',
};

// Compact skill row for atomic skills list (test + edit + refresh + delete)
function CompactSkillRow({
  skill,
  agentId,
  onTest,
  onEdit,
  onRefresh,
  onDelete,
  isTesting,
  isRefreshing,
  errorInfo,
}: {
  skill: AgentSkill;
  agentId: string;
  onTest: (agentId: string, skillName: string, headed: boolean, skillPath?: string) => void;
  onEdit: (skillPath: string) => void;
  onRefresh: (agentId: string, skillName: string, skillPath: string) => void;
  onDelete: (agentId: string, skillName: string, skillPath?: string) => void;
  isTesting?: boolean;
  isRefreshing?: boolean;
  errorInfo?: { reason: string } | null;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [showErrorTooltip, setShowErrorTooltip] = useState(false);
  const isDraft = skill.status === 'draft';
  const hasError = !!errorInfo;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '4px 6px',
      backgroundColor: hasError ? 'rgba(239,68,68,0.04)' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${hasError ? 'rgba(239,68,68,0.18)' : 'rgba(255,255,255,0.05)'}`,
      borderRadius: 4,
      marginBottom: 3,
      gap: 6,
    }}>
      <div style={{
        width: 5,
        height: 5,
        borderRadius: '50%',
        flexShrink: 0,
        backgroundColor: hasError ? '#ef4444' : isDraft ? '#f59e0b' : '#10b981',
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.65rem', color: '#9ca3af', fontFamily: 'ui-monospace,monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {skill.name}
        </div>
      </div>

      {/* Inline error badge */}
      {hasError && (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setShowErrorTooltip(v => !v)}
            title={SKILL_ERROR_MESSAGES[errorInfo!.reason] || 'Test failed'}
            style={{ padding: '1px 4px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: 3, cursor: 'pointer', color: '#f87171', display: 'flex', alignItems: 'center', gap: 2 }}
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
          </button>
          {showErrorTooltip && (
            <div style={{
              position: 'absolute', right: 0, top: '110%', zIndex: 99,
              background: '#1f2937', border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 5, padding: '6px 8px', width: 170,
              boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
            }}>
              <div style={{ fontSize: '0.6rem', color: '#f87171', marginBottom: 4, fontWeight: 600 }}>⚠ Test failed</div>
              <div style={{ fontSize: '0.59rem', color: '#9ca3af', marginBottom: 6, lineHeight: 1.4 }}>
                {SKILL_ERROR_MESSAGES[errorInfo!.reason] || 'Unknown error'}
              </div>
              {skill.skillPath && (
                <button
                  onClick={() => { setShowErrorTooltip(false); onRefresh(agentId, skill.name, skill.skillPath!); }}
                  style={{ width: '100%', padding: '3px 0', background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 3, color: '#818cf8', fontSize: '0.59rem', cursor: 'pointer' }}
                >
                  Rescan skill
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Test */}
      {isTesting ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: 'spin 0.9s linear infinite', color: '#818cf8' }}>
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
      ) : choosing ? (
        <div style={{ display: 'flex', gap: 2 }}>
          <button onClick={() => { setChoosing(false); onTest(agentId, skill.name, false, skill.skillPath); }} title="Run headless" style={{ padding: '2px 4px', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: '#9ca3af', borderRadius: 3, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <path d="M12 2C7.03 2 3 6.03 3 11v7l3-2 2 2 2-2 2 2 2-2 3 2v-7c0-4.97-4.03-9-9-9zm-3 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm6 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"/>
            </svg>
          </button>
          <button onClick={() => { setChoosing(false); onTest(agentId, skill.name, true, skill.skillPath); }} title="Run headed" style={{ padding: '2px 4px', background: 'transparent', border: '1px solid rgba(99,102,241,0.3)', color: '#818cf8', borderRadius: 3, cursor: 'pointer', display: 'flex', alignItems: 'center' }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
          <button onClick={() => setChoosing(false)} title="Cancel" style={{ padding: '2px 4px', background: 'transparent', border: 'none', color: '#4b5563', cursor: 'pointer', fontSize: '0.7rem' }}>×</button>
        </div>
      ) : (
        <button onClick={() => setChoosing(true)} title="Test" style={{ padding: '2px 4px', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 3, cursor: 'pointer', color: '#6b7280', display: 'flex', alignItems: 'center' }}>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21"/></svg>
        </button>
      )}

      {/* Edit — opens skill file */}
      {skill.skillPath && (
        <button 
          onClick={() => onEdit(skill.skillPath!)} 
          title="Edit skill code" 
          style={{ padding: '2px 4px', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 3, cursor: 'pointer', color: '#6b7280', display: 'flex', alignItems: 'center' }}
        >
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
      )}

      {/* Refresh — rescan/regenerate skill */}
      {isRefreshing ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: 'spin 0.9s linear infinite', color: '#f59e0b' }}>
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
      ) : (
        skill.skillPath && (
          <button 
            onClick={() => onRefresh(agentId, skill.name, skill.skillPath!)} 
            title="Rescan this skill" 
            style={{ padding: '2px 4px', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 3, cursor: 'pointer', color: '#6b7280', display: 'flex', alignItems: 'center' }}
          >
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        )
      )}

      {/* Delete */}
      {confirmDelete ? (
        <button onClick={() => { onDelete(agentId, skill.name, skill.skillPath); setConfirmDelete(false); }} style={{ padding: '2px 5px', background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.4)', color: '#ef4444', borderRadius: 3, fontSize: '0.55rem', cursor: 'pointer' }}>sure?</button>
      ) : (
        <button onClick={() => setConfirmDelete(true)} title="Delete" style={{ padding: '2px 4px', background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 3, cursor: 'pointer', color: '#6b7280', display: 'flex', alignItems: 'center' }}>
          <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      )}
    </div>
  );
}

// Individual agent card — matches CronItemCard / SkillItemCard compact style
function AgentCard({ 
  agent, 
  onTrain, 
  onEdit,
  onDelete,
  onTestSkill,
  onDeleteSkill,
  onEditSkill,
  onRefreshSkill,
  testingSkills,
  refreshingSkills,
  failedSkills,
  expanded,
  onToggle,
  highlighted,
  onLogin,
  loginLoading,
  editingStartUrl,
  startUrlValue,
  setStartUrlValue,
  onSaveStartUrl,
  onStartUrlEdit,
  setEditingStartUrl,
  startUrlSaving,
}: { 
  agent: AgentItem;
  onTrain: (agentId: string) => void;
  onEdit: (agentId: string) => void;
  onDelete: (agentId: string) => void;
  onTestSkill: (agentId: string, skillName: string, headed: boolean, skillPath?: string) => void;
  onDeleteSkill: (agentId: string, skillName: string, skillPath?: string) => void;
  onEditSkill: (skillPath: string) => void;
  onRefreshSkill: (agentId: string, skillName: string, skillPath: string) => void;
  testingSkills: Record<string, boolean>;
  refreshingSkills: Record<string, boolean>;
  failedSkills: Record<string, { reason: string; ts: number }>;
  expanded: boolean;
  onToggle: () => void;
  highlighted?: boolean;
  onLogin?: (id: string) => void;
  loginLoading?: boolean;
  editingStartUrl?: string | null;
  startUrlValue?: string;
  setStartUrlValue?: (v: string) => void;
  onSaveStartUrl?: (agentId: string) => void;
  onStartUrlEdit?: (agentId: string, currentUrl: string) => void;
  setEditingStartUrl?: (v: string | null) => void;
  startUrlSaving?: boolean;
}) {
  const categoryColor = categoryColors[agent.category] || '#6b7280';
  const statusColor = statusColors[agent.status] || '#6b7280';
  const isLearning = agent.status === 'learning';
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div style={{
      borderRadius: 9,
      padding: '10px 12px',
      marginBottom: 6,
      backgroundColor: highlighted ? 'rgba(245,158,11,0.06)' : 'rgba(255,255,255,0.025)',
      border: highlighted ? '2px solid rgba(245,158,11,0.5)' : '1px solid rgba(255,255,255,0.07)',
      boxShadow: highlighted ? '0 0 12px rgba(245,158,11,0.15)' : 'none',
      transition: 'border 0.3s, box-shadow 0.3s, background-color 0.3s',
    }}>
      {/* Main row: icon · info · actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>

        {/* Favicon / fallback icon — compact 28px */}
        <div style={{ flexShrink: 0 }}>
          <AgentIcon domain={agent.domain} name={agent.name} size={28} />
        </div>

        {/* Name + domain */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Name row — name + (domain) clickable */}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, overflow: 'hidden' }}>
            <span style={{
              fontSize: '0.72rem',
              fontWeight: 600,
              color: '#e5e7eb',
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}>
              {agent.name}
            </span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                const url = agent.domain ? `https://${agent.domain}` : undefined;
                if (url) ipcRenderer?.send('shell:open-url', url);
              }}
              title={`Open ${agent.domain}`}
              style={{
                fontSize: '0.62rem',
                color: '#6b7280',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                cursor: agent.domain ? 'pointer' : 'default',
                textDecoration: 'none',
                flexShrink: 1,
              }}
              onMouseEnter={(e) => { if (agent.domain) (e.currentTarget as HTMLElement).style.textDecoration = 'underline'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.textDecoration = 'none'; }}
            >
              {agent.domain ? `(${agent.domain})` : ''}
            </span>
          </div>
          {/* Badge row */}
          <div style={{ marginTop: 1, marginBottom: 2 }}>
            <span style={{
              fontSize: '0.58rem',
              padding: '1px 5px',
              borderRadius: 3,
              backgroundColor: categoryColor + '22',
              color: categoryColor,
              border: `1px solid ${categoryColor}44`,
              whiteSpace: 'nowrap',
              display: 'inline-block',
            }}>
              {agent.category}
            </span>
          </div>
          {/* Status row — dot + label + skills count */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: statusColor,
              flexShrink: 0,
              boxShadow: isLearning ? `0 0 5px ${statusColor}` : 'none',
              animation: isLearning ? 'pulse 1.5s infinite' : undefined,
            }} />
            <span style={{ fontSize: '0.62rem', color: '#6b7280' }}>
              {statusLabels[agent.status] || agent.status}
            </span>
            <span style={{ color: '#6b7280' }}>|</span>
            <span 
              style={{
                fontSize: '0.58rem',
                color: (agent.skills?.length ?? 0) === 0 ? '#f59e0b' : '#10b981',
                whiteSpace: 'nowrap',
                userSelect: 'none',
                marginTop: '2px',
              }}
            >
              {(agent.skills?.length ?? 0) === 0
                ? 'No skills'
                : agent.lastScanned
                  ? `Auto-scan · ${agent.skills?.length ?? 0} skill${(agent.skills?.length ?? 0) === 1 ? '' : 's'} · ${new Date(agent.lastScanned).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                  : `${agent.skills?.length ?? 0} skill${(agent.skills?.length ?? 0) === 1 ? '' : 's'}`
              }
            </span>
          </div>
        </div>

        {/* Icon-only action buttons — never overflow */}
        <div style={{ display: 'flex', flexDirection: 'row', gap: 4, flexShrink: 0, alignItems: 'center'}}>
          {/* Scanning indicator (auto-scan when idle) */}
          {isLearning && (
            <button
              disabled
              title="Auto-scanning…"
              style={{
                padding: '4px 7px', borderRadius: 5, cursor: 'not-allowed',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)',
                color: '#f59e0b', opacity: 0.4,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: 'spin 0.9s linear infinite' }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
            </button>
          )}

          {/* Train — lightning bolt, blue */}
          <button
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onTrain(agent.id); }}
            title="Train agent"
            style={{
              padding: '4px 7px',
              borderRadius: 5,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(59,130,246,0.12)',
              border: '1px solid rgba(59,130,246,0.3)',
              color: '#60a5fa',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
          </button>

          {/* Edit — pencil SVG, gray */}
          <button
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onEdit(agent.id); }}
            title="Edit agent"
            style={{
              padding: '4px 7px',
              borderRadius: 5,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: '#9ca3af',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>

          {/* Delete — trash icon with two-click confirm */}
          <button
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              if (confirmDelete) {
                onDelete(agent.id);
              } else {
                setConfirmDelete(true);
                setTimeout(() => setConfirmDelete(false), 3000);
              }
            }}
            title={confirmDelete ? 'Click again to confirm delete' : 'Delete agent'}
            style={{
              padding: confirmDelete ? '4px 6px' : '4px 7px',
              borderRadius: 5,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
              background: confirmDelete ? 'rgba(239,68,68,0.18)' : 'rgba(255,255,255,0.04)',
              border: confirmDelete ? '1px solid rgba(239,68,68,0.45)' : '1px solid rgba(255,255,255,0.1)',
              color: confirmDelete ? '#f87171' : '#6b7280',
              transition: 'all 0.15s',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/>
              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
            </svg>
            {confirmDelete && <span style={{ fontSize: '0.58rem', fontWeight: 600, whiteSpace: 'nowrap' }}>sure?</span>}
          </button>

          {/* Login — key icon, amber (browser agents only) */}
          {onLogin && (
            <button
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); onLogin(agent.id); }}
              disabled={loginLoading}
              title={loginLoading ? 'Opening browser for login…' : 'Sign in to this service'}
              style={{
                padding: '4px 7px',
                borderRadius: 5,
                cursor: loginLoading ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: loginLoading ? 'rgba(245,158,11,0.06)' : 'rgba(245,158,11,0.12)',
                border: '1px solid rgba(245,158,11,0.3)',
                color: '#f59e0b',
                opacity: loginLoading ? 0.5 : 1,
              }}
            >
              {loginLoading ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: 'spin 0.9s linear infinite' }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 5.5m0 0l3 3L22 7l-3-3"/>
                </svg>
              )}
            </button>
          )}

          {/* Expand chevron */}
          <button
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onToggle(); }}
            title={expanded ? 'Collapse' : 'Show details'}
            style={{
              padding: '4px 7px',
              borderRadius: 5,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: expanded ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.04)',
              border: expanded ? '1px solid rgba(99,102,241,0.25)' : '1px solid rgba(255,255,255,0.1)',
              color: expanded ? '#818cf8' : '#6b7280',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              {expanded ? <polyline points="18,15 12,9 6,15"/> : <polyline points="6,9 12,15 18,9"/>}
            </svg>
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)' }}>

          {/* URLs to Index - only show actual URLs, not natural language prompts */}
          {(() => {
            const urls = (agent.userGoals || []).filter(g => 
              g && (g.startsWith('http://') || g.startsWith('https://') || g.startsWith('/'))
            );
            if (urls.length === 0) return null;
            return (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '0.62rem', color: '#4b5563', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                  URLs to Index ({urls.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {urls.map((url, idx) => (
                    <div key={idx} style={{
                      fontSize: '0.62rem',
                      color: '#6b7280',
                      fontFamily: 'ui-monospace,monospace',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {url}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Start URL editing — browser agents only */}
          {onStartUrlEdit && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: '0.62rem', color: '#4b5563', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Start URL
              </div>
              {editingStartUrl === agent.id ? (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <input
                    type="text"
                    value={startUrlValue || ''}
                    onChange={(e) => setStartUrlValue?.(e.target.value)}
                    placeholder="https://example.com"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') onSaveStartUrl?.(agent.id); if (e.key === 'Escape') setEditingStartUrl?.(null); }}
                    style={{
                      flex: 1,
                      fontSize: '0.62rem',
                      fontFamily: 'ui-monospace,monospace',
                      padding: '3px 6px',
                      borderRadius: 4,
                      border: '1px solid rgba(99,102,241,0.4)',
                      backgroundColor: 'rgba(99,102,241,0.06)',
                      color: '#e5e7eb',
                      outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => onSaveStartUrl?.(agent.id)}
                    disabled={startUrlSaving}
                    style={{
                      padding: '3px 8px', borderRadius: 4, fontSize: '0.58rem', fontWeight: 500,
                      backgroundColor: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)',
                      color: '#10b981', cursor: startUrlSaving ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {startUrlSaving ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    onClick={() => setEditingStartUrl?.(null)}
                    style={{
                      padding: '3px 8px', borderRadius: 4, fontSize: '0.58rem',
                      backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                      color: '#6b7280', cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{
                    fontSize: '0.62rem',
                    color: '#6b7280',
                    fontFamily: 'ui-monospace,monospace',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: 1,
                  }}>
                    {(() => {
                      const fm = agent.descriptor?.match(/^---\n([\s\S]*?)\n---/);
                      const startUrl = fm?.[1]?.match(/^start_url\s*[:=]\s*(.+)/m)?.[1]?.trim();
                      return startUrl || agent.domain ? `https://${agent.domain}` : 'Not set';
                    })()}
                  </span>
                  <button
                    onClick={() => {
                      const fm = agent.descriptor?.match(/^---\n([\s\S]*?)\n---/);
                      const current = fm?.[1]?.match(/^start_url\s*[:=]\s*(.+)/m)?.[1]?.trim() || (agent.domain ? `https://${agent.domain}` : '');
                      onStartUrlEdit(agent.id, current);
                    }}
                    style={{
                      padding: '2px 6px', borderRadius: 3, fontSize: '0.58rem',
                      backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                      color: '#6b7280', cursor: 'pointer',
                    }}
                  >
                    Edit
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Learned States */}
          {agent.learnedStates && agent.learnedStates.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: '0.62rem', color: '#4b5563', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Learned Pages
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {agent.learnedStates.map((state) => (
                  <span key={state} style={{
                    fontSize: '0.62rem',
                    padding: '2px 7px',
                    borderRadius: 4,
                    backgroundColor: 'rgba(16,185,129,0.1)',
                    border: '1px solid rgba(16,185,129,0.2)',
                    color: '#10b981',
                  }}>
                    {state.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Atomic Skills Section */}
          {agent.skills && agent.skills.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: '0.62rem', color: '#4b5563', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Atomic Skills ({agent.skills.length})
              </div>
              {agent.skills.map((skill) => (
                <CompactSkillRow
                  key={skill.name}
                  skill={skill}
                  agentId={agent.id}
                  onTest={onTestSkill}
                  onEdit={onEditSkill}
                  onRefresh={onRefreshSkill}
                  onDelete={onDeleteSkill}
                  isTesting={testingSkills[`${agent.id}::${skill.name}`] === true}
                  isRefreshing={refreshingSkills[`${agent.id}::${skill.name}`] === true}
                  errorInfo={failedSkills[`${agent.id}::${skill.name}`] || null}
                />
              ))}
            </div>
          )}

          {agent.lastLearned && (
            <div style={{ marginTop: 8, fontSize: '0.6rem', color: '#4b5563' }}>
              Last learned: {new Date(agent.lastLearned).toLocaleDateString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Note: SkillRow removed — composite skills disabled in Atomic Index model
// Using CompactSkillRow for atomic skills only

// Note: GoalSkillsSection removed — composite skills disabled in Atomic Index model
// Atomic skills are now displayed directly without goal-based grouping

// Edit agent modal — same form as CreateAgentModal but pre-filled, domain read-only
function EditAgentModal({
  isOpen,
  agent,
  onClose,
  onSave,
}: {
  isOpen: boolean;
  agent: AgentItem | null;
  onClose: () => void;
  onSave: (agentId: string, goals: string[], options?: { includeLandingPage?: boolean }) => void;
}) {
  const [goals, setGoals] = useState<string[]>(['']);
  const [includeLandingPage, setIncludeLandingPage] = useState(false);

  useEffect(() => {
    if (agent) {
      const existing = [
        ...(agent.userGoals || []),
        ...(agent.userGoal && !agent.userGoals?.includes(agent.userGoal) ? [agent.userGoal] : []),
      ].filter(Boolean);
      setGoals(existing.length > 0 ? existing : ['']);
      // Default: don't include landing page if URLs are provided
      setIncludeLandingPage(existing.length === 0);
    }
  }, [agent]);

  if (!isOpen || !agent) return null;

  // URL validation helper
  const isValidUrl = (url: string): boolean => {
    if (!url.trim()) return true; // Empty is allowed (will be filtered later)
    return /^https?:\/\/.+/.test(url.trim());
  };

  const addGoal = () => setGoals([...goals, '']);
  const removeGoal = (index: number) => {
    if (goals.length > 1) setGoals(goals.filter((_, i) => i !== index));
  };
  const updateGoal = (index: number, value: string) => {
    const next = [...goals];
    next[index] = value;
    setGoals(next);
  };

  // Filter to only valid URLs (must start with http:// or https://)
  const validUrls = goals.filter(g => {
    const trimmed = g.trim();
    return trimmed.length > 0 && isValidUrl(trimmed);
  });
  
  const hasNoGoalsYet = !agent.userGoals?.length && !agent.userGoal;
  const isNewAgent = (agent.learnedStates?.length ?? 0) === 0 && !agent.lastLearned;

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
    }}>
      <div style={{
        backgroundColor: '#1f2937',
        borderRadius: 12,
        padding: 24,
        width: 450,
        maxWidth: '90vw',
        maxHeight: '80vh',
        overflowY: 'auto',
      }}>
        <h3 style={{ margin: '0 0 6px 0', color: '#fff', fontSize: '1.1rem' }}>{isNewAgent ? 'Set URLs to Index' : 'Edit URLs to Index'}</h3>
        <p style={{ margin: '0 0 16px 0', color: '#6b7280', fontSize: '0.8rem' }}>{agent.domain}</p>

        {hasNoGoalsYet && (
          <div style={{
            marginBottom: 16,
            padding: '10px 14px',
            borderRadius: 8,
            backgroundColor: 'rgba(245,158,11,0.1)',
            border: '1px solid rgba(245,158,11,0.3)',
            color: '#fbbf24',
            fontSize: '0.8rem',
            lineHeight: 1.5,
          }}>
            💡 Add URLs to index for this domain. ThinkDrop will scan each page
            and extract atomic skills (buttons, links, inputs) you can use directly.
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: '0.8rem', color: '#9ca3af', marginBottom: 6 }}>
            Which pages should be scanned for skills?
          </label>
          {goals.map((goal, index) => {
            const trimmed = goal.trim();
            const isInvalid = trimmed.length > 0 && !isValidUrl(trimmed);
            return (
              <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                type="text"
                value={goal}
                onChange={(e) => updateGoal(index, e.target.value)}
                placeholder={`URL ${index + 1}: https://example.com/page`}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRadius: 6,
                  border: `1px solid ${isInvalid ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.1)'}`,
                  backgroundColor: isInvalid ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.05)',
                  color: '#fff',
                  fontSize: '0.9rem',
                }}
              />
              {isInvalid && (
                <span style={{ 
                  color: '#ef4444', 
                  fontSize: '0.7rem', 
                  alignSelf: 'center',
                  whiteSpace: 'nowrap'
                }}>
                  Must start with http:// or https://
                </span>
              )}
              {goals.length > 1 && (
                <button
                  onClick={() => removeGoal(index)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    border: '1px solid rgba(255,255,255,0.2)',
                    backgroundColor: 'transparent',
                    color: '#9ca3af',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          )})}
          <button
            onClick={addGoal}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px dashed rgba(255,255,255,0.3)',
              backgroundColor: 'transparent',
              color: '#9ca3af',
              cursor: 'pointer',
              fontSize: '0.8rem',
              marginTop: 4,
            }}
          >
            + Add Another URL
          </button>
          
          {/* Include landing page checkbox - only show when URLs are provided */}
          {validUrls.length > 0 && (
            <label style={{ 
              display: 'flex', 
              alignItems: 'center', 
              gap: 8, 
              marginTop: 8,
              fontSize: '0.8rem',
              color: '#9ca3af',
              cursor: 'pointer'
            }}>
              <input
                type="checkbox"
                checked={includeLandingPage}
                onChange={(e) => setIncludeLandingPage(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              Also scan landing page ({agent.domain || 'domain root'})
            </label>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
          <button
            onClick={() => { onSave(agent.id, validUrls, { includeLandingPage }); onClose(); }}
            disabled={validUrls.length === 0 && !includeLandingPage}
            style={{
              width: '100%',
              padding: '12px 16px',
              borderRadius: 8,
              border: 'none',
              backgroundColor: (validUrls.length === 0 && !includeLandingPage) ? 'rgba(59,130,246,0.4)' : '#3b82f6',
              color: '#fff',
              cursor: (validUrls.length === 0 && !includeLandingPage) ? 'not-allowed' : 'pointer',
              fontSize: '0.95rem',
              fontWeight: 600,
            }}
          >
            Start Learning
          </button>
          {hasNoGoalsYet && (
            <button
              onClick={() => { onSave(agent.id, []); onClose(); }}
              style={{
                width: '100%',
                padding: '11px 16px',
                borderRadius: 8,
                border: '1px solid rgba(255,255,255,0.2)',
                backgroundColor: 'transparent',
                color: '#d1d5db',
                cursor: 'pointer',
                fontSize: '0.9rem',
              }}
            >
              Skip — Basic Scan
            </button>
          )}
          <button
            onClick={onClose}
            style={{
              width: '100%',
              padding: '10px 16px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.1)',
              backgroundColor: 'transparent',
              color: '#6b7280',
              cursor: 'pointer',
              fontSize: '0.85rem',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const CRED_TYPE_OPTIONS = [
  { value: 'api_key',       label: 'API Key',       keyName: 'api_key' },
  { value: 'token',         label: 'Token',         keyName: 'token' },
  { value: 'username',      label: 'Username',      keyName: 'username' },
  { value: 'password',      label: 'Password',      keyName: 'password' },
  { value: 'client_id',     label: 'Client ID',     keyName: 'client_id' },
  { value: 'client_secret', label: 'Client Secret', keyName: 'client_secret' },
  { value: 'custom',        label: 'Custom…',       keyName: '' },
];

const MODAL_INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '9px 11px',
  borderRadius: 6,
  border: '1px solid rgba(255,255,255,0.12)',
  backgroundColor: 'rgba(255,255,255,0.05)',
  color: '#fff',
  fontSize: '0.88rem',
  boxSizing: 'border-box',
};

const MODAL_LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: '0.75rem',
  color: '#9ca3af',
  marginBottom: 5,
};

// Create Browser Agent modal — URL only
function CreateBrowserAgentModal({
  isOpen,
  onClose,
  onCreate,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (url: string) => void;
}) {
  const [url, setUrl] = useState('');

  if (!isOpen) return null;

  const isValid = url.trim().length > 0;
  const handleCreate = () => {
    if (!isValid) return;
    onCreate(url.trim());
    setUrl('');
    onClose();
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
      <div style={{ backgroundColor: '#1a2030', borderRadius: 12, padding: 24, width: 420, maxWidth: '90vw', border: '1px solid rgba(99,102,241,0.25)', boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(99,102,241,0.18)', border: '1px solid rgba(99,102,241,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
            </svg>
          </div>
          <div>
            <h3 style={{ margin: 0, color: '#fff', fontSize: '0.95rem', fontWeight: 600 }}>Create Browser Agent</h3>
            <p style={{ margin: 0, color: '#6b7280', fontSize: '0.72rem' }}>ThinkDrop will explore and learn the site</p>
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={MODAL_LABEL_STYLE}>Website URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="https://spotify.com"
            autoFocus
            style={MODAL_INPUT_STYLE}
          />
          <p style={{ margin: '5px 0 0 0', fontSize: '0.68rem', color: '#4b5563' }}>
            The domain will be derived automatically from the URL.
          </p>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '8px 15px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: '0.83rem' }}>
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!isValid}
            style={{ padding: '8px 18px', borderRadius: 6, border: 'none', backgroundColor: isValid ? '#6366f1' : 'rgba(99,102,241,0.35)', color: '#fff', cursor: isValid ? 'pointer' : 'not-allowed', fontSize: '0.83rem', fontWeight: 600 }}
          >
            Create Agent
          </button>
        </div>
      </div>
    </div>
  );
}

interface CliCredRow {
  type: string;
  key: string;
  value: string;
}

// Create CLI Agent modal — service name + cliTool + dynamic credential rows
function CreateCliAgentModal({
  isOpen,
  onClose,
  onCreate,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (service: string, cliTool: string, credentials: CliCredRow[]) => void;
}) {
  const [service, setService] = useState('');
  const [cliTool, setCliTool] = useState('');
  const [creds, setCreds] = useState<CliCredRow[]>([{ type: 'api_key', key: 'api_key', value: '' }]);

  if (!isOpen) return null;

  const isValid = service.trim().length > 0;

  const addCred = () => setCreds(prev => [...prev, { type: 'api_key', key: 'api_key', value: '' }]);
  const removeCred = (i: number) => setCreds(prev => prev.filter((_, idx) => idx !== i));
  const updateCred = (i: number, field: keyof CliCredRow, val: string) => {
    setCreds(prev => prev.map((row, idx) => {
      if (idx !== i) return row;
      if (field === 'type') {
        const opt = CRED_TYPE_OPTIONS.find(o => o.value === val);
        return { ...row, type: val, key: opt?.keyName || row.key };
      }
      return { ...row, [field]: val };
    }));
  };

  const handleCreate = () => {
    if (!isValid) return;
    const filled = creds.filter(c => c.key.trim() && c.value.trim());
    onCreate(service.trim(), cliTool.trim(), filled);
    setService(''); setCliTool('');
    setCreds([{ type: 'api_key', key: 'api_key', value: '' }]);
    onClose();
  };

  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
      <div style={{ backgroundColor: '#1a2030', borderRadius: 12, padding: 24, width: 480, maxWidth: '92vw', maxHeight: '86vh', overflowY: 'auto', border: '1px solid rgba(16,185,129,0.22)', boxShadow: '0 16px 48px rgba(0,0,0,0.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(16,185,129,0.15)', border: '1px solid rgba(16,185,129,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
            </svg>
          </div>
          <div>
            <h3 style={{ margin: 0, color: '#fff', fontSize: '0.95rem', fontWeight: 600 }}>Create CLI Agent</h3>
            <p style={{ margin: 0, color: '#6b7280', fontSize: '0.72rem' }}>Register an API-backed service agent</p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 18 }}>
          <div>
            <label style={MODAL_LABEL_STYLE}>Service Name <span style={{ color: '#ef4444' }}>*</span></label>
            <input
              type="text"
              value={service}
              onChange={(e) => setService(e.target.value)}
              placeholder="stripe, sendgrid, openai…"
              autoFocus
              style={MODAL_INPUT_STYLE}
            />
          </div>
          <div>
            <label style={MODAL_LABEL_STYLE}>CLI Tool <span style={{ color: '#6b7280', fontWeight: 400 }}>(optional)</span></label>
            <input
              type="text"
              value={cliTool}
              onChange={(e) => setCliTool(e.target.value)}
              placeholder="stripe, gh, aws…"
              style={MODAL_INPUT_STYLE}
            />
          </div>
        </div>

        <div style={{ marginBottom: 6 }}>
          <label style={{ ...MODAL_LABEL_STYLE, marginBottom: 8 }}>Credentials <span style={{ color: '#6b7280', fontWeight: 400 }}>(optional)</span></label>
          {creds.map((row, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '130px 1fr 1fr 28px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <select
                value={row.type}
                onChange={(e) => updateCred(i, 'type', e.target.value)}
                style={{ ...MODAL_INPUT_STYLE, padding: '8px 8px', fontSize: '0.78rem', cursor: 'pointer', width: '100%' }}
              >
                {CRED_TYPE_OPTIONS.map(o => (
                  <option key={o.value} value={o.value} style={{ backgroundColor: '#1a2030' }}>{o.label}</option>
                ))}
              </select>
              <input
                type="text"
                value={row.key}
                onChange={(e) => updateCred(i, 'key', e.target.value)}
                placeholder="key name"
                style={{ ...MODAL_INPUT_STYLE, fontSize: '0.78rem' }}
              />
              <input
                type="password"
                value={row.value}
                onChange={(e) => updateCred(i, 'value', e.target.value)}
                placeholder="value"
                style={{ ...MODAL_INPUT_STYLE, fontSize: '0.78rem' }}
              />
              <button
                onClick={() => removeCred(i)}
                disabled={creds.length === 1}
                style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5, color: '#6b7280', cursor: creds.length === 1 ? 'default' : 'pointer', padding: '4px', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: creds.length === 1 ? 0.3 : 1 }}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
          ))}
          <button
            onClick={addCred}
            style={{ marginTop: 4, padding: '5px 12px', borderRadius: 5, border: '1px dashed rgba(255,255,255,0.2)', backgroundColor: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: '0.75rem' }}
          >
            + Add credential
          </button>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
          <button onClick={onClose} style={{ padding: '8px 15px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.15)', backgroundColor: 'transparent', color: '#6b7280', cursor: 'pointer', fontSize: '0.83rem' }}>
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!isValid}
            style={{ padding: '8px 18px', borderRadius: 6, border: 'none', backgroundColor: isValid ? '#10b981' : 'rgba(16,185,129,0.3)', color: '#fff', cursor: isValid ? 'pointer' : 'not-allowed', fontSize: '0.83rem', fontWeight: 600 }}
          >
            Create Agent
          </button>
        </div>
      </div>
    </div>
  );
}

// Main Agents Tab component
export function AgentsTab({ items, onRefresh }: AgentsTabProps) {
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [isCreateBrowserModalOpen, setIsCreateBrowserModalOpen] = useState(false);
  const [isCreateCliModalOpen, setIsCreateCliModalOpen] = useState(false);
  const [editModalAgent, setEditModalAgent] = useState<AgentItem | null>(null);
  const [localItems, setLocalItems] = useState<AgentItem[]>(items);
  const [isCreating, setIsCreating] = useState(false);
  const [creatingAgent, setCreatingAgent] = useState<{ agentId: string; domain: string } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [autoScanEnabled, setAutoScanEnabled] = useState<boolean>(false);
  // Training panel state
  const [trainingAgentId, setTrainingAgentId] = useState<string | null>(null);
  // testingSkills: key = "agentId::skillName" → true while test is running
  const [testingSkills, setTestingSkills] = useState<Record<string, boolean>>({});
  // refreshingSkills: key = "agentId::skillName" → true while refresh/rescan is running
  const [refreshingSkills, setRefreshingSkills] = useState<Record<string, boolean>>({});
  // failedSkills: key = "agentId::skillName" → { reason, ts } — auto-clears after 30s
  const [failedSkills, setFailedSkills] = useState<Record<string, { reason: string; ts: number }>>({});

  // Subtab state: 'browser' | 'cli' | 'app'
  const [activeSubtab, setActiveSubtab] = useState<'browser' | 'cli' | 'app'>('browser');

  // CLI Agents state
  const [cliValidating, setCliValidating] = useState<Record<string, boolean>>({});
  const [cliRebuilding, setCliRebuilding] = useState<Record<string, boolean>>({});
  const [cliAuthLoading, setCliAuthLoading] = useState<Record<string, boolean>>({});
  const [cliDetailAgent, setCliDetailAgent] = useState<AgentItem | null>(null);
  const [cliDetailData, setCliDetailData] = useState<{ descriptor?: string; rules?: string[]; failureLog?: string } | null>(null);
  const [cliConfirmDelete, setCliConfirmDelete] = useState<string | null>(null);
  // Collapsible sections state for CLI agent detail
  const [expandedSections, setExpandedSections] = useState({
    learnedRules: true,
    descriptor: true,
    config: true,
  });
  // Descriptor edit mode
  const [isEditingDescriptor, setIsEditingDescriptor] = useState(false);
  const [editedDescriptor, setEditedDescriptor] = useState('');
  // Config fields from descriptor
  const [configFields, setConfigFields] = useState<{key: string; value: string; label: string}[]>([]);
  // Dynamic credential pairs for the editor (key-value with metadata)
  const [credentialPairs, setCredentialPairs] = useState<Array<{ key: string; value: string; isEditing: boolean; isStored: boolean }>>([]);
  // Track which credential is pending delete confirmation (stores the key)
  const [confirmDeleteCredential, setConfirmDeleteCredential] = useState<string | null>(null);
  // Preflight highlight: agentId that needs auth, highlighted when user clicks "Open Agents Tab"
  const [preflightHighlightAgent, setPreflightHighlightAgent] = useState<string | null>(null);
  // Browser login loading state
  const [browserLoginLoading, setBrowserLoginLoading] = useState<Record<string, boolean>>({});
  // Start URL editing state
  const [editingStartUrl, setEditingStartUrl] = useState<string | null>(null);
  const [startUrlValue, setStartUrlValue] = useState('');
  const [startUrlSaving, setStartUrlSaving] = useState(false);

  // Filter agents by type from props (items now includes ALL agents with type field from DB)
  const browserAgents = items.filter(agent => agent.type === 'browser');
  const cliAgents = items.filter(agent => agent.type === 'cli' || agent.type === 'api_key');
  const appAgents = items.filter(agent => agent.type === 'app');

  // Sync props to localItems (fallback for non-DB flow)
  useEffect(() => {
    console.log('AGENT ITEMS:', items)
    setLocalItems(items);
  }, [items]);

  // Preflight highlight: check sessionStorage for agent to highlight (set by UnifiedOverlay when user clicks "Open Agents Tab")
  useEffect(() => {
    try {
      const highlightAgentId = sessionStorage.getItem('preflight:highlight-agent');
      if (highlightAgentId) {
        sessionStorage.removeItem('preflight:highlight-agent');
        setPreflightHighlightAgent(highlightAgentId);
        // Auto-expand the agent card and switch to the right subtab
        setExpandedAgent(highlightAgentId);
        const isCli = cliAgents.some(a => a.id === highlightAgentId);
        const isApp = appAgents.some(a => a.id === highlightAgentId);
        setActiveSubtab(isCli ? 'cli' : isApp ? 'app' : 'browser');
        // Auto-clear highlight after 10s
        setTimeout(() => setPreflightHighlightAgent(null), 10000);
      }
      // Training handoff: auto-start the CDP recorder for the requested agent
      const trainAgentId = sessionStorage.getItem('takeover:train-agent');
      if (trainAgentId) {
        sessionStorage.removeItem('takeover:train-agent');
        setExpandedAgent(trainAgentId);
        const isCli = cliAgents.some(a => a.id === trainAgentId);
        const isApp = appAgents.some(a => a.id === trainAgentId);
        setActiveSubtab(isCli ? 'cli' : isApp ? 'app' : 'browser');
        // Call handleTrain after a short delay to ensure the card is rendered
        setTimeout(() => handleTrain(trainAgentId), 300);
      }
    } catch (_) {}
  }, [items]);

  // Request auto-scan setting on mount
  useEffect(() => {
    if (!ipcRenderer) return;
    ipcRenderer.invoke?.('agents:auto-scan-get')?.then((result: { enabled?: boolean }) => {
      setAutoScanEnabled(!!result?.enabled);
    }).catch(() => {
      setAutoScanEnabled(false);
    });
  }, []);

  // Listen for create-specific events from main process.
  useEffect(() => {
    if (!ipcRenderer) return;

    const handleCreating = (data: { agentId?: string; domain?: string }) => {
      setIsCreating(true);
      setCreateError(null);
      setCreatingAgent({ agentId: data?.agentId || '', domain: data?.domain || '' });
    };

    // Preload strips the IPC event arg — callback receives (data) directly
    const handleCreateError = (data: { message: string }) => {
      setIsCreating(false);
      setCreatingAgent(null);
      setCreateError(data?.message || 'Failed to create agent');
      setTimeout(() => setCreateError(null), 5000);
    };

    // agents:new — emitted right after build_agent succeeds; add immediately to local list
    const handleAgentNew = (agent: AgentItem) => {
      setIsCreating(false);
      setCreatingAgent(null);
      if (agent?.id) {
        setLocalItems(prev => {
          if (prev.some(a => a.id === agent.id)) return prev;
          return [agent, ...prev];
        });
        // Switch to the right subtab so the new agent is visible
        if (agent.type === 'cli' || agent.type === 'api_key') {
          setActiveSubtab('cli');
        } else if (agent.type === 'app') {
          setActiveSubtab('app');
        } else {
          setActiveSubtab('browser');
        }
      }
    };

    // agents:list — full list refresh also signals creation is done
    const handleAgentsList = () => {
      setIsCreating(false);
      setCreatingAgent(null);
    };

    ipcRenderer.on('agents:creating', handleCreating);
    ipcRenderer.on('agents:error', handleCreateError);
    ipcRenderer.on('agents:new', handleAgentNew);
    ipcRenderer.on('agents:list', handleAgentsList);

    return () => {
      ipcRenderer.removeListener('agents:creating', handleCreating);
      ipcRenderer.removeListener('agents:error', handleCreateError);
      ipcRenderer.removeListener('agents:new', handleAgentNew);
      ipcRenderer.removeListener('agents:list', handleAgentsList);
    };
  }, []);

  // Listen for skill test status updates
  useEffect(() => {
    if (!ipcRenderer) return;
    const handleTestUpdate = (data: { agentId: string; skillName: string; status: 'testing' | 'done' | 'error'; errorReason?: string }) => {
      const key = `${data.agentId}::${data.skillName}`;
      setTestingSkills(prev => {
        if (data.status === 'testing') return { ...prev, [key]: true };
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (data.status === 'error') {
        const reason = data.errorReason || 'unknown';
        setFailedSkills(prev => ({ ...prev, [key]: { reason, ts: Date.now() } }));
        setTimeout(() => {
          setFailedSkills(prev => {
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }, 30000);
      } else if (data.status === 'done') {
        setFailedSkills(prev => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    };
    ipcRenderer.on('agents:skill-test-update', handleTestUpdate);
    return () => { ipcRenderer.removeListener('agents:skill-test-update', handleTestUpdate); };
  }, []);

  // Listen for skill refresh status updates
  useEffect(() => {
    if (!ipcRenderer) return;
    const handleRefreshUpdate = (data: { agentId: string; skillName: string; status: 'refreshing' | 'done' | 'error' }) => {
      const key = `${data.agentId}::${data.skillName}`;
      setRefreshingSkills(prev => {
        if (data.status === 'refreshing') return { ...prev, [key]: true };
        const next = { ...prev };
        delete next[key];
        return next;
      });
    };
    ipcRenderer.on('agents:skill-refresh-update', handleRefreshUpdate);
    return () => { ipcRenderer.removeListener('agents:skill-refresh-update', handleRefreshUpdate); };
  }, []);

  const handleTrain = (agentId: string) => {
    setTrainingAgentId(agentId);
    ipcRenderer?.send('agents:train', { agentId });
  };

  const handleTrainSave = (skillName: string) => {
    if (!trainingAgentId) return;
    ipcRenderer?.send('agents:train-save', { agentId: trainingAgentId, skillName });
    setTrainingAgentId(null);
  };

  const handleTrainCancel = () => {
    if (trainingAgentId) {
      ipcRenderer?.send('agents:train-cancel', { agentId: trainingAgentId });
    }
    setTrainingAgentId(null);
  };

  const handleEdit = async (agentId: string) => {
    const agentFile = agentId.endsWith('.agent') ? `${agentId}.md` : `${agentId}.agent.md`;
    const home = (window as any).electron?.homedir?.() || '~';
    const agentMdPath = `${home}/.thinkdrop/agents/${agentFile}`;
    try {
      const result = await ipcRenderer?.invoke('shell:open-path', agentMdPath);
      if (result?.error) {
        setEditError(`Could not open file: ${result.error}`);
        setTimeout(() => setEditError(null), 4000);
      }
    } catch (_) {
      setEditError('Could not open agent descriptor file.');
      setTimeout(() => setEditError(null), 4000);
    }
  };

  const handleEditSave = (agentId: string, goals: string[], options?: { includeLandingPage?: boolean }) => {
    setLocalItems(prev => prev.map(a =>
      a.id === agentId ? { ...a, userGoals: goals } : a
    ));
    // Save goals to backend — auto-scan will pick them up on idle
    ipcRenderer?.send('agents:update-goals', { agentId, goals, options });
  };

  const handleDelete = (agentId: string) => {
    // Optimistically remove from UI immediately
    setLocalItems(prev => prev.filter(a => a.id !== agentId));
    ipcRenderer?.send('agents:delete', { agentId });
  };

  const handleTestSkill = (agentId: string, skillName: string, headed: boolean, skillPath?: string) => {
    const key = `${agentId}::${skillName}`;
    // Clear any previous error when retesting
    setFailedSkills(prev => { const next = { ...prev }; delete next[key]; return next; });
    // Optimistically mark as testing immediately
    setTestingSkills(prev => ({ ...prev, [key]: true }));
    ipcRenderer?.send('agents:test-skill', { agentId, skillName, headed, skillPath });
  };

  const handleDeleteSkill = (agentId: string, skillName: string, skillPath?: string) => {
    ipcRenderer?.send('agents:delete-skill', { agentId, skillName, skillPath });
    // Optimistic update — remove skill from UI immediately
    setLocalItems(prev => prev.map(agent =>
      agent.id === agentId
        ? { ...agent, skills: agent.skills?.filter(s => s.name !== skillName) }
        : agent
    ));
  };

  const handleEditSkill = (skillPath: string) => {
    // Open the skill directory in the default file manager
    ipcRenderer?.send('shell:open-path', skillPath);
  };

  const handleRefreshSkill = (agentId: string, skillName: string, skillPath: string) => {
    // Optimistically mark as refreshing immediately
    setRefreshingSkills(prev => ({ ...prev, [`${agentId}::${skillName}`]: true }));
    // Send request to refresh/rescan this specific skill
    ipcRenderer?.send('agents:refresh-skill', { agentId, skillName, skillPath });
  };

  const handleCreateBrowserAgent = (url: string) => {
    setIsCreating(true);
    setCreateError(null);
    let domain = url;
    try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}
    ipcRenderer?.send('agents:create', { domain, goals: [], headed: true });
  };

  const handleCreateCliAgent = async (service: string, cliTool: string, credentials: CliCredRow[]) => {
    setIsCreating(true);
    setCreateError(null);
    try {
      const result = await ipcRenderer?.invoke('cli-agents:create', { service, cliTool, credentials });
      if (!result?.ok) {
        setCreateError(result?.error || 'Failed to create CLI agent');
        setTimeout(() => setCreateError(null), 5000);
      }
    } catch (e: any) {
      setCreateError(e?.message || 'Failed to create CLI agent');
      setTimeout(() => setCreateError(null), 5000);
    } finally {
      setIsCreating(false);
      onRefresh?.();
    }
  };

  const toggleExpanded = (agentId: string) => {
    setExpandedAgent(expandedAgent === agentId ? null : agentId);
  };

  // ── CLI Agents handlers ──────────────────────────────────────────────────
  const handleCliValidate = async (id: string) => {
    setCliValidating(prev => ({ ...prev, [id]: true }));
    try {
      await ipcRenderer?.invoke('cli-agents:validate', { id });
      onRefresh?.(); // Refresh parent to get updated agents list
    } finally {
      setCliValidating(prev => { const n = { ...prev }; delete n[id]; return n; });
    }
  };

  const handleCliRebuild = async (id: string, service: string) => {
    setCliRebuilding(prev => ({ ...prev, [id]: true }));
    try {
      await ipcRenderer?.invoke('cli-agents:rebuild', { service });
      onRefresh?.(); // Refresh parent to get updated agents list
    } finally {
      setCliRebuilding(prev => { const n = { ...prev }; delete n[id]; return n; });
    }
  };

  const handleCliDelete = async (id: string) => {
    try {
      await ipcRenderer?.invoke('cli-agents:delete', { id });
      onRefresh?.(); // Refresh parent to get updated agents list
      setCliConfirmDelete(null);
      if (cliDetailAgent?.id === id) { setCliDetailAgent(null); setCliDetailData(null); }
    } catch {}
  };

  const handleCliAuth = async (id: string, cliTool: string) => {
    setCliAuthLoading(prev => ({ ...prev, [id]: true }));
    try {
      await ipcRenderer?.invoke('cli-agents:auth-login', { id, cliTool });
      onRefresh?.(); // Refresh parent to get updated agents list
    } catch {}
    setCliAuthLoading(prev => { const n = { ...prev }; delete n[id]; return n; });
  };

  const handleBrowserLogin = async (id: string) => {
    setBrowserLoginLoading(prev => ({ ...prev, [id]: true }));
    try {
      await ipcRenderer?.invoke('browser-agents:login', { id });
      onRefresh?.();
    } catch {}
    setBrowserLoginLoading(prev => { const n = { ...prev }; delete n[id]; return n; });
  };

  const handleSaveStartUrl = async (agentId: string) => {
    if (!startUrlValue.trim()) return;
    setStartUrlSaving(true);
    try {
      const agent = browserAgents.find(a => a.id === agentId);
      const descriptor = agent?.descriptor || '';
      // Update or add start_url in frontmatter
      let updated = descriptor;
      if (/^start_url\s*[:=]/m.test(descriptor)) {
        updated = descriptor.replace(/^start_url\s*[:=]\s*.*/m, `start_url: ${startUrlValue.trim()}`);
      } else if (/^---\n/m.test(descriptor)) {
        updated = descriptor.replace(/^---\n/, `---\nstart_url: ${startUrlValue.trim()}\n`);
      }
      await ipcRenderer?.invoke('browser-agents:update', { id: agentId, descriptor: updated });
      onRefresh?.();
      setEditingStartUrl(null);
    } catch {}
    setStartUrlSaving(false);
  };

  // Parse config fields from descriptor frontmatter
  const parseConfigFields = (descriptor: string): {key: string; value: string; label: string}[] => {
    const fields: {key: string; value: string; label: string}[] = [];
    const frontmatterMatch = descriptor.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const fm = frontmatterMatch[1];
      const configPatterns = [
        { key: 'client_id', label: 'Client ID' },
        { key: 'client_secret', label: 'Client Secret' },
        { key: 'api_key', label: 'API Key' },
        { key: 'api_key_env', label: 'API Key Env Var' },
        { key: 'token', label: 'Token' },
        { key: 'auth_url', label: 'Auth URL' },
        { key: 'oauth_scopes', label: 'OAuth Scopes' },
      ];
      for (const pattern of configPatterns) {
        const match = fm.match(new RegExp(`${pattern.key}[:=]\\s*(.+)`));
        if (match) {
          fields.push({ key: pattern.key, value: match[1].trim(), label: pattern.label });
        }
      }
    }
    return fields;
  };

  // Load credentials into the dynamic editor
  const loadCredentials = async (agentId: string, service?: string) => {
    try {
      console.log(`[AgentsTab] Loading credentials for ${agentId}, service: ${service}`);
      const secrets = await ipcRenderer?.invoke('cli-agents:get-stored-secrets', { agentId, service });
      console.log(`[AgentsTab] Got secrets:`, secrets);
      // Convert to pairs format - only key names, no actual values for security
      const pairs = (secrets || []).map((key: string) => ({
        key,
        value: '',
        isEditing: false,
        isStored: true
      }));
      // Add empty row for new entries
      pairs.push({ key: '', value: '', isEditing: true, isStored: false });
      console.log(`[AgentsTab] Setting credentialPairs:`, pairs);
      setCredentialPairs(pairs);
    } catch (e) {
      console.error('[AgentsTab] Failed to load credentials:', e);
      // On error, just show empty editor
      setCredentialPairs([{ key: '', value: '', isEditing: true, isStored: false }]);
    }
  };

  // Store a credential
  const handleStoreCredential = async (_index: number, key: string, value: string) => {
    if (!cliDetailAgent || !key || !value) return;
    try {
      await ipcRenderer?.invoke('cli-agents:store-credential', {
        agentId: cliDetailAgent.id,
        key,
        value,
        service: cliDetailAgent.service,
      });
      // Refresh the credential pairs list
      await loadCredentials(cliDetailAgent.id, cliDetailAgent.service);
    } catch (e) {
      console.error('Failed to store credential:', e);
    }
  };

  // Search for setup link via StateGraph
  const handleSearchSetupLink = async (service: string, cliTool?: string) => {
    try {
      await ipcRenderer?.invoke('cli-agents:search-setup-link', { service, cliTool });
    } catch (e) {
      console.error('Failed to search setup link:', e);
    }
  };

  // Delete a credential (with confirmation)
  const handleDeleteCredential = async (_index: number, key: string) => {
    if (!cliDetailAgent || !key) return;
    // Check if already confirming this key
    if (confirmDeleteCredential === key) {
      // Actually delete
      try {
        console.log(`[AgentsTab] Deleting credential ${key} for ${cliDetailAgent.id}`);
        const result = await ipcRenderer?.invoke('cli-agents:delete-credential', {
          agentId: cliDetailAgent.id,
          key,
          service: cliDetailAgent.service,
        });
        console.log(`[AgentsTab] Delete result:`, result);
        setConfirmDeleteCredential(null);
        // Clear pairs immediately for visual feedback
        setCredentialPairs([]);
        // Small delay to ensure delete propagates
        await new Promise(r => setTimeout(r, 200));
        // Refresh the credential pairs list
        await loadCredentials(cliDetailAgent.id, cliDetailAgent.service);
      } catch (e) {
        console.error('Failed to delete credential:', e);
      }
    } else {
      // First click - set confirmation state
      setConfirmDeleteCredential(key);
      // Auto-clear confirmation after 3 seconds
      setTimeout(() => setConfirmDeleteCredential(null), 3000);
    }
  };

  // Update credential pair at index
  const updateCredentialPair = (index: number, field: 'key' | 'value', value: string) => {
    setCredentialPairs(prev => prev.map((pair, i) => 
      i === index ? { ...pair, [field]: value } : pair
    ));
  };

  // Toggle edit mode for a credential pair
  const toggleCredentialEdit = (index: number) => {
    setCredentialPairs(prev => prev.map((pair, i) => 
      i === index ? { ...pair, isEditing: !pair.isEditing } : pair
    ));
  };

  // Add new empty credential row
  const addCredentialRow = () => {
    setCredentialPairs(prev => [...prev, { key: '', value: '', isEditing: true, isStored: false }]);
  };

  const handleCliDetail = async (agent: AgentItem) => {
    setCliDetailAgent(agent);
    setCliDetailData(null);
    setIsEditingDescriptor(false);
    setEditedDescriptor('');
    setCredentialPairs([{ key: '', value: '', isEditing: true, isStored: false }]);
    setExpandedSections({ learnedRules: true, descriptor: false, config: true });
    // Load stored credentials for this agent
    await loadCredentials(agent.id, agent.service);
    try {
      const [queryRes, rules] = await Promise.all([
        ipcRenderer?.invoke('cli-agents:query', { id: agent.id }),
        ipcRenderer?.invoke('cli-agents:rules', { id: agent.id }),
      ]);
      const descriptor = queryRes?.descriptor || '(no descriptor)';
      setCliDetailData({
        descriptor,
        rules: Array.isArray(rules) ? rules : [],
        failureLog: queryRes?.failureLog || queryRes?.failure_log || '',
      });
      setEditedDescriptor(descriptor);
      setConfigFields(parseConfigFields(descriptor));
    } catch {}
  };

  // Save edited descriptor (handles both browser and CLI agents)
  const handleSaveDescriptor = async () => {
    if (!cliDetailAgent || !ipcRenderer) return;
    try {
      // Determine which update handler to use based on agent type
      const isBrowserAgent = !cliDetailAgent.type || cliDetailAgent.type === 'browser' || cliDetailAgent.type === 'api';
      const handler = isBrowserAgent ? 'browser-agents:update' : 'cli-agents:update';
      await ipcRenderer.invoke(handler, { id: cliDetailAgent.id, descriptor: editedDescriptor });
      setCliDetailData(prev => prev ? { ...prev, descriptor: editedDescriptor } : prev);
      setIsEditingDescriptor(false);
      setConfigFields(parseConfigFields(editedDescriptor));
    } catch (e) {
      console.error('Failed to save descriptor:', e);
    }
  };

  // Toggle section expansion
  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  // CLI agent status colors
  const cliStatusColor = (status: string) => {
    switch (status) {
      case 'healthy': return '#10b981';
      case 'needs_update': return '#f59e0b';
      case 'broken': case 'not_installed': return '#ef4444';
      default: return '#6b7280';
    }
  };
  const cliStatusLabel = (status: string) => {
    switch (status) {
      case 'healthy': return 'Healthy';
      case 'needs_update': return 'Needs update';
      case 'broken': return 'Broken';
      case 'not_installed': return 'Not installed';
      default: return status || 'Unknown';
    }
  };

  // Relative time helper
  const timeAgo = (iso?: string) => {
    if (!iso) return 'never';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  return (
    <div style={{
      padding: 16,
      overflowY: 'visible',
      height: 'auto',
    }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: '#fff', fontSize: '1.1rem', fontWeight: 600 }}>Agents</h2>
        <p style={{ margin: '3px 0 10px 0', color: '#6b7280', fontSize: '0.78rem' }}>
          Domain-specific automation agents that learn and adapt
        </p>

        {/* COMMENT OUT FOR NOW AS NOT SEEING THE NEED TO ALLOW AGENT CREATION THIS WAY */}
        {/* Action buttons — compact inline row */}
        {/* <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={onRefresh}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.18)',
              backgroundColor: 'rgba(255,255,255,0.07)',
              color: '#d1d5db',
              fontSize: '0.85rem',
              cursor: 'pointer',
              lineHeight: 1,
              whiteSpace: 'nowrap',
              fontWeight: 500,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Refresh
          </button>

          <button
            onClick={() => {
              if (!isCreating) {
                setCreateError(null);
                if (activeSubtab === 'browser') setIsCreateBrowserModalOpen(true);
                else setIsCreateCliModalOpen(true);
              }
            }}
            disabled={isCreating}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 18px',
              borderRadius: 8,
              border: 'none',
              backgroundColor: isCreating ? 'rgba(59,130,246,0.5)' : '#3b82f6',
              color: '#fff',
              fontSize: '0.85rem',
              cursor: isCreating ? 'not-allowed' : 'pointer',
              lineHeight: 1,
              whiteSpace: 'nowrap',
              fontWeight: 500,
            }}
          >
            {isCreating ? (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                  <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                </svg>
                Creating...
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19"/>
                  <line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                Create Agent
              </>
            )}
          </button>
        </div> */}

        {/* Error feedback */}
        {createError && (
          <div style={{
            marginTop: 8,
            padding: '6px 10px',
            borderRadius: 6,
            backgroundColor: 'rgba(239,68,68,0.1)',
            border: '1px solid rgba(239,68,68,0.3)',
            color: '#f87171',
            fontSize: '0.75rem',
          }}>
            {createError}
          </div>
        )}

        {/* Auto-scan toggle - compact row */}
        <div style={{
          marginTop: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <label style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            cursor: 'pointer',
            fontSize: '0.75rem',
            color: autoScanEnabled ? '#10b981' : '#6b7280',
            transition: 'color 0.15s',
          }} title="Automatically scan all agents when system has been idle for 30+ minutes (once per 24h max)">
            <div style={{
              width: 32,
              height: 18,
              borderRadius: 9,
              backgroundColor: autoScanEnabled ? '#10b981' : 'rgba(255,255,255,0.2)',
              position: 'relative',
              transition: 'background-color 0.15s',
            }}>
              <div style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                backgroundColor: '#fff',
                position: 'absolute',
                top: 2,
                left: autoScanEnabled ? 16 : 2,
                transition: 'left 0.15s',
              }} />
              <input
                type="checkbox"
                checked={autoScanEnabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setAutoScanEnabled(enabled);
                  ipcRenderer?.send('agents:auto-scan-set', { enabled });
                }}
                style={{
                  position: 'absolute',
                  opacity: 0,
                  width: '100%',
                  height: '100%',
                  cursor: 'pointer',
                }}
              />
            </div>
            <span>Auto-scan when idle</span>
          </label>
        </div>
      </div>

      {/* Subtab switcher */}
      <div style={{
        marginTop: 12,
        marginBottom: 16,
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        paddingBottom: 8,
      }}>
        <button
          onClick={() => setActiveSubtab('browser')}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            backgroundColor: activeSubtab === 'browser' ? 'rgba(99,102,241,0.25)' : 'transparent',
            color: activeSubtab === 'browser' ? '#818cf8' : '#6b7280',
            fontSize: '0.8rem',
            cursor: 'pointer',
            fontWeight: activeSubtab === 'browser' ? 500 : 400,
            transition: 'all 0.15s',
          }}
        >
          Browser Agents
        </button>
        <button
          onClick={() => setActiveSubtab('cli')}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            backgroundColor: activeSubtab === 'cli' ? 'rgba(16,185,129,0.25)' : 'transparent',
            color: activeSubtab === 'cli' ? '#10b981' : '#6b7280',
            fontSize: '0.8rem',
            cursor: 'pointer',
            fontWeight: activeSubtab === 'cli' ? 500 : 400,
            transition: 'all 0.15s',
          }}
        >
          CLI Agents
        </button>
        <button
          onClick={() => setActiveSubtab('app')}
          style={{
            padding: '6px 14px',
            borderRadius: 6,
            border: 'none',
            backgroundColor: activeSubtab === 'app' ? 'rgba(236,72,153,0.25)' : 'transparent',
            color: activeSubtab === 'app' ? '#ec4899' : '#6b7280',
            fontSize: '0.8rem',
            cursor: 'pointer',
            fontWeight: activeSubtab === 'app' ? 500 : 400,
            transition: 'all 0.15s',
          }}
        >
          App Agents {appAgents.length > 0 && `(${appAgents.length})`}
        </button>

        {/* Spacer + Create button */}
        <div style={{ flex: 1 }} />
        {activeSubtab !== 'app' && (
        <button
          onClick={() => {
            if (activeSubtab === 'browser') setIsCreateBrowserModalOpen(true);
            else setIsCreateCliModalOpen(true);
          }}
          disabled={isCreating}
          title={activeSubtab === 'browser' ? 'Create Browser Agent' : 'Create CLI Agent'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '5px 11px',
            borderRadius: 6,
            border: `1px solid ${activeSubtab === 'browser' ? 'rgba(99,102,241,0.4)' : 'rgba(16,185,129,0.4)'}`,
            backgroundColor: activeSubtab === 'browser' ? 'rgba(99,102,241,0.14)' : 'rgba(16,185,129,0.12)',
            color: activeSubtab === 'browser' ? '#818cf8' : '#10b981',
            fontSize: '0.75rem',
            fontWeight: 500,
            cursor: isCreating ? 'not-allowed' : 'pointer',
            opacity: isCreating ? 0.5 : 1,
            transition: 'all 0.15s',
          }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New
        </button>
        )}
      </div>

      {/* Browser Agents Tab */}
      {activeSubtab === 'browser' && (
      <>
      {/* Edit error toast */}
      {editError && (
        <div style={{ margin: '0 0 8px', padding: '8px 12px', borderRadius: 7, background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171', fontSize: '0.78rem' }}>
          {editError}
        </div>
      )}
      {/* Skeleton placeholder card while agent is being built */}
      {creatingAgent && (
        <div style={{
          borderRadius: 10,
          border: '1px solid rgba(99,102,241,0.35)',
          background: 'rgba(99,102,241,0.06)',
          padding: '14px 16px',
          marginBottom: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <div style={{
            width: 38, height: 38, borderRadius: 8, flexShrink: 0,
            background: 'linear-gradient(90deg,rgba(99,102,241,0.15) 25%,rgba(99,102,241,0.3) 50%,rgba(99,102,241,0.15) 75%)',
            backgroundSize: '200% 100%',
            animation: 'shimmer 1.4s infinite',
          }}/>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#c7d2fe' }}>
                {creatingAgent.domain ? creatingAgent.domain.split('.')[0].replace(/^./, c => c.toUpperCase()) : 'New Agent'}
              </span>
              <span style={{ fontSize: '0.72rem', color: '#6b7280' }}>
                ({creatingAgent.domain || 'building…'})
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#818cf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
              <span style={{ fontSize: '0.75rem', color: '#818cf8' }}>Building agent… this takes ~10–20s</span>
            </div>
          </div>
        </div>
      )}
      {browserAgents.length === 0 && !creatingAgent ? (
        <div style={{
          textAlign: 'center',
          padding: 60,
          color: '#6b7280',
        }}>
          <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
            <div style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="6" height="6" rx="1"/>
                <rect x="4" y="4" width="16" height="16" rx="2"/>
                <line x1="9" y1="4" x2="9" y2="2"/>
                <line x1="12" y1="4" x2="12" y2="2"/>
                <line x1="15" y1="4" x2="15" y2="2"/>
                <line x1="9" y1="20" x2="9" y2="22"/>
                <line x1="12" y1="20" x2="12" y2="22"/>
                <line x1="15" y1="20" x2="15" y2="22"/>
                <line x1="4" y1="9" x2="2" y2="9"/>
                <line x1="4" y1="12" x2="2" y2="12"/>
                <line x1="4" y1="15" x2="2" y2="15"/>
                <line x1="20" y1="9" x2="22" y2="9"/>
                <line x1="20" y1="12" x2="22" y2="12"/>
                <line x1="20" y1="15" x2="22" y2="15"/>
              </svg>
            </div>
          </div>
          <div style={{ fontSize: '1rem', marginBottom: 8 }}>No agents yet</div>
          <div style={{ fontSize: '0.85rem' }}>
            Create your first agent to start automating websites
          </div>
        </div>
      ) : browserAgents.length === 0 && creatingAgent ? null : (
        browserAgents
          .filter((agent): agent is AgentItem => !!agent && !!agent.id)
          .map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onTrain={handleTrain}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onTestSkill={handleTestSkill}
            onDeleteSkill={handleDeleteSkill}
            onEditSkill={handleEditSkill}
            onRefreshSkill={handleRefreshSkill}
            testingSkills={testingSkills}
            refreshingSkills={refreshingSkills}
            failedSkills={failedSkills}
            expanded={expandedAgent === agent.id}
            onToggle={() => toggleExpanded(agent.id)}
            highlighted={preflightHighlightAgent === agent.id}
            onLogin={handleBrowserLogin}
            loginLoading={browserLoginLoading[agent.id] === true}
            editingStartUrl={editingStartUrl}
            startUrlValue={startUrlValue}
            setStartUrlValue={setStartUrlValue}
            onSaveStartUrl={handleSaveStartUrl}
            onStartUrlEdit={(agentId, currentUrl) => { setEditingStartUrl(agentId); setStartUrlValue(currentUrl); }}
            setEditingStartUrl={setEditingStartUrl}
            startUrlSaving={startUrlSaving}
          />
        ))
      )}
      </>
      )}

      {/* CLI Agents Tab */}
      {activeSubtab === 'cli' && (
        <div style={{ marginTop: 8 }}>
          {/* Empty state */}
          {cliAgents.length === 0 && (
            <div style={{ textAlign: 'center', padding: 50, color: '#6b7280' }}>
              <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
                <div style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: 'rgba(16,185,129,0.12)', border: '1px solid rgba(16,185,129,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.6"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                </div>
              </div>
              <div style={{ fontSize: '0.95rem', marginBottom: 6, color: '#fff' }}>No CLI agents yet</div>
              <div style={{ fontSize: '0.8rem', maxWidth: 320, margin: '0 auto', lineHeight: 1.5 }}>
                Try <code style={{ background: 'rgba(16,185,129,0.2)', padding: '2px 5px', borderRadius: 4, fontSize: '0.75rem' }}>set up GitHub</code> or <code style={{ background: 'rgba(16,185,129,0.2)', padding: '2px 5px', borderRadius: 4, fontSize: '0.75rem' }}>install the Stripe CLI</code> in the prompt
              </div>
            </div>
          )}
          {/* Agent cards */}
          {cliAgents.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cliAgents.map(agent => (
                <div
                  key={agent.id}
                  onClick={() => handleCliDetail(agent)}
                  style={{
                    background: preflightHighlightAgent === agent.id ? 'rgba(245,158,11,0.06)' : 'rgba(255,255,255,0.03)',
                    border: preflightHighlightAgent === agent.id ? '2px solid rgba(245,158,11,0.5)' : '1px solid rgba(255,255,255,0.06)',
                    boxShadow: preflightHighlightAgent === agent.id ? '0 0 12px rgba(245,158,11,0.15)' : 'none',
                    borderRadius: 10,
                    padding: '12px 14px',
                    cursor: 'pointer',
                    transition: 'border-color 0.15s, box-shadow 0.3s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = 'rgba(16,185,129,0.3)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = preflightHighlightAgent === agent.id ? 'rgba(245,158,11,0.5)' : 'rgba(255,255,255,0.06)')}
                >
                  {/* Top row: icon + name + status */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <div style={{ width: 34, height: 34, borderRadius: 8, backgroundColor: agent.type === 'api_key' ? 'rgba(251,191,36,0.1)' : 'rgba(16,185,129,0.12)', border: `1px solid ${agent.type === 'api_key' ? 'rgba(251,191,36,0.25)' : 'rgba(16,185,129,0.2)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {agent.type === 'api_key'
                        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="1.8"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
                        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.8"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
                      }
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 500 }}>{agent.id}</span>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.65rem', color: cliStatusColor(agent.status), background: `${cliStatusColor(agent.status)}15`, padding: '1px 6px', borderRadius: 8 }}>
                          <span style={{ width: 5, height: 5, borderRadius: '50%', backgroundColor: cliStatusColor(agent.status) }} />
                          {cliStatusLabel(agent.status)}
                        </span>
                        {agent.type === 'api_key' && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.62rem', color: '#fbbf24', background: 'rgba(251,191,36,0.1)', padding: '1px 6px', borderRadius: 8, border: '1px solid rgba(251,191,36,0.25)' }}>
                            🔑 API Key Required
                          </span>
                        )}
                        {agent.type !== 'api_key' && agent.authStatus === 'not_authenticated' && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.62rem', color: '#fbbf24', background: 'rgba(251,191,36,0.1)', padding: '1px 6px', borderRadius: 8, border: '1px solid rgba(251,191,36,0.25)' }}>
                            ⚠ Auth Required
                          </span>
                        )}
                        {/* Show credentials badge for agents that may need credentials */}
                        {agent.apiKeyEnv && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: '0.62rem', color: '#fbbf24', background: 'rgba(251,191,36,0.1)', padding: '1px 6px', borderRadius: 8, border: '1px solid rgba(251,191,36,0.25)' }}>
                            🔑 Credentials
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: '#6b7280', marginTop: 2 }}>
                        {agent.cliTool && <span>CLI: <code style={{ color: '#10b981', fontSize: '0.68rem' }}>{agent.cliTool}</code></span>}
                        {agent.service && <span style={{ marginLeft: agent.cliTool ? 8 : 0 }}>Service: {agent.service}</span>}
                        {agent.lastValidated && <span style={{ marginLeft: 8 }}>Validated: {timeAgo(agent.lastValidated)}</span>}
                      </div>
                    </div>
                  </div>
                  {/* Action buttons */}
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }} onClick={e => e.stopPropagation()}>
                    {agent.authStatus === 'not_authenticated' && (
                      <button
                        onClick={() => handleCliAuth(agent.id, agent.cliTool!)}
                        disabled={!!cliAuthLoading[agent.id]}
                        style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.1)', color: '#fbbf24', fontSize: '0.63rem', cursor: 'pointer', opacity: cliAuthLoading[agent.id] ? 0.5 : 1, fontWeight: 600 }}
                      >
                        {cliAuthLoading[agent.id] ? '🔐 Signing in...' : '🔐 Sign In'}
                      </button>
                    )}
                    <button
                      onClick={() => handleCliValidate(agent.id)}
                      disabled={!!cliValidating[agent.id]}
                      style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(16,185,129,0.25)', background: 'rgba(16,185,129,0.08)', color: '#10b981', fontSize: '0.63rem', cursor: 'pointer', opacity: cliValidating[agent.id] ? 0.5 : 1 }}
                    >
                      {cliValidating[agent.id] ? 'Validating...' : 'Validate'}
                    </button>
                    <button
                      onClick={() => handleCliRebuild(agent.id, agent.service!)}
                      disabled={!!cliRebuilding[agent.id]}
                      style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(99,102,241,0.25)', background: 'rgba(99,102,241,0.08)', color: '#818cf8', fontSize: '0.63rem', cursor: 'pointer', opacity: cliRebuilding[agent.id] ? 0.5 : 1 }}
                    >
                      {cliRebuilding[agent.id] ? 'Rebuilding...' : 'Rebuild'}
                    </button>
                    {cliConfirmDelete === agent.id ? (
                      <button
                        onClick={() => handleCliDelete(agent.id)}
                        style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.15)', color: '#ef4444', fontSize: '0.63rem', cursor: 'pointer' }}
                      >
                        Confirm delete?
                      </button>
                    ) : (
                      <button
                        onClick={() => { setCliConfirmDelete(agent.id); setTimeout(() => setCliConfirmDelete(null), 3000); }}
                        style={{ padding: '3px 8px', borderRadius: 5, border: '1px solid rgba(255,255,255,0.08)', background: 'transparent', color: '#6b7280', fontSize: '0.63rem', cursor: 'pointer' }}
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Detail drawer */}
          {cliDetailAgent && (
            <div style={{
              position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.6)', zIndex: 1000,
              display: 'flex', justifyContent: 'center', alignItems: 'center',
            }} onClick={() => { setCliDetailAgent(null); setCliDetailData(null); }}>
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: 14, padding: 24, width: '90%', maxWidth: 480,
                  maxHeight: '80vh', overflowY: 'auto', color: '#e5e7eb',
                }}
              >
                {/* Header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                  <div>
                    <div style={{ fontSize: '1rem', fontWeight: 600, color: '#fff' }}>{cliDetailAgent.id}</div>
                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 2 }}>
                      {cliDetailAgent.cliTool && <span>CLI: <code style={{ color: '#10b981' }}>{cliDetailAgent.cliTool}</code></span>}
                      {cliDetailAgent.service && <span style={{ marginLeft: 10 }}>Service: {cliDetailAgent.service}</span>}
                    </div>
                  </div>
                  <button onClick={() => { setCliDetailAgent(null); setCliDetailData(null); }} style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', fontSize: '1.2rem' }}>x</button>
                </div>
                {/* Status */}
                <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.72rem', color: cliStatusColor(cliDetailAgent.status), background: `${cliStatusColor(cliDetailAgent.status)}15`, padding: '2px 8px', borderRadius: 8 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: cliStatusColor(cliDetailAgent.status) }} />
                    {cliStatusLabel(cliDetailAgent.status)}
                  </span>
                  {cliDetailAgent.lastValidated && (
                    <span style={{ fontSize: '0.7rem', color: '#6b7280' }}>Last validated: {timeAgo(cliDetailAgent.lastValidated)}</span>
                  )}
                </div>
                {/* Credentials card — dynamic key-value editor */}
                <div style={{ marginBottom: 16, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.3)', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="2"/><path d="M14.5 14.5l-2.5-2.5M19 19l-1-1M8 16l-2 2M16 8l-2 2"/>
                    </svg>
                    <span style={{ fontSize: '0.78rem', fontWeight: 600, color: '#fbbf24' }}>
                      {credentialPairs.some(p => p.isStored) ? 'Credentials Stored' : 'Add Credentials'}
                    </span>
                    {credentialPairs.filter(p => p.isStored).length > 0 && (
                      <span style={{ fontSize: '0.65rem', color: '#9ca3af', marginLeft: 'auto' }}>
                        {credentialPairs.filter(p => p.isStored).length} stored
                      </span>
                    )}
                  </div>

                  {/* Search for setup link button */}
                  <button
                    onClick={() => handleSearchSetupLink(cliDetailAgent.service || cliDetailAgent.id, cliDetailAgent.cliTool)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 6, border: '1px solid rgba(251,191,36,0.4)', background: 'rgba(251,191,36,0.12)', color: '#fbbf24', fontSize: '0.72rem', cursor: 'pointer', fontWeight: 500, marginBottom: 12 }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    Search for setup instructions
                  </button>

                  {/* Dynamic credential editor */}
                  <div style={{ marginTop: 10 }}>
                    {credentialPairs.map((pair, idx) => (
                      <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                        {/* Key input */}
                        <input
                          type="text"
                          value={pair.key}
                          onChange={(e) => updateCredentialPair(idx, 'key', e.target.value)}
                          placeholder="Key (e.g., API_KEY)"
                          disabled={pair.isStored && !pair.isEditing}
                          style={{
                            width: 90,
                            padding: '5px 8px',
                            borderRadius: 5,
                            border: '1px solid rgba(255,255,255,0.15)',
                            background: pair.isStored && !pair.isEditing ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.3)',
                            color: pair.isStored && !pair.isEditing ? '#9ca3af' : '#fff',
                            fontSize: '0.7rem',
                          }}
                        />
                        <span style={{ color: '#6b7280', fontSize: '0.75rem' }}>=</span>
                        {/* Value input */}
                        <input
                          type="password"
                          value={pair.value}
                          onChange={(e) => updateCredentialPair(idx, 'value', e.target.value)}
                          placeholder={pair.isStored ? '••••••••' : 'Value...'}
                          style={{
                            flex: 1,
                            minWidth: 60,
                            padding: '5px 8px',
                            borderRadius: 5,
                            border: '1px solid rgba(255,255,255,0.15)',
                            background: 'rgba(0,0,0,0.3)',
                            color: '#fff',
                            fontSize: '0.7rem',
                          }}
                        />
                        {/* Action buttons - icon-only on same row */}
                        {pair.isStored ? (
                          <>
                            {/* Edit button - highlighted when in edit mode */}
                            <button
                              onClick={() => toggleCredentialEdit(idx)}
                              style={{
                                padding: '2px 4px',
                                background: pair.isEditing ? 'rgba(59,130,246,0.15)' : 'transparent',
                                border: pair.isEditing ? '1px solid rgba(59,130,246,0.5)' : '1px solid rgba(59,130,246,0.3)',
                                borderRadius: 3,
                                cursor: 'pointer',
                                color: pair.isEditing ? '#60a5fa' : '#3b82f6',
                                display: 'flex',
                                alignItems: 'center',
                                transition: 'all 0.15s',
                              }}
                              title={pair.isEditing ? 'Editing...' : 'Edit'}
                            >
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                              </svg>
                            </button>
                            {/* Delete button with two-click confirm */}
                            {confirmDeleteCredential === pair.key ? (
                              <button
                                onClick={() => handleDeleteCredential(idx, pair.key)}
                                style={{
                                  padding: '2px 6px',
                                  background: 'rgba(239,68,68,0.15)',
                                  border: '1px solid rgba(239,68,68,0.45)',
                                  borderRadius: 3,
                                  cursor: 'pointer',
                                  color: '#f87171',
                                  fontSize: '0.58rem',
                                  fontWeight: 600,
                                  display: 'flex',
                                  alignItems: 'center',
                                  whiteSpace: 'nowrap',
                                  transition: 'all 0.15s',
                                }}
                                title="Click again to confirm"
                              >
                                sure?
                              </button>
                            ) : (
                              <button
                                onClick={() => handleDeleteCredential(idx, pair.key)}
                                style={{
                                  padding: '2px 4px',
                                  background: 'transparent',
                                  border: '1px solid rgba(239,68,68,0.3)',
                                  borderRadius: 3,
                                  cursor: 'pointer',
                                  color: '#ef4444',
                                  display: 'flex',
                                  alignItems: 'center',
                                }}
                                title="Delete"
                              >
                                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                                </svg>
                              </button>
                            )}
                          </>
                        ) : (
                          <>
                            {/* Save button for new entries */}
                            {pair.key && pair.value && (
                              <button
                                onClick={() => handleStoreCredential(idx, pair.key, pair.value)}
                                style={{
                                  padding: '2px 4px',
                                  background: 'transparent',
                                  border: '1px solid rgba(16,185,129,0.3)',
                                  borderRadius: 3,
                                  cursor: 'pointer',
                                  color: '#10b981',
                                  display: 'flex',
                                  alignItems: 'center',
                                }}
                                title="Save"
                              >
                                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12"/>
                                </svg>
                              </button>
                            )}
                            {/* Add button on last row */}
                            {idx === credentialPairs.length - 1 && (
                              <button
                                onClick={addCredentialRow}
                                style={{
                                  padding: '2px 4px',
                                  background: 'transparent',
                                  border: '1px solid rgba(107,114,128,0.3)',
                                  borderRadius: 3,
                                  cursor: 'pointer',
                                  color: '#6b7280',
                                  display: 'flex',
                                  alignItems: 'center',
                                }}
                                title="Add new"
                              >
                                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                                </svg>
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                {/* Capabilities */}
                {cliDetailAgent.capabilities && cliDetailAgent.capabilities.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: '0.7rem', color: '#9ca3af', marginBottom: 4, fontWeight: 500 }}>Capabilities</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {cliDetailAgent.capabilities.map(cap => (
                        <span key={cap} style={{ fontSize: '0.63rem', padding: '2px 7px', borderRadius: 6, background: 'rgba(16,185,129,0.1)', color: '#10b981', border: '1px solid rgba(16,185,129,0.2)' }}>{cap}</span>
                      ))}
                    </div>
                  </div>
                )}
                {/* Loading detail data */}
                {!cliDetailData && (
                  <div style={{ textAlign: 'center', padding: 20, color: '#6b7280', fontSize: '0.75rem' }}>Loading details...</div>
                )}
                {cliDetailData && (
                  <>
                    {/* Config Fields Section */}
                    {configFields.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <button 
                          onClick={() => toggleSection('config')}
                          style={{ 
                            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '8px 0', border: 'none', background: 'none', color: '#9ca3af', 
                            fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer'
                          }}
                        >
                          <span>Configuration ({configFields.length})</span>
                          <span>{expandedSections.config ? '▼' : '▶'}</span>
                        </button>
                        {expandedSections.config && (
                          <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 12px', marginTop: 4 }}>
                            {configFields.map((field) => (
                              <div key={field.key} style={{ marginBottom: 8 }}>
                                <div style={{ fontSize: '0.65rem', color: '#6b7280', marginBottom: 2 }}>{field.label}</div>
                                <div style={{ 
                                  fontSize: '0.7rem', color: '#10b981', fontFamily: 'monospace',
                                  background: 'rgba(16,185,129,0.08)', padding: '4px 8px', borderRadius: 4,
                                  border: '1px solid rgba(16,185,129,0.15)', wordBreak: 'break-all'
                                }}>
                                  {field.value}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Learned Rules - Collapsible */}
                    {cliDetailData.rules && cliDetailData.rules.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <button 
                          onClick={() => toggleSection('learnedRules')}
                          style={{ 
                            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            padding: '8px 0', border: 'none', background: 'none', color: '#9ca3af', 
                            fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer'
                          }}
                        >
                          <span>Learned Rules ({cliDetailData.rules.length})</span>
                          <span>{expandedSections.learnedRules ? '▼' : '▶'}</span>
                        </button>
                        {expandedSections.learnedRules && (
                          <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: '8px 10px', maxHeight: 120, overflowY: 'auto', marginTop: 4 }}>
                            {cliDetailData.rules.map((rule, i) => (
                              <div key={i} style={{ fontSize: '0.68rem', color: '#d1d5db', padding: '3px 0', borderBottom: i < cliDetailData.rules!.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                                {rule}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Failure Log */}
                    {cliDetailData.failureLog && (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: '0.7rem', color: '#f87171', marginBottom: 4, fontWeight: 500 }}>Failure Log</div>
                        <pre style={{ background: 'rgba(239,68,68,0.06)', borderRadius: 8, padding: '8px 10px', fontSize: '0.63rem', color: '#fca5a5', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 150, overflowY: 'auto', margin: 0, border: '1px solid rgba(239,68,68,0.15)' }}>
                          {cliDetailData.failureLog}
                        </pre>
                      </div>
                    )}

                    {/* Descriptor - Collapsible & Editable */}
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                        <button 
                          onClick={() => toggleSection('descriptor')}
                          style={{ 
                            display: 'flex', alignItems: 'center', gap: 6,
                            border: 'none', background: 'none', color: '#9ca3af', 
                            fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer'
                          }}
                        >
                          <span>Descriptor</span>
                          <span>{expandedSections.descriptor ? '▼' : '▶'}</span>
                        </button>
                        {!isEditingDescriptor ? (
                          <button 
                            onClick={() => setIsEditingDescriptor(true)}
                            style={{ 
                              padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(99,102,241,0.3)', 
                              background: 'rgba(99,102,241,0.1)', color: '#818cf8', fontSize: '0.65rem',
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4
                            }}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            Edit
                          </button>
                        ) : (
                          <div style={{ display: 'flex', gap: 6 }}>
                            <button 
                              onClick={handleSaveDescriptor}
                              style={{ 
                                padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(16,185,129,0.3)', 
                                background: 'rgba(16,185,129,0.1)', color: '#10b981', fontSize: '0.65rem', cursor: 'pointer'
                              }}
                            >
                              Save
                            </button>
                            <button 
                              onClick={() => { setIsEditingDescriptor(false); setEditedDescriptor(cliDetailData.descriptor || ''); }}
                              style={{ 
                                padding: '3px 8px', borderRadius: 4, border: '1px solid rgba(107,114,128,0.3)', 
                                background: 'transparent', color: '#6b7280', fontSize: '0.65rem', cursor: 'pointer'
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                      {expandedSections.descriptor && (
                        isEditingDescriptor ? (
                          <textarea 
                            value={editedDescriptor}
                            onChange={(e) => setEditedDescriptor(e.target.value)}
                            style={{ 
                              width: '100%', minHeight: 200, background: 'rgba(0,0,0,0.4)', 
                              border: '1px solid rgba(99,102,241,0.3)', borderRadius: 8, 
                              padding: '10px 12px', fontSize: '0.65rem', color: '#e5e7eb',
                              fontFamily: 'monospace', resize: 'vertical', lineHeight: 1.4
                            }}
                          />
                        ) : (
                          <pre style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: '8px 10px', fontSize: '0.6rem', color: '#d1d5db', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflowY: 'auto', margin: 0 }}>
                            {cliDetailData.descriptor}
                          </pre>
                        )
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* App Agents Tab */}
      {activeSubtab === 'app' && (
        <div style={{ marginTop: 8 }}>
          {/* Empty state */}
          {appAgents.length === 0 && (
            <div style={{ textAlign: 'center', padding: 50, color: '#6b7280' }}>
              <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center' }}>
                <div style={{ width: 56, height: 56, borderRadius: 12, backgroundColor: 'rgba(236,72,153,0.12)', border: '1px solid rgba(236,72,153,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ec4899" strokeWidth="1.6"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>
                </div>
              </div>
              <div style={{ fontSize: '0.95rem', marginBottom: 6, color: '#fff' }}>No app agents yet</div>
              <div style={{ fontSize: '0.8rem', maxWidth: 320, margin: '0 auto', lineHeight: 1.5 }}>
                App agents are created automatically when you ask ThinkDrop to use a desktop app's AI assistant (e.g., "use Cursor's AI to refactor this file").
              </div>
            </div>
          )}
          {/* App agent cards */}
          {appAgents.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {appAgents.map(agent => (
                <div
                  key={agent.id}
                  style={{
                    background: preflightHighlightAgent === agent.id ? 'rgba(245,158,11,0.06)' : 'rgba(255,255,255,0.03)',
                    border: preflightHighlightAgent === agent.id ? '2px solid rgba(245,158,11,0.5)' : '1px solid rgba(255,255,255,0.06)',
                    boxShadow: preflightHighlightAgent === agent.id ? '0 0 12px rgba(245,158,11,0.15)' : 'none',
                    borderRadius: 10,
                    padding: '12px 14px',
                    transition: 'border-color 0.15s, box-shadow 0.3s',
                  }}
                >
                  {/* Top row: icon + name + status */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <div style={{
                      width: 32, height: 32, borderRadius: 8,
                      backgroundColor: 'rgba(236,72,153,0.12)',
                      border: '1px solid rgba(236,72,153,0.25)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ec4899" strokeWidth="1.8">
                        <rect x="3" y="3" width="18" height="18" rx="2"/>
                        <line x1="9" y1="9" x2="15" y2="9"/>
                        <line x1="9" y1="13" x2="15" y2="13"/>
                        <line x1="9" y1="17" x2="13" y2="17"/>
                      </svg>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.78rem', fontWeight: 600, color: '#e5e7eb' }}>
                        {agent.name || agent.id.replace(/\.agent$/i, '')}
                      </div>
                      <div style={{ fontSize: '0.62rem', color: '#6b7280' }}>
                        {agent.id} · {agent.status}
                      </div>
                    </div>
                    <span style={{
                      fontSize: '0.58rem', padding: '2px 7px', borderRadius: 4,
                      backgroundColor: 'rgba(236,72,153,0.12)', border: '1px solid rgba(236,72,153,0.25)',
                      color: '#ec4899', whiteSpace: 'nowrap',
                    }}>
                      App
                    </span>
                  </div>
                  {/* Capabilities */}
                  {agent.capabilities && agent.capabilities.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                      {agent.capabilities.map(cap => (
                        <span key={cap} style={{
                          fontSize: '0.58rem', padding: '2px 7px', borderRadius: 4,
                          backgroundColor: 'rgba(236,72,153,0.08)', border: '1px solid rgba(236,72,153,0.15)',
                          color: '#db2777',
                        }}>
                          {cap.replace(/_/g, ' ')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create Browser Agent modal */}
      <CreateBrowserAgentModal
        isOpen={isCreateBrowserModalOpen}
        onClose={() => setIsCreateBrowserModalOpen(false)}
        onCreate={handleCreateBrowserAgent}
      />

      {/* Create CLI Agent modal */}
      <CreateCliAgentModal
        isOpen={isCreateCliModalOpen}
        onClose={() => setIsCreateCliModalOpen(false)}
        onCreate={handleCreateCliAgent}
      />

      {/* Training Panel — shown when user clicks Train */}
      {trainingAgentId && (
        <TrainingPanel
          agentId={trainingAgentId}
          hostname={localItems.find(a => a.id === trainingAgentId)?.domain || trainingAgentId}
          onDone={handleTrainSave}
          onCancel={handleTrainCancel}
        />
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}
