import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import VoiceButton from './VoiceButton';
import VoiceBars from './VoiceBars';
import type { RefObject } from 'react';
import type { AIActivityPanelHandle } from './AIActivityPanel';
import { BrainIcon } from './QueueTaskCard';
import { useVoiceSession } from '../state/voiceSessionStore';
import { useHighlights, highlightsStore } from '../state/highlightsStore';

export interface PromptInputBarHandle {
  setPromptText: (text: string) => void;
  focus: () => void;
}

interface PromptInputBarProps {
  /** Wrapper div ref — observed by useDynamicHeight's ResizeObserver in parent. */
  inputBarRef: RefObject<HTMLDivElement>;
  /** Highlight chips now come from highlightsStore (subscribed internally). */
  /** Gather flow — changes placeholder text. */
  gatherPending: boolean;
  gatherQuestion: string | null;
  /** Debug mode (currently always false, preserved for future). */
  isDebugMode: boolean;
  /** Submit/cancel button state. */
  isSubmitting: boolean;
  /** Paste handler — parent owns highlights state. */
  onPaste: (e: React.ClipboardEvent) => void;
  /** File attach button. */
  onAttachClick: () => void;
  /** Cancel automation. */
  onCancel: () => void;
  /** Submit callback — receives text + current highlights + gatherPending. */
  onSubmit: (text: string, highlights: string[], gatherPending: boolean) => void;
  /** Debug mode terminal ref (currently no-op, preserved). */
  aiActivityPanelRef: RefObject<AIActivityPanelHandle>;
  /** "Continue Thread" — recalled task context pinned for the next prompt. */
  threadContext?: { prompt: string } | null;
  onThreadContextClear?: () => void;
  /** Armed selection waiting to be captured — renders a pending chip and
   *  triggers the capture request on textarea focus. Prop-driven (never in
   *  highlightsStore) so it can't leak into submitted prompts. */
  selectionPending?: boolean;
  /** Planning mode — active plan-drafting session pinned above the input.
   *  planName is the dot-syntax name (or null → "plan-<id>" placeholder). */
  planning?: { active: boolean; planId?: string | null; planName?: string | null } | null;
  /** Toggle planning mode on/off (paperclip-adjacent button or chip ×). */
  onPlanningToggle?: () => void;
}

// ── Chip icons (inline SVG — no emojis) ────────────────────────────────────────
const _iconProps = { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const FileIcon = () => (
  <svg {..._iconProps}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
  </svg>
);
const FolderIcon = () => (
  <svg {..._iconProps}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
  </svg>
);
const ThreadIcon = () => (
  <svg {..._iconProps}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);
const TargetIcon = () => (
  <svg {..._iconProps}>
    <circle cx="12" cy="12" r="10" /><line x1="22" y1="12" x2="18" y2="12" /><line x1="6" y1="12" x2="2" y2="12" /><line x1="12" y1="6" x2="12" y2="2" /><line x1="12" y1="22" x2="12" y2="18" />
  </svg>
);
// Clipboard with arrow-in — "paste context into the overlay" (distinct from
// the old copy icon's two overlapping rects).
const ClipboardPasteIcon = () => (
  <svg {..._iconProps}>
    <path d="M15 2H9a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1Z" />
    <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    <path d="M18.4 15.6 21 18l-2.6 2.4" />
    <path d="M15 18h6" />
  </svg>
);

/** Display label for a highlight chip — basename for paths, excerpt for text. */
function _chipLabel(h: string): string {
  const m = h.match(/^\[(File|Folder):\s*(.+?)\s*\]$/);
  if (m) {
    const base = m[2].split('/').filter(Boolean).pop() || m[2];
    return base;
  }
  const t = h.match(/^\[(Thought|Context):\s*(.+)\s*\]$/s);
  if (t) return t[2];
  return h;
}

// Display-only: replace embedded [File:]/[Folder:] path tags with basenames and
// strip [Highlighted:] wrappers so e.g. a thread chip reads "家庭 how many..."
// instead of "[Folder: /Users/.../家庭] how many...". The raw string is untouched.
function _promptLabel(p: string): string {
  return p
    .replace(/\[(File|Folder):\s*([^\]]+)\]/g,
      (_m, _k, inner: string) => inner.trim().split('/').filter(Boolean).pop() || inner.trim())
    .replace(/\[Highlighted:\s*([^\]]+)\]/g, '$1')
    .replace(/\[(Thought|Context):\s*([^\]]+)\]/g, '$2')
    .trim();
}

function PromptInputBarImpl(
  {
    inputBarRef,
    gatherPending,
    gatherQuestion,
    isDebugMode,
    isSubmitting,
    onPaste,
    onAttachClick,
    onCancel,
    onSubmit,
    aiActivityPanelRef,
    threadContext,
    onThreadContextClear,
    selectionPending,
    planning,
    onPlanningToggle,
  }: PromptInputBarProps,
  ref: React.Ref<PromptInputBarHandle>,
) {
  // Voice session from the external store — level ticks ~6Hz must not
  // re-render the parent overlay; this subtree is the only consumer.
  const voiceSession = useVoiceSession();
  // Highlight chips from the external store — drop/paste writes re-render ONLY
  // this subtree, not the whole overlay (was the 1–3s drop→chip delay).
  const highlights = useHighlights();
  const onHighlightRemove = useCallback((index: number) => {
    highlightsStore.set(prev => prev.filter((_, i) => i !== index));
  }, []);
  // --- Input state (owned by this component so typing doesn't re-render parent) ---
  const [promptText, setPromptText] = useState('');
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [promptHistoryIndex, setPromptHistoryIndex] = useState(-1);
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [terminalHistoryIndex, setTerminalHistoryIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Guard against double-submit during the brief window before the parent's
  // isSubmitting prop updates (parent state is now in a startTransition).
  const localSubmittingRef = useRef(false);

  // Imperative handle — lets parent inject text (voice) and focus the textarea.
  useImperativeHandle(ref, () => ({
    setPromptText: (text: string) => setPromptText(text),
    focus: () => textareaRef.current?.focus(),
  }), []);

  // --- Textarea change + auto-resize ---
  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPromptText(e.target.value);
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
  };

  // Reset textarea inline height when prompt is cleared (submit, history nav, voice inject).
  useEffect(() => {
    if (promptText === '' && textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [promptText]);

  // Reset local submit guard when the parent's isSubmitting transitions back to false
  // (task completed or cancelled).
  useEffect(() => {
    if (!isSubmitting) localSubmittingRef.current = false;
  }, [isSubmitting]);

  // --- Submit (called from keydown Enter or button click) ---
  const doSubmit = useCallback(() => {
    // Prevent double-submit during the transition window before parent's isSubmitting updates
    if (localSubmittingRef.current) return;
    const text = promptText;
    const currentHighlights = highlights;

    // Guard: nothing to submit
    if (!text.trim() && currentHighlights.length === 0) return;
    // No isSubmitting gate — concurrent prompts are supported (quick replies
    // route around a running automation). The button shows Cancel while a task
    // runs, but Enter must always send.

    // Save to prompt history (normal prompts only, not gather answers)
    if (!gatherPending && text.trim()) {
      setPromptHistory(prev => {
        const newHistory = [text.trim(), ...prev.filter(p => p !== text.trim())].slice(0, 100);
        return newHistory;
      });
      setPromptHistoryIndex(-1);
    }

    // Clear the textarea synchronously — fast because this component is small.
    // Debounce double-fires for 600ms, but don't latch on isSubmitting — a
    // long-running task would otherwise deadlock every later submit.
    localSubmittingRef.current = true;
    setTimeout(() => { localSubmittingRef.current = false; }, 600);
    flushSync(() => {
      setPromptText('');
    });

    // Delegate the rest (parent state reset, IPC send) to the parent — deferred
    // ~10ms so the browser can paint the cleared textarea first. The parent's
    // submit work (feedStore mutations → sync subscriber re-render of the whole
    // overlay, prompt assembly, IPC) runs in the same task and would otherwise
    // delay that paint, leaving the text visibly lingering after Enter.
    setTimeout(() => {
      onSubmit(text, currentHighlights, gatherPending);
    }, 10);
  }, [promptText, highlights, isSubmitting, gatherPending, onSubmit]);

  // --- Keydown ---
  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Debug mode: handle terminal commands and history
    if (isDebugMode) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const command = promptText.trim();
        if (command) {
          setTerminalHistory(prev => [command, ...prev].slice(0, 50));
          setTerminalHistoryIndex(-1);
          aiActivityPanelRef.current?.executeCommand(command);
          setPromptText('');
        }
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (terminalHistoryIndex < terminalHistory.length - 1) {
          const newIndex = terminalHistoryIndex + 1;
          setTerminalHistoryIndex(newIndex);
          setPromptText(terminalHistory[newIndex] || '');
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (terminalHistoryIndex > 0) {
          const newIndex = terminalHistoryIndex - 1;
          setTerminalHistoryIndex(newIndex);
          setPromptText(terminalHistory[newIndex] || '');
        } else if (terminalHistoryIndex === 0) {
          setTerminalHistoryIndex(-1);
          setPromptText('');
        }
        return;
      }
    }

    // Normal mode: Prompt history navigation with Up/Down arrows
    if (!isDebugMode && promptHistory.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (promptHistoryIndex < promptHistory.length - 1) {
          const newIndex = promptHistoryIndex + 1;
          setPromptHistoryIndex(newIndex);
          setPromptText(promptHistory[newIndex]);
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (promptHistoryIndex > 0) {
          const newIndex = promptHistoryIndex - 1;
          setPromptHistoryIndex(newIndex);
          setPromptText(promptHistory[newIndex]);
        } else if (promptHistoryIndex === 0) {
          setPromptHistoryIndex(-1);
          setPromptText('');
        }
        return;
      }
    }

    // Normal mode: standard submit
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSubmit();
    }
  };

  // --- Highlight chips ---
  const renderHighlightChips = () => {
    if (!threadContext && !selectionPending && highlights.length === 0 && !planning?.active) return null;

    return (
      <div className="flex flex-wrap gap-2 mb-2">
        {planning?.active && (
          <div
            className="planning-chip flex items-center gap-1 px-2 py-1 rounded-md text-xs"
            title={`Planning mode${planning.planName ? `: ${planning.planName}` : ' — drafting a plan'}`}
            style={{
              backgroundColor: 'rgba(34, 211, 238, 0.14)',
              border: '1px solid rgba(34, 211, 238, 0.35)',
              color: '#67e8f9',
            }}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><polyline points="9 4 9 18"/><polyline points="15 6 15 20"/>
            </svg>
            <span className="truncate max-w-[180px]">
              Planning{planning.planName ? `: ${planning.planName}` : ' mode'}
            </span>
            <button
              onClick={onPlanningToggle}
              className="ml-1 hover:opacity-70"
              style={{ color: '#67e8f9' }}
              title="Exit planning mode"
            >
              ×
            </button>
          </div>
        )}
        {threadContext && (
          <div
            className="flex items-center gap-1 px-2 py-1 rounded-md text-xs"
            title={`Continue thread: ${threadContext.prompt}`}
            style={{
              backgroundColor: 'rgba(167, 139, 250, 0.15)',
              border: '1px solid rgba(167, 139, 250, 0.35)',
              color: '#c4b5fd',
            }}
          >
            <ThreadIcon />
            <span className="truncate max-w-[150px]">{_promptLabel(threadContext.prompt)}</span>
            <button
              onClick={() => onThreadContextClear?.()}
              className="ml-1 hover:opacity-70"
              style={{ color: '#c4b5fd' }}
            >
              ×
            </button>
          </div>
        )}
        {selectionPending && (
          <div className="relative flex items-center">
            <span className="selection-paste-ring" aria-hidden="true" />
            <button
              onClick={() => (window as any).electron?.ipcRenderer?.send('selection:capture-request')}
              className="relative flex items-center gap-1.5 px-2 py-1 rounded-md text-xs selection-pending-chip"
              title="Paste highlighted text into the overlay (⌘;)"
              style={{
                backgroundColor: 'rgba(251, 146, 60, 0.14)',
                border: '1px solid rgba(251, 146, 60, 0.35)',
                color: '#fdba74',
                cursor: 'pointer',
              }}
            >
              <ClipboardPasteIcon />
              <span>Paste context</span>
              <kbd
                className="px-1 rounded text-[10px]"
                style={{
                  backgroundColor: 'rgba(251, 146, 60, 0.12)',
                  border: '1px solid rgba(251, 146, 60, 0.3)',
                  fontFamily: 'inherit',
                }}
              >
                ⌘;
              </kbd>
            </button>
            <button
              onClick={() => (window as any).electron?.ipcRenderer?.send('selection:clear')}
              className="ml-1 hover:opacity-70 relative"
              style={{ color: '#fdba74' }}
            >
              ×
            </button>
          </div>
        )}
        {highlights.map((highlight, index) => {
          const isFolder = highlight.includes('[Folder:');
          const isFile = highlight.includes('[File:');
          const isThought = highlight.startsWith('[Thought:');
          const isContext = highlight.startsWith('[Context:');
          const bgColor = isFolder ? 'rgba(74, 222, 128, 0.15)' : isFile ? 'rgba(59, 130, 246, 0.15)' : isThought ? 'rgba(129, 140, 248, 0.15)' : isContext ? 'rgba(34, 211, 238, 0.15)' : 'rgba(255, 255, 255, 0.1)';
          const borderColor = isFolder ? 'rgba(74, 222, 128, 0.3)' : isFile ? 'rgba(59, 130, 246, 0.3)' : isThought ? 'rgba(129, 140, 248, 0.35)' : isContext ? 'rgba(34, 211, 238, 0.35)' : 'rgba(255, 255, 255, 0.2)';
          const textColor = isFolder ? '#4ade80' : isFile ? '#93c5fd' : isThought ? '#a5b4fc' : isContext ? '#67e8f9' : '#e5e7eb';

          return (
            <div
              key={index}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs"
              title={highlight}
              style={{
                backgroundColor: bgColor,
                border: `1px solid ${borderColor}`,
                color: textColor,
              }}
            >
              {isFolder && <FolderIcon />}
              {isFile && <FileIcon />}
              {isThought && <BrainIcon size={11} />}
              {isContext && <TargetIcon />}
              <span className="truncate max-w-[150px]">{_chipLabel(highlight)}</span>
              <button
                onClick={() => onHighlightRemove(index)}
                className="ml-1 hover:opacity-70"
                style={{ color: textColor }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    );
  };

  const hasContent = promptText.trim() || highlights.length > 0;

  return (
    <div
      ref={inputBarRef}
      className="border-t p-4 relative"
      style={{ borderColor: 'rgba(255, 255, 255, 0.1)', flexShrink: 0 }}
    >
      {/* Highlights */}
      {renderHighlightChips()}

      {/* Voice session: bars + live transcript replace the textarea */}
      {voiceSession?.active ? (
        <div className="mb-3" style={{ minHeight: '24px' }}>
          <VoiceBars state={voiceSession.state} level={voiceSession.level ?? 0} />
          <div
            className="text-sm text-center px-2"
            style={{
              color: voiceSession.interimText ? '#9ca3af' : '#e5e7eb',
              fontStyle: voiceSession.interimText ? 'italic' : 'normal',
              minHeight: '20px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={voiceSession.interimText || voiceSession.finalText || ''}
          >
            {voiceSession.interimText
              || voiceSession.finalText
              || (voiceSession.state === 'speaking'
                ? 'Speaking…'
                : voiceSession.state === 'processing'
                  ? 'Thinking…'
                  : 'Listening…')}
          </div>
        </div>
      ) : (
        /* Textarea with $ prefix in debug mode */
        <div className="relative">
          {isDebugMode && (
            <span className="absolute left-0 top-0 text-green-400 font-mono text-sm select-none pointer-events-none">
              $
            </span>
          )}
          <textarea
            ref={textareaRef}
            value={promptText}
            onChange={handleTextareaChange}
            onKeyDown={handleTextareaKeyDown}
            onPaste={onPaste}
            placeholder={
              gatherPending && gatherQuestion
                ? gatherQuestion
                : isDebugMode
                  ? "Enter command..."
                  : "Ask or Drag-Drop anything here"
            }
            className={`w-full bg-transparent text-white placeholder-gray-500 resize-none outline-none text-sm mb-3 ${isDebugMode ? 'pl-4' : ''}`}
            style={{ minHeight: '24px', maxHeight: '200px' }}
            rows={1}
          />
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Attach Button */}
          <button
            onClick={onAttachClick}
            className="flex items-center justify-center w-9 h-9 p-0 rounded-lg text-sm font-medium bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10 transition-all"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>

          {/* Planning-mode toggle — orbiting cyan ring while active (same
              affordance grammar as the paste-context button). */}
          <div className="relative flex items-center">
            {planning?.active && <span className="planning-toggle-ring" aria-hidden="true" />}
            <button
              onClick={onPlanningToggle}
              className="relative flex items-center justify-center w-9 h-9 p-0 rounded-lg text-sm font-medium border transition-all"
              style={{
                backgroundColor: planning?.active ? 'rgba(34,211,238,0.15)' : 'rgba(255,255,255,0.05)',
                color: planning?.active ? '#22d3ee' : '#9ca3af',
                borderColor: planning?.active ? 'rgba(34,211,238,0.4)' : 'rgba(255,255,255,0.1)',
              }}
              title={planning?.active ? 'Exit planning mode' : 'Start a plan — multi-task prompts draft a plan first'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z"/><polyline points="9 4 9 18"/><polyline points="15 6 15 20"/>
              </svg>
            </button>
          </div>

          {/* Terminal Button */}
          {/* <button
            onClick={() => setIsDebugMode(!isDebugMode)}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium border transition-all ${
              isDebugMode
                ? 'bg-blue-600/20 text-blue-400 border-blue-500/50 hover:bg-blue-600/30'
                : 'bg-white/5 text-gray-400 border-white/10 hover:bg-white/10'
            }`}
            title={isDebugMode ? 'Exit Debug Mode' : 'Enter Debug Mode'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button> */}
        </div>

        {/* Submit/Cancel Button - Matching StandalonePromptCapture style */}
        <div className="flex items-center gap-2">
          <div
            className={isSubmitting ? 'relative group' : ''}
            style={{
              width: '36px',
              height: '36px',
              borderRadius: '8px',
              backgroundColor: isSubmitting
                ? 'rgba(239, 68, 68, 0.15)'
                : hasContent ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
              border: '1px solid',
              borderColor: isSubmitting
                ? 'rgba(239, 68, 68, 0.3)'
                : hasContent ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)',
              flexShrink: 0,
              marginTop: '0px',
              cursor: (isSubmitting || hasContent) ? 'pointer' : 'default',
              transition: 'background-color 0.15s, border-color 0.15s',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }}
            onMouseEnter={(e) => {
              if (isSubmitting) {
                e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.25)';
                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.5)';
              }
            }}
            onMouseLeave={(e) => {
              if (isSubmitting) {
                e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
                e.currentTarget.style.borderColor = 'rgba(239, 68, 68, 0.3)';
              }
            }}
            title={isSubmitting ? 'Cancel' : 'Send'}
            onClick={isSubmitting ? onCancel : hasContent ? doSubmit : undefined}
          >
            {/* Red glow ring on hover when cancelling */}
            {isSubmitting && (
              <div
                className="cancel-glow-ring group-hover:active"
                style={{ borderRadius: '8px' }}
              />
            )}
            {isSubmitting ? (
              /* Stop square — like ChatGPT/Windsurf cancel */
              <svg width="10" height="10" viewBox="0 0 10 10" className="group-hover:fill-[#ef4444] transition-colors" fill="#9ca3af">
                <rect x="0" y="0" width="10" height="10" rx="2" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke={hasContent ? '#60a5fa' : '#abafb8'}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 10l-5 5 5 5" />
                <path d="M20 4v7a4 4 0 0 1-4 4H4" />
              </svg>
            )}
          </div>
          <VoiceButton compact={true} icon="voice" style={{ width: '36px', height: '36px', borderRadius: '8px' }} />
        </div>
      </div>
    </div>
  );
}

export const PromptInputBar = forwardRef(PromptInputBarImpl);
