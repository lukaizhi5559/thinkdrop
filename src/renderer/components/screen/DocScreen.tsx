import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ScreenOutput } from './types';
import { MOOD_ACCENT } from './types';
import RichContentRenderer from '../rich-content/RichContentRenderer';

const ipcRenderer = (window as any).electron?.ipcRenderer;

const MAX_CARD_VH = 0.84;
const SCROLL_PX_PER_SEC = 46;
const SCROLL_UP_PX_PER_SEC = 140;
const HOLD_MS_TOP = 2000;
const HOLD_MS_BOTTOM = 1400;
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const BASE_FONT = 15;

/**
 * DocScreen — kind:'doc' (and kind:'text' routed through it): a Claude-style
 * artifact card. Header bar carries the title, a format chip, and the action
 * cluster (Copy menu, Print, Edit/Preview switch). The body renders full
 * markdown via RichContentRenderer; Edit swaps in a plaintext contentEditable
 * source view and, when `doc.sourcePath` is set, saves back to the file on
 * exit ('ghostlayer:doc-save').
 *
 * Interaction parity with TextScreen: hover-capture lifts click-through only
 * while over the card; arrow keys scroll, Cmd±/Cmd0 zoom, Space toggles the
 * ping-pong autoplay — all via the capability → global-shortcut pipeline.
 *
 * Esc routing: while editing, main forwards Esc here as nav 'exit-edit'
 * (screen:doc-nav) which commits the buffer and drops back to preview; a
 * second Esc clears the display.
 */
export function DocScreen({ output, animateClass }: { output: ScreenOutput; animateClass: string }) {
  const accent = MOOD_ACCENT[output.mood] || MOOD_ACCENT.neutral;
  const doc: Partial<import('./types').ScreenDoc> = output.doc || {};
  const editable = !!doc.editable;
  const rawMd = doc.markdown ?? output.text ?? '';
  const plainText = !doc.markdown && !!output.text;

  const cardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef<HTMLDivElement>(null);
  const playRaf = useRef(0);

  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [markdown, setMarkdown] = useState(rawMd);
  const [dirty, setDirty] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [userScale, setUserScale] = useState(1);
  const [overflowPx, setOverflowPx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [scrollFrac, setScrollFrac] = useState(0);

  // Refs mirror the latest state so IPC handlers + unmount cleanup see it.
  const modeRef = useRef(mode);
  const dirtyRef = useRef(dirty);
  modeRef.current = mode;
  dirtyRef.current = dirty;

  // Non-markdown text displays arrive pre-wrapped in a fence by ScreenStage,
  // so `markdown` is always markdown here.
  const shown = markdown;
  const scrolling = overflowPx > 0;
  const editing = mode === 'source';

  // ── Edit lifecycle ────────────────────────────────────────────────────────
  const commitSource = (): string => {
    const el = sourceRef.current;
    const next = el ? el.innerText.replace(/\r/g, '') : markdown;
    return next;
  };

  const saveIfDirty = (content: string) => {
    if (!dirtyRef.current || !doc.sourcePath) { setDirty(false); dirtyRef.current = false; return; }
    try {
      ipcRenderer?.send('ghostlayer:doc-save', { id: output.id, sourcePath: doc.sourcePath, content });
      setFlash('Saved');
      setTimeout(() => setFlash(null), 1800);
    } catch (_) {}
    setDirty(false);
    dirtyRef.current = false;
  };

  const enterEdit = () => {
    if (!editable) return;
    setMode('source');
    modeRef.current = 'source';
    try { ipcRenderer?.send('ghostlayer:edit-focus', { id: output.id, on: true }); } catch (_) {}
  };

  const exitEdit = () => {
    if (modeRef.current !== 'source') return;
    const next = commitSource();
    setMarkdown(next);
    setMode('preview');
    modeRef.current = 'preview';
    saveIfDirty(next);
    try { ipcRenderer?.send('ghostlayer:edit-focus', { id: output.id, on: false }); } catch (_) {}
  };

  // Esc-in-edit arrives as a re-broadcast nav event from main (via ScreenStage).
  useEffect(() => {
    const onNav = (e: Event) => {
      const dir = (e as CustomEvent).detail?.dir;
      if (dir === 'exit-edit') exitEdit();
      else if (dir === 'doc-saved') { setFlash('Saved'); setTimeout(() => setFlash(null), 1800); }
    };
    window.addEventListener('screen:doc-nav', onNav);
    return () => window.removeEventListener('screen:doc-nav', onNav);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown]);

  // Focus the source view when it mounts (main lifts focusable via edit-focus).
  useEffect(() => {
    if (editing && sourceRef.current) {
      try { sourceRef.current.focus(); } catch (_) {}
    }
  }, [editing]);

  // Save on unmount if the display is cleared mid-edit.
  useEffect(() => {
    return () => {
      if (modeRef.current === 'source') {
        const next = sourceRef.current ? sourceRef.current.innerText.replace(/\r/g, '') : '';
        if (dirtyRef.current && doc.sourcePath) {
          try { ipcRenderer?.send('ghostlayer:doc-save', { id: output.id, sourcePath: doc.sourcePath, content: next }); } catch (_) {}
        }
        try { ipcRenderer?.send('ghostlayer:edit-focus', { id: output.id, on: false }); } catch (_) {}
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [output.id]);

  // ── Measure / scroll / zoom / autoplay (TextScreen model) ────────────────
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const overflow = sc.scrollHeight - sc.clientHeight - 1;
    setOverflowPx(Math.max(0, overflow));
  }, [userScale, shown, mode, output.id]);

  useEffect(() => {
    if (!playing || !scrolling || editing) return;
    let dir: 1 | -1 = 1;
    let holdUntil = performance.now() + HOLD_MS_TOP;
    let last = performance.now();
    const step = (now: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const dt = Math.min(50, now - last);
      last = now;
      if (now >= holdUntil) {
        const pps = dir === 1 ? SCROLL_PX_PER_SEC : SCROLL_UP_PX_PER_SEC;
        el.scrollTop += (pps * dt / 1000) * dir;
        const max = el.scrollHeight - el.clientHeight;
        if (el.scrollTop >= max - 1 && dir === 1) {
          el.scrollTop = max; dir = -1; holdUntil = now + HOLD_MS_BOTTOM;
        } else if (el.scrollTop <= 0 && dir === -1) {
          el.scrollTop = 0; dir = 1; holdUntil = now + HOLD_MS_TOP;
        }
      }
      playRaf.current = requestAnimationFrame(step);
    };
    playRaf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(playRaf.current);
  }, [playing, scrolling, editing]);

  useEffect(() => {
    const keys = ['up', 'down', 'zoom_in', 'zoom_out', 'zoom_reset'];
    if (scrolling) keys.push('play');
    try { ipcRenderer?.send('ghostlayer:display-capabilities', { id: output.id, keys }); } catch (_) {}
    return () => {
      try { ipcRenderer?.send('ghostlayer:display-capabilities', { id: output.id, keys: [] }); } catch (_) {}
    };
  }, [scrolling, output.id]);

  useEffect(() => {
    const onKey = (e: Event) => {
      const el = scrollRef.current;
      if (!el) return;
      const dir = (e as CustomEvent).detail?.dir === 'up' ? -1 : 1;
      el.scrollTop += dir * 48;
    };
    window.addEventListener('screen:text-scroll', onKey);
    return () => window.removeEventListener('screen:text-scroll', onKey);
  }, []);

  useEffect(() => {
    const onZoom = (e: Event) => {
      const dir = (e as CustomEvent).detail?.dir;
      if (dir === 'zoom_reset') {
        setUserScale(1);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        return;
      }
      setUserScale(prev =>
        Math.min(ZOOM_MAX, Math.max(ZOOM_MIN,
          Math.round((dir === 'zoom_in' ? prev * ZOOM_STEP : prev / ZOOM_STEP) * 100) / 100)));
    };
    window.addEventListener('screen:text-zoom', onZoom);
    return () => window.removeEventListener('screen:text-zoom', onZoom);
  }, []);

  useEffect(() => {
    const onPlay = () => setPlaying(p => !p);
    window.addEventListener('screen:text-play', onPlay);
    return () => window.removeEventListener('screen:text-play', onPlay);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollFrac(max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0);
  };

  // ── Header actions ────────────────────────────────────────────────────────
  const sendExport = (action: 'download' | 'pdf' | 'publish') => {
    setMenuOpen(false);
    try {
      ipcRenderer?.send('ghostlayer:doc-export', {
        id: output.id,
        action,
        title: output.title || 'document',
        markdown: shown,
        html: previewRef.current?.innerHTML || '',
      });
    } catch (_) {}
  };

  const copyText = () => {
    setMenuOpen(false);
    try { ipcRenderer?.send('clipboard:write-text', shown); } catch (_) {}
    setFlash('Copied');
    setTimeout(() => setFlash(null), 1400);
  };

  const hoverProps = {
    onMouseEnter: () => { try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: true }); } catch (_) {} },
    onMouseLeave: () => { try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: false }); setMenuOpen(false); } catch (_) {} },
  };

  const zoomPct = Math.round(userScale * 100);
  const fmt = doc.format || (plainText ? 'TXT' : 'MD');

  return (
    <div
      ref={cardRef}
      className={animateClass}
      {...hoverProps}
      style={{
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        width: 'min(920px, 78vw)',
        maxHeight: `${MAX_CARD_VH * 100}vh`,
        borderRadius: 18,
        overflow: 'hidden',
        background: 'rgba(13, 17, 26, 0.92)',
        border: `1px solid ${accent}40`,
        boxShadow: `0 18px 70px rgba(0,0,0,0.6), 0 0 40px ${accent}18`,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        position: 'relative',
      }}
    >
      {/* ── Header bar — Claude-style artifact chrome ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px 10px 18px',
          borderBottom: '1px solid rgba(148,163,184,0.14)',
          background: 'rgba(20, 25, 38, 0.85)',
          flexShrink: 0,
          userSelect: 'none',
        }}
      >
        <span style={{
          padding: '3px 8px',
          borderRadius: 6,
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: '0.1em',
          color: accent,
          background: `${accent}1f`,
          border: `1px solid ${accent}44`,
        }}>
          {fmt}
        </span>
        <div style={{
          flex: 1,
          minWidth: 0,
          color: '#e5e7eb',
          fontSize: 13,
          fontWeight: 650,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {output.title || 'Document'}
          {dirty && <span style={{ color: '#fbbf24', marginLeft: 6 }} title="Unsaved changes">●</span>}
          {flash && <span style={{ color: '#4ade80', marginLeft: 8, fontSize: 11, fontWeight: 600 }}>{flash}</span>}
        </div>

        {/* Preview / Edit switch */}
        {editable && (
          <div style={{ display: 'flex', borderRadius: 8, border: '1px solid rgba(148,163,184,0.25)', overflow: 'hidden' }}>
            {(['preview', 'source'] as const).map(m => (
              <button
                key={m}
                onClick={() => (m === 'source' ? enterEdit() : exitEdit())}
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  fontWeight: 650,
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  background: (m === 'source') === editing ? `${accent}33` : 'transparent',
                  color: (m === 'source') === editing ? accent : '#94a3b8',
                }}
              >
                {m === 'preview' ? 'Preview' : 'Edit'}
              </button>
            ))}
          </div>
        )}

        {/* Copy menu */}
        <div style={{ position: 'relative' }}>
          <HeaderBtn accent={accent} onClick={() => setMenuOpen(o => !o)}>Copy ▾</HeaderBtn>
          {menuOpen && (
            <div style={{
              position: 'absolute',
              top: '110%',
              right: 0,
              zIndex: 5,
              minWidth: 190,
              borderRadius: 10,
              overflow: 'hidden',
              background: 'rgba(17, 22, 34, 0.97)',
              border: '1px solid rgba(148,163,184,0.3)',
              boxShadow: '0 10px 32px rgba(0,0,0,0.55)',
            }}>
              <MenuItem onClick={copyText}>Copy text</MenuItem>
              <MenuItem onClick={() => sendExport('download')}>Download .md</MenuItem>
              <MenuItem onClick={() => sendExport('pdf')}>Print → save as PDF</MenuItem>
              <MenuItem onClick={() => sendExport('publish')}>Publish snapshot</MenuItem>
            </div>
          )}
        </div>

        <HeaderBtn accent={accent} onClick={() => sendExport('pdf')} title="Print / save as PDF">Print</HeaderBtn>

        {/* Zoom + autoplay cluster */}
        <HeaderBtn accent={accent} onClick={() => setUserScale(s => Math.max(ZOOM_MIN, Math.round(s / ZOOM_STEP * 100) / 100))} title="Smaller (⌘−)">A−</HeaderBtn>
        <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 34, textAlign: 'center' }}>{zoomPct}%</span>
        <HeaderBtn accent={accent} onClick={() => setUserScale(s => Math.min(ZOOM_MAX, Math.round(s * ZOOM_STEP * 100) / 100))} title="Bigger (⌘=)">A+</HeaderBtn>
        <HeaderBtn
          accent={accent}
          onClick={() => setPlaying(p => !p)}
          disabled={!scrolling}
          title={scrolling ? (playing ? 'Pause auto-scroll (Space)' : 'Play auto-scroll (Space)') : 'Fits — nothing to scroll'}
        >
          {playing ? '❚❚' : '▶'}
        </HeaderBtn>
      </div>

      {/* ── Body ── */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          overflowY: scrolling ? 'auto' : 'hidden',
          overflowX: 'hidden',
          flex: 1,
          minHeight: 0,
          scrollbarWidth: 'none',
          msOverflowStyle: 'none',
          padding: '26px 34px',
        }}
      >
        {editing ? (
          <div
            ref={sourceRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onInput={() => { setDirty(true); dirtyRef.current = true; }}
            style={{
              outline: 'none',
              color: '#e5e7eb',
              fontSize: 13,
              lineHeight: 1.6,
              fontFamily: 'ui-monospace, Menlo, monospace',
              whiteSpace: 'pre-wrap',
              minHeight: '100%',
            }}
          >
            {markdown}
          </div>
        ) : (
          <div
            ref={previewRef}
            style={{
              fontSize: Math.round(BASE_FONT * userScale),
              lineHeight: 1.6,
              color: '#f3f4f6',
            }}
          >
            <RichContentRenderer content={shown} animated={false} />
          </div>
        )}
      </div>

      {/* Scroll progress — thin accent line on the left edge. */}
      {scrolling && (
        <div style={{
          position: 'absolute',
          left: 0,
          top: 48,
          bottom: 12,
          width: 3,
          borderRadius: 999,
          background: 'rgba(148,163,184,0.15)',
          overflow: 'hidden',
        }}>
          <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: `${Math.round(scrollFrac * 100)}%`,
            background: accent,
            borderRadius: 999,
            transition: 'height 0.15s ease-out',
          }} />
        </div>
      )}
    </div>
  );
}

function HeaderBtn({ children, accent, onClick, disabled, title }: {
  children: React.ReactNode; accent: string; onClick: () => void; disabled?: boolean; title?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        height: 26,
        padding: '0 9px',
        borderRadius: 7,
        border: `1px solid ${accent}55`,
        background: 'rgba(10,14,22,0.7)',
        color: disabled ? '#475569' : '#e5e7eb',
        fontSize: 12,
        fontWeight: 700,
        fontFamily: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 14px',
        border: 'none',
        background: 'transparent',
        color: '#e5e7eb',
        fontSize: 12,
        fontWeight: 600,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(96,165,250,0.16)'; }}
      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}
