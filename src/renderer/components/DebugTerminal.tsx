import { useEffect, useRef, useState, useCallback } from 'react';
import { XTerm } from 'xterm-for-react';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';

const { ipcRenderer } = window.electron;

interface DebugTerminalProps {
  sessionId: string;
  onClose: () => void;
}

export default function DebugTerminal({ sessionId, onClose }: DebugTerminalProps) {
  const xtermRef = useRef<XTerm>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [currentInput, setCurrentInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [autoDebug, setAutoDebug] = useState(false);

  // Initialize terminal
  useEffect(() => {
    if (xtermRef.current) {
      terminalRef.current = xtermRef.current.terminal;
      
      // Set up terminal options
      terminalRef.current.options = {
        fontSize: 13,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        cursorStyle: 'block',
        cursorBlink: true,
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
          cursor: '#d4d4d4',
          selectionBackground: '#264f78',
          black: '#000000',
          red: '#cd3131',
          green: '#0dbc79',
          yellow: '#e5e510',
          blue: '#2472c8',
          magenta: '#bc3fbc',
          cyan: '#11a8cd',
          white: '#e5e5e5',
        },
      };

      // Write welcome message
      terminalRef.current.writeln('\x1b[36m╔═══════════════════════════════════════════════════════════╗\x1b[0m');
      terminalRef.current.writeln('\x1b[36m║                                                           ║\x1b[0m');
      terminalRef.current.writeln('\x1b[36m║   🔧 Thinkdrop Debug Terminal                              ║\x1b[0m');
      terminalRef.current.writeln('\x1b[36m║                                                           ║\x1b[0m');
      terminalRef.current.writeln(`\x1b[36m║   Session: \x1b[33m${sessionId}\x1b[36m${' '.repeat(Math.max(0, 42 - sessionId.length))}║\x1b[0m`);
      terminalRef.current.writeln('\x1b[36m║                                                           ║\x1b[0m');
      terminalRef.current.writeln('\x1b[36m╚═══════════════════════════════════════════════════════════╝\x1b[0m');
      terminalRef.current.writeln('');
      terminalRef.current.writeln('\x1b[90mType commands or click [Auto-Debug] for AI-driven diagnosis\x1b[0m');
      terminalRef.current.writeln('');
      terminalRef.current.write('\x1b[32m$\x1b[0m ');

      // Set up input handling
      terminalRef.current.onData((data) => {
        const code = data.charCodeAt(0);
        
        // Handle Enter key
        if (code === 13) {
          if (currentInput.trim()) {
            executeCommand(currentInput.trim());
            setCommandHistory(prev => [...prev, currentInput.trim()]);
            setHistoryIndex(-1);
            setCurrentInput('');
          }
          terminalRef.current?.write('\r\n\x1b[32m$\x1b[0m ');
        }
        // Handle Backspace
        else if (code === 127) {
          if (currentInput.length > 0) {
            setCurrentInput(prev => prev.slice(0, -1));
            terminalRef.current?.write('\b \b');
          }
        }
        // Handle Up arrow (command history)
        else if (data === '\x1b[A') {
          if (commandHistory.length > 0 && historyIndex < commandHistory.length - 1) {
            const newIndex = historyIndex + 1;
            setHistoryIndex(newIndex);
            const cmd = commandHistory[commandHistory.length - 1 - newIndex];
            setCurrentInput(cmd);
            // Clear current line and write new command
            terminalRef.current?.write(`\r\x1b[32m$\x1b[0m ${cmd}`);
          }
        }
        // Handle Down arrow (command history)
        else if (data === '\x1b[B') {
          if (historyIndex > 0) {
            const newIndex = historyIndex - 1;
            setHistoryIndex(newIndex);
            const cmd = commandHistory[commandHistory.length - 1 - newIndex];
            setCurrentInput(cmd);
            terminalRef.current?.write(`\r\x1b[32m$\x1b[0m ${cmd}`);
          } else if (historyIndex === 0) {
            setHistoryIndex(-1);
            setCurrentInput('');
            terminalRef.current?.write('\r\x1b[32m$\x1b[0m ');
          }
        }
        // Regular character input
        else if (code >= 32 && code <= 126) {
          setCurrentInput(prev => prev + data);
          terminalRef.current?.write(data);
        }
      });
    }

    // Clean up IPC listener on unmount
    return () => {
      // IPC cleanup handled by useEffect below
    };
  }, [sessionId]);

  // Set up IPC response handler
  useEffect(() => {
    const handleTerminalResponse = (event: any, response: { output: string; error?: string }) => {
      setIsRunning(false);
      
      if (response.error) {
        terminalRef.current?.writeln(`\x1b[31mError: ${response.error}\x1b[0m`);
      } else {
        const lines = response.output.split('\n');
        lines.forEach(line => {
          terminalRef.current?.writeln(line);
        });
      }
      
      if (!autoDebug) {
        terminalRef.current?.write('\x1b[32m$\x1b[0m ');
      }
    };

    ipcRenderer.on('terminal:output', handleTerminalResponse);
    
    return () => {
      ipcRenderer.removeListener('terminal:output', handleTerminalResponse);
    };
  }, [autoDebug]);

  const executeCommand = useCallback((command: string) => {
    if (!command.trim() || isRunning) return;
    
    setIsRunning(true);
    terminalRef.current?.writeln('');
    
    ipcRenderer.send('terminal:execute', {
      sessionId,
      command,
    });
  }, [sessionId, isRunning]);

  const runAutoDebug = useCallback(async () => {
    if (autoDebug || isRunning) return;
    
    setAutoDebug(true);
    terminalRef.current?.writeln('');
    terminalRef.current?.writeln('\x1b[36m🔍 Starting AI-driven debug session...\x1b[0m');
    terminalRef.current?.writeln('');

    const diagnosticCommands = [
      { cmd: `playwright-cli -s=${sessionId} eval "window.location.href"`, desc: 'Check current URL' },
      { cmd: `playwright-cli -s=${sessionId} eval "document.body.innerText.length"`, desc: 'Check content length' },
      { cmd: `playwright-cli -s=${sessionId} eval "document.title"`, desc: 'Check page title' },
      { cmd: `playwright-cli -s=${sessionId} screenshot /tmp/debug_${Date.now()}.png`, desc: 'Capture screenshot' },
    ];

    for (const { cmd, desc } of diagnosticCommands) {
      terminalRef.current?.writeln(`\x1b[33m▶ ${desc}\x1b[0m`);
      terminalRef.current?.writeln(`\x1b[90m$ ${cmd}\x1b[0m`);
      
      await new Promise<void>((resolve) => {
        executeCommand(cmd);
        
        const checkComplete = setInterval(() => {
          if (!isRunning) {
            clearInterval(checkComplete);
            resolve();
          }
        }, 100);
        
        // Timeout after 10 seconds
        setTimeout(() => {
          clearInterval(checkComplete);
          resolve();
        }, 10000);
      });
      
      terminalRef.current?.writeln('');
    }

    terminalRef.current?.writeln('\x1b[36m✓ Diagnostic complete\x1b[0m');
    terminalRef.current?.writeln('\x1b[90mCheck results above. Click [Apply Fix] if root cause found.\x1b[0m');
    terminalRef.current?.writeln('');
    terminalRef.current?.write('\x1b[32m$\x1b[0m ');
    setAutoDebug(false);
  }, [sessionId, isRunning, autoDebug, executeCommand]);

  const applyFix = useCallback(() => {
    // This would trigger the AI to analyze terminal output and suggest fixes
    terminalRef.current?.writeln('');
    terminalRef.current?.writeln('\x1b[36m🤖 Analyzing terminal output for fix...\x1b[0m');
    
    ipcRenderer.send('terminal:analyze-and-fix', {
      sessionId,
      terminalHistory: commandHistory,
    });
  }, [sessionId, commandHistory]);

  return (
    <>
      {/* Backdrop overlay */}
      <div 
        className="fixed inset-0 bg-black/20 z-40"
        onClick={onClose}
      />
      {/* Terminal panel */}
      <div 
        className="fixed right-0 top-0 h-full w-[40%] min-w-[400px] max-w-[600px] bg-[#1e1e1e] border-l border-[#333] shadow-2xl z-50 flex flex-col animate-slide-in"
        style={{ animation: 'slideIn 0.2s ease-out' }}
      >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-[#252526] border-b border-[#333]">
        <div className="flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span className="text-sm font-medium text-gray-200">Debug Terminal</span>
          <span className="text-xs text-gray-500 ml-2">{sessionId}</span>
        </div>
        <button 
          onClick={onClose}
          className="p-1 hover:bg-[#3c3c3c] rounded transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Action Bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-[#252526] border-b border-[#333]">
        <button
          onClick={runAutoDebug}
          disabled={isRunning || autoDebug}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            isRunning || autoDebug 
              ? 'bg-[#3c3c3c] text-gray-500 cursor-not-allowed' 
              : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        >
          {autoDebug ? (
            <>
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
              </svg>
              Running...
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
              Auto-Debug
            </>
          )}
        </button>
        
        <button
          onClick={applyFix}
          disabled={isRunning || commandHistory.length === 0}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
            isRunning || commandHistory.length === 0
              ? 'bg-[#3c3c3c] text-gray-500 cursor-not-allowed'
              : 'bg-green-600 hover:bg-green-700 text-white'
          }`}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          Apply Fix
        </button>

        <div className="flex-1" />
        
        <span className="text-xs text-gray-500">
          {isRunning ? 'Running...' : 'Ready'}
        </span>
      </div>

      {/* Terminal */}
      <div className="flex-1 p-2 overflow-hidden">
        <XTerm 
          ref={xtermRef}
          className="h-full w-full"
        />
      </div>

      {/* Quick Commands */}
      <div className="px-4 py-2 bg-[#252526] border-t border-[#333]">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">Quick:</span>
          <button
            onClick={() => executeCommand(`playwright-cli -s=${sessionId} eval "document.body.innerText.slice(0,100)"`)}
            className="px-2 py-1 text-xs bg-[#3c3c3c] hover:bg-[#4c4c4c] text-gray-300 rounded transition-colors"
          >
            Page Text
          </button>
          <button
            onClick={() => executeCommand(`playwright-cli -s=${sessionId} eval "window.location.href"`)}
            className="px-2 py-1 text-xs bg-[#3c3c3c] hover:bg-[#4c4c4c] text-gray-300 rounded transition-colors"
          >
            URL
          </button>
          <button
            onClick={() => executeCommand(`playwright-cli -s=${sessionId} screenshot /tmp/snapshot_${Date.now()}.png`)}
            className="px-2 py-1 text-xs bg-[#3c3c3c] hover:bg-[#4c4c4c] text-gray-300 rounded transition-colors"
          >
            Screenshot
          </button>
        </div>
      </div>
    </div>
    </>
  );
}
