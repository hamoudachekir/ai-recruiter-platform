/**
 * QuestionEvaluationPanel.jsx
 *
 * Shows each AI question and candidate answer with:
 * - Score (0-100)
 * - Answer quality badge
 * - Sentiment badge
 * - Skills mentioned
 * - Strengths / weaknesses
 * - Recruiter follow-up suggestion
 *
 * If Q&A is unavailable, shows a clear unavailability message.
 */
import { useState } from 'react';
import './QuestionEvaluationPanel.css';

// ── Badge helpers ────────────────────────────────────────────────────────────

function QualityBadge({ quality }) {
  const map = {
    strong:       { label: 'Strong Answer',  cls: 'qep-badge--strong' },
    acceptable:   { label: 'Acceptable',     cls: 'qep-badge--acceptable' },
    weak:         { label: 'Weak',           cls: 'qep-badge--weak' },
    insufficient: { label: 'Insufficient',   cls: 'qep-badge--insufficient' },
  };
  const cfg = map[quality] || map.acceptable;
  return <span className={`qep-badge ${cfg.cls}`}>{cfg.label}</span>;
}

function SentimentBadge({ sentiment }) {
  const map = {
    positive: { label: '😊 Positive', cls: 'qep-badge--positive' },
    neutral:  { label: '😐 Neutral',  cls: 'qep-badge--neutral' },
    negative: { label: '😟 Cautious', cls: 'qep-badge--negative' },
  };
  const cfg = map[sentiment] || map.neutral;
  return <span className={`qep-badge ${cfg.cls}`}>{cfg.label}</span>;
}

function CategoryChip({ category }) {
  return <span className="qep-category-chip">{category}</span>;
}

function ScoreBar({ score }) {
  const pct = Math.max(0, Math.min(100, score || 0));
  const color =
    pct >= 75 ? '#22c55e' :
    pct >= 50 ? '#f59e0b' :
    '#ef4444';
  return (
    <div className="qep-score-bar">
      <div className="qep-score-bar__fill" style={{ width: `${pct}%`, background: color }} />
      <span className="qep-score-bar__label">{pct}/100</span>
    </div>
  );
}

// ── Single question card ─────────────────────────────────────────────────────

function QuestionCard({ item, index }) {
  const [open, setOpen] = useState(false);
  const hasAnswer = item.answer && item.answer.trim().length > 0;

  return (
    <div className={`qep-card ${open ? 'qep-card--open' : ''}`}>
      <button
        className="qep-card__header"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <div className="qep-card__header-left">
          <span className="qep-card__qnum">Q{index + 1}</span>
          <CategoryChip category={item.category || 'general'} />
          <QualityBadge quality={item.answerQuality} />
          {item.sentiment && <SentimentBadge sentiment={item.sentiment} />}
        </div>
        <div className="qep-card__header-right">
          <span className="qep-card__score">{item.score ?? '–'}/100</span>
          <span className="qep-card__chevron">{open ? '▲' : '▼'}</span>
        </div>
      </button>

      {open && (
        <div className="qep-card__body">
          {/* Question */}
          <div className="qep-block">
            <span className="qep-block__label">❓ Question</span>
            <p className="qep-block__text">{item.question || 'N/A'}</p>
          </div>

          {/* Score bar */}
          <div className="qep-block">
            <span className="qep-block__label">📊 Score</span>
            <ScoreBar score={item.score} />
            <span className="qep-block__sub">
              Confidence: <strong>{item.confidence || '–'}</strong>
              {item.wordCount != null && ` · ${item.wordCount} words`}
            </span>
          </div>

          {/* Candidate Answer */}
          <div className="qep-block">
            <span className="qep-block__label">💬 Candidate Answer</span>
            {hasAnswer
              ? <p className="qep-block__text qep-block__text--answer">{item.answer}</p>
              : <p className="qep-block__text qep-block__text--empty">No answer recorded.</p>
            }
          </div>

          {/* Skills mentioned */}
          {Array.isArray(item.skillsMentioned) && item.skillsMentioned.length > 0 && (
            <div className="qep-block">
              <span className="qep-block__label">🔧 Skills Mentioned</span>
              <div className="qep-chips">
                {item.skillsMentioned.map(s => (
                  <span key={s} className="qep-chip qep-chip--skill">{s}</span>
                ))}
              </div>
            </div>
          )}

          {/* Strengths & weaknesses */}
          <div className="qep-two-col">
            {Array.isArray(item.strengths) && item.strengths.length > 0 && (
              <div className="qep-col qep-col--green">
                <span className="qep-block__label">✅ Strengths</span>
                <ul className="qep-list">
                  {item.strengths.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              </div>
            )}
            {Array.isArray(item.weaknesses) && item.weaknesses.length > 0 && (
              <div className="qep-col qep-col--amber">
                <span className="qep-block__label">⚠️ Areas to Improve</span>
                <ul className="qep-list">
                  {item.weaknesses.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}
          </div>

          {/* Sentiment explanation */}
          {item.sentimentExplanation && (
            <div className="qep-block">
              <span className="qep-block__label">🎭 Sentiment Note</span>
              <p className="qep-block__text qep-block__text--note">{item.sentimentExplanation}</p>
            </div>
          )}

          {/* Follow-up suggestion */}
          {item.recommendedFollowUp && (
            <div className="qep-block qep-block--followup">
              <span className="qep-block__label">💡 Recruiter Follow-up Suggestion</span>
              <p className="qep-block__text qep-block__text--followup">
                "{item.recommendedFollowUp}"
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────────────

export default function QuestionEvaluationPanel({ report }) {
  if (!report) return null;

  const qna = report.interviewQna || {};
  const rawEvaluations = report.questionEvaluations || [];

  // Drop phantom duplicates: an unanswered question whose identical text is
  // answered by another entry (e.g. the agent's greeting re-sent before the
  // candidate replied → a "No answer recorded" Q1 plus the answered Q2).
  const normQ = (t) =>
    String(t || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 160);
  const answeredQuestions = new Set(
    rawEvaluations
      .filter((e) => String(e.answer || "").trim())
      .map((e) => normQ(e.question || e.questionText)),
  );
  const evaluations = rawEvaluations.filter((e) => {
    if (String(e.answer || "").trim()) return true;
    return !answeredQuestions.has(normQ(e.question || e.questionText));
  });

  // Q&A unavailable
  if (!qna.available && evaluations.length === 0) {
    return (
      <section className="qep-root">
        <div className="qep-header">
          <p className="qep-eyebrow">Interview Q&amp;A Evaluation</p>
          <h3 className="qep-title">Question-by-Question Evaluation</h3>
        </div>
        <div className="qep-unavailable">
          <span className="qep-unavailable__icon">📭</span>
          <p className="qep-unavailable__text">
            Question-by-question evaluation unavailable because{' '}
            {qna.note || 'interview Q&A transcript is missing or was not captured.'}
          </p>
          {qna.sttWordCount > 0 && (
            <p className="qep-unavailable__sub">
              STT transcript has {qna.sttWordCount} words but no speaker-role labels.
            </p>
          )}
        </div>
      </section>
    );
  }

  const answeredCount = qna.answeredCount ?? evaluations.filter(e => e.answer).length;
  const avgScore = evaluations.length > 0
    ? Math.round(evaluations.reduce((s, e) => s + (e.score || 0), 0) / evaluations.length)
    : null;

  return (
    <section className="qep-root">
      <div className="qep-header">
        <div>
          <p className="qep-eyebrow">Interview Q&amp;A Evaluation</p>
          <h3 className="qep-title">Question-by-Question Evaluation</h3>
        </div>
        <div className="qep-stats">
          <div className="qep-stat">
            <span className="qep-stat__value">{evaluations.length}</span>
            <span className="qep-stat__label">Questions</span>
          </div>
          <div className="qep-stat">
            <span className="qep-stat__value">{answeredCount}</span>
            <span className="qep-stat__label">Answered</span>
          </div>
          {avgScore !== null && (
            <div className="qep-stat">
              <span className="qep-stat__value">{avgScore}</span>
              <span className="qep-stat__label">Avg Score</span>
            </div>
          )}
          <div className="qep-stat qep-stat--source">
            <span className="qep-stat__label">
              Source: <strong>{qna.source || 'stored_conversation'}</strong>
            </span>
          </div>
        </div>
      </div>

      <div className="qep-list-root">
        {evaluations.map((item, idx) => (
          <QuestionCard key={item.questionId || idx} item={item} index={idx} />
        ))}
      </div>
    </section>
  );
}
