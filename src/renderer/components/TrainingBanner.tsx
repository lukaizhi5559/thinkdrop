import React, { useState, useEffect } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface TrainingBannerProps {
  agentId: string;
  hostname: string;
  onDone: () => void;
  onCancel: () => void;
}

interface NarrativeItem {
  timestamp: number;
  action: string;
  description: string;
}

export function TrainingBanner({ agentId, hostname, onDone, onCancel }: TrainingBannerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [narrative, setNarrative] = useState<NarrativeItem[]>([]);
  const [currentMessage, setCurrentMessage] = useState('Watching your interactions...');
  const [isDoneDialogOpen, setIsDoneDialogOpen] = useState(false);

  useEffect(() => {
    if (!ipcRenderer) return;

    const handleTrainingProgress = (_: any, data: any) => {
      if (data.agentId !== agentId) return;

      switch (data.type) {
        case 'training:narrative':
          if (data.narrative) {
            setNarrative(data.narrative);
            if (data.narrative.length > 0) {
              setCurrentMessage(data.narrative[data.narrative.length - 1].description);
            }
          }
          break;
        case 'training:observing':
          setCurrentMessage(data.message || 'Watching...');
          break;
      }
    };

    ipcRenderer.on('agents:train-progress', handleTrainingProgress);

    return () => {
      ipcRenderer.removeListener('agents:train-progress', handleTrainingProgress);
    };
  }, [agentId]);

  const handleDone = () => {
    setIsDoneDialogOpen(true);
  };

  const handleConfirmDone = () => {
    setIsDoneDialogOpen(false);
    onDone();
  };

  return (
    <>
      {/* Floating Training Banner */}
      <div style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9998,
        backgroundColor: '#1f2937',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
        minWidth: 400,
      }}>
        {/* Recording indicator */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            backgroundColor: '#ef4444',
            animation: 'pulse 1.5s infinite',
          }} />
          <span style={{ color: '#9ca3af', fontSize: '0.8rem' }}>Recording</span>
        </div>

        {/* Status */}
        <div style={{ flex: 1 }}>
          <div style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 500 }}>
            Training Mode
          </div>
          <div style={{ color: '#6b7280', fontSize: '0.75rem' }}>
            {currentMessage}
          </div>
        </div>

        {/* Narrative toggle */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          style={{
            padding: '6px 12px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.1)',
            backgroundColor: 'transparent',
            color: '#9ca3af',
            fontSize: '0.75rem',
            cursor: 'pointer',
          }}
        >
          {isExpanded ? 'Hide' : 'Show'} Log ({narrative.length})
        </button>

        {/* Done button */}
        <button
          onClick={handleDone}
          style={{
            padding: '8px 16px',
            borderRadius: 6,
            border: 'none',
            backgroundColor: '#10b981',
            color: '#fff',
            fontSize: '0.8rem',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          Done Training
        </button>

        {/* Cancel button */}
        <button
          onClick={onCancel}
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            border: 'none',
            backgroundColor: 'transparent',
            color: '#6b7280',
            fontSize: '0.8rem',
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      {/* Expanded Narrative Panel */}
      {isExpanded && (
        <div style={{
          position: 'fixed',
          top: 80,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 9997,
          backgroundColor: '#1f2937',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 12,
          padding: 16,
          width: 400,
          maxHeight: 300,
          overflowY: 'auto',
          boxShadow: '0 10px 40px rgba(0,0,0,0.5)',
        }}>
          <h4 style={{ margin: '0 0 12px 0', color: '#fff', fontSize: '0.85rem' }}>
            Training Log
          </h4>
          {narrative.length === 0 ? (
            <p style={{ color: '#6b7280', fontSize: '0.8rem', fontStyle: 'italic' }}>
              Waiting for interactions...
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {narrative.map((item, idx) => (
                <div 
                  key={idx}
                  style={{
                    padding: '8px 12px',
                    backgroundColor: 'rgba(255,255,255,0.05)',
                    borderRadius: 6,
                    fontSize: '0.8rem',
                    color: '#d1d5db',
                    borderLeft: item.action === 'teach_me' ? '3px solid #f59e0b' : '3px solid #3b82f6',
                  }}
                >
                  {item.description}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Done Confirmation Dialog */}
      {isDoneDialogOpen && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.7)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 10000,
        }}>
          <div style={{
            backgroundColor: '#1f2937',
            borderRadius: 12,
            padding: 24,
            width: 360,
            textAlign: 'center',
          }}>
            <h3 style={{ margin: '0 0 8px 0', color: '#fff' }}>
              Finish Training?
            </h3>
            <p style={{ margin: '0 0 20px 0', color: '#9ca3af', fontSize: '0.85rem' }}>
              I'll review what I learned and generate a skill you can test.
            </p>
            
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                onClick={() => setIsDoneDialogOpen(false)}
                style={{
                  padding: '10px 20px',
                  borderRadius: 6,
                  border: '1px solid rgba(255,255,255,0.2)',
                  backgroundColor: 'transparent',
                  color: '#9ca3af',
                  cursor: 'pointer',
                }}
              >
                Keep Training
              </button>
              <button
                onClick={handleConfirmDone}
                style={{
                  padding: '10px 20px',
                  borderRadius: 6,
                  border: 'none',
                  backgroundColor: '#10b981',
                  color: '#fff',
                  cursor: 'pointer',
                }}
              >
                Finish & Review
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
      `}</style>
    </>
  );
}
