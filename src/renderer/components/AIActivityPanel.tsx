import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { TerminalPane } from './TerminalPane';

const { ipcRenderer } = window.electron;

interface AIActivityPanelProps {
  isDebugMode: boolean;
  isRunning: boolean;
  currentOperation?: string;
}

export interface AIActivityPanelHandle {
  executeCommand: (command: string) => Promise<void>;
  getCommandHistory: () => string[];
  navigateHistory: (direction: 'up' | 'down', currentInput: string) => { command: string | null; newIndex: number };
  getHistoryIndex: () => number;
}

interface LogEntry {
  type: 'command' | 'output' | 'error' | 'status';
  content: string;
  timestamp: number;
  _agentId?: string;
}

export const AIActivityPanel = forwardRef<AIActivityPanelHandle, AIActivityPanelProps>(
  ({ isDebugMode, isRunning, currentOperation }, ref) => {
    // Panel height in px — drag-resizable. 40 = collapsed header row; default
    // expanded 288; full snaps to ~85% of the window so the terminal can take
    // over the feed area while the prompt bar stays visible.
    const COLLAPSED_H = 40, DEFAULT_H = 288;
    const _fullHeight = () => Math.max(DEFAULT_H, Math.round(window.innerHeight * 0.85));
    const [panelHeight, setPanelHeight] = useState(COLLAPSED_H);
    const [dragging, setDragging] = useState(false);
    const dragRef = useRef<{ startY: number; startH: number } | null>(null);
    const isExpanded = panelHeight > 80;
    const [view, setView] = useState<'activity' | 'terminal'>('terminal');
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [autoDebug, setAutoDebug] = useState(false);
    const [isCommandRunning, setIsCommandRunning] = useState(false);
    const [commandHistory, setCommandHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [scheduledRunning, setScheduledRunning] = useState(false);
    const scheduledRunningRef = useRef(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    // Ticker — last terminal:activity line shown in the collapsed header row.
    // The dot pulses while work is recent; the panel stays collapsed unless an
    // event needs eyes (prompt wait, hard failure) or the user expands it.
    const [activityLine, setActivityLine] = useState<string | null>(null);
    const [activityBusy, setActivityBusy] = useState(false);
    const busyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const manualCollapseRef = useRef(0);

    // Auto-expand when entering debug mode
    useEffect(() => {
      if (isDebugMode) {
        setPanelHeight(DEFAULT_H);
      }
    }, [isDebugMode]);

    // Terminal is the default surface; the activity log only takes over while
    // a scheduled automation is running (its real purpose), then hands back.
    useEffect(() => {
      setView(scheduledRunning ? 'activity' : 'terminal');
    }, [scheduledRunning]);

    // Listen for operation status updates
    useEffect(() => {
      const handleStatus = (data: { message: string; type?: string }) => {
        setLogs(prev => [...prev, { type: 'status', content: data.message, timestamp: Date.now() }]);
        if (data.type === 'cancel') {
          setIsCommandRunning(false);
          setAutoDebug(false);
        }
      };

      ipcRenderer.on('operation:status', handleStatus, 'AIActivityPanel-status');
      return () => {
        ipcRenderer.removeListenerByToken('operation:status', 'AIActivityPanel-status');
      };
    }, []);

    // Listen for scheduled automation progress events
    // Uses a ref for the running flag to avoid stale-closure issues — the handler
    // is registered once on mount and reads scheduledRunningRef.current directly.
    useEffect(() => {
      const handleAutomationProgress = (data: any) => {
        const { type } = data || {};
        switch (type) {
          case 'reminder_fired': {
            // Scheduled task just fired — take over the panel
            scheduledRunningRef.current = true;
            setScheduledRunning(true);
            setLogs([{ type: 'status', content: `⏰ Reminder fired: "${data.label || data.triggerPrompt || 'scheduled task'}"`, timestamp: Date.now() }]);
            setPanelHeight(DEFAULT_H);
            break;
          }
          case 'plan_ready': {
            if (!scheduledRunningRef.current) break;
            const stepCount = data.steps?.length ?? data.totalSteps ?? '?';
            setLogs(prev => [...prev, { type: 'status', content: `📋 Plan ready — ${stepCount} step${stepCount !== 1 ? 's' : ''}`, timestamp: Date.now() }]);
            break;
          }
          case 'step_start':
          case 'plan:step_start': {
            if (!scheduledRunningRef.current) break;
            const stepDesc = data.description || data.skill || 'step';
            setLogs(prev => [...prev, { type: 'output', content: `→ ${stepDesc}`, timestamp: Date.now() }]);
            break;
          }
          case 'step_done':
          case 'plan:step_done': {
            if (!scheduledRunningRef.current) break;
            const doneDesc = data.description || data.skill || 'step';
            setLogs(prev => [...prev, { type: 'status', content: `✓ ${doneDesc}`, timestamp: Date.now() }]);
            break;
          }
          case 'step_failed': {
            if (!scheduledRunningRef.current) break;
            const failDesc = data.description || data.skill || 'step';
            const failErr = data.error ? ` — ${String(data.error).slice(0, 120)}` : '';
            setLogs(prev => [...prev, { type: 'error', content: `✗ ${failDesc}${failErr}`, timestamp: Date.now() }]);
            break;
          }
          case 'agent:turn_live':
          case 'agent:turn': {
            if (!scheduledRunningRef.current) break;
            const agentId = data.agentId || 'agent';
            const turn = data.turn ?? '?';
            const maxTurns = data.maxTurns ?? '?';
            const actionStr = data.action?.action ? ` — ${data.action.action}` : (data.currentAction ? ` — ${data.currentAction}` : '');
            // Replace the last agent:turn line for the same agentId to avoid log spam
            setLogs(prev => {
              const lastIdx = prev.map(e => e._agentId).lastIndexOf(agentId);
              const entry = { type: 'output' as const, content: `⟳ [${agentId}] turn ${turn}/${maxTurns}${actionStr}`, timestamp: Date.now(), _agentId: agentId };
              if (lastIdx >= 0 && prev[lastIdx].content.startsWith('⟳')) {
                return [...prev.slice(0, lastIdx), entry, ...prev.slice(lastIdx + 1)];
              }
              return [...prev, entry];
            });
            break;
          }
          case 'agent:complete': {
            if (!scheduledRunningRef.current) break;
            const completeAgentId = data.agentId || 'agent';
            const result = data.result ? String(data.result).slice(0, 120) : (data.ok ? 'done' : 'failed');
            // Replace the last spinner turn line for this agent with the completion line
            setLogs(prev => {
              const lastIdx = prev.map(e => e._agentId).lastIndexOf(completeAgentId);
              const entryType: LogEntry['type'] = data.ok !== false ? 'status' : 'error';
              const entry = { type: entryType, content: `✓ [${completeAgentId}]: ${result}`, timestamp: Date.now(), _agentId: completeAgentId };
              if (lastIdx >= 0 && prev[lastIdx].content.startsWith('⟳')) {
                return [...prev.slice(0, lastIdx), entry, ...prev.slice(lastIdx + 1)];
              }
              return [...prev, entry];
            });
            break;
          }
          case 'agent:thought': {
            if (!scheduledRunningRef.current) break;
            if (!data.thoughts) break;
            const thoughtAgentId = data.agentId || 'agent';
            setLogs(prev => [...prev, { type: 'output', content: `💭 [${thoughtAgentId}]: ${String(data.thoughts).slice(0, 80)}`, timestamp: Date.now(), _agentId: thoughtAgentId }]);
            break;
          }
          case 'all_done': {
            if (!scheduledRunningRef.current) break;
            scheduledRunningRef.current = false;
            setScheduledRunning(false);
            setLogs(prev => [...prev, { type: 'status', content: '✅ Done', timestamp: Date.now() }]);
            break;
          }
          default:
            break;
        }
      };

      ipcRenderer.on('automation:progress', handleAutomationProgress, 'AIActivityPanel-automation');
      return () => {
        ipcRenderer.removeListenerByToken('automation:progress', 'AIActivityPanel-automation');
      };
    }, []); // mount once — reads ref, never stale

    // Ticker — terminal:activity lines (step boundaries, diagnosis notes) and
    // terminal:session events (auto-raise only when input is needed).
    useEffect(() => {
      const bump = () => {
        setActivityBusy(true);
        if (busyTimerRef.current) clearTimeout(busyTimerRef.current);
        busyTimerRef.current = setTimeout(() => setActivityBusy(false), 4000);
      };
      const handleActivity = (evt: any) => {
        const line = String(evt?.line || '').slice(0, 140);
        if (!line) return;
        setActivityLine(line);
        bump();
        setLogs(prev => [...prev.slice(-300), {
          type: evt?.kind === 'fail' ? 'error' as const : 'output' as const,
          content: `· ${line}`,
          timestamp: Date.now(),
        }]);
        // Failures deserve eyes — raise unless the user just collapsed it.
        if (evt?.kind === 'fail' && Date.now() - manualCollapseRef.current > 10000) {
          setPanelHeight(h => (h > COLLAPSED_H + 16 ? h : DEFAULT_H));
        }
      };
      const handleSession = (evt: any) => {
        if (evt?.type === 'terminal:prompt_wait') {
          setActivityLine(`input needed — ${String(evt.prompt || 'terminal is waiting for a response').slice(0, 100)}`);
          bump();
          if (Date.now() - manualCollapseRef.current > 10000) {
            setPanelHeight(DEFAULT_H);
          }
        } else if (evt?.type === 'terminal:session_open' && evt?.label) {
          setActivityLine(`terminal: ${String(evt.label).slice(0, 100)}`);
          bump();
        }
      };
      ipcRenderer.on('terminal:activity', handleActivity, 'AIActivityPanel-activity');
      ipcRenderer.on('terminal:session', handleSession, 'AIActivityPanel-session');
      return () => {
        ipcRenderer.removeListenerByToken('terminal:activity', 'AIActivityPanel-activity');
        ipcRenderer.removeListenerByToken('terminal:session', 'AIActivityPanel-session');
      };
    }, []);

    // Auto-scroll to bottom when new logs added
    useEffect(() => {
      if (scrollRef.current && logs.length > 0) {
        // Small delay to ensure DOM is updated
        setTimeout(() => {
          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }
        }, 50);
      }
    }, [logs]);

    const addLog = useCallback((type: LogEntry['type'], content: string) => {
      setLogs(prev => [...prev, { type, content, timestamp: Date.now() }]);
    }, []);

    const clearLogs = useCallback(() => {
      setLogs([]);
    }, []);

    // Execute command via IPC to main process
    const executeCommand = useCallback(async (command: string) => {
      if (!command.trim()) return;

      // Add to command history
      setCommandHistory(prev => {
        const newHistory = [command, ...prev.filter(c => c !== command)].slice(0, 50);
        return newHistory;
      });
      setHistoryIndex(-1);

      setIsCommandRunning(true);
      addLog('command', `$ ${command}`);

      try {
        // Use IPC instead of direct HTTP fetch
        const result = await ipcRenderer.invoke('shell:execute', {
          command,
          timeout: 30000
        });
        
        // DEBUG: Log full result structure
        console.log('[Shell] Full result:', JSON.stringify(result, null, 2));
        console.log('[Shell] result.success:', result.success);
        console.log('[Shell] result.data:', result.data);
        console.log('[Shell] result.data?.data:', result.data?.data);
        console.log('[Shell] result.data?.stdout:', result.data?.stdout);
        console.log('[Shell] result.data?.data?.stdout:', result.data?.data?.stdout);

        if (result.success && result.data) {
          // Handle double-nested response: result.data may have stdout directly or nested in data property
          const outputData = result.data.data || result.data;
          
          if (outputData.stdout) {
            addLog('output', outputData.stdout);
          }
          if (outputData.stderr) {
            addLog('error', outputData.stderr);
          }
          if (!outputData.stdout && !outputData.stderr) {
            addLog('status', 'Command completed (no output)');
          }
        } else {
          // Debug: log full result to console
          console.log('[Shell] Command result:', result);
          
          // Handle double-nested response: result.data is skill result which has its own data property
          const skillResult = result.data?.data || result.data || {};
          
          if (skillResult.stdout) {
            addLog('output', skillResult.stdout);
          }
          if (skillResult.stderr) {
            addLog('error', skillResult.stderr);
          }
          if (!skillResult.stdout && !skillResult.stderr) {
            addLog('status', 'Command completed (no output)');
          }
        }
      } catch (error) {
        addLog('error', `Failed to execute: ${(error as Error).message}`);
      } finally {
        setIsCommandRunning(false);
      }
    }, [addLog]);

    // Navigate command history
    const navigateHistory = useCallback((direction: 'up' | 'down', _currentInput: string) => {
      if (commandHistory.length === 0) {
        return { command: null, newIndex: -1 };
      }

      let newIndex = historyIndex;
      
      if (direction === 'up') {
        // If at start or -1, go to most recent
        if (newIndex === -1) {
          newIndex = 0;
        } else if (newIndex < commandHistory.length - 1) {
          newIndex++;
        }
      } else {
        // Down arrow
        if (newIndex > 0) {
          newIndex--;
        } else if (newIndex === 0) {
          // At bottom, return to empty input
          newIndex = -1;
          return { command: '', newIndex };
        }
      }

      setHistoryIndex(newIndex);
      return { 
        command: newIndex >= 0 ? commandHistory[newIndex] : '', 
        newIndex 
      };
    }, [commandHistory, historyIndex]);

    const getCommandHistory = useCallback(() => commandHistory, [commandHistory]);
    const getHistoryIndex = useCallback(() => historyIndex, [historyIndex]);

    // Expose methods via ref
    useImperativeHandle(ref, () => ({
      executeCommand,
      getCommandHistory,
      navigateHistory,
      getHistoryIndex
    }));

  const runAutoDebug = useCallback(async () => {
    if (autoDebug) return;
    
    setAutoDebug(true);
    setIsCommandRunning(true);
    addLog('status', '🤖 Starting auto-debug sequence...');
    
    const commands = [
      'playwright-cli -s=default eval "document.title"',
      'playwright-cli -s=default eval "window.location.href"',
      'playwright-cli -s=default eval "document.querySelectorAll(\'button\').length"',
    ];
    
    for (const cmd of commands) {
      addLog('command', `$ ${cmd}`);
      ipcRenderer.send('terminal:execute', { command: cmd });
      await new Promise(r => setTimeout(r, 500));
    }
    
    addLog('status', '✅ Auto-debug complete');
    setAutoDebug(false);
    setIsCommandRunning(false);
  }, [autoDebug, addLog]);

  // Show on all tabs when there's activity - no more hiding
  
  // Always show panel - compute activity state
  const hasActivity = isRunning || currentOperation || isCommandRunning || scheduledRunning || activityBusy;

  // Toggle handler for chevron / header-row click
  const handleToggle = () => {
    setPanelHeight(h => {
      const next = h > COLLAPSED_H + 16 ? COLLAPSED_H : DEFAULT_H;
      if (next === COLLAPSED_H) manualCollapseRef.current = Date.now();
      return next;
    });
  };

  // Top-edge drag resize — live height during drag (transition off), snap
  // bands on release: near-bottom → collapsed, near-default → 288, past
  // ~70% of full → full height. Double-click the grip jumps full/collapse.
  const _snapHeight = (h: number) => {
    const full = _fullHeight();
    if (h < 72) return COLLAPSED_H;
    if (h > full * 0.70) return full;
    if (Math.abs(h - DEFAULT_H) < 40) return DEFAULT_H;
    return h;
  };
  const handleDragStart = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = { startY: e.clientY, startH: panelHeight };
    setDragging(true);
    const prevSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const next = Math.min(Math.max(d.startH + (d.startY - ev.clientY), COLLAPSED_H), _fullHeight());
      setPanelHeight(next);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      document.body.style.userSelect = prevSelect;
      setDragging(false);
      const d = dragRef.current;
      dragRef.current = null;
      if (d) {
        const snapped = _snapHeight(Math.min(Math.max(d.startH + (d.startY - ev.clientY), COLLAPSED_H), _fullHeight()));
        if (snapped <= 80) manualCollapseRef.current = Date.now();
        setPanelHeight(snapped);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, { once: true });
  };
  const handleGripDoubleClick = (e: ReactMouseEvent) => {
    e.stopPropagation();
    setPanelHeight(h => (h > _fullHeight() * 0.7 ? COLLAPSED_H : _fullHeight()));
  };

  // Unified render - always shows, just different heights
  return (
    <div
      className={`relative border-t bg-[#1e1e1e] ${dragging ? '' : 'transition-all duration-300 ease-in-out'} flex flex-col`}
      style={{
        borderColor: 'rgba(255, 255, 255, 0.1)',
        overflow: 'hidden',
        height: panelHeight,
      }}
    >
      {/* Drag-resize handle — top edge; separate from the row-toggle so a
          click still expands/collapses while a drag resizes freely. */}
      <div
        className="absolute top-0 left-0 right-0 h-2 cursor-ns-resize z-10 group"
        onMouseDown={handleDragStart}
        onDoubleClick={handleGripDoubleClick}
        title="Drag to resize · double-click for full height"
      >
        <div className="mx-auto mt-[3px] w-10 h-1 rounded-full bg-white/10 group-hover:bg-white/30 transition-colors" />
      </div>
      {/* Header - Icon only, minimal like Windsurf. Click anywhere on the
          row to expand/collapse; action buttons stopPropagation below. */}
      <div
        className="flex items-center justify-between px-3 py-2 h-10 cursor-pointer select-none"
        onClick={handleToggle}
        role="button"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-2">
          {/* Activity indicator - pulse when has activity */}
          {hasActivity ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          )}
          <span className="text-xs text-gray-400 truncate">{scheduledRunning ? 'Running scheduled automation...' : (activityLine || currentOperation || (hasActivity ? 'Working...' : 'Ready'))}</span>
        </div>
        
        <div className="flex items-center gap-1">
          {/* Auto-Debug button - only when not running */}
          {isDebugMode && !isCommandRunning && (
            <button
              onClick={(e) => { e.stopPropagation(); runAutoDebug(); }}
              disabled={autoDebug}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 disabled:opacity-50 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z"/>
              </svg>
              Auto-Debug
            </button>
          )}
          
          {/* Stop button - only when command is running */}
          {isCommandRunning && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsCommandRunning(false);
                setAutoDebug(false);
                ipcRenderer.send('operation:cancel');
              }}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2"/>
              </svg>
              Stop
            </button>
          )}
          
          {/* Clear button - only show when expanded and has logs */}
          {isExpanded && logs.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); clearLogs(); }}
              className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-gray-200 transition-colors"
              title="Clear terminal"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
          
          <button
            onClick={(e) => { e.stopPropagation(); handleToggle(); }}
            className="p-1 rounded hover:bg-white/10 text-gray-400 hover:text-gray-200 transition-colors"
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="18 15 12 9 6 15" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Terminal view — live PTY pane */}
      {view === 'terminal' && (
        <TerminalPane visible={isExpanded && view === 'terminal'} />
      )}

      {/* Terminal Output */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 pb-2 font-mono text-sm"
        style={{
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          fontSize: '13px',
          minHeight: 0, // Important for flex child scrolling
          display: view === 'terminal' ? 'none' : undefined,
        }}
      >
        {logs.length === 0 ? (
          <div className="text-gray-500 italic">
            {isDebugMode 
              ? 'Type commands or click [Auto-Debug] for AI-driven diagnosis'
              : 'AI activity will appear here...'
            }
          </div>
        ) : (
          logs.map((log, i) => (
            <div 
              key={i} 
              className={`
                mb-1 whitespace-pre-wrap break-all
                ${log.type === 'command' ? 'text-green-400' : ''}
                ${log.type === 'error' ? 'text-red-400' : ''}
                ${log.type === 'status' ? 'text-blue-400' : ''}
                ${log.type === 'output' ? 'text-gray-300' : ''}
              `}
            >
              {log.content}
            </div>
          ))
        )}
      </div>

    </div>
  );
  }
);

AIActivityPanel.displayName = 'AIActivityPanel';
