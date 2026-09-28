import React, { useLayoutEffect, useRef, useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;
import type { ScreenOutput } from './types';
import { MOOD_ACCENT } from './types';
import { EmojiGlyph } from './EmojiGlyph';

const FONT_SIZES: Record<string, number> = { md: 28, lg: 44, xl: 64, hero: 96 };
const MIN_FONT = 22;
/** Fraction of viewport height the card may occupy before scrolling kicks in. */
const MAX_CARD_VH = 0.82;
/** Scroll speed for overflowing passages, px per second. */
const SCROLL_PX_PER_SEC = 46;
const SCROLL_HOLD_FRAC = 0.12; // hold at start/end of each scroll pass

/**
 * TextScreen — kind:'text': hero text on a soft scrim, tinted by mood,
 * animated by animate.css classes. An `emoji` field renders the accent glyph
 * above the text (the "Are you still there? 🙂" moment).
 *
 * text supports markdown-lite: **bold**, *italic*, and line breaks.
 *
 * Fit behaviour (output.fit):
 *   'auto'   — shrink the font stepwise (down to MIN_FONT) until the content
 *              fits ~82vh; if it still overflows, auto-scroll the passage.
 *   'scroll' — skip shrinking to fit; keep the requested size and scroll.
 */
export function TextScreen({ output, animateClass }: { output: ScreenOutput; animateClass: string }) {
  const accent = MOOD_ACCENT[output.mood] || MOOD_ACCENT.neutral;
  const baseSize = FONT_SIZES[output.fontSize || 'xl'] || FONT_SIZES.xl;
  const forceScroll = output.fit === 'scroll';

  const cardRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const scrollAnim = useRef<Animation | null>(null);

  const [fontSize, setFontSize] = useState(baseSize);
  const [overflowPx, setOverflowPx] = useState(0); // >0 → scroll mode
  // Trackpad manual scroll: null = auto-marquee; a number = user-driven
  // offset (px). Set by wheel events; auto-scroll resumes after idle.
  const [manualY, setManualY] = useState<number | null>(null);
  const manualIdle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shrinkGuard = useRef(0);

  // Measure + shrink loop. Runs when fontSize changes until content fits or
  // the floor is reached; overflow beyond the floor becomes scroll distance.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const text = textRef.current;
    if (!card || !text) return;
    const avail = window.innerHeight * MAX_CARD_VH;
    // Budget for the text = card height minus everything else (title, emoji,
    // gaps, padding) — scroll distance is the text's overflow past that.
    const nonText = card.scrollHeight - text.scrollHeight;
    const overflow = text.scrollHeight - (avail - nonText);

    if (forceScroll) {
      setOverflowPx(Math.max(0, overflow));
      return;
    }
    if (overflow <= 0) {
      setOverflowPx(0);
      return;
    }
    if (fontSize > MIN_FONT && shrinkGuard.current < 12) {
      shrinkGuard.current += 1;
      setFontSize(prev => Math.max(MIN_FONT, Math.floor(prev * 0.85)));
      return; // re-measure at the smaller size
    }
    // At the floor and still overflowing → scroll the remainder.
    setOverflowPx(overflow);
  }, [fontSize, forceScroll, output.id]);

  // Scroll pass: translateY 0 → -overflowPx with holds at both ends, looping.
  // Suspended while the user is driving the scroll offset manually.
  useLayoutEffect(() => {
    scrollAnim.current?.cancel();
    scrollAnim.current = null;
    const text = textRef.current;
    if (!text || overflowPx <= 0 || manualY != null) {
      if (text && manualY != null) text.style.transform = `translateY(${-manualY}px)`;
      return;
    }
    text.style.transform = ''; // clear any manual offset before the anim resumes
    const scrollFrac = 1 - SCROLL_HOLD_FRAC * 2;
    const duration = Math.max(8000, (overflowPx / SCROLL_PX_PER_SEC) * 1000 / scrollFrac);
    scrollAnim.current = text.animate(
      [
        { transform: 'translateY(0px)', offset: 0 },
        { transform: 'translateY(0px)', offset: SCROLL_HOLD_FRAC },
        { transform: `translateY(${-overflowPx}px)`, offset: 1 - SCROLL_HOLD_FRAC },
        { transform: `translateY(${-overflowPx}px)`, offset: 1 },
      ],
      { duration, iterations: Infinity, easing: 'linear' },
    );
    return () => { scrollAnim.current?.cancel(); scrollAnim.current = null; };
  }, [overflowPx, manualY]);

  const scrolling = overflowPx > 0;

  // Trackpad scroll: wheel deltas drive a manual offset, clamped to the
  // overflow range. Marquee resumes ~4s after the last wheel event.
  const onWheel = (e: React.WheelEvent) => {
    if (!scrolling) return;
    if (manualIdle.current) clearTimeout(manualIdle.current);
    setManualY(prev => {
      const cur = prev ?? (() => {
        // Seed from the running animation's current offset so the transition
        // is seamless — WAAPI doesn't write inline style, read the computed
        // matrix's translateY.
        try {
          const cs = textRef.current ? getComputedStyle(textRef.current).transform : '';
          return cs && cs !== 'none' ? Math.abs(new DOMMatrixReadOnly(cs).m42) : 0;
        } catch (_) { return 0; }
      })();
      return Math.max(0, Math.min(overflowPx, cur + e.deltaY));
    });
    manualIdle.current = setTimeout(() => setManualY(null), 4000);
  };

  // Hover-capture: while the cursor is over a scrollable card, main lifts
  // click-through so wheel/trackpad events actually reach us. On leave the
  // window goes back to click-through (clicks pass to apps below).
  const hoverProps = scrolling ? {
    onWheel,
    onMouseEnter: () => { try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: true }); } catch (_) {} },
    onMouseLeave: () => { try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: false }); } catch (_) {} },
  } : {};

  return (
    <div
      ref={cardRef}
      className={animateClass}
      {...hoverProps}
      style={{
        pointerEvents: scrolling ? 'auto' : 'none',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 28,
        maxWidth: '80vw',
        textAlign: 'center',
        padding: '48px 56px',
        borderRadius: 28,
        background: 'rgba(8, 12, 20, 0.55)',
        border: `1px solid ${accent}44`,
        boxShadow: `0 8px 60px rgba(0,0,0,0.5), 0 0 40px ${accent}22`,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        // Clip content when scrolling so the passage slides inside the card.
        ...(scrolling ? { maxHeight: `${MAX_CARD_VH * 100}vh`, overflow: 'hidden' } : {}),
      }}
    >
      {output.emoji && <EmojiGlyph emoji={output.emoji} accent={accent} size={110} />}
      {output.title && (
        <div
          style={{
            color: accent,
            fontSize: Math.max(16, fontSize * 0.32),
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
          ref={textRef}
          style={{
            color: '#f3f4f6',
            fontSize,
            fontWeight: 700,
            lineHeight: 1.25,
            fontFamily: 'system-ui, -apple-system, sans-serif',
            textShadow: '0 2px 20px rgba(0,0,0,0.6)',
            whiteSpace: 'pre-wrap',
            willChange: scrolling ? 'transform' : undefined,
          }}
        >
          {renderLite(output.text)}
        </div>
      )}
    </div>
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
