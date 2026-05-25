import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';

const { ipcRenderer } = window.electron;

interface AIActivityPanelProps {
  isDebugMode: boolean;
  activeTab: string;
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
}

export const AIActivityPanel = forwardRef<AIActivityPanelHandle, AIActivityPanelProps>(
  ({ isDebugMode, activeTab, isRunning, currentOperation }, ref) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [autoDebug, setAutoDebug] = useState(false);
    const [isCommandRunning, setIsCommandRunning] = useState(false);
    const [commandHistory, setCommandHistory] = useState<string[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Auto-expand when entering debug mode
    useEffect(() => {
      if (isDebugMode) {
        setIsExpanded(true);
      }
    }, [isDebugMode]);

    // Listen for operation status updates
    useEffect(() => {
      const handleStatus = (_event: any, data: { message: string; type?: string }) => {
        setLogs(prev => [...prev, { type: 'status', content: data.message, timestamp: Date.now() }]);
        if (data.type === 'cancel') {
          setIsCommandRunning(false);
          setAutoDebug(false);
        }
      };

      ipcRenderer.on('operation:status', handleStatus);
      return () => {
        ipcRenderer.removeListener('operation:status', handleStatus);
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
    const navigateHistory = useCallback((direction: 'up' | 'down', currentInput: string) => {
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

  const applyFix = useCallback(() => {
    addLog('status', '🔧 Analyzing for fixes... (placeholder)');
    // TODO: Implement AI fix analysis
  }, [addLog]);

  // Show on all tabs when there's activity - no more hiding
  
  // Always show panel - compute activity state
  const hasActivity = isRunning || currentOperation || isCommandRunning;

  // Toggle handler for chevron
  const handleToggle = () => {
    setIsExpanded(prev => !prev);
  };

  // Unified render - always shows, just different heights
  return (
    <div 
      className={`border-t bg-[#1e1e1e] transition-all duration-300 ease-in-out flex flex-col ${
        isExpanded ? 'h-48' : 'h-10'
      }`}
      style={{ 
        borderColor: 'rgba(255, 255, 255, 0.1)',
        overflow: 'hidden'
      }}
    >
      {/* Header - Icon only, minimal like Windsurf */}
      <div className="flex items-center justify-between px-3 py-2 h-10">
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
          <span className="text-xs text-gray-400">{currentOperation || (hasActivity ? 'Working...' : 'Ready')}</span>
        </div>
        
        <div className="flex items-center gap-1">
          {/* Auto-Debug button - only when not running */}
          {isDebugMode && !isCommandRunning && (
            <button
              onClick={runAutoDebug}
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
              onClick={() => {
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
              onClick={clearLogs}
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
            onClick={handleToggle}
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

      {/* Terminal Output */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-3 pb-2 font-mono text-sm"
        style={{ 
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          fontSize: '13px',
          minHeight: 0 // Important for flex child scrolling
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

// Mark unused props intentionally - visible on all tabs
void ((props: AIActivityPanelProps) => props.activeTab);
