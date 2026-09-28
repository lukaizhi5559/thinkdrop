import 'animate.css';
import React, { useEffect, useRef, useState } from 'react';
import type { ScreenOutput, ScreenClearMessage } from './types';
import { TextScreen } from './TextScreen';
import { ImageScreen } from './ImageScreen';
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

    ipcRenderer.on('ghostlayer:display', handleDisplay, STAGE_TOKEN);
    ipcRenderer.on('ghostlayer:display-clear', handleClear, STAGE_TOKEN);
    ipcRenderer.on('app-agent:highlight', handleAgentMsg, STAGE_TOKEN);

    return () => {
      ipcRenderer.removeListenerByToken('ghostlayer:display', STAGE_TOKEN);
      ipcRenderer.removeListenerByToken('ghostlayer:display-clear', STAGE_TOKEN);
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
      {sorted.map(item => (
        <ScreenItem
          key={`${item.output.id}:${item.mountKey}`}
          output={item.output}
          outSeq={item.outSeq}
          onRemove={(id) => setItems(prev => prev.filter(i => i.output.id !== id))}
        />
      ))}
    </div>
  );
}

// ── Per-display wrapper: scrim + positioned content + lifecycle ─────────────

function ScreenItem({ output, outSeq, onRemove }: {
  output: ScreenOutput;
  outSeq: number;
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
      <div style={{ position: 'relative', display: 'flex', width: '100%', ...positionFlex(output.position) }}>
        <KindView
          output={output}
          animateClass=""
          onDismiss={() => {
            try { ipcRenderer?.send('ghostlayer:display-clear-request', { id: output.id }); } catch (_) {}
          }}
        />
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
