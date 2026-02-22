import { useEffect, useState, useRef } from 'react';
import { RichContentRenderer } from './rich-content';
import AutomationProgress from './AutomationProgress';

const ipcRenderer = (window as any).electron?.ipcRenderer;

export default function ResultsWindow() {
  console.log('🎨 [RESULTS_WINDOW] Component rendering');
  
  const [promptText, setPromptText] = useState<string>('');
  const contentRef = useRef<HTMLDivElement>(null);
  
  const [streamingResponse, setStreamingResponse] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);

  // Automation mode: tracked inside AutomationProgress itself
  const [isAutomationMode, setIsAutomationMode] = useState(false);
  
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  
  const [isCopied, setIsCopied] = useState(false);
  const [showTrigger, setShowTrigger] = useState(0);

  useEffect(() => {
    if (!ipcRenderer) return;

    console.log('🔄 [RESULTS_WINDOW] Setting up VS Code Bridge IPC listeners');

    const handleBridgeConnected = () => {
      console.log('✅ [RESULTS_WINDOW] VS Code Bridge connected');
    };

    const handleBridgeDisconnected = () => {
      console.log('🔌 [RESULTS_WINDOW] VS Code Bridge disconnected');
    };

    const handleBridgeMessage = (_event: any, message: any) => {
      console.log('📨 [RESULTS_WINDOW] Bridge message:', message.type);
      
      // if (message.type === 'llm_stream_start') {
      //   setIsThinking(true);
      //   setIsStreaming(false);
      //   setStreamingResponse('');
      // }

      if (message.type === 'chunk' || message.type === 'llm_stream_chunk') {
        console.log('💬 [RESULTS_WINDOW] Stream token:', message);
        setIsThinking(false);
        setIsStreaming(true);

        const msgText = message?.text || message.payload?.text || '';
        setStreamingResponse(prev => prev + msgText);
      } else if (message.type === 'done' || message.type === 'llm_stream_end') {
        setIsStreaming(false);
        console.log('✅ [RESULTS_WINDOW] Streaming complete');
      } else if (message.type === 'ready') {
        console.log('✅ [RESULTS_WINDOW] VS Code extension ready');
      }
    };

    const handleBridgeError = (_event: any, error: string) => {
      console.error('❌ [RESULTS_WINDOW] Bridge error:', error);
      setIsThinking(false);
      setIsStreaming(false);
      setStreamingResponse(`❌ Error: ${error}`);
    };

    // Remove any stale listeners before adding new ones (handles React StrictMode double-invoke)
    ipcRenderer.removeAllListeners('ws-bridge:connected');
    ipcRenderer.removeAllListeners('ws-bridge:disconnected');
    ipcRenderer.removeAllListeners('ws-bridge:message');
    ipcRenderer.removeAllListeners('ws-bridge:error');

    ipcRenderer.on('ws-bridge:connected', handleBridgeConnected);
    ipcRenderer.on('ws-bridge:disconnected', handleBridgeDisconnected);
    ipcRenderer.on('ws-bridge:message', handleBridgeMessage);
    ipcRenderer.on('ws-bridge:error', handleBridgeError);

    // Request connection on mount
    ipcRenderer.send('ws-bridge:connect');

    return () => {
      ipcRenderer.removeAllListeners('ws-bridge:connected');
      ipcRenderer.removeAllListeners('ws-bridge:disconnected');
      ipcRenderer.removeAllListeners('ws-bridge:message');
      ipcRenderer.removeAllListeners('ws-bridge:error');
    };
  }, []);

  useEffect(() => {
    if (!ipcRenderer) return;

    const handleDisplayError = (_event: any, errorMessage: string) => {
      console.log('⚠️ [RESULTS_WINDOW] Displaying error message:', errorMessage);
      setIsThinking(false);
      setIsStreaming(false);
      setStreamingResponse(errorMessage);
    };

    const handlePromptText = async (_event: any, text: string) => {
      console.log('📝 [RESULTS_WINDOW] Received prompt text:', text);
      
      if (!text || text.trim().length === 0) {
        console.warn('⚠️ [RESULTS_WINDOW] Empty message ignored');
        return;
      }
      
      // Reset all state for new prompt
      setPromptText(text);
      setStreamingResponse('');
      setIsStreaming(false);
      setIsThinking(true);
      setIsAutomationMode(false); // AutomationProgress will self-activate on 'planning' event
      
      console.log('✅ [RESULTS_WINDOW] Ready to receive response for:', text.substring(0, 50));
    };

    // When the window is re-shown, bump showTrigger to re-measure content height
    const handleWindowShow = () => {
      console.log('📐 [RESULTS_WINDOW] Window shown - triggering content resize');
      setShowTrigger(prev => prev + 1);
    };

    ipcRenderer.on('results-window:display-error', handleDisplayError);
    ipcRenderer.on('results-window:set-prompt', handlePromptText);
    ipcRenderer.on('results-window:show', handleWindowShow);
  
    return () => {
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('results-window:display-error', handleDisplayError);
        ipcRenderer.removeListener('results-window:set-prompt', handlePromptText);
        ipcRenderer.removeListener('results-window:show', handleWindowShow);
      }
    };
  }, []);

  // Dynamically resize window based on content at all times
  useEffect(() => {
    if (!contentRef.current || !ipcRenderer) return;

    const resizeForContent = () => {
      const headerHeight = 52;
      const padding = 32;
      const minHeight = 100;
      const maxHeight = 800;

      const contentHeight = contentRef.current?.scrollHeight || 0;
      const totalHeight = Math.min(Math.max(contentHeight + headerHeight + padding, minHeight), maxHeight);

      console.log('📏 [RESULTS_WINDOW] Content resize:', { height: totalHeight, contentHeight });
      // Ensure integers for Electron
      const width = 400;
      const height = Math.round(totalHeight);
      ipcRenderer.send('results-window:resize', { width, height });
    };

    const rafId = requestAnimationFrame(resizeForContent);

    return () => cancelAnimationFrame(rafId);
  }, [streamingResponse, isStreaming, promptText, isThinking, showTrigger]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        console.log('⌨️  [RESULTS_WINDOW] ESC pressed - closing results window');
        if (ipcRenderer) {
          ipcRenderer.send('results-window:close');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleClose = () => {
    console.log('❌ [RESULTS_WINDOW] Close button clicked');
    if (ipcRenderer) {
      ipcRenderer.send('results-window:close');
    }
  };

  const handleCopy = async () => {
    const contentToCopy = streamingResponse;
    if (!contentToCopy) return;
    
    try {
      await navigator.clipboard.writeText(contentToCopy);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
      console.log('✅ [RESULTS_WINDOW] Content copied to clipboard');
    } catch (error) {
      console.error('❌ [RESULTS_WINDOW] Failed to copy:', error);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    
    setIsDragging(true);
    const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffset.current = {
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top
    };
    
    console.log('🖱️ [RESULTS_WINDOW] Drag started');
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!ipcRenderer) return;
      
      const newX = e.screenX - dragOffset.current.x;
      const newY = e.screenY - dragOffset.current.y;
      
      ipcRenderer.send('results-window:move', { x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      console.log('🖱️ [RESULTS_WINDOW] Drag ended');
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const renderResults = () => {
    if (isAutomationMode) return null;

    if (isThinking) {
      return (
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: '0ms' }} />
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: '150ms' }} />
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" style={{ animationDelay: '300ms' }} />
          </div>
          <span className="text-gray-400 text-sm">Thinking...</span>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        {streamingResponse && (
          <div className="relative">
            <RichContentRenderer 
              content={streamingResponse}
              animated={!isStreaming}
              className="text-sm"
            />
            {isStreaming && (
              <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-1" />
            )}
          </div>
        )}

        {!isThinking && !streamingResponse && (
          <div className="text-gray-400 text-sm text-center">
            Waiting for response...
          </div>
        )}
      </div>
    );
  };

  return (
    <div 
      className="w-full h-full flex flex-col"
      style={{
        backgroundColor: 'rgba(23, 23, 23, 0.95)',
      }}
    >
      <div 
        className="flex items-center justify-between px-4 py-3 border-b"
        onMouseDown={handleMouseDown}
        style={{
          borderColor: 'rgba(255, 255, 255, 0.1)',
          flexShrink: 0,
          cursor: isDragging ? 'grabbing' : 'grab',
          userSelect: 'none',
        }}
      >
        <div 
          className="text-sm font-medium truncate flex-1 mr-2"
          style={{ color: '#e5e7eb' }}
          title={promptText}
        >
          {promptText || 'Results'}
        </div>
        <div className="flex items-center gap-2">
          {streamingResponse && (
            <button
              onClick={handleCopy}
              className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700 transition-colors flex-shrink-0"
              style={{
                backgroundColor: isCopied ? 'rgba(34, 197, 94, 0.2)' : 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                color: isCopied ? '#22c55e' : '#9ca3af',
                fontSize: '12px',
                cursor: 'pointer',
              }}
              title={isCopied ? 'Copied!' : 'Copy response'}
            >
              {isCopied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              )}
            </button>
          )}
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded-full hover:bg-gray-700 transition-colors flex-shrink-0"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              color: '#9ca3af',
              fontSize: '14px',
              cursor: 'pointer',
            }}
            title="Close (ESC)"
          >
            ×
          </button>
        </div>
      </div>
      
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4">
        <div ref={contentRef}>
          {/* AutomationProgress is always mounted so its IPC listener is pre-registered */}
          <AutomationProgress
            onHeightChange={() => setShowTrigger(prev => prev + 1)}
            onActiveChange={setIsAutomationMode}
          />
          {renderResults()}
        </div>
      </div>
    </div>
  );
}
