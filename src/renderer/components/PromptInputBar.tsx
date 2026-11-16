import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef, useCallback } from 'react';
import { flushSync } from 'react-dom';
import VoiceButton from './VoiceButton';
import VoiceBars from './VoiceBars';
import VoiceLangPicker from './VoiceLangPicker';
import RoptKeyIcon from './RoptKeyIcon';
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
   *  planName is the dot-syntax name (or null → "plan-<id>" placeholder);
   *  planFile backs the Plan Readiness strip's task snapshot + Open plan. */
  planning?: { active: boolean; planId?: string | null; planName?: string | null; planFile?: string | null } | null;
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
  const [, setTerminalHistory] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Guard against double-submit during the brief window before the parent's
  // isSubmitting prop updates (parent state is now in a startTransition).
  const localSubmittingRef = useRef(false);

  // ── ROpt-hold PTT ─────────────────────────────────────────────────────────
  // 'voice:ptt-start/stop' come from main (ui + service dispatched together);
  // 'ptt:interim' shows live text; 'ptt:transcript' is the final — auto-submit
  // with the current highlight chips (an armed selection confirmed by the same
  // keypress rides along).
  const [pttActive, setPttActive] = useState(false);
  const [pttInterim, setPttInterim] = useState('');
  // ⓘ legend tooltip open state (hover + click-toggle).
  const [legendOpen, setLegendOpen] = useState(false);
  // Avatar mode ("Optyons") — droplet toggle next to the planning button.
  const [avatarMode, setAvatarMode] = useState(false);
  useEffect(() => {
    const ipc = (window as any).electron?.ipcRenderer;
    if (!ipc) return;
    const T = 'inputbar-avatar';
    ipc.on('avatar:mode', (d: any) => setAvatarMode(!!d?.on), T);
    return () => { try { ipc.removeListenerByToken('avatar:mode', T); } catch (_) {} };
  }, []);
  const promptTextRef = useRef(promptText);
  promptTextRef.current = promptText;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const gatherPendingRef = useRef(gatherPending);
  gatherPendingRef.current = gatherPending;

  useEffect(() => {
    const ipc = (window as any).electron?.ipcRenderer;
    if (!ipc) return;
    const T = 'inputbar-ptt';
    const onStart = () => { setPttActive(true); setPttInterim(''); };
    const onStop = () => { setPttActive(false); setPttInterim(''); };
    const onInterim = (data: { text?: string }) => setPttInterim(data?.text || '');
    const onTranscript = (data: { transcript?: string }) => {
      const said = (data?.transcript || '').trim();
      setPttActive(false);
      setPttInterim('');
      if (!said) return;
      // Typed text already in the box stays — prepend it to the dictation.
      const typed = promptTextRef.current.trim();
      const text = typed ? `${typed} ${said}` : said;
      const chips = highlightsStore.get();
      flushSync(() => setPromptText(''));
      setTimeout(() => onSubmitRef.current(text, chips, gatherPendingRef.current), 10);
    };
    ipc.on('voice:ptt-start', onStart, T);
    ipc.on('voice:ptt-stop', onStop, T);
    ipc.on('ptt:interim', onInterim, T);
    ipc.on('ptt:transcript', onTranscript, T);
    return () => {
      ipc.removeListenerByToken?.('voice:ptt-start', T);
      ipc.removeListenerByToken?.('voice:ptt-stop', T);
      ipc.removeListenerByToken?.('ptt:interim', T);
      ipc.removeListenerByToken?.('ptt:transcript', T);
    };
  }, []);

  // PTT dictation language — pref lives in main (settings.json); changes
  // arrive as voice:lang-state broadcasts.
  const [voiceLang, setVoiceLang] = useState<string | null>(null);
  useEffect(() => {
    const ipc = (window as any).electron?.ipcRenderer;
    if (!ipc) return;
    const T = 'inputbar-vlang';
    const onLang = (d: { lang?: string | null }) => setVoiceLang(d?.lang ?? null);
    ipc.on('voice:lang-state', onLang, T);
    ipc.send('voice:lang'); // pull the current pref on mount
    return () => { ipc.removeListenerByToken?.('voice:lang-state', T); };
  }, []);

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
    // Debug mode: Enter executes the terminal command. Arrow keys always move
    // the text cursor — history recall on ArrowUp/Down was removed (it kept
    // hijacking navigation while editing).
    if (isDebugMode) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const command = promptText.trim();
        if (command) {
          setTerminalHistory(prev => [command, ...prev].slice(0, 50));
          aiActivityPanelRef.current?.executeCommand(command);
          setPromptText('');
        }
        return;
      }
    }

    // Normal mode: standard submit (Shift+Enter inserts a newline).
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
            style={{
              backgroundColor: 'rgba(34, 211, 238, 0.14)',
              border: '1px solid rgba(34, 211, 238, 0.35)',
              color: '#67e8f9',
            }}
          >
            {/* Chip body surfaces the Plan Readiness card in the results feed;
                the × is the only exit-planning affordance. */}
            <button
              type="button"
              className="flex items-center gap-1 hover:opacity-80"
              title={`Show plan readiness${planning.planName ? ` — ${planning.planName}` : ''}`}
              style={{ background: 'none', border: 'none', color: 'inherit', padding: 0, cursor: 'pointer' }}
              onClick={() => {
                try {
                  (window as any).electron?.ipcRenderer?.send('plan:check:action', {
                    planId: planning.planId || null,
                    planFile: planning.planFile || null,
                    action: 'show-check',
                  });
                } catch (_) {}
              }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 2L3 6v15l6-4 6 4 6-4V2l-6 4-6-4z"/><polyline points="9 2 9 17"/><polyline points="15 6 15 21"/>
              </svg>
              <span className="truncate max-w-[180px]">
                Planning{planning.planName ? `: ${planning.planName}` : ' mode'}
              </span>
            </button>
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
              title="Paste highlighted text into the overlay (tap Right ⌥)"
              style={{
                backgroundColor: 'rgba(251, 146, 60, 0.14)',
                border: '1px solid rgba(251, 146, 60, 0.35)',
                color: '#fdba74',
                cursor: 'pointer',
              }}
            >
              <ClipboardPasteIcon />
              <span>Paste context</span>
              <RoptKeyIcon size={16} tone="amber" detail="icon" />
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

      {/* ROpt-hold PTT: amber key + live interim while dictating */}
      {pttActive && (
        <div
          className="mb-3 flex items-center justify-center gap-2 px-2"
          style={{ minHeight: '24px' }}
        >
          <RoptKeyIcon size={20} tone="amber" pulse />
          <span
            className="text-sm"
            style={{
              color: pttInterim ? '#fbbf24' : '#9ca3af',
              fontStyle: pttInterim ? 'italic' : 'normal',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={pttInterim || 'Listening…'}
          >
            {pttInterim || 'Listening…'}
          </span>
        </div>
      )}

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
            spellCheck
            lang="en"
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

      {/* Action Buttons — three zones: left group (Avatar, Attach, Planning),
          centered Option legend, right-justified (Language, Voice, Send). */}
      <div className="relative flex items-center gap-2">
        <div className="flex items-center gap-2 shrink-0">
        {/* Avatar mode toggle — switches the overlay for the Optyons
            companion avatar on the GhostLayer. */}
        <button
          onClick={() => (window as any).electron?.ipcRenderer?.send('avatar:toggle')}
          className="relative flex items-center justify-center w-9 h-9 p-0 rounded-lg text-sm font-medium border transition-all shrink-0"
          style={{
            backgroundColor: avatarMode ? 'rgba(96,165,250,0.18)' : 'rgba(255,255,255,0.05)',
            color: avatarMode ? '#60a5fa' : '#9ca3af',
            borderColor: avatarMode ? 'rgba(96,165,250,0.45)' : 'rgba(255,255,255,0.1)',
          }}
          title={avatarMode ? 'Exit Avatar mode — back to overlay' : 'Avatar mode — the Optyons companion takes over'}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12.5" r="8" />
            <circle cx="8.8" cy="10" r="1" fill="currentColor" stroke="none" />
            <circle cx="15.2" cy="10" r="1" fill="currentColor" stroke="none" />
            <path d="M8 15 Q12 18.5 16 15" />
          </svg>
        </button>

        {/* Attach Button */}
        <button
          onClick={onAttachClick}
          className="flex items-center justify-center w-9 h-9 p-0 rounded-lg text-sm font-medium bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10 transition-all shrink-0"
          title="Attach files"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        {/* Planning-mode toggle — orbiting cyan ring while active. */}
        <div className="relative flex items-center shrink-0">
          {planning?.active && <span className="planning-toggle-ring" aria-hidden="true" />}
          <button
            onClick={onPlanningToggle}
            className="relative flex items-center justify-center w-9 h-9 p-0 rounded-lg text-sm font-medium border transition-all shrink-0"
            style={{
              backgroundColor: planning?.active ? 'rgba(34,211,238,0.15)' : 'rgba(255,255,255,0.05)',
              color: planning?.active ? '#22d3ee' : '#9ca3af',
              borderColor: planning?.active ? 'rgba(34,211,238,0.4)' : 'rgba(255,255,255,0.1)',
            }}
            title={planning?.active ? 'Exit planning mode' : 'Start a plan — multi-task prompts draft a plan first'}
          >
            {/* Map glyph with a deepened ±4-unit fold — the previous path was
                also malformed (never reached x=21), rendering squished in the
                left half of the viewBox. */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M9 2L3 6v15l6-4 6 4 6-4V2l-6 4-6-4z"/><polyline points="9 2 9 17"/><polyline points="15 6 15 21"/>
            </svg>
          </button>
        </div>
        </div>

        {/* Compact Option control — centered between the left group and the
            right-justified voice cluster; the trigger keeps the legend. */}
        <div
          className="absolute left-1/2 -translate-x-1/2 flex items-center"
          onMouseEnter={() => setLegendOpen(true)}
          onMouseLeave={() => setLegendOpen(false)}
        >
          <button
            type="button"
            onClick={() => setLegendOpen(v => !v)}
            className="flex items-center justify-center w-9 h-9 text-base font-medium transition-all"
            style={{
              color: legendOpen ? '#60a5fa' : '#9ca3af',
              borderColor: legendOpen ? 'rgba(96,165,250,0.45)' : 'rgba(255,255,255,0.1)',
            }}
            title="Option-key shortcuts"
            aria-label="Option-key shortcuts"
          >
            ⌥
          </button>
          {legendOpen && (
            <div
              className="absolute flex flex-col gap-2 px-3 py-2.5 rounded-lg"
              style={{
                bottom: 46,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 60,
                width: 330,
                backgroundColor: 'rgba(12,16,24,0.96)',
                border: '1px solid rgba(255,255,255,0.14)',
                boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
              }}
            >
              {[
                { keys: <><RoptKeyIcon size={22} /><span>double-tap</span></>, desc: 'prompt · focus input' },
                { keys: <><RoptKeyIcon size={22} /><span>hold</span></>, desc: 'talk (PTT)' },
                { keys: <><RoptKeyIcon size={22} /><span>hold 3s</span></>, desc: 'cancel automation' },
                { keys: <><RoptKeyIcon size={22} /><span>tap</span></>, desc: 'confirm · approve · run plan · mute' },
                { keys: <><RoptKeyIcon size={22} /><span>tap (scrolled up)</span></>, desc: 'jump to latest' },
                { keys: <><RoptKeyIcon size={22} mod="shift" /><span>hold +</span><RoptKeyIcon size={22} /><span>tap</span></>, desc: 'show / hide' },
                { keys: <><RoptKeyIcon size={22} mod="shift" /><span>hold +</span><RoptKeyIcon size={22} /><span>double-tap</span></>, desc: 'history' },
                { keys: <><RoptKeyIcon size={22} side="left" /><span>hold +</span><RoptKeyIcon size={22} /><span>tap</span></>, desc: 'cancel / exit' },
              ].map((row, i) => (
                <div key={i} className="flex items-center justify-between" style={{ fontSize: 11.5 }}>
                  <span className="flex items-center gap-1.5" style={{ color: '#d1d5db', fontWeight: 500, whiteSpace: 'nowrap' }}>{row.keys}</span>
                  <span style={{ color: '#6b7280', textAlign: 'right' }}>{row.desc}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right group — Language (ambers with the voice button while PTT
            is held), Voice, Send. */}
        <div className="ml-auto flex items-center gap-2 shrink-0">
        <VoiceLangPicker
          lang={voiceLang}
          highlighted={pttActive}
          onPick={(code) => { setVoiceLang(code); (window as any).electron?.ipcRenderer?.send('voice:set-lang', { lang: code }); }}
          buttonStyle={{
            width: '28px', height: '36px', borderRadius: '8px',
            background: 'transparent', fontSize: 14,
          }}
        />
        {/* Voice/PTT */}
        <VoiceButton compact={true} icon="voice" ptt={pttActive} style={{ width: '36px', height: '36px', borderRadius: '8px' }} />

        {/* Submit/Cancel Button - Matching StandalonePromptCapture style */}
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
          {isSubmitting && (
            <div
              className="cancel-glow-ring group-hover:active"
              style={{ borderRadius: '8px' }}
            />
          )}
          {isSubmitting ? (
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
        </div>
      </div>
    </div>
  );
}

export const PromptInputBar = forwardRef(PromptInputBarImpl);
