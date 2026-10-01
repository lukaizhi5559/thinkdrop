import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;
import type { ScreenOutput } from './types';
import { MOOD_ACCENT } from './types';
import { EmojiGlyph } from './EmojiGlyph';

const FONT_SIZES: Record<string, number> = { md: 28, lg: 44, xl: 64, hero: 96 };
const MIN_FONT = 22;
/** Fraction of viewport height the card may occupy before scrolling kicks in. */
const MAX_CARD_VH = 0.82;
/** Auto-scroll speed for overflowing passages, px per second. */
const SCROLL_PX_PER_SEC = 46;
const SCROLL_UP_PX_PER_SEC = 140; // rewind pass is faster than the read pass
const HOLD_MS_TOP = 2000;
const HOLD_MS_BOTTOM = 1400;
const ZOOM_STEP = 1.25;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;

/**
 * TextScreen — kind:'text': left-aligned reading card on a soft scrim.
 *
 * Interaction model: the card hover-captures pointer input
 * (ghostlayer:hover-interactive) so trackpad scroll, text selection, and the
 * control cluster all work while the cursor is over it; the rest of the
 * screen stays click-through. Arrow keys scroll, Cmd±/Cmd0 zoom, Space
 * toggles autoplay — all via the capability → global-shortcut pipeline.
 *
 * Overflowing text scrolls inside a real overflow container (scrollTop), not
 * a transform. Autoplay (rAF scroll loop) starts PAUSED — press the play
 * button or Space to animate; it ping-pongs top→bottom→top with holds.
 *
 * text supports markdown-lite: **bold**, *italic*, and line breaks.
 *
 * Fit behaviour (output.fit):
 *   'auto'   — shrink the font stepwise (down to MIN_FONT) until the content
 *              fits ~82vh; if it still overflows, the passage scrolls.
 *   'scroll' — skip shrinking to fit; keep the requested size and scroll.
 */
export function TextScreen({ output, animateClass }: { output: ScreenOutput; animateClass: string }) {
  const accent = MOOD_ACCENT[output.mood] || MOOD_ACCENT.neutral;
  const baseSize = FONT_SIZES[output.fontSize || 'xl'] || FONT_SIZES.xl;
  const forceScroll = output.fit === 'scroll';

  const cardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null); // the scrollable text container
  const playRaf = useRef(0);

  const [fontSize, setFontSize] = useState(baseSize); // fitted base size
  const [userScale, setUserScale] = useState(1);      // Cmd± multiplier
  const [overflowPx, setOverflowPx] = useState(0);    // >0 → scrollable
  const [playing, setPlaying] = useState(false);      // autoplay off by default
  const [scrollFrac, setScrollFrac] = useState(0);    // progress indicator
  const shrinkGuard = useRef(0);

  const effSize = Math.round(fontSize * userScale);
  const scrolling = overflowPx > 0;

  // Measure + shrink loop. Runs when fontSize/userScale change until content
  // fits or the floor is reached; remaining overflow becomes scrollable.
  // userScale is strictly multiplicative over the fitted base — the shrink
  // loop only operates at scale 1 so zooming can't fight it.
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const overflow = sc.scrollHeight - sc.clientHeight - 1;
    if (forceScroll) {
      setOverflowPx(Math.max(0, overflow));
      return;
    }
    if (overflow <= 0) {
      setOverflowPx(0);
      return;
    }
    if (userScale === 1 && fontSize > MIN_FONT && shrinkGuard.current < 12) {
      shrinkGuard.current += 1;
      setFontSize(prev => Math.max(MIN_FONT, Math.floor(prev * 0.85)));
      return; // re-measure at the smaller size
    }
    setOverflowPx(overflow);
  }, [fontSize, userScale, forceScroll, output.id, effSize]);

  // Autoplay: rAF scroll loop — down at reading pace, hold, rewind faster,
  // hold, repeat. Manual scrolling while paused never fights this loop.
  useEffect(() => {
    if (!playing || !scrolling) return;
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
          el.scrollTop = max;
          dir = -1;
          holdUntil = now + HOLD_MS_BOTTOM;
        } else if (el.scrollTop <= 0 && dir === -1) {
          el.scrollTop = 0;
          dir = 1;
          holdUntil = now + HOLD_MS_TOP;
        }
      }
      playRaf.current = requestAnimationFrame(step);
    };
    playRaf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(playRaf.current);
  }, [playing, scrolling]);

  // Report key capabilities — arrows only when scrollable, zoom + play always
  // (zooming in past fit makes a fitting text scrollable). Retract on unmount.
  useEffect(() => {
    const keys = ['up', 'down', 'zoom_in', 'zoom_out', 'zoom_reset'];
    if (scrolling) keys.push('play');
    try {
      ipcRenderer?.send('ghostlayer:display-capabilities', { id: output.id, keys });
    } catch (_) {}
    return () => {
      try { ipcRenderer?.send('ghostlayer:display-capabilities', { id: output.id, keys: [] }); } catch (_) {}
    };
  }, [scrolling, output.id]);

  // Arrow-key scroll — ScreenStage re-broadcasts global Up/Down.
  useEffect(() => {
    const onKey = (e: Event) => {
      const el = scrollRef.current;
      if (!el) return;
      const dir = (e as CustomEvent).detail?.dir === 'up' ? -1 : 1;
      el.scrollTop += dir * effSize * 3;
    };
    window.addEventListener('screen:text-scroll', onKey);
    return () => window.removeEventListener('screen:text-scroll', onKey);
  }, [effSize]);

  // Cmd±/Cmd0 zoom — userScale multiplies the fitted base size.
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

  // Space toggles autoplay (capability only reported when scrollable).
  useEffect(() => {
    const onPlay = () => setPlaying(p => !p);
    window.addEventListener('screen:text-play', onPlay);
    return () => window.removeEventListener('screen:text-play', onPlay);
  }, []);

  // Trackpad scroll is native (overflow container) — nothing to handle here.
  // Scroll progress for the edge indicator.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setScrollFrac(max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0);
  };

  // Hover-capture: while the cursor is over the card, main lifts
  // click-through so wheel/trackpad events and control clicks reach us.
  const hoverProps = {
    onMouseEnter: () => { try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: true }); } catch (_) {} },
    onMouseLeave: () => { try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: false }); } catch (_) {} },
  };

  const zoomPct = Math.round(userScale * 100);
  const canPlay = scrolling;

  return (
    <div
      ref={cardRef}
      className={animateClass}
      {...hoverProps}
      style={{
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'stretch',
        gap: 22,
        width: 'min(1100px, 80vw)',
        textAlign: 'left',
        padding: '40px 52px',
        borderRadius: 28,
        background: 'rgba(8, 12, 20, 0.55)',
        border: `1px solid ${accent}44`,
        boxShadow: `0 8px 60px rgba(0,0,0,0.5), 0 0 40px ${accent}22`,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        maxHeight: `${MAX_CARD_VH * 100}vh`,
        position: 'relative',
      }}
    >
      {/* Text-adjust control cluster — hover-capture makes these clickable. */}
      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          zIndex: 2,
        }}
      >
        <CtlBtn
          label={playing ? '❚❚' : '▶'}
          title={canPlay ? (playing ? 'Pause auto-scroll (Space)' : 'Play auto-scroll (Space)') : 'Fits — nothing to scroll'}
          accent={accent}
          disabled={!canPlay}
          onClick={() => setPlaying(p => !p)}
        />
        <CtlBtn
          label="A−"
          title="Smaller text (⌘−)"
          accent={accent}
          disabled={userScale <= ZOOM_MIN}
          onClick={() => setUserScale(s => Math.max(ZOOM_MIN, Math.round(s / ZOOM_STEP * 100) / 100))}
        />
        <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 36, textAlign: 'center', fontFamily: 'system-ui' }}>
          {zoomPct}%
        </span>
        <CtlBtn
          label="A+"
          title="Bigger text (⌘=)"
          accent={accent}
          disabled={userScale >= ZOOM_MAX}
          onClick={() => setUserScale(s => Math.min(ZOOM_MAX, Math.round(s * ZOOM_STEP * 100) / 100))}
        />
        <CtlBtn
          label="⟲"
          title="Reset zoom + scroll (⌘0)"
          accent={accent}
          onClick={() => { setUserScale(1); if (scrollRef.current) scrollRef.current.scrollTop = 0; }}
        />
      </div>

      {/* Scroll progress bar — thin accent line on the card's left edge. */}
      {scrolling && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 14,
            bottom: 14,
            width: 3,
            borderRadius: 999,
            background: 'rgba(148,163,184,0.15)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: `${Math.round(scrollFrac * 100)}%`,
              background: accent,
              borderRadius: 999,
              transition: 'height 0.15s ease-out',
            }}
          />
        </div>
      )}

      {output.emoji && <EmojiGlyph emoji={output.emoji} accent={accent} size={72} />}
      {output.title && (
        <div
          style={{
            color: accent,
            fontSize: Math.max(16, effSize * 0.32),
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            textShadow: `0 0 14px ${accent}66`,
            flexShrink: 0,
          }}
        >
          {output.title}
        </div>
      )}
      {output.text && (
        <div
          ref={scrollRef}
          onScroll={onScroll}
          style={{
            overflowY: scrolling ? 'auto' : 'hidden',
            overflowX: 'hidden',
            flexShrink: 1,
            minHeight: 0,
            scrollbarWidth: 'none',
            msOverflowStyle: 'none',
          }}
        >
          <div
            style={{
              color: '#f3f4f6',
              fontSize: effSize,
              fontWeight: 700,
              lineHeight: 1.25,
              fontFamily: 'system-ui, -apple-system, sans-serif',
              textShadow: '0 2px 20px rgba(0,0,0,0.6)',
              whiteSpace: 'pre-wrap',
              textAlign: 'left',
            }}
          >
            {renderLite(output.text)}
          </div>
        </div>
      )}
    </div>
  );
}

/** Small pill button for the text-adjust control cluster. */
function CtlBtn({ label, title, accent, onClick, disabled }: {
  label: string; title: string; accent: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        minWidth: 30,
        height: 26,
        padding: '0 8px',
        borderRadius: 7,
        border: `1px solid ${accent}55`,
        background: 'rgba(10,14,22,0.7)',
        color: disabled ? '#475569' : '#e5e7eb',
        fontSize: 12,
        fontWeight: 700,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {label}
    </button>
  );
}

/** markdown-lite: **bold**, *italic* — line breaks handled by pre-wrap. */
function renderLite(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else parts.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
