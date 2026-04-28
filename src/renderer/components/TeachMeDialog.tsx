import React, { useState } from 'react';

const ipcRenderer = (window as any).electron?.ipcRenderer;

interface TeachMeDialogProps {
  agentId: string;
  question: string;
  options: string[];
  snapshot?: string;
  onAnswer: (answer: string, explanation?: string) => void;
  onSkip: () => void;
}

export function TeachMeDialog({ agentId, question, options, snapshot, onAnswer, onSkip }: TeachMeDialogProps) {
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [explanation, setExplanation] = useState('');
  const [showExplanation, setShowExplanation] = useState(false);

  const handleOptionSelect = (option: string) => {
    setSelectedOption(option);
    if (option === 'Something else') {
      setShowExplanation(true);
    } else {
      setShowExplanation(false);
    }
  };

  const handleContinue = () => {
    if (!selectedOption) return;
    onAnswer(selectedOption, explanation || undefined);
  };

  const isSomethingElse = selectedOption === 'Something else';
  const canContinue = selectedOption && (!isSomethingElse || explanation.trim());

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.85)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10001,
    }}>
      <div style={{
        backgroundColor: '#1f2937',
        borderRadius: 16,
        padding: 28,
        width: 440,
        maxWidth: '90vw',
        boxShadow: '0 25px 50px -12px rgba(0,0,0,0.5)',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <div style={{ fontSize: '2rem' }}>🤔</div>
          <div>
            <h3 style={{ margin: 0, color: '#fff', fontSize: '1.1rem' }}>
              I'm not sure what happened here
            </h3>
            <p style={{ margin: '4px 0 0 0', color: '#9ca3af', fontSize: '0.8rem' }}>
              Teach me so I can learn
            </p>
          </div>
        </div>

        {/* Question */}
        <p style={{ 
          margin: '0 0 20px 0', 
          color: '#d1d5db', 
          fontSize: '0.95rem',
          lineHeight: 1.5,
        }}>
          {question}
        </p>

        {/* Options */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
          {options.map((option, idx) => (
            <button
              key={idx}
              onClick={() => handleOptionSelect(option)}
              style={{
                padding: '12px 16px',
                borderRadius: 8,
                border: '1px solid',
                borderColor: selectedOption === option ? '#3b82f6' : 'rgba(255,255,255,0.1)',
                backgroundColor: selectedOption === option ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.03)',
                color: selectedOption === option ? '#60a5fa' : '#d1d5db',
                fontSize: '0.9rem',
                cursor: 'pointer',
                textAlign: 'left',
                transition: 'all 0.15s ease',
              }}
            >
              {selectedOption === option && (
                <span style={{ marginRight: 8 }}>●</span>
              )}
              {option}
            </button>
          ))}
        </div>

        {/* Explanation input (only for "Something else") */}
        {showExplanation && (
          <div style={{ marginBottom: 20 }}>
            <label style={{ 
              display: 'block', 
              marginBottom: 8, 
              color: '#9ca3af', 
              fontSize: '0.8rem' 
            }}>
              Please explain what happened:
            </label>
            <textarea
              value={explanation}
              onChange={(e) => setExplanation(e.target.value)}
              placeholder="e.g., 'I clicked the Settings menu to change preferences'"
              rows={3}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.1)',
                backgroundColor: 'rgba(255,255,255,0.05)',
                color: '#fff',
                fontSize: '0.9rem',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
          </div>
        )}

        {/* Current page hint (optional) */}
        {snapshot && (
          <div style={{
            marginBottom: 20,
            padding: 12,
            backgroundColor: 'rgba(0,0,0,0.3)',
            borderRadius: 8,
            fontSize: '0.75rem',
            color: '#6b7280',
            maxHeight: 100,
            overflow: 'hidden',
          }}>
            <div style={{ marginBottom: 4, fontWeight: 500, color: '#9ca3af' }}>
              Current page snapshot:
            </div>
            <code style={{ fontFamily: 'monospace' }}>
              {snapshot.substring(0, 200)}...
            </code>
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button
            onClick={onSkip}
            style={{
              padding: '10px 18px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.1)',
              backgroundColor: 'transparent',
              color: '#6b7280',
              fontSize: '0.85rem',
              cursor: 'pointer',
            }}
          >
            Skip This
          </button>
          <button
            onClick={handleContinue}
            disabled={!canContinue}
            style={{
              padding: '10px 18px',
              borderRadius: 6,
              border: 'none',
              backgroundColor: canContinue ? '#3b82f6' : '#374151',
              color: canContinue ? '#fff' : '#6b7280',
              fontSize: '0.85rem',
              cursor: canContinue ? 'pointer' : 'not-allowed',
              transition: 'all 0.15s ease',
            }}
          >
            Continue Training
          </button>
        </div>
      </div>
    </div>
  );
}
