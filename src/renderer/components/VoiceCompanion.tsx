/**
 * VoiceCompanion — Full-screen Chrome voice interface
 *
 * Opened by Electron via shell.openExternal('http://localhost:5173?mode=voice-companion').
 * Uses webkitSpeechRecognition (works in real Chrome, not Electron) for fast on-device STT.
 *
 * Voice pipeline (Tier 1 / Tier 2):
 *   Chrome STT → POST localhost:3006/voice.process (skipSTT, skipTTS)
 *     → personality-service:3012 overlay injected into Butler system prompt
 *     → fast-lane Butler LLM → text answer returned immediately (<1s)
 *     → if classifySGTrigger fires → StateGraph escalation in background
 *         → background result arrives via POST localhost:3010/voice/result → IPC
 *
 * Tier 3 (control plane) is handled separately via IPC, not this component.
 * Plays responses via speechSynthesis (instant macOS voices, no audio roundtrip).
 * Closes itself when Electron sends SSE 'close' event via GET /voice/companion/events.
 *
 * Animation: Canvas 2D pulsing orb — requestAnimationFrame, ~0% CPU when idle.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

type CompanionState = 'idle' | 'listening' | 'processing' | 'speaking' | 'error';

// Route through voice-service for personality injection + Butler LLM + optional SG escalation
const PROCESS_URL = 'http://localhost:3006/voice.process';
const TTS_URL     = 'http://localhost:3006/voice.tts';   // OpenAI TTS proxy — non-English
const EVENTS_URL  = 'http://localhost:3010/voice/companion/events';

// BCP-47 map used by both detection paths and lang switching
const LANG_BCP47: Record<string, string> = {
  en: 'en-US', zh: 'zh-CN', es: 'es-ES', fr: 'fr-FR', de: 'de-DE',
  ja: 'ja-JP', ko: 'ko-KR', pt: 'pt-BR', it: 'it-IT', ru: 'ru-RU',
  ar: 'ar-SA', hi: 'hi-IN', tr: 'tr-TR', nl: 'nl-NL', pl: 'pl-PL',
  sv: 'sv-SE', id: 'id-ID', vi: 'vi-VN', th: 'th-TH',
};

/**
 * Fast, sync, zero-dep language detection based on Unicode script ranges.
 * Handles non-Latin scripts (Chinese, Japanese, Korean, Arabic, Russian,
 * Hindi, Thai) with ~100% accuracy — no network call, no library.
 * Returns a BCP-47 locale string or null for Latin-script text.
 */
function detectScriptLang(text: string): string | null {
  // CJK Unified Ideographs — Mandarin / Classical Chinese
  if (/[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text)) return 'zh-CN';
  // Hiragana / Katakana — Japanese (must come AFTER CJK so kanji-only → zh)
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja-JP';
  // Hangul — Korean
  if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(text)) return 'ko-KR';
  // Arabic script
  if (/[\u0600-\u06FF\u0750-\u077F]/.test(text)) return 'ar-SA';
  // Cyrillic — Russian (most common), also covers Ukrainian etc.
  if (/[\u0400-\u04FF]/.test(text)) return 'ru-RU';
  // Devanagari — Hindi
  if (/[\u0900-\u097F]/.test(text)) return 'hi-IN';
  // Thai
  if (/[\u0E00-\u0E7F]/.test(text)) return 'th-TH';
  // Vietnamese has Latin base but unique diacritics — good heuristic
  if (/[\u1EA0-\u1EF9]/.test(text)) return 'vi-VN';
  // Latin-script languages (en/es/fr/de/pt/it…) → need AI or server detection
  return null;
}

/**
 * Try Chrome's experimental built-in AI Language Detector.
 * Only available in Chrome >= 129 with the flag enabled.
 * Best effort — silently returns null if unavailable or fails.
 * Primarily useful for distinguishing Latin-script languages (en vs es vs fr).
 */
async function tryDetectWithChromeAI(text: string): Promise<string | null> {
  try {
    const ai = (window as any).ai;
    // Check both the new (M129+) and older preview APIs
    const LD = ai?.languageDetector ?? (window as any).LanguageDetector;
    if (!LD) return null;
    const detector = await LD.create();
    const results  = await detector.detect(text);
    const top = results?.[0];
    if (!top?.detectedLanguage || (top.confidence ?? 1) < 0.55) return null;
    const code = top.detectedLanguage.toLowerCase().split('-')[0];
    return LANG_BCP47[code] ?? null;
  } catch {
    return null;
  }
}

// ── Siri-style fluid sphere animation ────────────────────────────────────────
// Morphing blob silhouette + swirling color blobs + specular highlight.
// Pure Canvas 2D — no WebGL, ~0% CPU when idle.

interface SiriOrbParams {
  color1: string;      // dominant centre colour
  color2: string;      // swirling blob A
  color3: string;      // swirling blob B
  edgeColor: string;   // dark rim colour
  pulseRingColor: string; // expanding ring colour for active states
  morphAmt: number;    // blob shape distortion  (0 = perfect sphere)
  swirlSpeed: number;  // how fast colour blobs orbit
  pulseSpeed: number;  // overall size breathing speed
  pulseAmt: number;    // breathing amplitude
}

const ORB_STATE: Record<CompanionState, SiriOrbParams> = {
  idle: {
    color1: '#1a3a5c', color2: '#0f2a50', color3: '#1a2d4a',
    edgeColor: '#060d1a', pulseRingColor: '#334155',
    morphAmt: 0.012, swirlSpeed: 0.004, pulseSpeed: 0.006, pulseAmt: 0.010,
  },
  listening: {
    color1: '#1565C0', color2: '#00B0FF', color3: '#0097A7',
    edgeColor: '#071628', pulseRingColor: '#60a5fa',
    // slow organic drift + big gentle breathing pulse while user speaks
    morphAmt: 0.025, swirlSpeed: 0.008, pulseSpeed: 0.018, pulseAmt: 0.10,
  },
  processing: {
    color1: '#6A1B9A', color2: '#CE93D8', color3: '#4527A0',
    edgeColor: '#130820', pulseRingColor: '#c084fc',
    morphAmt: 0.04, swirlSpeed: 0.018, pulseSpeed: 0.028, pulseAmt: 0.028,
  },
  speaking: {
    color1: '#00695C', color2: '#26C6DA', color3: '#43A047',
    edgeColor: '#001a10', pulseRingColor: '#4ade80',
    // rhythmic pulse rings radiate outward while AI speaks
    morphAmt: 0.02, swirlSpeed: 0.010, pulseSpeed: 0.032, pulseAmt: 0.12,
  },
  error: {
    color1: '#C62828', color2: '#FF6D00', color3: '#B71C1C',
    edgeColor: '#1a0404', pulseRingColor: '#f87171',
    morphAmt: 0.05, swirlSpeed: 0.025, pulseSpeed: 0.045, pulseAmt: 0.035,
  },
};

function drawSiriOrb(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number,
  baseR: number,
  t: number,           // monotone time counter, ~0.016 per frame
  params: SiriOrbParams,
  showPulse = false,   // emit expanding rings (listening / speaking)
) {
  const { color1, color2, color3, edgeColor, pulseRingColor, morphAmt, swirlSpeed, pulseSpeed, pulseAmt } = params;

  // Breathing radius — slowed down pulse
  const r = baseR * (1 + Math.sin(t * pulseSpeed * 18) * pulseAmt);

  // ── Build morphing blob path ─────────────────────────────────────────────
  // 80 control points with 3 slow harmonic distortions → smooth, calm silhouette
  const N = 80;
  const pts: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const d =
      morphAmt * 0.55 * Math.sin(3 * a + t * 4)   +
      morphAmt * 0.30 * Math.sin(5 * a - t * 6.5) +
      morphAmt * 0.15 * Math.sin(7 * a + t * 9);
    const pr = r * (1 + d);
    pts.push([cx + pr * Math.cos(a), cy + pr * Math.sin(a)]);
  }

  // Smooth quadratic curve through midpoints (cheap catmull-rom approx)
  const blob = new Path2D();
  blob.moveTo(
    (pts[0][0] + pts[N - 1][0]) / 2,
    (pts[0][1] + pts[N - 1][1]) / 2,
  );
  for (let i = 0; i < N; i++) {
    const p0 = pts[i];
    const p1 = pts[(i + 1) % N];
    blob.quadraticCurveTo(p0[0], p0[1], (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
  }
  blob.closePath();

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // ── Outer atmospheric glow — dimmer to keep the orb translucent ──────────
  const glowGrad = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 2.1);
  glowGrad.addColorStop(0,   color1 + '28');
  glowGrad.addColorStop(0.5, color2 + '0e');
  glowGrad.addColorStop(1,   'transparent');
  ctx.fillStyle = glowGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 2.1, 0, Math.PI * 2);
  ctx.fill();

  // ── Interior — clipped to blob ───────────────────────────────────────────
  ctx.save();
  ctx.clip(blob);

  // Base gradient: translucent centre → dark edge
  const baseGrad = ctx.createRadialGradient(cx - r * 0.08, cy - r * 0.08, 0, cx, cy, r * 1.05);
  baseGrad.addColorStop(0,   color1 + '90');
  baseGrad.addColorStop(0.55, color1 + '55');
  baseGrad.addColorStop(1,   edgeColor + '88');
  ctx.fillStyle = baseGrad;
  ctx.fill(blob);

  // Swirling colour blob A — very slow orbit
  const s1x = cx + r * 0.38 * Math.cos(t * swirlSpeed * 14);
  const s1y = cy + r * 0.28 * Math.sin(t * swirlSpeed * 14 * 0.71);
  const swirl1 = ctx.createRadialGradient(s1x, s1y, 0, s1x, s1y, r * 0.78);
  swirl1.addColorStop(0,   color2 + '70');
  swirl1.addColorStop(0.6, color2 + '22');
  swirl1.addColorStop(1,   'transparent');
  ctx.fillStyle = swirl1;
  ctx.fill(blob);

  // Swirling colour blob B — counter-orbits even slower
  const s2x = cx + r * 0.30 * Math.cos(t * swirlSpeed * 14 * 0.79 + Math.PI * 0.65);
  const s2y = cy + r * 0.34 * Math.sin(t * swirlSpeed * 14 * 0.55 + Math.PI * 0.40);
  const swirl2 = ctx.createRadialGradient(s2x, s2y, 0, s2x, s2y, r * 0.62);
  swirl2.addColorStop(0,   color3 + '55');
  swirl2.addColorStop(0.6, color3 + '18');
  swirl2.addColorStop(1,   'transparent');
  ctx.fillStyle = swirl2;
  ctx.fill(blob);

  // Specular highlight — barely moves
  const hx = cx - r * (0.24 + 0.05 * Math.sin(t * 2.5));
  const hy = cy - r * (0.28 + 0.04 * Math.cos(t * 3));
  const specGrad = ctx.createRadialGradient(hx, hy, 0, hx, hy, r * 0.52);
  specGrad.addColorStop(0,   'rgba(255,255,255,0.18)');
  specGrad.addColorStop(0.45,'rgba(255,255,255,0.05)');
  specGrad.addColorStop(1,   'transparent');
  ctx.fillStyle = specGrad;
  ctx.fill(blob);

  ctx.restore();

  // Translucent rim
  ctx.strokeStyle = color1 + '30';
  ctx.lineWidth   = 1.2;
  ctx.stroke(blob);

  // ── Expanding pulse rings (listening = user speaking, speaking = AI output)
  if (showPulse) {
    // Two rings offset by half a cycle so they alternate smoothly
    const RING_CYCLE = 2.8;   // seconds per full expansion
    const speed = 1 / RING_CYCLE;
    const phase1 = (t * speed) % 1;
    const phase2 = (t * speed + 0.5) % 1;

    for (const phase of [phase1, phase2]) {
      const ringR  = r * (1.05 + phase * 1.8);
      const alpha  = (1 - phase) * 0.45;
      if (alpha < 0.01) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
      // Parse pulseRingColor as hex → rgba for the ring
      const rc = pulseRingColor;
      const rr = parseInt(rc.slice(1, 3), 16);
      const rg = parseInt(rc.slice(3, 5), 16);
      const rb = parseInt(rc.slice(5, 7), 16);
      ctx.strokeStyle = `rgba(${rr},${rg},${rb},${alpha.toFixed(3)})`;
      ctx.lineWidth = 1.8 * (1 - phase * 0.6);
      ctx.stroke();
    }
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function VoiceCompanion() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const warpRef   = useRef<HTMLCanvasElement>(null);   // full-screen warp background
  const stateRef  = useRef<CompanionState>('idle');
  const tRef      = useRef(0);   // monotone time, +0.016 per frame (~60fps)
  const rafRef    = useRef<number>(0);
  const warpRafRef = useRef<number>(0);
  const recognitionRef = useRef<any>(null);
  const sendingRef = useRef(false);   // true while fetch in-flight

  // Current STT language — updated after each response so Chrome adapts to detected lang
  // navigator.language is only the starting guess (browser UI, not spoken language).
  const sttLangRef = useRef<string>(navigator.language || 'en-US');

  // Replaced by LANG_BCP47 (module-level) — kept as alias for backward compat
  const LANG_TO_BCP47 = LANG_BCP47;

  const audioCtxRef       = useRef<AudioContext | null>(null);
  const audioSourceRef    = useRef<AudioBufferSourceNode | null>(null);

  // ── Base64 audio player (mp3/wav from OpenAI TTS) ───────────────────────
  // Used for OpenAI TTS (non-English). Resolves when playback ends.
  const playBase64Audio = useCallback((audioBase64: string, _fmt = 'mp3'): Promise<void> => {
    return new Promise((resolve, reject) => {
      try { audioSourceRef.current?.stop(); } catch (_) {}
      const audioCtx = audioCtxRef.current;
      if (!audioCtx || audioCtx.state === 'closed') { reject(new Error('AudioContext not ready')); return; }
      const resume = audioCtx.state === 'suspended' ? audioCtx.resume() : Promise.resolve();
      resume.then(() => {
        const bytes = Uint8Array.from(atob(audioBase64), c => c.charCodeAt(0));
        return audioCtx.decodeAudioData(bytes.buffer.slice(0));
      }).then(buffer => {
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        audioSourceRef.current = source;
        setCompanionState('speaking');
        source.onended = () => {
          sendingRef.current = false;
          setCompanionState('listening');
          createAndStartRef.current?.();
          resolve();
        };
        source.start(0);
      }).catch(reject);
    });
  }, []);

  // Exposed by the STT effect so injectTranscript can restart listening after speaking.
  const createAndStartRef = useRef<(() => void) | null>(null);
  const unlockedRef       = useRef(false);   // true once user clicks to start

  const [unlocked,       setUnlocked]       = useState(false);
  const [companionState, setCompanionState] = useState<CompanionState>('idle');
  const [interimText,    setInterimText]    = useState('');
  const [lastTranscript, setLastTranscript] = useState('');
  const [responseText,   setResponseText]   = useState('');
  const [errorMsg,       setErrorMsg]       = useState('');
  // Visible language label — mirrors sttLangRef so the button updates after auto-detect
  const [sttDisplayLang, setSttDisplayLang] = useState<string>(
    (navigator.language || 'en-US').substring(0, 2).toUpperCase()
  );

  // Pre-warm AudioContext on the user-gesture click so subsequent audio plays fine.
  const handleUnlock = useCallback(() => {
    if (unlockedRef.current) return;
    unlockedRef.current = true;
    setUnlocked(true);
    // Create + resume here while we still have the gesture context.
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext();
    }
    audioCtxRef.current.resume().catch(() => {});
  }, []);

  // Sync display label when voice-service auto-detects a new language
  useEffect(() => {
    setSttDisplayLang(sttLangRef.current.substring(0, 2).toUpperCase());
  }, [companionState]);  // fires after each response cycle

  // ── Language cycle button ──────────────────────────────────────────────
  // Cycles through common languages and restarts Chrome STT in the new mode.
  // Chrome STT must be restarted (not just .lang= changed) to switch language.
  const STT_LANG_CYCLE = [
    { bcp47: 'en-US', label: 'EN' },
    { bcp47: 'zh-CN', label: 'ZH' },
    { bcp47: 'zh-TW', label: 'ZH-TW' },
    { bcp47: 'ja-JP', label: 'JA' },
    { bcp47: 'ko-KR', label: 'KO' },
    { bcp47: 'es-ES', label: 'ES' },
    { bcp47: 'fr-FR', label: 'FR' },
    { bcp47: 'de-DE', label: 'DE' },
    { bcp47: 'ar-SA', label: 'AR' },
    { bcp47: 'hi-IN', label: 'HI' },
    { bcp47: 'pt-BR', label: 'PT' },
    { bcp47: 'ru-RU', label: 'RU' },
  ];

  const cycleLang = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();  // don’t trigger handleUnlock
    if (!unlocked || sendingRef.current) return;
    const cur = sttLangRef.current;
    const idx = STT_LANG_CYCLE.findIndex(l => l.bcp47 === cur);
    const next = STT_LANG_CYCLE[(idx + 1) % STT_LANG_CYCLE.length];
    sttLangRef.current = next.bcp47;
    setSttDisplayLang(next.label);
    // Abort current recognition and restart in new language
    try { recognitionRef.current?.abort(); } catch (_) {}
    recognitionRef.current = null;
    setTimeout(() => createAndStartRef.current?.(), 150);
    console.info(`[VoiceCompanion] Language toggled: ${cur} → ${next.bcp47}`);
  }, [unlocked]);
  // Keep stateRef in sync for the rAF loop (avoids closure stale)
  useEffect(() => { stateRef.current = companionState; }, [companionState]);
  // ── Warp starfield background ──────────────────────────────────────────────
  useEffect(() => {
    const canvas = warpRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const resize = () => {
      canvas.width  = window.innerWidth  * devicePixelRatio;
      canvas.height = window.innerHeight * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
    };
    resize();
    window.addEventListener('resize', resize);

    // ── Dust particles — static scatter like Warp terminal ─────────────────
    const N_STARS = 320;
    interface Star { x: number; y: number; r: number; alpha: number; twinkleOffset: number; twinkleSpeed: number; }
    const stars: Star[] = Array.from({ length: N_STARS }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: Math.random() * 1.2 + 0.3,          // tiny dots, 0.3–1.5 px
      alpha: Math.random() * 0.28 + 0.06,    // very dim: 0.06–0.34
      twinkleOffset: Math.random() * Math.PI * 2,
      twinkleSpeed:  Math.random() * 0.008 + 0.002, // extremely slow twinkle
    }));

    let warpT = 0;
    const warpLoop = () => {
      warpT += 0.016;
      const W = window.innerWidth;
      const H = window.innerHeight;

      // Full clear each frame — no trails, just static dots
      ctx.fillStyle = '#0b0b0b';
      ctx.fillRect(0, 0, W, H);

      for (const s of stars) {
        // Gentle twinkle: alpha oscillates very slowly
        const a = s.alpha * (0.7 + 0.3 * Math.sin(warpT * s.twinkleSpeed * 60 + s.twinkleOffset));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(210,210,220,${a.toFixed(3)})`;
        ctx.fill();
      }

      warpRafRef.current = requestAnimationFrame(warpLoop);
    };
    warpLoop();

    return () => {
      cancelAnimationFrame(warpRafRef.current);
      window.removeEventListener('resize', resize);
    };
  }, []);

  // ── Orb animation loop ────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;

    const resize = () => {
      canvas.width = canvas.offsetWidth * devicePixelRatio;
      canvas.height = canvas.offsetHeight * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const loop = () => {
      tRef.current += 0.016;   // ~1/60 s per frame
      const state  = stateRef.current;
      const params = ORB_STATE[state];
      const w = canvas.offsetWidth, h = canvas.offsetHeight;
      const baseR = Math.min(w, h) * 0.22;
      const showPulse = state === 'listening' || state === 'speaking';
      drawSiriOrb(ctx, w / 2, h / 2, baseR, tRef.current, params, showPulse);
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();

    return () => {
      cancelAnimationFrame(rafRef.current);
      ro.disconnect();
    };
  }, []);

  // ── SSE — listen for Electron's close signal ──────────────────────────────
  useEffect(() => {
    let es: EventSource;
    let retryTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      es = new EventSource(EVENTS_URL);
      es.addEventListener('close', () => {
        if (recognitionRef.current) {
          try { recognitionRef.current.abort(); } catch (_) {}
        }
        window.speechSynthesis?.cancel();
        try { audioSourceRef.current?.stop(); } catch (_) {}
        try { audioCtxRef.current?.close(); } catch (_) {}
        window.close();
      });
      es.onerror = () => {
        es.close();
        // Retry after 3s in case Electron hasn't started yet
        retryTimeout = setTimeout(connect, 3000);
      };
    };
    connect();

    return () => {
      clearTimeout(retryTimeout);
      es?.close();
    };
  }, []);


  const speakMacOS = useCallback((text: string, lang = 'en') => {
    const SS = window.speechSynthesis;
    if (!SS) { sendingRef.current = false; setCompanionState('listening'); createAndStartRef.current?.(); return; }
    SS.cancel();

    const localeMap: Record<string, string> = {
      en: 'en', zh: 'zh', ja: 'ja', ko: 'ko',
      es: 'es', fr: 'fr', de: 'de', ar: 'ar',
      pt: 'pt', it: 'it', ru: 'ru', hi: 'hi',
      tr: 'tr', nl: 'nl', pl: 'pl', sv: 'sv',
    };
    const lang2 = (lang || 'en').substring(0, 2).toLowerCase();
    const langPrefix = localeMap[lang2] || 'en';

    const doSpeak = () => {
      const voices = SS.getVoices();
      const candidates = voices.filter(v =>
        v.lang.toLowerCase().startsWith(langPrefix) &&
        !v.name.toLowerCase().includes('eloquence') // skip robotic
      );

      // Priority: Premium > Enhanced > local > any for this language
      const pick =
        candidates.find(v => v.name.includes('(Premium)')) ||
        candidates.find(v => v.name.includes('(Enhanced)')) ||
        candidates.find(v => v.localService) ||
        candidates[0] ||
        // Fallback to any English premium if lang not found
        voices.find(v => v.lang.startsWith('en') && v.name.includes('(Premium)')) ||
        null;

      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = pick?.lang || `${langPrefix}-${langPrefix.toUpperCase()}`;
      utter.rate = 1.05;
      if (pick) utter.voice = pick;

      setCompanionState('speaking');
      utter.onend = () => {
        sendingRef.current = false;
        setCompanionState('listening');
        createAndStartRef.current?.();
      };
      utter.onerror = () => {
        sendingRef.current = false;
        setCompanionState('listening');
        createAndStartRef.current?.();
      };
      SS.speak(utter);
    };

    // Chrome loads voices asynchronously — wait if not ready yet
    if (SS.getVoices().length > 0) {
      doSpeak();
    } else {
      SS.onvoiceschanged = () => { SS.onvoiceschanged = null; doSpeak(); };
    }
  }, []);

  // OpenAI TTS (nova, multilingual) → macOS last resort
  const speakKokoro = useCallback(async (text: string, lang = 'en') => {
    try {
      const res = await fetch(TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, language: lang }),
      });
      const json = await res.json();
      const b64 = json?.data?.audioBase64 || json?.audioBase64 || '';
      if (b64) { await playBase64Audio(b64, 'mp3'); return; }
    } catch (err) {
      console.warn('[TTS] OpenAI error:', err);
    }
    speakMacOS(text, lang);  // offline last resort
  }, [speakMacOS, playBase64Audio]);

  // Map 2-letter language codes from Groq/voice-service → BCP-47 locale Chrome understands
  // NOTE: LANG_TO_BCP47 is now an alias for the module-level LANG_BCP47 constant.

  // ── Send transcript → voice-service → Butler LLM → macOS TTS ────────────
  const injectTranscript = useCallback(async (transcript: string, sttLang?: string) => {
    if (!transcript.trim() || sendingRef.current) return;
    sendingRef.current = true;
    // Abort mic immediately — prevents AI's voice being picked up as input (echo loop)
    try { recognitionRef.current?.abort(); } catch (_) {}
    recognitionRef.current = null;
    setLastTranscript(transcript);
    setInterimText('');
    setResponseText('');
    setCompanionState('processing');

    try {
      const res = await fetch(PROCESS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript,
          skipSTT: true,   // Chrome already transcribed — skip Groq Whisper
          skipTTS: true,   // Skip Cartesia — macOS speechSynthesis is faster
          languageHint: sttLang || null,
          source: 'voice-companion',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json.data ?? json;

      const answer: string = result.responseFinal || result.responseEnglish || result.text || '';
      const lang: string   = result.detectedLanguage || sttLang || 'en';

      // ── Adaptive language switch ────────────────────────────────────────
      const lang2   = (lang || 'en').substring(0, 2).toLowerCase();
      const newBcp47 = LANG_TO_BCP47[lang2] || sttLangRef.current;
      if (newBcp47 !== sttLangRef.current) {
        console.info(`[VoiceCompanion] Lang switch: ${sttLangRef.current} → ${newBcp47}`);
        sttLangRef.current = newBcp47;
      }

      setResponseText(answer);

      if (answer) {
        speakKokoro(answer, lang);  // OpenAI TTS nova → macOS fallback
      } else {
        sendingRef.current = false;
        setCompanionState('listening');
        createAndStartRef.current?.();
      }
    } catch (err: any) {
      console.error('[VoiceCompanion] process error:', err.message);
      setErrorMsg('Could not reach Thinkdrop. Is it running?');
      sendingRef.current = false;
      setCompanionState('error');
      createAndStartRef.current?.();
      setTimeout(() => { setCompanionState('listening'); setErrorMsg(''); }, 3000);
    }
  }, [speakKokoro]);  // LANG_TO_BCP47 intentionally omitted — stable object

  // ── webkitSpeechRecognition ───────────────────────────────────────────────
  // Only starts after user click (unlocked). Recognition is aborted before
  // speaking and restarted via createAndStartRef after audio ends.
  useEffect(() => {
    if (!unlocked) return;  // wait for user gesture

    const W = window as any;
    const SR = W.webkitSpeechRecognition || W.SpeechRecognition;
    if (!SR) {
      setErrorMsg('Speech recognition not available — open in Chrome');
      setCompanionState('error');
      return;
    }

    let active = true;

    const createAndStart = () => {
      if (!active) return;
      const rec = new SR();
      rec.continuous     = true;
      rec.interimResults = true;
      rec.lang           = sttLangRef.current;
      recognitionRef.current = rec;

      rec.onstart = () => setCompanionState('listening');

      rec.onresult = (event: any) => {
        // Ignore results while processing/speaking — the abort should have
        // stopped new events, but guard here as a safety net.
        if (sendingRef.current) return;
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) {
            const text = r[0].transcript.trim();
            if (text.length <= 1) continue;

            // ── Client-side language detection ────────────────────────────
            // 1. Instant script-based detection (sync, no deps)
            //    Handles Chinese, Japanese, Korean, Arabic, Russian, Hindi, Thai.
            //    Returns null for Latin-script text (en/es/fr/de/pt…).
            const scriptLang = detectScriptLang(text);
            if (scriptLang && scriptLang !== sttLangRef.current) {
              console.info(`[VoiceCompanion] Script detected: ${sttLangRef.current} → ${scriptLang}`);
              sttLangRef.current = scriptLang;
            }

            // 2. Chrome AI detection for Latin-script languages (async, fire-and-forget)
            //    Updates sttLangRef for the NEXT utterance — zero impact on current call.
            if (!scriptLang) {
              tryDetectWithChromeAI(text).then(aiLang => {
                if (aiLang && aiLang !== sttLangRef.current) {
                  console.info(`[VoiceCompanion] Chrome AI detected: ${sttLangRef.current} → ${aiLang}`);
                  sttLangRef.current = aiLang;
                }
              });
            }

            injectTranscript(text, sttLangRef.current);
          } else {
            interim += r[0].transcript;
          }
        }
        setInterimText(interim);
      };

      rec.onerror = (e: any) => {
        if (e.error === 'aborted' || e.error === 'not-allowed') return;
        console.warn('[VoiceCompanion] STT error:', e.error);
      };

      rec.onend = () => {
        // Only auto-restart on natural end (silence timeout).
        // Do NOT restart if we aborted it intentionally (recognitionRef set null).
        if (recognitionRef.current === rec && active && !sendingRef.current) {
          setTimeout(createAndStart, 300);
        }
      };

      try { rec.start(); } catch (e) {
        console.warn('[VoiceCompanion] Failed to start recognition:', e);
      }
    };

    // Expose so injectTranscript / speakMacOS can restart after audio ends
    createAndStartRef.current = createAndStart;
    createAndStart();

    return () => {
      active = false;
      createAndStartRef.current = null;
      const r = recognitionRef.current;
      recognitionRef.current = null;
      try { r?.abort(); } catch (_) {}
    };
  }, [unlocked, injectTranscript]);

  // ── Render ────────────────────────────────────────────────────────────────
  const stateLabel: Record<CompanionState, string> = {
    idle: 'Ready',
    listening: 'Listening…',
    processing: 'Thinking…',
    speaking: 'Speaking…',
    error: 'Error',
  };

  const stateAccent: Record<CompanionState, string> = {
    idle: '#64748b',
    listening: '#60a5fa',
    processing: '#c084fc',
    speaking: '#4ade80',
    error: '#f87171',
  };

  return (
    <div
      onClick={handleUnlock}
      style={{
        width: '100vw', height: '100vh',
        backgroundColor: '#0b0b0b',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        color: '#e2e8f0',
        overflow: 'hidden',
        userSelect: 'none',
        position: 'relative',
        cursor: unlocked ? 'default' : 'pointer',
      }}
    >
      {/* Click-to-start overlay — Chrome requires a user gesture before AudioContext */}
      {!unlocked && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          background: 'rgba(11,11,11,0.92)',
        }}>
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            border: '1.5px solid rgba(255,255,255,0.18)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 20,
            fontSize: 28,
          }}>🎙</div>
          <div style={{ fontSize: '1rem', color: 'rgba(255,255,255,0.7)', letterSpacing: '0.06em' }}>
            Tap anywhere to begin
          </div>
        </div>
      )}
      {/* Warp starfield — full-screen background layer */}
      <canvas
        ref={warpRef}
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          display: 'block',
          zIndex: 0,
        }}
      />

      {/* All foreground content above warp */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* Orb canvas */}
      <canvas
        ref={canvasRef}
        style={{ width: '340px', height: '340px', display: 'block' }}
      />

      {/* Status label */}
      <div style={{
        marginTop: '8px',
        fontSize: '0.9rem',
        fontWeight: 500,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: stateAccent[companionState],
        transition: 'color 0.3s',
        minHeight: '1.4em',
      }}>
        {errorMsg || stateLabel[companionState]}
      </div>

      {/* Transcript area */}
      <div style={{
        marginTop: '28px',
        width: '480px',
        maxWidth: '90vw',
        minHeight: '48px',
        textAlign: 'center',
      }}>
        {/* Interim (live) */}
        {interimText && (
          <div style={{ fontSize: '1.05rem', color: '#94a3b8', fontStyle: 'italic', lineHeight: 1.5 }}>
            {interimText}
          </div>
        )}

        {/* Confirmed transcript */}
        {!interimText && lastTranscript && (
          <div style={{ fontSize: '1.05rem', color: '#cbd5e1', lineHeight: 1.5 }}>
            "{lastTranscript}"
          </div>
        )}
      </div>

      {/* Response */}
      {responseText && (
        <div style={{
          marginTop: '20px',
          width: '520px',
          maxWidth: '90vw',
          padding: '16px 20px',
          borderRadius: '12px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          fontSize: '0.95rem',
          lineHeight: 1.65,
          color: '#e2e8f0',
          textAlign: 'center',
        }}>
          {responseText}
        </div>
      )}

      {/* Language toggle + status footer */}
      <div style={{
        marginTop: '48px',
        display: 'flex', alignItems: 'center', gap: '12px',
      }}>
        {/* Language toggle button */}
        {unlocked && (
          <button
            onClick={cycleLang}
            title="Tap to switch STT language"
            style={{
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '6px',
              color: 'rgba(255,255,255,0.55)',
              fontSize: '0.65rem',
              letterSpacing: '0.12em',
              padding: '3px 8px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              lineHeight: 1.4,
              transition: 'all 0.15s',
            }}
          >
            {sttDisplayLang}
          </button>
        )}

        {/* Service label */}
        <div style={{
          fontSize: '0.7rem', color: 'rgba(255,255,255,0.12)',
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
        }}>
          THINKDROP VOICE
        </div>
      </div>
      </div>{/* end foreground */}
    </div>
  );
}
