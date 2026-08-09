/**
 * QuestionCard — Grill-Me Phase D: batched question card UI
 *
 * Renders a batch of questions as numbered option cards with multiple-choice
 * options + free-text "Other" + pagination, using ThinkDrop's color palette.
 *
 * Styled to match the existing scout card / gather auth card patterns in
 * AutomationProgress.tsx (cyan info theme + amber memory-resolved badges).
 */

import { useState } from 'react';

export interface QuestionOption {
  label: string;
  value: string;
  primary?: boolean;
  description?: string;
}

export interface Question {
  id: string;
  text: string;
  type: 'confirm' | 'text' | 'choice';
  options?: QuestionOption[];
  freeText?: boolean;
  memoryResolved?: boolean;
  memoryText?: string;
  memoryTextTemplate?: string;
}

export interface RouteConfirmation {
  service: string;
  route: string;
  reason: string;
  question: string;
}

export interface QuestionBatch {
  batchId: string;
  questions: Question[];
  routeConfirmation?: RouteConfirmation | null;
}

interface QuestionCardProps {
  batch: QuestionBatch;
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: () => void;
}

// ── Partial-failure summary (from playwright.agent's _summarizePartialProgress) ──
// When the turn-loop exhausts after discovery retry, this summary is surfaced
// instead of the generic failure banner. It shows what was completed, what
// remains, and three actions: "Try to finish" (plan extension), "Train me with
// a recipe", or "Other" (free text).
export interface PartialFailureSummary {
  summary: string;
  completed: string[];
  remaining: string[];
  currentUrl?: string | null;
}

interface PartialFailureCardProps {
  partialFailure: PartialFailureSummary;
  options: QuestionOption[];
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

// ── ThinkDrop color palette (extracted from AutomationProgress.tsx) ──────────
const COLORS = {
  cardBg: 'rgba(56,189,248,0.06)',
  cardBorder: '1px solid rgba(56,189,248,0.28)',
  headerText: '#7dd3fc',
  bodyText: '#e5e7eb',
  secondaryText: '#9ca3af',
  mutedText: '#6b7280',
  optionBg: 'rgba(255,255,255,0.04)',
  optionBgHover: 'rgba(56,189,248,0.10)',
  optionBgSelected: 'rgba(56,189,248,0.18)',
  optionBorder: '1px solid rgba(255,255,255,0.08)',
  optionBorderSelected: '1px solid rgba(56,189,248,0.5)',
  optionDimOpacity: 0.45,
  primaryBadgeText: '#7dd3fc',
  primaryBadgeBg: 'rgba(56,189,248,0.12)',
  primaryBadgeBorder: '1px solid rgba(56,189,248,0.25)',
  memoryBadgeText: '#fbbf24',
  memoryBadgeBg: 'rgba(245,158,11,0.12)',
  memoryBadgeBorder: '1px solid rgba(245,158,11,0.35)',
  nextBtnBg: 'rgba(56,189,248,0.15)',
  nextBtnBorder: '1px solid rgba(56,189,248,0.45)',
  nextBtnText: '#7dd3fc',
  cancelText: '#6b7280',
  inputBg: 'rgba(255,255,255,0.04)',
  inputBorder: '1px solid rgba(255,255,255,0.08)',
  inputText: '#e5e7eb',
  numberCircleBg: 'rgba(56,189,248,0.12)',
  numberCircleBorder: '1px solid rgba(56,189,248,0.3)',
  numberCircleText: '#7dd3fc',
};

export function QuestionCard({ batch, onSubmit, onCancel }: QuestionCardProps) {
  const { questions, routeConfirmation } = batch;
  // Build the full question list: route confirmation first (if present), then questions
  const allQuestions: (Question & { isRoute?: boolean })[] = [];
  if (routeConfirmation) {
    allQuestions.push({
      id: '__route__',
      text: routeConfirmation.question,
      type: 'confirm',
      options: [
        { label: `Yes — use ${routeConfirmation.route}`, value: `route_accept:${routeConfirmation.service}`, primary: true },
        { label: 'Use a different route', value: `route_reject:${routeConfirmation.service}` },
      ],
      freeText: false,
      isRoute: true,
    });
  }
  allQuestions.push(...questions);

  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [otherText, setOtherText] = useState('');
  const [showOther, setShowOther] = useState(false);

  const currentQ = allQuestions[currentIdx];
  const isLast = currentIdx === allQuestions.length - 1;
  const hasAnswer = answers[currentQ?.id] !== undefined;

  const _selectOption = (qid: string, value: string) => {
    setAnswers(prev => ({ ...prev, [qid]: value }));
    setShowOther(false);
    setOtherText('');
  };

  const _submitOther = (qid: string) => {
    if (otherText.trim()) {
      setAnswers(prev => ({ ...prev, [qid]: otherText.trim() }));
      setShowOther(false);
      setOtherText('');
    }
  };

  const _handleNext = () => {
    if (isLast) {
      onSubmit(answers);
    } else {
      setCurrentIdx(idx => idx + 1);
      setShowOther(false);
      setOtherText('');
    }
  };

  const _handleCancel = () => {
    onCancel();
  };

  if (!currentQ) return null;

  return (
    <div style={{
      padding: '14px 16px',
      borderRadius: 10,
      backgroundColor: COLORS.cardBg,
      border: COLORS.cardBorder,
    }}>
      {/* Header */}
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div style={{ color: COLORS.headerText, fontSize: '0.76rem', fontWeight: 600 }}>
          A few questions before I start
        </div>
        <div style={{ color: COLORS.mutedText, fontSize: '0.69rem' }}>
          {currentIdx + 1} of {allQuestions.length}
        </div>
      </div>

      {/* Route reason (if route confirmation) */}
      {currentQ.isRoute && routeConfirmation && (
        <div style={{
          color: COLORS.secondaryText,
          fontSize: '0.69rem',
          lineHeight: 1.4,
          marginBottom: 10,
          fontStyle: 'italic',
        }}>
          {routeConfirmation.reason}
        </div>
      )}

      {/* Question text */}
      <div style={{
        color: COLORS.bodyText,
        fontSize: '0.82rem',
        lineHeight: 1.4,
        marginBottom: 12,
      }}>
        {currentQ.text}
      </div>

      {/* Memory-resolved badge */}
      {currentQ.memoryResolved && (
        <div style={{
          display: 'inline-block',
          fontSize: '0.62rem',
          fontWeight: 700,
          padding: '2px 6px',
          borderRadius: 4,
          color: COLORS.memoryBadgeText,
          backgroundColor: COLORS.memoryBadgeBg,
          border: COLORS.memoryBadgeBorder,
          textTransform: 'uppercase',
          marginBottom: 10,
        }}>
          From your memory
        </div>
      )}

      {/* Options (for confirm/choice types) */}
      {(currentQ.type === 'confirm' || currentQ.type === 'choice') && currentQ.options && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {currentQ.options.map((opt, i) => {
            const selected = answers[currentQ.id] === opt.value;
            const dim = answers[currentQ.id] !== undefined && !selected;
            return (
              <button
                key={i}
                onClick={() => _selectOption(currentQ.id, opt.value)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 10px',
                  borderRadius: 8,
                  cursor: selected ? 'default' : 'pointer',
                  backgroundColor: selected ? COLORS.optionBgSelected : COLORS.optionBg,
                  border: selected ? COLORS.optionBorderSelected : COLORS.optionBorder,
                  textAlign: 'left',
                  transition: 'all 0.15s',
                  opacity: dim ? COLORS.optionDimOpacity : 1,
                }}
                onMouseEnter={e => { if (!selected) e.currentTarget.style.backgroundColor = COLORS.optionBgHover; }}
                onMouseLeave={e => { if (!selected) e.currentTarget.style.backgroundColor = COLORS.optionBg; }}
              >
                {/* Numbered circle */}
                <span style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  fontSize: '0.62rem',
                  fontWeight: 700,
                  flexShrink: 0,
                  color: COLORS.numberCircleText,
                  backgroundColor: COLORS.numberCircleBg,
                  border: COLORS.numberCircleBorder,
                }}>
                  {i + 1}
                </span>
                <span style={{ color: COLORS.bodyText, fontSize: '0.76rem', fontWeight: 600 }}>
                  {opt.label}
                </span>
                {opt.primary && (
                  <span style={{
                    marginLeft: 'auto',
                    fontSize: '0.62rem',
                    fontWeight: 700,
                    padding: '2px 6px',
                    borderRadius: 4,
                    color: COLORS.primaryBadgeText,
                    backgroundColor: COLORS.primaryBadgeBg,
                    border: COLORS.primaryBadgeBorder,
                    textTransform: 'uppercase',
                    flexShrink: 0,
                  }}>
                    Recommended
                  </span>
                )}
                {selected && (
                  <span style={{ marginLeft: 'auto', color: COLORS.primaryBadgeText, fontSize: '0.7rem', flexShrink: 0 }}>✓</span>
                )}
              </button>
            );
          })}

          {/* Free-text "Other" option */}
          {currentQ.freeText && (
            <div>
              {showOther ? (
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <input
                    type="text"
                    value={otherText}
                    onChange={e => setOtherText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') _submitOther(currentQ.id); }}
                    placeholder="Type your answer…"
                    autoFocus
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      borderRadius: 6,
                      fontSize: '0.74rem',
                      backgroundColor: COLORS.inputBg,
                      border: COLORS.inputBorder,
                      color: COLORS.inputText,
                      outline: 'none',
                    }}
                  />
                  <button
                    onClick={() => _submitOther(currentQ.id)}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 6,
                      fontSize: '0.72rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      backgroundColor: COLORS.nextBtnBg,
                      border: COLORS.nextBtnBorder,
                      color: COLORS.nextBtnText,
                    }}
                  >
                    OK
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowOther(true)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    borderRadius: 8,
                    cursor: 'pointer',
                    backgroundColor: COLORS.optionBg,
                    border: COLORS.optionBorder,
                    textAlign: 'left',
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.backgroundColor = COLORS.optionBgHover; }}
                  onMouseLeave={e => { e.currentTarget.style.backgroundColor = COLORS.optionBg; }}
                >
                  <span style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 18,
                    height: 18,
                    borderRadius: '50%',
                    fontSize: '0.62rem',
                    fontWeight: 700,
                    flexShrink: 0,
                    color: COLORS.mutedText,
                    backgroundColor: 'rgba(107,114,128,0.1)',
                    border: '1px solid rgba(107,114,128,0.2)',
                  }}>
                    ✎
                  </span>
                  <span style={{ color: COLORS.mutedText, fontSize: '0.76rem', fontWeight: 500 }}>
                    Other (type your own)
                  </span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Text-only question (no options) */}
      {currentQ.type === 'text' && (
        <div style={{ marginBottom: 8 }}>
          <input
            type="text"
            value={answers[currentQ.id] || otherText}
            onChange={e => {
              setOtherText(e.target.value);
              setAnswers(prev => ({ ...prev, [currentQ.id]: e.target.value }));
            }}
            onKeyDown={e => { if (e.key === 'Enter' && hasAnswer) _handleNext(); }}
            placeholder="Type your answer…"
            autoFocus
            style={{
              width: '100%',
              padding: '7px 10px',
              borderRadius: 6,
              fontSize: '0.76rem',
              backgroundColor: COLORS.inputBg,
              border: COLORS.inputBorder,
              color: COLORS.inputText,
              outline: 'none',
            }}
          />
        </div>
      )}

      {/* Footer: Next / Cancel */}
      <div className="flex items-center justify-between" style={{ marginTop: 10 }}>
        <button
          onClick={_handleCancel}
          style={{
            background: 'transparent',
            border: 'none',
            color: COLORS.cancelText,
            fontSize: '0.69rem',
            cursor: 'pointer',
            padding: '4px 8px',
          }}
        >
          Cancel
        </button>
        <button
          onClick={_handleNext}
          disabled={!hasAnswer}
          style={{
            padding: '7px 16px',
            borderRadius: 6,
            fontSize: '0.74rem',
            fontWeight: 600,
            cursor: hasAnswer ? 'pointer' : 'not-allowed',
            backgroundColor: hasAnswer ? COLORS.nextBtnBg : 'rgba(255,255,255,0.02)',
            border: hasAnswer ? COLORS.nextBtnBorder : '1px solid rgba(255,255,255,0.05)',
            color: hasAnswer ? COLORS.nextBtnText : COLORS.mutedText,
            opacity: hasAnswer ? 1 : 0.5,
          }}
        >
          {isLast ? 'Start task →' : 'Next →'}
        </button>
      </div>
    </div>
  );
}

// ── PartialFailureCard ─────────────────────────────────────────────────────
// Renders a partial-completion summary with completed/remaining lists and
// three action buttons: "Try to finish" (plan extension), "Train me with a
// recipe", and "Other" (free text). Replaces the generic ask_user failure
// banner when partialProgress is available.
export function PartialFailureCard({ partialFailure, options, onSubmit, onCancel }: PartialFailureCardProps) {
  const { summary, completed, remaining, currentUrl } = partialFailure;
  const [otherText, setOtherText] = useState('');
  const [showOther, setShowOther] = useState(false);

  const _handleOption = (value: string) => onSubmit(value);
  const _submitOther = () => {
    if (otherText.trim()) {
      onSubmit(otherText.trim());
      setShowOther(false);
      setOtherText('');
    }
  };

  return (
    <div style={{
      padding: '14px 16px',
      borderRadius: 10,
      backgroundColor: 'rgba(245,158,11,0.06)',
      border: '1px solid rgba(245,158,11,0.28)',
    }}>
      {/* Header */}
      <div className="flex items-center gap-2" style={{ marginBottom: 10 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <div style={{ color: '#fbbf24', fontSize: '0.76rem', fontWeight: 600 }}>
          Partial completion — I need your help to finish
        </div>
      </div>

      {/* Summary paragraph */}
      {summary && (
        <div style={{
          color: COLORS.bodyText,
          fontSize: '0.8rem',
          lineHeight: 1.5,
          marginBottom: 12,
        }}>
          {summary}
        </div>
      )}

      {/* Completed / Remaining lists */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
        {completed.length > 0 && (
          <div>
            <div style={{ color: '#34d399', fontSize: '0.69rem', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>
              ✅ Completed
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, listStyleType: '✓' }}>
              {completed.map((item, i) => (
                <li key={i} style={{ color: COLORS.bodyText, fontSize: '0.76rem', lineHeight: 1.4, marginBottom: 2 }}>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
        {remaining.length > 0 && (
          <div>
            <div style={{ color: '#fbbf24', fontSize: '0.69rem', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>
              ⚠️ Still needs to be done
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, listStyleType: '•' }}>
              {remaining.map((item, i) => (
                <li key={i} style={{ color: COLORS.bodyText, fontSize: '0.76rem', lineHeight: 1.4, marginBottom: 2 }}>
                  {item}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Current URL (if available) */}
      {currentUrl && (
        <div style={{
          color: COLORS.mutedText,
          fontSize: '0.66rem',
          marginBottom: 10,
          fontFamily: 'monospace',
          wordBreak: 'break-all',
        }}>
          Current page: {currentUrl}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
        {options.map((opt, i) => {
          const isPrimary = opt.primary;
          return (
            <button
              key={i}
              onClick={() => _handleOption(opt.value)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 12px',
                borderRadius: 8,
                cursor: 'pointer',
                backgroundColor: isPrimary ? 'rgba(56,189,248,0.15)' : COLORS.optionBg,
                border: isPrimary ? COLORS.nextBtnBorder : COLORS.optionBorder,
                textAlign: 'left',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = isPrimary ? 'rgba(56,189,248,0.25)' : COLORS.optionBgHover; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = isPrimary ? 'rgba(56,189,248,0.15)' : COLORS.optionBg; }}
            >
              <span style={{
                color: isPrimary ? COLORS.nextBtnText : COLORS.bodyText,
                fontSize: '0.78rem',
                fontWeight: 600,
              }}>
                {opt.label}
              </span>
              {isPrimary && (
                <span style={{
                  marginLeft: 'auto',
                  fontSize: '0.62rem',
                  fontWeight: 700,
                  padding: '2px 6px',
                  borderRadius: 4,
                  color: COLORS.primaryBadgeText,
                  backgroundColor: COLORS.primaryBadgeBg,
                  border: COLORS.primaryBadgeBorder,
                  textTransform: 'uppercase',
                  flexShrink: 0,
                }}>
                  Recommended
                </span>
              )}
            </button>
          );
        })}

        {/* Free-text "Other" option */}
        <div>
          {showOther ? (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input
                type="text"
                value={otherText}
                onChange={e => setOtherText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') _submitOther(); }}
                placeholder="Type your answer…"
                autoFocus
                style={{
                  flex: 1,
                  padding: '6px 10px',
                  borderRadius: 6,
                  fontSize: '0.74rem',
                  backgroundColor: COLORS.inputBg,
                  border: COLORS.inputBorder,
                  color: COLORS.inputText,
                  outline: 'none',
                }}
              />
              <button
                onClick={_submitOther}
                style={{
                  padding: '6px 12px',
                  borderRadius: 6,
                  fontSize: '0.72rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  backgroundColor: COLORS.nextBtnBg,
                  border: COLORS.nextBtnBorder,
                  color: COLORS.nextBtnText,
                }}
              >
                OK
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowOther(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px',
                borderRadius: 8,
                cursor: 'pointer',
                backgroundColor: COLORS.optionBg,
                border: COLORS.optionBorder,
                textAlign: 'left',
                transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = COLORS.optionBgHover; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = COLORS.optionBg; }}
            >
              <span style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 18,
                height: 18,
                borderRadius: '50%',
                fontSize: '0.62rem',
                fontWeight: 700,
                flexShrink: 0,
                color: COLORS.mutedText,
                backgroundColor: 'rgba(107,114,128,0.1)',
                border: '1px solid rgba(107,114,128,0.2)',
              }}>
                ✎
              </span>
              <span style={{ color: COLORS.mutedText, fontSize: '0.76rem', fontWeight: 500 }}>
                Other (type your own)
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Footer: Cancel */}
      <div className="flex items-center justify-end" style={{ marginTop: 8 }}>
        <button
          onClick={onCancel}
          style={{
            background: 'transparent',
            border: 'none',
            color: COLORS.cancelText,
            fontSize: '0.69rem',
            cursor: 'pointer',
            padding: '4px 8px',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default QuestionCard;
