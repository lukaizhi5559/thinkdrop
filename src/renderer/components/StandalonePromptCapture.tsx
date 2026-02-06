import { useState, useEffect, useRef } from 'react';
import { getVSCodeBridge, hasBridge } from '../services/vscodebridge';

const ipcRenderer = (window as any).electron?.ipcRenderer;

export default function StandalonePromptCapture() {
  const [promptText, setPromptText] = useState('');
  const [highlights, setHighlights] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!ipcRenderer) return;

    const handleShow = (_event: any, data: { position?: { x: number; y: number } }) => {
      console.log('📥 [STANDALONE_PROMPT] Window shown at position:', data?.position);
      
      setHighlights([]);
      setPromptText('');
      
      setTimeout(() => {
        textareaRef.current?.focus();
        console.log('✅ [STANDALONE_PROMPT] Textarea focused');
      }, 100);
    };

    const handleAddHighlight = (_event: any, text: string) => {
      console.log('📥 [STANDALONE_PROMPT] Received highlight:', text.substring(0, 50));
      
      setHighlights(prev => {
        if (prev.includes(text)) {
          console.log('⏭️ [STANDALONE_PROMPT] Duplicate highlight ignored');
          return prev;
        }
        
        setTimeout(() => requestWindowResize(), 100);
        return [...prev, text];
      });
    };

    ipcRenderer.on('prompt-capture:show', handleShow);
    ipcRenderer.on('prompt-capture:add-highlight', handleAddHighlight);

    return () => {
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('prompt-capture:show', handleShow);
        ipcRenderer.removeListener('prompt-capture:add-highlight', handleAddHighlight);
      }
    };
  }, []);

  useEffect(() => {
    requestWindowResize();
  }, [highlights, promptText]);

  const handleSubmit = async () => {
    console.log('🚀 [STANDALONE_PROMPT] handleSubmit called');
    
    if (!promptText.trim() && highlights.length === 0) {
      console.log('⚠️ [STANDALONE_PROMPT] No text or highlights, skipping submit');
      return;
    }
    
    let finalPrompt = '';
    
    if (highlights.length > 0) {
      finalPrompt = highlights.map(h => `[Highlighted: ${h}]`).join('\n') + '\n\n';
    }
    
    finalPrompt += promptText;
    
    const MAX_MESSAGE_LENGTH = 50000;
    if (finalPrompt.trim().length > MAX_MESSAGE_LENGTH) {
      console.error(`❌ [STANDALONE_PROMPT] Message too long: ${finalPrompt.length} chars`);
      
      const errorMessage = 
        `⚠️ Message Too Long\n\n` +
        `Your message is ${finalPrompt.length.toLocaleString()} characters, but the limit is ${MAX_MESSAGE_LENGTH.toLocaleString()}.\n\n` +
        `Please try:\n` +
        `• Remove some highlight tags by clicking the × button\n` +
        `• Highlight a smaller section of code\n` +
        `• Break your question into multiple parts`;
      
      if (ipcRenderer) {
        ipcRenderer.send('results-window:show-error', errorMessage);
      }
      return;
    }
    
    console.log('📤 [STANDALONE_PROMPT] Final prompt to send:', finalPrompt.trim());
    
    if (ipcRenderer) {
      ipcRenderer.send('results-window:set-prompt', finalPrompt.trim());
    }
    
    if (hasBridge()) {
      try {
        console.log('📤 [STANDALONE_PROMPT] Sending via VS Code Bridge');
        const bridge = getVSCodeBridge();
        
        // let screenshot: string | undefined;
        // try {
        //   const screenshotBase64 = await ipcRenderer.invoke('capture-screenshot');
        //   screenshot = screenshotBase64;
        //   console.log('📸 [STANDALONE_PROMPT] Screenshot captured');
        // } catch (error) {
        //   console.warn('⚠️ [STANDALONE_PROMPT] Screenshot capture failed:', error);
        // }
        
        const screenshot = undefined; // Screenshot disabled for now
        await bridge.sendMessage(finalPrompt.trim(), screenshot);
        console.log('✅ [STANDALONE_PROMPT] Message sent successfully');
      } catch (error) {
        console.error('❌ [STANDALONE_PROMPT] Failed to send message:', error);
      }
    } else {
      console.error('❌ [STANDALONE_PROMPT] VS Code Bridge not available!');
    }
    
    setPromptText('');
    setHighlights([]);
    console.log('✅ [STANDALONE_PROMPT] Submit complete, waiting for results');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === 'Escape') {
      if (ipcRenderer) {
        ipcRenderer.send('prompt-capture:hide');
      }
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setPromptText(e.target.value);
    
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
    
    requestWindowResize();
  };
  
  const removeHighlight = (index: number) => {
    setHighlights(prev => prev.filter((_, i) => i !== index));
    setTimeout(() => requestWindowResize(), 100);
  };
  
  const requestWindowResize = () => {
    if (!ipcRenderer || !containerRef.current) return;
    
    setTimeout(() => {
      if (!containerRef.current) return;
      
      const rect = containerRef.current.getBoundingClientRect();
      const contentHeight = Math.ceil(rect.height);
      const contentWidth = Math.ceil(rect.width);
      
      const targetHeight = Math.min(Math.max(contentHeight, 120), 600);
      const targetWidth = Math.min(Math.max(contentWidth, 400), 600);
      
      console.log(`📐 [STANDALONE_PROMPT] Requesting resize to ${targetWidth}x${targetHeight}`);
      ipcRenderer.send('prompt-capture:resize', { width: targetWidth, height: targetHeight });
    }, 50);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!ipcRenderer) return;
    
    setIsDragging(true);
    const bounds = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dragOffset.current = {
      x: e.clientX - bounds.left,
      y: e.clientY - bounds.top
    };
    console.log('🖱️ [STANDALONE_PROMPT] Drag started');
  };

  useEffect(() => {
    if (!isDragging || !ipcRenderer) return;

    const handleMouseMove = (e: MouseEvent) => {
      const newX = e.screenX - dragOffset.current.x;
      const newY = e.screenY - dragOffset.current.y;
      
      ipcRenderer.send('prompt-capture:move', { x: newX, y: newY });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      console.log('🖱️ [STANDALONE_PROMPT] Drag ended');
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div className="w-full h-full flex items-center justify-center">
      <div
        ref={containerRef}
        className="rounded-xl shadow-2xl backdrop-blur-md"
        style={{
          backgroundColor: 'rgba(23, 23, 23, 0.95)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          minWidth: '400px',
          maxWidth: '600px',
          maxHeight: '600px',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div
          onMouseDown={handleMouseDown}
          className="px-4 py-2 pt-2 border-b flex items-center justify-between"
          style={{
            borderColor: 'rgba(255, 255, 255, 0.08)',
            cursor: isDragging ? 'grabbing' : 'grab',
            userSelect: 'none',
            flex: '0 0 auto',
            position: 'sticky',
            top: 0,
            backgroundColor: 'rgba(23, 23, 23, 0.95)',
            zIndex: 10,
          }}
        >
          <div style={{ display: 'flex', gap: '4px' }}>
            <div style={{ width: '3px', height: '3px', borderRadius: '50%', backgroundColor: 'rgba(255, 255, 255, 0.3)' }} />
            <div style={{ width: '3px', height: '3px', borderRadius: '50%', backgroundColor: 'rgba(255, 255, 255, 0.3)' }} />
            <div style={{ width: '3px', height: '3px', borderRadius: '50%', backgroundColor: 'rgba(255, 255, 255, 0.3)' }} />
          </div>
        </div>
        <div style={{ flex: '1 1 auto', overflowY: 'auto', overflowX: 'hidden' }}>
          <div className="p-4">
            {highlights.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
                {highlights.map((highlight, index) => {
                  const truncated = highlight.length > 50 ? highlight.substring(0, 50) + '...' : highlight;
                  return (
                    <div
                      key={index}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '4px 8px',
                        backgroundColor: 'rgba(59, 130, 246, 0.15)',
                        border: '1px solid rgba(59, 130, 246, 0.3)',
                        borderRadius: '6px',
                        fontSize: '0.75rem',
                        color: '#93c5fd',
                      }}
                    >
                      <span style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {truncated}
                      </span>
                      <button
                        onClick={() => removeHighlight(index)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: '14px',
                          height: '14px',
                          padding: 0,
                          border: 'none',
                          backgroundColor: 'transparent',
                          color: '#93c5fd',
                          cursor: 'pointer',
                          fontSize: '12px',
                          lineHeight: 1,
                        }}
                        onMouseEnter={(e) => e.currentTarget.style.color = '#60a5fa'}
                        onMouseLeave={(e) => e.currentTarget.style.color = '#93c5fd'}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              <textarea
                ref={textareaRef}
                value={promptText}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                placeholder="Ask anything"
                className="text-sm whitespace-pre-wrap break-words resize-none focus:outline-none"
                style={{
                  color: '#e5e7eb',
                  backgroundColor: 'transparent',
                  border: 'none',
                  outline: 'none',
                  boxShadow: 'none',
                  minHeight: '25px',
                  maxHeight: '400px',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                  flex: 1,
                  padding: '5px',
                  margin: 0,
                }}
                rows={1}
                autoFocus
              />
              
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '24px',
                  height: '24px',
                  borderRadius: '4px',
                  backgroundColor: (promptText.trim() || highlights.length > 0) ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid',
                  borderColor: (promptText.trim() || highlights.length > 0) ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                  flexShrink: 0,
                  marginTop: '2px',
                  cursor: (promptText.trim() || highlights.length > 0) ? 'pointer' : 'default',
                }}
                onClick={(promptText.trim() || highlights.length > 0) ? handleSubmit : undefined}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={(promptText.trim() || highlights.length > 0) ? '#60a5fa' : '#6b7280'}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M9 10l-5 5 5 5" />
                  <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                </svg>
              </div>
            </div>
          </div>
        </div>
        
        <div
          className="px-4 py-2.5 border-t text-xs flex items-center gap-3"
          style={{ 
            borderColor: 'rgba(255, 255, 255, 0.08)',
            color: '#9ca3af',
            flex: '0 0 auto',
            position: 'sticky',
            bottom: 0,
            backgroundColor: 'rgba(23, 23, 23, 0.95)',
            zIndex: 10,
          }}
        >
          <span><span style={{ fontWeight: 500 }}>Highlight and Cmd+C: </span>Tag(s)</span>
          <span>•</span>
          <span><span style={{ fontWeight: 500 }}>Esc:</span> Close</span>
        </div>
      </div>
    </div>
  );
}
