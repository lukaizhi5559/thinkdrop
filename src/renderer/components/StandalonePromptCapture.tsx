import React, { useState, useEffect, useRef } from 'react';
import VoiceButton from './VoiceButton';

const ipcRenderer = (window as any).electron?.ipcRenderer;

export default function StandalonePromptCapture() {
  const [promptText, setPromptText] = useState('');
  const [highlights, setHighlights] = useState<string[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const [isProcessing, setIsProcessing] = useState(false);

  const handleAddHighlight = (_event: any, text: string) => {
    console.log('📥 [STANDALONE_PROMPT] Received highlight:', text);
    
    setHighlights(prev => {
      if (prev.includes(text)) {
        console.log('⏭️ [STANDALONE_PROMPT] Duplicate highlight ignored');
        return prev;
      }
      
      setTimeout(() => requestWindowResize(), 100);
      return [...prev, text];
    });
  };

  useEffect(() => {
    if (!ipcRenderer) return;

    const handleShow = (_event: any, data: { position?: { x: number; y: number } }) => {
      console.log('📥 [STANDALONE_PROMPT] Window shown at position:', data?.position);
      
      setHighlights([]);
      setPromptText('');
      
      setTimeout(() => {
        textareaRef.current?.focus();
        console.log('✅ [STANDALONE_PROMPT] Textarea focused');
      }, 300);
    };

    const handleProgress = (_event: any, data: any) => {
      if (data?.type === 'all_done') setIsProcessing(false);
    };

    const handleBridgeMessage = (_event: any, msg: any) => {
      if (msg?.type === 'done' || msg?.type === 'llm_stream_end') setIsProcessing(false);
    };

    // Voice inject: clear textarea + show processing ring. Do NOT populate the text input.
    const handleVoiceInjectPrompt = (_event: any) => {
      setPromptText('');
      setHighlights([]);
      setIsProcessing(true);
    };

    // Voice done (response received): stop processing ring
    const handleVoiceResponse = () => {
      setIsProcessing(false);
    };

    ipcRenderer.on('prompt-capture:show', handleShow);
    ipcRenderer.on('prompt-capture:add-highlight', handleAddHighlight);
    ipcRenderer.on('automation:progress', handleProgress);
    ipcRenderer.on('ws-bridge:message', handleBridgeMessage);
    ipcRenderer.on('voice:inject-prompt', handleVoiceInjectPrompt);
    ipcRenderer.on('voice:response', handleVoiceResponse);

    return () => {
      if (ipcRenderer.removeListener) {
        ipcRenderer.removeListener('prompt-capture:show', handleShow);
        ipcRenderer.removeListener('prompt-capture:add-highlight', handleAddHighlight);
        ipcRenderer.removeListener('automation:progress', handleProgress);
        ipcRenderer.removeListener('ws-bridge:message', handleBridgeMessage);
        ipcRenderer.removeListener('voice:inject-prompt', handleVoiceInjectPrompt);
        ipcRenderer.removeListener('voice:response', handleVoiceResponse);
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
    console.log('🔍 [STANDALONE_PROMPT] ipcRenderer available?', !!ipcRenderer);
    
    if (ipcRenderer) {
      // Route through StateGraph pipeline (intent → MCP services → LLM answer)
      console.log('🧠 [STANDALONE_PROMPT] Sending to StateGraph pipeline');
      ipcRenderer.send('stategraph:process', {
        prompt: finalPrompt.trim(),
        selectedText: highlights.join('\n'),
      });
      setIsProcessing(true);
      console.log('✅ [STANDALONE_PROMPT] Message sent to StateGraph');
    } else {
      console.error('❌ [STANDALONE_PROMPT] ipcRenderer is not available!');
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
      const newX = Math.round(e.screenX - dragOffset.current.x);
      const newY = Math.round(e.screenY - dragOffset.current.y);
      if (!Number.isFinite(newX) || !Number.isFinite(newY)) return;
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

  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    files.forEach(file => {
      const path = (file as any).path;
      if (path) {
        handleAddHighlight(null, `[File: ${path}]`);
      }
    });
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes('Files')) setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  return (
    <div className="w-full h-full flex items-center justify-center">
      <style>{`
        @keyframes prompt-border-sweep {
          0%   { --prompt-angle: 0deg; }
          100% { --prompt-angle: 360deg; }
        }
        @property --prompt-angle {
          syntax: '<angle>';
          initial-value: 0deg;
          inherits: false;
        }
        .prompt-glow-ring {
          position: absolute;
          inset: -1px;
          border-radius: 13px;
          padding: 1.5px;
          background: conic-gradient(from var(--prompt-angle), transparent 65%, #3b82f6 82%, #60a5fa 88%, #3b82f6 94%, transparent);
          animation: prompt-border-sweep 2.4s linear infinite;
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          pointer-events: none;
          z-index: 20;
          opacity: 0;
          transition: opacity 0.4s ease;
        }
        .prompt-glow-ring.active {
          opacity: 1;
        }
      `}</style>
      <div style={{ position: 'relative' }}>
        <div className={`prompt-glow-ring${isProcessing ? ' active' : ''}`} />
        <div
          ref={containerRef}
          className="rounded-xl shadow-2xl backdrop-blur-md"
          onDrop={handleFileDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          style={{
            backgroundColor: 'rgba(23, 23, 23, 0.95)',
            border: isDragOver ? '1px solid rgba(59, 130, 246, 0.6)' : '1px solid rgba(255, 255, 255, 0.08)',
            boxShadow: isDragOver ? '0 0 0 2px rgba(59, 130, 246, 0.2)' : undefined,
            minWidth: '400px',
            maxWidth: '600px',
            maxHeight: '600px',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            transition: 'border-color 0.15s, box-shadow 0.15s',
            position: 'relative',
            zIndex: 1,
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
                  // Detect tag type for icon + label
                  const fileMatch = highlight.match(/^\[File:\s*(.+)\]$/);
                  const isFile = !!fileMatch;
                  const isApp = highlight.match(/^\[File:.*\.app\]$/);

                  let label: string;
                  let chipColor: string;
                  let borderColor: string;
                  let icon: React.ReactNode;

                  if (isFile) {
                    const fullPath = fileMatch![1].trim();
                    const fileName = fullPath.split('/').pop() || fullPath;
                    label = fileName;
                    chipColor = isApp ? 'rgba(139, 92, 246, 0.15)' : 'rgba(59, 130, 246, 0.15)';
                    borderColor = isApp ? 'rgba(139, 92, 246, 0.35)' : 'rgba(59, 130, 246, 0.3)';
                    icon = isApp ? (
                      // App icon
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="3" />
                        <path d="M9 9h6M9 12h6M9 15h4" />
                      </svg>
                    ) : (
                      // File icon
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                    );
                  } else {
                    // Text highlight — show first ~24 chars
                    const words = highlight.replace(/\s+/g, ' ').trim();
                    label = words.length > 24 ? words.slice(0, 24) + '…' : words;
                    chipColor = 'rgba(16, 185, 129, 0.12)';
                    borderColor = 'rgba(16, 185, 129, 0.3)';
                    icon = (
                      // Quote/text icon
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z" />
                        <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z" />
                      </svg>
                    );
                  }

                  const iconColor = isApp ? '#c4b5fd' : isFile ? '#93c5fd' : '#6ee7b7';

                  return (
                    <div
                      key={index}
                      title={highlight}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '3px 7px',
                        backgroundColor: chipColor,
                        border: `1px solid ${borderColor}`,
                        borderRadius: '6px',
                        fontSize: '0.72rem',
                        color: iconColor,
                        maxWidth: '180px',
                      }}
                    >
                      <span style={{ flexShrink: 0, opacity: 0.85 }}>{icon}</span>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {label}
                      </span>
                      <button
                        onClick={() => removeHighlight(index)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          width: '13px',
                          height: '13px',
                          padding: 0,
                          border: 'none',
                          backgroundColor: 'transparent',
                          color: iconColor,
                          cursor: 'pointer',
                          fontSize: '13px',
                          lineHeight: 1,
                          opacity: 0.7,
                        }}
                        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
                        onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.7')}
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
                  backgroundColor: isProcessing
                    ? 'rgba(255, 255, 255, 0.07)'
                    : (promptText.trim() || highlights.length > 0) ? 'rgba(59, 130, 246, 0.2)' : 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid',
                  borderColor: isProcessing
                    ? 'rgba(255, 255, 255, 0.15)'
                    : (promptText.trim() || highlights.length > 0) ? 'rgba(59, 130, 246, 0.3)' : 'rgba(255, 255, 255, 0.1)',
                  flexShrink: 0,
                  marginTop: '2px',
                  cursor: (isProcessing || promptText.trim() || highlights.length > 0) ? 'pointer' : 'default',
                  transition: 'background-color 0.15s, border-color 0.15s',
                }}
                title={isProcessing ? 'Cancel' : 'Send'}
                onClick={isProcessing ? () => ipcRenderer?.send('automation:cancel') : (promptText.trim() || highlights.length > 0) ? handleSubmit : undefined}
              >
                {isProcessing ? (
                  /* Stop square — like ChatGPT/Windsurf cancel */
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="#9ca3af">
                    <rect x="0" y="0" width="10" height="10" rx="2" />
                  </svg>
                ) : (
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
                )}
              </div>
            </div>
          </div>
        </div>
        
        <div
          style={{
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            flex: '0 0 auto',
            position: 'sticky',
            bottom: 0,
            backgroundColor: 'rgba(23, 23, 23, 0.95)',
            zIndex: 10,
          }}
        >
          {/* ⇧⌘C shortcut hint — not clickable, just informational */}
          <div
            title="Copy text or a file path, then press ⇧⌘C to tag it as context"
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '4px 8px', borderRadius: '6px',
              backgroundColor: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              color: '#9ca3af', cursor: 'default', fontSize: '0.7rem',
              userSelect: 'none',
            }}
          >
            {/* Keyboard key badges: Shift + Ctrl/Cmd + C */}
            {([
              {
                label: 'shift',
                content: (
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                    <polygon points="5,1 9,6 7,6 7,9 3,9 3,6 1,6" />
                  </svg>
                ),
              },
              {
                label: 'ctrl-cmd',
                content: <span style={{ fontSize: '0.62rem', fontWeight: 600, lineHeight: 1, letterSpacing: '-0.02em' }}>Ctrl/⌘</span>,
              },
              {
                label: 'C',
                content: <span style={{ fontSize: '0.7rem', fontWeight: 600, lineHeight: 1 }}>C</span>,
              },
            ]).map(({ label, content }, i, arr) => (
              <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '20px',
                    padding: '0 6px',
                    borderRadius: '4px',
                    backgroundColor: 'rgba(255,255,255,0.08)',
                    color: '#c9d1d9',
                  }}
                >
                  {content}
                </span>
                {i < arr.length - 1 && (
                  <span style={{ color: '#4b5563', fontSize: '0.65rem', lineHeight: 1 }}>+</span>
                )}
              </span>
            ))}
          </div>

          {/* Voice button — push-to-talk or wake word */}
          <VoiceButton
            mode="push-to-talk"
            compact={false}
          />

          {/* File picker button — click to open native file dialog */}
          <button
            title="Click to select a file or folder to tag as context. You can also drag files directly onto this window."
            onClick={() => ipcRenderer?.send('prompt-capture:pick-file')}
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              padding: '4px 8px', borderRadius: '6px',
              backgroundColor: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              color: '#9ca3af', cursor: 'pointer', fontSize: '0.7rem',
              userSelect: 'none',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(59,130,246,0.12)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(59,130,246,0.3)';
              (e.currentTarget as HTMLButtonElement).style.color = '#93c5fd';
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.backgroundColor = 'rgba(255,255,255,0.04)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.07)';
              (e.currentTarget as HTMLButtonElement).style.color = '#9ca3af';
            }}
          >
            {/* Folder open icon */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
            <span>Attach file</span>
          </button>

          <div style={{ flex: 1 }} />

          {/* Esc hint */}
          <div
            title="Press Escape to close"
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '4px 8px', borderRadius: '6px',
              backgroundColor: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.07)',
              color: '#4b5563', cursor: 'default', fontSize: '0.7rem',
              userSelect: 'none',
            }}
          >
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>esc</span>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
