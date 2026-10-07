import { useState, useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const { ipcRenderer } = window.electron;

interface SessionMeta {
  id: string;
  backend: string;
  exitCode: number | null;
  meta: {
    label: string | null;
    managedBy: string;
    prompt: string | null;
    cwd: string;
    createdAt: string;
  };
}

interface TerminalPaneProps {
  visible: boolean;
}

/**
 * Live view + input into agent/user PTY sessions (command-service
 * terminal.agent). Polls `read` while visible; keystrokes go through `send`.
 * The "sensitive" toggle pauses transcript capture so typed secrets never
 * land in ~/.thinkdrop/logs/terminal/*.log.
 */
export function TerminalPane({ visible }: TerminalPaneProps) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [exited, setExited] = useState<number | null>(null);
  const [input, setInput] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const sensitiveRef = useRef(false);
  sensitiveRef.current = sensitive;
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const termHostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Per-session raw stream cursors — read mode:'raw' pages deltas via offset.
  const rawCursorRef = useRef<Record<string, number>>({});
  const activeIdRef = useRef<string | null>(null);

  const act = useCallback(async (payload: any) => {
    try {
      return await ipcRenderer.invoke('terminal:action', payload);
    } catch (e: any) {
      return { ok: false, error: e?.message || 'ipc-failed' };
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    const r = await act({ action: 'list' });
    if (r?.ok) {
      setSessions(r.sessions || []);
      if (!activeId && r.sessions?.length) {
        setActiveId(r.sessions[r.sessions.length - 1].id);
      }
      if (activeId && r.sessions?.length && !r.sessions.find((s: SessionMeta) => s.id === activeId)) {
        setActiveId(r.sessions[r.sessions.length - 1]?.id || null);
      }
    } else if (r?.error) {
      setErr(r.error);
    }
  }, [act, activeId]);

  const refreshScreen = useCallback(async () => {
    const sid = activeIdRef.current;
    if (!sid) return;
    const cursor = rawCursorRef.current[sid] ?? null;
    const r = await act({ action: 'read', sessionId: sid, mode: 'raw', cursor });
    if (r?.ok) {
      if (typeof r.offset === 'number') rawCursorRef.current[sid] = r.offset;
      if (r.data) termRef.current?.write(r.data);
      setPrompt(r.prompt || null);
      setExited(r.exited ? r.exitCode : null);
      setErr(null);
    } else {
      setErr(r?.error || null);
    }
  }, [act]);

  useEffect(() => {
    if (!visible) return;
    refreshSessions();
    const t = setInterval(() => { refreshScreen(); }, 80);
    const s = setInterval(refreshSessions, 5000);
    return () => { clearInterval(t); clearInterval(s); };
  }, [visible, refreshSessions, refreshScreen]);

  // xterm lifecycle — create once; raw deltas stream in via refreshScreen.
  useEffect(() => {
    if (!visible || !termHostRef.current || termRef.current) return;
    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 2000,
      theme: {
        background: '#0d0d0d',
        foreground: '#e5e5e5',
        cursor: '#60a5fa',
        selectionBackground: 'rgba(96,165,250,0.3)',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Direct keystrokes → PTY (arrows, Ctrl-C, TUI keys all work).
    term.onData((d) => {
      const sid = activeIdRef.current;
      if (sid) act({ action: 'send', sessionId: sid, text: d, sensitive: sensitiveRef.current });
    });

    // Fit → PTY resize on container size change.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        const sid = activeIdRef.current;
        if (sid) act({ action: 'resize', sessionId: sid, cols: term.cols, rows: term.rows });
      } catch (_) {}
    });
    ro.observe(termHostRef.current);
    return () => { ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // host div only exists once a session is selected — !activeId gates it
  }, [visible, !!activeId]);

  // Agent sessions — when an agent opens a PTY (cli.agent pty_exec etc.) jump
  // straight to it so the pane shows the live work without manual selection.
  useEffect(() => {
    const handler = (data: any) => {
      if (data?.type === 'terminal:session_open' && data.sessionId) {
        setActiveId(data.sessionId);
        refreshSessions();
      }
    };
    try {
      ipcRenderer.on('terminal:session', handler, 'TerminalPane-session');
      return () => { ipcRenderer.removeListenerByToken('terminal:session', 'TerminalPane-session'); };
    } catch (_) { return; }
  }, [refreshSessions]);

  // Session switch — reset the emulator and replay the session's full
  // buffered output (cursor null → rawSince returns everything).
  useEffect(() => {
    activeIdRef.current = activeId;
    if (!activeId) return;
    termRef.current?.reset();
    delete rawCursorRef.current[activeId];
    refreshScreen();
    try {
      const fit = fitRef.current, term = termRef.current;
      if (fit && term) { fit.fit(); act({ action: 'resize', sessionId: activeId, cols: term.cols, rows: term.rows }); }
    } catch (_) {}
  }, [activeId, act, refreshScreen]);

  const openSession = async () => {
    const r = await act({ action: 'open', label: 'user terminal', managedBy: 'user' });
    if (r?.ok) {
      setActiveId(r.sessionId);
      refreshSessions();
      inputRef.current?.focus();
    } else {
      setErr(r?.error || 'open-failed');
    }
  };

  const sendLine = async (text: string) => {
    if (!activeId) return;
    // \n → \r so multi-line input executes as typed lines in the PTY.
    const r = await act({ action: 'send', sessionId: activeId, text: text.replace(/\n/g, '\r') + '\r', sensitive });
    if (!r?.ok) setErr(r?.error || null);
    setTimeout(refreshScreen, 120);
  };

  const sendCtrl = async (key: string) => {
    if (!activeId) return;
    await act({ action: 'send', sessionId: activeId, ctrl: key });
    setTimeout(refreshScreen, 120);
  };

  const isPassword = prompt === 'password';

  // Warp-style prompt prefix — show the session's working directory.
  const activeMeta = sessions.find(s => s.id === activeId)?.meta;
  const cwdLabel = activeMeta?.cwd
    ? `${activeMeta.cwd.replace(/^\/Users\/[^/]+/, '~')} %`
    : '~ %';

  return (
    <div className="flex flex-col h-full" style={{ minHeight: 0 }}>
      {/* Session bar */}
      <div className="flex items-center gap-2 px-2 pb-1">
        <select
          value={activeId || ''}
          onChange={e => { setActiveId(e.target.value || null); }}
          className="flex-1 bg-[#2a2a2a] text-gray-300 text-xs rounded px-2 py-1 border border-white/10 outline-none"
          style={{ fontFamily: 'Menlo, monospace' }}
        >
          {sessions.length === 0 && <option value="">(no sessions)</option>}
          {sessions.map(s => (
            <option key={s.id} value={s.id}>
              {s.id} · {s.meta.managedBy}{s.meta.label ? ` · ${s.meta.label}` : ''}{s.exitCode !== null ? ' (exited)' : ''}
            </option>
          ))}
        </select>
        <button
          onClick={openSession}
          className="px-2 py-1 text-xs rounded bg-emerald-600/20 text-emerald-400 hover:bg-emerald-600/30 transition-colors whitespace-nowrap"
          title="Open a new interactive terminal session"
        >
          + New
        </button>
        {activeId && (
          <button
            onClick={() => act({ action: 'close', sessionId: activeId }).then(refreshSessions)}
            className="px-2 py-1 text-xs rounded bg-white/5 text-gray-400 hover:bg-white/10 transition-colors"
            title="Close this session"
          >
            ×
          </button>
        )}
      </div>

      {/* Terminal block — screen + prompt read as one unit (Warp-style) */}
      <div
        className="flex-1 flex flex-col bg-black/40 rounded mx-2 overflow-hidden"
        style={{ minHeight: 0 }}
      >
        {/* Screen — xterm emulator fed by the session's raw ANSI stream.
            Focus is grabbed only on the screen area — clicks on the compose
            row below must NOT steal focus back to xterm. */}
        <div
          className="flex-1 px-2 py-1"
          style={{ minHeight: 0 }}
          onClick={() => termRef.current?.focus()}
        >
          {activeId
            ? <div ref={termHostRef} className="h-full w-full" />
            : <div className="px-1 py-1 text-gray-500 text-xs" style={{ fontFamily: 'Menlo, monospace' }}>No session — click "+ New" or start an agent task.</div>}
        </div>

        {/* Prompt banner */}
        {isPassword && (
          <div className="px-3 py-1 bg-amber-500/15 text-amber-300 text-xs">
            Password prompt detected — type below; transcript capture is paused while "sensitive" is on.
          </div>
        )}
        {exited !== null && (
          <div className="px-3 py-1 bg-white/5 text-gray-400 text-xs">
            Session exited (code {exited}).
          </div>
        )}
        {err && (
          <div className="px-3 py-1 bg-red-500/10 text-red-400 text-xs">{err}</div>
        )}

        {/* Divider */}
        <div className="border-t border-white/10" />

        {/* Prompt row — cwd prefix + multi-line input + controls */}
        <div className="flex items-end gap-2 px-3 py-1.5">
          <span
            className="text-gray-500 whitespace-nowrap select-none pb-[3px]"
            style={{ fontFamily: 'Menlo, Monaco, "Courier New", monospace', fontSize: 12 }}
          >
            {cwdLabel}
          </span>
          <textarea
            ref={inputRef}
            value={input}
            rows={Math.max(1, Math.min(4, input.split('\n').length))}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendLine(input); setInput(''); }
              e.stopPropagation();
            }}
            disabled={!activeId || exited !== null}
            placeholder={activeId ? (isPassword ? 'type password, Enter to send' : 'Enter to run · Shift+Enter for newline') : 'select or open a session'}
            className="flex-1 bg-transparent text-gray-200 text-xs outline-none resize-none disabled:opacity-40 placeholder:text-gray-600"
            style={{
              fontFamily: 'Menlo, Monaco, "Courier New", monospace', fontSize: 12, lineHeight: '18px', maxHeight: 90, overflowY: 'auto',
              // Textareas can't use type=password — mask via WebkitTextSecurity (Chromium).
              ...((sensitive || isPassword) ? { WebkitTextSecurity: 'disc' } as any : {}),
            }}
          />
          <button
            onClick={() => sendCtrl('esc')}
            disabled={!activeId || exited !== null}
            className="px-1.5 py-1 text-[10px] font-mono rounded bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40 transition-colors shrink-0"
            title="Escape — sends Esc (for terminal menus and prompts)"
          >
            esc
          </button>
          <button
            onClick={() => sendCtrl('c')}
            disabled={!activeId || exited !== null}
            className="p-1.5 rounded bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-40 transition-colors shrink-0"
            title="Interrupt — sends Ctrl-C to the terminal"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <button
            onClick={() => setSensitive(s => !s)}
            className={`p-1.5 rounded transition-colors shrink-0 ${sensitive ? 'bg-amber-500/25 text-amber-300' : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-gray-200'}`}
            title={sensitive ? 'Sensitive input on — transcript capture paused' : 'Sensitive input off — click to hide what you type from logs'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
