import React, { useEffect, useRef, useState } from 'react';

/**
 * Shared PTT/session dictation-language picker — used by the unified overlay
 * (next to VoiceButton) and the avatar control strip. `code` is a BCP-47 tag
 * Chrome SpeechRecognition understands; '' = system default.
 */

export interface VoiceLang {
  code: string;   // BCP-47; '' = system default (navigator.language)
  flag: string;
  name: string;
}

export const VOICE_LANGS: VoiceLang[] = [
  { code: '',       flag: '🌐', name: 'System default' },
  { code: 'en-US',  flag: '🇺🇸', name: 'English (US)' },
  { code: 'en-GB',  flag: '🇬🇧', name: 'English (UK)' },
  { code: 'es-ES',  flag: '🇪🇸', name: 'Español' },
  { code: 'es-MX',  flag: '🇲🇽', name: 'Español (México)' },
  { code: 'fr-FR',  flag: '🇫🇷', name: 'Français' },
  { code: 'de-DE',  flag: '🇩🇪', name: 'Deutsch' },
  { code: 'it-IT',  flag: '🇮🇹', name: 'Italiano' },
  { code: 'pt-BR',  flag: '🇧🇷', name: 'Português (BR)' },
  { code: 'nl-NL',  flag: '🇳🇱', name: 'Nederlands' },
  { code: 'ja-JP',  flag: '🇯🇵', name: '日本語' },
  { code: 'ko-KR',  flag: '🇰🇷', name: '한국어' },
  { code: 'zh-CN',  flag: '🇨🇳', name: '中文 (简体)' },
  { code: 'zh-TW',  flag: '🇹🇼', name: '中文 (繁體)' },
  { code: 'hi-IN',  flag: '🇮🇳', name: 'हिन्दी' },
  { code: 'ar-SA',  flag: '🇸🇦', name: 'العربية' },
  { code: 'ru-RU',  flag: '🇷🇺', name: 'Русский' },
  { code: 'pl-PL',  flag: '🇵🇱', name: 'Polski' },
  { code: 'uk-UA',  flag: '🇺🇦', name: 'Українська' },
  { code: 'sv-SE',  flag: '🇸🇪', name: 'Svenska' },
  { code: 'tr-TR',  flag: '🇹🇷', name: 'Türkçe' },
  { code: 'vi-VN',  flag: '🇻🇳', name: 'Tiếng Việt' },
  { code: 'th-TH',  flag: '🇹🇭', name: 'ไทย' },
  { code: 'id-ID',  flag: '🇮🇩', name: 'Bahasa Indonesia' },
];

/** Best display entry for a stored pref — exact, else base-language match. */
export function voiceLangEntry(code: string | null | undefined): VoiceLang {
  if (!code) return VOICE_LANGS[0];
  return VOICE_LANGS.find(l => l.code === code)
      || VOICE_LANGS.find(l => l.code && l.code.split('-')[0] === code.split('-')[0])
      || { code, flag: '🏳️', name: code };
}

interface Props {
  lang: string | null;                        // current pref (''/null = system)
  onPick: (code: string | null) => void;      // caller sends voice:set-lang
  buttonStyle?: React.CSSProperties;          // match the host surface's chrome
  buttonClassName?: string;
  title?: string;
  /** PTT active — amber ring so the dictation language reads as part of the
   *  voice cluster (mirrors VoiceButton's pttColors). */
  highlighted?: boolean;
}

export default function VoiceLangPicker({ lang, onPick, buttonStyle, buttonClassName, title, highlighted = false }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const entry = voiceLangEntry(lang);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        type="button"
        className={buttonClassName}
        title={title || `PTT language — ${entry.name}`}
        onClick={() => setOpen(o => !o)}
        style={{
          cursor: 'pointer',
          border: 'none',
          padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          ...buttonStyle,
          // Highlight wins over caller chrome (its `background: 'transparent'`
          // would otherwise swallow the PTT amber).
          ...(highlighted ? {
            background: 'rgba(251,191,36,0.18)',
            border: '1px solid rgba(251,191,36,0.45)',
            animation: 'vlp-ptt-pulse 0.7s ease-in-out infinite',
            transition: 'background-color 0.15s, border-color 0.15s',
          } : null),
        }}
      >
        <span style={{ fontSize: buttonStyle?.fontSize || 15, lineHeight: 1 }}>{entry.flag}</span>
      </button>
      <style>{`
        @keyframes vlp-ptt-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(251,191,36,0.35); }
          50% { box-shadow: 0 0 0 3px rgba(251,191,36,0.12); }
        }
      `}</style>
      {open && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 8px)', left: '50%',
          transform: 'translateX(-50%)',
          background: 'rgba(10,14,24,.96)',
          border: '1px solid rgba(255,255,255,.16)',
          borderRadius: 12, padding: 4,
          maxHeight: 240, overflowY: 'auto',
          zIndex: 100020, minWidth: 168,
          boxShadow: '0 8px 30px rgba(0,0,0,.5)',
        }}>
          {VOICE_LANGS.map(l => {
            const sel = (l.code || null) === (lang || null);
            return (
              <button
                key={l.code || 'auto'}
                type="button"
                onClick={() => { onPick(l.code || null); setOpen(false); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '6px 9px', border: 'none', borderRadius: 8, cursor: 'pointer',
                  background: sel ? 'rgba(96,165,250,.22)' : 'transparent',
                  color: sel ? '#bfdbfe' : '#cbd5e1',
                  fontSize: 12, fontFamily: 'system-ui', textAlign: 'left',
                  whiteSpace: 'nowrap',
                }}
                onMouseEnter={e => { if (!sel) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,.08)'; }}
                onMouseLeave={e => { if (!sel) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
              >
                <span style={{ fontSize: 15 }}>{l.flag}</span>
                <span>{l.name}</span>
                {sel && <span style={{ marginLeft: 'auto', color: '#60a5fa' }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
