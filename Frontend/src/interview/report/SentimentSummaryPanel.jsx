/**
 * SentimentSummaryPanel.jsx
 *
 * Shows overall sentiment across candidate answers.
 * Includes disclaimer that sentiment is NOT a hiring criterion.
 */
import './SentimentSummaryPanel.css';

const SENTIMENT_ICONS = {
  positive: '😊',
  neutral:  '😐',
  negative: '😟',
};

const SENTIMENT_LABELS = {
  positive: 'Positive',
  neutral:  'Neutral',
  negative: 'Cautious',
};

export default function SentimentSummaryPanel({ report }) {
  if (!report) return null;

  const data = report.answerSentimentSummary;
  if (!data) return null;

  const overall  = data.overallSentiment || 'neutral';
  const pos      = data.positiveAnswers ?? 0;
  const neu      = data.neutralAnswers ?? 0;
  const neg      = data.negativeAnswers ?? 0;
  const total    = data.totalAnswersAnalyzed ?? (pos + neu + neg);
  const notes    = data.notes || '';

  const barPct = (n) => total > 0 ? Math.round((n / total) * 100) : 0;

  return (
    <section className="ssp-root">
      <div className="ssp-header">
        <div>
          <p className="ssp-eyebrow">Sentiment Analysis</p>
          <h3 className="ssp-title">Answer Sentiment Summary</h3>
        </div>
        <div className="ssp-overall">
          <span className="ssp-overall__icon">{SENTIMENT_ICONS[overall]}</span>
          <span className="ssp-overall__label">{SENTIMENT_LABELS[overall] || 'Neutral'}</span>
        </div>
      </div>

      {/* Disclaimer */}
      <div className="ssp-disclaimer">
        ⚠️ Sentiment is a communication indicator only.
        It must <strong>not</strong> be used as a standalone hiring criterion.
      </div>

      {/* Bars */}
      {total > 0 && (
        <div className="ssp-bars">
          <div className="ssp-bar-row">
            <span className="ssp-bar-label">😊 Positive</span>
            <div className="ssp-bar-track">
              <div className="ssp-bar-fill ssp-bar-fill--pos" style={{ width: `${barPct(pos)}%` }} />
            </div>
            <span className="ssp-bar-count">{pos}</span>
          </div>
          <div className="ssp-bar-row">
            <span className="ssp-bar-label">😐 Neutral</span>
            <div className="ssp-bar-track">
              <div className="ssp-bar-fill ssp-bar-fill--neu" style={{ width: `${barPct(neu)}%` }} />
            </div>
            <span className="ssp-bar-count">{neu}</span>
          </div>
          <div className="ssp-bar-row">
            <span className="ssp-bar-label">😟 Cautious</span>
            <div className="ssp-bar-track">
              <div className="ssp-bar-fill ssp-bar-fill--neg" style={{ width: `${barPct(neg)}%` }} />
            </div>
            <span className="ssp-bar-count">{neg}</span>
          </div>
        </div>
      )}

      {/* Notes */}
      {notes && <p className="ssp-notes">{notes}</p>}
    </section>
  );
}
