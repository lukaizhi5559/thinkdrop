import React, { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { Favicon } from './DefaultFaviconIcon';
import { ThinkDropLogo } from './SlideoutDrawer';
import AutomationProgress, { type RunSummary } from './AutomationProgress';
import { RichContentRenderer } from './rich-content';
import { WebResultsGrid, stripItemImageMarkdown } from './rich-content';
import type { WebResultItem } from './rich-content/WebResultCard';
import SkillBuildProgress from './SkillBuildProgress';

// --- Shared types (exported for use by UnifiedOverlay) ---

export interface SkillBuildState {
  step: 'fetching' | 'building' | 'validating' | 'fixing' | 'installing' | 'done' | 'error' | 'asking';
  skillName?: string;
  code?: string;
  error?: string;
  language?: string;
  confirmMessage?: string;
}

export interface BridgeStatus {
  state: 'idle' | 'watching' | 'stopped';
  cronStatus?: 'running' | 'done' | 'failed';
  cronSkillName?: string;
}

export interface SearchSource {
  url: string;
  hostname: string;
  title?: string;
}

export interface ActionChip {
  label: string;
  action: string;
  args?: Record<string, unknown>;
}

export interface InstallPrompt {
  tool: string;
  installCmd: string;
  reason: string;
  source?: string;
  toolDescription?: string;
}

export interface SchedulePending {
  id: string;
  label: string;
  targetTime: string;
}

// --- Props ---

interface ResultsContentProps {
  // Refs (stable — created by useRef in parent)
  contentRef: RefObject<HTMLDivElement>;
  scrollBottomRef: RefObject<HTMLDivElement>;
  installOutputRef: RefObject<HTMLDivElement>;
  // Results state
  streamingResponse: string;
  resultItems: WebResultItem[];
  isStreaming: boolean;
  isThinking: boolean;
  thinkingElapsed: number;
  isTaskWorking: boolean;
  isAutomationMode: boolean;
  isDropping: boolean;
  // Install state
  installPrompt: InstallPrompt | null;
  isInstalling: boolean;
  installOutput: string[];
  // Action chips
  actionChips: ActionChip[];
  // Search sources
  searchSources: SearchSource[];
  showSourcesPanel: boolean;
  // Schedule + bridge
  schedulePending: SchedulePending | null;
  bridgeStatus: BridgeStatus | null;
  // Skill build
  skillBuild: SkillBuildState | null;
  // Live run visibility — once the run summary commits to the feed the live
  // AutomationProgress collapses away (its feed card represents it).
  liveRunHidden: boolean;
  // AutomationProgress forwarding
  deferredTab: string;
  // Callbacks (all must be useCallback-stabilized)
  setIsSubmitting: (v: boolean) => void;
  setPreflightAuthPending: (v: boolean) => void;
  onScheduleDismiss: (id: string) => void;
  onInstallConfirm: (confirmed: boolean) => void;
  onActionChip: (chip: ActionChip) => void;
  onToggleSourcesPanel: () => void;
  onOpenSourceUrl: (url: string) => void;
  onScrollToBottom: () => void;
  onOpenRules: () => void;
  onHeightChange: () => void;
  onActiveChange: (active: boolean) => void;
  onRunSummary: (summary: RunSummary) => void;
}

function ResultsContentImpl({
  contentRef,
  scrollBottomRef,
  installOutputRef,
  streamingResponse,
  resultItems,
  isStreaming,
  isThinking,
  thinkingElapsed,
  isTaskWorking,
  isAutomationMode,
  isDropping,
  installPrompt,
  isInstalling,
  installOutput,
  actionChips,
  searchSources,
  showSourcesPanel,
  schedulePending,
  bridgeStatus,
  skillBuild,
  liveRunHidden,
  deferredTab,
  setIsSubmitting,
  setPreflightAuthPending,
  onScheduleDismiss,
  onInstallConfirm,
  onActionChip,
  onToggleSourcesPanel,
  onOpenSourceUrl,
  onScrollToBottom,
  onOpenRules,
  onHeightChange,
  onActiveChange,
  onRunSummary,
}: ResultsContentProps) {
  // Live-run collapse — manual toggle while running; the run auto-expands when
  // a new automation starts (isAutomationMode flips true). Once the terminal
  // summary commits, liveRunHidden removes the whole block — the feed's run
  // card represents it.
  const [runCollapsed, setRunCollapsed] = useState(false);
  useEffect(() => {
    if (isAutomationMode) setRunCollapsed(false);
  }, [isAutomationMode]);

  // --- Install Card ---
  const renderInstallCard = () => {
    if (!installPrompt && !isInstalling) return null;

    if (isInstalling) {
      return (
        <div style={{ margin: '8px 0', borderRadius: 10, backgroundColor: 'rgba(15,15,15,0.95)', border: '1px solid rgba(59,130,246,0.3)', overflow: 'hidden' }}>
          <div className="flex items-center gap-2" style={{ padding: '8px 12px', borderBottom: '1px solid rgba(59,130,246,0.15)', backgroundColor: 'rgba(59,130,246,0.08)' }}>
            <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse" />
            <span style={{ color: '#93c5fd', fontSize: '0.78rem', fontWeight: 600 }}>Installing...</span>
            <span style={{ color: '#4b5563', fontSize: '0.7rem', marginLeft: 'auto', fontFamily: 'monospace' }}>{installOutput.length} lines</span>
          </div>
          <div
            ref={installOutputRef}
            style={{ maxHeight: 180, overflowY: 'auto', padding: '8px 12px', fontFamily: 'ui-monospace, monospace', fontSize: '0.68rem', lineHeight: 1.55, color: '#86efac', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
          >
            {installOutput.length === 0 ? (
              <span style={{ color: '#4b5563' }}>Waiting for output...</span>
            ) : (
              installOutput.map((line, i) => (
                <div key={i} style={{ color: line.toLowerCase().includes('error') || line.toLowerCase().includes('failed') ? '#f87171' : line.toLowerCase().includes('warn') ? '#fbbf24' : '#86efac' }}>{line}</div>
              ))
            )}
          </div>
        </div>
      );
    }

    if (!installPrompt) return null;
    const { tool, installCmd, reason, source, toolDescription } = installPrompt;
    const sourceLabel = source === 'brew' ? 'Homebrew' : source === 'npm' ? 'npm' : source === 'pip' ? 'pip' : source;
    const sourceBadgeColor = source === 'brew' ? 'rgba(251,146,60,0.15)' : 'rgba(59,130,246,0.15)';
    const sourceBorderColor = source === 'brew' ? 'rgba(251,146,60,0.35)' : 'rgba(59,130,246,0.3)';
    const sourceTextColor = source === 'brew' ? '#fdba74' : '#93c5fd';

    return (
      <div style={{ margin: '8px 0', padding: '14px', borderRadius: 10, backgroundColor: 'rgba(23,23,23,0.9)', border: '1px solid rgba(255,255,255,0.12)' }}>
        <div className="flex items-start gap-3">
          <div style={{ width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(251,146,60,0.12)', border: '1px solid rgba(251,146,60,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fdba74" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 4 }}>
              <span style={{ color: '#f3f4f6', fontSize: '0.82rem', fontWeight: 600 }}>Install {tool}?</span>
              <span style={{ padding: '1px 6px', borderRadius: 4, backgroundColor: sourceBadgeColor, border: `1px solid ${sourceBorderColor}`, color: sourceTextColor, fontSize: '0.68rem', fontWeight: 500 }}>{sourceLabel}</span>
            </div>
            <p style={{ color: '#9ca3af', fontSize: '0.75rem', margin: '0 0 6px', lineHeight: 1.4 }}>{reason}</p>
            {toolDescription && (
              <p style={{ color: '#abafb8', fontSize: '0.72rem', margin: '0 0 8px', lineHeight: 1.4 }}>{toolDescription}</p>
            )}
            <code style={{ display: 'block', padding: '4px 8px', borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.3)', color: '#86efac', fontSize: '0.7rem', fontFamily: 'monospace', marginBottom: 10, wordBreak: 'break-all' }}>{installCmd}</code>
            <div className="flex gap-2">
              <button
                onClick={() => onInstallConfirm(true)}
                style={{ padding: '5px 14px', borderRadius: 6, backgroundColor: 'rgba(59,130,246,0.2)', border: '1px solid rgba(59,130,246,0.4)', color: '#93c5fd', fontSize: '0.75rem', fontWeight: 600, cursor: 'pointer' }}
              >
                Install
              </button>
              <button
                onClick={() => onInstallConfirm(false)}
                style={{ padding: '5px 14px', borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)', color: '#abafb8', fontSize: '0.75rem', fontWeight: 500, cursor: 'pointer' }}
              >
                Skip
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // --- Source Pill ---
  const renderSourcePill = () => {
    if (!searchSources.length) return null;
    const visible = searchSources.slice(0, 4);
    const OVERLAP = 10;
    const CIRCLE = 22;
    return (
      <div style={{ position: 'relative', marginBottom: 10 }}>
        <button
          data-sources-button
          onClick={onToggleSourcesPanel}
          style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer', userSelect: 'none' }}
        >
          <div style={{ position: 'relative', width: CIRCLE + (visible.length - 1) * (CIRCLE - OVERLAP), height: CIRCLE, flexShrink: 0 }}>
            {visible.map((src, i) => (
              <div
                key={src.url}
                style={{ position: 'absolute', left: i * (CIRCLE - OVERLAP), top: 0, width: CIRCLE, height: CIRCLE, borderRadius: '50%', overflow: 'hidden', border: '1.5px solid rgba(255,255,255,0.12)', backgroundColor: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: visible.length - i, flexShrink: 0 }}
              >
                <Favicon domain={src.hostname} size={14} alt={src.hostname} />
              </div>
            ))}
          </div>
          <span style={{ color: '#9ca3af', fontSize: '0.7rem', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 3 }}>
            {searchSources.length} {searchSources.length === 1 ? 'site' : 'sites'}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#abafb8', transform: showSourcesPanel ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </span>
        </button>
        {showSourcesPanel && (
          <div data-sources-panel style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 50, width: 280, maxHeight: 320, overflowY: 'auto', backgroundColor: '#1c1c1e', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.5)', padding: '6px 0' }}>
            <div style={{ padding: '6px 12px 4px', fontSize: '0.65rem', fontWeight: 600, color: '#abafb8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Sources</div>
            {searchSources.map((src, i) => (
              <div
                key={src.url + i}
                onClick={() => onOpenSourceUrl(src.url)}
                style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 12px', cursor: 'pointer' }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.06)')}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
              >
                <div style={{ width: 20, height: 20, borderRadius: '50%', backgroundColor: '#2a2a2c', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Favicon domain={src.hostname} size={12} alt="" />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: '0.72rem', fontWeight: 500, color: '#e5e7eb', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {src.title || src.hostname}
                  </div>
                  <div style={{ fontSize: '0.65rem', color: '#abafb8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {src.hostname}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // --- Action Chips ---
  const renderActionChips = () => {
    if (!actionChips.length || isStreaming || isThinking || isAutomationMode) return null;
    return (
      <div className="flex flex-wrap gap-2" style={{ marginTop: 10 }}>
        {actionChips.map((chip, i) => {
          const label = typeof chip === 'string' ? chip : (chip as any).label || String(chip);
          return (
            <button
              key={i}
              onClick={() => onActionChip(chip)}
              style={{ padding: '4px 12px', borderRadius: 20, backgroundColor: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.25)', color: '#93c5fd', fontSize: '0.72rem', fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              {label}
            </button>
          );
        })}
      </div>
    );
  };

  const renderResults = () => {
    // In automation mode, only render if there's streaming content (synthesis answer below steps)
    if (isAutomationMode && !streamingResponse && !installPrompt && !isInstalling) return null;

    if (isThinking) {
      // Progressive status messages based on elapsed time
      const thinkingText =
        thinkingElapsed >= 15 ? 'This is taking longer than usual...'
        : thinkingElapsed >= 10 ? 'Still working on it...'
        : thinkingElapsed >= 5 ? 'Thinking...'
        : '';
      return (
        <div>
          {/* ThinkDrop avatar — matches the settled feed entry's header row */}
          <div className="flex items-center gap-1.5 select-none" style={{ marginBottom: 5, opacity: 0.85 }}>
            <ThinkDropLogo size={14} />
          </div>
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: '0ms' }} />
              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: '150ms' }} />
              <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: '300ms' }} />
            </div>
            {thinkingText && <span className="text-gray-400 text-sm">{thinkingText}</span>}
          </div>
        </div>
      );
    }

    if (!streamingResponse && !installPrompt && !isInstalling && !actionChips.length) return null;

    // Approximate token count (1 token ≈ 4 chars) for the progress indicator
    const synthTokenCount = streamingResponse ? Math.ceil(streamingResponse.length / 4) : 0;

    return (
      <div className={`space-y-4${isDropping ? ' drop-animate' : ''} mt-4`}>
        {/* ThinkDrop avatar — matches the settled feed entry's header row */}
        <div className="flex items-center gap-1.5 select-none" style={{ opacity: 0.85 }}>
          <ThinkDropLogo size={14} />
        </div>
        {renderInstallCard()}
        {searchSources.length > 0 && renderSourcePill()}

        {/* Non-automation responses (plain LLM answers) */}
        {streamingResponse && !isAutomationMode && (
          <div className="relative" style={{ overflowX: 'hidden', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
            {resultItems.length > 0 && <WebResultsGrid items={resultItems} />}
            <RichContentRenderer
              content={stripItemImageMarkdown(streamingResponse, resultItems)}
              animated={!isStreaming}
              className="text-sm"
            />
            {isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-1" />
            )}
            {/* "•••" working indicator — shows while a handoff task is running */}
            {isTaskWorking && !isStreaming && (
              <div className="flex gap-1.5 mt-2">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: '0ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: '200ms' }} />
                <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" style={{ animationDelay: '400ms' }} />
              </div>
            )}
          </div>
        )}

        {/* Automation mode summary with progress indicator */}
        {isAutomationMode && (streamingResponse || isStreaming) && (
          <div style={{ marginTop: '20px' }}>
            {/* Clean divider */}
            <div style={{
              height: '1px',
              background: 'linear-gradient(to right, transparent, rgba(255,255,255,0.1), transparent)',
              margin: '16px 0'
            }} />

            {/* Progress indicator or summary content */}
            <div className="relative" style={{ overflowX: 'hidden', wordBreak: 'break-word', overflowWrap: 'break-word' }}>
              {/* Header with progress */}
              <div className="flex items-center gap-2 mb-3" style={{ color: 'rgba(147,197,253,0.9)', fontSize: '0.875rem', fontWeight: 500 }}>
                {isStreaming ? (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-pulse">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                    <span>Summarizing...</span>
                    {synthTokenCount > 0 && (
                      <span style={{
                        fontSize: '0.75rem',
                        color: 'rgba(147,197,253,0.7)',
                        marginLeft: '8px',
                        background: 'rgba(59,130,246,0.15)',
                        padding: '2px 8px',
                        borderRadius: '12px',
                        fontFamily: 'monospace'
                      }}>
                        {synthTokenCount > 999 ? `${(synthTokenCount / 1000).toFixed(1)}k` : synthTokenCount} tokens
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                    </svg>
                    <span>Summary</span>
                    {synthTokenCount > 0 && (
                      <span style={{
                        fontSize: '0.75rem',
                        color: 'rgba(147,197,253,0.6)',
                        marginLeft: '8px',
                        background: 'rgba(59,130,246,0.1)',
                        padding: '2px 8px',
                        borderRadius: '12px',
                        fontFamily: 'monospace'
                      }}>
                        {synthTokenCount > 999 ? `${(synthTokenCount / 1000).toFixed(1)}k` : synthTokenCount} tokens
                      </span>
                    )}
                  </>
                )}
              </div>

              {/* Summary content with smooth streaming */}
              {streamingResponse && (
                <div
                  className="relative text-sm leading-relaxed"
                  style={{
                    animation: isStreaming ? 'fadeIn 0.3s ease-out' : 'none',
                    lineHeight: '1.6'
                  }}
                >
                  {resultItems.length > 0 && <WebResultsGrid items={resultItems} />}
                  <RichContentRenderer
                    content={stripItemImageMarkdown(streamingResponse, resultItems)}
                    animated={!isStreaming}
                    className="text-sm"
                  />
                  {isStreaming && (
                    <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-1" />
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {renderActionChips()}
      </div>
    );
  };

  return (
    <div ref={contentRef}>
      {schedulePending && (
        <div style={{ marginBottom: 12, padding: '12px 14px', borderRadius: 10, backgroundColor: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.3)' }}>
          <div className="flex items-start gap-3">
            <div style={{ width: 28, height: 28, borderRadius: 7, backgroundColor: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div style={{ color: '#c4b5fd', fontSize: '0.8rem', fontWeight: 600, marginBottom: 2 }}>
                Scheduled task queued
              </div>
              <div style={{ color: '#9ca3af', fontSize: '0.72rem', marginBottom: 8, lineHeight: 1.4 }}>
                <strong style={{ color: '#e5e7eb' }}>{schedulePending.label}</strong> will run automatically at <strong style={{ color: '#a78bfa' }}>{schedulePending.targetTime}</strong>
              </div>
              <button
                onClick={() => onScheduleDismiss(schedulePending.id)}
                style={{ padding: '3px 10px', borderRadius: 5, backgroundColor: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.3)', color: '#a78bfa', fontSize: '0.72rem', cursor: 'pointer' }}
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {bridgeStatus && bridgeStatus.state !== 'stopped' && (
        <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 5, opacity: bridgeStatus.cronStatus === 'running' ? 1 : (bridgeStatus.cronStatus ? 0.85 : 0.45) }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', flexShrink: 0, backgroundColor: bridgeStatus.cronStatus === 'running' ? '#3b82f6' : bridgeStatus.cronStatus === 'failed' ? '#ef4444' : bridgeStatus.cronStatus === 'done' ? '#22c55e' : '#10b981', animation: bridgeStatus.cronStatus === 'running' ? 'pulse 1.5s ease-in-out infinite' : 'none' }} />
          <span style={{ color: '#abafb8', fontSize: '0.65rem' }}>Bridge watching</span>
        </div>
      )}

      {!liveRunHidden && isAutomationMode && (
        <button
          onClick={() => setRunCollapsed(prev => !prev)}
          className="flex items-center gap-2 w-full text-left"
          style={{ background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer' }}
        >
          <span style={{ color: '#6b7280', fontSize: '0.7rem', width: 10, flexShrink: 0 }}>{runCollapsed ? '▸' : '▾'}</span>
          <span style={{ color: '#93c5fd', fontSize: '0.78rem', fontWeight: 600 }}>AI: Automation run</span>
        </button>
      )}
      <div style={{ display: liveRunHidden || runCollapsed ? 'none' : 'block' }}>
        <AutomationProgress
          suppressIfScheduled={false}
          setIsSubmitting={setIsSubmitting}
          onAuthPending={setPreflightAuthPending}
          activeTab={deferredTab}
          onHeightChange={onHeightChange}
          onActiveChange={onActiveChange}
          onAskUserShown={onScrollToBottom}
          onOpenRules={onOpenRules}
          onRunSummary={onRunSummary}
        />
      </div>

      {skillBuild && (
        <SkillBuildProgress
          state={{
            phase: skillBuild.step || 'idle',
            skillName: skillBuild.skillName || '',
            skillDisplayName: skillBuild.skillName || '',
            category: 'general',
            round: 0,
            maxRounds: 3,
            rounds: [],
            question: skillBuild.confirmMessage,
            error: skillBuild.error,
          }}
          onAnswer={() => {}}
          onCancel={() => {}}
          onOpenUrl={() => {}}
        />
      )}

      {renderResults()}

      {/* Thought-engine outreach is now committed as proactive feed entries
          (ResultsFeed) instead of a live block here. */}
      <div ref={scrollBottomRef} />
    </div>
  );
}

export const ResultsContent = React.memo(ResultsContentImpl);
export default ResultsContent;
