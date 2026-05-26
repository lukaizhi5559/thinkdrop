import { useState, useEffect, useCallback } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

// Types
interface ContextRule {
  id: string;
  contextType: string;
  contextKey: string;
  ruleText: string;
  category: string;
  source: string;
  hitCount: number;
  createdAt: string;
  updatedAt: string;
  status: string;
  priority: number;
  verifiedCount: number;
  failedCount: number;
  lastVerifiedAt?: string;
  userNote?: string;
}

interface ConstraintRule {
  id: string;
  scope: string;
  rule: string;
  severity: 'hard' | 'soft';
  pinProtected: boolean;
  blocks: string[];
}

type GroupedContextRules = Record<string, ContextRule[]>;

// No props needed - this is a tab component like SettingsTab

// Category icons
const CATEGORY_ICONS: Record<string, string> = {
  interaction: '🖱️',
  content: '📝',
  keyboard: '⌨️',
  auth: '🔐',
  general: '📋',
};

const SOURCE_BADGES: Record<string, { label: string; color: string }> = {
  system: { label: 'System', color: '#3b82f6' },
  thinkdrop_ai: { label: 'AI', color: '#8b5cf6' },
  evaluate_skills_auto: { label: 'Auto', color: '#f59e0b' },
  user: { label: 'User', color: '#10b981' },
};

export function RulesManagementPanel() {
  // State
  const [contextRules, setContextRules] = useState<GroupedContextRules>({});
  const [constraints, setConstraints] = useState<ConstraintRule[]>([]);
  const [allowedCmds, setAllowedCmds] = useState<{ builtin: string[]; user: string[] }>({ builtin: [], user: [] });
  const [newCmdInput, setNewCmdInput] = useState('');
  const [newCmdError, setNewCmdError] = useState<string | null>(null);
  const [expandedDomains, setExpandedDomains] = useState<Set<string>>(new Set());
  const [expandedSections, setExpandedSections] = useState({
    contextRules: true,
    constraints: false,
    allowedCommands: false,
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingRule, setEditingRule] = useState<ContextRule | ConstraintRule | null>(null);
  const [editingType, setEditingType] = useState<'context' | 'constraint' | null>(null);
  const [cleanupDomain, setCleanupDomain] = useState<string | null>(null);
  const [cleanupAnalysis, setCleanupAnalysis] = useState<any>(null);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);
  const [clearAllStats, setClearAllStats] = useState({ total: 0, domains: 0 });
  const [showDomainDeleteConfirm, setShowDomainDeleteConfirm] = useState(false);
  const [domainToDelete, setDomainToDelete] = useState<string | null>(null);
  const [domainDeleteCount, setDomainDeleteCount] = useState(0);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createType, setCreateType] = useState<'context' | 'constraint'>('context');

  // Load rules
  const loadRules = useCallback(async () => {
    if (!ipcRenderer) {
      console.error('[RulesManagementPanel] ipcRenderer not available');
      setLoadError('IPC not available');
      return;
    }
    setIsLoading(true);
    setLoadError(null);
    try {
      console.log('[RulesManagementPanel] Loading rules...');
      const [contextResult, constraintsResult, allowedCmdsResult] = await Promise.all([
        ipcRenderer.invoke('rules:context:list_all'),
        ipcRenderer.invoke('rules:constraint:list'),
        ipcRenderer.invoke('rules:allowedcmds:list'),
      ]);
      console.log('[RulesManagementPanel] Context result:', contextResult);
      console.log('[RulesManagementPanel] Constraints result:', constraintsResult);
      console.log('[RulesManagementPanel] Allowed cmds result:', allowedCmdsResult);
      
      // Handle different response structures
      const contextData = contextResult?.data?.grouped || contextResult?.grouped || {};
      const constraintsData = constraintsResult?.data?.constraints || constraintsResult?.constraints || [];
      
      setContextRules(contextData);
      setConstraints(constraintsData);
      setAllowedCmds({
        builtin: allowedCmdsResult?.builtin || [],
        user: allowedCmdsResult?.user || [],
      });
      
      // Check for errors in response
      if (contextResult?.error) {
        setLoadError(`Context rules error: ${contextResult.error}`);
      } else if (constraintsResult?.error) {
        setLoadError(`Constraints error: ${constraintsResult.error}`);
      }
      
      console.log('[RulesManagementPanel] Loaded', Object.keys(contextData).length, 'domains,', constraintsData.length, 'constraints');
    } catch (error) {
      console.error('[RulesManagementPanel] Failed to load rules:', error);
      setLoadError(error instanceof Error ? error.message : 'Failed to load rules');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  // Toggle domain expansion
  const toggleDomain = (domain: string) => {
    setExpandedDomains(prev => {
      const next = new Set(prev);
      if (next.has(domain)) {
        next.delete(domain);
      } else {
        next.add(domain);
      }
      return next;
    });
  };

  // Toggle section expansion
  const toggleSection = (section: 'contextRules' | 'constraints') => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  // Delete context rule
  const deleteContextRule = async (id: string) => {
    if (!ipcRenderer) return;
    if (!confirm('Are you sure you want to delete this rule?')) return;
    
    try {
      await ipcRenderer.invoke('rules:context:delete', { id });
      await loadRules();
    } catch (error) {
      console.error('[RulesManagementPanel] Failed to delete rule:', error);
    }
  };

  // Delete constraint
  const deleteConstraint = async (id: string) => {
    if (!ipcRenderer) return;
    if (!confirm('Are you sure you want to delete this constraint?')) return;
    
    try {
      await ipcRenderer.invoke('rules:constraint:remove', { id });
      await loadRules();
    } catch (error) {
      console.error('[RulesManagementPanel] Failed to delete constraint:', error);
    }
  };

  // Update rule priority
  const updateRulePriority = async (id: string, priority: number) => {
    if (!ipcRenderer) return;
    try {
      await ipcRenderer.invoke('rules:context:update', { id, updates: { priority } });
      await loadRules();
    } catch (error) {
      console.error('[RulesManagementPanel] Failed to update priority:', error);
    }
  };

  // Analyze domain for cleanup
  const analyzeDomain = async (domain: string) => {
    if (!ipcRenderer) return;
    setIsLoading(true);
    try {
      const result = await ipcRenderer.invoke('rules:context:cleanup', { contextKey: domain });
      setCleanupAnalysis(result);
      setCleanupDomain(domain);
    } catch (error) {
      console.error('[RulesManagementPanel] Failed to analyze domain:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Delete ALL context rules across all domains
  const promptClearAllConfirm = () => {
    const domainCount = Object.keys(contextRules).length;
    const totalRules = Object.values(contextRules).reduce((sum, rules) => sum + rules.length, 0);
    setClearAllStats({ total: totalRules, domains: domainCount });
    setShowClearAllConfirm(true);
  };

  const executeClearAll = async () => {
    if (!ipcRenderer) return;
    setShowClearAllConfirm(false);
    setIsLoading(true);
    try {
      const domains = Object.keys(contextRules);
      await Promise.all(domains.map(domain => 
        ipcRenderer.invoke('rules:context:delete_by_key', { contextKey: domain })
      ));
      await loadRules();
    } catch (error) {
      console.error('[RulesManagementPanel] Failed to delete all rules:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const executeDomainDelete = async () => {
    if (!ipcRenderer || !domainToDelete) return;
    setShowDomainDeleteConfirm(false);
    setIsLoading(true);
    try {
      await ipcRenderer.invoke('rules:context:delete_by_key', { contextKey: domainToDelete });
      await loadRules();
    } catch (error) {
      console.error('[RulesManagementPanel] Failed to delete domain rules:', error);
    } finally {
      setIsLoading(false);
      setDomainToDelete(null);
    }
  };

  // Filter rules based on search
  const filteredDomains = Object.entries(contextRules).filter(([domain, rules]) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return domain.toLowerCase().includes(query) || 
           rules.some(r => r.ruleText.toLowerCase().includes(query));
  });

  const filteredConstraints = constraints.filter(c => {
    if (!searchQuery) return true;
    return c.rule.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const filteredBuiltinCmds = allowedCmds.builtin.filter(c =>
    !searchQuery || c.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const filteredUserCmds = allowedCmds.user.filter(c =>
    !searchQuery || c.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const addAllowedCmd = async () => {
    const cmd = newCmdInput.trim().toLowerCase();
    if (!cmd) return;
    if (/[;&|`$<>\\/ ]/.test(cmd)) {
      setNewCmdError('Invalid command name — no spaces or special characters');
      return;
    }
    setNewCmdError(null);
    try {
      await ipcRenderer.invoke('rules:allowedcmds:add', { command: cmd });
      setNewCmdInput('');
      await loadRules();
    } catch (err) {
      setNewCmdError('Failed to add command');
    }
  };

  const removeAllowedCmd = async (cmd: string) => {
    try {
      await ipcRenderer.invoke('rules:allowedcmds:remove', { command: cmd });
      await loadRules();
    } catch (err) {
      console.error('[RulesManagementPanel] Failed to remove command:', err);
    }
  };

  const resetAllowedCmds = async () => {
    if (!confirm('Reset user-added commands? Built-in commands are unaffected.')) return;
    try {
      await ipcRenderer.invoke('rules:allowedcmds:reset');
      await loadRules();
    } catch (err) {
      console.error('[RulesManagementPanel] Failed to reset commands:', err);
    }
  };

  // Detect conflicts within a domain
  const detectConflicts = (rules: ContextRule[]): string[] => {
    const conflicts: string[] = [];
    const hasApiRule = rules.some(r => /api|python/i.test(r.ruleText));
    const hasBrowserRule = rules.some(r => /browser\.act|playwright/i.test(r.ruleText));
    if (hasApiRule && hasBrowserRule) {
      conflicts.push('API vs Browser conflict');
    }
    return conflicts;
  };

  return (
    <div className="space-y-6">
      {/* Error Message */}
      {loadError && (
        <div className="px-4 py-2 bg-red-500/20 border border-red-500/30 rounded-lg">
          <p className="text-xs text-red-400">{loadError}</p>
        </div>
      )}

      {/* Info Text */}
      <div className="text-xs text-gray-500">
        <p>Context rules guide LLM planning • Constraints protect you from mistakes</p>
      </div>

      {/* Search */}
      <div>
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search rules..."
            className="w-full px-3 py-2 rounded-md text-sm text-gray-300 placeholder-gray-500 outline-none"
            style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-400"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="w-6 h-6 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
        </div>
      )}

          {/* Context Rules Section */}
          <div>
            <div className="flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/5 transition-colors">
              <button
                onClick={() => toggleSection('contextRules')}
                className="flex-1 flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-gray-300">
                    Site Context Rules
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400">
                    {Object.keys(contextRules).length} domains
                  </span>
                </div>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-gray-500 transition-transform"
                  style={{ transform: expandedSections.contextRules ? 'rotate(180deg)' : 'rotate(0deg)' }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {Object.keys(contextRules).length > 0 && (
                <button
                  onClick={() => promptClearAllConfirm()}
                  className="ml-2 px-2 py-1 rounded text-xs font-medium bg-red-600/80 hover:bg-red-500 text-white transition-colors"
                  title="Delete ALL context rules"
                >
                  Clear All
                </button>
              )}
            </div>

            {expandedSections.contextRules && (
              <div className="mt-2 space-y-2">
                {filteredDomains.length === 0 ? (
                  <p className="text-sm text-gray-500 px-3 py-2">No context rules found</p>
                ) : (
                  filteredDomains.map(([domain, rules]) => {
                    const conflicts = detectConflicts(rules);
                    const isExpanded = expandedDomains.has(domain);

                    return (
                      <div
                        key={domain}
                        className="rounded-lg overflow-hidden"
                        style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)' }}
                      >
                        {/* Domain Header */}
                        <div
                          className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-white/5 transition-colors"
                          onClick={() => toggleDomain(domain)}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              className="text-gray-500 flex-shrink-0 transition-transform"
                              style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                            >
                              <polyline points="9 18 15 12 9 6" />
                            </svg>
                            <span className="text-sm text-gray-300 truncate">{domain}</span>
                            <span className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 flex-shrink-0">
                              {rules.length}
                            </span>
                            {conflicts.length > 0 && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400 flex-shrink-0" title={conflicts.join(', ')}>
                                ⚠️
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setDomainToDelete(domain);
                                setDomainDeleteCount(rules.length);
                                setShowDomainDeleteConfirm(true);
                              }}
                              className="p-1.5 rounded hover:bg-white/10 text-gray-500 hover:text-red-400 transition-colors"
                              title="Delete all rules for this domain"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                            {/* <button
                              onClick={(e) => {
                                e.stopPropagation();
                                analyzeDomain(domain);
                              }}
                              className="p-1.5 rounded hover:bg-white/10 text-gray-500 hover:text-amber-400 transition-colors"
                              title="Analyze this domain"
                            >
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 6h18" />
                                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                              </svg>
                            </button> */}
                          </div>
                        </div>

                        {/* Rules List */}
                        {isExpanded && (
                          <div className="px-3 pb-2 space-y-1">
                            {rules.map((rule) => (
                              <div
                                key={rule.id}
                                className="flex items-start gap-2 p-2 rounded hover:bg-white/5 transition-colors group"
                              >
                                <span className="text-sm flex-shrink-0" title={rule.category}>
                                  {CATEGORY_ICONS[rule.category] || '📋'}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <p className="text-sm text-gray-300 truncate" title={rule.ruleText}>
                                    {rule.ruleText}
                                  </p>
                                  <div className="flex items-center gap-2 mt-1">
                                    <span
                                      className="text-[10px] px-1.5 py-0.5 rounded"
                                      style={{
                                        backgroundColor: SOURCE_BADGES[rule.source]?.color + '20' || 'rgba(255,255,255,0.1)',
                                        color: SOURCE_BADGES[rule.source]?.color || '#9ca3af',
                                      }}
                                    >
                                      {SOURCE_BADGES[rule.source]?.label || rule.source}
                                    </span>
                                    {rule.verifiedCount > 0 && (
                                      <span className="text-[10px] text-green-400">
                                        ✓ {rule.verifiedCount}
                                      </span>
                                    )}
                                    {rule.failedCount > 0 && (
                                      <span className="text-[10px] text-red-400">
                                        ✗ {rule.failedCount}
                                      </span>
                                    )}
                                    {rule.priority > 0 && (
                                      <span className="text-[10px] text-amber-400">
                                        ⭐ {rule.priority}
                                      </span>
                                    )}
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button
                                    onClick={() => updateRulePriority(rule.id, rule.priority > 0 ? 0 : 10)}
                                    className={`p-1 rounded hover:bg-white/10 transition-colors ${rule.priority > 0 ? 'text-amber-400' : 'text-gray-500'}`}
                                    title={rule.priority > 0 ? 'Remove priority' : 'Boost priority'}
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => {
                                      setEditingRule(rule);
                                      setEditingType('context');
                                    }}
                                    className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-blue-400 transition-colors"
                                    title="Edit"
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                    </svg>
                                  </button>
                                  <button
                                    onClick={() => deleteContextRule(rule.id)}
                                    className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-red-400 transition-colors"
                                    title="Delete"
                                  >
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="3 6 5 6 21 6" />
                                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

          {/* Constraints Section */}
          <div>
            <button
              onClick={() => toggleSection('constraints')}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/5 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-300">
                  User Constraints
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400">
                  {constraints.length} rules
                </span>
              </div>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-gray-500 transition-transform"
                style={{ transform: expandedSections.constraints ? 'rotate(180deg)' : 'rotate(0deg)' }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {expandedSections.constraints && (
              <div className="mt-2 space-y-2">
                {filteredConstraints.length === 0 ? (
                  <p className="text-sm text-gray-500 px-3 py-2">No constraints found</p>
                ) : (
                  filteredConstraints.map((constraint) => (
                    <div
                      key={constraint.id}
                      className="flex items-start gap-2 p-3 rounded-lg hover:bg-white/5 transition-colors group"
                      style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)' }}
                    >
                      <span className="text-lg">
                        {constraint.severity === 'hard' ? '🚫' : '⚠️'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-gray-300">{constraint.rule}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                            {constraint.severity}
                          </span>
                          {constraint.pinProtected && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                              🔒 PIN
                            </span>
                          )}
                          <span className="text-[10px] text-gray-500">
                            scope: {constraint.scope}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => {
                            setEditingRule(constraint);
                            setEditingType('constraint');
                          }}
                          className="p-1.5 rounded hover:bg-white/10 text-gray-500 hover:text-blue-400 transition-colors"
                          title="Edit"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                        </button>
                        <button
                          onClick={() => deleteConstraint(constraint.id)}
                          className="p-1.5 rounded hover:bg-white/10 text-gray-500 hover:text-red-400 transition-colors"
                          title="Delete"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Allowed Commands Section */}
          <div>
            <button
              onClick={() => setExpandedSections(prev => ({ ...prev, allowedCommands: !prev.allowedCommands }))}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-white/5 transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-300">
                  Allowed Commands
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-400">
                  {allowedCmds.builtin.length + allowedCmds.user.length} commands
                </span>
              </div>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-gray-500 transition-transform"
                style={{ transform: expandedSections.allowedCommands ? 'rotate(180deg)' : 'rotate(0deg)' }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>

            {expandedSections.allowedCommands && (
              <div className="mt-2 space-y-3">
                <p className="text-xs text-gray-500 px-1">
                  Commands ThinkDrop can execute directly. Built-in commands (🔒) cannot be removed. Add custom CLIs below.
                </p>

                {/* Built-in commands */}
                {filteredBuiltinCmds.length > 0 && (
                  <div>
                    <p className="text-[10px] text-gray-600 px-1 mb-1.5 uppercase tracking-wider">Built-in</p>
                    <div className="flex flex-wrap gap-1.5">
                      {filteredBuiltinCmds.map(cmd => (
                        <span
                          key={cmd}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs text-gray-400"
                          style={{ backgroundColor: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
                        >
                          <span className="text-[10px]">🔒</span>
                          {cmd}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* User-added commands */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <p className="text-[10px] text-gray-600 px-1 uppercase tracking-wider">User-added</p>
                    {allowedCmds.user.length > 0 && (
                      <button
                        onClick={resetAllowedCmds}
                        className="text-[10px] text-gray-600 hover:text-red-400 transition-colors px-1"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                  {filteredUserCmds.length === 0 && !searchQuery ? (
                    <p className="text-xs text-gray-600 px-1">No user-added commands yet</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {filteredUserCmds.map(cmd => (
                        <span
                          key={cmd}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs text-gray-300"
                          style={{ backgroundColor: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)' }}
                        >
                          {cmd}
                          <button
                            onClick={() => removeAllowedCmd(cmd)}
                            className="ml-0.5 text-gray-500 hover:text-red-400 transition-colors"
                            title="Remove"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="18" y1="6" x2="6" y2="18" />
                              <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Add new command */}
                <div className="pt-1">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newCmdInput}
                      onChange={e => { setNewCmdInput(e.target.value); setNewCmdError(null); }}
                      onKeyDown={e => e.key === 'Enter' && addAllowedCmd()}
                      placeholder="Add command (e.g. my-cli)"
                      className="flex-1 px-3 py-1.5 rounded text-xs text-gray-300 placeholder-gray-600 outline-none"
                      style={{ backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
                    />
                    <button
                      onClick={addAllowedCmd}
                      disabled={!newCmdInput.trim()}
                      className="px-3 py-1.5 rounded text-xs font-medium text-white transition-colors disabled:opacity-40"
                      style={{ backgroundColor: 'rgba(59,130,246,0.6)' }}
                    >
                      Add
                    </button>
                  </div>
                  {newCmdError && (
                    <p className="text-[10px] text-red-400 mt-1 px-1">{newCmdError}</p>
                  )}
                </div>
              </div>
            )}
          </div>

      {/* Edit Modal */}
      {editingRule && editingType && (
        <EditRuleModal
          rule={editingRule}
          type={editingType}
          onClose={() => {
            setEditingRule(null);
            setEditingType(null);
          }}
          onSave={async (id, updates) => {
            if (!ipcRenderer) return;
            try {
              if (editingType === 'context') {
                await ipcRenderer.invoke('rules:context:update', { id, updates });
              } else {
                await ipcRenderer.invoke('rules:constraint:update', { id, updates });
              }
              await loadRules();
              setEditingRule(null);
              setEditingType(null);
            } catch (error) {
              console.error('[RulesManagementPanel] Failed to save:', error);
            }
          }}
        />
      )}

      {/* Cleanup Modal */}
      {cleanupDomain && cleanupAnalysis && (
        <CleanupModal
          domain={cleanupDomain}
          analysis={cleanupAnalysis}
          onClose={() => {
            setCleanupDomain(null);
            setCleanupAnalysis(null);
          }}
          onApply={async (changes) => {
            // Apply cleanup changes
            await loadRules();
            setCleanupDomain(null);
            setCleanupAnalysis(null);
          }}
        />
      )}

      {/* Clear All Confirm Modal */}
      <ConfirmModal
        isOpen={showClearAllConfirm}
        title="Clear All Context Rules?"
        message={`${clearAllStats.total} rules across ${clearAllStats.domains} domains will be permanently removed.\n\nThis cannot be undone.`}
        confirmText="Delete All"
        cancelText="Cancel"
        onConfirm={executeClearAll}
        onCancel={() => setShowClearAllConfirm(false)}
        isDanger={true}
      />

      {/* Domain Delete Confirm Modal */}
      <ConfirmModal
        isOpen={showDomainDeleteConfirm}
        title={`Delete all ${domainDeleteCount} rules?`}
        message={`All rules for "${domainToDelete || ''}" will be permanently removed.\n\nThis cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={executeDomainDelete}
        onCancel={() => {
          setShowDomainDeleteConfirm(false);
          setDomainToDelete(null);
        }}
        isDanger={true}
      />

      {/* Create Modal */}
      {showCreateModal && (
        <CreateRuleModal
          type={createType}
          onClose={() => setShowCreateModal(false)}
          onSave={async (data) => {
            if (!ipcRenderer) return;
            try {
              if (createType === 'context') {
                await ipcRenderer.invoke('rules:context:create', data);
              } else {
                await ipcRenderer.invoke('rules:constraint:create', data);
              }
              await loadRules();
              setShowCreateModal(false);
            } catch (error) {
              console.error('[RulesManagementPanel] Failed to create:', error);
            }
          }}
        />
      )}
    </div>
  );
}

// Edit Rule Modal
interface EditRuleModalProps {
  rule: ContextRule | ConstraintRule;
  type: 'context' | 'constraint';
  onClose: () => void;
  onSave: (id: string, updates: any) => void;
}

function EditRuleModal({ rule, type, onClose, onSave }: EditRuleModalProps) {
  const [updates, setUpdates] = useState<any>({});

  const isContext = type === 'context';
  const contextRule = isContext ? rule as ContextRule : null;
  const constraintRule = !isContext ? rule as ConstraintRule : null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" style={{ top: '48px' }}>
      <div
        className="w-[420px] max-h-[80vh] overflow-y-auto rounded-lg p-4"
        style={{ backgroundColor: 'rgba(36, 36, 38, 0.98)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-300">Edit {isContext ? 'Context Rule' : 'Constraint'}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-400">✕</button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs text-gray-500 block mb-1">Rule Text</label>
            <textarea
              defaultValue={isContext ? contextRule?.ruleText : constraintRule?.rule}
              onChange={(e) => setUpdates({ ...updates, [isContext ? 'rule_text' : 'rule']: e.target.value })}
              className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none resize-none"
              style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', minHeight: '80px' }}
            />
          </div>

          {isContext && (
            <>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Category</label>
                <select
                  defaultValue={contextRule?.category}
                  onChange={(e) => setUpdates({ ...updates, category: e.target.value })}
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                >
                  <option value="general">General</option>
                  <option value="interaction">Interaction</option>
                  <option value="content">Content</option>
                  <option value="keyboard">Keyboard</option>
                  <option value="auth">Auth</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Priority (0-100)</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  defaultValue={contextRule?.priority}
                  onChange={(e) => setUpdates({ ...updates, priority: parseInt(e.target.value) || 0 })}
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">User Note</label>
                <input
                  type="text"
                  defaultValue={contextRule?.userNote}
                  onChange={(e) => setUpdates({ ...updates, user_note: e.target.value })}
                  placeholder="Personal annotation..."
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                />
              </div>
            </>
          )}

          {!isContext && (
            <>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Severity</label>
                <select
                  defaultValue={constraintRule?.severity}
                  onChange={(e) => setUpdates({ ...updates, severity: e.target.value })}
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                >
                  <option value="hard">Hard (block)</option>
                  <option value="soft">Soft (warn)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Scope</label>
                <input
                  type="text"
                  defaultValue={constraintRule?.scope}
                  onChange={(e) => setUpdates({ ...updates, scope: e.target.value })}
                  placeholder="global or specific service"
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                />
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs font-medium text-gray-400 hover:text-gray-300 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(rule.id, updates)}
            className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// Cleanup Modal
interface CleanupModalProps {
  domain: string;
  analysis: any;
  onClose: () => void;
  onApply: (changes: any) => void;
}

function CleanupModal({ domain, analysis, onClose, onApply }: CleanupModalProps) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" style={{ top: '48px' }}>
      <div
        className="w-[480px] max-h-[80vh] overflow-y-auto rounded-lg p-4"
        style={{ backgroundColor: 'rgba(36, 36, 38, 0.98)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-300">🧹 Cleanup: {domain}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-400">✕</button>
        </div>

        <div className="space-y-4">
          <p className="text-xs text-gray-400">
            {analysis.count} rules found. LLM analysis coming in Phase 4.
          </p>

          {/* Placeholder for LLM recommendations */}
          <div className="p-3 rounded" style={{ backgroundColor: 'rgba(255, 255, 255, 0.03)' }}>
            <p className="text-sm text-gray-500">
              Cleanup recommendations will be generated by LLM in a future update.
              For now, you can manually review and delete conflicting rules.
            </p>
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded text-xs font-medium text-gray-400 hover:text-gray-300 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => onApply({})}
              className="px-3 py-1.5 rounded text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors"
            >
              OK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Confirm Modal (reusable confirmation dialog)
interface ConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
  onCancel: () => void;
  isDanger?: boolean;
}

function ConfirmModal({ isOpen, title, message, confirmText, cancelText, onConfirm, onCancel, isDanger = false }: ConfirmModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50" style={{ top: '48px' }}>
      <div
        className="w-[420px] rounded-lg p-4"
        style={{ backgroundColor: 'rgba(36, 36, 38, 0.98)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-300">{title}</h3>
          <button onClick={onCancel} className="text-gray-500 hover:text-gray-400">✕</button>
        </div>

        <div className="space-y-4">
          <p className="text-sm text-gray-400 whitespace-pre-line">{message}</p>

          <div className="flex justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1.5 rounded text-xs font-medium text-gray-400 hover:text-gray-300 transition-colors"
            >
              {cancelText}
            </button>
            <button
              onClick={onConfirm}
              className={`px-3 py-1.5 rounded text-xs font-medium text-white transition-colors ${
                isDanger 
                  ? 'bg-red-600 hover:bg-red-500' 
                  : 'bg-blue-600 hover:bg-blue-500'
              }`}
            >
              {confirmText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Create Rule Modal
interface CreateRuleModalProps {
  type: 'context' | 'constraint';
  onClose: () => void;
  onSave: (data: any) => void;
}

function CreateRuleModal({ type, onClose, onSave }: CreateRuleModalProps) {
  const [data, setData] = useState<any>({ type });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" style={{ top: '48px' }}>
      <div
        className="w-[420px] rounded-lg p-4"
        style={{ backgroundColor: 'rgba(36, 36, 38, 0.98)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-300">Create New Rule</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-400">✕</button>
        </div>

        {/* Type selector */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setData({ ...data, type: 'context' })}
            className={`flex-1 px-3 py-2 rounded text-xs font-medium transition-colors ${
              data.type === 'context'
                ? 'bg-blue-600 text-white'
                : 'bg-white/5 text-gray-400 hover:bg-white/10'
            }`}
          >
            Context Rule
          </button>
          <button
            onClick={() => setData({ ...data, type: 'constraint' })}
            className={`flex-1 px-3 py-2 rounded text-xs font-medium transition-colors ${
              data.type === 'constraint'
                ? 'bg-blue-600 text-white'
                : 'bg-white/5 text-gray-400 hover:bg-white/10'
            }`}
          >
            Constraint
          </button>
        </div>

        <div className="space-y-3">
          {data.type === 'context' ? (
            <>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Domain (e.g., mail.google.com)</label>
                <input
                  type="text"
                  onChange={(e) => setData({ ...data, contextKey: e.target.value })}
                  placeholder="example.com"
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Rule Text</label>
                <textarea
                  onChange={(e) => setData({ ...data, ruleText: e.target.value })}
                  placeholder="e.g., Use browser.act to click the Send button"
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none resize-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)', minHeight: '80px' }}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Category</label>
                <select
                  onChange={(e) => setData({ ...data, category: e.target.value })}
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                >
                  <option value="general">General</option>
                  <option value="interaction">Interaction</option>
                  <option value="content">Content</option>
                  <option value="keyboard">Keyboard</option>
                  <option value="auth">Auth</option>
                </select>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Rule (e.g., Never let me delete files)</label>
                <input
                  type="text"
                  onChange={(e) => setData({ ...data, rule: e.target.value })}
                  placeholder="Describe what should be blocked..."
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                />
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Severity</label>
                <select
                  onChange={(e) => setData({ ...data, severity: e.target.value })}
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                >
                  <option value="hard">Hard (block action)</option>
                  <option value="soft">Soft (show warning)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Scope</label>
                <input
                  type="text"
                  onChange={(e) => setData({ ...data, scope: e.target.value })}
                  placeholder="global or specific service"
                  defaultValue="global"
                  className="w-full px-3 py-2 rounded text-sm text-gray-300 outline-none"
                  style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.1)' }}
                />
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-xs font-medium text-gray-400 hover:text-gray-300 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(data)}
            disabled={data.type === 'context' ? !data.contextKey || !data.ruleText : !data.rule}
            className="px-3 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

export default RulesManagementPanel;
