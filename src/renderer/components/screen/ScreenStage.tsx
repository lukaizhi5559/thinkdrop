import 'animate.css';
import React, { useEffect, useRef, useState } from 'react';
import type { ScreenOutput, ScreenClearMessage } from './types';
import { TextScreen } from './TextScreen';
import { ImageScreen } from './ImageScreen';
import { SceneScreen } from './SceneScreen';
import { EmojiScreen } from './EmojiGlyph';
import { EffectScreen } from './EffectScreen';
import { ChartScreen } from './ChartScreen';
import { AlertCurtain } from './AlertCurtain';
import { DeckScreen } from './DeckScreen';
import { ThreeScreen } from './ThreeScreen';

const ipcRenderer = (window as any).electron?.ipcRenderer;
const STAGE_TOKEN = 'screen-stage';

type Phase = 'in' | 'idle' | 'out';

interface StageItem {
  output: ScreenOutput;
  /** bumps to force the out-phase (clear message) — does NOT remount */
  outSeq: number;
  /** bumps on same-id update — remounts the item so the entrance replays */
  mountKey: number;
}

/**
 * ScreenStage — the GhostLayer "screen as an output" dispatcher.
 *
 * Owns the set of live ScreenOutput displays (keyed by id), their
 * in → idle → out animation lifecycle, auto-dismiss timers, scrims and
 * stacking order. Renders independently of the highlight/scanning chrome —
 * mounted as an always-on sibling inside GhostLayer so a display works even
 * when no bounding boxes are active.
 *
 * Fade contract: during app.agent screenshots (capture_begin) the whole stage
 * fades to opacity 0 — same contract as the progress drop — so displays never
 * taint OCR. capture_end restores it.
 *
 * Occupancy: reports hasDisplays upward via onOccupancyChange; the parent
 * decides when the window is truly empty and sends 'ghostlayer:display-idle'
 * for main to hide the window.
 */
export function ScreenStage({ onOccupancyChange }: { onOccupancyChange?: (occupied: boolean) => void }) {
  const [items, setItems] = useState<StageItem[]>([]);
  const [faded, setFaded] = useState(false);

  // ── IPC wiring ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!ipcRenderer) return;

    const handleDisplay = (output: ScreenOutput) => {
      if (!output || !output.id) return;
      setItems(prev => {
        const idx = prev.findIndex(i => i.output.id === output.id);
        if (idx >= 0) {
          // Same id = update → restart the lifecycle (fresh mount via key).
          const next = prev.slice();
          next[idx] = { output, outSeq: 0, mountKey: prev[idx].mountKey + 1 };
          return next;
        }
        return [...prev, { output, outSeq: 0, mountKey: 0 }];
      });
    };

    const handleClear = (msg: ScreenClearMessage) => {
      const id = msg?.id || null;
      setItems(prev => prev.map(i =>
        (!id || i.output.id === id) ? { ...i, outSeq: i.outSeq + 1 } : i
      ));
    };

    // Reuse the app-agent channel for the capture-fade signal only.
    const handleAgentMsg = (data: { type?: string }) => {
      if (data?.type === 'capture_begin') setFaded(true);
      else if (data?.type === 'capture_end') setFaded(false);
    };

    // Arrow-key nav — main registers global arrows while displays report
    // needing them (capability-driven). left/right → deck slide nav;
    // up/down → text scroll. Components listen on DOM events so the stage
    // stays kind-agnostic.
    const handleNav = (data: { dir?: string }) => {
      const dir = data?.dir;
      if (dir === 'prev' || dir === 'next' || dir === 'left' || dir === 'right') {
        window.dispatchEvent(new CustomEvent('screen:deck-nav', {
          detail: { dir: (dir === 'prev' || dir === 'left') ? 'prev' : 'next' },
        }));
      } else if (dir === 'up' || dir === 'down') {
        window.dispatchEvent(new CustomEvent('screen:text-scroll', { detail: { dir } }));
      }
    };

    ipcRenderer.on('ghostlayer:display', handleDisplay, STAGE_TOKEN);
    ipcRenderer.on('ghostlayer:display-clear', handleClear, STAGE_TOKEN);
    ipcRenderer.on('ghostlayer:display-nav', handleNav, STAGE_TOKEN);
    ipcRenderer.on('app-agent:highlight', handleAgentMsg, STAGE_TOKEN);

    return () => {
      ipcRenderer.removeListenerByToken('ghostlayer:display', STAGE_TOKEN);
      ipcRenderer.removeListenerByToken('ghostlayer:display-clear', STAGE_TOKEN);
      ipcRenderer.removeListenerByToken('ghostlayer:display-nav', STAGE_TOKEN);
      ipcRenderer.removeListenerByToken('app-agent:highlight', STAGE_TOKEN);
    };
  }, []);

  // ── Occupancy reporting ───────────────────────────────────────────────────
  const occupied = items.length > 0;
  useEffect(() => { onOccupancyChange?.(occupied); }, [occupied]);

  if (items.length === 0) return null;

  // Stacking: sort by priority asc then creation order — later render = on top.
  const sorted = [...items].sort((a, b) =>
    (a.output.priority - b.output.priority) || (a.output.createdAt - b.output.createdAt));

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 99997, // below boundary(99998)/drop(100000)/flash(100000) chrome
        pointerEvents: 'none',
        opacity: faded ? 0 : 1,
        transition: 'opacity 0.4s ease',
      }}
    >
      {sorted.map((item, idx) => (
        <ScreenItem
          key={`${item.output.id}:${item.mountKey}`}
          output={item.output}
          outSeq={item.outSeq}
          stackIndex={idx}
          onRemove={(id) => setItems(prev => prev.filter(i => i.output.id !== id))}
        />
      ))}
    </div>
  );
}

// ── Per-display wrapper: scrim + positioned content + lifecycle ─────────────

function ScreenItem({ output, outSeq, stackIndex = 0, onRemove }: {
  output: ScreenOutput;
  outSeq: number;
  stackIndex?: number;
  onRemove: (id: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>(output.animate?.in ? 'in' : 'idle');
  const outTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear message → out phase.
  const prevOutSeq = useRef(outSeq);
  useEffect(() => {
    if (outSeq !== prevOutSeq.current) {
      prevOutSeq.current = outSeq;
      setPhase('out');
    }
  }, [outSeq]);

  // Auto-dismiss (dismiss:'auto' with durationMs > 0).
  useEffect(() => {
    if (output.dismiss === 'manual' || !output.durationMs) return;
    const t = setTimeout(() => setPhase('out'), Math.max(600, output.durationMs));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Out phase → remove after the exit animation (fallback timer covers
  // missing/unknown animation names that never fire animationend).
  useEffect(() => {
    if (phase !== 'out') return;
    const t = setTimeout(() => onRemove(output.id), 900);
    outTimer.current = t;
    return () => clearTimeout(t);
  }, [phase, output.id, onRemove]);

  const cls = animateClasses(output, phase);
  const onAnimEnd = () => { if (phase === 'in') setPhase('idle'); };

  const onBackdropClick = (e: React.MouseEvent) => {
    // Blocking displays (interactive charts, alert curtains) dismiss on a
    // click outside the content card. Route through main's clear path so
    // screenDisplays + the Esc shortcut stay consistent.
    if (!output.blocking || e.target !== e.currentTarget) return;
    try { ipcRenderer?.send('ghostlayer:display-clear-request', { id: output.id }); } catch (_) {}
  };

  return (
    <div
      onAnimationEnd={onAnimEnd}
      onClick={onBackdropClick}
      className={cls}
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        ...positionFlex(output.position),
        pointerEvents: output.blocking ? 'auto' : 'none',
      }}
    >
      <Scrim output={output} />
      {/* ESC affordance — every display advertises the exit key. The chip is
          the only always-interactive element: hover-capture lifts
          click-through while over it, so it stays clickable on non-blocking
          items too. Staggered per item so stacked displays each show one. */}
      <div
        data-esc-badge={output.id}
        onMouseEnter={() => { try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: true }); } catch (_) {} }}
        onMouseLeave={() => { try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: false }); } catch (_) {} }}
        onClick={(e) => {
          e.stopPropagation();
          try { ipcRenderer?.send('ghostlayer:display-clear-request', { id: output.id }); } catch (_) {}
        }}
        style={{
          position: 'absolute',
          top: 18 + stackIndex * 42,
          right: 22,
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '5px 11px 5px 8px',
          borderRadius: 8,
          background: 'rgba(10,14,22,0.72)',
          border: '1px solid rgba(148,163,184,0.35)',
          color: '#cbd5e1',
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: '0.05em',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          cursor: 'pointer',
          pointerEvents: 'auto',
          zIndex: 2,
          userSelect: 'none',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <span style={{
          padding: '2px 6px', borderRadius: 5,
          background: 'rgba(148,163,184,0.18)',
          border: '1px solid rgba(148,163,184,0.45)',
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
        }}>ESC</span>
        <span style={{ opacity: 0.85 }}>exit</span>
      </div>
      <div style={{ position: 'relative', display: 'flex', width: '100%', ...positionFlex(output.position) }}>
        {/* Interactive items (non-blocking): the content box lifts
            click-through only while hovered — main forwards pointer moves so
            enter/leave fire even while clicks pass through. Blocking items
            keep 'auto' so descendants' own pointer-events (nav zones, cards)
            stay hit-testable — 'none' here would suppress them too. */}
        <div
          onMouseEnter={output.interactive ? () => { try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: true }); } catch (_) {} } : undefined}
          onMouseLeave={output.interactive ? () => { try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: false }); } catch (_) {} } : undefined}
          style={{ pointerEvents: (output.blocking || output.interactive) ? 'auto' : 'none' }}
        >
          <KindView
            output={output}
            animateClass=""
            onDismiss={() => {
              try { ipcRenderer?.send('ghostlayer:display-clear-request', { id: output.id }); } catch (_) {}
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function animateClasses(output: ScreenOutput, phase: Phase): string {
  const a = output.animate || {};
  const speed = output.animateSpeed ? ` animate__${output.animateSpeed}` : '';
  if (phase === 'in') {
    return `animate__animated${a.in ? ` animate__${a.in}` : ''}${speed}`;
  }
  if (phase === 'idle') {
    return a.idle ? `animate__animated animate__${a.idle} animate__infinite${speed}` : '';
  }
  return `animate__animated ${a.out ? `animate__${a.out}` : 'animate__fadeOut'} animate__faster`;
}

function positionFlex(position: ScreenOutput['position']): React.CSSProperties {
  switch (position) {
    case 'top':        return { alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh' };
    case 'bottom':     return { alignItems: 'flex-end',   justifyContent: 'center', paddingBottom: '12vh' };
    case 'banner':     return { alignItems: 'flex-start', justifyContent: 'stretch', flexDirection: 'column' };
    case 'fullscreen': return { alignItems: 'stretch',    justifyContent: 'stretch' };
    case 'center':
    default:           return { alignItems: 'center',     justifyContent: 'center' };
  }
}

function Scrim({ output }: { output: ScreenOutput }) {
  const { scrim, opacity } = output;
  if (!scrim || scrim === 'none') return null;
  const style: React.CSSProperties = { position: 'absolute', inset: 0 };
  if (scrim === 'dim') {
    style.backgroundColor = `rgba(0,0,0,${opacity})`;
  } else if (scrim === 'black') {
    style.backgroundColor = `rgba(0,0,0,${Math.max(0.85, opacity)})`;
  } else if (scrim === 'white') {
    style.backgroundColor = `rgba(255,255,255,${Math.max(0.85, opacity)})`;
  } else if (scrim === 'blur') {
    style.backdropFilter = 'blur(14px)';
    (style as any).WebkitBackdropFilter = 'blur(14px)';
    style.backgroundColor = 'rgba(0,0,0,0.25)';
  }
  return <div style={style} />;
}

// ── Kind dispatch ───────────────────────────────────────────────────────────

function KindView({ output, animateClass, onDismiss }: { output: ScreenOutput; animateClass: string; onDismiss?: () => void }) {
  switch (output.kind) {
    case 'text':  return <TextScreen  output={output} animateClass={animateClass} />;
    case 'image': return <ImageScreen output={output} animateClass={animateClass} />;
    case 'emoji': return <EmojiScreen output={output} animateClass={animateClass} />;
    case 'effect': return <EffectScreen output={output} />;
    case 'chart':  return <ChartScreen  output={output} />;
    case 'alert': return <AlertCurtain output={output} onDismiss={onDismiss} />;
    case 'deck':   return <DeckScreen   output={output} onDismiss={onDismiss} />;
    case 'three':  return <ThreeScreen  output={output} />;
    case 'scene':  return <SceneScreen  output={output} />;
    default:      return <KindStub    output={output} />;
  }
}

/** Placeholder for kinds whose renderers land in later stages. */
function KindStub({ output }: { output: ScreenOutput }) {
  return (
    <div
      style={{
        padding: '14px 22px',
        borderRadius: 14,
        background: 'rgba(10,14,22,0.82)',
        border: '1px solid rgba(96,165,250,0.35)',
        color: '#93c5fd',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      {output.kind} display (coming in a later stage){output.title ? ` — ${output.title}` : ''}
    </div>
  );
}
