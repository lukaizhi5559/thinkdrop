// JSON, not the .cjs — Vite dev serves .cjs verbatim (module.exports →
// ReferenceError), which crashed the GhostLayer tree at startup. The .cjs
// wrapper is for node consumers only; the renderer needs FACES alone.
import emojiCatalog from '../../../shared/emoji-catalog.json';

const { FACES } = emojiCatalog as { FACES: Record<string, { spec: FaceSpec }> };

export interface FaceSpec {
  head?: string;
  l?: string; r?: string;
  brows?: string;
  mouth?: string;
  extra?: string[];
}

// ── Eyes ── drawn per eye; `mirror` flips asymmetric shapes for the left eye.
const EYE_POS = { l: 30, r: 50 };

function Eye({ side, kind, a }: { side: 'l' | 'r'; kind: string; a: string }) {
  const x = EYE_POS[side];
  const y = 36;
  const m = side === 'l' ? -1 : 1;
  const sw = { stroke: a, strokeWidth: 2.4, strokeLinecap: 'round' as const, fill: 'none' };
  switch (kind) {
    case 'dot':     return <circle cx={x} cy={y} r={3.2} fill={a} />;
    case 'dotBig':  return <circle cx={x} cy={y} r={4.4} fill={a} />;
    case 'happy':   return <path d={`M${x - 5} ${y + 1} Q${x} ${y - 5} ${x + 5} ${y + 1}`} {...sw} />;
    case 'closedDown': return <path d={`M${x - 5} ${y - 1} Q${x} ${y + 5} ${x + 5} ${y - 1}`} {...sw} />;
    case 'flat':    return <path d={`M${x - 4} ${y} H${x + 4}`} {...sw} />;
    case 'dash':    return <path d={`M${x - 2.5} ${y} H${x + 2.5}`} {...sw} />;
    case 'heart':   return <path d={`M${x} ${y + 4} C${x - 7} ${y - 2} ${x - 3} ${y - 6} ${x} ${y - 2} C${x + 3} ${y - 6} ${x + 7} ${y - 2} ${x} ${y + 4} Z`} fill={a} />;
    case 'star':    return <path d={starPath(x, y, 5, 2.2, 5)} fill={a} />;
    case 'dollar':  return <text x={x} y={y + 3.5} textAnchor="middle" fontSize={11} fontWeight={700} fill={a}>$</text>;
    case 'x':       return <path d={`M${x - 4} ${y - 4} L${x + 4} ${y + 4} M${x + 4} ${y - 4} L${x - 4} ${y + 4}`} {...sw} />;
    case 'cross':   return <path d={`M${x} ${y - 5} V${y + 5} M${x - 5} ${y} H${x + 5}`} {...sw} />;
    case 'spiral':  return <path d={`M${x} ${y} m-4 0 a4 4 0 1 1 8 0 a3 3 0 1 1 -6 0 a2 2 0 1 1 4 0`} {...sw} />;
    case 'squint':  return <path d={`M${x - 4 * m} ${y - 4} L${x + 4 * m} ${y} L${x - 4 * m} ${y + 4}`} {...sw} />;
    case 'roll':    return (<g><path d={`M${x - 5} ${y - 4} Q${x} ${y - 8} ${x + 5} ${y - 4}`} {...sw} /><circle cx={x} cy={y - 3} r={2.2} fill={a} /></g>);
    case 'tear':    return (<g><circle cx={x} cy={y} r={3.2} fill={a} /><path d={`M${x + 4} ${y + 5} q-1.5 3 -3 3 a1.8 1.8 0 1 0 3 -3`} fill={a} /></g>);
    case 'hole':    return <circle cx={x} cy={y} r={4.4} {...sw} />;
    case 'alienEye': return <ellipse cx={x} cy={y} rx={6.5} ry={4.5} fill={a} transform={`rotate(${side === 'l' ? 22 : -22} ${x} ${y})`} />;
    case 'sq':      return <rect x={x - 3.5} y={y - 3.5} width={7} height={7} rx={1} fill={a} />;
    default:        return null;
  }
}

function starPath(cx: number, cy: number, R: number, r: number, n: number) {
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const rad = (i % 2 ? r : R);
    const ang = (Math.PI / n) * i - Math.PI / 2;
    pts.push(`${i ? 'L' : 'M'}${(cx + rad * Math.cos(ang)).toFixed(1)} ${(cy + rad * Math.sin(ang)).toFixed(1)}`);
  }
  return pts.join(' ') + ' Z';
}

// ── Brows ───────────────────────────────────────────────────────────────────
function Brows({ kind, a }: { kind?: string; a: string }) {
  const sw = { stroke: a, strokeWidth: 2.2, strokeLinecap: 'round' as const, fill: 'none' };
  switch (kind) {
    case 'up':     return (<g><path d="M24 26 Q30 22 36 26" {...sw} /><path d="M44 26 Q50 22 56 26" {...sw} /></g>);
    case 'worry':  return (<g><path d="M25 29 Q31 24 36 27" {...sw} /><path d="M55 29 Q49 24 44 27" {...sw} /></g>);
    case 'angry':  return (<g><path d="M24 25 L35 31" {...sw} /><path d="M56 25 L45 31" {...sw} /></g>);
    case 'raiseL': return (<g><path d="M24 25 Q30 21 36 25" {...sw} /><path d="M45 28 H55" {...sw} /></g>);
    default:       return null;
  }
}

// ── Mouths ──────────────────────────────────────────────────────────────────
function Mouth({ kind, a }: { kind?: string; a: string }) {
  const sw = { stroke: a, strokeWidth: 2.4, strokeLinecap: 'round' as const, fill: 'none' };
  switch (kind) {
    case 'smile':      return <path d="M28 50 Q40 59 52 50" {...sw} />;
    case 'smileSmall': return <path d="M31 51 Q40 57 49 51" {...sw} />;
    case 'beam':       return <path d="M27 48 Q40 63 53 48 Z" {...sw} />;
    case 'grin':       return (<g><path d="M27 48 Q40 63 53 48 Z" {...sw} /><path d="M28 51.5 H52" {...sw} /></g>);
    case 'frown':      return <path d="M30 57 Q40 50 50 57" {...sw} />;
    case 'frownBig':   return <path d="M27 59 Q40 47 53 59" {...sw} />;
    case 'flat':       return <path d="M32 54 H48" {...sw} />;
    case 'open':       return <ellipse cx={40} cy={55} rx={6} ry={7} {...sw} />;
    case 'oval':       return <ellipse cx={40} cy={56} rx={7} ry={10} {...sw} />;
    case 'zigzag':     return <path d="M29 54 l4 -3 4 3 4 -3 4 3 4 -3 4 3" {...sw} />;
    case 'grimace':    return (<g><rect x={28} y={50} width={24} height={9} rx={4} {...sw} /><path d="M36 50 V59 M44 50 V59" {...sw} /></g>);
    case 'tongue':     return (<g><path d="M28 50 Q40 59 52 50" {...sw} /><path d="M36 55 q0 8 4 8 q4 0 4 -8" {...sw} /></g>);
    case 'tongueBig':  return (<g><path d="M27 48 Q40 62 53 48" {...sw} /><path d="M34 53 q0 11 6 11 q6 0 6 -11" {...sw} /></g>);
    case 'lick':       return (<g><path d="M28 50 Q40 59 52 50" {...sw} /><path d="M50 53 q4 1 5 4" {...sw} /></g>);
    case 'kiss':       return <path d="M37 52 q4 -4 8 0 q-4 4 -8 0 M40 52 q0 3 -3 3" {...sw} />;
    case 'drool':      return (<g><ellipse cx={40} cy={54} rx={6} ry={5} {...sw} /><path d="M43 58 q0 5 2 7" {...sw} /></g>);
    case 'money':      return (<g><path d="M28 50 Q40 60 52 50 Z" {...sw} /><text x={40} y={58} textAnchor="middle" fontSize={9} fontWeight={700} fill={a}>$</text></g>);
    case 'zipper':     return (<g><path d="M30 54 H50" {...sw} strokeDasharray="3 2.5" /><rect x={48} y={51.5} width={5} height={5} rx={1} {...sw} /></g>);
    case 'yawn':       return <ellipse cx={40} cy={56} rx={7.5} ry={10.5} {...sw} />;
    case 'vomit':      return (<g><ellipse cx={40} cy={53} rx={6} ry={5} {...sw} /><circle cx={36} cy={62} r={1.8} fill={a} /><circle cx={42} cy={64} r={1.8} fill={a} /><circle cx={39} cy={67} r={1.5} fill={a} /></g>);
    case 'wavy':       return <path d="M30 55 q3 -3 6 0 q3 3 6 0 q3 -3 6 0" {...sw} />;
    case 'diagonal':   return <path d="M31 57 L49 51" {...sw} />;
    case 'smirk':      return <path d="M30 52 Q42 58 50 49" {...sw} />;
    case 'symbols':    return <text x={40} y={58} textAnchor="middle" fontSize={10} fontWeight={700} fill={a} letterSpacing={1}>#@%!</text>;
    case 'teethGrit':  return (<g><path d="M30 54 H50" {...sw} /><path d="M35 51 V57 M40 51 V57 M45 51 V57" {...sw} /></g>);
    case 'fang':       return (<g><path d="M28 50 Q40 60 52 50" {...sw} /><path d="M33 51.5 L35.5 56 L38 51.5 M42 51.5 L44.5 56 L47 51.5" {...sw} /></g>);
    default:           return null;
  }
}

// ── Extras ──────────────────────────────────────────────────────────────────
function Extra({ kind, a }: { kind: string; a: string }) {
  const sw = { stroke: a, strokeWidth: 2.2, strokeLinecap: 'round' as const, fill: 'none' };
  switch (kind) {
    case 'halo':     return <ellipse cx={40} cy={9} rx={15} ry={3.5} {...sw} />;
    case 'hornsS':   return (<g><path d="M25 15 L28 6 L33 13" {...sw} /><path d="M55 15 L52 6 L47 13" {...sw} /></g>);
    case 'hornsL':   return (<g><path d="M22 14 L24 3 L32 11" {...sw} /><path d="M58 14 L56 3 L48 11" {...sw} /></g>);
    case 'partyHat': return (<g><path d="M46 4 L40 22 L60 16 Z" {...sw} /><circle cx={46} cy={4} r={2} fill={a} /><path d="M28 56 l-4 6 M33 58 l-2 7" {...sw} /></g>);
    case 'cowboy':   return (<g><path d="M14 22 Q40 30 66 22" {...sw} /><path d="M26 21 Q28 8 40 8 Q52 8 54 21" {...sw} /></g>);
    case 'glasses':  return (<g><rect x={22} y={30} width={16} height={11} rx={4} {...sw} /><rect x={42} y={30} width={16} height={11} rx={4} {...sw} /><path d="M38 34 H42" {...sw} /></g>);
    case 'shades':   return (<g><rect x={21} y={30} width={17} height={10} rx={4} fill={a} /><rect x={42} y={30} width={17} height={10} rx={4} fill={a} /><path d="M38 33 H42" {...sw} /></g>);
    case 'nerd':     return (<g><rect x={22} y={30} width={16} height={11} rx={4} {...sw} /><rect x={42} y={30} width={16} height={11} rx={4} {...sw} /><path d="M38 34 H42" {...sw} /><rect x={35} y={56} width={10} height={6} rx={1.5} {...sw} /><path d="M40 56 V62" {...sw} /></g>);
    case 'monocle':  return (<g><circle cx={50} cy={36} r={8} {...sw} /><path d="M56 42 q3 10 -2 18" {...sw} /></g>);
    case 'disguise': return (<g><path d="M20 26 H60" {...sw} strokeWidth={3.5} /><rect x={22} y={30} width={16} height={10} rx={4} {...sw} /><rect x={42} y={30} width={16} height={10} rx={4} {...sw} /><ellipse cx={40} cy={47} rx={5} ry={6} {...sw} /><path d="M28 56 q6 -4 12 0 q6 -4 12 0" {...sw} /></g>);
    case 'mask':     return (<g><rect x={26} y={48} width={28} height={14} rx={6} {...sw} /><path d="M26 51 L16 46 M26 59 L16 60 M54 51 L64 46 M54 59 L64 60" {...sw} /></g>);
    case 'thermo':   return (<g><path d="M47 52 L57 42" {...sw} /><circle cx={58} cy={41} r={2.5} {...sw} /></g>);
    case 'bandage':  return (<g transform="rotate(-24 30 14)"><rect x={20} y={11} width={20} height={6} rx={3} {...sw} /><path d="M27 14 h.1 M30 14 h.1 M33 14 h.1" {...sw} /></g>);
    case 'zzz':      return <text x={57} y={16} fontSize={11} fontWeight={800} fill={a}>zZ</text>;
    case 'snot':     return (<g><circle cx={47} cy={46} r={4} {...sw} /><path d="M47 42 q-1 -3 1 -4" {...sw} /></g>);
    case 'steam':    return (<g><path d="M32 46 q-3 3 -1 6 q2 3 -1 6 M48 46 q3 3 1 6 q-2 3 1 6" {...sw} /></g>);
    case 'puff':     return (<g><circle cx={56} cy={56} r={2.4} {...sw} /><circle cx={60} cy={54} r={2.8} {...sw} /><circle cx={61} cy={59} r={2.2} {...sw} /></g>);
    case 'sweat':    return <path d="M62 20 q4 6 0 9 a3.5 3.5 0 1 1 0 -9" fill={a} />;
    case 'tearL':    return <path d="M27 44 q-4 7 0 10 a3.5 3.5 0 1 0 0 -10" fill={a} />;
    case 'tearXL':   return (<g><path d="M25 44 q-4 8 0 12 a4 4 0 1 0 0 -12" fill={a} /><path d="M55 44 q4 8 0 12 a4 4 0 1 1 0 -12" fill={a} /></g>);
    case 'tearBoth': return (<g><path d="M27 44 q-4 7 0 10 a3.5 3.5 0 1 0 0 -10" fill={a} /><path d="M53 44 q4 7 0 10 a3.5 3.5 0 1 1 0 -10" fill={a} /></g>);
    case 'drops3':   return (<g><path d="M60 30 q3 5 0 7 a2.6 2.6 0 1 1 0 -7" fill={a} /><path d="M64 38 q3 5 0 7 a2.6 2.6 0 1 1 0 -7" fill={a} /><path d="M20 30 q-3 5 0 7 a2.6 2.6 0 1 0 0 -7" fill={a} /></g>);
    case 'hands':    return (<g><circle cx={20} cy={58} r={5} {...sw} /><circle cx={60} cy={58} r={5} {...sw} /><path d="M16 54 l-3 -4 M24 54 l3 -4 M56 54 l-3 -4 M64 54 l3 -4" {...sw} /></g>);
    case 'cheekHands': return (<g><circle cx={21} cy={42} r={5.5} {...sw} /><circle cx={59} cy={42} r={5.5} {...sw} /></g>);
    case 'handMouth': return (<g><ellipse cx={40} cy={55} rx={9} ry={7} fill={a} opacity={0.9} /><path d="M34 51 v8 M40 50 v9 M46 51 v8" stroke="#000" strokeOpacity={0.35} strokeWidth={1.4} fill="none" /></g>);
    case 'peekHand': return (<g><path d="M34 20 q18 -6 26 10 q4 10 0 22 q-10 8 -24 2 q6 -6 2 -12 q-6 -4 -4 -10 q0 -8 0 -12 Z" fill={a} opacity={0.9} /><circle cx={43} cy={36} r={3} fill="#000" opacity={0.55} /></g>);
    case 'thinkHand': return (<g><circle cx={47} cy={64} r={5} {...sw} /><path d="M43 61 q-3 -3 0 -6" {...sw} /></g>);
    case 'salute':   return <rect x={50} y={22} width={16} height={5} rx={2.5} fill={a} transform="rotate(-12 58 24)" />;
    case 'shh':      return (<g><rect x={37} y={44} width={6} height={18} rx={3} {...sw} /><path d="M40 44 v-6" {...sw} /></g>);
    case 'explode':  return (<g><path d="M40 14 V6 M28 16 L22 8 M52 16 L58 8 M18 22 L10 18 M62 22 L70 18" {...sw} /><path d={starPath(40, 4, 4, 1.8, 4)} fill={a} /></g>);
    case 'melt':     return <path d="M16 58 q-2 8 -4 10 q1 3 3 1 q3 -2 3 -6 M64 58 q2 8 4 10 q-1 3 -3 1 q-3 -2 -3 -6 M40 68 q0 5 -2 7" {...sw} />;
    case 'dotted':   return <circle cx={40} cy={42} r={28.5} {...sw} strokeDasharray="4 4" opacity={0.7} />;
    case 'clouds':   return (<g><circle cx={24} cy={62} r={5} {...sw} /><circle cx={32} cy={66} r={6} {...sw} /><circle cx={48} cy={66} r={6} {...sw} /><circle cx={57} cy={62} r={5} {...sw} /></g>);
    case 'hot':      return (<g><path d="M30 12 q-2 -4 1 -6 M40 10 q-2 -4 1 -6 M50 12 q-2 -4 1 -6" {...sw} /></g>);
    case 'cold':     return (<g><path d="M60 24 l4 -4 M60 20 l4 4 M18 24 l-4 -4 M18 20 l-4 4" {...sw} /><path d="M30 66 q1 4 -1 6 M50 66 q1 4 -1 6" {...sw} /></g>);
    case 'crossbones': return (<g><path d="M24 66 L56 74 M56 66 L24 74" {...sw} strokeWidth={3} /><circle cx={22} cy={65} r={2.2} fill={a} /><circle cx={58} cy={65} r={2.2} fill={a} /><circle cx={22} cy={75} r={2.2} fill={a} /><circle cx={58} cy={75} r={2.2} fill={a} /></g>);
    case 'blush':    return (<g><path d="M19 46 l5 -2 M20 49 l5 -2 M56 44 l5 2 M55 47 l5 2" {...sw} /></g>);
    case 'tilt':     return null; // handled at face level
    case 'flip':     return null;
    case 'clownNose': return <circle cx={40} cy={45} r={5.5} {...sw} />;
    case 'longnose': return <path d="M37 44 L58 47 Q60 48 57 50 L38 48 Z" {...sw} />;
    case 'spray':    return (<g><path d="M56 44 l6 -3 M57 48 l7 0 M56 52 l6 3" {...sw} /></g>);
    case 'hearts3':  return (<g><path d="M17 30 c-4 -4 -1 -7 1 -5 c2 -2 5 1 1 5 Z" fill={a} /><path d="M62 26 c-4 -4 -1 -7 1 -5 c2 -2 5 1 1 5 Z" fill={a} /><path d="M63 50 c-3 -3 -1 -5 1 -4 c2 -1 4 1 1 4 Z" fill={a} /></g>);
    case 'heartSm':  return <path d="M56 44 c-4 -4 -1 -7 1 -5 c2 -2 5 1 1 5 Z" fill={a} />;
    case 'globe':    return (<g><circle cx={40} cy={42} r={14} {...sw} /><ellipse cx={40} cy={42} rx={6} ry={14} {...sw} /><path d="M27 38 h26 M27 46 h26" {...sw} /></g>);
    case 'inbox':    return (<g><path d="M26 40 h28 v16 h-28 Z" {...sw} /><path d="M26 40 l6 -8 h16 l6 8" {...sw} /><path d="M40 44 v8 M36 48 l4 4 4 -4" {...sw} /></g>);
    case 'speakArcs': return (<g><path d="M44 48 q6 3 0 8 M48 45 q9 6 0 14" {...sw} /></g>);
    case 'planSheet': return (<g><rect x={56} y={58} width={17} height={21} rx={2.5} {...sw} /><path d="M60 64 h9 M60 68 h9 M60 72 h5" {...sw} /><path d="M71 57 l6 -6 l2.5 2.5 l-6 6 Z" {...sw} /></g>);
    default:          return null;
  }
}

// ── Head silhouettes ────────────────────────────────────────────────────────
function Head({ kind, a }: { kind?: string; a: string }) {
  const sw = { stroke: a, strokeWidth: 2.6, fill: 'none' };
  switch (kind) {
    case 'skull':   return (<g><path d="M40 12 C24 12 15 24 15 37 C15 47 20 53 27 57 L27 64 Q27 68 31 68 L49 68 Q53 68 53 64 L53 57 C60 53 65 47 65 37 C65 24 56 12 40 12 Z" {...sw} /><circle cx={40} cy={50} r={2.4} fill={a} /></g>);
    case 'poop':    return <path d="M32 12 q-2 6 4 8 q-14 0 -14 10 q0 5 4 8 q-10 1 -10 9 q0 8 8 8 h32 q8 0 8 -8 q0 -8 -10 -9 q4 -3 4 -8 q0 -10 -14 -10 q6 -2 4 -8 Z" {...sw} />;
    case 'ghost':   return <path d="M40 12 C26 12 18 24 18 40 L18 66 q4 -6 7 -2 q3 5 7 0 q3 -5 8 0 q4 5 7 0 q3 -4 7 2 L62 40 C62 24 54 12 40 12 Z" {...sw} />;
    case 'alien':   return <path d="M40 14 C22 14 14 28 14 40 C14 54 28 68 40 68 C52 68 66 54 66 40 C66 28 58 14 40 14 Z" {...sw} />;
    case 'invader': return <path d="M20 28 h8 v-8 h8 v-8 h8 v8 h8 v8 h8 v12 h-8 v8 h8 v8 h-8 v-8 h-16 v8 h-8 v-8 h8 v-8 h-8 Z" {...sw} />;
    case 'robot':   return (<g><rect x={16} y={24} width={48} height={40} rx={8} {...sw} /><path d="M40 24 V14 M34 14 h12" {...sw} /><circle cx={40} cy={11} r={3} {...sw} /></g>);
    default:        return <circle cx={40} cy={42} r={27} {...sw} />;
  }
}

// ── The builder ─────────────────────────────────────────────────────────────
export function AvatarFace({ face, accent, glow, suppressMouth }: { face: string; accent: string; glow?: string; suppressMouth?: boolean }) {
  const entry = FACES[face] || FACES['slightly-smiling-face'];
  const s: FaceSpec = entry.spec;
  const extras = s.extra || [];
  const rot = extras.includes('tilt') ? -14 : 0;
  const flip = extras.includes('flip');
  return (
    <svg viewBox="0 0 80 84" style={{ width: '100%', height: '100%', display: 'block', overflow: 'visible', filter: glow ? `drop-shadow(0 4px 10px ${glow})` : undefined }}>
      <g transform={`rotate(${rot} 40 42)${flip ? ' scale(1,-1) translate(0,-84)' : ''}`}>
        <Head kind={s.head} a={accent} />
        <Eye side="l" kind={s.l || 'dot'} a={accent} />
        <Eye side="r" kind={s.r || 'dot'} a={accent} />
        <Brows kind={s.brows} a={accent} />
        {!suppressMouth && <Mouth kind={s.mouth} a={accent} />}
        {extras.map(e => <Extra key={e} kind={e} a={accent} />)}
      </g>
    </svg>
  );
}

export function faceExists(face: string): boolean { return !!FACES[face]; }

// Planning-mode badge — the planSheet extra as a standalone corner badge.
export function PlanBadge({ accent }: { accent: string }) {
  return (
    <svg viewBox="0 0 80 84" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
      <Extra kind="planSheet" a={accent} />
    </svg>
  );
}
