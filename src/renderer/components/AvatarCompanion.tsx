import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { WebResultsGrid, RichContentRenderer } from './rich-content';
import type { WebResultItem } from './rich-content';
import { AvatarFace, faceExists, PlanBadge } from './avatarFaces';
import AutomationProgress from './AutomationProgress';
import VoiceLangPicker from './VoiceLangPicker';

const ipcRenderer = (window as any).electron?.ipcRenderer;
const TOKEN = 'avatar-companion';
const SIZE = 104;         // bubble-orb bounding box (mirrors main's _isOnAvatar)
const PAD = 30;           // inflated hover zone around it

type Mode = 'idle' | 'listening' | 'thinking' | 'streaming' | 'speaking' | 'muted';

interface Bubble {
  text: string;
  phase: 'thinking' | 'stream' | 'done' | 'error' | 'question';
  label?: string;
  notice?: string;   // failure/status line appended under the body (red)
  items?: WebResultItem[];
  sources?: number;
  engine?: string;
}

// ↑/↓ scrollback — a submitted prompt paired with its settled bubble. Kept in
// renderer state (session-local); browsing swaps the live bubble for a stored
// exchange without disturbing the stream still tracking behind it.
interface Exchange {
  prompt: string;
  bubble: Bubble | null;
}

const PALETTE = ['#60a5fa', '#34d399', '#f472b6', '#fbbf24', '#a78bfa', '#f87171'];

// Option-key gesture legend — mirrors the overlay's legend panel.
const LEGEND: [string, string][] = [
  ['⌥R ×2', 'prompt · focus input'],
  ['⌥R hold', 'talk (PTT)'],
  ['⌥R tap', 'confirm · dismiss'],
  ['⇧R + ⌥R tap', 'show / hide'],
  ['⇧R + ⌥R ×2', 'history'],
  ['⌥L + ⌥R tap', 'cancel / exit'],
  ['esc', 'dismiss response'],
];

function hexToRgba(hex: string, a: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(96,165,250,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Scrollback header — drop [File:]/[Folder:] path tags down to basenames so
// "You" reads like the prompt the user wrote, not the wire format.
function prettyPrompt(p: string) {
  return (p || '')
    .replace(/\[(File|Folder):\s*([^\]]+)\]\s*/g, (_m, _k, inner) => `${inner.trim().split('/').filter(Boolean).pop()} `)
    .replace(/\[(Highlighted|Thought|Context):\s*([^\]]+)\]/g, '$2')
    .trim();
}

// Prompt text minus every tag wrapper — dedupe key for the double-signal the
// same submission fires (avatar:submit's raw text vs the queue-dispatched
// prompt enriched with [Highlighted:] context).
function promptCore(p: string) {
  return (p || '').replace(/\[(File|Folder|Highlighted|Thought|Context):\s*[^\]]*\]/g, '').trim();
}

// Talk Mode glyph — the same 4-bar waveform the overlay's voice button draws
// (VoiceButton icon="voice"), sized for the Ctl row.
function VoiceGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="10" width="2.5" height="4" rx="1.25" />
      <rect x="9.25" y="7" width="2.5" height="10" rx="1.25" />
      <rect x="13.5" y="4" width="2.5" height="16" rx="1.25" />
      <rect x="17.75" y="9" width="2.5" height="6" rx="1.25" />
    </svg>
  );
}

/** Tiny sparkle field orbiting the orb — a dozen dots on a small canvas is far
 * cheaper than a WebGL context living on the always-on-top GhostLayer. */
function useSparkles(ref: React.RefObject<HTMLCanvasElement | null>, active: boolean, color: string) {
  useEffect(() => {
    if (!active) return;
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = SIZE + PAD * 2;
    canvas.width = W * dpr;
    canvas.height = W * dpr;
    ctx.scale(dpr, dpr);
    const sparks = Array.from({ length: 16 }, (_, i) => ({
      ang: (i / 16) * Math.PI * 2 + Math.random(),
      rad: 46 + Math.random() * 34,
      spd: 0.002 + Math.random() * 0.004,
      size: 0.7 + Math.random() * 1.7,
      tw: Math.random() * Math.PI * 2,
    }));
    let raf = 0;
    const tick = () => {
      ctx.clearRect(0, 0, W, W);
      const cx = W / 2, cy = W / 2;
      for (const s of sparks) {
        s.ang += s.spd;
        s.tw += 0.05;
        const a = 0.15 + 0.6 * (0.5 + 0.5 * Math.sin(s.tw));
        ctx.fillStyle = hexToRgba(color, a);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(s.ang) * s.rad, cy + Math.sin(s.ang) * s.rad * 0.92, s.size, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, color]);
}

// ── Waveform mouth ───────────────────────────────────────────────────────────
// Optyon talks through a little VoiceBars-style wave drawn where the face's
// mouth sits — the same waveform language the overlay uses (blue/purple/
// amber), just shrunk to a mouth. Only rendered during voice/work states;
// quiet faces draw their own mouth line.
interface BarSpec { color: string; amp: number; speed: number; alpha: number; }
function barSpec(mode: Mode, accent: string): BarSpec {
  switch (mode) {
    case 'listening': return { color: '#fbbf24', amp: 1.0, speed: 9.0, alpha: 1 };
    case 'thinking':  return { color: accent,    amp: 0.8, speed: 6.5, alpha: 1 };
    case 'streaming': return { color: accent,    amp: 0.7, speed: 5.0, alpha: 1 };
    case 'speaking':  return { color: '#c084fc', amp: 0.9, speed: 7.0, alpha: 1 };
    case 'muted':     return { color: accent,    amp: 0.2, speed: 1.2, alpha: 0.4 };
    default:          return { color: accent,    amp: 0.45, speed: 2.2, alpha: 0.9 };
  }
}

const MOUTH_W = 58, MOUTH_H = 24;

function useBars(ref: React.RefObject<HTMLCanvasElement | null>, on: boolean, modeRef: React.MutableRefObject<Mode>, color: string) {
  useEffect(() => {
    if (!on) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = MOUTH_W, H = MOUTH_H;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    const N = 15, barW = 2.5;
    const span = W * 0.94, gap = (span - N * barW) / (N - 1);
    const x0 = (W - span) / 2, cy = H * 0.55;
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      const t = (performance.now() - t0) / 1000;
      const s = barSpec(modeRef.current, color);
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < N; i++) {
        const env = Math.sin(Math.PI * (i + 0.5) / N);
        const w = 0.5 + 0.5 * Math.sin(t * s.speed + i * 0.72 + Math.sin(t * 0.9 + i * 1.3) * 0.5);
        const h = 2.5 + env * (H - 4) * (0.15 + s.amp * w * 0.85);
        ctx.fillStyle = hexToRgba(s.color, s.alpha * (0.55 + 0.45 * env));
        const x = x0 + i * (barW + gap), y = cy - h / 2;
        ctx.beginPath();
        if ((ctx as any).roundRect) (ctx as any).roundRect(x, y, barW, h, barW / 2);
        else ctx.rect(x, y, barW, h);
        ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [on, color]);
}

// ── Emoji faces ────────────────────────────────────────────────────────────
// Faces come from shared/emoji-catalog.cjs via avatarFaces.tsx — parametric
// line-art SVG specs, never glyphs. Legacy emotion/mode names map to catalog
// keys here; main may also send catalog keys directly.
const FACE_MAP: Record<string, string> = {
  smile: 'slightly-smiling-face', wow: 'face-open-mouth', thinking: 'thinking-face',
  sad: 'crying-face', upset: 'angry-face', love: 'heart-eyes', party: 'partying-face',
  sleep: 'sleeping-face', inbox: 'inbox-face', speak: 'speak-face', globe: 'globe-face',
};
const faceKeyOf = (name: string) => FACE_MAP[name] || (faceExists(name) ? name : 'slightly-smiling-face');

const css = `
@keyframes av-breathe {
  0%,100% { transform: scale(1) translateY(0); }
  50%     { transform: scale(1.025) translateY(-3px); }
}
@keyframes av-ring { 0% { transform: scale(0.72); opacity: .6; } 100% { transform: scale(1.45); opacity: 0; } }
@keyframes av-bob  { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
@keyframes av-dots { 0%,80%,100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
@keyframes av-spin { to { transform: rotate(360deg); } }
@keyframes av-fade { from { opacity: 0; } to { opacity: 1; } }
.av-ctl { transition: background .12s, color .12s, transform .12s; }
.av-ctl:hover { background: rgba(255,255,255,.24) !important; color: #fff !important; transform: translateY(-1px); }
.av-ctl:active { transform: translateY(0); }
.av-ctl:disabled { opacity: .35; cursor: default; transform: none; }
.av-sw { transition: transform .12s, box-shadow .12s; }
.av-sw:hover { transform: scale(1.18); box-shadow: 0 0 0 2px rgba(255,255,255,.5); }
`;

export function AvatarCompanion({ onOccupancyChange }: { onOccupancyChange?: (occupied: boolean) => void }) {
  const [on, setOn] = useState(false);
  const [pos, setPos] = useState({ x: 40, y: 40 });
  const [color, setColor] = useState('#60a5fa');
  const [mode, setMode] = useState<Mode>('idle');
  const [interim, setInterim] = useState('');
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [hover, setHover] = useState(false);
  const [palette, setPalette] = useState(false);
  const [legend, setLegend] = useState(false);
  const [s2s, setS2s] = useState(false);
  const [voiceLang, setVoiceLang] = useState<string | null>(null);
  const [ctxHeld, setCtxHeld] = useState(false);
  const [ctxExcerpt, setCtxExcerpt] = useState('');
  const [trayHover, setTrayHover] = useState(false);
  const [dropHint, setDropHint] = useState(false);
  const [emotion, setEmotion] = useState<string | null>(null);
  const [faceOverride, setFaceOverride] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  // Pending approval — main pushes {pending, kind:'plan'|'review'|'question',
  // hint} while a gate waits on the user; the ✓/✕ pair under the face mirrors
  // the ⌥R-confirm / ⌥L+⌥R-cancel gestures.
  const [approval, setApproval] = useState<{ pending: boolean; kind?: string; hint?: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [sleepTick, setSleepTick] = useState(0);
  // Prompt/response scrollback — browseIdx null = live view; a number points
  // into exchanges. Keys arm in main while hovered (ghost can't hold focus).
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [browseIdx, setBrowseIdx] = useState<number | null>(null);
  const exchangesRef = useRef<Exchange[]>([]); exchangesRef.current = exchanges;
  const browseRef = useRef<number | null>(null); browseRef.current = browseIdx;
  // Embedded AutomationProgress reports a live run — keeps the tray mounted
  // even when the user dismissed the text bubble mid-run.
  const [apActive, setApActive] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barsRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef<null | { dx: number; dy: number; downX: number; downY: number }>(null);
  const modeRef = useRef<Mode>('idle');
  modeRef.current = mode;
  const lastBubble = useRef<Bubble | null>(null);   // last settled bubble — click restores
  const bubbleRef = useRef<Bubble | null>(null);
  bubbleRef.current = bubble;
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bubbleW, setBubbleW] = useState(400);      // tracks the overlay's live width (400–800)
  const hoverRef = useRef(false);   hoverRef.current = hover;
  const trayHoverRef = useRef(false); trayHoverRef.current = trayHover;

  useSparkles(canvasRef, on, color);
  useBars(barsRef, on, modeRef, color);

  // Occupancy — keeps the GhostLayer alive + suppresses the selection pill.
  useEffect(() => { onOccupancyChange?.(on); return () => onOccupancyChange?.(false); }, [on]);

  // Activity tracking + sleep — untouched for SLEEP_MS → 😴 face. Any hover,
  // stream event, or gesture stamps lastActive and wakes it.
  const lastActive = useRef(Date.now());
  const SLEEP_MS = 4 * 60 * 1000;
  const poke = useCallback(() => { lastActive.current = Date.now(); }, []);
  useEffect(() => {
    if (!on) return;
    const iv = setInterval(() => setSleepTick(t => t + 1), 15000);
    return () => clearInterval(iv);
  }, [on]);

  // Sticky faces — a prompt-set emotion or display face holds until the next
  // stimulus (new prompt/emotion/face, or avatar off) — no timer decay. The
  // emotion gets a ~3s "react beat" outranking work faces so it's seen.
  const REACT_MS = 3000;
  const emotionAt = useRef(0);
  const reactTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, setReactTick] = useState(0);
  const holdEmotion = useCallback((e: string) => {
    emotionAt.current = Date.now();
    setEmotion(e);
    setFaceOverride(null);
    if (reactTimer.current) clearTimeout(reactTimer.current);
    reactTimer.current = setTimeout(() => setReactTick(t => t + 1), REACT_MS + 50);
  }, []);
  const faceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdFace = useCallback((f: string | null, ttlMs?: number) => {
    if (faceTimer.current) { clearTimeout(faceTimer.current); faceTimer.current = null; }
    setFaceOverride(f);
    if (f && typeof ttlMs === 'number' && ttlMs > 0) {
      faceTimer.current = setTimeout(() => setFaceOverride(null), ttlMs);
    }
  }, []);

  // Bubble phase transitions. Settled bubbles (done/error/question) persist —
  // no auto-fade — and are remembered in lastBubble so a click on Optyon after
  // dismissal restores the most recent response.
  // A settled bubble joins the scrollback, paired under the last prompt.
  const recordSettled = useCallback((b: Bubble) => {
    lastBubble.current = b;
    setExchanges(prev => {
      const next = prev.slice(-49);
      if (next.length) next[next.length - 1] = { ...next[next.length - 1], bubble: b };
      else next.push({ prompt: '', bubble: b });
      return next;
    });
  }, []);
  const setPhase = useCallback((phase: Bubble['phase'], patch?: Partial<Bubble>) => {
    setBubble(b => {
      const next = { ...(b || { text: '' }), ...patch, phase, text: patch?.text !== undefined ? patch.text : (b?.text || '') };
      if (phase === 'done' || phase === 'error' || phase === 'question') recordSettled(next);
      return next;
    });
  }, [recordSettled]);
  const patchBubble = useCallback((patch: Partial<Bubble>) => {
    setBubble(b => {
      const next = { ...(b || { text: '', phase: 'stream' as const }), ...patch };
      if (next.phase === 'done' || next.phase === 'error' || next.phase === 'question') recordSettled(next);
      return next;
    });
  }, [recordSettled]);
  // Release click-capture — sends hovering:false only when neither the avatar
  // zone nor the tray is hovered. Called on every programmatic bubble unmount
  // (a mouseleave can't fire under a dismissed element, which was the leak).
  const releaseHover = useCallback(() => {
    if (!hoverRef.current && !trayHoverRef.current) {
      try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: false }); } catch (_) {}
    }
  }, []);
  // History browse — armed keys live in main (ghost can't hold focus); the
  // renderer owns the index. Keys arm on HOVER (see keysArmed effect below),
  // not on entering browse — no click needed. Live (null) sits just off the
  // ring: ↑ enters at the newest, ↓ at the oldest, and both ends wrap — so
  // arrow navigation can never exit-and-hide the tray.
  const sendHistoryArmed = useCallback((armed: boolean) => {
    try { ipcRenderer?.send('avatar:history-state', { armed }); } catch (_) {}
  }, []);
  const exitBrowse = useCallback(() => {
    if (browseRef.current == null) return;
    browseRef.current = null;
    setBrowseIdx(null);
  }, []);
  const enterBrowse = useCallback(() => {
    const len = exchangesRef.current.length;
    if (!len) return;
    setBrowseIdx(len - 1);
  }, []);
  const navBrowse = useCallback((dir: 'up' | 'down') => {
    setBrowseIdx(i => {
      const len = exchangesRef.current.length;
      if (!len) return null;
      const cur = i == null ? (dir === 'down' ? -1 : len) : i;
      const next = dir === 'down' ? cur + 1 : cur - 1;
      return ((next % len) + len) % len;
    });
  }, []);
  const dismissBubble = useCallback(() => {
    exitBrowse();
    setBubble(null);
    setTrayHover(false);
    setTimeout(releaseHover, 0); // let the state write land before the check
  }, [releaseHover, exitBrowse]);
  // What's actually rendered in the tray — a browsed exchange outranks the
  // live bubble (which keeps tracking in the background for the way back).
  const displayedRef = useRef<{ text?: string; notice?: string } | null>(null);
  const copyAndDismiss = useCallback(() => {
    const b = displayedRef.current || bubbleRef.current;
    const t = [b?.text, b?.notice].filter(Boolean).join('\n\n');
    if (t) try { ipcRenderer?.send('clipboard:write-text', t); } catch (_) {}
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => {
      setCopied(false);
      setBubble(null);
      setTrayHover(false);
      setTimeout(releaseHover, 0);
    }, 1200);
  }, [releaseHover]);

  // IPC wiring.
  useEffect(() => {
    if (!ipcRenderer) return;
    const onState = (d: any) => {
      if (typeof d?.pos?.x === 'number') setPos({ x: d.pos.x, y: d.pos.y });
      if (typeof d?.color === 'string') setColor(d.color);
      if (typeof d?.on === 'boolean') { setOn(d.on); if (!d.on) { setEmotion(null); holdFace(null); exitBrowse(); setApproval(null); } }
      if (typeof d?.overlayWidth === 'number') setBubbleW(Math.max(320, Math.min(800, d.overlayWidth)));
      if (typeof d?.planning === 'boolean') setPlanning(d.planning);
      if (d && 'voiceLang' in d) setVoiceLang(d.voiceLang ?? null);
    };
    const onLang = (d: any) => setVoiceLang(d?.lang ?? null);
    const onPlanning = (d: any) => setPlanning(!!d?.active);
    const onFace = (d: any) => {
      const f = typeof d?.face === 'string' ? d.face : '';
      poke();
      holdFace(f || null, typeof d?.ttlMs === 'number' ? d.ttlMs : undefined);
    };
    const onPttStart = () => { poke(); setMode('listening'); setInterim(''); };
    const onPttStop = () => { setInterim(''); setMode(m => m === 'listening' ? 'idle' : m); };
    const onInterim = (d: any) => setInterim(String(d?.text || ''));
    const onContext = (d: any) => {
      const held = !!(d?.armed || d?.captured);
      setCtxHeld(held);
      setCtxExcerpt(held && typeof d?.excerpt === 'string' ? d.excerpt : '');
    };
    const onSession = (d: any) => setS2s(!!d?.active);
    const onApproval = (d: any) => setApproval(d?.pending ? { pending: true, kind: d.kind, hint: d.hint } : null);
    const onVoice = (d: any) => {
      const st = d?.state;
      if (st === 'speaking') setMode('speaking');
      else if (st === 'disconnected' || st === 'error') setS2s(false);
      else if (modeRef.current === 'speaking' || modeRef.current === 'muted') setMode('idle');
    };
    const onMute = (d: any) => setMode(d?.muted ? 'muted' : 'idle');
    const onEmotion = (d: any) => {
      const e = typeof d?.emotion === 'string' ? d.emotion : '';
      if (e) { poke(); holdEmotion(e); }
    };
    const onStream = (d: any) => {
      if (!d || typeof d !== 'object') return;
      poke();
      switch (d.type) {
        case 'input-open':
          setInputOpen(!!d.on);
          break;
        case 'prompt': {
          // Outgoing prompt — starts a scrollback entry; the settled bubble
          // attaches to it when the run finishes. The same submission is
          // signalled twice — avatar:submit's raw text, then unified:set-
          // prompt when the queue dispatches it (enriched with [Highlighted:]
          // context, so the strings differ). Dedupe on the tag-stripped core
          // while the previous entry is still unanswered.
          const t = String(d.text || '');
          setExchanges(prev => {
            const last = prev[prev.length - 1];
            if (last && !last.bubble && promptCore(last.prompt) === promptCore(t)) return prev;
            return [...prev.slice(-49), { prompt: t, bubble: null }];
          });
          exitBrowse(); // a new prompt always returns to the live view
          break;
        }
        case 'history-nav': {
          navBrowse(d.dir === 'down' ? 'down' : 'up');
          break;
        }
        case 'thinking': {
          const label = typeof d.label === 'string' ? d.label.slice(0, 60) : undefined;
          setMode('thinking');
          if (d.fresh) { setEmotion(null); holdFace(null); exitBrowse(); } // new run reclaims the view
          // "Searching google…" etc. flips the face to the globe.
          setSearching(!!label && /^searching/i.test(label));
          setBubble(b => {
            // task:progress fires constantly mid-run — a thinking label must
            // update the status line WITHOUT hiding in-flight streamed text.
            // It only resets the bubble on a fresh run/segment or when the
            // previous bubble already settled.
            const settled = !b || b.phase === 'done' || b.phase === 'error' || b.phase === 'question';
            if (d.fresh || settled) {
              return { text: '', phase: 'thinking' as const, label };
            }
            return { ...b, label };
          });
          break;
        }
        case 'chunk': {
          // Sentinel chunks (\x00ITEMS\x00 etc.) are decoded in main; anything
          // still tagged is control data, not answer text.
          const t = String(d.text || '').replace(/\x00[A-Z_]+\x00[\s\S]*/g, '').replace(/\x00/g, '');
          if (!t) return;
          setSearching(false);
          setMode('streaming');
          // Only a live stream appends — a chunk landing on a settled or
          // thinking bubble starts a fresh answer instead of grafting onto
          // stale text (old answer, parked question, placeholder label).
          setBubble(b => ({ ...(b || { text: '' }), text: (b?.phase === 'stream' ? b?.text || '' : '') + t, phase: 'stream' }));
          break;
        }
        case 'replace': {
          // The real answer REPLACES the placeholder ack wholesale — never
          // append, or "Checking on that…" lingers in front of the answer.
          const t = String(d.text || '').replace(/\x00/g, '');
          if (!t.trim()) break;
          setSearching(false);
          setMode('streaming');
          setBubble(b => ({ ...(b || { text: '' }), text: t, phase: 'stream' }));
          break;
        }
        case 'question': {
          // The run parked on a user question — show it (amber) with a reply
          // hint; answering through the avatar input resolves it downstream.
          // An empty label is a "still parked" nudge (task:complete) — keep an
          // existing question's specific text rather than overwriting it.
          const q = String(d.label || d.text || '').replace(/\x00/g, '');
          setSearching(false);
          setMode('idle');
          setBubble(b => {
            const text = q || (b?.phase === 'question' ? b.text : 'Waiting for your input — reply via the prompt input.');
            const next = {
              ...(b || { text: '', phase: 'stream' as const }),
              text, phase: 'question' as const,
              items: undefined, sources: undefined, engine: undefined, label: undefined,
              notice: undefined,
            };
            recordSettled(next);
            return next;
          });
          break;
        }
        case 'dismiss-bubble':
          dismissBubble();
          break;
        case 'items':
          patchBubble({ items: d.items });
          break;
        case 'sources':
          patchBubble({ sources: Array.isArray(d.items) ? d.items.length : undefined });
          break;
        case 'engine':
          patchBubble({ engine: String(d.text || '').slice(0, 40) });
          break;
        case 'utterance':
          setSearching(false);
          setMode('streaming');
          setPhase('done', { text: String(d.text || '').replace(/\x00/g, '') });
          break;
        case 'done': {
          setSearching(false);
          setMode('idle');
          const clean = typeof d.text === 'string' ? d.text.replace(/\x00/g, '') : '';
          setBubble(b => {
            // What streamed IS the answer — the overlay feed's contract
            // (feedIpc): a diverging settled result (condensed journal
            // answer, review correction) must NOT replace the text the user
            // watched generate. Detect the stream by TEXT presence, not
            // phase — a mid-run progress label can leave phase 'thinking'
            // while real text already accumulated.
            const streamed = (b?.text || '').trim();
            const text = streamed || clean || (b?.text || '');
            // A failure-style summary ("Failed — N step(s) failed…" /
            // "Partial — …") that differs from the rendered answer rides
            // as a notice line appended under it — kept, not hidden.
            const notice = clean && clean !== streamed && /^(Failed|Partial)\b/.test(clean) ? clean : undefined;
            const next = {
              ...(b || { text: '', phase: 'stream' as const }),
              text, phase: 'done' as const, notice,
              ...(d.items ? { items: d.items } : {}),
            };
            if (d.needsInfo) next.notice = 'Awaiting your reply — respond in the prompt input.';
            recordSettled(next);
            return next;
          });
          break;
        }
        case 'error':
        case 'cancelled': {
          setSearching(false);
          setMode('idle');
          const notice = d.type === 'cancelled'
            ? 'Cancelled.'
            : (String(d.text || '').replace(/\x00/g, '') || 'Something went wrong.');
          setBubble(b => {
            // Keep whatever streamed as the body — the failure line appends
            // as a red notice beneath it instead of wiping the stream.
            const streamed = (b?.text || '').trim();
            const next = {
              ...(b || { text: '', phase: 'stream' as const }),
              text: streamed || notice,
              phase: 'error' as const,
              notice: streamed ? notice : undefined,
              ...(d.items ? { items: d.items } : {}),
            };
            recordSettled(next);
            return next;
          });
          break;
        }
      }
    };
    ipcRenderer.on('avatar:state', onState, TOKEN);
    ipcRenderer.on('avatar:ptt-start', onPttStart, TOKEN);
    ipcRenderer.on('avatar:ptt-stop', onPttStop, TOKEN);
    ipcRenderer.on('avatar:ptt-interim', onInterim, TOKEN);
    ipcRenderer.on('avatar:context', onContext, TOKEN);
    ipcRenderer.on('avatar:session-state', onSession, TOKEN);
    ipcRenderer.on('avatar:approval', onApproval, TOKEN);
    ipcRenderer.on('avatar:stream', onStream, TOKEN);
    ipcRenderer.on('voice:state', onVoice, TOKEN);
    ipcRenderer.on('voice:mute-state', onMute, TOKEN);
    ipcRenderer.on('avatar:emotion', onEmotion, TOKEN);
    ipcRenderer.on('avatar:face', onFace, TOKEN);
    ipcRenderer.on('avatar:planning', onPlanning, TOKEN);
    ipcRenderer.on('voice:lang-state', onLang, TOKEN);
    try { ipcRenderer.send('avatar:query'); } catch (_) {}
    return () => {
      for (const ch of ['avatar:state', 'avatar:ptt-start', 'avatar:ptt-stop', 'avatar:ptt-interim',
        'avatar:context', 'avatar:session-state', 'avatar:stream', 'avatar:emotion', 'avatar:face', 'avatar:planning', 'avatar:approval', 'voice:state', 'voice:mute-state', 'voice:lang-state']) {
        try { ipcRenderer.removeListenerByToken(ch, TOKEN); } catch (_) {}
      }
    };
  }, [setPhase, patchBubble, dismissBubble, recordSettled, navBrowse, exitBrowse]);

  // Hover — lifting click-through is scoped to the hovered region only.
  const sendHover = (h: boolean) => {
    try { ipcRenderer?.send('ghostlayer:hover-interactive', { hovering: h }); } catch (_) {}
  };
  const enter = () => { poke(); setHover(true); sendHover(true); };
  const leave = () => {
    if (draggingRef.current) return; // stay interactive through the drag
    setHover(false); setPalette(false);
    if (!trayHover) sendHover(false);
  };
  const trayEnter = () => { setTrayHover(true); sendHover(true); };
  const trayLeave = () => { setTrayHover(false); if (!hover) sendHover(false); };

  // Drag — pointer capture isn't reliable across the click-through boundary,
  // so track on window listeners.
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-avctl]')) return;
    draggingRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y, downX: e.clientX, downY: e.clientY };
    const move = (ev: PointerEvent) => {
      const d = draggingRef.current;
      if (!d) return;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - SIZE, ev.clientX - d.dx)),
        y: Math.max(0, Math.min(window.innerHeight - SIZE, ev.clientY - d.dy)),
      });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const d = draggingRef.current;
      draggingRef.current = null;
      if (d) {
        const np = { x: Math.round(ev.clientX - d.dx), y: Math.round(ev.clientY - d.dy) };
        const travel = Math.hypot(ev.clientX - d.downX, ev.clientY - d.downY);
        if (travel < 5) {
          // Tap: browsing → back to live; live bubble → hide; hidden +
          // history → open the scrollback (then ↑/↓ walks it); otherwise
          // restore the settled bubble as before.
          if (browseRef.current != null) exitBrowse();
          else if (bubbleRef.current) dismissBubble();
          else if (exchangesRef.current.length) enterBrowse();
          else if (lastBubble.current) setBubble(lastBubble.current);
        } else {
          try { ipcRenderer?.send('avatar:moved', np); } catch (_) {}
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  useEffect(() => () => sendHover(false), []);
  useEffect(() => () => sendHistoryArmed(false), [sendHistoryArmed]);

  // Arrow keys arm on HOVER — no click required. Main globally registers bare
  // Up/Down while armed (ghost is focusable:false) and routes them here as
  // history-nav events. Scoped to (hover || trayHover) so the grab releases
  // the moment the pointer leaves; gated on real history existing so arrows
  // aren't stolen for an empty scrollback.
  const keysArmed = on && (hover || trayHover) && exchanges.length > 0;
  const keysArmedRef = useRef(false);
  useEffect(() => {
    if (keysArmed === keysArmedRef.current) return;
    keysArmedRef.current = keysArmed;
    sendHistoryArmed(keysArmed);
  }, [keysArmed, sendHistoryArmed]);

  // A dismissed/hidden bubble unmounts under the cursor — its mouseleave never
  // fires, so trayHover must be reset here or it suppresses every future
  // leave() and the GhostLayer stays click-captured forever.
  useEffect(() => { if (!bubble) setTrayHover(false); }, [bubble]);

  // Report bubble presence — main registers Esc globally ONLY while a bubble
  // is up (scoped dismiss, so Esc stays free for other apps otherwise). An
  // open scrollback counts too: Esc exits browse via the same dismiss-bubble.
  useEffect(() => {
    try { ipcRenderer?.send('avatar:bubble-state', { showing: !!bubble || browseIdx != null }); } catch (_) {}
    return () => { try { ipcRenderer?.send('avatar:bubble-state', { showing: false }); } catch (_) {} };
  }, [bubble, browseIdx]);

  // File-drag hoist — macOS never routes OS file drags to a click-through
  // window, so a drop on Optyon can only land while the ghost is already
  // interactive. If a drag event DOES reach us, lift capture immediately so
  // the drop survives mid-flight. The guaranteed attach paths are the 📎
  // dialog and dropping on the (real, focusable) input window.
  useEffect(() => {
    if (!on) return;
    const hoist = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      sendHover(true);
    };
    window.addEventListener('dragenter', hoist);
    window.addEventListener('dragover', hoist);
    return () => {
      window.removeEventListener('dragenter', hoist);
      window.removeEventListener('dragover', hoist);
    };
  }, [on]);

  // Interactive watchdog — while the ghost is click-captured, ANY pointer move
  // whose target isn't inside the avatar zone or the bubble force-releases
  // capture. Self-heals every leak class (missed mouseleave, unmounted-under-
  // cursor, stuck drag ref). DOM containment — not rect math — so the controls
  // column and palette, which hang OUTSIDE the avatar rect, still count.
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const trayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!hover && !trayHover) return;
    const onMove = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if ((t && zoneRef.current?.contains(t)) || (t && trayRef.current?.contains(t))) return;
      setHover(false); setPalette(false); setTrayHover(false);
      sendHover(false);
    };
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, [hover, trayHover]);

  // Content-fit bubble — the div is width:fit-content, so measure the real
  // rendered width after each layout for centering/clamping math below.
  // Runs every render; the guarded setState makes it free when unchanged.
  const [liveBubbleW, setLiveBubbleW] = useState(0);
  useLayoutEffect(() => {
    const w = trayRef.current ? trayRef.current.offsetWidth : 0;
    if (w !== liveBubbleW) setLiveBubbleW(w);
  });

  if (!on) return null;

  const accent = mode === 'listening' || ctxHeld ? '#fbbf24' : color;
  const active = mode !== 'idle';
  const working = mode === 'listening' || mode === 'thinking' || mode === 'streaming';
  const waveMouth = mode === 'listening' || mode === 'thinking' || mode === 'streaming' || mode === 'speaking';
  const sleeping = !active && !searching && !dropHint
    && sleepTick >= 0 && Date.now() - lastActive.current > SLEEP_MS;
  const emotionKey = emotion ? faceKeyOf(emotion) : null;
  const reactNow = !!emotion && Date.now() - emotionAt.current < REACT_MS;
  // Priority: drop > error > question > display face > react beat > searching
  // > work modes > S2S session > planning > held emotion > muted > sleep > idle.
  const face: string = dropHint ? 'inbox-face'
    : bubble?.phase === 'error' ? 'confounded-face'
    : bubble?.phase === 'question' ? 'raised-eyebrow-face'
    : faceOverride ? faceKeyOf(faceOverride)
    : reactNow ? emotionKey!
    : searching ? 'globe-face'
    : mode === 'listening' ? 'face-open-mouth'
    : (mode === 'thinking' || mode === 'streaming') ? 'thinking-face'
    : mode === 'speaking' ? 'speak-face'
    : s2s ? 'speak-face'
    : planning ? 'face-monocle'
    : emotionKey ? emotionKey
    : mode === 'muted' ? 'sleeping-face'
    : sleeping ? 'sleeping-face'
    : 'slightly-smiling-face';
  const bubbleAbove = pos.y > 340;
  // Content-fit bubble — fit-content width capped at the overlay width; the
  // rendered width is measured so it still centers on Optyon and clamps.
  const measuredW = liveBubbleW || Math.min(bubbleW, 400);
  const bubbleLeft = Math.max(12, Math.min(window.innerWidth - measuredW - 16, pos.x + SIZE / 2 - measuredW / 2));

  // Browsing swaps the tray body for a stored exchange — the live bubble keeps
  // tracking behind it for the way back. The tray stays up while an automation
  // run is live even when the text bubble was dismissed (steps must show).
  const view = browseIdx != null ? exchanges[browseIdx] || null : null;
  const bodyBubble: Bubble | null = view ? (view.bubble || { text: '', phase: 'done' }) : bubble;
  displayedRef.current = bodyBubble;
  const showTray = !!(bubble || apActive || view);

  return (
    <>
      <style>{css}</style>
      <div
        ref={zoneRef}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onPointerDown={onPointerDown}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); if (!dropHint) setDropHint(true); }
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget instanceof Node && (e.currentTarget as HTMLElement).contains(e.relatedTarget)) return;
          setDropHint(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          poke();
          setDropHint(false);
          const paths: string[] = [];
          const dirs: string[] = [];
          Array.from(e.dataTransfer.items).forEach((it, i) => {
            const f = e.dataTransfer.files[i];
            const p = (f as any)?.path;
            if (!p) return;
            paths.push(p);
            try { if ((it as any).webkitGetAsEntry?.()?.isDirectory) dirs.push(p); } catch (_) {}
          });
          if (paths.length) try { ipcRenderer?.send('avatar:files', { paths, dirs }); } catch (_) {}
        }}
        style={{
          position: 'fixed',
          left: pos.x - PAD,
          top: pos.y - PAD,
          width: SIZE + PAD * 2,
          height: SIZE + PAD * 2,
          zIndex: 100004,
          pointerEvents: 'auto',
          cursor: draggingRef.current ? 'grabbing' : 'grab',
          animation: 'av-fade .3s ease-out',
        }}
      >
        {/* sparkle field */}
        <canvas
          ref={canvasRef}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        />

        {/* working pulse rings — amber while listening, accent while thinking/streaming */}
        {working && [0, 1].map(i => (
          <div key={i} style={{
            position: 'absolute', inset: PAD - 8,
            borderRadius: '50%',
            border: `2px solid ${hexToRgba(accent, 0.7)}`,
            animation: `av-ring 1.5s ease-out ${i * 0.55}s infinite`,
            pointerEvents: 'none',
          }} />
        ))}

        {/* context-held ring */}
        {ctxHeld && (
          <div style={{
            position: 'absolute', inset: PAD - 5,
            borderRadius: '50%',
            border: `2px dashed ${hexToRgba('#fbbf24', 0.85)}`,
            animation: 'av-bob 2.2s ease-in-out infinite',
            pointerEvents: 'none',
          }} />
        )}

        {/* S2S live ring — green expanding pulses while a Talk Mode session
            is up, distinct from the amber listen + cyan planning rings */}
        {s2s && [0, 1].map(i => (
          <div key={`s2s-${i}`} style={{
            position: 'absolute', inset: PAD - 9,
            borderRadius: '50%',
            border: '2px solid rgba(52,211,153,.65)',
            animation: `av-ring 2s ease-out ${i * 0.95}s infinite`,
            pointerEvents: 'none',
          }} />
        ))}

        {/* planning-mode ring — cyan dashed slow rotation + plan badge,
            planning's theme color, distinct from the amber listen ring */}
        {planning && (
          <>
            <div style={{
              position: 'absolute', inset: PAD - 4,
              borderRadius: '50%',
              border: '2px dashed rgba(34,211,238,.8)',
              animation: 'av-spin 14s linear infinite',
              pointerEvents: 'none',
            }} />
            <div style={{
              position: 'absolute', right: PAD - 6, bottom: PAD - 4,
              width: 30, height: 32,
              pointerEvents: 'none',
              filter: 'drop-shadow(0 2px 6px rgba(34,211,238,.5))',
            }}>
              <PlanBadge accent="#22d3ee" />
            </div>
            <div style={{
              position: 'absolute', right: PAD + 24, bottom: PAD - 1,
              padding: '2px 5px', borderRadius: 999,
              color: '#67e8f9', background: 'rgba(10,14,24,.82)',
              border: '1px solid rgba(34,211,238,.35)',
              fontSize: 9, lineHeight: '12px', fontFamily: 'system-ui',
              whiteSpace: 'nowrap', pointerEvents: 'none',
            }}>
              ⌥L+⌥R exit
            </div>
          </>
        )}

        {/* file-drop catch ring */}
        {dropHint && (
          <div style={{
            position: 'absolute', inset: PAD - 6,
            borderRadius: '50%',
            border: `2.5px solid #fbbf24`,
            boxShadow: '0 0 22px rgba(251,191,36,.55), inset 0 0 18px rgba(251,191,36,.3)',
            animation: 'av-bob 1.1s ease-in-out infinite',
            pointerEvents: 'none',
          }} />
        )}

        {/* soft accent halo behind the bubble */}
        <div style={{
          position: 'absolute',
          left: PAD - 10, top: PAD - 10,
          width: SIZE + 20, height: SIZE + 20,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${hexToRgba(accent, .5)}, transparent 70%)`,
          filter: 'blur(8px)',
          opacity: active ? 0.9 : 0.55,
          pointerEvents: 'none',
          transition: 'opacity .3s',
        }} />

        {/* Optyon — a floating line-art emoji face, accent-tinted, on
            transparency. The mouth is a live waveform during voice states. */}
        <div style={{
          position: 'absolute',
          left: PAD, top: PAD,
          width: SIZE, height: SIZE,
          animation: `av-breathe ${active ? 1.8 : sleeping ? 7 : 4}s ease-in-out infinite`,
          transform: dropHint ? 'scale(1.06)' : undefined,
          opacity: mode === 'muted' ? 0.5 : sleeping ? 0.62 : hover ? 1 : 0.92,
          transition: 'opacity .3s, transform .2s',
        }}>
          <AvatarFace face={face} accent={accent} glow={hexToRgba(accent, hover || active ? 0.55 : 0.38)} suppressMouth={waveMouth} />
          {/* waveform mouth — visible while Optyon listens/thinks/speaks */}
          <canvas
            ref={barsRef}
            style={{
              position: 'absolute',
              left: (SIZE - MOUTH_W) / 2, top: 62,
              width: MOUTH_W, height: MOUTH_H,
              pointerEvents: 'none',
              opacity: waveMouth ? 1 : 0,
              transition: 'opacity .25s',
            }}
          />
        </div>

        {/* pending-approval ✓/✕ — mirrors the gestures: ✓ = ⌥R confirm of the
            top gate, ✕ = ⌥L+⌥R cancel. Fixed-positioned but a DOM child of the
            zone, so hover-lift + watchdog containment + data-avctl drag
            suppression all apply (mouseleave doesn't fire when crossing into a
            child outside the parent's box). Flips above the face when the tray
            owns the space below — same rule as the hover controls. */}
        {approval?.pending && !inputOpen && (
          <div
            data-avctl
            onPointerDown={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: pos.x + SIZE / 2,
              top: (showTray && !bubbleAbove) ? Math.max(4, pos.y - 44) : pos.y + SIZE + 4,
              transform: 'translateX(-50%)',
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '5px 7px', borderRadius: 999,
              background: 'rgba(10,14,24,.94)',
              border: `1px solid ${hexToRgba(accent, .5)}`,
              boxShadow: '0 6px 18px rgba(0,0,0,.45)',
              pointerEvents: 'auto',
              animation: 'av-fade .2s',
            }}
          >
            <button
              data-avctl className="av-ctl"
              title={approval.kind === 'question' ? 'Answer (⌥R)' : 'Approve · run (⌥R)'}
              onClick={() => { try { ipcRenderer?.send('avatar:approval-action', { action: 'confirm' }); } catch (_) {} }}
              style={{
                width: 26, height: 26, borderRadius: '50%', border: 'none', cursor: 'pointer',
                background: 'rgba(52,211,153,.9)', color: '#0f172a',
                fontSize: 14, fontWeight: 700, lineHeight: '26px', padding: 0,
              }}
            >✓</button>
            <button
              data-avctl className="av-ctl"
              title="Cancel (⌥L + ⌥R)"
              onClick={() => { try { ipcRenderer?.send('avatar:approval-action', { action: 'cancel' }); } catch (_) {} }}
              style={{
                width: 26, height: 26, borderRadius: '50%', border: 'none', cursor: 'pointer',
                background: 'rgba(239,68,68,.9)', color: '#fff',
                fontSize: 12, fontWeight: 700, lineHeight: '26px', padding: 0,
              }}
            >✕</button>
          </div>
        )}

        {/* browse-mode badge — the ↑↓ hint that arrow keys walk history while
            hovered (armed in main via avatar:history-state) */}
        {exchanges.length > 0 && (
          <button
            data-avctl
            className="av-ctl"
            title={browseIdx != null ? 'Conversation history' : 'Browse conversation history (↑/↓)'}
            onPointerDown={e => e.stopPropagation()}
            onClick={e => {
              e.stopPropagation();
              if (browseIdx == null) enterBrowse();
            }}
            style={{
            position: 'absolute', left: PAD + SIZE - 16, top: PAD - 8,
            padding: '3px 7px', borderRadius: 999,
            background: 'rgba(10,14,24,.92)', border: `1px solid ${hexToRgba(accent, .55)}`,
            color: accent, fontSize: 10, lineHeight: '12px', fontFamily: 'system-ui',
            cursor: browseIdx == null ? 'pointer' : 'default',
            animation: 'av-fade .18s', letterSpacing: 1,
          }}>
            {browseIdx == null ? '↑↓' : `${browseIdx + 1}/${exchanges.length}`}
          </button>
        )}

        {/* interim transcript pill — drops below the approval pill when both
            are up (they share the under-face slot) */}
        {mode === 'listening' && (
          <div style={{
            position: 'absolute', top: SIZE + PAD + 10 + (approval?.pending ? 42 : 0), left: '50%', transform: 'translateX(-50%)',
            width: 230, maxHeight: 60, overflow: 'hidden',
            background: 'rgba(10,14,24,.85)', border: '1px solid rgba(251,191,36,.35)',
            borderRadius: 12, padding: '6px 10px',
            color: '#fde68a', fontSize: 11, lineHeight: '15px', fontFamily: 'system-ui',
            pointerEvents: 'none', animation: 'av-fade .2s',
          }}>
            {interim ? interim.slice(-160) : 'Listening…'}
          </div>
        )}

        {/* held-selection chip — the ⌥R-confirm result is visible (not just
            the amber ring): the captured excerpt rides until the next submit
            consumes it (main clears avatar:context on consume) */}
        {ctxHeld && ctxExcerpt && mode !== 'listening' && (
          <div style={{
            position: 'absolute', top: SIZE + PAD + 10 + (approval?.pending ? 42 : 0), left: '50%', transform: 'translateX(-50%)',
            width: 230, maxHeight: 60, overflow: 'hidden',
            background: 'rgba(10,14,24,.85)', border: '1px solid rgba(251,191,36,.35)',
            borderRadius: 12, padding: '6px 10px',
            color: '#fde68a', fontSize: 11, lineHeight: '15px', fontFamily: 'system-ui',
            pointerEvents: 'none', animation: 'av-fade .2s',
          }}>
            {ctxExcerpt.slice(0, 140)}
          </div>
        )}

        {/* hover controls + palette — one column wrapper so crossing between
            them stays inside the hover DOM (an air gap used to fire
            mouseleave and make the palette unreachable). Sits on the side
            OPPOSITE the response bubble so both stay reachable. */}
        {hover && !inputOpen && !draggingRef.current && (
          <div data-avctl style={{
            position: 'absolute', left: '50%', transform: 'translateX(-50%)',
            ...(showTray && bubbleAbove
              ? { top: SIZE + PAD + 10 + (mode === 'listening' ? 66 : 0) + (approval?.pending ? 42 : 0) }
              : { bottom: SIZE + PAD + 8 }),
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            animation: 'av-fade .18s',
          }} onPointerDown={e => e.stopPropagation()}>
            {palette && (
              <div style={{
                display: 'flex', gap: 6, padding: 7,
                background: 'rgba(10,14,24,.92)', borderRadius: 999, border: '1px solid rgba(255,255,255,.14)',
                animation: 'av-fade .18s',
              }}>
                {PALETTE.map(c => (
                  <button key={c} className="av-sw" onClick={() => { setColor(c); ipcRenderer?.send('avatar:color', c); setPalette(false); }}
                    style={{
                      width: 20, height: 20, borderRadius: '50%', background: c,
                      border: c === color ? '2px solid #fff' : '1px solid rgba(255,255,255,.3)',
                      cursor: 'pointer', padding: 0,
                    }} />
                ))}
              </div>
            )}
            {legend && (
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 11px',
                background: 'rgba(10,14,24,.92)', borderRadius: 12, border: '1px solid rgba(255,255,255,.14)',
                animation: 'av-fade .18s', whiteSpace: 'nowrap',
              }}>
                {LEGEND.map(([keys, desc]) => (
                  <div key={keys} style={{
                    display: 'flex', justifyContent: 'space-between', gap: 14,
                    fontSize: 10, fontFamily: 'system-ui', lineHeight: '15px',
                  }}>
                    <span style={{ color: accent, fontWeight: 600 }}>{keys}</span>
                    <span style={{ color: 'rgba(203,213,225,.8)' }}>{desc}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{
              display: 'flex', gap: 8, padding: '6px 9px',
              background: 'rgba(10,14,24,.92)', borderRadius: 999,
              border: '1px solid rgba(255,255,255,.14)',
            }}>
              <Ctl label="×" title="Back to overlay" onClick={() => ipcRenderer?.send('avatar:exit')} />
              <Ctl label="✎" title="Prompt" onClick={() => ipcRenderer?.send('avatar:open-input')} />
              <Ctl label="📎" title="Attach files" onClick={() => ipcRenderer?.send('avatar:pick-files')} />
              <Ctl label="◐" title="Color" active={palette} onClick={() => { setPalette(p => !p); setLegend(false); }} />
              <Ctl label="⌥" title="Option-key commands" active={legend} onClick={() => { setLegend(l => !l); setPalette(false); }} />
              <Ctl label={<VoiceGlyph />} title={s2s ? 'Stop Talk Mode' : 'Talk Mode'} active={s2s} onClick={() => ipcRenderer?.send('avatar:session', { on: !s2s })} />
              <VoiceLangPicker
                lang={voiceLang}
                onPick={(code) => { setVoiceLang(code); try { ipcRenderer?.send('voice:set-lang', { lang: code }); } catch (_) {} }}
                buttonClassName="av-ctl"
                buttonStyle={{
                  width: 30, height: 30, borderRadius: '50%',
                  background: 'rgba(255,255,255,.12)', color: '#cbd5e1', fontSize: 15,
                }}
              />
            </div>
          </div>
        )}
      </div>

      {/* response bubble + results tray — comic style, flips below near screen
          top. Stays mounted while a run is live (apActive) or history is being
          browsed (view), even when the text bubble was dismissed. */}
      {showTray && bodyBubble && (
        <div
          ref={trayRef}
          onMouseEnter={trayEnter}
          onMouseLeave={trayLeave}
          style={{
            position: 'fixed',
            left: bubbleLeft,
            ...(bubbleAbove
              ? { top: pos.y - 10, transform: 'translateY(-100%)' }
              : { top: pos.y + SIZE + 12 }),
            width: 'fit-content', minWidth: 180, maxWidth: bubbleW,
            maxHeight: apActive ? 520 : 340, overflowY: 'auto',
            background: 'rgba(10,14,24,.93)',
            border: `1.5px solid ${hexToRgba(bodyBubble.phase === 'question' ? '#fbbf24' : accent, .5)}`,
            borderRadius: 16, padding: '10px 12px',
            zIndex: 100004,
            pointerEvents: 'auto',
            animation: 'av-fade .2s',
          }}
        >
          <div style={{
            position: 'absolute',
            // Aim the tail at Optyon — avatar center in bubble coordinates,
            // so it tracks even when the bubble clamps to a screen edge.
            left: pos.x + SIZE / 2 - bubbleLeft - 5,
            ...(bubbleAbove ? { bottom: -6 } : { top: -6 }),
            width: 10, height: 10,
            background: 'rgba(10,14,24,.93)',
            borderRight: `1.5px solid ${hexToRgba(bodyBubble.phase === 'question' ? '#fbbf24' : accent, .5)}`,
            borderBottom: `1.5px solid ${hexToRgba(bodyBubble.phase === 'question' ? '#fbbf24' : accent, .5)}`,
            transform: `rotate(${bubbleAbove ? 45 : 225}deg)`,
          }} />
          {/* scrollback header — the prompt this response answered, position
              in history, and click-able ↑/↓ (mirrors the armed keys) */}
          {view && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
              paddingBottom: 5, borderBottom: '1px solid rgba(255,255,255,.08)',
            }}>
              <span style={{ color: accent, fontSize: 10, fontWeight: 600, fontFamily: 'system-ui', flexShrink: 0 }}>You</span>
              <span style={{
                color: 'rgba(203,213,225,.85)', fontSize: 11, fontFamily: 'system-ui',
                flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={prettyPrompt(view.prompt)}>
                {prettyPrompt(view.prompt) || '—'}
              </span>
              <span style={{ fontSize: 9, color: 'rgba(148,163,184,.7)', fontFamily: 'system-ui', whiteSpace: 'nowrap' }}>
                {browseIdx! + 1}/{exchanges.length}
              </span>
              <button
                data-avctl className="av-ctl" title="Older (↑) — wraps to newest"
                onClick={() => navBrowse('up')}
                style={{
                  width: 18, height: 18, borderRadius: '50%', border: 'none', cursor: 'pointer',
                  background: 'rgba(255,255,255,.1)', color: '#94a3b8', fontSize: 10, lineHeight: '18px', padding: 0,
                }}
              >↑</button>
              <button
                data-avctl className="av-ctl" title="Newer (↓) — wraps to oldest"
                onClick={() => navBrowse('down')}
                style={{
                  width: 18, height: 18, borderRadius: '50%', border: 'none', cursor: 'pointer',
                  background: 'rgba(255,255,255,.1)', color: '#94a3b8', fontSize: 10, lineHeight: '18px', padding: 0,
                }}
              >↓</button>
            </div>
          )}
          {/* settled bubbles get copy + dismiss chrome — they persist until
              the user explicitly clears them (⧉ copies then clears; ✕ clears;
              ⌥R tap clears; clicking Optyon brings the latest back) */}
          {(bodyBubble.phase === 'done' || bodyBubble.phase === 'error' || bodyBubble.phase === 'question') && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, marginBottom: 2 }}>
              <button
                data-avctl className="av-ctl"
                title={copied ? 'Copied' : 'Copy response'}
                onClick={copyAndDismiss}
                style={{
                  width: 20, height: 20, borderRadius: '50%', border: 'none', cursor: 'pointer',
                  background: copied ? 'rgba(52,211,153,.9)' : 'rgba(255,255,255,.1)',
                  color: copied ? '#0f172a' : '#94a3b8', fontSize: 11, lineHeight: '20px', padding: 0,
                }}
              >{copied ? '✓' : '⧉'}</button>
              <button
                data-avctl className="av-ctl"
                title="Dismiss"
                onClick={dismissBubble}
                style={{
                  width: 20, height: 20, borderRadius: '50%', border: 'none', cursor: 'pointer',
                  background: 'rgba(255,255,255,.1)',
                  color: '#94a3b8', fontSize: 11, lineHeight: '20px', padding: 0,
                }}
              >✕</button>
            </div>
          )}
          {view && !view.bubble && (
            <div style={{ color: 'rgba(148,163,184,.6)', fontSize: 11, fontFamily: 'system-ui', fontStyle: 'italic' }}>
              No response captured for this prompt.
            </div>
          )}
          {bodyBubble.phase === 'thinking' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 2px' }}>
              <div style={{ display: 'flex', gap: 5 }}>
                {[0, 1, 2].map(i => <div key={i} style={{
                  width: 6, height: 6, borderRadius: '50%', background: accent,
                  animation: `av-dots 1s ${i * 0.15}s infinite`,
                }} />)}
              </div>
              {bodyBubble.label && <span style={{ color: 'rgba(148,163,184,.9)', fontSize: 11, fontFamily: 'system-ui' }}>{bodyBubble.label}</span>}
            </div>
          ) : bodyBubble.phase === 'question' ? (
            <div>
              <div style={{
                color: '#fde68a', fontSize: 12.5, lineHeight: '18px', fontFamily: 'system-ui',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {bodyBubble.text}
              </div>
              {(approval?.pending ? approval.kind === 'question' : true) && (
                <div style={{ marginTop: 6, fontSize: 10, color: 'rgba(148,163,184,.75)', fontFamily: 'system-ui' }}>
                  {approval?.pending ? approval.hint : '⌥R tap → reply in the prompt input'}
                </div>
              )}
            </div>
          ) : (
            <div>
              {bodyBubble.text && (
                bodyBubble.phase === 'done' ? (
                  // Settled answers render as rich markdown — same pipeline the
                  // overlay feed uses (links, lists, code, file chips).
                  <div className="avatar-md" style={{ fontSize: 12.5, lineHeight: '18px' }}>
                    <RichContentRenderer content={bodyBubble.text} />
                  </div>
                ) : (
                  <div style={{
                    // A bare error (no streamed body) reads red; when a stream
                    // survived, the failure is the notice line below instead.
                    color: bodyBubble.phase === 'error' && !bodyBubble.notice ? '#fca5a5' : '#e2e8f0',
                    fontSize: 12.5, lineHeight: '18px', fontFamily: 'system-ui',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  }}>
                    {bodyBubble.text}
                    {bodyBubble.phase === 'stream' && <span style={{ opacity: .6 }}>▌</span>}
                  </div>
                )
              )}
              {/* live step label under the stream — progress stays visible
                  alongside the answer instead of replacing it */}
              {bodyBubble.phase === 'stream' && bodyBubble.label && (
                <div style={{
                  marginTop: 6, fontSize: 10, lineHeight: '14px',
                  color: 'rgba(148,163,184,.7)', fontFamily: 'system-ui',
                }}>
                  {bodyBubble.label}
                </div>
              )}
              {/* appended status/failure summary — e.g. "Failed — 1 step(s)
                  failed: …" after the streamed body, never replacing it */}
              {bodyBubble.notice && (
                <div style={{
                  marginTop: 6, fontSize: 11, lineHeight: '15px',
                  color: '#fca5a5', fontFamily: 'system-ui',
                }}>
                  {bodyBubble.notice}
                </div>
              )}
            </div>
          )}
          {/* web/image results — same cards the overlay feed uses */}
          {bodyBubble.items && bodyBubble.items.length > 0 && (
            <div style={{ marginTop: bodyBubble.text ? 8 : 0, fontSize: 11 }}>
              <WebResultsGrid items={bodyBubble.items} />
            </div>
          )}
          {/* footnote — source count / engine */}
          {(bodyBubble.sources || bodyBubble.engine) && bodyBubble.phase !== 'thinking' && (
            <div style={{ marginTop: 6, fontSize: 10, color: 'rgba(148,163,184,.7)', fontFamily: 'system-ui' }}>
              {[bodyBubble.sources ? `${bodyBubble.sources} sources` : '', bodyBubble.engine ? `via ${bodyBubble.engine}` : ''].filter(Boolean).join(' · ')}
            </div>
          )}
          {/* full run cards — the real AutomationProgress embedded in the
              tray (self-hides at phase 'idle'); step lists, gather
              QuestionCards, and auth prompts render verbatim. It subscribes
              to the raw channels main forwards to the ghost; acceptAnyTask
              because the avatar's single surface shows whatever run is live.
              Free-text question fields are view-only here (the ghost can't
              hold focus) — answers still route through the avatar input. */}
          <div style={{ marginTop: 6, fontSize: 12 }}>
            <AutomationProgress
              acceptAnyTask
              onActiveChange={setApActive}
              onApplyDraft={(d) => {
                try { ipcRenderer?.send('edit:apply', { draftPath: d.draftPath, filePath: d.filePath }); } catch (_) {}
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}

function Ctl({ label, title, onClick, active }: { label: ReactNode; title: string; onClick: () => void; active?: boolean }) {
  return (
    <button data-avctl className="av-ctl" title={title} onClick={onClick} style={{
      width: 30, height: 30, borderRadius: '50%',
      border: 'none', cursor: 'pointer',
      background: active ? 'rgba(251,191,36,.9)' : 'rgba(255,255,255,.12)',
      color: active ? '#0f172a' : '#cbd5e1',
      fontSize: 16, lineHeight: '30px', padding: 0, textAlign: 'center',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {label}
    </button>
  );
}

export default AvatarCompanion;
