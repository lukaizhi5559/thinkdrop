/**
 * AutomationProgress — Windsurf-style live automation progress display.
 *
 * Shows:
 *   1. "Generating plan..." spinner while planSkills runs
 *   2. Step list (N / total done) as executeCommand fires step events
 *   3. Stdout output inline under each completed step
 *   4. Final summary on completion or error banner on failure
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { RichContentRenderer } from './rich-content';

const ipcRenderer = (window as any).electron?.ipcRenderer;

// ── Types ─────────────────────────────────────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'replanning' | 'deferred' | 'needs_input';

interface Step {
  index: number;
  skill: string;
  description: string;
  status: StepStatus;
  stdout?: string;
  stderr?: string;
  error?: string;
  exitCode?: number;
  replanMessage?: string;
  savedFilePath?: string;
  guideInstruction?: string; // original instruction text preserved after guide.step completes
  userAllowlistHint?: boolean;
  commandName?: string | null;
  runGroup?: string; // parallel group ID (e.g. "g1")
  args?: any; // arguments passed to the skill (contains agentId for browser.agent)
}

// ── AgentFavicon — shown next to agentId on every agent step ─────────────────
function agentIdToDomain(agentId: string): string {
  // Strip .agent suffix, map to domain (e.g. amazon.agent → amazon.com)
  const base = agentId.replace(/\.agent$/i, '').toLowerCase();
  const overrides: Record<string, string> = {
    gmail: 'mail.google.com',
    google: 'google.com',
    youtube: 'youtube.com',
    ebay: 'ebay.com',
    amazon: 'amazon.com',
    reddit: 'reddit.com',
    twitter: 'twitter.com',
    x: 'x.com',
    linkedin: 'linkedin.com',
    slack: 'slack.com',
    notion: 'notion.so',
    github: 'github.com',
    perplexity: 'perplexity.ai',
    chatgpt: 'chat.openai.com',
    openai: 'openai.com',
  };
  return overrides[base] || `${base}.com`;
}

function AgentFavicon({ agentId, size = 14 }: { agentId: string; size?: number }) {
  const [ok, setOk] = useState(true);
  const domain = agentIdToDomain(agentId);
  const src = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
  if (!ok) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#6b7280', flexShrink: 0 }}>
        <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
    );
  }
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt=""
      onError={() => setOk(false)}
      style={{ borderRadius: 2, flexShrink: 0, display: 'block' }}
    />
  );
}

type AutomationPhase =
  | 'idle'
  | 'gathering'
  | 'preflight'
  | 'planning'
  | 'executing'
  | 'done'
  | 'failed'
  | 'ask_user'
  | 'guide_step'
  | 'schedule_wait'
  | 'evaluating'
  | 'retrying_with_fix'
  | 'recovering'
  | 'project_building'
  | 'plan_review';

interface PreflightAgent {
  type: 'cli' | 'browser' | 'app' | 'api_key' | 'bearer' | 'basic' | 'preflight';
  agentId: string;
  ready: boolean;
  authed: boolean;
  iconUrl: string | null;
  message?: string;
}

interface PreflightAuthRequired {
  agentId: string;
  serviceName: string;
  authType: 'cli_token' | 'browser_oauth' | 'app_intro' | 'cli_install' | 'api_key' | 'bearer' | 'basic' | 'cli_update_needed' | 'browser_reauth' | 'cli_setup';
  iconUrl: string;
  message: string;
  reason?: string;
  setupInfo?: {
    installCmd?: string;
    authCmd?: string;
    credentials?: string[];
    verifyCmd?: string;
    setupUrl?: string | string[];
    instructions?: string;
  } | null;
}

interface RouteChoiceOption {
  route: 'cli_api' | 'browser' | 'app';
  label: string;
  recommended: boolean;
  description: string;
  agentId: string;
  authType: string;
  requiresSetup: boolean;
  appInstalled?: boolean;
  downloadUrl?: string | null;
}

interface RouteChoice {
  serviceName: string;
  iconUrl: string;
  options: RouteChoiceOption[];
}

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

interface GatherAuthActionItem {
  label: string;
  value: string;
  primary: boolean;
}

interface GatherAuthAction {
  question: string;
  agentId: string;
  agentType: 'browser' | 'cli';
  authType: 'browser_oauth' | 'browser_reauth' | 'cli_token' | 'api_key';
  iconUrl: string | null;
  startUrl: string | null;
  actions: GatherAuthActionItem[];
}

interface AskUserPrompt {
  question: string;
  options: (string | { label?: string; value?: string })[];
  agentId?: string | null;
  freeText?: boolean;
  stepIndex?: number | null;
}

interface ParallelLoginService {
  stepIdx: number;
  agentId: string;
  service: string;
  description: string;
}

type ParallelLoginDecision = 'login' | 'try_without' | 'skip';

interface AgentTurnEntry {
  turn: number;
  maxTurns: number;
  action?: { action?: string; [key: string]: any };
  outcome?: { ok: boolean; error?: string; result?: string };
  observation?: string;
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
  onHeightChange?: (height: number) => void;
  onActiveChange?: (active: boolean) => void;
  onOpenRules?: () => void;
  onAskUserShown?: () => void;
  setIsSubmitting?: (submitting: boolean) => void;
  onAuthPending?: (pending: boolean) => void;
  suppressIfScheduled?: boolean;
  activeTab?: string;
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
  if (status === 'skipped') {
    return (
      <div className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
        style={{ backgroundColor: 'rgba(245,158,11,0.15)', border: '1.5px solid #f59e0b' }}>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5"
          strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </div>
    );
  }
  if (status === 'needs_input') {
    return (
      <div className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
        style={{ backgroundColor: '#f59e0b' }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
          strokeLinecap="round" strokeLinejoin="round">
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
    );
  }
  if (status === 'deferred') {
    return (
      <div className="flex-shrink-0 w-4 h-4 rounded-full flex items-center justify-center"
        style={{ backgroundColor: 'rgba(107,114,128,0.12)', border: '1.5px solid #4b5563' }}>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#6b7280" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </div>
    );
  }
  if (status === 'replanning') {
    // Orange/yellow spinner indicating step is being replanned
    return (
      <div className="flex-shrink-0 w-4 h-4 rounded-full border-2 animate-spin"
        style={{ borderColor: '#f59e0b', borderTopColor: 'transparent' }} />
    );
  }
  // pending
  return (
    <div className="flex-shrink-0 w-4 h-4 rounded-full"
      style={{ backgroundColor: 'rgba(156,163,175,0.25)', border: '1px solid rgba(156,163,175,0.4)' }} />
  );
}

// ── ETA estimation ──────────────────────────────────────────────────────────
// Per-skill execution time ranges [lo, hi] in milliseconds, based on observed runs.
const SKILL_MS: Record<string, [number, number]> = {
  'shell.run':      [300,   800],
  'synthesize':     [1500,  3000],
  'browser.act':    [2000,  4000],
  'browser.agent':  [12000, 30000],
  'external.skill': [3000,  8000],
  'image.analyze':  [2000,  5000],
  'fs.read':        [200,   600],
  'fs.write':       [200,   600],
  'cli.agent':      [3000,  8000],
  'guide.step':     [5000,  15000],
  'screen.capture': [1000,  3000],
};
// Fixed LLM pipeline overhead before execution starts (decomposePrompt + enrichIntent +
// gatherPlanContext + planSkills + reviewExecution). Shell-only tasks now skip reviewExecution.
const PIPELINE_OVERHEAD_MS: [number, number] = [14000, 20000];

// Infer the likely skill type from a plain-text step description (used at plan:generated
// time when skill names are not yet known — only step titles from the plan.md are available).
function inferSkillFromDescription(desc: string): string {
  const d = desc.toLowerCase();
  if (/browser|navigate|open.*url|click|fill|scroll.*page|web page|website|search.*on|go to http/.test(d)) return 'browser.act';
  if (/agent|autonomously|multi.?step|reason|browse.*and|visit.*and/.test(d)) return 'browser.agent';
  if (/external.*skill|run.*skill|execute.*skill/.test(d)) return 'external.skill';
  if (/analyze.*image|image.*analyze|screenshot.*analyze/.test(d)) return 'image.analyze';
  if (/capture.*screen|screenshot|screen.*capture/.test(d)) return 'screen.capture';
  if (/summarize|provide.*summary|generate.*summary|confirm.*complete|report|answer|tell me|create.*description/.test(d)) return 'synthesize';
  if (/guide|instruction|manual step|click.*manually/.test(d)) return 'guide.step';
  return 'shell.run';
}

function estimateEta(steps: Step[]): { lo: number; hi: number } {
  const [oLo, oHi] = PIPELINE_OVERHEAD_MS;
  let lo = oLo, hi = oHi;
  for (const s of steps) {
    const [sLo, sHi] = SKILL_MS[s.skill] ?? [500, 2000];
    lo += sLo;
    hi += sHi;
  }
  return { lo, hi };
}

function formatEta(lo: number, hi: number): string {
  const loS = Math.round(lo / 1000);
  const hiS = Math.round(hi / 1000);

  // Helper to format single duration as Xm Ys or Xh Ym Zs
  const fmt = (sec: number): string => {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) {
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return s > 0 ? `${m}m ${s}s` : `${m}m`;
    }
    // Hours
    const h = Math.floor(sec / 3600);
    const rem = sec % 3600;
    const m = Math.floor(rem / 60);
    const s = rem % 60;
    const parts: string[] = [`${h}h`];
    if (m > 0) parts.push(`${m}m`);
    if (s > 0) parts.push(`${s}s`);
    return parts.join(' ');
  };

  if (Math.abs(hiS - loS) <= 4) return `~${fmt(loS)}`;
  return `~${fmt(loS)} – ${fmt(hiS)}`;
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
    case 'run_shell':  return action.script
      ? `Probe: ${(action.script as string).slice(0, 60)}${(action.script as string).length > 60 ? '…' : ''}`
      : 'Shell probe';
    case 'run_help':   return `Read help${Array.isArray(action.subcmd) && action.subcmd.length ? ': ' + action.subcmd.join(' ') : ''}`;
    case 'web_search': return `Search: ${((action.query as string) || '').slice(0, 50)}`;
    case 'web_fetch':  { try { return `Fetch: ${new URL(action.url || '').hostname}`; } catch { return `Fetch: ${(action.url || '').slice(0, 40)}`; } }
    case 'run_update': return `Update ${action.cli || 'CLI'}`;
    case 'ask_user':   return `Ask: ${((action.question as string) || '').slice(0, 60)}`;
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

export default function AutomationProgress({ onHeightChange, onActiveChange, onOpenRules, onAskUserShown, setIsSubmitting, onAuthPending, suppressIfScheduled, activeTab }: AutomationProgressProps) {
  const [phase, setPhase] = useState<AutomationPhase>('idle');
  const planReviewRef = useRef<HTMLDivElement>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [planMessage, setPlanMessage] = useState('Generating skill plan...');
  const [totalCount, setTotalCount] = useState(0);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [expandedSteps, setExpandedSteps] = useState<Set<number>>(new Set());
  const [synthesisAnswer, setSynthesisAnswer] = useState<string>('');
  const [savedFilePaths, setSavedFilePaths] = useState<string[]>([]);
  const [askUserPrompt, setAskUserPrompt] = useState<AskUserPrompt | null>(null);
  const [askUserFreeText, setAskUserFreeText] = useState('');
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
  const [gatherAuthAction, setGatherAuthAction] = useState<GatherAuthAction | null>(null);
  const [gatherAuthConnecting, setGatherAuthConnecting] = useState(false);
  const [gatherAuthBrowserOpened, setGatherAuthBrowserOpened] = useState(false);
  // Login guidance — shown inline while waitForAuth polls (step stays running)
  const [loginGuidance, setLoginGuidance] = useState<{ stepIndex: number; serviceDisplay: string; loginUrl: string; message: string; sessionId: string } | null>(null);
  const [manualAuthBtnVisible, setManualAuthBtnVisible] = useState(false);
  // Task auth overlay — prominent lock card shown when login wall detected during task execution
  const [taskAuthOverlay, setTaskAuthOverlay] = useState<{ stepIndex: number; serviceDisplay: string; loginUrl: string; agentId: string; message: string } | null>(null);
  const [gatherOAuthConnected, setGatherOAuthConnected] = useState<string | null>(null);
  // Maps stepIndex → array of agent turn entries (populated post-hoc from cli.agent / browser.agent runs)
  const [agentTurns, setAgentTurns] = useState<Map<number, AgentTurnEntry[]>>(new Map());
  const [agentCompletes, setAgentCompletes] = useState<Map<number, AgentComplete>>(new Map());
  const [expandedAgentSteps, setExpandedAgentSteps] = useState<Set<number>>(new Set());
  // Maps stepIndex → array of learned rule strings saved to memory during that step
  const [learnedRules, setLearnedRules] = useState<Map<number, string[]>>(new Map());
  // Maps stepIndex → LLM thought strings from browser.agent (plan / replan / repair phases)
  const [agentThoughts, setAgentThoughts] = useState<Map<number, string[]>>(new Map());
  // Maps stepIndex → current thinking text from shell.run goal resolution
  const [stepThinking, setStepThinking] = useState<Map<number, string>>(new Map());
  // Maps stepIndex → accumulated live stdout/stderr text (streamed during execution)
  const [stepLiveOutput, setStepLiveOutput] = useState<Map<number, string>>(new Map());
  // Set of step indices that have triggered a sudo_required warning
  const [stepSudoWarning, setStepSudoWarning] = useState<Set<number>>(new Set());
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

  // ETA estimate state
  const [etaLabel, setEtaLabel] = useState<string | null>(null);
  const [elapsedLabel, setElapsedLabel] = useState<string | null>(null);
  const executionStartRef = useRef<number | null>(null);
  const suppressIfScheduledRef = useRef<boolean>(!!suppressIfScheduled);
  suppressIfScheduledRef.current = !!suppressIfScheduled;

  // Name-a-plan state (Part 5)
  const [showNamePlan, setShowNamePlan] = useState(false);
  const [planNameInput, setPlanNameInput] = useState('');
  const [planNameSaved, setPlanNameSaved] = useState(false);
  const [planNameError, setPlanNameError] = useState('');
  const [savedContextRule, setSavedContextRule] = useState<{ ruleText: string; contextKey: string; category: string } | null>(null);
  const [failureAnswer, setFailureAnswer] = useState<string | null>(null);
  const [parallelLoginServices, setParallelLoginServices] = useState<ParallelLoginService[] | null>(null);
  const [parallelLoginDecisions, setParallelLoginDecisions] = useState<Record<string, ParallelLoginDecision>>({});
  const [parallelLoginCountdown, setParallelLoginCountdown] = useState<number>(180); // 3 minute timeout countdown
  const _planFileRef = useRef<string>('');
  const DOT_NAME_RE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
  const isValidDotName = (n: string) => {
    if (!DOT_NAME_RE.test(n)) return false;
    const segs = n.split('.');
    return segs.length >= 2 && segs.length <= 5;
  };
  const derivePlanName = (title: string) => {
    const stop = new Set(['a','an','the','for','to','in','on','at','of','and','or','with','from','by','check','find','get','run','go']);
    const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !stop.has(w)).slice(0, 5);
    const c = words.join('.');
    return isValidDotName(c) ? c : '';
  };

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

  // Preflight state
  const [preflightAgents, setPreflightAgents] = useState<PreflightAgent[]>([]);
  const [preflightAuthRequired, setPreflightAuthRequired] = useState<PreflightAuthRequired | null>(null);
  const preflightAuthRequiredRef = useRef<PreflightAuthRequired | null>(null);
  useEffect(() => { preflightAuthRequiredRef.current = preflightAuthRequired; }, [preflightAuthRequired]);
  const [preflightAuthBrowserOpened, setPreflightAuthBrowserOpened] = useState(false);
  const [preflightAuthBackgroundFailed, setPreflightAuthBackgroundFailed] = useState(false);
  const [authContinueVisible, setAuthContinueVisible] = useState(false);
  const [preflightRouteChoice, setPreflightRouteChoice] = useState<RouteChoice | null>(null);
  const [preflightMessage, setPreflightMessage] = useState('Preparing agents...');
  const [preflightWarnings, setPreflightWarnings] = useState<{ type: string; message: string }[]>([]);
  const [vetScriptReview, setVetScriptReview] = useState<{ scriptContent: string; scriptUrl: string; message: string } | null>(null);

  // Delay the "I've signed in — Continue" button by 5s after browser auth opens
  useEffect(() => {
    if (preflightAuthBrowserOpened) {
      setAuthContinueVisible(false);
      const t = setTimeout(() => setAuthContinueVisible(true), 5000);
      return () => clearTimeout(t);
    }
    setAuthContinueVisible(false);
  }, [preflightAuthBrowserOpened]);

  // Ref to track current phase — avoids stale closure issues in the IPC listener useEffect
  const phaseRef = useRef<AutomationPhase>('idle');
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Scroll plan review buttons into view when plan_review phase activates
  useEffect(() => {
    if (phase === 'plan_review' && planReviewRef.current) {
      // Delay to allow DOM to settle
      setTimeout(() => {
        planReviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }, 150);
    }
  }, [phase]);

  // Refs for auto-scrolling to the active step
  const stepRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  // Tracks global step index offset across multi-intent queue sub-plans.
  // When plan_ready fires for a second/third sub-intent, new steps are appended
  // at this offset so the user sees a cumulative list instead of a reset view.
  const stepOffsetRef = useRef<number>(0);
  // Tracks the absolute index of the most recent synthesize step (used for auto-expand)
  const synthStepIndexRef = useRef<number | null>(null);
  // Tracks when each running step started (for flickering heartbeat status)
  const agentStepStartTimes = useRef<Map<number, number>>(new Map());
  // Tracks live turn progress (agent:turn_live) from the command-service callback
  const agentLiveTurns = useRef<Map<number, { turn: number; maxTurns: number; currentAction?: string | null; agentId?: string; thinking?: string | null }>>(new Map());
  const [_heartbeatTick, setHeartbeatTick] = useState(0);

  // Callback ref for ResizeObserver — useCallback fires when div actually mounts/unmounts.
  // useRef+useEffect([]) misses the mount because the component returns null during idle phase.
  // STABILIZED: Added height delta threshold (40px) and stabilization timer (150ms) to prevent bouncing.
  const rootObserverRef = useRef<ResizeObserver | null>(null);
  const rootDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const lastHeightRef = useRef<number>(0);
  const stableHeightRef = useRef<number>(0);
  const stabilizeTimerRef = useRef<NodeJS.Timeout | null>(null);

  const rootCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (rootObserverRef.current) {
      rootObserverRef.current.disconnect();
      rootObserverRef.current = null;
    }
    if (rootDebounceRef.current) {
      clearTimeout(rootDebounceRef.current);
      rootDebounceRef.current = null;
    }
    if (stabilizeTimerRef.current) {
      clearTimeout(stabilizeTimerRef.current);
      stabilizeTimerRef.current = null;
    }
    if (!node) return;

    const obs = new ResizeObserver(([entry]) => {
      const newHeight = Math.round(entry.contentRect.height);

      // Clear any pending stabilization timer
      if (stabilizeTimerRef.current) {
        clearTimeout(stabilizeTimerRef.current);
        stabilizeTimerRef.current = null;
      }

      // Check if height change is significant enough (>40px threshold)
      // This prevents rapid small shifts during planning/replanning
      const heightDelta = Math.abs(newHeight - lastHeightRef.current);
      if (heightDelta < 40 && lastHeightRef.current !== 0) {
        return; // Ignore small jitter
      }

      // Wait for height to stabilize before reporting (150ms stabilization period)
      // This prevents the window from bouncing during rapid content updates
      stableHeightRef.current = newHeight;
      stabilizeTimerRef.current = setTimeout(() => {
        if (stableHeightRef.current === newHeight) {
          lastHeightRef.current = newHeight;
          console.log('[AutomationProgress] Height stabilized:', newHeight);
          // Only send height changes when on results tab - prevents fighting with useDynamicHeight
          if (activeTab === 'results') {
            onHeightChange?.(newHeight);
          }
        }
      }, 150);
    });

    obs.observe(node);
    rootObserverRef.current = obs;
  }, [onHeightChange, activeTab]);

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

  // Parallel login countdown timer
  useEffect(() => {
    if (!parallelLoginServices) {
      setParallelLoginCountdown(180);
      return;
    }
    const id = setInterval(() => {
      setParallelLoginCountdown(prev => {
        if (prev <= 1) {
          clearInterval(id);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [parallelLoginServices]);

  useEffect(() => {
    if (!ipcRenderer) return;
    let active = true;

    // Reset when a new prompt starts (skip for resume answers so step cards stay visible)
    const handleNewPrompt = (data?: any) => {
      if (data?.isResume || (typeof data === 'object' && data?.isResume)) {
        // Resume answer: clear only the prompt card, keep the step list/spinner intact
        setAskUserPrompt(null);
        return;
      }
      setPhase('idle');
      setSteps([]);
      setGlobalError(null);
      setTotalCount(0);
      setPreflightAgents([]);
      setPreflightAuthRequired(null);
      setPreflightAuthBrowserOpened(false);
      setPreflightAuthBackgroundFailed(false);
      setPreflightRouteChoice(null);
      setPreflightWarnings([]);
      setVetScriptReview(null);
      setExpandedSteps(new Set());
      synthStepIndexRef.current = null;
      setSynthesisAnswer('');
      setFailureAnswer(null);
      setSavedFilePaths([]);
      setAskUserPrompt(null);
      setGatherAuthAction(null);
      setGatherAuthConnecting(false);
      setGatherAuthBrowserOpened(false);
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
      setManualAuthBtnVisible(false);
      setTaskAuthOverlay(null);
      setLearnedRules(new Map());
      setAgentThoughts(new Map());
      setStepLiveOutput(new Map());
      setStepSudoWarning(new Set());
      setProjectBuild(null);
      setProjectBuildFiles([]);
      setPlanReview(null);
      setSavedContextRule(null);
      // Reset multi-intent step accumulation offset
      stepOffsetRef.current = 0;
      setEtaLabel(null);
      setElapsedLabel(null);
      executionStartRef.current = null;
    };
    const handleScanProgress = (data: any) => {
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
    const handleScanDiscovery = (data: any) => {
      if (!active || !Array.isArray(data?.suggestions) || data.suggestions.length === 0) return;
      setScanDiscovery(data.suggestions);
    };
    const handleProgress = (data: any) => {
      if (suppressIfScheduledRef.current) return;
      if (!active) return;
      switch (data.type) {
        case 'preflight:start':
          setPhase('preflight');
          setPreflightAgents([]);
          setPreflightAuthRequired(null);
          setPreflightAuthBrowserOpened(false);
          setPreflightAuthBackgroundFailed(false);
          setPreflightRouteChoice(null);
          setPreflightWarnings([]);
          setVetScriptReview(null);
          setPreflightMessage(data.message || 'Preparing agents...');
          break;

        case 'preflight:building_agent': {
          setPhase('preflight');
          setPreflightAuthRequired(null);
          setPreflightAuthBrowserOpened(false);
          setPreflightAuthBackgroundFailed(false);
          const buildingAgent: PreflightAgent = {
            type: data.agentType || 'browser',
            agentId: data.agentId || '',
            ready: false,
            authed: false,
            iconUrl: data.iconUrl || null,
            message: data.message || `Checking ${data.agentId || 'agent'}...`,
          };
          setPreflightAgents(prev => {
            const existing = prev.findIndex(a => a.agentId === buildingAgent.agentId);
            if (existing >= 0) {
              const next = [...prev];
              next[existing] = buildingAgent;
              return next;
            }
            return [...prev, buildingAgent];
          });
          if (data.message) setPreflightMessage(data.message);
          break;
        }

        case 'preflight:route_choice':
          setPhase('preflight');
          setPreflightRouteChoice({
            serviceName: data.serviceName,
            iconUrl: data.iconUrl,
            options: data.options || [],
          });
          onAuthPending?.(true);
          break;

        case 'preflight:auth_required':
          setPreflightAuthRequired({
            agentId: data.agentId,
            serviceName: data.serviceName,
            authType: data.authType,
            iconUrl: data.iconUrl,
            message: data.message,
            reason: data.reason || null,
            setupInfo: data.setupInfo || null,
          });
          setPreflightAuthBrowserOpened(false);
          setPreflightAuthBackgroundFailed(false);
          onAuthPending?.(true);
          break;

        case 'preflight:agent_ready':
          setPreflightAgents(prev => prev.map(a =>
            a.agentId === data.agentId
              ? { ...a, ready: true, authed: true, message: data.message || `${data.agentId} ready` }
              : a
          ));
          setPreflightAuthRequired(prev => (prev?.agentId === data.agentId ? null : prev));
          if (preflightAuthRequiredRef.current?.agentId === data.agentId) {
            onAuthPending?.(false);
          }
          if (data.message) setPreflightMessage(data.message);
          break;

        case 'preflight:auth_failed':
          setPreflightAgents(prev => prev.map(a =>
            a.agentId === data.agentId
              ? { ...a, ready: false, authed: false, message: data.message || `${data.agentId} auth failed` }
              : a
          ));
          setPreflightAuthRequired(prev => (prev?.agentId === data.agentId ? null : prev));
          if (preflightAuthRequiredRef.current?.agentId === data.agentId) {
            onAuthPending?.(false);
          }
          setPreflightWarnings(prev => [
            ...prev,
            { type: 'preflight_auth_failed', message: data.message || `${data.agentId} authentication failed` },
          ]);
          if (data.message) setPreflightMessage(data.message);
          break;

        case 'preflight:complete':
          if (Array.isArray(data.agents)) {
            setPreflightAgents(data.agents.map((a: any) => ({
              type: a.type,
              agentId: a.agentId,
              ready: a.ready,
              authed: a.authed,
              iconUrl: a.iconUrl,
            })));
          }
          if (Array.isArray(data.warnings)) {
            setPreflightWarnings(data.warnings);
          }
          // All agents ready — clear auth pending state so cancel button doesn't stick
          onAuthPending?.(false);
          // Transition to planning after a brief delay so user sees the final state
          setTimeout(() => {
            setPreflightAuthRequired(null);
            setPreflightAuthBrowserOpened(false);
            setPreflightAuthBackgroundFailed(false);
            setPreflightRouteChoice(null);
            setPhase('planning');
            setPlanMessage('Generating skill plan...');
          }, 500);
          break;

        case 'resuming': {
          setAskUserPrompt(null);
          setPhase('executing');
          // Flip any paused (needs_input) steps back to running spinners
          setSteps(prev => prev.map(s => s.status === 'needs_input' && (typeof data.stepIndex !== 'number' || s.index === data.stepIndex) ? { ...s, status: 'running' as const } : s));
          // Resume progress events carry the original step index so step_start maps back to the existing card.
          if (typeof data.stepIndex === 'number') stepOffsetRef.current = data.stepIndex;
          setPlanMessage(data.agentId ? `Resuming ${data.agentId}…` : 'Resuming…');
          setGlobalError(null);
          break;
        }

        case 'planning':
          setAskUserPrompt(null);
          setExpandedSteps(new Set());
          setFailureAnswer(null);
          setPreflightAgents([]);
          setPreflightAuthRequired(null);
          setPreflightAuthBrowserOpened(false);
          setPreflightAuthBackgroundFailed(false);
          setPreflightRouteChoice(null);
          setPreflightWarnings([]);
          setVetScriptReview(null);
          setPhase('planning');
          setPlanMessage(data.message || 'Generating skill plan...');
          setSteps([]);
          setGlobalError(null);
          setTotalCount(0);
          break;

        case 'plan_ready': {
          // Don't override an active plan review — user must approve before execution starts
          if (phaseRef.current === 'plan_review') break;
          // Resume of an ask_user step: resuming already set the offset and flipped the '?' back to spinner.
          if (data.isResume) break;
          // If there are already completed steps (mid-queue), append rather than replace.
          // This gives users a cumulative view of all sub-intent steps instead of resetting.
          // Exception: recoveryReplan=true means the failed step is being retried with a new plan —
          // reset the view so the old red X is replaced rather than appended below it.
          const isRecoveryReplan = data.recoveryReplan === true;
          const isSingleStepReplan = data.singleStepReplan === true;
          const hasDoneSteps = !isRecoveryReplan && steps.some(s => s.status === 'done');
          
          // Single-step replan: merge new step into existing plan, preserve prior step statuses
          if (isSingleStepReplan && steps.length > 0) {
            setSteps(prev => {
              // CRITICAL FIX: Build a map of new steps by their index
              const newStepsByIndex = new Map<number, any>();
              data.steps.forEach((s: any) => {
                newStepsByIndex.set(s.index, s);
              });
              
              // Build merged array by comparing step CONTENT (not just index)
              // A step is "replaced" only if its skill or description changed
              const mergedSteps: Step[] = [];
              
              // Process all steps that should exist in the final plan
              // Get the max index to know the full range
              const allIndices = new Set<number>();
              prev.forEach(s => allIndices.add(s.index));
              data.steps.forEach((s: any) => allIndices.add(s.index));
              
              // For each index, decide which version to keep
              Array.from(allIndices).sort((a, b) => a - b).forEach(index => {
                const existingStep = prev.find(s => s.index === index);
                const newStep = newStepsByIndex.get(index);
                
                if (existingStep && newStep) {
                  // Step exists in both old and new plan - check if it changed
                  const isSameSkill = existingStep.skill === newStep.skill;
                  const isAlreadyDone = existingStep.status === 'done';
                  
                  if (isSameSkill && isAlreadyDone) {
                    // Same skill type and already completed — preserve done status even if
                    // description text changed (LLM may reword it slightly on replan).
                    mergedSteps.push({ ...existingStep, description: newStep.description });
                  } else if (isSameSkill && existingStep.status !== 'failed') {
                    // Same skill, not done, not failed — preserve current status
                    mergedSteps.push(existingStep);
                  } else {
                    // Skill changed or step failed — use new version with pending status
                    mergedSteps.push({
                      index: newStep.index,
                      skill: newStep.skill,
                      description: newStep.description,
                      status: 'pending' as StepStatus,
                      runGroup: newStep.runGroup || undefined,
                    });
                  }
                } else if (existingStep && !newStep) {
                  // Step only in old plan - keep it (might be done)
                  mergedSteps.push(existingStep);
                } else if (newStep) {
                  // Step only in new plan - add as pending
                  mergedSteps.push({
                    index: newStep.index,
                    skill: newStep.skill,
                    description: newStep.description,
                    status: 'pending' as StepStatus,
                    runGroup: newStep.runGroup || undefined,
                  });
                }
              });
              
              return mergedSteps;
            });
            // Don't reset offset or phase - continue executing with updated plan
            setTotalCount(data.steps.length);
          } else if (hasDoneSteps) {
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
                runGroup: s.runGroup || undefined,
              })),
            ]);
          } else {
            stepOffsetRef.current = 0;
            setPhase('executing');
            setTotalCount(data.steps.length);
            if (data.intent) setIntentType(data.intent);
            // Compute ETA from skill list now that we know the plan
            const _etaSteps: Step[] = data.steps.map((s: any) => ({ index: s.index, skill: s.skill, description: s.description, status: 'pending' as StepStatus }));
            const { lo, hi } = estimateEta(_etaSteps);
            setEtaLabel(formatEta(lo, hi));
            setElapsedLabel(null);
            executionStartRef.current = Date.now();
            setSteps(data.steps.map((s: any) => ({
              index: s.index,
              skill: s.skill,
              description: s.description,
              status: 'pending' as StepStatus,
              runGroup: s.runGroup || undefined,
            })));
          }
          break;
        }

        case 'plan_error': {
          setPhase('failed');
          setGlobalError(data.error || 'Plan generation failed');
          break;
        }

        case 'step_start': {
          const stepIdx = data.stepIndex + stepOffsetRef.current;
          // Log parallel group steps for debugging
          if (data.runGroup) {
            console.log(`[AutomationProgress] step_start: stepIdx=${stepIdx}, runGroup=${data.runGroup}, skill=${data.skill}`);
          }
          // Clear any active guide step card when the next step begins
          setGuideStep(null);
          setAskUserPrompt(null);
          // Track synthesize step index for auto-expand on all_done
          if (data.skill === 'synthesize') {
            synthStepIndexRef.current = stepIdx;
          }
          // If recovery just patched and retried (AUTO_PATCH), clear the orange banner — we're executing again
          if (phaseRef.current === 'retrying_with_fix') setPhase('executing');
          agentStepStartTimes.current.set(stepIdx, Date.now());
          setSteps(prev => prev.map(s =>
            s.index === stepIdx
              ? { ...s, 
                  // CRITICAL FIX: Don't overwrite if already in terminal state
                  status: (s.status === 'done' || s.status === 'failed' || s.status === 'skipped')
                    ? s.status  // Keep existing terminal status
                    : 'running',
                  description: data.description || s.description, 
                  runGroup: data.runGroup || s.runGroup 
                }
              : s
          ));
          // Scroll the active step into view
          setTimeout(() => {
            const el = stepRefs.current.get(data.stepIndex + stepOffsetRef.current);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }, 60);
          break;
        }

        case 'step_thinking': {
          const _thinkIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setStepThinking(prev => {
            const next = new Map(prev);
            next.set(_thinkIdx, data.thinking || '');
            return next;
          });
          break;
        }

        case 'skill:thinking': {
          // Universal skill thinking phase - displayed for ALL skills
          const _thinkIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setStepThinking(prev => {
            const next = new Map(prev);
            next.set(_thinkIdx, data.thinking || '');
            return next;
          });
          setHeartbeatTick(t => t + 1); // Force re-render to show thinking immediately
          break;
        }

        case 'step_replanning': {
          // Single-step replan in progress - show visual feedback
          const _replanIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setSteps(prev => prev.map(s =>
            s.index === _replanIdx
              ? { ...s, status: 'replanning' as const, replanMessage: data.message || 'Replanning step...' }
              : s
          ));
          setHeartbeatTick(t => t + 1); // Force re-render
          break;
        }

        case 'step_output': {
          const _outIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setStepLiveOutput(prev => {
            const next = new Map(prev);
            next.set(_outIdx, (prev.get(_outIdx) || '') + (data.text || ''));
            return next;
          });
          break;
        }

        case 'step_sudo_required': {
          const _sudoIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setStepSudoWarning(prev => new Set([...prev, _sudoIdx]));
          break;
        }

        case 'step_done': {
          const stepIdx = data.stepIndex + stepOffsetRef.current;
          // Log all step_done events for debugging
          console.log(`[AutomationProgress] step_done: stepIdx=${stepIdx}, data.stepIndex=${data.stepIndex}, stepOffset=${stepOffsetRef.current}, runGroup=${data.runGroup || 'none'}, skill=${data.skill}`);
          agentStepStartTimes.current.delete(stepIdx);
          setStepThinking(prev => { const next = new Map(prev); next.delete(stepIdx); return next; });
          setSteps(prev => {
            const updated = prev.map(s =>
              s.index === stepIdx
                ? { ...s, 
                    // CRITICAL FIX: Don't overwrite if already in terminal state
                    status: (s.status === 'done' || s.status === 'failed' || s.status === 'skipped')
                      ? s.status  // Keep existing terminal status
                      : 'done' as const,
                    description: data.description || s.description, 
                    stdout: data.stdout, 
                    exitCode: data.exitCode, 
                    savedFilePath: data.savedFilePath || undefined, 
                    guideInstruction: data.instruction || s.guideInstruction, 
                    runGroup: data.runGroup || s.runGroup 
                  }
                : s
            );
            // Log the actual status change
            const updatedStep = updated.find(s => s.index === stepIdx);
            if (updatedStep) {
              console.log(`[AutomationProgress] step_done: Updated step ${stepIdx} status to '${updatedStep.status}'`);
            } else {
              console.warn(`[AutomationProgress] step_done: Step ${stepIdx} not found in steps array`);
            }
            return updated;
          });
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
        }

        case 'step_skipped':
          agentStepStartTimes.current.delete(data.stepIndex + stepOffsetRef.current);
          setSteps(prev => prev.map(s =>
            s.index === data.stepIndex + stepOffsetRef.current
              ? { ...s, status: 'skipped', stdout: data.reason ? `[Skipped: ${data.reason}]` : '[Skipped]' }
              : s
          ));
          break;

        case 'step_failed': {
          const stepIdx = data.stepIndex + stepOffsetRef.current;
          console.log(`[AutomationProgress] step_failed: stepIdx=${stepIdx}, stepOffset=${stepOffsetRef.current}, data.stepIndex=${data.stepIndex}, runGroup=${data.runGroup || 'none'}, error="${(data.error || '').slice(0, 100)}"`);
          agentStepStartTimes.current.delete(stepIdx);
          setStepThinking(prev => { const next = new Map(prev); next.delete(stepIdx); return next; });
          setSteps(prev => {
            const stepExists = prev.some(s => s.index === stepIdx);
            if (!stepExists) {
              console.warn(`[AutomationProgress] step_failed: step not found at index ${stepIdx}`, prev.map(s => ({ index: s.index, status: s.status, skill: s.skill })));
            }
            return prev.map(s =>
              s.index === stepIdx
                ? { ...s, status: 'failed', error: data.error, stderr: data.stderr,
                    userAllowlistHint: data.userAllowlistHint || false,
                    commandName: data.commandName || null,
                    runGroup: data.runGroup || s.runGroup }
                : s
            );
          });
          break;
        }

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
            sessionId: data.sessionId || '',
          });
          // Show manual "I have signed in" button after 5s delay
          setManualAuthBtnVisible(false);
          setTimeout(() => setManualAuthBtnVisible(true), 5000);
          break;
        }

        case 'task:auth_required': {
          // Login wall detected during task execution — show prominent auth overlay card
          const stepIdx = steps.findIndex(s => s.status === 'running');
          const displayIdx = stepIdx >= 0 ? stepIdx : (data.stepIndex ?? 0) + stepOffsetRef.current;
          setTaskAuthOverlay({
            stepIndex: displayIdx,
            serviceDisplay: data.serviceDisplay || '',
            loginUrl: data.loginUrl || '',
            agentId: data.agentId || '',
            message: data.message || '',
          });
          // Also clear the simpler loginGuidance if it was showing
          setLoginGuidance(null);
          setManualAuthBtnVisible(false);
          break;
        }

        case 'task:auth_resolved': {
          // Auth succeeded — dismiss the overlay
          setTaskAuthOverlay(null);
          break;
        }

        case 'agent:turn_live': {
          // Real-time turn update from cli.agent during execution (before agent:complete fires)
          const stepIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          agentLiveTurns.current.set(stepIdx, {
            turn: data.turn,
            maxTurns: data.maxTurns,
            currentAction: data.currentAction ?? null,
            agentId: data.agentId ?? null,
            thinking: data.thinking ?? null,
          });
          setHeartbeatTick(t => t + 1); // force re-render to show updated label
          break;
        }

        case 'agent:turn': {
          const stepIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setAgentTurns(prev => {
            const next = new Map(prev);
            const existing = next.get(stepIdx) || [];
            next.set(stepIdx, [...existing, {
              turn:        data.turn,
              maxTurns:    data.maxTurns,
              action:      data.action,
              outcome:     data.outcome,
              observation: data.observation,
              thoughts:    data.thoughts,
            }]);
            return next;
          });
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
          setHeartbeatTick(t => t + 1); // force re-render so live thought text appears immediately
          break;
        }

        case 'agent:thinking': {
          // Agent reasoning/thinking phase - displayed in real-time for user insight
          const stepIdx = (data.stepIndex ?? 0) + stepOffsetRef.current;
          setAgentThoughts(prev => {
            const next = new Map(prev);
            const existing = next.get(stepIdx) || [];
            // Add the thinking text with a prefix to distinguish it
            const thoughtText = `[${data.agent || 'Agent'}] ${String(data.thought || data.thoughts || '')}`;
            next.set(stepIdx, [...existing, thoughtText]);
            return next;
          });
          setHeartbeatTick(t => t + 1); // force re-render so thinking appears immediately
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

        case 'ask_user': {
          setPhase('ask_user');
          // Mark only the asking step as needs_input (amber "?"); parallel siblings keep running.
          // When no stepIndex is provided (global pause), pause running steps as needs_input — never 'failed'.
          const askIdx = data.stepIndex != null ? data.stepIndex + stepOffsetRef.current : null;
          setAskUserPrompt({ question: data.question, options: data.options || [], agentId: data.agentId || null, freeText: data.freeText || (data.options || []).length === 0, stepIndex: askIdx });
          setSteps(prev => prev.map(s => {
            if (askIdx != null) {
              return s.index === askIdx && s.status !== 'done' && s.status !== 'failed' && s.status !== 'skipped'
                ? { ...s, status: 'needs_input' as const }
                : s;
            }
            return s.status === 'running' ? { ...s, status: 'needs_input' as const } : s;
          }));
          onAskUserShown?.();
          break;
        }

        case 'parallel_login_required':
        case 'parallel_login_start':
          setParallelLoginServices(data.services || []);
          setParallelLoginDecisions({});
          setParallelLoginCountdown(data.timeoutSeconds || 180);
          break;

        case 'parallel_login_progress':
          // Update countdown from main process progress callback
          if (data.remainingSeconds !== undefined) {
            setParallelLoginCountdown(data.remainingSeconds);
          }
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

        case 'gather_auth_action':
          setPhase('gathering');
          setGatherAuthAction({
            question: data.question || '',
            agentId: data.agentId || '',
            agentType: data.agentType || 'browser',
            authType: data.authType || 'browser_oauth',
            iconUrl: data.iconUrl || null,
            startUrl: data.startUrl || null,
            actions: data.actions || [],
          });
          setGatherAuthConnecting(false);
          setGatherAuthBrowserOpened(false);
          break;

        case 'browser:auth_opened':
          // Browser opened for sign-in — swap card to confirmation phase
          setGatherAuthConnecting(false);
          setGatherAuthBrowserOpened(true);
          // Also update preflight auth card if active
          if (preflightAuthRequiredRef.current) {
            setPreflightAuthBrowserOpened(true);
          }
          break;

        case 'preflight:auth_background_failed':
          // Background auth probe returned failure/inconclusive — show retry/continue
          if (preflightAuthRequiredRef.current?.agentId === data.agentId) {
            setPreflightAuthBackgroundFailed(true);
            onAuthPending?.(false);
          }
          break;

        case 'gather_start':
          setPhase('gathering');
          setGatherCredential(null);
          setGatherConfirm(null);
          setGatherOAuth(null);
          setGatherOAuthConnecting(false);
          setGatherAuthAction(null);
          setGatherAuthConnecting(false);
          setGatherAuthBrowserOpened(false);
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
          setGatherAuthAction(null);
          setGatherAuthConnecting(false);
          setGatherAuthBrowserOpened(false);
          setAskUserPrompt(null);
          setPhase('executing');
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

        case 'preflight:vet_script_review':
          setVetScriptReview({
            scriptContent: data.scriptContent || '',
            scriptUrl: data.scriptUrl || '',
            message: data.message || 'Please review the install script.',
          });
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
          // Don't override recovery phase - keep showing retrying_with_fix banner
          // if we're already in recovery flow. Evaluating happens during recovery.
          if (phaseRef.current !== 'retrying_with_fix') {
            setPhase('evaluating');
          }
          setEvalMessage(data.message || 'Evaluating result quality...');
          break;

        case 'retrying_with_fix':
          // Don't pull phase back out of 'done' — recovery events that arrive after
          // all_done (e.g. reviewExecution firing on a schedule result) must not un-resolve the UI.
          if (phaseRef.current === 'done') break;
          setExpandedSteps(new Set());
          setFailureAnswer(null);
          setPhase('retrying_with_fix');
          setRetryMessage(data.message || 'Adjusting approach and retrying...');
          if (data.ruleText) {
            setSavedContextRule({ ruleText: data.ruleText, contextKey: data.contextKey || '', category: data.category || 'general' });
          }
          // Reset steps for the new plan run
          setSteps([]);
          setTotalCount(0);
          break;

        case 'recovering':
          // Don't pull phase back out of 'done' — same guard as retrying_with_fix.
          if (phaseRef.current === 'done') break;
          setPhase('retrying_with_fix');
          setRetryMessage(
            data.description ||
            `Attempt ${data.attempt || ''}: recovering from ${data.skill || 'step'} failure — analyzing options...`
          );
          break;

        case 'recovery:analyzing':
          // Granular recovery event - analyzing the failure
          if (phaseRef.current !== 'retrying_with_fix' && phaseRef.current !== 'done') {
            setPhase('retrying_with_fix');
          }
          if (phaseRef.current !== 'done') setRetryMessage(data.message || `Analyzing ${data.skill || 'step'} failure...`);
          break;

        case 'recovery:category_detected':
          // Recovery category determined (PATH, TOOL_SUB, EXEC_MODE, etc.)
          if (phaseRef.current !== 'retrying_with_fix' && phaseRef.current !== 'done') {
            setPhase('retrying_with_fix');
          }
          if (phaseRef.current !== 'done') setRetryMessage(`Recovery strategy: ${data.category || 'analyzing'} — ${data.message || ''}`);
          break;

        case 'recovery:mode_switch':
          // Execution mode switching (bash → python)
          if (phaseRef.current !== 'retrying_with_fix' && phaseRef.current !== 'done') {
            setPhase('retrying_with_fix');
          }
          if (phaseRef.current !== 'done') setRetryMessage(`Switching from ${data.fromMode || 'bash'} to ${data.toMode || 'python3'}...`);
          break;

        case 'schedule_registered': {
          // Schedule step completed — reminder registered. The all_done event fires
          // immediately after this and resolves the spinner via phase='done'.
          // doneCount is derived from steps state (no setter) — no action needed here.
          break;
        }

        case 'pipeline:done': {
          // Marks the end of a single StateGraph execution cycle.
          // The output contract is available in data.contract for inspection / logging.
          // UI state transitions are driven by all_done / plan:step_done events — no action here.
          break;
        }

        case 'all_done': {
          // Don't let all_done collapse an active plan review (awaitingPlanApproval path)
          if (phaseRef.current === 'plan_review') break;
          if (data.cancelled) {
            setPreflightAuthRequired(null);
            setPreflightAuthBrowserOpened(false);
            setPreflightAuthBackgroundFailed(false);
            setPreflightRouteChoice(null);
          }
          setGuideStep(null);
          setParallelLoginServices(null);
          setParallelLoginDecisions({});
          setLoginGuidance(null);
          setManualAuthBtnVisible(false);
          // Record actual elapsed and replace ETA with it
          if (executionStartRef.current) {
            const elapsed = Math.round((Date.now() - executionStartRef.current) / 1000);
            setElapsedLabel(`${elapsed}s`);
            setEtaLabel(null);
          }
          setPhase('done');
          setTotalCount(prev => Math.max(prev, (data.totalCount || 0) + stepOffsetRef.current));
          // Trigger name-a-plan card if 2+ steps all succeeded
          if (Array.isArray(data.skillResults) && data.skillResults.length >= 2 && data.skillResults.every((r: any) => r.ok || r.skipped)) {
            const _pf = data.planFile || '';
            _planFileRef.current = _pf;
            const _suggested = derivePlanName(planReview?.title || '');
            setPlanNameInput(_suggested);
            setPlanNameSaved(false);
            setPlanNameError('');
            setShowNamePlan(true);
          }
          // Merge any final stdout from skillResults into steps.
          // Also backfill savedFilePath onto the step that wrote it so the
          // inline file link appears on the step row (shell.run write steps
          // don't emit savedFilePath in step_done — only synthesize does).
          //
          // IMPORTANT: After multiple replan cycles the steps array accumulates
          // rows from every plan_ready. skillResults only contains the FINAL plan's
          // results. We match by step index within the final plan's offset window
          // (stepOffsetRef.current) rather than raw array position so stale rows
          // from dead replan cycles don't get mismatched results. Any step outside
          // the final plan's window that is still red (failed) is downgraded to
          // 'skipped' (grey) so the UI reflects that the task ultimately succeeded.
          if (Array.isArray(data.skillResults)) {
            const filePaths: string[] = Array.isArray(data.savedFilePaths) ? data.savedFilePaths : [];
            const finalOffset = stepOffsetRef.current;
            const finalCount = data.skillResults.length;
            // Steps the backend tagged as deferred (run when reminder fires)
            const deferredIndices: number[] = Array.isArray(data.deferredStepIndices)
              ? data.deferredStepIndices.map((i: number) => i + finalOffset)
              : [];
            setSteps(prev => prev.map((s) => {
              // Mark deferred steps with their own status
              if (deferredIndices.includes(s.index) && (s.status === 'pending' || s.status === 'running')) {
                return { ...s, status: 'deferred' as StepStatus };
              }
              // Compute position within the final plan window
              const posInFinal = s.index - finalOffset;
              const r = (posInFinal >= 0 && posInFinal < finalCount) ? data.skillResults[posInFinal] : null;
              if (!r) {
                // Step is from a prior (abandoned) replan cycle — don't leave it red.
                // Only downgrade steps BEFORE the current plan window (posInFinal < 0).
                // Steps AFTER the window (posInFinal >= finalCount) may be genuine
                // failures from the original parallel execution and should stay failed.
                if (s.status === 'failed' && posInFinal < 0) return { ...s, status: 'skipped' as StepStatus };
                return s;
              }
              // Find a savedFilePath that this step wrote by matching against its resolved args script
              let stepFilePath = s.savedFilePath;
              if (!stepFilePath && r.skill === 'shell.run' && filePaths.length > 0) {
                const script = (r.args?.argv || []).find((a: any) => typeof a === 'string') || '';
                stepFilePath = filePaths.find(fp => script.includes(fp) || script.includes(fp.replace(/^\/Users\/[^/]+/, '~')));
              }
              return {
                ...s,
                status: r.skipped ? 'skipped' : r.ok ? 'done' : 'failed',
                stdout: r.stdout || s.stdout,
                stderr: r.stderr || s.stderr,
                error: r.error || s.error,
                exitCode: r.exitCode ?? s.exitCode,
                savedFilePath: stepFilePath || s.savedFilePath,
              };
            }));
          }
          // Auto-expand synthesize and surface failure explanation on terminal states only.
          // Uses synthStepIndexRef (set on step_start for synthesize) to avoid calling
          // setExpandedSteps inside a setSteps updater, which causes React batching races.
          {
            const allSuccess = Array.isArray(data.skillResults) && data.skillResults.length > 0 && data.skillResults.every((r: any) => r.ok || r.skipped);
            const hasAnyFailed = Array.isArray(data.skillResults) && data.skillResults.some((r: any) => !r.ok && !r.skipped);
            const answerText = typeof data.answer === 'string' ? data.answer.trim() : '';
            const synthIdx = synthStepIndexRef.current;
            if (synthIdx !== null && (allSuccess || hasAnyFailed)) {
              setExpandedSteps(e => { const n = new Set(e); n.add(synthIdx); return n; });
            }
            if (hasAnyFailed && answerText) {
              setFailureAnswer(answerText);
            }
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
          const _planGenSteps: Step[] = _planStepTitles.map((title, i) => ({ index: i, skill: inferSkillFromDescription(title), description: title, status: 'pending' as StepStatus }));
          setSteps(_planGenSteps.map(s => ({ ...s, skill: '' })));
          const _planGenEta = estimateEta(_planGenSteps);
          setEtaLabel(formatEta(_planGenEta.lo, _planGenEta.hi));
          setElapsedLabel(null);
          executionStartRef.current = null;
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
          const _existingSteps: Step[] = _existingStepTitles.map((title, i) => ({ index: i, skill: inferSkillFromDescription(title), description: title, status: 'pending' as StepStatus }));
          setSteps(_existingSteps.map(s => ({ ...s, skill: '' })));
          const _existingEta = estimateEta(_existingSteps);
          setEtaLabel(formatEta(_existingEta.lo, _existingEta.hi));
          setElapsedLabel(null);
          executionStartRef.current = null;
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
                ? { ...s, 
                    // CRITICAL FIX: Don't overwrite if already in terminal state
                    status: (s.status === 'done' || s.status === 'failed' || s.status === 'skipped')
                      ? s.status  // Keep existing terminal status
                      : 'running',
                    skill: data.skill || s.skill, 
                    description: data.description || data.title || s.description 
                  }
                : s
              );
            }
            // Dynamically add if not pre-populated
            const total = data.totalSteps ?? prev.length + 1;
            const base: Step[] = prev.length < total
              ? Array.from({ length: total }, (_, i) => prev[i] ?? { index: i, skill: '', description: `Step ${i + 1}`, status: 'pending' as StepStatus })
              : prev;
            return base.map(s => s.index === _psIdx
              ? { ...s, 
                  // CRITICAL FIX: Don't overwrite if already in terminal state
                  status: (s.status === 'done' || s.status === 'failed' || s.status === 'skipped')
                    ? s.status  // Keep existing terminal status
                    : 'running',
                  skill: data.skill || s.skill, 
                  description: data.description || data.title || s.description 
                }
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

        case 'plan:name_saved':
          if (data.ok) {
            setPlanNameSaved(true);
          } else {
            setPlanNameError(data.error || 'Save failed');
          }
          break;
      }
    };

    // Capture streaming synthesis answer chunks
    const handleBridgeMessage = (message: any) => {
      if (!message) return;
      if (message.type === 'chunk' || message.type === 'llm_stream_chunk') {
        const text = message?.text || message.payload?.text || '';
        if (text) setSynthesisAnswer(prev => prev + text);
      }
    };

    const handleControlModeChange = (data: any) => {
      setControlMode({ active: !!data.active, app: data.app || null });
    };

    const handlePlanApproved = () => {
      setPlanReview(null);
      setPhase('executing');
    };

    const AP_TOKEN = 'automation-progress';
    ipcRenderer.on('unified:set-prompt', handleNewPrompt, AP_TOKEN);
    ipcRenderer.on('queue:enqueued', handleNewPrompt, AP_TOKEN);
    ipcRenderer.on('scan:progress', handleScanProgress, AP_TOKEN);
    ipcRenderer.on('scan:discovery', handleScanDiscovery, AP_TOKEN);
    ipcRenderer.on('automation:progress', handleProgress, AP_TOKEN);
    ipcRenderer.on('ws-bridge:message', handleBridgeMessage, AP_TOKEN);
    ipcRenderer.on('app-control:mode-change', handleControlModeChange, AP_TOKEN);
    ipcRenderer.on('plan:approved', handlePlanApproved, AP_TOKEN);
    return () => {
      active = false;
      ipcRenderer.removeListenerByToken('automation:progress', AP_TOKEN);
      ipcRenderer.removeListenerByToken('unified:set-prompt', AP_TOKEN);
      ipcRenderer.removeListenerByToken('queue:enqueued', AP_TOKEN);
      ipcRenderer.removeListenerByToken('ws-bridge:message', AP_TOKEN);
      ipcRenderer.removeListenerByToken('app-control:mode-change', AP_TOKEN);
      ipcRenderer.removeListenerByToken('plan:approved', AP_TOKEN);
      ipcRenderer.removeListenerByToken('scan:progress', AP_TOKEN);
      ipcRenderer.removeListenerByToken('scan:discovery', AP_TOKEN);
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

  const handleGatherAuthAction = (actionValue: string, agentId: string, _agentType: string) => {
    if (actionValue === 'auth_browser') {
      setGatherAuthConnecting(true);
      ipcRenderer?.send('browser.agent:auth', { agentId });
    } else if (actionValue === 'open_agents_tab') {
      ipcRenderer?.send('preflight:open-agents-tab', { agentId });
      // Keep card visible — user will complete auth in agents tab then confirm
    } else if (actionValue === 'agents_tab_done') {
      setGatherAuthAction(null);
      setGatherAuthConnecting(false);
      ipcRenderer?.send('gather:answer', { answer: 'authenticated' });
    } else {
      // 'use_api' or any other answer
      setGatherAuthAction(null);
      setGatherAuthConnecting(false);
      ipcRenderer?.send('gather:answer', { answer: actionValue });
    }
  };

  const handleOptionClick = (option: string | { label?: string; value?: string }) => {
    const _label = typeof option === 'string' ? option : (option?.label || String(option));
    const _value = typeof option === 'string' ? option : (option?.value || _label);
    setAskUserPrompt(null);
    if (_value === 'open_agents_training') {
      const _agentId = askUserPrompt?.agentId || null;
      ipcRenderer?.send('agents:open-training', { agentId: _agentId });
      return;
    }
    // Answer submitted — flip paused steps back to running spinners while the agent resumes
    const blockedStepIndex = askUserPrompt?.stepIndex;
    setSteps(prev => prev.map(s => s.status === 'needs_input' && (blockedStepIndex == null || s.index === blockedStepIndex) ? { ...s, status: 'running' as const } : s));
    ipcRenderer?.send('prompt-queue:submit', { prompt: _value, selectedText: '', isAskUserAnswer: true });
  };

  const handleAskUserFreeTextSubmit = () => {
    const _val = askUserFreeText.trim();
    if (!_val) return;
    setAskUserPrompt(null);
    setAskUserFreeText('');
    // Answer submitted — flip paused steps back to running spinners while the agent resumes
    const blockedStepIndex = askUserPrompt?.stepIndex;
    setSteps(prev => prev.map(s => s.status === 'needs_input' && (blockedStepIndex == null || s.index === blockedStepIndex) ? { ...s, status: 'running' as const } : s));
    ipcRenderer?.send('prompt-queue:submit', { prompt: _val, selectedText: '', isAskUserAnswer: true });
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
    // Optimistic UI: transition immediately without waiting for plan:approved IPC echo
    setPlanReview(null);
    setPhase('executing');
    // Set isSubmitting to show cancel button
    setIsSubmitting?.(true);
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
    s.status === 'done' || s.status === 'skipped' ||
    (s.status !== 'failed' && s.status !== 'deferred' && agentCompletes.get(s.index)?.ok === true)
  ).length;
  const shownTotal = totalCount || steps.length;

  if (suppressIfScheduled) return null;

  if (phase === 'idle' && !controlMode.active && !maintenanceScan && !scanDiscovery && !preflightAuthRequired) return null;

  return (
    <div ref={rootCallbackRef} className="space-y-3">
      <style>{`
        @keyframes agentGloss {
          0% { background-position: -200% center; }
          100% { background-position: 200% center; }
        }
        @keyframes scanPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes pulse {
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
        {phase === 'preflight' && (
          <>
            <div className="w-3.5 h-3.5 rounded-full border-2 animate-spin flex-shrink-0"
              style={{ borderColor: '#22d3ee', borderTopColor: 'transparent' }} />
            <span className="text-sm font-medium" style={{ color: '#22d3ee' }}>
              {preflightMessage}
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
              {allDone && (
                <div className="flex-shrink-0 w-3.5 h-3.5 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: '#22c55e' }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"
                    strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
              )}
              <span className="text-sm font-medium" style={{ color: allDone ? '#34d399' : '#e5e7eb' }}>
                {doneCount} / {shownTotal} tasks done
              </span>
              {!allDone && etaLabel && (
                <span className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                  style={{ backgroundColor: 'rgba(107,114,128,0.12)', color: '#9ca3af', border: '1px solid rgba(107,114,128,0.2)' }}>
                  {etaLabel}
                </span>
              )}
              {allDone && elapsedLabel && (
                <span className="text-xs px-1.5 py-0.5 rounded-full font-medium"
                  style={{ backgroundColor: 'rgba(34,197,94,0.08)', color: '#86efac', border: '1px solid rgba(34,197,94,0.15)' }}>
                  {elapsedLabel}
                </span>
              )}
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
            {etaLabel && (
              <div className="flex items-center gap-2 mt-2" style={{ padding: '6px 10px', borderRadius: 7, backgroundColor: 'rgba(96,165,250,0.07)', border: '1px solid rgba(96,165,250,0.15)' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10"/>
                  <polyline points="12 6 12 12 16 14"/>
                </svg>
                <span style={{ fontSize: '0.75rem', color: '#9ca3af', fontWeight: 500 }}>Est. completion</span>
                <span style={{ fontSize: '0.78rem', color: '#e5e7eb', fontWeight: 600, marginLeft: 2 }}>{etaLabel}</span>
              </div>
            )}
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

      {/* ── Parallel login wall card ─────────────────────────────────────── */}
      {parallelLoginServices && parallelLoginServices.length > 0 && (
        <div style={{
          padding: '12px 14px',
          borderRadius: 10,
          backgroundColor: '#120e1a',
          border: '1px solid #7c3aed',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}>
          {/* Header */}
          <div className="flex items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <div>
              <div style={{ color: '#c4b5fd', fontSize: '0.75rem', fontWeight: 700 }}>
                Login required — {parallelLoginServices.length} service{parallelLoginServices.length > 1 ? 's' : ''}
              </div>
              <div style={{ color: '#71717a', fontSize: '0.68rem', marginTop: 1 }}>
                Auto-skipping in {Math.floor(parallelLoginCountdown / 60)}:{String(parallelLoginCountdown % 60).padStart(2, '0')} — Choose how to handle each service, then click Continue.
              </div>
            </div>
          </div>

          {/* Per-service rows */}
          {parallelLoginServices.map(svc => {
            const decision = parallelLoginDecisions[svc.agentId] || null;
            const serviceName = svc.service.charAt(0).toUpperCase() + svc.service.slice(1).replace(/_/g, ' ');
            return (
              <div key={svc.agentId} style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px',
                borderRadius: 8,
                backgroundColor: 'rgba(124,58,237,0.08)',
                border: `1px solid ${decision ? 'rgba(124,58,237,0.4)' : 'rgba(124,58,237,0.2)'}`,
                flexWrap: 'wrap',
              }}>
                {/* Service name */}
                <div style={{ color: '#e2e2e2', fontSize: '0.75rem', fontWeight: 600, minWidth: 80, flex: '1 1 80px' }}>
                  {serviceName}
                </div>

                {/* Decision buttons */}
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {(['login', 'try_without', 'skip'] as ParallelLoginDecision[]).map(opt => {
                    const labels: Record<ParallelLoginDecision, string> = {
                      login: 'Log in / Create account',
                      try_without: 'Try without logging in',
                      skip: 'Skip',
                    };
                    const colors: Record<ParallelLoginDecision, { bg: string; border: string; text: string }> = {
                      login:       { bg: 'rgba(124,58,237,0.25)', border: '#7c3aed', text: '#c4b5fd' },
                      try_without: { bg: 'rgba(59,130,246,0.15)', border: '#3b82f6', text: '#93c5fd' },
                      skip:        { bg: 'rgba(113,113,122,0.15)', border: '#52525b', text: '#a1a1aa' },
                    };
                    const c = colors[opt];
                    const isSelected = decision === opt;
                    return (
                      <button
                        key={opt}
                        onClick={() => setParallelLoginDecisions(prev => ({ ...prev, [svc.agentId]: opt }))}
                        style={{
                          fontSize: '0.68rem',
                          fontWeight: isSelected ? 700 : 500,
                          padding: '3px 8px',
                          borderRadius: 5,
                          border: `1px solid ${isSelected ? c.border : 'rgba(113,113,122,0.3)'}`,
                          backgroundColor: isSelected ? c.bg : 'transparent',
                          color: isSelected ? c.text : '#71717a',
                          cursor: 'pointer',
                          transition: 'all 0.12s',
                          outline: 'none',
                        }}
                      >
                        {labels[opt]}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}

          {/* Continue button */}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              disabled={parallelLoginServices.some(s => !parallelLoginDecisions[s.agentId])}
              onClick={() => {
                const decisions = { ...parallelLoginDecisions };
                // Default any undecided to 'skip'
                parallelLoginServices.forEach(s => { if (!decisions[s.agentId]) decisions[s.agentId] = 'skip'; });
                ipcRenderer?.send('parallel:login:decision', decisions);
                setParallelLoginServices(null);
                setParallelLoginDecisions({});
                setParallelLoginCountdown(180);
              }}
              style={{
                fontSize: '0.72rem',
                fontWeight: 600,
                padding: '5px 14px',
                borderRadius: 6,
                border: '1px solid #7c3aed',
                backgroundColor: parallelLoginServices.some(s => !parallelLoginDecisions[s.agentId])
                  ? 'rgba(124,58,237,0.1)' : 'rgba(124,58,237,0.3)',
                color: parallelLoginServices.some(s => !parallelLoginDecisions[s.agentId])
                  ? '#6d28d9' : '#c4b5fd',
                cursor: parallelLoginServices.some(s => !parallelLoginDecisions[s.agentId]) ? 'not-allowed' : 'pointer',
                transition: 'all 0.12s',
                outline: 'none',
              }}
            >
              Continue →
            </button>
          </div>
        </div>
      )}

      {/* ── Action required banner (ask_user) ───────────────────────────── */}
      {phase === 'ask_user' && (
        <div style={{ padding: '10px 14px', borderRadius: 10, backgroundColor: '#1a120a', border: '1px solid #d97706', position: 'sticky', top: 0, zIndex: 10 }}>
          <div className="flex items-center gap-2.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div>
              <div style={{ color: '#fbbf24', fontSize: '0.75rem', fontWeight: 600 }}>
                Action required
              </div>
              <div style={{ color: '#a3a3a3', fontSize: '0.68rem', marginTop: 2 }}>
                ThinkDrop couldn't complete this step automatically. Choose an option below.
              </div>
            </div>
          </div>
        </div>
      )}

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

      {/* ── Context rule saved toast ────────────────────────────────── */}
      {savedContextRule && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          backgroundColor: 'rgba(245, 158, 11, 0.08)',
          border: '1px solid rgba(245, 158, 11, 0.35)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div className="flex items-start justify-between gap-2">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
              <div style={{ color: '#fbbf24', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                Rule saved{savedContextRule.contextKey ? ` · ${savedContextRule.contextKey}` : ''}
              </div>
              <div style={{ color: '#e5e7eb', fontSize: '0.75rem', lineHeight: 1.45, wordBreak: 'break-word' }}>
                {savedContextRule.ruleText.length > 140
                  ? savedContextRule.ruleText.slice(0, 140) + '…'
                  : savedContextRule.ruleText}
              </div>
            </div>
            <button
              onClick={() => setSavedContextRule(null)}
              style={{ flexShrink: 0, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', fontSize: '1rem', lineHeight: 1 }}
              title="Dismiss"
            >✕</button>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => { setSavedContextRule(null); onOpenRules?.(); }}
              style={{
                fontSize: '0.7rem', fontWeight: 600, padding: '4px 10px', borderRadius: 6,
                backgroundColor: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(245, 158, 11, 0.4)',
                color: '#fbbf24', cursor: 'pointer',
              }}
            >Edit Rule</button>
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

      {/* ── Gather: Auth action card (browser sign-in / CLI agents tab) ────── */}
      {gatherAuthAction && (
        <div style={{ padding: '14px 16px', borderRadius: 10, backgroundColor: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.35)' }}>
          <div className="flex items-start gap-3">
            {gatherAuthAction.iconUrl ? (
              <img
                src={gatherAuthAction.iconUrl}
                width={28}
                height={28}
                alt={gatherAuthAction.agentId}
                style={{ borderRadius: 6, flexShrink: 0, marginTop: 1 }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <div style={{ width: 28, height: 28, borderRadius: 6, backgroundColor: 'rgba(245,158,11,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginTop: 1, fontSize: '0.9rem' }}>
                🔐
              </div>
            )}
            <div style={{ flex: 1 }}>
              <div style={{ color: '#fbbf24', fontSize: '0.76rem', fontWeight: 600, marginBottom: 4 }}>
                Sign-in required
              </div>
              <div style={{ color: '#d1d5db', fontSize: '0.82rem', lineHeight: 1.4, marginBottom: 12 }}>
                {gatherAuthAction.question}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {gatherAuthAction.agentType === 'browser' ? (
                  // ── Browser agent: two-phase UI ──────────────────────────────
                  gatherAuthBrowserOpened ? (
                    // Phase 2: browser is open — show confirmation + escape hatch
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                        <div className="w-2 h-2 rounded-full animate-pulse flex-shrink-0"
                          style={{ backgroundColor: '#4ade80' }} />
                        <span style={{ color: '#86efac', fontSize: '0.69rem' }}>
                          Browser opened — sign in, then click below
                        </span>
                      </div>
                      <button
                        onClick={() => handleGatherAuthAction('agents_tab_done', gatherAuthAction.agentId, gatherAuthAction.agentType)}
                        style={{
                          padding: '7px 16px', borderRadius: 6, fontSize: '0.74rem', fontWeight: 600, cursor: 'pointer',
                          backgroundColor: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.4)', color: '#4ade80',
                          alignSelf: 'flex-start',
                        }}
                      >
                        ✓ I've signed in — continue
                      </button>
                      <button
                        onClick={() => handleGatherAuthAction('use_api', gatherAuthAction.agentId, gatherAuthAction.agentType)}
                        style={{
                          padding: '5px 12px', borderRadius: 6, fontSize: '0.68rem', fontWeight: 400, cursor: 'pointer',
                          backgroundColor: 'transparent', border: '1px solid rgba(107,114,128,0.25)', color: '#6b7280',
                          alignSelf: 'flex-start',
                        }}
                      >
                        Use a different service
                      </button>
                    </>
                  ) : (
                    // Phase 1: not yet opened — show "Sign in" + escape hatch
                    <>
                      <button
                        onClick={() => handleGatherAuthAction('auth_browser', gatherAuthAction.agentId, gatherAuthAction.agentType)}
                        disabled={gatherAuthConnecting}
                        style={{
                          padding: '7px 14px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 600,
                          cursor: gatherAuthConnecting ? 'wait' : 'pointer',
                          backgroundColor: gatherAuthConnecting ? 'rgba(245,158,11,0.05)' : 'rgba(245,158,11,0.15)',
                          border: '1px solid rgba(245,158,11,0.45)',
                          color: gatherAuthConnecting ? '#78716c' : '#fbbf24',
                          alignSelf: 'flex-start',
                        }}
                      >
                        {gatherAuthConnecting ? 'Opening browser…' : `Sign in to ${gatherAuthAction.agentId.replace('.agent', '')}`}
                      </button>
                      <button
                        onClick={() => handleGatherAuthAction('use_api', gatherAuthAction.agentId, gatherAuthAction.agentType)}
                        style={{
                          padding: '5px 12px', borderRadius: 6, fontSize: '0.68rem', fontWeight: 400, cursor: 'pointer',
                          backgroundColor: 'transparent', border: '1px solid rgba(107,114,128,0.25)', color: '#6b7280',
                          alignSelf: 'flex-start',
                        }}
                      >
                        Use a different service
                      </button>
                    </>
                  )
                ) : (
                  // ── CLI / API-key agent: show Open Agents tab + Done ──────────
                  gatherAuthAction.actions.map((action, i) => (
                    action.value === 'open_agents_tab' ? (
                      <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button
                          onClick={() => handleGatherAuthAction('open_agents_tab', gatherAuthAction.agentId, gatherAuthAction.agentType)}
                          style={{
                            padding: '6px 14px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 600, cursor: 'pointer',
                            backgroundColor: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.45)', color: '#fbbf24',
                          }}
                        >
                          {action.label}
                        </button>
                        <button
                          onClick={() => handleGatherAuthAction('agents_tab_done', gatherAuthAction.agentId, gatherAuthAction.agentType)}
                          style={{
                            padding: '6px 14px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer',
                            backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.3)', color: '#86efac',
                          }}
                        >
                          Done — credentials added
                        </button>
                      </div>
                    ) : (
                      <button
                        key={i}
                        onClick={() => handleGatherAuthAction(action.value, gatherAuthAction.agentId, gatherAuthAction.agentType)}
                        style={{
                          padding: '6px 12px', borderRadius: 6, fontSize: '0.68rem', fontWeight: 400, cursor: 'pointer',
                          backgroundColor: 'transparent', border: '1px solid rgba(107,114,128,0.25)', color: '#6b7280',
                          alignSelf: 'flex-start',
                        }}
                      >
                        {action.label}
                      </button>
                    )
                  ))
                )}
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

      {/* ── Failure explanation card (max-retry exhausted) ──────────────── */}
      {failureAnswer && (
        <div className="px-3 py-2.5 rounded-lg text-xs"
          style={{ backgroundColor: 'rgba(239,68,68,0.07)', borderLeft: '3px solid rgba(239,68,68,0.5)', color: '#fca5a5', lineHeight: 1.55 }}>
          <div style={{ color: '#f87171', fontWeight: 600, marginBottom: 4, fontSize: '0.7rem', letterSpacing: '0.01em' }}>
            What happened
          </div>
          {failureAnswer}
        </div>
      )}

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
        <div className="space-y-2" style={{ overflowX: 'hidden' }}>
          {steps.map((step, stepArrayIdx) => {
            // ── Parallel group bracket helpers ──────────────────────────────
            const prevStep = stepArrayIdx > 0 ? steps[stepArrayIdx - 1] : null;
            const nextStep = stepArrayIdx < steps.length - 1 ? steps[stepArrayIdx + 1] : null;
            const isInGroup = !!step.runGroup;
            const isGroupStart = isInGroup && (!prevStep || prevStep.runGroup !== step.runGroup);
            const isGroupEnd   = isInGroup && (!nextStep || nextStep.runGroup !== step.runGroup);
            // const groupDoneCount = isInGroup ? steps.filter(s => s.runGroup === step.runGroup && (s.status === 'done' || s.status === 'skipped')).length : 0;
            // const groupTotalCount = isInGroup ? steps.filter(s => s.runGroup === step.runGroup).length : 0;
            // const groupAllDone = isInGroup && groupDoneCount === groupTotalCount && groupTotalCount > 0;
            // Show all parallel agents after completion (don't collapse)
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
                {/* ── Parallel group header — shown above first step in group ── */}
                {isGroupStart && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4, paddingLeft: 2 }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#818cf8', flexShrink: 0 }}>
                      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                    </svg>
                    <span style={{ fontSize: '10px', fontWeight: 600, color: '#6366f1', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                      {(() => {
                        // Check if all steps in this group have the same agentId (sequential execution)
                        const groupSteps = steps.filter(s => s.runGroup === step.runGroup);
                        const agentIds = new Set(groupSteps.map(s => s.skill === 'browser.agent' ? s.args?.agentId || s.skill : s.skill));
                        return agentIds.size === 1 ? 'Running sequentially' : 'Running in parallel';
                      })()}
                    </span>
                  </div>
                )}
                {/* Step row — wrapped in bracket container when in group */}
                <div style={isInGroup ? { display: 'flex', alignItems: 'stretch', gap: 0 } : {}}>
                  {/* Left bracket bar */}
                  {isInGroup && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 14, flexShrink: 0, marginRight: 4 }}>
                      <div style={{
                        width: 1,
                        backgroundColor: '#4338ca',
                        flex: 1,
                        opacity: 0.6,
                        borderRadius: isGroupStart ? '2px 2px 0 0' : isGroupEnd ? '0 0 2px 2px' : 0,
                        minHeight: 8,
                      }} />
                      {isGroupEnd && (
                        <svg width="8" height="6" viewBox="0 0 8 6" style={{ flexShrink: 0, color: '#4338ca', opacity: 0.6 }}>
                          <path d="M0 0 L0 6 L8 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                      )}
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
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
                          : step.status === 'skipped' ? '#fbbf24'
                          : step.status === 'needs_input' ? '#fbbf24'
                          : step.status === 'deferred' ? '#6b7280'
                          : '#e5e7eb',
                        textDecoration: step.status === 'deferred' ? 'line-through' : undefined,
                        opacity: step.status === 'deferred' ? 0.6 : undefined,
                      }}>
                        {step.runGroup
                          ? `Step ${step.index + 1}: ${step.description?.split(' — ')[0]?.slice(0, 60) || step.description?.slice(0, 60) || step.skill}`
                          : step.description}
                      </span>
                      {/* Hide browser.agent badge in parallel runs — we show agent name inline instead */}
                      {!(step.runGroup && step.skill === 'browser.agent') && <SkillBadge skill={step.skill} />}
                      {/* ── Inline agent header — shown right after badge, live and done ── */}
                      {(() => {
                        const liveTurn = agentLiveTurns.current.get(step.index);
                        const complete = agentCompletes.get(step.index);
                        if (!liveTurn && !complete) return null;
                        const agentId = complete ? complete.agentId : liveTurn?.agentId;
                        if (!agentId) return null;
                        if (complete) {
                          return (
                            <>
                              <span style={{ color: '#4b5563', fontSize: '11px' }}>→</span>
                              <button
                                onClick={e => { e.stopPropagation(); setExpandedAgentSteps(prev => { const n = new Set(prev); n.has(step.index) ? n.delete(step.index) : n.add(step.index); return n; }); }}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: '11px', color: '#94a3b8' }}
                              >
                                <AgentFavicon agentId={complete.agentId} />
                                <span style={{ fontWeight: 600, color: '#818cf8' }}>{complete.agentId}</span>
                                <span>·</span>
                                <span>{complete.totalTurns} step{complete.totalTurns !== 1 ? 's' : ''}</span>
                                <span>·</span>
                                <span style={{ color: complete.ok ? '#34d399' : '#f87171' }}>{complete.ok ? '✓ done' : '✗ failed'}</span>
                                <span style={{ fontSize: '9px', marginLeft: 2 }}>{expandedAgentSteps.has(step.index) ? '▲' : '▼'}</span>
                              </button>
                            </>
                          );
                        }
                        return (
                          <>
                            <span style={{ color: '#4b5563', fontSize: '11px' }}>→</span>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '11px', color: '#94a3b8' }}>
                              <AgentFavicon agentId={agentId} />
                              <span style={{ fontWeight: 600, color: '#818cf8' }}>{agentId}</span>
                              {liveTurn && (
                                <><span style={{ color: '#4b5563' }}>·</span>
                                <span style={{ color: '#6b7280' }}>{liveTurn.turn}/{liveTurn.maxTurns} steps</span></>
                              )}
                            </span>
                          </>
                        );
                      })()}
                    </div>
                    {step.status === 'done' && !isExpanded && !agentCompletes.get(step.index) && (() => {
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
                    {/* ── shell.run goal-mode thinking — shown while _resolveGoalToCommand runs ── */}
                    {step.status === 'running' && !!stepThinking.get(step.index) && (
                      <div style={{ marginTop: 3, fontSize: '11px', color: '#7c6fa0', fontStyle: 'italic', lineHeight: '1.45' }}>
                        {stepThinking.get(step.index)}
                      </div>
                    )}
                    {/* ── sudo warning — shown when step needs administrator access ── */}
                    {stepSudoWarning.has(step.index) && (step.status === 'running' || step.status === 'failed') && (
                      <div style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '11px', color: '#fbbf24', background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 5, padding: '3px 8px' }}>
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                        </svg>
                        Requires system password (sudo)
                      </div>
                    )}
                    {/* ── live terminal output — streamed while step is running ── */}
                    {step.status === 'running' && !!stepLiveOutput.get(step.index) && (
                      <div style={{ marginTop: 6 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 3 }}>
                          <span style={{ fontSize: '10px', color: '#6b7280', fontFamily: 'ui-monospace, monospace' }}>terminal output</span>
                          <button
                            onClick={e => { e.stopPropagation(); ipcRenderer?.send('shell:open-terminal', { cwd: process.env.HOME }); }}
                            style={{ fontSize: '10px', color: '#60a5fa', background: 'none', border: '1px solid rgba(96,165,250,0.3)', borderRadius: 4, padding: '1px 6px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
                          >
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>
                            </svg>
                            Open in Terminal
                          </button>
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            padding: '8px 10px',
                            borderRadius: 6,
                            backgroundColor: 'rgba(0,0,0,0.55)',
                            border: '1px solid rgba(255,255,255,0.07)',
                            color: '#86efac',
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: '10.5px',
                            lineHeight: '1.5',
                            maxHeight: '140px',
                            overflowY: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-all',
                          }}
                        >
                          {(stepLiveOutput.get(step.index) || '').slice(-4000)}
                        </pre>
                      </div>
                    )}
                    {step.status === 'skipped' && !isExpanded && (
                      <div className="text-xs mt-0.5" style={{ color: '#fbbf24', opacity: 0.75 }}>
                        {step.stdout?.replace(/^\[Skipped:\s*/i, '').replace(/\]$/, '') || 'Skipped'}
                      </div>
                    )}
                    {step.status === 'deferred' && (
                      <div className="text-xs mt-0.5" style={{ color: '#92400e', opacity: 0.8 }}>
                        Runs when reminder fires
                      </div>
                    )}
                    {step.status === 'failed' && step.error && !isExpanded && (
                      <div className="text-xs mt-0.5" style={{ color: '#f87171' }}>
                        {humanizeError(step.error)}
                      </div>
                    )}
                    {step.status === 'failed' && step.userAllowlistHint && step.commandName && (
                      <button
                        onClick={e => { e.stopPropagation(); handleOptionClick(`Allow "${step.commandName}" and retry`); }}
                        className="mt-1 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors"
                        style={{ backgroundColor: 'rgba(217,119,6,0.15)', border: '1px solid rgba(217,119,6,0.4)', color: '#fbbf24', cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(217,119,6,0.28)')}
                        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'rgba(217,119,6,0.15)')}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>
                        </svg>
                        Allow &ldquo;{step.commandName}&rdquo; and retry
                      </button>
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
                    {manualAuthBtnVisible && loginGuidance.sessionId && (
                      <button
                        onClick={() => {
                          fetch('http://localhost:3007/browser.auth_complete', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ sessionId: loginGuidance.sessionId }),
                          }).catch(() => {});
                          setManualAuthBtnVisible(false);
                        }}
                        style={{
                          marginTop: 8, fontSize: '11px', fontWeight: 600, color: '#fbbf24',
                          background: 'rgba(251,191,36,0.12)', border: '1px solid rgba(251,191,36,0.35)',
                          borderRadius: 6, padding: '6px 12px', cursor: 'pointer',
                        }}
                      >
                        ✓ I have signed in — generate plan
                      </button>
                    )}
                  </div>
                )}
                {/* ── Task auth overlay — prominent lock card when login wall detected during task execution ── */}
                {step.status === 'running' && taskAuthOverlay?.stepIndex === step.index && (
                  <div style={{
                    marginTop: 10, marginLeft: 28, padding: '14px 16px', borderRadius: 10,
                    background: 'linear-gradient(135deg, rgba(251,191,36,0.12) 0%, rgba(245,158,11,0.08) 100%)',
                    border: '1px solid rgba(251,191,36,0.35)',
                    boxShadow: '0 0 16px rgba(251,191,36,0.08)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span style={{
                        fontSize: '18px', lineHeight: 1,
                        animation: 'pulse 2s ease-in-out infinite',
                      }}>🔐</span>
                      <span style={{
                        fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em',
                        color: '#f59e0b', background: 'rgba(245,158,11,0.15)', padding: '2px 8px', borderRadius: 4,
                      }}>Action Required</span>
                    </div>
                    <div style={{ fontSize: '13px', color: '#f9fafb', fontWeight: 600, marginBottom: 6 }}>
                      Sign in to {taskAuthOverlay.serviceDisplay || 'this service'}
                    </div>
                    <div style={{ fontSize: '11px', color: '#d1d5db', lineHeight: 1.6 }}>
                      A browser window is open and waiting. Sign in with Google, Apple, or email — this panel updates automatically once you're in.
                    </div>
                    {taskAuthOverlay.loginUrl && (
                      <div style={{ fontSize: '10px', color: '#6b7280', marginTop: 6 }}>
                        {taskAuthOverlay.loginUrl}
                      </div>
                    )}
                    <div style={{
                      marginTop: 8, display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%', backgroundColor: '#f59e0b',
                        animation: 'pulse 1.5s ease-in-out infinite',
                      }} />
                      <span style={{ fontSize: '10px', color: '#9ca3af', fontStyle: 'italic' }}>
                        Waiting for sign-in…
                      </span>
                    </div>
                  </div>
                )}
                {/* ── Agent sub-card: step rows + live status (header now inline with SkillBadge above) ── */}
                {(() => {
                  const liveTurn = agentLiveTurns.current.get(step.index);
                  const complete = agentCompletes.get(step.index);
                  const isRunning = step.status === 'running' && !complete && loginGuidance?.stepIndex !== step.index;
                  const isDone = !!complete;
                  if (!liveTurn && !isDone) return null;

                  const _actionVerbs: Record<string, string> = {
                    run_cmd: 'running command', run_shell: 'probing',
                    run_help: 'reading help', web_search: 'searching',
                    web_fetch: 'fetching docs', run_update: 'updating CLI',
                  };

                  const isExpanded = expandedAgentSteps.has(step.index);
                  const allSteps = agentTurns.get(step.index) || [];
                  const lastStep = allSteps.length > 0 ? allSteps[allSteps.length - 1] : null;

                  return (
                    <div style={{ marginTop: 3, marginLeft: 28 }}>
                      {/* ── Latest step row — visible when done+collapsed (last result) ── */}
                      {isDone && !isExpanded && lastStep && (() => {
                        const t = lastStep;
                        const isExecAction = t.action?.action === 'run_cmd' || t.action?.action === 'done';
                        const isProbeAction = t.action?.action === 'run_shell' || t.action?.action === 'run_help' || t.action?.action === 'web_search' || t.action?.action === 'web_fetch';
                        const isFailed = isExecAction && t.outcome && !t.outcome.ok;
                        return (
                          <div style={{
                            fontSize: '11px',
                            padding: '2px 0 2px 8px',
                            borderLeft: `2px solid ${isFailed ? 'rgba(248,113,113,0.4)' : isProbeAction ? 'rgba(251,191,36,0.35)' : 'rgba(99,102,241,0.35)'}`,
                            marginTop: 3,
                          }}>
                            <span style={{ color: '#6b7280', marginRight: 6 }}>Step {t.turn}</span>
                            {t.action?.action && (
                              <span style={{
                                color: isFailed ? '#f87171' : isProbeAction ? '#fbbf24' : '#a5b4fc',
                                marginRight: 4, fontFamily: 'ui-monospace,monospace', fontSize: '10px',
                              }}>
                                {formatActionLabel(t.action)}
                              </span>
                            )}
                            {/* HIDE OUTCOME VERBOSE TEXT JUST SHOW IN DRILLDOWN BELOW */}
                            {/* {t.outcome && (
                              <span style={{ color: t.outcome.ok ? '#6ee7b7' : '#fca5a5' }}>
                                {t.outcome.ok
                                  ? (t.outcome.result && t.action?.action !== 'snapshot'
                                      ? `✓ ${t.outcome.result.length > 120 ? t.outcome.result.slice(0, 120) + '…' : t.outcome.result}`
                                      : '✓')
                                  : `✗ ${t.outcome.error || ''}`}
                              </span>
                            )} */}
                          </div>
                        );
                      })()}

                      {/* ── Live step rows while running (playwright.agent emits agent:turn live) ── */}
                      {isRunning && allSteps.length > 0 && (() => {
                        const t = allSteps[allSteps.length - 1];
                        const isExecAction = t.action?.action === 'run_cmd' || t.action?.action === 'done';
                        const isProbeAction = t.action?.action === 'run_shell' || t.action?.action === 'run_help' || t.action?.action === 'web_search' || t.action?.action === 'web_fetch';
                        const isFailed = isExecAction && t.outcome && !t.outcome.ok;
                        return (
                          <div style={{
                            fontSize: '11px',
                            padding: '2px 0 2px 8px',
                            borderLeft: `2px solid ${isFailed ? 'rgba(248,113,113,0.4)' : isProbeAction ? 'rgba(251,191,36,0.35)' : 'rgba(99,102,241,0.35)'}`,
                            marginTop: 3,
                          }}>
                            <span style={{ color: '#6b7280', marginRight: 6 }}>Step {t.turn}</span>
                            {t.action?.action && (
                              <span style={{
                                color: isFailed ? '#f87171' : isProbeAction ? '#fbbf24' : '#a5b4fc',
                                marginRight: 4, fontFamily: 'ui-monospace,monospace', fontSize: '10px',
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
                      })()}

                      {/* ── Live step label while running (heartbeat / cli.agent action verb) ── */}
                      {isRunning && liveTurn && (() => {
                        const startTime = agentStepStartTimes.current.get(step.index);
                        const elapsedMs = startTime ? (Date.now() - startTime) : 0;
                        const _actionVerb = liveTurn.currentAction ? (_actionVerbs[liveTurn.currentAction] ?? null) : null;
                        const liveLabel = _actionVerb || getAgentStatusLabel(elapsedMs);
                        return (
                          <div style={{ marginTop: 3 }}>
                            <span style={{
                              fontSize: '11px',
                              fontStyle: 'italic',
                              display: 'inline-block',
                              background: 'linear-gradient(90deg, #818cf8 30%, #c4b5fd 50%, #818cf8 70%)',
                              backgroundSize: '200% auto',
                              WebkitBackgroundClip: 'text',
                              WebkitTextFillColor: 'transparent',
                              backgroundClip: 'text',
                              animation: 'agentGloss 2s linear infinite',
                            }}>
                              {liveLabel}
                            </span>
                          </div>
                        );
                      })()}

                      {/* ── Fallback heartbeat when no liveTurn yet ── */}
                      {isRunning && !liveTurn && (
                        <div style={{ marginTop: 3 }}>
                          <span style={{
                            fontSize: '11px',
                            fontStyle: 'italic',
                            display: 'inline-block',
                            background: 'linear-gradient(90deg, #818cf8 30%, #c4b5fd 50%, #818cf8 70%)',
                            backgroundSize: '200% auto',
                            WebkitBackgroundClip: 'text',
                            WebkitTextFillColor: 'transparent',
                            backgroundClip: 'text',
                            animation: 'agentGloss 2s linear infinite',
                          }}>
                            {getAgentStatusLabel(agentStepStartTimes.current.get(step.index) ? Date.now() - agentStepStartTimes.current.get(step.index)! : 0)}
                          </span>
                        </div>
                      )}

                      {/* ── Live thinking — cli.agent (liveTurn.thinking) or playwright.agent (agentThoughts) ── */}
                      {isRunning && liveTurn?.thinking && (
                        <div style={{ marginTop: 3, fontSize: '11px', color: '#7c6fa0', fontStyle: 'italic', lineHeight: '1.45' }}>
                          ☁️ {liveTurn.thinking.length > 140 ? liveTurn.thinking.slice(0, 140) + '…' : liveTurn.thinking}
                        </div>
                      )}
                      {isRunning && !liveTurn?.thinking && (agentThoughts.get(step.index) || []).length > 0 && (() => {
                        const thoughts = agentThoughts.get(step.index)!;
                        const latest = thoughts[thoughts.length - 1];
                        return (
                          <div style={{ marginTop: 3, fontSize: '11px', color: '#7c6fa0', fontStyle: 'italic', lineHeight: '1.45' }}>
                            ☁️ {latest.length > 160 ? latest.slice(0, 160) + '…' : latest}
                          </div>
                        );
                      })()}

                      {/* ── Learned rule rows — always visible ── */}
                      {(learnedRules.get(step.index) || []).map((rule, ri) => (
                        <div key={ri} style={{
                          display: 'flex', alignItems: 'flex-start', gap: 5,
                          marginTop: 4, padding: '3px 7px', borderRadius: 4,
                          borderLeft: '2px solid rgba(245,158,11,0.5)',
                          backgroundColor: 'rgba(245,158,11,0.05)',
                        }}>
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

                      {/* ── Expanded step list — all steps, shown when user clicks header (done only) ── */}
                      {isDone && isExpanded && (
                        <div style={{ marginTop: 4 }}>
                          {allSteps.map((t, i) => {
                            const isExecAction = t.action?.action === 'run_cmd' || t.action?.action === 'done';
                            const isProbeAction = t.action?.action === 'run_shell' || t.action?.action === 'run_help' || t.action?.action === 'web_search' || t.action?.action === 'web_fetch';
                            const isFailed = isExecAction && t.outcome && !t.outcome.ok;
                            const observationText = t.observation || '';
                            const thoughtText = t.thoughts || '';
                            return (
                              <div key={i} style={{
                                fontSize: '11px',
                                padding: '2px 0 4px 8px',
                                borderLeft: `2px solid ${isFailed ? 'rgba(248,113,113,0.4)' : isProbeAction ? 'rgba(251,191,36,0.35)' : 'rgba(99,102,241,0.35)'}`,
                                marginBottom: 2,
                              }}>
                                <div>
                                  <span style={{ color: '#6b7280', marginRight: 6 }}>Step {t.turn}</span>
                                  {t.action?.action && (
                                    <span style={{
                                      color: isFailed ? '#f87171' : isProbeAction ? '#fbbf24' : '#a5b4fc',
                                      marginRight: 4, fontFamily: 'ui-monospace,monospace', fontSize: '10px',
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
                                {thoughtText && (
                                  <div style={{
                                    marginTop: 2, fontSize: '10px', color: '#7c6fa0',
                                    fontStyle: 'italic', lineHeight: '1.4',
                                  }}>
                                    ☁️ {thoughtText.length > 140 ? thoughtText.slice(0, 140) + '…' : thoughtText}
                                  </div>
                                )}
                                {observationText && (
                                  <div style={{
                                    marginTop: 2, color: '#64748b', fontSize: '10px',
                                    fontFamily: 'ui-monospace,monospace',
                                    overflow: 'hidden', textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap', maxWidth: '100%',
                                  }} title={observationText}>
                                    ↳ {observationText.length > 120 ? observationText.slice(0, 120) + '…' : observationText}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          {allSteps.length === 0 && complete?.reasoning && (
                            <div style={{
                              fontSize: '11px', color: '#94a3b8',
                              padding: '2px 0 2px 8px',
                              borderLeft: '2px solid rgba(99,102,241,0.3)',
                            }}>
                              {complete!.reasoning}
                            </div>
                          )}
                          {(agentThoughts.get(step.index) || []).map((thought, ti) => (
                            <div key={`thought-${ti}`} style={{
                              fontSize: '11px', color: '#a78bfa', fontStyle: 'italic',
                              padding: '2px 0 2px 8px',
                              borderLeft: '2px solid rgba(167,139,250,0.3)',
                              marginBottom: 2,
                            }}>
                              ☁️ {thought.length > 200 ? thought.slice(0, 200) + '…' : thought}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
                  </div>{/* end flex:1 content wrapper */}
                </div>{/* end isInGroup bracket container */}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Plan review: existing-plan banner + Approve/Cancel bar ────────── */}
      {phase === 'plan_review' && planReview && (
        <div ref={planReviewRef} style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 10, marginTop: 10}}>          {planReview.isExisting && (
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

      {/* ── Name-a-plan card (Part 5) ───────────────────────────────────────── */}
      {phase === 'done' && showNamePlan && !planNameSaved && (
        <div style={{
          marginTop: 12,
          padding: '12px 14px',
          borderRadius: 10,
          backgroundColor: 'rgba(99,102,241,0.07)',
          border: '1px solid rgba(99,102,241,0.25)',
        }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: '#a5b4fc', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>
            </svg>
            Save this plan for later?
          </div>
          <div style={{ fontSize: '0.69rem', color: '#94a3b8', marginBottom: 8 }}>
            Give it a name and recall it anytime by prompt.
          </div>
          <input
            type="text"
            value={planNameInput}
            onChange={e => {
              const v = e.target.value.toLowerCase().replace(/[^a-z0-9.]/g, '');
              setPlanNameInput(v);
              setPlanNameError(!v || isValidDotName(v) ? '' : 'Only dot-syntax allowed: e.g. perplexity.history.vegan');
            }}
            placeholder="e.g. perplexity.history.vegan"
            style={{
              width: '100%',
              padding: '6px 8px',
              borderRadius: 6,
              border: `1px solid ${planNameError ? 'rgba(239,68,68,0.6)' : isValidDotName(planNameInput) ? 'rgba(99,102,241,0.5)' : 'rgba(255,255,255,0.12)'}`,
              backgroundColor: 'rgba(15,15,25,0.6)',
              color: '#e2e8f0',
              fontSize: '0.75rem',
              fontFamily: 'monospace',
              outline: 'none',
              marginBottom: 4,
              boxSizing: 'border-box',
            }}
          />
          {planNameError && (
            <div style={{ fontSize: '0.67rem', color: '#f87171', marginBottom: 6 }}>{planNameError}</div>
          )}
          {planNameInput && isValidDotName(planNameInput) && (
            <div style={{ fontSize: '0.67rem', color: '#6b7280', marginBottom: 8, fontStyle: 'italic' }}>
              Recall later: &ldquo;Run {planNameInput}&rdquo;
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              disabled={!isValidDotName(planNameInput)}
              onClick={() => {
                if (isValidDotName(planNameInput)) {
                  const pf = _planFileRef.current || planReview?.planFile || '';
                  ipcRenderer?.send('plan:save_name', { planFile: pf, planName: planNameInput });
                }
              }}
              style={{
                padding: '5px 14px', borderRadius: 6, fontSize: '0.72rem', fontWeight: 600, cursor: isValidDotName(planNameInput) ? 'pointer' : 'not-allowed',
                backgroundColor: isValidDotName(planNameInput) ? 'rgba(99,102,241,0.25)' : 'rgba(99,102,241,0.07)',
                border: '1px solid rgba(99,102,241,0.4)', color: isValidDotName(planNameInput) ? '#a5b4fc' : '#4b5563',
              }}
            >
              Save Plan
            </button>
            <button
              onClick={() => setShowNamePlan(false)}
              style={{ padding: '5px 12px', borderRadius: 6, fontSize: '0.72rem', cursor: 'pointer', backgroundColor: 'transparent', border: '1px solid rgba(107,114,128,0.3)', color: '#6b7280' }}
            >
              Skip
            </button>
          </div>
        </div>
      )}
      {phase === 'done' && planNameSaved && (
        <div style={{ marginTop: 8, padding: '7px 12px', borderRadius: 8, backgroundColor: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)', fontSize: '0.72rem', color: '#4ade80' }}>
          ✓ Plan saved as <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{planNameInput}</span> — recall with &ldquo;Run {planNameInput}&rdquo;
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

      {/* ── Preflight agent list with favicons ─────────────────────────────── */}
      {phase === 'preflight' && preflightAgents.length > 0 && (
        <div className="flex flex-wrap gap-2" style={{ padding: '4px 0' }}>
          {preflightAgents.map((agent, i) => (
            <div key={`${agent.agentId}-${i}`}
              className="flex items-center gap-1.5 rounded-md"
              style={{
                padding: '4px 8px',
                backgroundColor: agent.ready ? 'rgba(34,197,94,0.08)' : 'rgba(59,130,246,0.08)',
                border: `1px solid ${agent.ready ? 'rgba(34,197,94,0.2)' : 'rgba(59,130,246,0.2)'}`,
              }}
            >
              {agent.iconUrl ? (
                <img
                  src={agent.iconUrl}
                  width={16}
                  height={16}
                  alt={agent.agentId}
                  style={{ borderRadius: 2, flexShrink: 0 }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: '#6b7280', flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" />
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                </svg>
              )}
              <span className="text-xs font-medium" style={{ color: agent.ready ? '#22c55e' : '#60a5fa' }}>
                {agent.type === 'preflight' || agent.agentId === 'preflight'
                  ? 'preflight...'
                  : agent.agentId.replace(/\.agent$/i, '')}
              </span>
              {agent.ready ? (
                <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <div className="w-2 h-2 rounded-full border animate-spin" style={{ borderColor: '#60a5fa', borderTopColor: 'transparent' }} />
              )}
              {!agent.authed && agent.ready && (
                <span className="text-xs" style={{ color: '#f59e0b' }}>⚠</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── Preflight route choice card ─────────────────────────────────────── */}
      {preflightRouteChoice && (
        <div className="rounded-lg"
          style={{
            padding: '12px 14px',
            backgroundColor: 'rgba(99,102,241,0.08)',
            border: '1px solid rgba(99,102,241,0.3)',
          }}
        >
          <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
            {preflightRouteChoice.iconUrl && (
              <img
                src={preflightRouteChoice.iconUrl}
                width={20}
                height={20}
                alt={preflightRouteChoice.serviceName}
                style={{ borderRadius: 4, flexShrink: 0 }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
              />
            )}
            <div className="text-sm font-medium" style={{ color: '#a5b4fc' }}>
              Choose execution route for {preflightRouteChoice.serviceName}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {preflightRouteChoice.options.map((opt) => (
              <button
                key={opt.route}
                onClick={() => {
                  setPreflightRouteChoice(null);
                  onAuthPending?.(false);
                  ipcRenderer?.send('gather:answer', { answer: opt.route });
                }}
                className="text-xs font-medium rounded-md transition-colors"
                style={{
                  padding: '8px 14px',
                  backgroundColor: opt.recommended ? 'rgba(99,102,241,0.15)' : 'transparent',
                  border: `1px solid ${opt.recommended ? 'rgba(99,102,241,0.4)' : 'rgba(107,114,128,0.25)'}`,
                  color: opt.recommended ? '#a5b4fc' : '#9ca3af',
                  cursor: 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 2,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {opt.recommended && <span style={{ fontSize: '0.6rem' }}>★</span>}
                  {opt.label}
                  {opt.recommended && <span style={{ fontSize: '0.6rem', opacity: 0.7 }}>(recommended)</span>}
                </div>
                <div style={{ fontSize: '0.6rem', opacity: 0.6, fontWeight: 400 }}>
                  {opt.description}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Preflight auth-required banner ─────────────────────────────────── */}
      {preflightAuthRequired && (
        (() => {
          const isBrowserAuth = preflightAuthRequired.authType === 'browser_oauth' || preflightAuthRequired.authType === 'browser_reauth';
          const isCliSetup = preflightAuthRequired.authType === 'cli_setup';
          return (
        <div className="rounded-lg"
          style={{
            padding: '10px 14px',
            backgroundColor: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.3)',
            display: 'flex',
            alignItems: 'flex-start',
            flexWrap: 'wrap',
            gap: 10,
          }}
        >
          {preflightAuthRequired.iconUrl && (
            <img
              src={preflightAuthRequired.iconUrl}
              width={24}
              height={24}
              alt={preflightAuthRequired.agentId}
              style={{ borderRadius: 4, flexShrink: 0 }}
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          )}
          <div className="flex-1" style={{ minWidth: 0 }}>
            <div className="text-sm font-medium" style={{ color: '#f59e0b', overflowWrap: 'anywhere' }}>
              {preflightAuthRequired.message}
            </div>
            <div className="text-xs" style={{ color: '#92400e' }}>
              {isCliSetup
                ? 'CLI agent needs configuration — open the Agents tab to complete setup.'
                : isBrowserAuth
                ? preflightAuthBackgroundFailed
                  ? 'Background auth check could not verify login. If you have signed in, click Continue to proceed.'
                  : preflightAuthBrowserOpened
                  ? 'Browser is open — complete the sign-in, then click Continue.'
                  : 'Browser login required — click Sign in to continue.'
                : preflightAuthRequired.authType === 'cli_install'
                ? 'CLI install required — open the Agents tab to install.'
                : preflightAuthRequired.authType === 'cli_update_needed'
                ? 'CLI version drift detected — update recommended. Open the Agents tab to update.'
                : preflightAuthRequired.authType === 'api_key'
                ? 'API key required — open the Agents tab to add credentials.'
                : 'Authentication required — open the Agents tab to add credentials.'
              }
            </div>
          </div>
          <div style={{ display: 'flex', width: '100%', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
            {isBrowserAuth ? (
              preflightAuthBrowserOpened || preflightAuthBackgroundFailed ? (
                <>
                  {preflightAuthBackgroundFailed && (
                    <button
                      onClick={() => {
                        setPreflightAuthBrowserOpened(false);
                        setPreflightAuthBackgroundFailed(false);
                        ipcRenderer?.send('browser.agent:auth', { agentId: preflightAuthRequired.agentId });
                      }}
                      className="text-xs font-medium rounded-md transition-colors"
                      style={{
                        padding: '6px 12px',
                        backgroundColor: 'rgba(245,158,11,0.15)',
                        border: '1px solid rgba(245,158,11,0.4)',
                        color: '#f59e0b',
                        cursor: 'pointer',
                      }}
                    >
                      Retry sign-in →
                    </button>
                  )}
                  {authContinueVisible || preflightAuthBackgroundFailed ? (
                    <button
                      onClick={() => {
                        ipcRenderer?.send('preflight:auth_continue', { agentId: preflightAuthRequired.agentId });
                        setPreflightAuthRequired(null);
                        setPreflightAuthBrowserOpened(false);
                        setPreflightAuthBackgroundFailed(false);
                        setAuthContinueVisible(false);
                      }}
                      className="text-xs font-medium rounded-md transition-colors"
                      style={{
                        padding: '6px 12px',
                        backgroundColor: 'rgba(34,197,94,0.15)',
                        border: '1px solid rgba(34,197,94,0.4)',
                        color: '#22c55e',
                        cursor: 'pointer',
                      }}
                    >
                      I've signed in — Continue →
                    </button>
                  ) : (
                    <span className="text-xs" style={{ color: '#92400e' }}>
                      Complete sign-in… Continue unlocks shortly.
                    </span>
                  )}
                </>
              ) : (
                <button
                  onClick={() => {
                    ipcRenderer?.send('browser.agent:auth', { agentId: preflightAuthRequired.agentId });
                  }}
                  className="text-xs font-medium rounded-md transition-colors"
                  style={{
                    padding: '6px 12px',
                    backgroundColor: 'rgba(245,158,11,0.15)',
                    border: '1px solid rgba(245,158,11,0.4)',
                    color: '#f59e0b',
                    cursor: 'pointer',
                  }}
                >
                  Sign in to {preflightAuthRequired.agentId.replace('.agent', '')} →
                </button>
              )
            ) : (
              <button
                onClick={() => {
                  ipcRenderer?.send('preflight:open-agents-tab', {
                    agentId: preflightAuthRequired.agentId,
                    serviceName: preflightAuthRequired.serviceName,
                    authType: preflightAuthRequired.authType,
                    message: preflightAuthRequired.message,
                    reason: preflightAuthRequired.reason || null,
                    setupInfo: preflightAuthRequired.setupInfo || null,
                  });
                }}
                className="text-xs font-medium rounded-md transition-colors"
                style={{
                  padding: '6px 12px',
                  backgroundColor: 'rgba(245,158,11,0.15)',
                  border: '1px solid rgba(245,158,11,0.4)',
                  color: '#f59e0b',
                  cursor: 'pointer',
                }}
              >
                {isCliSetup ? 'Configure in Agents Tab →' : 'Open Agents Tab →'}
              </button>
            )}
          </div>
        </div>
          );
        })()
      )}

      {/* ── vet CLI script review card ────────────────────────────────────── */}
      {vetScriptReview && phase === 'preflight' && (
        <div style={{ padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.35)' }}>
          <div className="flex items-start gap-2" style={{ marginBottom: 8 }}>
            <div style={{ fontSize: '0.95rem', lineHeight: 1, marginTop: 1, flexShrink: 0 }}>🔐</div>
            <div>
              <div style={{ color: '#c4b5fd', fontSize: '0.76rem', fontWeight: 600, marginBottom: 3 }}>
                vet CLI Installation Review
              </div>
              <div style={{ color: '#9ca3af', fontSize: '0.69rem', lineHeight: 1.4 }}>
                Source: <span style={{ color: '#e5e7eb', fontFamily: 'ui-monospace,monospace', fontSize: '0.68rem' }}>{vetScriptReview.scriptUrl}</span>
              </div>
            </div>
          </div>
          <div style={{ color: '#d1d5db', fontSize: '0.71rem', lineHeight: 1.5, marginBottom: 8, paddingLeft: 22 }}>
            {vetScriptReview.message}
          </div>
          <pre style={{
            paddingLeft: 22, marginBottom: 10,
            maxHeight: 280, overflow: 'auto',
            padding: '8px 10px', borderRadius: 6,
            background: 'rgba(0,0,0,0.3)',
            color: '#a5b6c2',
            fontFamily: 'ui-monospace,monospace',
            fontSize: '0.65rem', lineHeight: 1.45,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            border: '1px solid rgba(255,255,255,0.08)',
          }}>
            {vetScriptReview.scriptContent}
          </pre>
          <div style={{ display: 'flex', gap: 6, paddingLeft: 22 }}>
            <button
              onClick={() => {
                setVetScriptReview(null);
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
                <path d="M20 6L9 17l-5-5"/>
              </svg>
              Approve &amp; Install
            </button>
            <button
              onClick={() => {
                setVetScriptReview(null);
                ipcRenderer?.send('install:confirm', { confirmed: false });
              }}
              style={{
                padding: '5px 12px', borderRadius: 6, fontSize: '0.7rem', fontWeight: 600,
                cursor: 'pointer', background: 'rgba(107,114,128,0.1)',
                border: '1px solid rgba(107,114,128,0.3)', color: '#9ca3af',
              }}
            >
              Skip
            </button>
          </div>
        </div>
      )}

      {/* ── Preflight warnings banner ─────────────────────────────────────── */}
      {preflightWarnings.length > 0 && (phase === 'preflight' || phase === 'planning') && (
        <div className="rounded-lg" style={{ padding: '8px 14px', backgroundColor: 'rgba(234,179,8,0.06)', border: '1px solid rgba(234,179,8,0.2)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {preflightWarnings.map((w, i) => (
            <div key={i} className="flex items-center gap-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#eab308', flexShrink: 0 }}>
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span className="text-xs" style={{ color: '#a16207' }}>{w.message}</span>
            </div>
          ))}
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
              {askUserPrompt.options.map((option, i) => {
                const _label = typeof option === 'string' ? option : (option?.label || String(option));
                return (
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
                  {_label}
                </button>
                );
              })}
            </div>
          )}
          {(askUserPrompt.freeText || askUserPrompt.options.length === 0) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <input
                type="text"
                value={askUserFreeText}
                onChange={e => setAskUserFreeText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAskUserFreeTextSubmit(); }}
                placeholder="Type your answer…"
                autoFocus
                style={{
                  flex: 1, minWidth: 0, background: 'rgba(0,0,0,0.35)',
                  border: '1px solid rgba(245,158,11,0.35)',
                  borderRadius: 6, padding: '6px 10px',
                  color: '#e5e7eb', fontSize: '0.8rem',
                  outline: 'none',
                }}
              />
              <button
                onClick={handleAskUserFreeTextSubmit}
                disabled={!askUserFreeText.trim()}
                style={{
                  padding: '6px 14px', borderRadius: 6, fontSize: '0.8rem', fontWeight: 600,
                  backgroundColor: askUserFreeText.trim() ? 'rgba(245,158,11,0.18)' : 'rgba(245,158,11,0.06)',
                  border: '1px solid rgba(245,158,11,0.35)',
                  color: askUserFreeText.trim() ? '#fbbf24' : '#9ca3af',
                  cursor: askUserFreeText.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                Submit
              </button>
            </div>
          )}
          {askUserPrompt.options.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <input
                type="text"
                value={askUserFreeText}
                onChange={e => setAskUserFreeText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAskUserFreeTextSubmit(); }}
                placeholder="…or type your own answer"
                style={{
                  width: '100%', background: 'rgba(0,0,0,0.25)',
                  border: '1px solid rgba(107,114,128,0.25)',
                  borderRadius: 6, padding: '6px 10px',
                  color: '#9ca3af', fontSize: '0.75rem',
                  outline: 'none',
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
