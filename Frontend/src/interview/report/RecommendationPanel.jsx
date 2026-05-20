/**
 * RecommendationPanel.jsx
 *
 * Displays the final recommendation and next steps.
 */
import './RecommendationPanel.css';

export default function RecommendationPanel({ report }) {
  if (!report) return null;

  const { finalRecommendation, humanReviewRequired, ethicsNote } = report;

  // Handle both string and object formats
  const isStringRec = typeof finalRecommendation === 'string';

  const recText = isStringRec
    ? finalRecommendation
    : finalRecommendation?.summary || finalRecommendation?.text || '';

  const nextStep = isStringRec ? null : finalRecommendation?.nextStep;
  const status = isStringRec ? null : finalRecommendation?.status;

  // Determine recommendation type for styling
  const getRecType = () => {
    const statusLower = String(status || '').toLowerCase();
    if (statusLower.includes('review') || statusLower.includes('manual')) return 'neutral';
    const text = String(recText).toLowerCase();
    if (text.includes('accept') || text.includes('proceed') || text.includes('pass') || text.includes('recommend')) {
      return 'positive';
    }
    if (text.includes('reject') || text.includes('fail') || text.includes('decline')) {
      return 'negative';
    }
    return 'neutral';
  };

  const recType = getRecType();

  return (
    <div className="recommendation-panel">
      <h3 className="recommendation-panel__title">Final Recommendation</h3>

      <div className={`recommendation-card recommendation-card--${recType}`}>
        <div className="recommendation-card__header">
          <span className="recommendation-card__icon">
            {recType === 'positive' && '✓'}
            {recType === 'negative' && '✗'}
            {recType === 'neutral' && '⚠'}
          </span>
          <h4 className="recommendation-card__title">
            {recType === 'positive' && 'Proceed Recommendation'}
            {recType === 'negative' && 'Do Not Proceed'}
            {recType === 'neutral' && 'Review Required'}
          </h4>
        </div>

        <div className="recommendation-card__content">
          {recText ? (
            <p className="recommendation__text">{recText}</p>
          ) : (
            <p className="recommendation__empty">No recommendation available.</p>
          )}

          {nextStep && (
            <div className="recommendation__next-step">
              <h5 className="next-step__title">Next Step</h5>
              <p className="next-step__text">{nextStep}</p>
            </div>
          )}

          {status && (
            <div className="recommendation__status">
              <span className="status-label">Status:</span>
              <span className={`status-value status-value--${status.toLowerCase().replace(/\s+/g, '-')}`}>
                {status}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Human review warning */}
      {humanReviewRequired && (
        <div className="human-review-warning">
          <div className="human-review-warning__header">
            <span className="human-review-warning__icon">👁️</span>
            <h4 className="human-review-warning__title">Human Review Required</h4>
          </div>
          <p className="human-review-warning__text">
            This interview has flagged events that require recruiter review.
            Please examine the integrity alerts and vision monitoring data before making a final decision.
          </p>
        </div>
      )}

      {/* Ethics note */}
      {ethicsNote && (
        <div className="ethics-note">
          <span className="ethics-note__icon">⚖️</span>
          <p className="ethics-note__text">{ethicsNote}</p>
        </div>
      )}

    </div>
  );
}
