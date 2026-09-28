import { useEffect, useRef, useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;
import type { ScreenOutput, ScreenSlide } from './types';
import { MOOD_ACCENT } from './types';
import { ChartScreen } from './ChartScreen';

/**
 * DeckScreen — slide presentations for kind:'deck'.
 *
 * Typed slides (title/body/bullets/image/chart — chart slides reuse the
 * ChartScreen primitives via a synthetic ScreenOutput) with slide/fade/zoom
 * transitions, slideMs auto-advance, progress dots, and a slide counter.
 * `deck.controls` renders left/right click zones for manual navigation —
 * the zones are the only pointer-interactive regions, so the rest of the
 * screen stays click-through unless the payload also sets `blocking`.
 * Esc clears via the main-process global shortcut.
 */

const TRANSITION_CLASS = {
  slide: 'deckInSlide',
  fade: 'deckInFade',
  zoom: 'deckInZoom',
} as const;

export function DeckScreen({ output, onDismiss }: { output: ScreenOutput; onDismiss?: () => void }) {
  const deck = output.deck;
  const accent = MOOD_ACCENT[output.mood] || '#60a5fa';
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeLock = useRef(0);

  const slides = deck?.slides || [];
  const count = slides.length;

  const go = (next: number, direction: 1 | -1) => {
    setDir(direction);
    setIdx(Math.max(0, Math.min(count - 1, next)));
  };

  // Auto-advance; on the last slide the stage's durationMs (if any) handles exit.
  useEffect(() => {
    if (!deck || deck.slideMs <= 0 || count <= 1) return;
    timer.current = setTimeout(() => {
      setIdx(i => {
        if (i + 1 >= count) return i; // hold on last slide until dismiss
        setDir(1);
        return i + 1;
      });
    }, deck.slideMs);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [idx, deck, count]);

  // Report nav capability — main registers global Left/Right while a
  // controls-deck is displayed (belt & suspenders alongside the payload
  // sniff; covers decks whose controls flag arrives post-mount).
  useEffect(() => {
    if (!deck?.controls) return;
    try {
      ipcRenderer?.send('ghostlayer:display-capabilities', { id: output.id, keys: ['left', 'right'] });
    } catch (_) {}
    return () => {
      try { ipcRenderer?.send('ghostlayer:display-capabilities', { id: output.id, keys: [] }); } catch (_) {}
    };
  }, [deck?.controls, output.id]);

  // Arrow keys — main registers global Left/Right while a controls-deck is
  // displayed; ScreenStage re-broadcasts them as this DOM event.
  useEffect(() => {
    if (!deck?.controls) return;
    const onNav = (e: Event) => {
      const dir = (e as CustomEvent).detail?.dir;
      setIdx(i => {
        const next = dir === 'prev' ? i - 1 : i + 1;
        if (next < 0 || next >= count) return i;
        setDir(dir === 'prev' ? -1 : 1);
        return next;
      });
    };
    window.addEventListener('screen:deck-nav', onNav);
    return () => window.removeEventListener('screen:deck-nav', onNav);
  }, [deck?.controls, count]);

  if (!deck || !count) return null;
  const slide = slides[idx];

  // Trackpad swipe → slide nav. Debounced: a swipe emits a burst of wheel
  // deltas; one threshold crossing = one slide.
  const onWheel = (e: React.WheelEvent) => {
    if (!deck.controls || Math.abs(e.deltaX) < 24) return;
    const now = Date.now();
    if (now - swipeLock.current < 400) return;
    swipeLock.current = now;
    setIdx(i => {
      const next = e.deltaX > 0 ? i + 1 : i - 1;
      if (next < 0 || next >= count) return i;
      setDir(e.deltaX > 0 ? 1 : -1);
      return next;
    });
  };

  return (
    <div
      onWheel={onWheel}
      style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <style>{`
        @keyframes deckInFade  { from { opacity: 0; } to { opacity: 1; } }
        @keyframes deckInSlide { from { opacity: 0; transform: translateX(${dir * 60}px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes deckInZoom  { from { opacity: 0; transform: scale(0.9); } to { opacity: 1; transform: scale(1); } }
      `}</style>

      {/* Slide body — remount per index so the transition replays. */}
      <div
        key={idx}
        style={{
          width: 'min(1100px, 78vw)',
          minHeight: '46vh',
          padding: '56px 64px',
          borderRadius: 28,
          background: 'rgba(10,14,22,0.82)',
          border: `1px solid ${accent}44`,
          boxShadow: '0 30px 90px rgba(0,0,0,0.6)',
          backdropFilter: 'blur(14px)',
          WebkitBackdropFilter: 'blur(14px)',
          animation: `${TRANSITION_CLASS[deck.transition] || 'deckInFade'} 0.45s ease both`,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <SlideBody slide={slide} accent={accent} output={output} />
      </div>

      {/* Progress dots + counter */}
      <div style={{
        position: 'absolute', bottom: 40, left: 0, right: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      }}>
        {slides.map((_, i) => (
          <div
            key={i}
            onClick={deck.controls ? () => go(i, i >= idx ? 1 : -1) : undefined}
            style={{
              width: i === idx ? 26 : 9, height: 9, borderRadius: 999,
              background: i === idx ? accent : 'rgba(148,163,184,0.4)',
              transition: 'all 0.3s ease',
              cursor: deck.controls ? 'pointer' : 'default',
              pointerEvents: deck.controls ? 'auto' : 'none',
            }}
          />
        ))}
        <span style={{
          marginLeft: 14, color: '#94a3b8', fontSize: 13, fontWeight: 600,
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}>
          {idx + 1} / {count}
        </span>
      </div>

      {/* Optional click zones for manual navigation. */}
      {deck.controls && idx > 0 && (
        <NavZone side="left" onClick={() => go(idx - 1, -1)} accent={accent} label="‹" />
      )}
      {deck.controls && idx < count - 1 && (
        <NavZone side="right" onClick={() => go(idx + 1, 1)} accent={accent} label="›" />
      )}
      {deck.controls && idx === count - 1 && onDismiss && (
        <div
          onClick={onDismiss}
          style={{
            position: 'absolute', top: 40, right: 44, padding: '8px 20px',
            borderRadius: 999, border: `1px solid ${accent}66`, color: accent,
            fontSize: 14, fontWeight: 600, cursor: 'pointer', pointerEvents: 'auto',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            background: 'rgba(10,14,22,0.6)',
          }}
        >
          Done ✕
        </div>
      )}
    </div>
  );
}

function NavZone({ side, onClick, accent, label }: {
  side: 'left' | 'right'; onClick: () => void; accent: string; label: string;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        position: 'absolute', top: 0, bottom: 0, [side]: 0, width: 110,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', pointerEvents: 'auto',
        color: accent, fontSize: 56, fontWeight: 300,
        fontFamily: 'system-ui, -apple-system, sans-serif',
        opacity: 0.55,
        background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, rgba(0,0,0,0.25), transparent)`,
      }}
    >
      {label}
    </div>
  );
}

function SlideBody({ slide, accent, output }: {
  slide: ScreenSlide; accent: string; output: ScreenOutput;
}) {
  const fg = '#f3f4f6';
  return (
    <div>
      {slide.title && (
        <div style={{ fontSize: 44, fontWeight: 800, color: accent, lineHeight: 1.15, marginBottom: 18 }}>
          {slide.title}
        </div>
      )}
      {slide.body && (
        <div style={{ fontSize: 24, color: fg, lineHeight: 1.5, whiteSpace: 'pre-wrap', marginBottom: 16 }}>
          {slide.body}
        </div>
      )}
      {slide.bullets && slide.bullets.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 28, color: fg, fontSize: 23, lineHeight: 1.7 }}>
          {slide.bullets.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      )}
      {slide.image && (
        <img
          src={slide.image}
          alt={slide.title || ''}
          style={{ maxWidth: '100%', maxHeight: '50vh', borderRadius: 14, display: 'block', marginTop: 12 }}
        />
      )}
      {slide.chart && (
        <div style={{ marginTop: 12 }}>
          <ChartScreen output={{
            ...output,
            kind: 'chart',
            chart: slide.chart,
            title: null,
          }} />
        </div>
      )}
    </div>
  );
}
