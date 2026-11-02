import { useState, useEffect, useRef } from 'react';
import { AgentsTab } from './AgentsTab';
import { SkillsTab, type SkillItem, type AgentItem } from './TabComponents';
import DiscoverPane from './DiscoverPane';

type CapSub = 'agents' | 'skills' | 'discover';

interface CapabilitiesTabProps {
  /** Nav target — 'skills' tab → skills, 'agents' tab → agents, null when a
   *  different tab is active (internal subtab state is preserved). */
  navSubtab: 'agents' | 'skills' | null;
  agentItems: AgentItem[];
  onAgentsRefresh: () => void;
  skillItems: SkillItem[];
  onSaveSecret: (skillName: string, key: string, value: string) => void;
  onOpenCode: (filePath: string) => void;
  onOAuthConnect: (skillName: string, provider: string, tokenKey: string, scopes?: string) => void;
  onScopesChange: (skillName: string, provider: string, scopes: string) => void;
  onRepairOAuth: (skillName: string) => void;
  onSkillDelete: (skillName: string) => void;
  onInstallFromUrl?: (url: string, nameOverride?: string, descriptionOverride?: string) => void;
  onInstallFromFile?: (filePath: string, nameOverride?: string, descriptionOverride?: string) => void;
  onRefreshSkills?: () => void;
  onContentResize?: () => void;
  modalCardRef?: (el: HTMLDivElement | null) => void;
  /** Dropped SKILL.md file awaiting the Add Skill modal — forwarded to SkillsTab. */
  pendingSkillFile?: { path: string; ts: number } | null;
  onSkillFileHandled?: () => void;
  /** SkillStore "Build" kicked off — overlay switches to the results feed for progress. */
  onGoResults?: () => void;
}


// ── Segmented control ────────────────────────────────────────────────────────

const SUBTABS: { id: CapSub; label: string }[] = [
  { id: 'agents',   label: 'Agents' },
  { id: 'skills',   label: 'Skills' },
  { id: 'discover', label: 'Discover' },
];

export function CapabilitiesTab({
  navSubtab,
  agentItems,
  onAgentsRefresh,
  skillItems,
  onSaveSecret,
  onOpenCode,
  onOAuthConnect,
  onScopesChange,
  onRepairOAuth,
  onSkillDelete,
  onInstallFromUrl,
  onInstallFromFile,
  onRefreshSkills,
  onContentResize,
  modalCardRef,
  pendingSkillFile,
  onSkillFileHandled,
  onGoResults,
}: CapabilitiesTabProps) {
  const [sub, setSub] = useState<CapSub>(navSubtab || 'agents');

  // Nav re-targets the surface: drawer "Skills" → skills segment, top-bar
  // "Agents" → agents segment. Internal clicks only flip local state; a null
  // navSubtab (another tab active) leaves the last segment untouched.
  useEffect(() => { if (navSubtab) setSub(navSubtab); }, [navSubtab]);

  // A dropped SKILL.md always lands on the skills segment — even when the
  // skills tab is already active on another segment (navSubtab unchanged).
  useEffect(() => { if (pendingSkillFile) setSub('skills'); }, [pendingSkillFile]);

  const onContentResizeRef = useRef(onContentResize);
  onContentResizeRef.current = onContentResize;
  useEffect(() => {
    const t = setTimeout(() => onContentResizeRef.current?.(), 60);
    return () => clearTimeout(t);
  }, [sub]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {/* Segmented control */}
      <div style={{
        display: 'flex', gap: 2, padding: '10px 16px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0,
      }}>
        {SUBTABS.map(s => {
          const active = sub === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setSub(s.id)}
              style={{
                padding: '4px 12px', borderRadius: 6, fontSize: '0.72rem',
                fontWeight: active ? 600 : 400, cursor: 'pointer',
                border: `1px solid ${active ? 'rgba(139,92,246,0.45)' : 'transparent'}`,
                background: active ? 'rgba(139,92,246,0.16)' : 'transparent',
                color: active ? '#c4b5fd' : '#9ca3af',
                transition: 'all 0.12s',
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Agents — keeps its own internal padding (p-4) */}
      {sub === 'agents' && (
        <AgentsTab
          items={agentItems}
          onRefresh={onAgentsRefresh}
          onContentResize={onContentResize}
          modalCardRef={modalCardRef}
        />
      )}

      {/* Skills — plan-backed skills section (inside SkillsTab) + installed manager */}
      {sub === 'skills' && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
          <SkillsTab
            items={skillItems}
            onSaveSecret={onSaveSecret}
            onOpenCode={onOpenCode}
            onOAuthConnect={onOAuthConnect}
            onScopesChange={onScopesChange}
            onRepairOAuth={onRepairOAuth}
            onDelete={onSkillDelete}
            onInstallFromUrl={onInstallFromUrl}
            onInstallFromFile={onInstallFromFile}
            onRefreshSkills={onRefreshSkills}
            onContentResize={onContentResize}
            modalCardRef={modalCardRef}
            pendingSkillFile={pendingSkillFile?.path || null}
            onSkillFileHandled={onSkillFileHandled}
          />
        </div>
      )}

      {/* Discover — live aggregated skills/MCP search */}
      {sub === 'discover' && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column' }}>
          <DiscoverPane onGoResults={onGoResults} onContentResize={onContentResize} />
        </div>
      )}
    </div>
  );
}

export default CapabilitiesTab;
