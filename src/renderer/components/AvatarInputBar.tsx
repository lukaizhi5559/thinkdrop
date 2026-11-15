import { useEffect, useRef, useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;
const TOKEN = 'avatar-input';

const basename = (p: string) => p.split('/').filter(Boolean).pop() || p;

// Chip language mirrors PromptInputBar — same colors/borders, inline SVGs.
const _iconProps = { width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const FileIcon = () => (
  <svg {..._iconProps}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
);
const FolderIcon = () => (
  <svg {..._iconProps}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
);
const TargetIcon = () => (
  <svg {..._iconProps}><circle cx="12" cy="12" r="10" /><line x1="22" y1="12" x2="18" y2="12" /><line x1="6" y1="12" x2="2" y2="12" /><line x1="12" y1="6" x2="12" y2="2" /><line x1="12" y1="22" x2="12" y2="18" /></svg>
);

/**
 * Mini prompt panel for Avatar mode — lives in its own small focusable
 * BrowserWindow (?mode=avatarinput) since the GhostLayer can't take keyboard
 * focus. Opened at the cursor (⇧R+⌥R) or above the avatar (PTT release),
 * optionally prefilled with the PTT transcript. Enter submits, Shift+Enter
 * newlines, Esc dismisses. The window auto-grows with the text (avatar:input-
 * resize) so multiline input stays visible. Files dropped on Optyon or onto
 * this panel arrive as chips and ride along as [File:] attachments.
 */
export function AvatarInputBar() {
  const [text, setText] = useState('');
  const [context, setContext] = useState('');
  const [planning, setPlanning] = useState(false);
  const [planName, setPlanName] = useState('');
  const [files, setFiles] = useState<string[]>([]);
  const [dirs, setDirs] = useState<string[]>([]);
  const [dropOn, setDropOn] = useState(false);
  // PTT dictation into an already-open field — interim renders live as
  // text + interim; pttText merges the transcript without touching chips.
  const [interim, setInterim] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    const t = setTimeout(() => taRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  // Auto-grow the window to fit the content (78px min, main clamps at 200).
  useEffect(() => {
    const ta = taRef.current;
    const root = rootRef.current;
    if (!ta || !root) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
    const h = Math.ceil(root.getBoundingClientRect().height) + 2;
    try { ipcRenderer?.send('avatar:input-resize', { height: h }); } catch (_) {}
  }, [text, context, planning, files]);

  useEffect(() => {
    if (!ipcRenderer) return;
    const onState = (d: any) => {
      if (d?.filesOnly) {
        // Files arriving while the field is already open — merge, never reset.
        const add = Array.isArray(d.files) ? d.files.filter((p: any) => typeof p === 'string' && p) : [];
        const addDirs = Array.isArray(d.dirs) ? d.dirs.filter((p: any) => typeof p === 'string' && p) : [];
        if (add.length) setFiles(prev => Array.from(new Set([...prev, ...add])));
        if (addDirs.length) setDirs(prev => Array.from(new Set([...prev, ...addDirs])));
        return;
      }
      if (d?.contextClear) {
        // Highlight dropped elsewhere (chip ✕, ⌥L+⌥R) — pull just the chip.
        setContext('');
        return;
      }
      if (typeof d?.planning === 'boolean') {
        setPlanning(d.planning);
        setPlanName(typeof d.planName === 'string' ? d.planName : '');
      }
      if (d?.contextOnly) {
        // Live capture landing in an already-open field — patch the chip
        // without resetting text/files.
        setContext(typeof d.contextExcerpt === 'string' ? d.contextExcerpt : '');
        return;
      }
      if (typeof d?.interim === 'string') {
        // Live PTT dictation — the field renders base + interim while held.
        setInterim(d.interim);
        return;
      }
      if (typeof d?.pttText === 'string') {
        // Final transcript merges into the OPEN field — files/dirs/context
        // all survive (the reset path would wipe the attachment chips).
        const it = d.pttText.trim();
        if (it) setText(prev => [prev.trim(), it].filter(Boolean).join(' '));
        setInterim('');
        return;
      }
      // Every open resets the field — a leftover prefill must never
      // concatenate with the next typed prompt (this caused merged queries).
      setText(typeof d?.prefill === 'string' ? d.prefill : '');
      setContext(typeof d?.contextExcerpt === 'string' ? d.contextExcerpt : '');
      setPlanning(!!d?.planning);
      setPlanName(typeof d?.planName === 'string' ? d.planName : '');
      setFiles(Array.isArray(d?.files) ? d.files.filter((p: any) => typeof p === 'string' && p) : []);
      setDirs(Array.isArray(d?.dirs) ? d.dirs.filter((p: any) => typeof p === 'string' && p) : []);
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      });
    };
    ipcRenderer.on('avatar:input-state', onState, TOKEN);
    return () => { try { ipcRenderer.removeListenerByToken('avatar:input-state', TOKEN); } catch (_) {} };
  }, []);

  const submit = () => {
    const t = text.trim();
    if (!t && !files.length) return;
    try { ipcRenderer?.send('avatar:submit', { text: t, files, dirs }); } catch (_) {}
    setText(''); setFiles([]); setDirs([]); setInterim(''); setContext('');
  };
  const close = () => { try { ipcRenderer?.send('avatar:input-close'); } catch (_) {} };

  const addDropped = (e: React.DragEvent) => {
    e.preventDefault();
    setDropOn(false);
    const paths: string[] = [];
    const foundDirs: string[] = [];
    Array.from(e.dataTransfer.items).forEach((it, i) => {
      const p = (e.dataTransfer.files[i] as any)?.path;
      if (!p) return;
      paths.push(p);
      try { if ((it as any).webkitGetAsEntry?.()?.isDirectory) foundDirs.push(p); } catch (_) {}
    });
    if (paths.length) setFiles(prev => Array.from(new Set([...prev, ...paths])));
    if (foundDirs.length) setDirs(prev => Array.from(new Set([...prev, ...foundDirs])));
    taRef.current?.focus();
  };

  return (
    <div
      ref={rootRef}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropOn(true); } }}
      onDragLeave={(e) => {
        if (e.relatedTarget instanceof Node && (e.currentTarget as HTMLElement).contains(e.relatedTarget)) return;
        setDropOn(false);
      }}
      onDrop={addDropped}
      style={{
        position: 'fixed', inset: 0,
        display: 'flex', flexDirection: 'column', gap: 4,
        padding: 8, background: 'transparent',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
      {(planning || context || files.length > 0) && (
        <div className="flex flex-wrap gap-2" style={{ marginBottom: 2 }}>
          {planning && (
            <div
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs"
              title="Planning mode"
              style={{
                backgroundColor: 'rgba(34,211,238,0.14)',
                border: '1px solid rgba(34,211,238,0.35)',
                color: '#67e8f9',
              }}
            >
              <svg {..._iconProps}><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6-2z"/><polyline points="9 4 9 18"/><polyline points="15 6 15 20"/></svg>
              <span className="truncate max-w-[150px]">{planName ? `Planning: ${planName}` : 'Planning mode'}</span>
              <button
                onClick={() => {
                  setPlanning(false);
                  try { ipcRenderer?.send('planning:set', { active: false }); } catch (_) {}
                }}
                className="ml-1 hover:opacity-70"
                title="Exit planning mode"
                style={{ color: '#67e8f9', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                ×
              </button>
            </div>
          )}
          {context && (
            // Held highlight — matches the overlay's [Context:] chip (cyan,
            // target icon, truncated, × to remove). Removing clears the
            // canonical captured selection in main via selection:clear so it
            // can't silently re-attach to the next submit.
            <div
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs"
              title={context}
              style={{
                backgroundColor: 'rgba(34,211,238,0.15)',
                border: '1px solid rgba(34,211,238,0.35)',
                color: '#67e8f9',
              }}
            >
              <TargetIcon />
              <span className="truncate max-w-[150px]">{context}</span>
              <button
                onClick={() => {
                  setContext('');
                  try { ipcRenderer?.send('selection:clear'); } catch (_) {}
                }}
                className="ml-1 hover:opacity-70"
                style={{ color: '#67e8f9', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                ×
              </button>
            </div>
          )}
          {files.map(p => {
            const isDir = dirs.includes(p);
            const bg = isDir ? 'rgba(74,222,128,0.15)' : 'rgba(59,130,246,0.15)';
            const bd = isDir ? 'rgba(74,222,128,0.3)' : 'rgba(59,130,246,0.3)';
            const fg = isDir ? '#4ade80' : '#93c5fd';
            return (
              <div
                key={p}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-xs"
                title={p}
                style={{ backgroundColor: bg, border: `1px solid ${bd}`, color: fg }}
              >
                {isDir ? <FolderIcon /> : <FileIcon />}
                <span className="truncate max-w-[150px]">{basename(p)}</span>
                <button
                  onClick={() => { setFiles(prev => prev.filter(f => f !== p)); setDirs(prev => prev.filter(f => f !== p)); }}
                  className="ml-1 hover:opacity-70"
                  style={{ color: fg, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        background: 'rgba(12,16,28,.92)', backdropFilter: 'blur(18px)',
        border: `1.5px solid ${dropOn ? '#fbbf24' : 'rgba(96,165,250,.4)'}`,
        borderRadius: 14,
        padding: '10px 12px 10px 14px',
        transition: 'border-color .15s',
      }}>
        <textarea
          ref={taRef}
          value={text + (interim ? (text ? ' ' : '') + interim : '')}
          spellCheck
          lang="en"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); close(); }
          }}
          placeholder="Ask Optyon…"
          rows={1}
          style={{
            flex: 1, resize: 'none', border: 'none', outline: 'none',
            background: 'transparent', color: '#e2e8f0',
            fontSize: 15, lineHeight: '20px', fontFamily: 'inherit',
            maxHeight: 120, overflowY: 'auto',
          }}
        />
        <span style={{ fontSize: 11, color: 'rgba(148,163,184,.7)', whiteSpace: 'nowrap', paddingTop: 3 }}>⏎ send · esc</span>
      </div>
    </div>
  );
}

export default AvatarInputBar;
