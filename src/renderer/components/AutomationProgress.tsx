/**
 * AutomationProgress — Windsurf-style live automation progress display.
 *
 * Shows:
 *   1. "Generating plan..." spinner while planSkills runs
 *   2. Step list (N / total done) as executeCommand fires step events
 *   3. Stdout output inline under each completed step
 *   4. Final summary on completion or error banner on failure
 */

import { useEffect, useState, useRef } from 'react';
import { RichContentRenderer } from './rich-content';

const ipcRenderer = (window as any).electron?.ipcRenderer;

// ── Types ─────────────────────────────────────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'done' | 'failed';

interface Step {
  index: number;
  skill: string;
  description: string;
  status: StepStatus;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: number;
  savedFilePath?: string;
  guideInstruction?: string; // original instruction text preserved after guide.step completes
}

type AutomationPhase =
  | 'idle'
  | 'gathering'
  | 'planning'
  | 'executing'
  | 'done'
  | 'failed'
  | 'ask_user'
  | 'guide_step'
  | 'schedule_wait'
  | 'evaluating'
  | 'retrying_with_fix'
  | 'project_building'
  | 'plan_review';

interface GatherCredential {
  credentialKey: string;
  question: string;
  hint: string | null;
  helpUrl: string | null;
  sensitive?: boolean;
  optional?: boolean;
}

interface GatherConfirm {
  question: string;
  credentialKey: string;
  confirmId: string;
}

interface GatherOAuth {
  provider: string;
  tokenKey: string;
  scopes: string;
  skillName: string;
}

interface AskUserPrompt {
  question: string;
  options: string[];
}

interface AgentTurnEntry {
  turn: number;
  maxTurns: number;
  action?: { action?: string; [key: string]: any };
  outcome?: { ok: boolean; error?: string; result?: string };
  thoughts?: string;
}

interface AgentComplete {
  agentId: string;
  task: string;
  totalTurns: number;
  done: boolean;
  result: string;
  reasoning?: string;
  ok: boolean;
}

// ScoutMatchState is defined above the component

interface GuideStepCard {
  instruction: string;
  url: string | null;
  highlight: string | null;
  imageUrl: string | null;
  description: string;
  mode: 'page_event' | 'ipc';
}

interface AutomationProgressProps {
  onHeightChange?: () => void;
  onActiveChange?: (active: boolean) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StepIcon({ status }: { status: StepStatus }) {
  if (status === 'done') {
    return (
      <div className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
        style={{ backgroundColor: '#22c55e' }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
    );
  }
  if (status === 'running') {
    return (
      <div className="flex-shrink-0 w-4 h-4 rounded-full border-2 animate-spin"
        style={{ borderColor: '#3b82f6', borderTopColor: 'transparent' }} />
    );
  }
  if (status === 'failed') {
    return (
      <div className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
        style={{ backgroundColor: '#ef4444' }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </div>
    );
  }
  // pending
  return (
    <div className="flex-shrink-0 w-4 h-4 rounded-full"
      style={{ backgroundColor: 'rgba(156,163,175,0.25)', border: '1px solid rgba(156,163,175,0.4)' }} />
  );
}

function humanizeError(error: string): string {
  if (!error) return error;
  // Strip [MCPClient] prefix and URL noise
  let msg = error
    .replace(/\[MCPClient\]\s*/g, '')
    .replace(/Request timeout after \d+ms:\s*https?:\/\/[^\s]+/g, 'Request timed out')
    .replace(/https?:\/\/\S+/g, '')
    .trim();
  // Map common internal errors to human-readable messages
  if (msg.includes('timed out') || msg.includes('timeout')) {
    return 'Step timed out — retrying with more time...';
  }
  if (msg.includes('ECONNREFUSED') || msg.includes('connection refused')) {
    return 'Could not reach the service — is it running?';
  }
  if (msg.includes('permission denied') || msg.includes('EACCES')) {
    return 'Permission denied';
  }
  if (msg.includes('command not found') || msg.includes('ENOENT')) {
    return `Command not found: ${msg.match(/"([^"]+)"/)?.[1] || 'unknown'}`;
  }
  // Search returned no results — recoverSkill will REPLAN automatically
  if (msg.includes('search_no_results')) {
    return 'No results found — trying a different approach...';
  }
  // Plan parse failure
  if (msg.includes('Failed to parse skill plan') || msg.includes('unable to generate a response') || msg.includes('Could not generate a skill plan')) {
    return 'Could not generate a plan for this request. Try rephrasing it.';
  }
  // Truncate anything still too long
  return msg.length > 100 ? msg.slice(0, 100) + '…' : msg;
}

function getAgentStatusLabel(elapsedMs: number): string {
  if (elapsedMs < 8000) return 'working…';
  if (elapsedMs < 20000) return 'running command…';
  if (elapsedMs < 40000) return 'still working…';
  if (elapsedMs < 60000) return 'taking a moment…';
  return 'taking longer than expected…';
}

function formatActionLabel(action: { action?: string; url?: string; selector?: string; key?: string; [key: string]: any } | undefined | null): string {
  if (!action || typeof action !== 'object') return String(action || '');
  switch (action.action) {
    case 'goto':
    case 'navigate': {
      try { return `Go to ${new URL(action.url || '').hostname}`; } catch { return `Go to ${action.url || ''}`; }
    }
    case 'click':     return `Click "${action.selector || ''}"`;
    case 'dblclick':  return `Double-click "${action.selector || ''}"`;
    case 'fill':      return `Type into "${action.selector || ''}"`;
    case 'type':      return 'Type text';
    case 'press':     return `Press ${action.key || ''}`;
    case 'snapshot':  return 'Read page';
    case 'run-code':
    case 'evaluate':
    case 'eval':      return 'Read page data';
    case 'scroll':    return 'Scroll page';
    case 'select':    return `Select option in "${action.selector || ''}"`;
    case 'check':     return `Check "${action.selector || ''}"`;
    case 'uncheck':   return `Uncheck "${action.selector || ''}"`;
    case 'return':    return 'Return result';
    case 'run_cmd':   return `Run command`;
    case 'done':      return 'Done';
    default:          return action.action || JSON.stringify(action).slice(0, 60);
  }
}

function SkillBadge({ skill }: { skill: string }) {
  return (
    <span className="text-xs font-mono px-1.5 py-0.5 rounded"
      style={{ backgroundColor: 'rgba(59,130,246,0.15)', color: '#93c5fd', border: '1px solid rgba(59,130,246,0.25)' }}>
      {skill}
    </span>
  );
}

// ── renderWithLinks ──────────────────────────────────────────────────────────
// Splits text on https?:// URLs and renders each URL as a clickable span
// that opens via shell:open-url IPC (handled in main.js).
function renderWithLinks(text: string): React.ReactNode {
  if (!text) return text;
  const urlRegex = /https?:\/\/[^\s)>,"'<\]]+/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const url = match[0];
    parts.push(
      <span
        key={match.index}
        onClick={(e) => { e.stopPropagation(); ipcRenderer?.send('shell:open-url', url); }}
        title={`Open ${url}`}
        style={{ color: '#60a5fa', textDecoration: 'underline', cursor: 'pointer' }}
      >
        {url}
      </span>
    );
    last = match.index + url.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? <>{parts}</> : text;
}

// ── ScoutMatchCard ───────────────────────────────────────────────────────────

interface ScoutProvider {
  capability: string;
  provider: string;
  type: 'cli' | 'api';
  config: any;
  defaultProvider?: string;
}

interface ScoutMatchState {
  capability: string;
  suggestion: string;
  matches: ScoutProvider[];
  errorHint?: string | null;
  showCarrierDropdown?: boolean;
  prefillPhone?: string;
}

function ScoutMatchCard({ scout, onSelect }: { scout: ScoutMatchState; onSelect: (provider: ScoutProvider) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [gatewayPhone, setGatewayPhone] = useState(scout.prefillPhone || '');
  const [gatewayCarrier, setGatewayCarrier] = useState('');

  const handlePick = (match: ScoutProvider) => {
    setSelected(match.provider);
    onSelect(match);
  };

  const isSmsCap = /sms|text message|text me|texting|send.*text|messaging/i.test(scout.capability);

  const TYPE_COLOR: Record<string, string> = { cli: '#84cc16', api: '#38bdf8' };
  const TYPE_BG: Record<string, string> = { cli: 'rgba(132,204,22,0.10)', api: 'rgba(56,189,248,0.10)' };
  const TYPE_BORDER: Record<string, string> = { cli: 'rgba(132,204,22,0.30)', api: 'rgba(56,189,248,0.30)' };

  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.28)' }}>
      <div className="flex items-start gap-2" style={{ marginBottom: 10 }}>
        <div style={{ fontSize: '0.95rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🔭</div>
        <div>
          <div style={{ color: '#7dd3fc', fontSize: '0.76rem', fontWeight: 600, marginBottom: 2 }}>
            Found a tool for this
          </div>
          <div style={{ color: '#9ca3af', fontSize: '0.69rem', lineHeight: 1.4 }}>
            Scout found {scout.matches.length} provider{scout.matches.length > 1 ? 's' : ''} for{' '}
            <strong style={{ color: '#e5e7eb' }}>{scout.capability}</strong>. Pick one to build the skill:
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {scout.matches.map((match) => (
          <button
            key={`${match.type}-${match.provider}`}
            onClick={() => handlePick(match)}
            disabled={selected !== null}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px', borderRadius: 8, cursor: selected ? 'default' : 'pointer',
              backgroundColor: selected === match.provider ? 'rgba(56,189,248,0.18)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${selected === match.provider ? 'rgba(56,189,248,0.5)' : 'rgba(255,255,255,0.08)'}`,
              textAlign: 'left', transition: 'all 0.15s',
              opacity: selected !== null && selected !== match.provider ? 0.45 : 1,
            }}
            onMouseEnter={e => { if (!selected) e.currentTarget.style.backgroundColor = 'rgba(56,189,248,0.10)'; }}
            onMouseLeave={e => { if (!selected) e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.04)'; }}
          >
            <span style={{
              fontSize: '0.62rem', fontWeight: 700, padding: '2px 6px', borderRadius: 4, flexShrink: 0,
              color: TYPE_COLOR[match.type] || '#9ca3af',
              backgroundColor: TYPE_BG[match.type] || 'rgba(156,163,175,0.1)',
              border: `1px solid ${TYPE_BORDER[match.type] || 'rgba(156,163,175,0.2)'}`,
              textTransform: 'uppercase',
            }}>{match.type}</span>
            <span style={{ color: '#e5e7eb', fontSize: '0.76rem', fontWeight: 600 }}>{match.provider}</span>
            {match.defaultProvider === match.provider && (
              <span style={{ marginLeft: 'auto', fontSize: '0.62rem', color: '#6b7280', fontStyle: 'italic' }}>recommended</span>
            )}
            {selected === match.provider && (
              <span style={{ marginLeft: 'auto', color: '#7dd3fc', fontSize: '0.7rem' }}>Building…</span>
            )}
          </button>
        ))}

        {isSmsCap && (
          <div style={{
            marginTop: 4, padding: '8px 10px', borderRadius: 8,
            backgroundColor: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.22)',
            opacity: selected !== null && !selected.startsWith('__sms_gateway__') ? 0.45 : 1,
          }}>
            <div className="flex items-center gap-1.5" style={{ marginBottom: 6 }}>
              <span style={{
                fontSize: '0.62rem', fontWeight: 700, padding: '2px 6px', borderRadius: 4, flexShrink: 0,
                color: '#4ade80', backgroundColor: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.30)',
                textTransform: 'uppercase',
              }}>free</span>
              <span style={{ color: '#86efac', fontSize: '0.76rem', fontWeight: 600 }}>
                Send via carrier email gateway
              </span>
            </div>
            {scout.errorHint && (
              <div style={{
                color: '#fca5a5', fontSize: '0.67rem', marginBottom: 8, lineHeight: 1.4,
                padding: '4px 8px', borderRadius: 5,
                backgroundColor: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)',
              }}>
                ⚠ {scout.errorHint}
              </div>
            )}
            <div style={{ color: '#6b7280', fontSize: '0.67rem', marginBottom: 8, lineHeight: 1.4 }}>
              {scout.showCarrierDropdown
                ? 'Select your carrier manually to continue.'
                : 'Enter your number — carrier is auto-detected. No API key needed.'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                type="tel"
                placeholder="Your phone number"
                value={gatewayPhone}
                onChange={e => setGatewayPhone(e.target.value.replace(/[^\d]/g, ''))}
                disabled={selected !== null}
                maxLength={11}
                style={{
                  padding: '5px 8px', borderRadius: 6, fontSize: '0.76rem',
                  backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
                  color: '#e5e7eb', outline: 'none', fontFamily: 'monospace',
                }}
              />
              {scout.showCarrierDropdown && (
                <select
                  value={gatewayCarrier}
                  onChange={e => setGatewayCarrier(e.target.value)}
                  disabled={selected !== null}
                  style={{
                    padding: '5px 8px', borderRadius: 6, fontSize: '0.73rem',
                    backgroundColor: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)',
                    color: gatewayCarrier ? '#e5e7eb' : '#6b7280', outline: 'none',
                  }}
                >
                  <option value="">Select your carrier…</option>
                  <option value="verizon">Verizon</option>
                  <option value="at&t">AT&amp;T</option>
                  <option value="t-mobile">T-Mobile</option>
                  <option value="sprint">Sprint</option>
                  <option value="boost mobile">Boost Mobile</option>
                  <option value="cricket wireless">Cricket Wireless</option>
                  <option value="metro by t-mobile">Metro by T-Mobile</option>
                  <option value="us cellular">US Cellular</option>
                  <option value="consumer cellular">Consumer Cellular</option>
                  <option value="google fi">Google Fi</option>
                  <option value="mint mobile">Mint Mobile</option>
                  <option value="visible">Visible</option>
                  <option value="xfinity mobile">Xfinity Mobile</option>
                  <option value="straight talk">Straight Talk</option>
                  <option value="tracfone">Tracfone</option>
                  <option value="republic wireless">Republic Wireless</option>
                  <option value="simple mobile">Simple Mobile</option>
                </select>
              )}
              <button
                onClick={() => {
                  const needsCarrier = scout.showCarrierDropdown && !gatewayCarrier;
                  if (gatewayPhone.length >= 10 && selected === null && !needsCarrier) {
                    const carrierSuffix = gatewayCarrier ? `:${gatewayCarrier}` : '';
                    handlePick({
                      capability: scout.capability,
                      provider: `__sms_gateway__:${gatewayPhone}${carrierSuffix}`,
                      type: 'api',
                      config: {},
                    });
                  }
                }}
                disabled={gatewayPhone.length < 10 || selected !== null || !!(scout.showCarrierDropdown && !gatewayCarrier)}
                style={{
                  padding: '5px 12px', borderRadius: 6, fontSize: '0.73rem', fontWeight: 600,
                  backgroundColor: gatewayPhone.length >= 10 && selected === null && !(scout.showCarrierDropdown && !gatewayCarrier)
                    ? 'rgba(34,197,94,0.20)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${gatewayPhone.length >= 10 && selected === null && !(scout.showCarrierDropdown && !gatewayCarrier)
                    ? 'rgba(34,197,94,0.40)' : 'rgba(255,255,255,0.08)'}`,
                  color: gatewayPhone.length >= 10 && selected === null && !(scout.showCarrierDropdown && !gatewayCarrier) ? '#4ade80' : '#4b5563',
                  cursor: gatewayPhone.length >= 10 && selected === null && !(scout.showCarrierDropdown && !gatewayCarrier) ? 'pointer' : 'default',
                  alignSelf: 'flex-end',
                }}
              >
                {selected?.startsWith('__sms_gateway__') ? 'Detecting…' : 'Use this →'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

function parsePlanStepTitles(content: string): string[] {
  const titles: string[] = [];
  const stepRegex = /^#{2,3}\s+(?:[⬜🔄✅❌⏭]\s+)?Step\s+\d+[:\s\u2014\u2013-]+(.+)/iu;
  for (const line of content.split('\n')) {
    const m = line.match(stepRegex);
    if (m) titles.push(m[1].trim());
  }
  return titles;
}

export default function AutomationProgress({ onHeightChange, onActiveChange }: AutomationProgressProps) {
  const [phase, setPhase] = useState<AutomationPhase>('idle');
  const [steps, setSteps] = useState<Step[]>([]);
  const [planMessage, setPlanMessage] = useState('Generating skill plan...');
  const [totalCount, setTotalCount] = useState(0);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  const [synthesisAnswer, setSynthesisAnswer] = useState<string>('');
  const [savedFilePaths, setSavedFilePaths] = useState<string[]>([]);
  const [askUserPrompt, setAskUserPrompt] = useState<AskUserPrompt | null>(null);
  const [guideStep, setGuideStep] = useState<GuideStepCard | null>(null);
  const [intentType, setIntentType] = useState<string | null>(null);
  const [scheduleCountdown, setScheduleCountdown] = useState<{ label: string; targetTime: string; remainingMs: number } | null>(null);
  const [evalMessage, setEvalMessage] = useState<string>('');
  const [retryMessage, setRetryMessage] = useState<string>('');
  const [skillBuildConfirm, setSkillBuildConfirm] = useState<{ skillName: string; summary: string } | null>(null);
  const [scoutMatch, setScoutMatch] = useState<ScoutMatchState | null>(null);
  const [gatherCredential, setGatherCredential] = useState<GatherCredential | null>(null);
  const [gatherConfirm, setGatherConfirm] = useState<GatherConfirm | null>(null);
  const [gatherCredentialValue, setGatherCredentialValue] = useState('');
  const [gatherCredentialStored, setGatherCredentialStored] = useState<string | null>(null);
  const [gatherOAuth, setGatherOAuth] = useState<GatherOAuth | null>(null);
  const [gatherOAuthConnecting, setGatherOAuthConnecting] = useState(false);
  // Login guidance — shown inline while waitForAuth polls (step stays running)
  const [loginGuidance, setLoginGuidance] = useState<{ stepIndex: number; serviceDisplay: string; loginUrl: string; message: string } | null>(null);
  const [gatherOAuthConnected, setGatherOAuthConnected] = useState<string | null>(null);
  // Maps stepIndex → array of agent turn entries (populated post-hoc from cli.agent / browser.agent runs)
  const [agentTurns, setAgentTurns] = useState<Map<number, AgentTurnEntry[]>>(new Map());
  const [agentCompletes, setAgentCompletes] = useState<Map<number, AgentComplete>>(new Map());
  const [expandedAgentSteps, setExpandedAgentSteps] = useState<Set<number>>(new Set());
  // Maps stepIndex → array of learned rule strings saved to memory during that step
  const [learnedRules, setLearnedRules] = useState<Map<number, string[]>>(new Map());
  // Maps stepIndex → LLM thought strings from browser.agent (plan / replan / repair phases)
  const [agentThoughts, setAgentThoughts] = useState<Map<number, string[]>>(new Map());
  const [projectBuild, setProjectBuild] = useState<{ capability: string; iteration: number; message: string; passed: boolean; failed: boolean; errorMsg: string | null } | null>(null);
  const [projectBuildFiles, setProjectBuildFiles] = useState<string[]>([]);
  const [controlMode, setControlMode] = useState<{ active: boolean; app: string | null }>({ active: false, app: null });
  const [planReview, setPlanReview] = useState<{
    planFile: string;
    content: string;
    title: string;
    isExisting: boolean;
    similarity?: number;
  } | null>(null);

  // Maintenance scan state
  const [maintenanceScan, setMaintenanceScan] = useState<{
    active: boolean;
    trigger: string;
    total: number;
    completed: number;
    agents: string[];
    doneAgents: string[];
    currentAgent: string | null;
  } | null>(null);
  const [scanDiscovery, setScanDiscovery] = useState<{ hostname: string; visits: number }[] | null>(null);

  // Ref to track current phase — avoids stale closure issues in the IPC listener useEffect
  const phaseRef = useRef<AutomationPhase>('idle');
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Refs for auto-scrolling to the active step
  const stepRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Tracks global step index offset across multi-intent queue sub-plans.
  // When plan_ready fires for a second/third sub-intent, new steps are appended
  // at this offset so the user sees a cumulative list instead of a reset view.
  const stepOffsetRef = useRef<number>(0);
  // Tracks when each running step started (for flickering heartbeat status)
  const agentStepStartTimes = useRef<Map<number, number>>(new Map());
  // Tracks live turn progress (agent:turn_live) from the command-service callback
  const agentLiveTurns = useRef<Map<number, { turn: number; maxTurns: number }>>(new Map());
  const [_heartbeatTick, setHeartbeatTick] = useState(0);

  // Notify parent to re-measure height whenever visible content changes
  useEffect(() => {
    onHeightChange?.();
  }, [phase, steps, expandedSteps]);

  // Notify parent when we become active/inactive
  // Only active during planning/executing — done/failed/idle should NOT keep the glow on
  useEffect(() => {
    onActiveChange?.(phase !== 'idle');
  }, [phase]);

  // Heartbeat ticker — drives flickering status labels on running steps
  useEffect(() => {
    if (phase !== 'executing') return;
    const id = setInterval(() => setHeartbeatTick(t => t + 1), 200);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (!ipcRenderer) return;
    let active = true;

    // Reset when a new prompt starts
    const handleNewPrompt = () => {
      setPhase('idle');
      setSteps([]);
      setGlobalError(null);
      setTotalCount(0);
      setExpandedSteps(new Set());
      setSynthesisAnswer('');
      setSavedFilePaths([]);
      setAskUserPrompt(null);
      setGuideStep(null);
      setIntentType(null);
      setScheduleCountdown(null);
      setSkillBuildConfirm(null);
      setGatherCredential(null);
      setGatherConfirm(null);
      setGatherCredentialValue('');
      setGatherCredentialStored(null);
      setGatherOAuth(null);
      setGatherOAuthConnecting(false);
      setGatherOAuthConnected(null);
      setAgentTurns(new Map());
      setAgentCompletes(new Map());
      setExpandedAgentSteps(new Set());
      agentStepStartTimes.current.clear();
      agentLiveTurns.current.clear();
      setHeartbeatTick(0);
      setLoginGuidance(null);
      setLearnedRules(new Map());
      setAgentThoughts(new Map());
      setProjectBuild(null);
      setProjectBuildFiles([]);
      setPlanReview(null);
      // Reset multi-intent step accumulation offset
      stepOffsetRef.current = 0;
    };
    ipcRenderer.on('results-window:set-prompt', handleNewPrompt);

    const handleScanProgress = (_event: any, data: any) => {
      if (!active) return;
      switch (data.type) {
        case 'maintenance_scan_start':
          setMaintenanceScan({
            active: true,
            trigger: data.trigger || 'user',
            total: data.total || 0,
            completed: 0,
            agents: data.agents || [],
            doneAgents: [],
            currentAgent: data.agents?.[0] || null,
          });
          break;
        case 'maintenance_scan_agent_done':
          setMaintenanceScan(prev => prev ? {
            ...prev,
            completed: data.index,
            doneAgents: [...prev.doneAgents, data.agentId],
            currentAgent: prev.agents[data.index] || null,
          } : prev);
          break;
        case 'maintenance_scan_complete':
          setMaintenanceScan(prev => prev ? { ...prev, active: false, completed: data.total } : null);
          setTimeout(() => setMaintenanceScan(null), 6000);
          break;
        case 'maintenance_scan_cancelled':
        case 'maintenance_scan_error':
          setMaintenanceScan(null);
          break;
      }
    };
    ipcRenderer.on('scan:progress', handleScanProgress);

    const handleScanDiscovery = (_event: any, data: any) => {
      if (!active || !Array.isArray(data?.suggestions) || data.suggestions.length === 0) return;
      setScanDiscovery(data.suggestions);
    };
    ipcRenderer.on('scan:discovery', handleScanDiscovery);

    const handleProgress = (_event: any, data: any) => {
      if (!active) return;
      switch (data.type) {
        case 'planning':
          setPhase('planning');
          setPlanMessage(data.message || 'Generating skill plan...');
          setSteps([]);
          setGlobalError(null);
          setTotalCount(0);
          break;

        case 'plan_ready': {
          // Don't override an active plan review — user must approve before execution starts
          if (phaseRef.current === 'plan_review') break;
          // If there are already completed steps (mid-queue), append rather than replace.
          // This gives users a cumulative view of all sub-intent steps instead of resetting.
          // Exception: recoveryReplan=true means the failed step is being retried with a new plan —
          // reset the view so the old red X is replaced rather than appended below it.
          const isRecoveryReplan = data.recoveryReplan === true;
          const hasDoneSteps = !isRecoveryReplan && steps.some(s => s.status === 'done');
          if (hasDoneSteps) {
            const newOffset = steps.length;
            stepOffsetRef.current = newOffset;
            setTotalCount(prev => prev + data.steps.length);
            if (data.intent) setIntentType(data.intent);
            setSteps(prev => [
              ...prev,
              ...data.steps.map((s: any) => ({
                index: newOffset + s.index,
                skill: s.skill,
                description: s.description,
                status: 'pending' as StepStatus,
              })),
            ]);
          } else {
            stepOffsetRef.current = 0;
            setPhase('executing');
            setTotalCount(data.steps.length);
            if (data.intent) setIntentType(data.intent);
            setSteps(data.steps.map((s: any) => ({
              index: s.index,
              skill: s.skill,
              description: s.description,
              status: 'pending' as StepStatus,
            })));
          }
          break;
        }

        case 'plan_error':
          setPhase('failed');
          setGlobalError(data.error || 'Plan generation failed');
          break;

        case 'step_start':
          // Clear any active guide step card when the next step begins
          setGuideStep(null);
          agentStepStartTimes.current.set(data.stepIndex + stepOffsetRef.current, Date.now());
          setSteps(prev => prev.map(s =>
            s.index === data.stepIndex + stepOffsetRef.current
              ? { ...s, status: 'running', description: data.description || s.description }
              : s
          ));
          // Scroll the active step into view
          setTimeout(() => {
            const el = stepRefs.current.get(data.stepIndex + stepOffsetRef.current);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 60);
          break;

        case 'step_done':
          agentStepStartTimes.current.delete(data.stepIndex + stepOffsetRef.current);
          setSteps(prev => prev.map(s =>
            s.index === data.stepIndex + stepOffsetRef.current
              ? { ...s, status: 'done', description: data.description || s.description, stdout: data.stdout, exitCode: data.exitCode, savedFilePath: data.savedFilePath || undefined, guideInstruction: data.instruction || s.guideInstruction }
              : s
          ));
          // Auto-dismiss the guide step card when a guide.step completes
          if (data.skill === 'guide.step') {
            setGuideStep(null);
            setPhase('executing');
          }
          if (data.savedFilePath && data.savedFilePath.startsWith('/')) {
            setSavedFilePaths(prev => {
              if (prev.includes(data.savedFilePath)) return prev;
              return [...prev, data.savedFilePath];
            });
          }
          break;

        case 'step_failed':
          agentStepStartTimes.current.delete(data.stepIndex + stepOffsetRef.current);
          setSteps(prev => prev.map(s =>
            s.index === data.stepIndex + stepOffsetRef.current
              ? { ...s, status: 'failed', error: data.error, stderr: data.stderr }
              : s
          ));
          break;

        case 'agent:turns_reset': {
          const stepIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setAgentTurns(prev => {
            const next = new Map(prev);
            next.delete(stepIdx);
            return next;
          });
          agentLiveTurns.current.delete(stepIdx);
          break;
        }

        case 'needs_login': {
          // browser.agent: Chrome opened at sign-in page, waitForAuth keeps polling
          // Show inline banner while step stays running — no second request needed
          const stepIdx = steps.findIndex(s => s.status === 'running');
          const displayIdx = stepIdx >= 0 ? stepIdx : (data.stepIndex ?? 0) + stepOffsetRef.current;
          setLoginGuidance({
            stepIndex: displayIdx,
            serviceDisplay: data.serviceDisplay || '',
            loginUrl: data.loginUrl || '',
            message: data.message || '',
          });
          break;
        }

        case 'agent:turn_live': {
          // Real-time turn update from cli.agent during execution (before agent:complete fires)
          const stepIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          agentLiveTurns.current.set(stepIdx, { turn: data.turn, maxTurns: data.maxTurns });
          setHeartbeatTick(t => t + 1); // force re-render to show updated label
          break;
        }

        case 'agent:turn': {
          const stepIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setAgentTurns(prev => {
            const next = new Map(prev);
            const existing = next.get(stepIdx) || [];
            next.set(stepIdx, [...existing, {
              turn:     data.turn,
              maxTurns: data.maxTurns,
              action:   data.action,
              outcome:  data.outcome,
              thoughts: data.thoughts,
            }]);
            return next;
          });
          // Auto-expand the card as soon as the first turn arrives
          setExpandedAgentSteps(prev => prev.has(stepIdx) ? prev : new Set([...prev, stepIdx]));
          break;
        }

        case 'agent:complete': {
          const stepIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setAgentCompletes(prev => {
            const next = new Map(prev);
            next.set(stepIdx, {
              agentId:    data.agentId,
              task:       data.task,
              totalTurns: data.totalTurns || 0,
              done:       data.done ?? data.ok,
              result:     data.result || '',
              reasoning:  data.reasoning,
              ok:         data.ok,
            });
            return next;
          });
          // Auto-expand on completion so turns are immediately visible
          setExpandedAgentSteps(prev => new Set([...prev, stepIdx]));
          break;
        }

        case 'agent:thought': {
          const stepIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setAgentThoughts(prev => {
            const next = new Map(prev);
            const existing = next.get(stepIdx) || [];
            next.set(stepIdx, [...existing, String(data.thoughts || '')]);
            return next;
          });
          break;
        }

        case 'agent:rule_learned': {          const stepIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setLearnedRules(prev => {
            const next = new Map(prev);
            next.set(stepIdx, [...(next.get(stepIdx) || []), String(data.rule || '')]);
            return next;
          });
          break;
        }

        case 'synthesis_start':
          // Keep phase as 'executing' — synthesize node emits step_done with answer as stdout
          break;

        case 'ask_user':
          setPhase('ask_user');
          setAskUserPrompt({ question: data.question, options: data.options || [] });
          break;

        case 'guide_step':
          setPhase('guide_step');
          setGuideStep({
            instruction: data.instruction,
            url: data.url || null,
            highlight: data.highlight || null,
            imageUrl: data.imageUrl || null,
            description: data.description || 'Follow the steps below',
            mode: data.mode === 'page_event' ? 'page_event' : 'ipc',
          });
          break;

        case 'schedule_start':
          setPhase('schedule_wait');
          setScheduleCountdown({ label: data.label || 'Waiting...', targetTime: data.targetTime || '', remainingMs: data.waitMs || 0 });
          break;

        case 'schedule_tick':
          setScheduleCountdown(prev => prev ? { ...prev, remainingMs: data.remainingMs, label: data.description || prev.label } : prev);
          break;

        case 'gather_start':
          setPhase('gathering');
          setGatherCredential(null);
          setGatherConfirm(null);
          setGatherOAuth(null);
          setGatherOAuthConnecting(false);
          break;

        case 'gather_credential':
          setPhase('gathering');
          setGatherConfirm(null);
          setGatherCredentialValue('');
          setGatherCredential({
            credentialKey: data.credentialKey,
            question: data.question,
            hint: data.hint || null,
            helpUrl: data.helpUrl || null,
            sensitive: data.sensitive || false,
            optional: data.optional || false,
          });
          break;

        case 'gather_credential_stored':
          setGatherCredentialStored(data.credentialKey);
          setGatherCredential(null);
          setTimeout(() => setGatherCredentialStored(null), 3000);
          break;

        case 'gather_confirm':
          setPhase('gathering');
          setGatherCredential(null);
          setGatherConfirm({
            question: data.question,
            credentialKey: data.credentialKey,
            confirmId: data.confirmId,
          });
          break;

        case 'gather_confirmed':
          setGatherConfirm(null);
          break;

        case 'gather_oauth':
          setPhase('gathering');
          setGatherCredential(null);
          setGatherConfirm(null);
          setGatherOAuthConnecting(false);
          setGatherOAuthConnected(null);
          setGatherOAuth({
            provider: data.provider,
            tokenKey: data.tokenKey,
            scopes: data.scopes || '',
            skillName: data.skillName || data.provider,
          });
          break;

        case 'gather_oauth_connected':
          setGatherOAuthConnecting(false);
          setGatherOAuthConnected(data.provider);
          setGatherOAuth(null);
          setTimeout(() => setGatherOAuthConnected(null), 3000);
          break;

        case 'gather_complete':
          setGatherCredential(null);
          setGatherConfirm(null);
          setGatherOAuth(null);
          setGatherOAuthConnecting(false);
          setPhase('planning');
          setPlanMessage('Starting build…');
          break;

        case 'gather_answer_received':
          break;

        case 'scout_match':
          setScoutMatch({
            capability: data.capability || '',
            suggestion: data.suggestion || '',
            matches: data.matches || [],
            errorHint: data.errorHint || null,
            showCarrierDropdown: !!data.showCarrierDropdown,
            prefillPhone: data.prefillPhone || '',
          });
          setPhase('planning');
          break;

        case 'error':
          setGlobalError(data.message || 'An error occurred.');
          setPhase('failed');
          break;

        case 'project_build_start':
          setPhase('project_building');
          setProjectBuild({ capability: data.capability || '', iteration: 0, message: data.message || 'Building project…', passed: false, failed: false, errorMsg: null });
          setProjectBuildFiles([]);
          break;

        case 'project_file_created':
          setProjectBuildFiles(prev => prev.includes(data.file) ? prev : [...prev, data.file]);
          break;

        case 'project_build_iteration':
          setProjectBuild(prev => prev ? { ...prev, iteration: data.attempt || prev.iteration + 1, message: data.message || `Attempt ${data.attempt}…` } : prev);
          break;

        case 'project_build_test':
          setProjectBuild(prev => prev ? { ...prev, message: 'Running smoke tests…' } : prev);
          break;

        case 'project_build_pass':
          setProjectBuild(prev => prev ? { ...prev, passed: true, failed: false, message: `Project ready — built in ${data.iterations || 1} iteration${data.iterations !== 1 ? 's' : ''}` } : prev);
          setPhase('executing');
          break;

        case 'project_build_fail':
          setProjectBuild(prev => prev ? { ...prev, failed: true, passed: false, errorMsg: data.error || 'Build failed after max retries', message: 'Build failed' } : prev);
          setPhase('failed');
          setGlobalError(data.error || 'Could not build project after max retries.');
          break;

        case 'skill_build_confirm':
          setSkillBuildConfirm({
            skillName: data.skillName,
            summary: data.summary,
          });
          break;

        case 'skill_build_triggered':
          setSkillBuildConfirm(null);
          break;

        case 'evaluating':
          setPhase('evaluating');
          setEvalMessage(data.message || 'Evaluating result quality...');
          break;

        case 'retrying_with_fix':
          setPhase('retrying_with_fix');
          setRetryMessage(data.message || 'Adjusting approach and retrying...');
          // Reset steps for the new plan run
          setSteps([]);
          setTotalCount(0);
          break;

        case 'all_done': {
          // Don't let all_done collapse an active plan review (awaitingPlanApproval path)
          if (phaseRef.current === 'plan_review') break;
          setGuideStep(null);
          setPhase('done');
          setTotalCount(data.totalCount);
          // Merge any final stdout from skillResults into steps.
          // Also backfill savedFilePath onto the step that wrote it so the
          // inline file link appears on the step row (shell.run write steps
          // don't emit savedFilePath in step_done — only synthesize does).
          if (Array.isArray(data.skillResults)) {
            const filePaths: string[] = Array.isArray(data.savedFilePaths) ? data.savedFilePaths : [];
            setSteps(prev => prev.map((s, i) => {
              const r = data.skillResults[i];
              if (!r) return s;
              // Find a savedFilePath that this step wrote by matching against its resolved args script
              let stepFilePath = s.savedFilePath;
              if (!stepFilePath && r.skill === 'shell.run' && filePaths.length > 0) {
                const script = (r.args?.argv || []).find((a: any) => typeof a === 'string') || '';
                stepFilePath = filePaths.find(fp => script.includes(fp) || script.includes(fp.replace(/^\/Users\/[^/]+/, '~')));
              }
              return {
                ...s,
                status: r.ok ? 'done' : 'failed',
                stdout: r.stdout || s.stdout,
                stderr: r.stderr || s.stderr,
                error: r.error || s.error,
                exitCode: r.exitCode ?? s.exitCode,
                savedFilePath: stepFilePath || s.savedFilePath,
              };
            }));
          }
          // Also keep bottom-level list for any paths not matched to a specific step
          if (Array.isArray(data.savedFilePaths) && data.savedFilePaths.length > 0) {
            setSavedFilePaths(data.savedFilePaths);
          }
          break;
        }

        case 'plan:generated': {
          const _planStepTitles = parsePlanStepTitles(data.content || '');
          setPhase('plan_review');
          setPlanReview({
            planFile: data.planFile || '',
            content: data.content || '',
            title: data.title || 'Execution Plan',
            isExisting: false,
          });
          setTotalCount(_planStepTitles.length);
          setIntentType('command_automate');
          setSteps(_planStepTitles.map((title, i) => ({
            index: i, skill: '', description: title, status: 'pending' as StepStatus,
          })));
          stepOffsetRef.current = 0;
          break;
        }

        case 'plan:found_existing': {
          const _existingStepTitles = parsePlanStepTitles(data.content || '');
          setPhase('plan_review');
          setPlanReview({
            planFile: data.planFile || '',
            content: data.content || '',
            title: data.title || 'Existing Plan',
            isExisting: true,
            similarity: data.similarity,
          });
          setTotalCount(_existingStepTitles.length);
          setIntentType('command_automate');
          setSteps(_existingStepTitles.map((title, i) => ({
            index: i, skill: '', description: title, status: 'pending' as StepStatus,
          })));
          stepOffsetRef.current = 0;
          break;
        }

        case 'plan:step_start': {
          // Transition out of plan_review to executing when first step fires
          if (phaseRef.current === 'plan_review') {
            setPhase('executing');
            setPlanReview(null);
          }
          setGuideStep(null);
          const _psIdx = data.stepIndex ?? 0;
          setSteps(prev => {
            if (prev.some(s => s.index === _psIdx)) {
              return prev.map(s => s.index === _psIdx
                ? { ...s, status: 'running', skill: data.skill || s.skill, description: data.description || data.title || s.description }
                : s
              );
            }
            // Dynamically add if not pre-populated
            const total = data.totalSteps ?? prev.length + 1;
            const base: Step[] = prev.length < total
              ? Array.from({ length: total }, (_, i) => prev[i] ?? { index: i, skill: '', description: `Step ${i + 1}`, status: 'pending' as StepStatus })
              : prev;
            return base.map(s => s.index === _psIdx
              ? { ...s, status: 'running', skill: data.skill || s.skill, description: data.description || data.title || s.description }
              : s
            );
          });
          setTimeout(() => {
            const el = stepRefs.current.get(_psIdx);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 60);
          break;
        }

        case 'plan:complete':
          setPhase('done');
          break;
      }
    };

    // Capture streaming synthesis answer chunks
    const handleBridgeMessage = (_event: any, message: any) => {
      if (message.type === 'chunk' || message.type === 'llm_stream_chunk') {
        const text = message?.text || message.payload?.text || '';
        if (text) setSynthesisAnswer(prev => prev + text);
      }
    };

    const handleControlModeChange = (_event: any, data: any) => {
      setControlMode({ active: !!data.active, app: data.app || null });
    };

    const handlePlanApproved = () => {
      setPlanReview(null);
      setPhase('executing');
    };

    ipcRenderer.on('automation:progress', handleProgress);
    ipcRenderer.on('ws-bridge:message', handleBridgeMessage);
    ipcRenderer.on('app-control:mode-change', handleControlModeChange);
    ipcRenderer.on('plan:approved', handlePlanApproved);
    return () => {
      active = false;
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('automation:progress', handleProgress);
        ipcRenderer.removeListener('results-window:set-prompt', handleNewPrompt);
        ipcRenderer.removeListener('ws-bridge:message', handleBridgeMessage);
        ipcRenderer.removeListener('app-control:mode-change', handleControlModeChange);
        ipcRenderer.removeListener('plan:approved', handlePlanApproved);
        ipcRenderer.removeListener('scan:progress', handleScanProgress);
        ipcRenderer.removeListener('scan:discovery', handleScanDiscovery);
      }
    };
  }, []);

  const toggleExpand = (index: number) => {
    setExpandedSteps(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleOptionClick = (option: string) => {
    setAskUserPrompt(null);
    ipcRenderer?.send('prompt-queue:submit', { prompt: option, selectedText: '' });
  };

  const handleGuideContinue = () => {
    setGuideStep(null);
    setPhase('executing');
    ipcRenderer?.send('guide:continue');
  };

  const handleGuideCancel = () => {
    setGuideStep(null);
    setPhase('idle');
    ipcRenderer?.send('guide:cancel');
  };

  const handleGatherCredentialSubmit = () => {
    if (!gatherCredential) return;
    // Allow empty submission for optional credentials (e.g. 2FA code — user wants to skip)
    if (!gatherCredentialValue.trim() && !gatherCredential.optional) return;
    ipcRenderer?.send('gather:credential', { key: gatherCredential.credentialKey, value: gatherCredentialValue });
    setGatherCredential(null);
    setGatherCredentialValue('');
    setGuideStep(null);
    setPhase('executing');
  };

  const handleGatherConfirm = (yes: boolean) => {
    setGatherConfirm(null);
    ipcRenderer?.send('gather:answer', { answer: yes ? 'yes' : 'no' });
  };

  const handleGatherOAuthConnect = () => {
    if (!gatherOAuth) return;
    setGatherOAuthConnecting(true);
    ipcRenderer?.send('gather:oauth_connect', {
      provider: gatherOAuth.provider,
      tokenKey: gatherOAuth.tokenKey,
      scopes: gatherOAuth.scopes,
      skillName: gatherOAuth.skillName,
    });
    // Timeout fallback — if no response in 5min, reset
    setTimeout(() => setGatherOAuthConnecting(false), 300000);
  };

  const handlePlanApprove = () => {
    if (!planReview) return;
    ipcRenderer?.send('plan:approve', { planFile: planReview.planFile });
    // phase transitions to 'executing' via plan:approved IPC event
  };

  const handlePlanCancel = () => {
    if (!planReview) return;
    ipcRenderer?.send('plan:cancel', { planFile: planReview.planFile });
    setPlanReview(null);
    setPhase('idle');
    setSteps([]);
  };

  const handlePlanNew = () => {
    ipcRenderer?.send('plan:new', {});
    setPlanReview(null);
    setPhase('planning');
    setPlanMessage('Generating new plan…');
    setSteps([]);
  };

  const doneCount = steps.filter(s =>
    s.status === 'done' ||
    (s.status !== 'failed' && agentCompletes.get(s.index)?.ok === true)
  ).length;
  const shownTotal = totalCount || steps.length;

  if (phase === 'idle' && !controlMode.active && !maintenanceScan && !scanDiscovery) return null;

  return (
    <div className="space-y-3">
      <style>{`
        @keyframes agentGloss {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        @keyframes scanPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>

      {/* ── Maintenance Scan Progress Card ───────────────────────────────── */}
      {maintenanceScan && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.25)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 14 }}>🔧</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#fbbf24' }}>
                {maintenanceScan.active ? 'Maintenance Scan' : 'Scan Complete'}
              </span>
              {maintenanceScan.active && (
                <span style={{ fontSize: 10, color: 'rgba(251,191,36,0.7)', animation: 'scanPulse 1.5s ease-in-out infinite' }}>
                  {maintenanceScan.trigger === 'idle' ? 'idle-triggered' : maintenanceScan.trigger === 'scheduled' ? 'scheduled' : 'running'}
                </span>
              )}
            </div>
            {maintenanceScan.active && (
              <button
                onClick={() => ipcRenderer?.send('scan:cancel')}
                style={{ fontSize: 10, color: 'rgba(251,191,36,0.6)', background: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(251,191,36,0.2)' }}
              >
                Cancel
              </button>
            )}
          </div>
          <div style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>
                {maintenanceScan.active
                  ? `Updating agent knowledge maps… ${maintenanceScan.currentAgent ? `(${maintenanceScan.currentAgent})` : ''}`
                  : `${maintenanceScan.completed} agent${maintenanceScan.completed !== 1 ? 's' : ''} updated`}
              </span>
              <span style={{ fontSize: 11, color: 'rgba(251,191,36,0.7)' }}>
                {maintenanceScan.completed} / {maintenanceScan.total}
              </span>
            </div>
            <div style={{ height: 3, borderRadius: 2, backgroundColor: 'rgba(251,191,36,0.15)', overflow: 'hidden' }}>
              <div style={{
                height: '100%',
                borderRadius: 2,
                backgroundColor: '#fbbf24',
                width: maintenanceScan.total > 0 ? `${Math.round((maintenanceScan.completed / maintenanceScan.total) * 100)}%` : '0%',
                transition: 'width 0.4s ease',
              }} />
            </div>
          </div>
          {maintenanceScan.agents.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {maintenanceScan.agents.map((agentId) => {
                const done = maintenanceScan.doneAgents.includes(agentId);
                const isCurrent = maintenanceScan.currentAgent === agentId && maintenanceScan.active;
                return (
                  <span key={agentId} style={{
                    fontSize: 10, padding: '2px 6px', borderRadius: 10,
                    backgroundColor: done ? 'rgba(34,197,94,0.12)' : isCurrent ? 'rgba(251,191,36,0.12)' : 'rgba(255,255,255,0.05)',
                    color: done ? '#4ade80' : isCurrent ? '#fbbf24' : 'rgba(255,255,255,0.35)',
                    border: `1px solid ${done ? 'rgba(34,197,94,0.25)' : isCurrent ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.1)'}`,
                  }}>
                    {done ? '✓ ' : isCurrent ? '⟳ ' : ''}{agentId}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── Discovery Suggestions Card ────────────────────────────────────── */}
      {scanDiscovery && scanDiscovery.length > 0 && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.25)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ fontSize: 14 }}>💡</span>
              <span style={{ fontSize: 12, fontWeight: 600, color: '#a78bfa' }}>Suggested Agents</span>
            </div>
            <button
              onClick={() => setScanDiscovery(null)}
              style={{ fontSize: 10, color: 'rgba(167,139,250,0.6)', background: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4, border: '1px solid rgba(139,92,246,0.2)' }}
            >
              Dismiss
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginBottom: 10, marginTop: 0 }}>
            Based on your browsing history:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {scanDiscovery.slice(0, 5).map((s) => (
              <div key={s.hostname} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>{s.hostname}</span>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>({s.visits} visits)</span>
                </div>
                <button
                  onClick={() => {
                    ipcRenderer?.send('prompt-queue:submit', { prompt: `Add an agent for ${s.hostname}` });
                    setScanDiscovery(prev => prev ? prev.filter(x => x.hostname !== s.hostname) : null);
                  }}
                  style={{ fontSize: 10, color: '#a78bfa', background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)', cursor: 'pointer', padding: '3px 8px', borderRadius: 6 }}
                >
                  Add Agent
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── App Control Mode badge ────────────────────────────────────────── */}
      {controlMode.active && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{ backgroundColor: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)' }}>
          <div className="w-2 h-2 rounded-full animate-pulse flex-shrink-0"
            style={{ backgroundColor: '#22c55e' }} />
          <span className="text-sm font-semibold" style={{ color: '#22c55e' }}>
            You're in control mode{controlMode.app ? ` · ${controlMode.app}` : ''}
          </span>
          <span className="text-xs ml-auto" style={{ color: 'rgba(34,197,94,0.7)' }}>
            speak or type · say <strong>stop</strong> to exit
          </span>
        </div>
      )}
      {/* ── Phase header ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        {phase === 'gathering' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#a78bfa', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#a78bfa' }}>
              Gathering requirements…
            </span>
          </>
        )}
        {phase === 'planning' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#60a5fa', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#60a5fa' }}>
              {planMessage}
            </span>
          </>
        )}
        {(phase === 'executing' || phase === 'done') && (phase as string) !== 'synthesizing' && (() => {
          const allDone = phase === 'done' || (shownTotal > 0 && doneCount >= shownTotal);
          return (
            <>
              {allDone ? (
                <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: '#22c55e' }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
                    strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              ) : (
                <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
                  style={{ borderColor: '#60a5fa', borderTopColor: 'transparent' }} />
              )}
              <span className="text-sm font-medium" style={{ color: allDone ? '#34d399' : '#e5e7eb' }}>
                {doneCount} / {shownTotal} tasks done
              </span>
              {intentType && (
                <span className="text-xs px-1.5 py-0.5 rounded-full font-medium ml-1"
                  style={{
                    backgroundColor: intentType === 'command_automate'
                      ? 'rgba(59,130,246,0.15)'
                      : intentType === 'memory_retrieve'
                      ? 'rgba(168,85,247,0.15)'
                      : 'rgba(107,114,128,0.15)',
                    color: intentType === 'command_automate'
                      ? '#93c5fd'
                      : intentType === 'memory_retrieve'
                      ? '#d8b4fe'
                      : '#9ca3af',
                    border: `1px solid ${intentType === 'command_automate'
                      ? 'rgba(59,130,246,0.25)'
                      : intentType === 'memory_retrieve'
                      ? 'rgba(168,85,247,0.25)'
                      : 'rgba(107,114,128,0.25)'}`,
                  }}>
                  {intentType === 'command_automate' ? 'automate'
                    : intentType === 'memory_retrieve' ? 'recall'
                    : intentType === 'web_search' ? 'search'
                    : intentType === 'screen_intelligence' ? 'screen'
                    : intentType}
                </span>
              )}
            </>
          );
        })()}
        {phase === 'plan_review' && (
          <div>
            <div style={{ marginBottom: 10, padding: '7px 10px', borderRadius: 8, backgroundColor: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.28)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 9v4"/>
                <path d="M12 17h.01"/>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              </svg>
              <span style={{ color: '#fcd34d', fontSize: '0.73rem', fontWeight: 600 }}>
                Plan Mode active: your messages will update/correct this plan. Cancel to return to normal ThinkDrop mode.
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-shrink-0 w-3 h-3 rounded-full" style={{ backgroundColor: '#3b82f6' }} />
              <span className="text-sm font-medium" style={{ color: '#93c5fd' }}>
                Review plan
              </span>
            </div>
          </div>
        )}
        {phase === 'failed' && (
          <>
            <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
              style={{ backgroundColor: '#ef4444' }}>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
                strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </div>
            <span className="text-sm font-medium" style={{ color: '#f87171' }}>
              Automation failed
            </span>
          </>
        )}
        {phase === 'schedule_wait' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#a78bfa', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#a78bfa' }}>
              Scheduled — waiting to run
            </span>
          </>
        )}
        {phase === 'evaluating' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#f59e0b', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#fbbf24' }}>
              {evalMessage}
            </span>
          </>
        )}
        {phase === 'retrying_with_fix' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#f97316', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#fb923c' }}>
              {retryMessage}
            </span>
          </>
        )}
      </div>

      {/* ── Evaluating banner ────────────────────────────────────────────── */}
      {phase === 'evaluating' && (
        <div style={{ padding: '10px 14px', borderRadius: 10, backgroundColor: '#1c1a0e', border: '1px solid #a16207', position: 'sticky', top: 0, zIndex: 10 }}>
          <div className="flex items-center gap-2.5">
            <div className="w-3 h-3 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#facc15', borderTopColor: 'transparent' }} />
            <div>
              <div style={{ color: '#fde047', fontSize: '0.75rem', fontWeight: 600 }}>
                Checking result quality
              </div>
              <div style={{ color: '#a3a3a3', fontSize: '0.68rem', marginTop: 2 }}>
                ThinkDrop is reviewing the output. This may take a few seconds.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Retrying with fix banner ──────────────────────────────────────── */}
      {phase === 'retrying_with_fix' && (
        <div style={{ padding: '10px 14px', borderRadius: 10, backgroundColor: '#1a1108', border: '1px solid #c2410c', position: 'sticky', top: 0, zIndex: 10 }}>
          <div className="flex items-center gap-2.5">
            <div className="w-3 h-3 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#fb923c', borderTopColor: 'transparent' }} />
            <div>
              <div style={{ color: '#fdba74', fontSize: '0.75rem', fontWeight: 600 }}>
                Self-healing — retrying with a fix
              </div>
              <div style={{ color: '#a3a3a3', fontSize: '0.68rem', marginTop: 2 }}>
                A correction rule was saved. Replanning now — no action needed.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Scout match card ───────────────────────────────────────── */}
      {scoutMatch && (
        <ScoutMatchCard
          scout={scoutMatch}
          onSelect={(match) => {
            setScoutMatch(null);
            ipcRenderer?.send('prompt-queue:submit', { prompt: match.provider, selectedText: '' });
          }}
        />
      )}

      {/* ── Project build card ─────────────────────────────────────── */}
      {projectBuild && (
        <div style={{
          padding: '12px 14px', borderRadius: 10,
          backgroundColor: projectBuild.failed ? 'rgba(239,68,68,0.07)' : projectBuild.passed ? 'rgba(34,197,94,0.07)' : 'rgba(99,102,241,0.07)',
          border: `1px solid ${projectBuild.failed ? 'rgba(239,68,68,0.30)' : projectBuild.passed ? 'rgba(34,197,94,0.30)' : 'rgba(99,102,241,0.30)'}`,
        }}>
          <div className="flex items-start gap-2">
            <div style={{ fontSize: '0.95rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>
              {projectBuild.failed ? '❌' : projectBuild.passed ? '✅' : '🏗️'}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{
                color: projectBuild.failed ? '#f87171' : projectBuild.passed ? '#86efac' : '#a5b4fc',
                fontSize: '0.76rem', fontWeight: 600, marginBottom: 2,
              }}>
                {projectBuild.passed ? 'Project built & registered' : projectBuild.failed ? 'Project build failed' : 'Building project…'}
              </div>
              <div style={{ color: '#9ca3af', fontSize: '0.69rem', lineHeight: 1.4 }}>
                {projectBuild.message}
              </div>
              {projectBuild.capability && !projectBuild.passed && !projectBuild.failed && (
                <div style={{ color: '#6b7280', fontSize: '0.66rem', marginTop: 4, fontStyle: 'italic' }}>
                  Capability: {projectBuild.capability}
                </div>
              )}
              {!projectBuild.passed && !projectBuild.failed && (
                <div className="flex items-center gap-1.5" style={{ marginTop: 6 }}>
                  <div className="w-2.5 h-2.5 rounded-full border-2 animate-spin flex-shrink-0"
                    style={{ borderColor: '#818cf8', borderTopColor: 'transparent' }} />
                  <span style={{ color: '#6b7280', fontSize: '0.65rem' }}>
                    npm install → build → smoke test → retry if needed
                  </span>
                </div>
              )}
              {projectBuildFiles.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {projectBuildFiles.map(f => (
                    <div key={f} className="flex items-center gap-1" style={{ color: '#6ee7b7', fontSize: '0.64rem', lineHeight: 1.6 }}>
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                      </svg>
                      <span style={{ fontFamily: 'monospace' }}>{f}</span>
                    </div>
                  ))}
                </div>
              )}
              {projectBuild.failed && projectBuild.errorMsg && (
                <div style={{ color: '#fca5a5', fontSize: '0.67rem', marginTop: 6, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {projectBuild.errorMsg.slice(0, 300)}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Gather: credential input card ────────────────────────────────── */}
      {gatherCredential && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.25)' }}>
          <div className="flex items-start gap-2" style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '0.9rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🔑</div>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#6ee7b7', fontSize: '0.76rem', fontWeight: 600, marginBottom: 2 }}>
                {gatherCredential.question}
              </div>
              {gatherCredential.hint && (
                <div style={{ color: '#6b7280', fontSize: '0.68rem', marginBottom: 6 }}>
                  {gatherCredential.hint}
                </div>
              )}
              {gatherCredential.helpUrl && (
                <a
                  href="#"
                  onClick={e => { e.preventDefault(); ipcRenderer?.send('shell:open-url', gatherCredential.helpUrl!); }}
                  style={{ display: 'inline-block', color: '#818cf8', fontSize: '0.67rem', textDecoration: 'underline', textDecorationStyle: 'dotted', marginBottom: 8 }}
                >
                  ↗ Open credentials page
                </a>
              )}
              {/* CLI-style input — masked for passwords/secrets, visible for emails/usernames */}
              {/* Key label on its own row so it never pushes the button off-screen */}
              <div style={{ color: '#10b981', fontSize: '0.68rem', fontFamily: 'monospace', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {gatherCredential.credentialKey}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type={gatherCredential.sensitive ? 'password' : 'text'}
                  value={gatherCredentialValue}
                  onChange={e => setGatherCredentialValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleGatherCredentialSubmit(); }}
                  placeholder={gatherCredential.optional ? 'Leave empty to skip…' : 'Paste value here…'}
                  autoFocus
                  style={{
                    flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.35)', border: '1px solid rgba(16,185,129,0.35)',
                    borderRadius: 5, padding: '4px 8px', color: '#d1fae5', fontSize: '0.72rem',
                    fontFamily: 'monospace', outline: 'none',
                  }}
                />
                <button
                  onClick={handleGatherCredentialSubmit}
                  disabled={!gatherCredential.optional && !gatherCredentialValue.trim()}
                  style={{
                    flexShrink: 0, padding: '4px 10px', borderRadius: 5,
                    cursor: (gatherCredential.optional || gatherCredentialValue.trim()) ? 'pointer' : 'not-allowed',
                    backgroundColor: (gatherCredential.optional || gatherCredentialValue.trim()) ? 'rgba(16,185,129,0.2)' : 'rgba(16,185,129,0.05)',
                    border: '1px solid rgba(16,185,129,0.35)',
                    color: '#6ee7b7', fontSize: '0.69rem', fontWeight: 600,
                    opacity: (gatherCredential.optional || gatherCredentialValue.trim()) ? 1 : 0.4,
                  }}
                >
                  {gatherCredential.optional && !gatherCredentialValue.trim() ? 'Skip →' : 'Store'}
                </button>
              </div>
              <div style={{ color: '#374151', fontSize: '0.65rem', marginTop: 4 }}>
                Stored securely in keychain — never logged or shared
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Gather: OAuth connect card ─────────────────────────────────── */}
      {gatherOAuth && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(66,133,244,0.07)', border: '1px solid rgba(66,133,244,0.3)' }}>
          <div className="flex items-start gap-2">
            <div style={{ fontSize: '0.9rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🔗</div>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#93bbff', fontSize: '0.76rem', fontWeight: 600, marginBottom: 2 }}>
                Connect {gatherOAuth.provider.charAt(0).toUpperCase() + gatherOAuth.provider.slice(1)} to continue
              </div>
              <div style={{ color: '#6b7280', fontSize: '0.68rem', marginBottom: 10 }}>
                This skill needs {gatherOAuth.provider} access. Click Connect to authenticate via OAuth — your token is stored securely in keychain.
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  onClick={handleGatherOAuthConnect}
                  disabled={gatherOAuthConnecting}
                  style={{
                    padding: '5px 14px', borderRadius: 6, fontSize: '0.69rem', fontWeight: 600,
                    cursor: gatherOAuthConnecting ? 'wait' : 'pointer',
                    backgroundColor: gatherOAuthConnecting ? 'rgba(66,133,244,0.05)' : 'rgba(66,133,244,0.15)',
                    border: '1px solid rgba(66,133,244,0.4)',
                    color: gatherOAuthConnecting ? '#4b5563' : '#93bbff',
                  }}
                >
                  {gatherOAuthConnecting ? 'Opening browser…' : `Connect ${gatherOAuth.provider}`}
                </button>
                <button
                  onClick={() => { setGatherOAuth(null); ipcRenderer?.send('gather:oauth_skip', { provider: gatherOAuth.provider }); }}
                  style={{
                    padding: '5px 10px', borderRadius: 6, fontSize: '0.65rem', cursor: 'pointer',
                    backgroundColor: 'transparent', border: '1px solid rgba(107,114,128,0.25)',
                    color: '#4b5563',
                  }}
                >
                  Skip
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Gather: OAuth connected flash ─────────────────────────────────── */}
      {gatherOAuthConnected && (
        <div style={{ padding: '8px 14px', borderRadius: 8, backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
            style={{ backgroundColor: '#22c55e' }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
              strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <span style={{ color: '#86efac', fontSize: '0.72rem', fontWeight: 500 }}>
            <code style={{ fontFamily: 'monospace', color: '#4ade80' }}>{gatherOAuthConnected}</code> connected
          </span>
        </div>
      )}

      {/* ── Gather: stored confirmation flash ────────────────────────────── */}
      {gatherCredentialStored && (
        <div style={{ padding: '8px 14px', borderRadius: 8, backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
            style={{ backgroundColor: '#22c55e' }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
              strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </div>
          <span style={{ color: '#86efac', fontSize: '0.72rem', fontWeight: 500 }}>
            <code style={{ fontFamily: 'monospace', color: '#4ade80' }}>{gatherCredentialStored}</code> stored in keychain
          </span>
        </div>
      )}

      {/* ── Gather: confirm existing credential card ──────────────────────── */}
      {gatherConfirm && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.3)' }}>
          <div className="flex items-start gap-2" style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '0.9rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🗝️</div>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#a5b4fc', fontSize: '0.76rem', fontWeight: 600, marginBottom: 4 }}>
                {gatherConfirm.question}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => handleGatherConfirm(true)}
                  style={{
                    padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
                    backgroundColor: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.4)',
                    color: '#c7d2fe', fontSize: '0.69rem', fontWeight: 600,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.28)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.15)')}
                >
                  Yes, use them
                </button>
                <button
                  onClick={() => handleGatherConfirm(false)}
                  style={{
                    padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
                    backgroundColor: 'rgba(107,114,128,0.1)', border: '1px solid rgba(107,114,128,0.3)',
                    color: '#9ca3af', fontSize: '0.69rem', fontWeight: 500,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(107,114,128,0.2)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(107,114,128,0.1)')}
                >
                  Enter new ones
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Schedule countdown banner ─────────────────────────────────────── */}
      {phase === 'schedule_wait' && scheduleCountdown && (() => {
        const totalSecs = Math.ceil(scheduleCountdown.remainingMs / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = totalSecs % 60;
        const countdownStr = mins > 0
          ? `${mins}m ${secs.toString().padStart(2, '0')}s`
          : `${secs}s`;
        return (
          <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.3)' }}>
            <div className="flex items-center gap-3">
              <div style={{ fontSize: '1.5rem', lineHeight: 1, color: '#a78bfa', fontVariantNumeric: 'tabular-nums', fontWeight: 700, minWidth: 72 }}>
                {countdownStr}
              </div>
              <div>
                <div style={{ color: '#c4b5fd', fontSize: '0.78rem', fontWeight: 600, marginBottom: 2 }}>
                  Fires at {scheduleCountdown.targetTime}
                </div>
                <div style={{ color: '#7c3aed', fontSize: '0.7rem' }}>
                  {scheduleCountdown.label.replace(/ — \d+m.*$| — \d+s.*$/, '')}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ── Global error ─────────────────────────────────────────────────── */}
      {globalError && (
        <div className="px-3 py-2 rounded-lg text-xs"
          style={{ backgroundColor: 'rgba(239,68,68,0.1)', borderLeft: '3px solid #ef4444', color: '#fca5a5' }}>
          {humanizeError(globalError)}
        </div>
      )}

      {/* ── Skill build confirmation card ───────────────────────────────── */}
      {skillBuildConfirm && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.35)' }}>
          <div className="flex items-start gap-2" style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '0.95rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🔧</div>
            <div>
              <div style={{ color: '#c4b5fd', fontSize: '0.76rem', fontWeight: 600, marginBottom: 3 }}>
                New skill required
              </div>
              <div style={{ color: '#9ca3af', fontSize: '0.69rem', lineHeight: 1.4, marginBottom: 4 }}>
                <span style={{ color: '#e5e7eb', fontFamily: 'ui-monospace,monospace', fontSize: '0.68rem', background: 'rgba(0,0,0,0.3)', padding: '1px 5px', borderRadius: 3 }}>
                  {skillBuildConfirm.skillName}
                </span>
              </div>
            </div>
          </div>
          <div style={{ color: '#d1d5db', fontSize: '0.71rem', lineHeight: 1.5, marginBottom: 10, paddingLeft: 22, fontStyle: 'italic' }}>
            {skillBuildConfirm.summary}
          </div>
          <div style={{ display: 'flex', gap: 6, paddingLeft: 22 }}>
            <button
              onClick={() => {
                setSkillBuildConfirm(null);
                ipcRenderer?.send('install:confirm', { confirmed: true });
              }}
              style={{
                padding: '5px 12px', borderRadius: 6, fontSize: '0.7rem', fontWeight: 600,
                cursor: 'pointer', background: 'rgba(139,92,246,0.2)',
                border: '1px solid rgba(139,92,246,0.5)', color: '#c4b5fd',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
              </svg>
              Build &amp; Install
            </button>
            <button
              onClick={() => {
                setSkillBuildConfirm(null);
                ipcRenderer?.send('install:confirm', { confirmed: false });
              }}
              style={{
                padding: '5px 12px', borderRadius: 6, fontSize: '0.7rem', fontWeight: 600,
                cursor: 'pointer', background: 'rgba(107,114,128,0.1)',
                border: '1px solid rgba(107,114,128,0.3)', color: '#9ca3af',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Step list ────────────────────────────────────────────────────── */}
      {steps.length > 0 && (
        <div className="space-y-2" style={{ maxHeight: 340, overflowY: 'auto', overflowX: 'hidden' }}>
          {steps.map((step) => {
            const isSynthesize = step.skill === 'synthesize';
            const isNeedsSkill = step.skill === 'needs_skill';
            const isGuideStep = step.skill === 'guide.step';
            const hasOutput = isSynthesize
              ? synthesisAnswer.length > 0
              : !isNeedsSkill && ((step.stdout && step.stdout.trim().length > 0) ||
                (step.error && step.error.trim().length > 0) ||
                (isGuideStep && !!step.guideInstruction));
            const isExpanded = expandedSteps.has(step.index);

            return (
              <div key={step.index} ref={(el) => { if (el) stepRefs.current.set(step.index, el); else stepRefs.current.delete(step.index); }}>
                {/* Step row */}
                <div
                  className="flex items-start gap-2.5"
                  style={{ cursor: hasOutput ? 'pointer' : 'default' }}
                  onClick={() => hasOutput && toggleExpand(step.index)}
                >
                  <div className="mt-0.5">
                    <StepIcon status={step.status} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm" style={{
                        color: step.status === 'pending' ? '#6b7280'
                          : step.status === 'failed' ? '#fca5a5'
                          : '#e5e7eb'
                      }}>
                        {step.description}
                      </span>
                      <SkillBadge skill={step.skill} />
                    </div>
                    {step.status === 'done' && !isExpanded && (() => {
                      const out = step.stdout?.trim() || '';
                      if (out.length === 0) {
                        return (
                          <div className="text-xs mt-0.5" style={{ color: '#6b7280' }}>
                            Done
                          </div>
                        );
                      }
                      const lines = out.split('\n').filter(l => l.trim());
                      const preview = lines[0].length > 60 ? lines[0].slice(0, 60) + '…' : lines[0];
                      const more = lines.length > 1 ? ` +${lines.length - 1} more` : '';
                      return (
                        <div className="text-xs mt-0.5 font-mono truncate" style={{ color: '#6ee7b7' }}>
                          {preview}<span style={{ color: '#6b7280' }}>{more}</span>
                        </div>
                      );
                    })()}
                    {step.status === 'failed' && step.error && !isExpanded && (
                      <div className="text-xs mt-0.5" style={{ color: '#f87171' }}>
                        {humanizeError(step.error)}
                      </div>
                    )}
                  </div>
                  {/* Inline file link — shown on the step that created the file */}
                  {step.savedFilePath && step.status === 'done' && (
                    <button
                      onClick={e => { e.stopPropagation(); ipcRenderer?.send('shell:open-path', step.savedFilePath); }}
                      className="flex-shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-xs"
                      style={{ backgroundColor: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#93c5fd', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.2)')}
                      onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.1)')}
                      title={step.savedFilePath}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                      </svg>
                      {step.savedFilePath.split('/').pop()}
                    </button>
                  )}
                  {/* Expand chevron */}
                  {hasOutput && (
                    <div className="flex-shrink-0 mt-0.5" style={{ color: '#6b7280' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </div>
                  )}
                </div>

                {/* Expanded output */}
                {isExpanded && hasOutput && (
                  <div className="ml-6 mt-1.5">
                    {isSynthesize ? (
                      <div className="text-xs rounded-lg px-3 py-2 overflow-y-auto whitespace-pre-wrap"
                        style={{
                          backgroundColor: 'rgba(0,0,0,0.4)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: '#e5e7eb',
                          maxHeight: '300px',
                          lineHeight: '1.5',
                        }}>
                        {synthesisAnswer}
                      </div>
                    ) : step.skill === 'guide.step' ? (
                      <>
                        {step.guideInstruction && (
                          <div className="text-xs rounded-lg px-3 py-2 mb-1.5"
                            style={{
                              backgroundColor: 'rgba(99,102,241,0.07)',
                              border: '1px solid rgba(99,102,241,0.25)',
                              color: '#c7d2fe',
                              lineHeight: '1.6',
                            }}>
                            {renderWithLinks(step.guideInstruction)}
                          </div>
                        )}
                        {step.stdout && step.stdout.trim().length > 0 && (
                          <pre className="text-xs rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all"
                            style={{
                              backgroundColor: 'rgba(0,0,0,0.4)',
                              border: '1px solid rgba(255,255,255,0.08)',
                              color: '#d1fae5',
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                              maxHeight: '80px',
                              overflowY: 'auto',
                            }}>
                            {step.stdout.trim()}
                          </pre>
                        )}
                      </>
                    ) : (
                      <>
                        {step.stdout && step.stdout.trim().length > 0 && (
                          <pre className="text-xs rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all"
                            style={{
                              backgroundColor: 'rgba(0,0,0,0.4)',
                              border: '1px solid rgba(255,255,255,0.08)',
                              color: '#d1fae5',
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                              maxHeight: '160px',
                              overflowY: 'auto',
                            }}>
                            {step.stdout.trim()}
                          </pre>
                        )}
                        {step.error && (
                          <pre className="text-xs rounded-lg px-3 py-2 mt-1 overflow-x-auto whitespace-pre-wrap break-all"
                            style={{
                              backgroundColor: 'rgba(239,68,68,0.08)',
                              border: '1px solid rgba(239,68,68,0.2)',
                              color: '#fca5a5',
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                              maxHeight: '120px',
                              overflowY: 'auto',
                            }}>
                            {step.error.trim()}
                          </pre>
                        )}
                      </>
                    )}
                  </div>
                )}
                {/* ── Login guidance banner — shown while waitForAuth polls after auth wall detected ── */}
                {step.status === 'running' && loginGuidance?.stepIndex === step.index && (
                  <div style={{ marginTop: 8, marginLeft: 28, padding: '8px 10px', borderRadius: 6, background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)' }}>
                    <div style={{ fontSize: '11px', color: '#fbbf24', fontWeight: 600, marginBottom: 3 }}>
                      ⏳ Sign in to continue
                    </div>
                    <div style={{ fontSize: '11px', color: '#d1d5db', lineHeight: 1.5 }}>
                      Please sign in to <strong style={{ color: '#f9fafb' }}>{loginGuidance.serviceDisplay}</strong> in the Chrome window.
                    </div>
                    {loginGuidance.loginUrl && (
                      <div style={{ fontSize: '10px', color: '#6b7280', marginTop: 3 }}>
                        {loginGuidance.loginUrl}
                      </div>
                    )}
                    <div style={{ fontSize: '10px', color: '#6b7280', marginTop: 4, fontStyle: 'italic' }}>
                      Your request will continue automatically after sign-in.
                    </div>
                  </div>
                )}
                {/* ── Flickering heartbeat — shown while step is running, before agent card appears ── */}
                {step.status === 'running' && !agentCompletes.has(step.index) && loginGuidance?.stepIndex !== step.index && (() => {
                  const startTime = agentStepStartTimes.current.get(step.index);
                  const elapsedMs = startTime ? (Date.now() - startTime) : 0;
                  const liveTurn = agentLiveTurns.current.get(step.index);
                  const label = liveTurn
                    ? `Turn ${liveTurn.turn}/${liveTurn.maxTurns} — ${getAgentStatusLabel(elapsedMs)}`
                    : getAgentStatusLabel(elapsedMs);
                  return (
                    <div style={{ marginTop: 2, marginLeft: 28 }}>
                      <span style={{
                        fontSize: '14px',
                        fontStyle: 'italic',
                        display: 'inline-block',
                        background: 'linear-gradient(90deg, #818cf8 30%, #c4b5fd 50%, #818cf8 70%)',
                        backgroundSize: '200% auto',
                        WebkitBackgroundClip: 'text',
                        WebkitTextFillColor: 'transparent',
                        backgroundClip: 'text',
                        animation: 'agentGloss 2s linear infinite',
                      }}>
                        {label}
                      </span>
                    </div>
                  );
                })()}
                {/* ── Sub-agent turn card ─────────────────────────────── */}
                {agentCompletes.has(step.index) && (
                  <div style={{ marginTop: 6, marginLeft: 28 }}>
                    <button
                      onClick={() => setExpandedAgentSteps(prev => {
                        const n = new Set(prev);
                        n.has(step.index) ? n.delete(step.index) : n.add(step.index);
                        return n;
                      })}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: '2px 0',
                        color: '#94a3b8',
                        fontSize: '11px',
                      }}
                    >
                      <span style={{ fontWeight: 600, color: '#818cf8' }}>
                        {agentCompletes.get(step.index)!.agentId}
                      </span>
                      <span>·</span>
                      <span>{agentCompletes.get(step.index)!.totalTurns} turn{agentCompletes.get(step.index)!.totalTurns !== 1 ? 's' : ''}</span>
                      <span>·</span>
                      <span style={{ color: agentCompletes.get(step.index)!.ok ? '#34d399' : '#f87171' }}>
                        {agentCompletes.get(step.index)!.ok ? '✓ done' : '✗ failed'}
                      </span>
                      <span style={{ fontSize: '9px', marginLeft: 2 }}>
                        {expandedAgentSteps.has(step.index) ? '▲' : '▼'}
                      </span>
                    </button>
                    {/* ── Agent result summary — shown when collapsed ── */}
                    {!expandedAgentSteps.has(step.index) && agentCompletes.get(step.index)!.ok && agentCompletes.get(step.index)!.result && (
                      <div style={{ marginTop: 3, paddingLeft: 2, fontSize: '11px', color: '#94a3b8', lineHeight: '1.45' }}>
                        {agentCompletes.get(step.index)!.result.length > 160
                          ? agentCompletes.get(step.index)!.result.slice(0, 160) + '…'
                          : agentCompletes.get(step.index)!.result}
                      </div>
                    )}
                    {/* ── Learned rule rows — always visible, one per saved rule ── */}
                    {(learnedRules.get(step.index) || []).map((rule, ri) => (
                      <div key={ri} style={{
                        display: 'flex', alignItems: 'flex-start', gap: 5,
                        marginTop: 4,
                        padding: '3px 7px',
                        borderRadius: 4,
                        borderLeft: '2px solid rgba(245,158,11,0.5)',
                        backgroundColor: 'rgba(245,158,11,0.05)',
                      }}>
                        {/* Memory icon */}
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 1 }}>
                          <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.44-3.16Z"/>
                          <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.44-3.16Z"/>
                        </svg>
                        <span style={{ color: '#fbbf24', fontSize: '10px', fontWeight: 600, flexShrink: 0 }}>Saved to memory</span>
                        <span title={rule} style={{
                          color: '#92400e', fontSize: '10px', fontFamily: 'ui-monospace,monospace',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180,
                        }}>
                          {rule.length > 110 ? rule.slice(0, 110) + '…' : rule}
                        </span>
                      </div>
                    ))}
                    {expandedAgentSteps.has(step.index) && (
                      <div style={{ marginTop: 4 }}>
                        {(agentTurns.get(step.index) || []).map((t, i) => {
                          // Only run_cmd and done are real execution steps that can truly fail.
                          // Exploration/thinking actions (web_search, run_help, web_fetch, etc.)
                          // are just the agent reasoning — show them dimmed, never red.
                          const isExecAction = t.action?.action === 'run_cmd' || t.action?.action === 'done';
                          const isFailed = isExecAction && t.outcome && !t.outcome.ok;
                          const outcomeText = t.outcome?.result || t.outcome?.error || '';
                          return (
                            <div key={i} style={{
                              fontSize: '11px',
                              padding: '2px 0 2px 8px',
                              borderLeft: `2px solid ${isFailed ? 'rgba(248,113,113,0.4)' : 'rgba(99,102,241,0.35)'}`,
                              marginBottom: 2,
                            }}>
                              <span style={{ color: '#6b7280', marginRight: 6 }}>Step {t.turn}/{t.maxTurns}</span>
                              {t.action?.action && (
                                <span style={{
                                  color: isFailed ? '#f87171' : '#a5b4fc',
                                  marginRight: 4,
                                  fontFamily: 'ui-monospace,monospace',
                                  fontSize: '10px',
                                }}>
                                  {formatActionLabel(t.action)}
                                </span>
                              )}
                              {t.outcome && (
                                <span style={{ color: t.outcome.ok ? '#6ee7b7' : '#fca5a5' }}>
                                  {t.outcome.ok
                                    ? (t.outcome.result && t.action?.action !== 'snapshot'
                                        ? `✓ ${t.outcome.result.length > 120 ? t.outcome.result.slice(0, 120) + '…' : t.outcome.result}`
                                        : '✓')
                                    : `✗ ${t.outcome.error || ''}`}
                                </span>
                              )}
                            </div>
                          );
                        })}
                        {(agentTurns.get(step.index) || []).length === 0 && agentCompletes.get(step.index)?.reasoning && (
                          <div style={{
                            fontSize: '11px',
                            color: '#94a3b8',
                            padding: '2px 0 2px 8px',
                            borderLeft: '2px solid rgba(99,102,241,0.3)',
                          }}>
                            {agentCompletes.get(step.index)!.reasoning}
                          </div>
                        )}
                        {(agentThoughts.get(step.index) || []).map((thought, ti) => (
                          <div key={`thought-${ti}`} style={{
                            fontSize: '11px',
                            color: '#a78bfa',
                            fontStyle: 'italic',
                            padding: '2px 0 2px 8px',
                            borderLeft: '2px solid rgba(167,139,250,0.3)',
                            marginBottom: 2,
                          }}>
                            💭 {thought.length > 200 ? thought.slice(0, 200) + '…' : thought}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Plan review: existing-plan banner + Approve/Cancel bar ────────── */}
      {phase === 'plan_review' && planReview && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 10, marginTop: 10}}>          {planReview.isExisting && (
            <div style={{ marginBottom: 8, padding: '7px 10px', borderRadius: 8, backgroundColor: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.25)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <span style={{ color: '#c4b5fd', fontSize: '0.73rem', fontWeight: 600 }}>
                Similar plan found ({planReview.similarity != null ? Math.round(planReview.similarity * 100) : 100}% match)
              </span>
              <button
                onClick={handlePlanNew}
                style={{ padding: '2px 8px', borderRadius: 5, backgroundColor: 'transparent', border: '1px solid rgba(107,114,128,0.3)', color: '#6b7280', fontSize: '0.68rem', fontWeight: 500, cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.07)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                New plan
              </button>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={handlePlanApprove}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 16px', borderRadius: 7, cursor: 'pointer', backgroundColor: 'rgba(59,130,246,0.18)', border: '1px solid rgba(59,130,246,0.45)', color: '#93c5fd', fontSize: '0.75rem', fontWeight: 600 }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.30)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.18)')}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Approve &amp; Run
            </button>
            <button
              onClick={handlePlanCancel}
              style={{ padding: '6px 14px', borderRadius: 7, cursor: 'pointer', backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171', fontSize: '0.75rem', fontWeight: 500 }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.08)')}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Saved file links ─────────────────────────────────────────────── */}
      {phase === 'done' && savedFilePaths.length > 0 && (
        <div className="space-y-1.5 mt-1">
          {savedFilePaths.map((filePath) => {
            const fileName = filePath.split('/').pop() || filePath;
            return (
              <button
                key={filePath}
                onClick={() => ipcRenderer?.send('shell:open-path', filePath)}
                className="flex items-center gap-2 w-full text-left px-3 py-2 rounded-lg transition-colors"
                style={{
                  backgroundColor: 'rgba(59,130,246,0.08)',
                  border: '1px solid rgba(59,130,246,0.2)',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.15)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.08)')}
                title={filePath}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                <span className="text-xs font-medium truncate" style={{ color: '#93c5fd' }}>
                  {fileName}
                </span>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginLeft: 'auto' }}>
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                  <polyline points="15 3 21 3 21 9" />
                  <line x1="10" y1="14" x2="21" y2="3" />
                </svg>
              </button>
            );
          })}
        </div>
      )}

      {/* ── Planning pulse (no steps yet) ────────────────────────────────── */}
      {phase === 'planning' && steps.length === 0 && (
        <div className="flex items-center gap-2" style={{ color: '#6b7280' }}>
          <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
          <span className="text-xs">Analyzing your request...</span>
        </div>
      )}

      {/* ── GUIDE STEP: instruction card ──────────────────────────── */}
      {guideStep && (
        <div className="mt-2 rounded-xl overflow-hidden"
          style={{ border: '1px solid rgba(99,102,241,0.35)', backgroundColor: 'rgba(99,102,241,0.06)' }}>
          {/* Header */}
          <div className="flex items-center gap-2 px-3 py-2"
            style={{ borderBottom: '1px solid rgba(99,102,241,0.2)', backgroundColor: 'rgba(99,102,241,0.1)' }}>
            {guideStep.mode === 'page_event' ? (
              <>
                <div className="w-3 h-3 rounded-full border-2 animate-spin flex-shrink-0"
                  style={{ borderColor: '#a5b4fc', borderTopColor: 'transparent' }} />
                <span className="text-xs font-semibold" style={{ color: '#a5b4fc' }}>Waiting for your action in the browser</span>
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span className="text-xs font-semibold" style={{ color: '#a5b4fc' }}>Action Required</span>
              </>
            )}
          </div>
          {/* Instruction */}
          <div className="px-3 py-2.5">
            <p className="text-sm" style={{ color: '#e5e7eb', lineHeight: 1.6 }}>
              {renderWithLinks(guideStep.instruction)}
            </p>
            {guideStep.mode === 'page_event' && (
              <p className="text-xs mt-2" style={{ color: '#6b7280' }}>
                The browser is highlighting what to click. Once you click it, the guide continues automatically.
              </p>
            )}
          </div>
          {/* Action buttons */}
          <div className="px-3 pb-3 flex gap-2">
            {/* Continue button — only shown in IPC fallback mode */}
            {guideStep.mode === 'ipc' && (
              <button
                onClick={handleGuideContinue}
                className="flex-1 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{
                  backgroundColor: 'rgba(99,102,241,0.2)',
                  border: '1px solid rgba(99,102,241,0.4)',
                  color: '#a5b4fc',
                  cursor: 'pointer',
                }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.35)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(99,102,241,0.2)')}
              >
                ✓ Done — Continue
              </button>
            )}
            {/* Stop Guide button — always shown */}
            <button
              onClick={handleGuideCancel}
              className="py-2 rounded-lg text-sm font-medium transition-colors"
              style={{
                flex: guideStep.mode === 'ipc' ? '0 0 auto' : '1',
                padding: '8px 14px',
                backgroundColor: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.25)',
                color: '#f87171',
                cursor: 'pointer',
              }}
              onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(239,68,68,0.08)')}
            >
              Stop Guide
            </button>
          </div>
        </div>
      )}

      {/* ── ASK_USER: clickable option buttons ───────────────────────────── */}
      {askUserPrompt && (
        <div className="mt-2 space-y-2">
          <div className="text-sm font-medium" style={{ color: '#e5e7eb', lineHeight: 1.5 }}>
            <RichContentRenderer content={askUserPrompt.question} animated={false} className="text-sm" />
          </div>
          {askUserPrompt.options.length > 0 && (
            <div className="flex flex-col gap-1.5 mt-2">
              {askUserPrompt.options.map((option, i) => (
                <button
                  key={i}
                  onClick={() => handleOptionClick(option)}
                  className="text-left px-3 py-2 rounded-lg text-sm transition-colors"
                  style={{
                    backgroundColor: 'rgba(59,130,246,0.08)',
                    border: '1px solid rgba(59,130,246,0.25)',
                    color: '#93c5fd',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.18)')}
                  onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(59,130,246,0.08)')}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
