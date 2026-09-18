import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import VoiceButton from './VoiceButton';
import type { RefObject } from 'react';
import type { AIActivityPanelHandle } from './AIActivityPanel';

export interface PromptInputBarHandle {
  setPromptText: (text: string) => void;
  focus: () => void;
}

interface PromptInputBarProps {
  /** Wrapper div ref — observed by useDynamicHeight's ResizeObserver in parent. */
  inputBarRef: RefObject<HTMLDivElement>;
  /** Highlight chips to display above the textarea. */
  highlights: string[];
  onHighlightRemove: (index: number) => void;
  /** Gather flow — changes placeholder text. */
  gatherPending: boolean;
  gatherQuestion: string | null;
  /** Debug mode (currently always false, preserved for future). */
  isDebugMode: boolean;
  /** Submit/cancel button state. */
  isSubmitting: boolean;
  /** Copy capture button glow state. */
  copyButtonGlowing: boolean;
  /** Paste handler — parent owns highlights state. */
  onPaste: (e: React.ClipboardEvent) => void;
  /** File attach button. */
  onAttachClick: () => void;
  /** Copy capture button click. */
  onCopyClick: () => void;
  /** Cancel automation. */
  onCancel: () => void;
  /** Submit callback — receives text + current highlights + gatherPending. */
  onSubmit: (text: string, highlights: string[], gatherPending: boolean) => void;
  /** Debug mode terminal ref (currently no-op, preserved). */
  aiActivityPanelRef: RefObject<AIActivityPanelHandle>;
  /** "Continue Thread" — recalled task context pinned for the next prompt. */
  threadContext?: { prompt: string } | null;
  onThreadContextClear?: () => void;
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

/** Display label for a highlight chip — basename for paths, excerpt for text. */
function _chipLabel(h: string): string {
  const m = h.match(/^\[(File|Folder):\s*(.+?)\s*\]$/);
  if (m) {
    const base = m[2].split('/').filter(Boolean).pop() || m[2];
    return base;
  }
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
    .trim();
}

function PromptInputBarImpl(
  {
    inputBarRef,
    highlights,
    onHighlightRemove,
    gatherPending,
    gatherQuestion,
    isDebugMode,
    isSubmitting,
    copyButtonGlowing,
    onPaste,
    onAttachClick,
    onCopyClick,
    onCancel,
    onSubmit,
    aiActivityPanelRef,
    threadContext,
    onThreadContextClear,
  }: PromptInputBarProps,
  ref: React.Ref<PromptInputBarHandle>,
) {
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
    if (isSubmitting && !gatherPending) return;

    // Save to prompt history (normal prompts only, not gather answers)
    if (!gatherPending && text.trim()) {
      setPromptHistory(prev => {
        const newHistory = [text.trim(), ...prev.filter(p => p !== text.trim())].slice(0, 100);
        return newHistory;
      });
      setPromptHistoryIndex(-1);
    }

    // Clear the textarea synchronously — fast because this component is small.
    localSubmittingRef.current = true;
    flushSync(() => {
      setPromptText('');
    });

    // Delegate the rest (parent state reset, IPC send) to the parent.
    onSubmit(text, currentHighlights, gatherPending);
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
    if (!threadContext && highlights.length === 0) return null;

    return (
      <div className="flex flex-wrap gap-2 mb-2">
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
        {highlights.map((highlight, index) => {
          const isFolder = highlight.includes('[Folder:');
          const isFile = highlight.includes('[File:');
          const bgColor = isFolder ? 'rgba(74, 222, 128, 0.15)' : isFile ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.1)';
          const borderColor = isFolder ? 'rgba(74, 222, 128, 0.3)' : isFile ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.2)';
          const textColor = isFolder ? '#4ade80' : isFile ? '#93c5fd' : '#e5e7eb';

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

      {/* Textarea with $ prefix in debug mode */}
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

          {/* Copy Button — pulses when text is highlighted (detected via mouse drag) */}
          <button
            id="copy-capture-button"
            onClick={copyButtonGlowing ? onCopyClick : undefined}
            title={copyButtonGlowing ? 'Click to save highlighted text as a copy file' : 'Highlight text to activate'}
            className={copyButtonGlowing ? 'copy-button-glowing' : ''}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '36px',
              height: '36px',
              borderRadius: '8px',
              backgroundColor: copyButtonGlowing ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.05)',
              border: '1px solid',
              borderColor: copyButtonGlowing ? 'rgba(59,130,246,0.5)' : 'rgba(255,255,255,0.1)',
              color: copyButtonGlowing ? '#93c5fd' : '#abafb8',
              cursor: copyButtonGlowing ? 'pointer' : 'default',
              transition: 'background-color 0.2s, border-color 0.2s, color 0.2s',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>

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
