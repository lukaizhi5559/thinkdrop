import React, { useState, useEffect } from 'react';
import type { AgentItem, AgentSkill } from './TabComponents';

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

// Individual agent card — matches CronItemCard / SkillItemCard compact style
function AgentCard({ 
  agent, 
  onLearn, 
  onTrain, 
  onEdit,
  onDelete,
  onTestSkill,
  onPublishSkill,
  expanded,
  onToggle
}: { 
  agent: AgentItem;
  onLearn: (agentId: string, options?: { headed?: boolean }) => void;
  onTrain: (agentId: string) => void;
  onEdit: (agentId: string) => void;
  onDelete: (agentId: string) => void;
  onTestSkill: (agentId: string, skillName: string) => void;
  onPublishSkill: (agentId: string, skillName: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const categoryColor = categoryColors[agent.category] || '#6b7280';
  const statusColor = statusColors[agent.status] || '#6b7280';
  const isLearning = agent.status === 'learning';
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [learnExpanded, setLearnExpanded] = useState(false);

  return (
    <div style={{
      borderRadius: 9,
      padding: '10px 12px',
      marginBottom: 6,
      backgroundColor: 'rgba(255,255,255,0.025)',
      border: '1px solid rgba(255,255,255,0.07)',
    }}>
      {/* Main row: icon · info · actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>

        {/* Favicon / fallback icon — compact 28px */}
        <div style={{ flexShrink: 0 }}>
          <AgentIcon domain={agent.domain} name={agent.name} size={28} />
        </div>

        {/* Name + domain */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'nowrap', overflow: 'hidden' }}>
            <span style={{
              fontSize: '0.72rem',
              fontWeight: 600,
              color: '#e5e7eb',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {agent.name}
            </span>
            <span style={{
              fontSize: '0.58rem',
              padding: '1px 5px',
              borderRadius: 3,
              backgroundColor: categoryColor + '22',
              color: categoryColor,
              border: `1px solid ${categoryColor}44`,
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}>
              {agent.category}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
            <div style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              backgroundColor: statusColor,
              flexShrink: 0,
              boxShadow: isLearning ? `0 0 5px ${statusColor}` : 'none',
              animation: isLearning ? 'pulse 1.5s infinite' : undefined,
            }} />
            <span style={{ fontSize: '0.62rem', color: '#6b7280', textTransform: 'capitalize' }}>
              {isLearning ? 'Learning…' : agent.status}
            </span>
            <span style={{ fontSize: '0.62rem', color: '#4b5563' }}>·</span>
            <span style={{
              fontSize: '0.62rem',
              color: '#4b5563',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {agent.domain}
            </span>
          </div>
        </div>

        {/* Icon-only action buttons — never overflow */}
        <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>

          {/* Learn — single ▶ expands into headless + headed choice buttons */}
          {isLearning ? (
            <button
              disabled
              title="Learning in progress…"
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
          ) : learnExpanded ? (
            <>
              {/* Headless learn */}
              <button
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); onLearn(agent.id, { headed: false }); setLearnExpanded(false); }}
                title="Learn headless (background)"
                style={{
                  padding: '4px 7px', borderRadius: 5, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(245,158,11,0.18)', border: '1px solid rgba(245,158,11,0.5)',
                  color: '#f59e0b',
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                  <polygon points="5,3 19,12 5,21"/>
                </svg>
              </button>
              {/* Headed/visible learn */}
              <button
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); onLearn(agent.id, { headed: true }); setLearnExpanded(false); }}
                title="Learn visible (watch the browser)"
                style={{
                  padding: '4px 7px', borderRadius: 5, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(99,102,241,0.18)', border: '1px solid rgba(99,102,241,0.5)',
                  color: '#818cf8',
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
              {/* Collapse back */}
              <button
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); setLearnExpanded(false); }}
                title="Cancel"
                style={{
                  padding: '4px 6px', borderRadius: 5, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(107,114,128,0.12)', border: '1px solid rgba(107,114,128,0.25)',
                  color: '#6b7280',
                }}
              >
                <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            </>
          ) : (
            <button
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); setLearnExpanded(true); }}
              title="Learn agent"
              style={{
                padding: '4px 7px', borderRadius: 5, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.3)',
                color: '#f59e0b',
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                <polygon points="5,3 19,12 5,21"/>
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

          {/* Goals */}
          {agent.userGoals && agent.userGoals.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: '0.62rem', color: '#4b5563', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Goals
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {agent.userGoals.map((goal, idx) => (
                  <span key={idx} style={{
                    fontSize: '0.65rem',
                    color: '#9ca3af',
                    backgroundColor: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.07)',
                    padding: '2px 7px',
                    borderRadius: 4,
                  }}>
                    {goal}
                  </span>
                ))}
              </div>
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

          {/* Skills */}
          {agent.skills && agent.skills.length > 0 && (
            <div>
              <div style={{ fontSize: '0.62rem', color: '#4b5563', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Skills
              </div>
              {agent.skills.map((skill) => (
                <SkillRow
                  key={skill.name}
                  skill={skill}
                  onTest={() => onTestSkill(agent.id, skill.name)}
                  onPublish={() => onPublishSkill(agent.id, skill.name)}
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

// Individual skill row — compact, matching other tabs
function SkillRow({ 
  skill, 
  onTest,
  onPublish 
}: { 
  skill: AgentSkill; 
  onTest: () => void;
  onPublish: () => void;
}) {
  const isDraft = skill.status === 'draft';

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      padding: '6px 8px',
      backgroundColor: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.05)',
      borderRadius: 5,
      marginBottom: 4,
      gap: 8,
    }}>
      <div style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        flexShrink: 0,
        backgroundColor: isDraft ? '#f59e0b' : '#10b981',
        boxShadow: isDraft ? 'none' : '0 0 4px #10b981',
      }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.68rem', color: '#d1d5db', fontFamily: 'ui-monospace,monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {skill.name}
        </div>
        {skill.description && (
          <div style={{ fontSize: '0.6rem', color: '#6b7280', marginTop: 1 }}>{skill.description}</div>
        )}
      </div>

      <span style={{
        fontSize: '0.58rem',
        padding: '1px 5px',
        borderRadius: 3,
        backgroundColor: isDraft ? 'rgba(245,158,11,0.12)' : 'rgba(16,185,129,0.12)',
        border: `1px solid ${isDraft ? 'rgba(245,158,11,0.25)' : 'rgba(16,185,129,0.25)'}`,
        color: isDraft ? '#f59e0b' : '#10b981',
        flexShrink: 0,
      }}>
        {skill.status}
      </span>

      {/* Test — play icon */}
      <button
        onClick={onTest}
        title="Test skill"
        style={{
          padding: '3px 6px',
          borderRadius: 4,
          cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.1)',
          color: '#9ca3af',
          flexShrink: 0,
        }}
      >
        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
      </button>

      {/* Publish — upload icon, only for draft */}
      {isDraft && (
        <button
          onClick={onPublish}
          title="Publish skill"
          style={{
            padding: '3px 6px',
            borderRadius: 4,
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(16,185,129,0.1)',
            border: '1px solid rgba(16,185,129,0.28)',
            color: '#10b981',
            flexShrink: 0,
          }}
        >
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="16 16 12 12 8 16"/>
            <line x1="12" y1="12" x2="12" y2="21"/>
            <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>
          </svg>
        </button>
      )}
    </div>
  );
}

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
  onSave: (agentId: string, goals: string[]) => void;
}) {
  const [goals, setGoals] = useState<string[]>(['']);

  useEffect(() => {
    if (agent) {
      const existing = [
        ...(agent.userGoals || []),
        ...(agent.userGoal && !agent.userGoals?.includes(agent.userGoal) ? [agent.userGoal] : []),
      ].filter(Boolean);
      setGoals(existing.length > 0 ? existing : ['']);
    }
  }, [agent]);

  if (!isOpen || !agent) return null;

  const addGoal = () => setGoals([...goals, '']);
  const removeGoal = (index: number) => {
    if (goals.length > 1) setGoals(goals.filter((_, i) => i !== index));
  };
  const updateGoal = (index: number, value: string) => {
    const next = [...goals];
    next[index] = value;
    setGoals(next);
  };

  const validGoals = goals.filter(g => g.trim().length > 0);
  const hasNoGoalsYet = !agent.userGoals?.length && !agent.userGoal;

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
        <h3 style={{ margin: '0 0 6px 0', color: '#fff', fontSize: '1.1rem' }}>Edit Agent Goals</h3>
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
            💡 Set at least one goal so ThinkDrop knows what to learn on this site.
            Focused goals = better results. You can skip for a basic general scan.
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: '0.8rem', color: '#9ca3af', marginBottom: 6 }}>
            What would you like to do on this site?
          </label>
          {goals.map((goal, index) => (
            <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                type="text"
                value={goal}
                onChange={(e) => updateGoal(index, e.target.value)}
                placeholder={`Goal ${index + 1}: e.g., Search for answers, Save threads...`}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.1)',
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  color: '#fff',
                  fontSize: '0.9rem',
                }}
              />
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
          ))}
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
            + Add Another Goal
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
          <button
            onClick={() => { onSave(agent.id, validGoals); onClose(); }}
            disabled={validGoals.length === 0}
            style={{
              width: '100%',
              padding: '12px 16px',
              borderRadius: 8,
              border: 'none',
              backgroundColor: validGoals.length === 0 ? 'rgba(59,130,246,0.4)' : '#3b82f6',
              color: '#fff',
              cursor: validGoals.length === 0 ? 'not-allowed' : 'pointer',
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

// Create agent modal
function CreateAgentModal({ 
  isOpen, 
  onClose, 
  onCreate 
}: { 
  isOpen: boolean; 
  onClose: () => void;
  onCreate: (domain: string, goals: string[]) => void;
}) {
  const [domain, setDomain] = useState('');
  const [goals, setGoals] = useState<string[]>(['']);

  if (!isOpen) return null;

  const addGoal = () => setGoals([...goals, '']);
  const removeGoal = (index: number) => {
    if (goals.length > 1) {
      setGoals(goals.filter((_, i) => i !== index));
    }
  };
  const updateGoal = (index: number, value: string) => {
    const newGoals = [...goals];
    newGoals[index] = value;
    setGoals(newGoals);
  };

  const hasValidGoals = goals.some(g => g.trim().length > 0);
  const validGoals = goals.filter(g => g.trim().length > 0);

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
        <h3 style={{ margin: '0 0 16px 0', color: '#fff', fontSize: '1.1rem' }}>Create New Agent</h3>
        
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: '0.8rem', color: '#9ca3af', marginBottom: 6 }}>
            Website Domain
          </label>
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="spotify.com, youtube.com, etc."
            style={{
              width: '100%',
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.1)',
              backgroundColor: 'rgba(255,255,255,0.05)',
              color: '#fff',
              fontSize: '0.9rem',
            }}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: '0.8rem', color: '#9ca3af', marginBottom: 6 }}>
            What would you like to do on this site? (Add multiple goals)
          </label>
          {goals.map((goal, index) => (
            <div key={index} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input
                type="text"
                value={goal}
                onChange={(e) => updateGoal(index, e.target.value)}
                placeholder={`Goal ${index + 1}: e.g., Buy products, Track orders...`}
                style={{
                  flex: 1,
                  padding: '10px 12px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.1)',
                  backgroundColor: 'rgba(255,255,255,0.05)',
                  color: '#fff',
                  fontSize: '0.9rem',
                }}
              />
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
          ))}
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
            + Add Another Goal
          </button>
        </div>

        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end', marginTop: 20 }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.2)',
              backgroundColor: 'transparent',
              color: '#9ca3af',
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => {
              onCreate(domain, validGoals);
              setDomain('');
              setGoals(['']);
              onClose();
            }}
            disabled={!domain || !hasValidGoals}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: 'none',
              backgroundColor: '#3b82f6',
              color: '#fff',
              cursor: !domain || !hasValidGoals ? 'not-allowed' : 'pointer',
              opacity: !domain || !hasValidGoals ? 0.6 : 1,
            }}
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
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editModalAgent, setEditModalAgent] = useState<AgentItem | null>(null);
  const [localItems, setLocalItems] = useState<AgentItem[]>(items);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [autoScanEnabled, setAutoScanEnabled] = useState<boolean>(false);

  // Sync with props
  useEffect(() => {
    setLocalItems(items);
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
  // NOTE: agents:update and agents:new are handled centrally in UnifiedOverlay
  // which passes updated items as props — registering them here again would cause
  // duplicate listeners with wrong signatures (preload strips the IPC event arg
  // before calling callbacks, so handlers must accept (data) not (event, data)).
  useEffect(() => {
    if (!ipcRenderer) return;

    const handleCreating = () => {
      setIsCreating(true);
      setCreateError(null);
    };

    // Preload strips the IPC event arg — callback receives (data) directly
    const handleCreateError = (data: { message: string }) => {
      setIsCreating(false);
      setCreateError(data?.message || 'Failed to create agent');
      setTimeout(() => setCreateError(null), 5000);
    };

    ipcRenderer.on('agents:creating', handleCreating);
    ipcRenderer.on('agents:error', handleCreateError);

    return () => {
      ipcRenderer.removeListener('agents:creating', handleCreating);
      ipcRenderer.removeListener('agents:error', handleCreateError);
    };
  }, []);

  const _fireLearning = (agentId: string, goals: string[], options: { headed?: boolean } = {}) => {
    ipcRenderer?.send('agents:learn', { agentId, goals, options });
    setLocalItems(prev => prev.map(agent =>
      agent.id === agentId ? { ...agent, status: 'learning' } : agent
    ));
  };

  const handleLearn = (agentId: string, options: { headed?: boolean } = {}) => {
    const agent = localItems.find(a => a.id === agentId);
    const hasGoals = (agent?.userGoals?.length ?? 0) > 0 || !!agent?.userGoal;
    if (!hasGoals) {
      setEditModalAgent(agent || null);
      return;
    }
    _fireLearning(agentId, agent?.userGoals || [], options);
  };

  const handleTrain = (agentId: string) => {
    ipcRenderer?.send('agents:train', { agentId });
  };

  const handleEdit = (agentId: string) => {
    const agent = localItems.find(a => a.id === agentId);
    if (agent) setEditModalAgent(agent);
  };

  const handleEditSave = (agentId: string, goals: string[]) => {
    setLocalItems(prev => prev.map(a =>
      a.id === agentId ? { ...a, userGoals: goals } : a
    ));
    _fireLearning(agentId, goals);
  };

  const handleDelete = (agentId: string) => {
    // Optimistically remove from UI immediately
    setLocalItems(prev => prev.filter(a => a.id !== agentId));
    ipcRenderer?.send('agents:delete', { agentId });
  };

  const handleTestSkill = (agentId: string, skillName: string) => {
    ipcRenderer?.send('agents:test-skill', { agentId, skillName });
  };

  const handlePublishSkill = (agentId: string, skillName: string) => {
    ipcRenderer?.send('agents:publish-skill', { agentId, skillName });
    
    // Optimistic update
    setLocalItems(prev => prev.map(agent => 
      agent.id === agentId 
        ? { 
            ...agent, 
            skills: agent.skills?.map(s => 
              s.name === skillName ? { ...s, status: 'published' } : s
            ) 
          }
        : agent
    ));
  };

  const handleCreateAgent = (domain: string, goals: string[]) => {
    setIsCreating(true);
    setCreateError(null);
    ipcRenderer?.send('agents:create', { domain, goals, headed: true });
  };

  const toggleExpanded = (agentId: string) => {
    setExpandedAgent(expandedAgent === agentId ? null : agentId);
  };

  return (
    <div style={{
      padding: 16,
      overflowY: 'auto',
      height: '100%',
    }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: '#fff', fontSize: '1.1rem', fontWeight: 600 }}>Agents</h2>
        <p style={{ margin: '3px 0 10px 0', color: '#6b7280', fontSize: '0.78rem' }}>
          Domain-specific automation agents that learn and adapt
        </p>

        {/* Action buttons — compact inline row */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
                setIsCreateModalOpen(true);
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
        </div>

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

      {/* Agent list */}
      {localItems.length === 0 ? (
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
      ) : (
        localItems.filter((agent): agent is AgentItem => !!agent && !!agent.id).map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onLearn={handleLearn}
            onTrain={handleTrain}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onTestSkill={handleTestSkill}
            onPublishSkill={handlePublishSkill}
            expanded={expandedAgent === agent.id}
            onToggle={() => toggleExpanded(agent.id)}
          />
        ))
      )}

      {/* Create modal */}
      <CreateAgentModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onCreate={handleCreateAgent}
      />

      {/* Edit / goal-gate modal */}
      <EditAgentModal
        isOpen={editModalAgent !== null}
        agent={editModalAgent}
        onClose={() => setEditModalAgent(null)}
        onSave={handleEditSave}
      />

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
