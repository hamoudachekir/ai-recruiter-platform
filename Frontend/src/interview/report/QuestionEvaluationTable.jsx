/**
 * QuestionEvaluationTable.jsx
 *
 * Renders each Q&A pair with score, quality badge, AI feedback, and skill chips.
 */
import { useState } from 'react';
import './QuestionEvaluationTable.css';

const QUALITY_CONFIG = {
  good:    { label: 'Good',    className: 'qet-quality--good' },
  average: { label: 'Average', className: 'qet-quality--average' },
  weak:    { label: 'Weak',    className: 'qet-quality--weak' },
};

function ScoreDots({ score, max = 10 }) {
  return (
    <div className="qet-dots">
      {Array.from({ length: max }).map((_, i) => (
        <span key={i} className={`qet-dot ${i < score ? 'qet-dot--filled' : ''}`} />
      ))}
    </div>
  );
}

export default function QuestionEvaluationTable({ evaluations }) {
  const [expanded, setExpanded] = useState(null);

  if (!Array.isArray(evaluations) || evaluations.length === 0) {
    return (
      <div className="qet-empty">
        <p>No question evaluations available. This may be because the interview transcript was not captured.</p>
      </div>
    );
  }

  return (
    <div className="qet-root" id="question-evaluation-table">
      {evaluations.map((item, idx) => {
        const isOpen = expanded === idx;
        const qConfig = QUALITY_CONFIG[item.answerQuality] || QUALITY_CONFIG.average;

        return (
          <div
            key={item.questionId || idx}
            className={`qet-row ${isOpen ? 'qet-row--open' : ''}`}
          >
            {/* ── Row header ── */}
            <button
              className="qet-row-header"
              onClick={() => setExpanded(isOpen ? null : idx)}
              aria-expanded={isOpen}
            >
              <div className="qet-row-left">
                <span className="qet-qid">{item.questionId}</span>
                <span className="qet-category">{item.category}</span>
                <span className={`qet-quality ${qConfig.className}`}>{qConfig.label}</span>
              </div>
              <div className="qet-row-right">
                <ScoreDots score={item.score} />
                <span className="qet-score-label">{item.score}/10</span>
                <span className="qet-chevron">{isOpen ? '▲' : '▼'}</span>
              </div>
            </button>

            {/* ── Expanded content ── */}
            {isOpen && (
              <div className="qet-detail">
                <div className="qet-block">
                  <span className="qet-block-label">Question</span>
                  <p className="qet-block-text">{item.question || 'N/A'}</p>
                </div>
                <div className="qet-block">
                  <span className="qet-block-label">Candidate Answer</span>
                  <p className="qet-block-text qet-answer">{item.answer || 'No answer recorded.'}</p>
                </div>
                <div className="qet-block">
                  <span className="qet-block-label">AI Feedback</span>
                  <p className="qet-block-text qet-feedback">{item.feedback || '–'}</p>
                </div>
                {Array.isArray(item.detectedSkills) && item.detectedSkills.length > 0 && (
                  <div className="qet-block">
                    <span className="qet-block-label">Detected Skills</span>
                    <div className="qet-chips">
                      {item.detectedSkills.map(skill => (
                        <span key={skill} className="qet-chip">{skill}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
