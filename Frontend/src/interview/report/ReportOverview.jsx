/**
 * ReportOverview.jsx
 *
 * Displays the main report overview with candidate info, scores, and status badges.
 */
import './ReportOverview.css';

export default function ReportOverview({ report, room }) {
  if (!report) return null;

  const {
    interviewId,
    candidateName,
    jobTitle,
    duration,
    durationSeconds,
    generatedAt,
    overallScore,
    technicalScore,
    hrScore,
    integrityScore,
    humanReviewRequired,
    finalRecommendation,
    polish,
  } = report;

  // Get technical evaluation score
  const technicalEvalScore = report.technicalEvaluation?.score;

  // Get HR evaluation score
  const hrEvalScore = report.hrEvaluation?.score;

  // Determine recommendation status
  const getRecommendationStatus = () => {
    if (!finalRecommendation) return null;

    const status = finalRecommendation.status ||
                   (typeof finalRecommendation === 'string' ? finalRecommendation : null);

    if (!status) return null;

    const statusLower = String(status).toLowerCase();

    if (statusLower.includes('accept') || statusLower.includes('pass') || statusLower.includes('proceed')) {
      return { label: 'Proceed', className: 'rec-badge--success' };
    }
    if (statusLower.includes('reject') || statusLower.includes('fail')) {
      return { label: 'Do Not Proceed', className: 'rec-badge--danger' };
    }
    if (statusLower.includes('review')) {
      return { label: 'Review Required', className: 'rec-badge--warning' };
    }

    return { label: status, className: 'rec-badge--neutral' };
  };

  const recStatus = getRecommendationStatus();

  // Polish status
  const getPolishStatus = () => {
    if (!polish) {
      return { label: 'Polish Skipped', className: 'polish-badge--skipped' };
    }

    if (!polish.enabled) {
      return { label: 'Polish Disabled', className: 'polish-badge--skipped' };
    }

    if (polish.success === false) {
      return { label: 'Polish Failed', className: 'polish-badge--failed' };
    }

    if (polish.success === true) {
      return { label: 'Polish Applied', className: 'polish-badge--success' };
    }

    return { label: 'Polish Pending', className: 'polish-badge--neutral' };
  };

  const polishStatus = getPolishStatus();

  const formatDuration = () => {
    if (duration) return duration;
    if (durationSeconds) {
      const mins = Math.floor(durationSeconds / 60);
      const secs = Math.round(durationSeconds % 60);
      return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
    return 'N/A';
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return 'N/A';
    try {
      return new Date(dateStr).toLocaleString();
    } catch {
      return dateStr;
    }
  };

  return (
    <div className="report-overview">
      {/* Header with badges */}
      <div className="report-overview__header">
        <h2 className="report-overview__title">Interview Report</h2>
        <div className="report-overview__badges">
          {recStatus && (
            <span className={`rec-badge ${recStatus.className}`}>
              {recStatus.label}
            </span>
          )}
          <span className={`polish-badge ${polishStatus.className}`}>
            {polishStatus.label}
          </span>
          {humanReviewRequired && (
            <span className="review-badge">👁️ Human Review Required</span>
          )}
        </div>
      </div>

      {/* Candidate info card */}
      <div className="report-overview__info-card">
        <div className="info-grid">
          <div className="info-item">
            <span className="info-item__label">Candidate</span>
            <span className="info-item__value">
              {candidateName || room?.candidate?.email || 'Unknown'}
            </span>
          </div>
          <div className="info-item">
            <span className="info-item__label">Position</span>
            <span className="info-item__value">{jobTitle || room?.jobTitle || 'N/A'}</span>
          </div>
          <div className="info-item">
            <span className="info-item__label">Interview ID</span>
            <span className="info-item__value info-item__value--mono">{interviewId || 'N/A'}</span>
          </div>
          <div className="info-item">
            <span className="info-item__label">Duration</span>
            <span className="info-item__value">{formatDuration()}</span>
          </div>
          <div className="info-item">
            <span className="info-item__label">Generated</span>
            <span className="info-item__value">{formatDate(generatedAt)}</span>
          </div>
        </div>
      </div>

      {/* Scores grid */}
      <div className="report-overview__scores">
        <h3 className="scores-title">Scores</h3>
        <div className="scores-grid">
          <div className="score-card score-card--overall">
            <span className="score-card__label">Overall</span>
            <span className="score-card__value">
              {overallScore ?? technicalEvalScore ?? hrEvalScore ?? '–'}
            </span>
            <span className="score-card__max">/ 100</span>
          </div>

          <div className="score-card score-card--technical">
            <span className="score-card__label">Technical</span>
            <span className="score-card__value">{technicalScore ?? technicalEvalScore ?? '–'}</span>
            <span className="score-card__max">/ 100</span>
          </div>

          <div className="score-card score-card--hr">
            <span className="score-card__label">HR</span>
            <span className={`score-card__value ${(hrScore ?? hrEvalScore) == null ? 'score-card__value--text' : ''}`}>
              {hrScore ?? hrEvalScore ?? 'Not enough evidence'}
            </span>
            {(hrScore ?? hrEvalScore) != null && <span className="score-card__max">/ 100</span>}
          </div>

          <div className="score-card score-card--integrity">
            <span className="score-card__label">Integrity</span>
            <span className="score-card__value">{integrityScore ?? '–'}</span>
            <span className="score-card__max">/ 100</span>
          </div>
        </div>
      </div>

      {/* Deterministic source note */}
      <div className="report-overview__source-note">
        <span className="source-note__icon">🛡️</span>
        <p className="source-note__text">
          <strong>Deterministic Source of Truth:</strong> Scores and integrity metrics are
          calculated using deterministic rules. LLM polish only improves wording and
          does not change the measured values.
          {polish?.nonDestructive && (
            <span className="source-note__verified"> ✓ Non-destructive polish verified</span>
          )}
        </p>
      </div>

      {/* Polish metadata (if available) */}
      {polish && polish.enabled && (
        <div className="report-overview__polish-meta">
          <h4 className="polish-meta__title">LLM Polish Metadata</h4>
          <div className="polish-meta__grid">
            <div className="polish-meta__item">
              <span className="polish-meta__label">Provider</span>
              <span className="polish-meta__value">{polish.provider || 'N/A'}</span>
            </div>
            <div className="polish-meta__item">
              <span className="polish-meta__label">Model</span>
              <span className="polish-meta__value">{polish.model || 'N/A'}</span>
            </div>
            <div className="polish-meta__item">
              <span className="polish-meta__label">Status</span>
              <span className={`polish-meta__value polish-meta__value--${polish.success ? 'success' : 'failed'}`}>
                {polish.success ? 'Success' : 'Failed'}
              </span>
            </div>
            <div className="polish-meta__item">
              <span className="polish-meta__label">Non-Destructive</span>
              <span className={`polish-meta__value polish-meta__value--${polish.nonDestructive ? 'success' : 'neutral'}`}>
                {polish.nonDestructive ? 'Yes ✓' : 'No'}
              </span>
            </div>
          </div>
          {polish.success === false && polish.error && (
            <p className="polish-meta__error">
              ⚠️ {polish.error}. The deterministic report is still available.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
