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
function AgentIcon({ domain, name }: { domain: string; name: string }) {
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

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
          width: 40, 
          height: 40, 
          borderRadius: 8,
          objectFit: 'cover',
          backgroundColor: 'rgba(255,255,255,0.1)'
        }}
        onError={() => setError(true)}
      />
    );
  }

  // Fallback emoji based on category or robot
  return (
    <div style={{
      width: 40,
      height: 40,
      borderRadius: 8,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(255,255,255,0.1)',
      fontSize: '1.5rem'
    }}>
      🤖
    </div>
  );
}

// Individual agent card
function AgentCard({ 
  agent, 
  onLearn, 
  onTrain, 
  onEdit,
  onTestSkill,
  onPublishSkill,
  expanded,
  onToggle
}: { 
  agent: AgentItem;
  onLearn: (agentId: string, options?: { headed?: boolean }) => void;
  onTrain: (agentId: string) => void;
  onEdit: (agentId: string) => void;
  onTestSkill: (agentId: string, skillName: string) => void;
  onPublishSkill: (agentId: string, skillName: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  const categoryColor = categoryColors[agent.category] || '#6b7280';
  const statusColor = statusColors[agent.status] || '#6b7280';

  return (
    <div style={{
      backgroundColor: 'rgba(255,255,255,0.05)',
      borderRadius: 12,
      padding: 16,
      marginBottom: 12,
      border: '1px solid rgba(255,255,255,0.08)',
    }}>
      {/* Header */}
      <div 
        onClick={onToggle}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }}}
        role="button"
        tabIndex={0}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          cursor: 'pointer',
        }}
      >
        <AgentIcon domain={agent.domain} name={agent.name} />
        
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontWeight: 600, color: '#fff' }}>{agent.name}</span>
            <span style={{
              fontSize: '0.65rem',
              padding: '2px 8px',
              borderRadius: 12,
              backgroundColor: categoryColor + '33',
              color: categoryColor,
              fontWeight: 500,
            }}>
              {agent.category}
            </span>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#9ca3af', marginTop: 2 }}>
            {agent.domain}
          </div>
        </div>

        {/* Status indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <div style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: statusColor,
            animation: agent.status === 'learning' ? 'pulse 1.5s infinite' : undefined,
          }} />
          <span style={{ fontSize: '0.7rem', color: '#9ca3af', textTransform: 'capitalize' }}>
            {agent.status}
          </span>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onLearn(agent.id); }}
            disabled={agent.status === 'learning'}
            title="Learn in headless mode (background)"
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: 'none',
              backgroundColor: agent.status === 'learning' ? '#374151' : '#f59e0b',
              color: '#fff',
              fontSize: '0.75rem',
              cursor: agent.status === 'learning' ? 'not-allowed' : 'pointer',
              opacity: agent.status === 'learning' ? 0.6 : 1,
            }}
          >
            {agent.status === 'learning' ? 'Learning...' : 'Learn'}
          </button>
          
          <button
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onLearn(agent.id, { headed: true }); }}
            disabled={agent.status === 'learning'}
            title="Learn in visible mode (watch the browser)"
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.2)',
              backgroundColor: agent.status === 'learning' ? '#374151' : 'transparent',
              color: '#9ca3af',
              fontSize: '0.75rem',
              cursor: agent.status === 'learning' ? 'not-allowed' : 'pointer',
              opacity: agent.status === 'learning' ? 0.6 : 1,
            }}
          >
            👁️
          </button>
          
          <button
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onTrain(agent.id); }}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: 'none',
              backgroundColor: '#3b82f6',
              color: '#fff',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            Train
          </button>

          <button
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onEdit(agent.id); }}
            style={{
              padding: '6px 10px',
              borderRadius: 6,
              border: 'none',
              backgroundColor: 'transparent',
              color: '#9ca3af',
              fontSize: '0.75rem',
              cursor: 'pointer',
            }}
          >
            ✏️
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          {/* Description */}
          {agent.userGoals && agent.userGoals.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: '0.7rem', color: '#6b7280', marginBottom: 4 }}>
                Goals ({agent.userGoals.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {agent.userGoals.map((goal, idx) => (
                  <span 
                    key={idx}
                    style={{ 
                      fontSize: '0.8rem', 
                      color: '#d1d5db',
                      backgroundColor: 'rgba(255,255,255,0.05)',
                      padding: '2px 8px',
                      borderRadius: 4,
                    }}
                  >
                    {goal}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Learned States */}
          {agent.learnedStates && agent.learnedStates.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: '0.7rem', color: '#6b7280', marginBottom: 4 }}>Learned Pages</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {agent.learnedStates.map((state) => (
                  <span key={state} style={{
                    fontSize: '0.65rem',
                    padding: '3px 8px',
                    borderRadius: 4,
                    backgroundColor: 'rgba(16,185,129,0.15)',
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
              <div style={{ fontSize: '0.7rem', color: '#6b7280', marginBottom: 8 }}>Skills</div>
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
            <div style={{ marginTop: 12, fontSize: '0.65rem', color: '#6b7280' }}>
              Last learned: {new Date(agent.lastLearned).toLocaleDateString()}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Individual skill row
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
      padding: '8px 12px',
      backgroundColor: 'rgba(255,255,255,0.03)',
      borderRadius: 6,
      marginBottom: 6,
      gap: 12,
    }}>
      <input 
        type="checkbox" 
        checked={!isDraft}
        readOnly
        style={{ cursor: 'default' }}
      />
      
      <div style={{ flex: 1 }}>
        <div style={{ 
          fontSize: '0.8rem', 
          color: '#d1d5db',
          textDecoration: isDraft ? 'none' : 'none'
        }}>
          {skill.name}
        </div>
        {skill.description && (
          <div style={{ fontSize: '0.65rem', color: '#6b7280' }}>{skill.description}</div>
        )}
        {skill.parameters && skill.parameters.length > 0 && (
          <div style={{ fontSize: '0.6rem', color: '#4b5563', marginTop: 2 }}>
            params: {skill.parameters.join(', ')}
          </div>
        )}
      </div>

      <span style={{
        fontSize: '0.6rem',
        padding: '2px 6px',
        borderRadius: 4,
        backgroundColor: isDraft ? 'rgba(245,158,11,0.2)' : 'rgba(16,185,129,0.2)',
        color: isDraft ? '#f59e0b' : '#10b981',
      }}>
        {skill.status}
      </span>

      <button
        onClick={onTest}
        style={{
          padding: '4px 10px',
          borderRadius: 4,
          border: 'none',
          backgroundColor: '#374151',
          color: '#fff',
          fontSize: '0.7rem',
          cursor: 'pointer',
        }}
      >
        Test
      </button>

      {isDraft && (
        <button
          onClick={onPublish}
          style={{
            padding: '4px 10px',
            borderRadius: 4,
            border: 'none',
            backgroundColor: '#10b981',
            color: '#fff',
            fontSize: '0.7rem',
            cursor: 'pointer',
          }}
        >
          Publish
        </button>
      )}
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
  const [localItems, setLocalItems] = useState<AgentItem[]>(items);

  // Sync with props
  useEffect(() => {
    setLocalItems(items);
  }, [items]);

  // Listen for agent updates from main process
  useEffect(() => {
    if (!ipcRenderer) return;

    const handleAgentUpdate = (_: any, data: { agentId: string; status: string; progress?: number }) => {
      setLocalItems(prev => prev.map(agent => 
        agent.id === data.agentId 
          ? { ...agent, status: data.status as any }
          : agent
      ));
    };

    const handleNewAgent = (_: any, agent: AgentItem) => {
      setLocalItems(prev => [...prev, agent]);
    };

    ipcRenderer.on('agents:update', handleAgentUpdate);
    ipcRenderer.on('agents:new', handleNewAgent);

    return () => {
      ipcRenderer.removeListener('agents:update', handleAgentUpdate);
      ipcRenderer.removeListener('agents:new', handleNewAgent);
    };
  }, []);

  const handleLearn = (agentId: string, options: { headed?: boolean } = {}) => {
    ipcRenderer?.send('agents:learn', { agentId, options });
    
    // Optimistic UI update
    setLocalItems(prev => prev.map(agent => 
      agent.id === agentId 
        ? { ...agent, status: 'learning' }
        : agent
    ));
  };

  const handleTrain = (agentId: string) => {
    ipcRenderer?.send('agents:train', { agentId });
  };

  const handleEdit = (agentId: string) => {
    // TODO: Open edit modal
    console.log('Edit agent:', agentId);
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
    ipcRenderer?.send('agents:create', { domain, goals });
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
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 20,
      }}>
        <div>
          <h2 style={{ margin: 0, color: '#fff', fontSize: '1.2rem' }}>Agents</h2>
          <p style={{ margin: '4px 0 0 0', color: '#9ca3af', fontSize: '0.8rem' }}>
            Domain-specific automation agents that learn and adapt
          </p>
        </div>
        
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={onRefresh}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.2)',
              backgroundColor: 'transparent',
              color: '#9ca3af',
              fontSize: '0.8rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            🔄 Refresh
          </button>
          
          <button
            onClick={() => setIsCreateModalOpen(true)}
            style={{
              padding: '8px 14px',
              borderRadius: 6,
              border: 'none',
              backgroundColor: '#3b82f6',
              color: '#fff',
              fontSize: '0.8rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            + Create Agent
          </button>
        </div>
      </div>

      {/* Agent list */}
      {localItems.length === 0 ? (
        <div style={{
          textAlign: 'center',
          padding: 60,
          color: '#6b7280',
        }}>
          <div style={{ fontSize: '3rem', marginBottom: 16 }}>🤖</div>
          <div style={{ fontSize: '1rem', marginBottom: 8 }}>No agents yet</div>
          <div style={{ fontSize: '0.85rem' }}>
            Create your first agent to start automating websites
          </div>
        </div>
      ) : (
        localItems.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onLearn={handleLearn}
            onTrain={handleTrain}
            onEdit={handleEdit}
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

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}
