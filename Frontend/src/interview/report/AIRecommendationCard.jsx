/**
 * AIRecommendationCard.jsx
 *
 * Displays the final AI recommendation (Recommended / Needs Review / Not Recommended)
 * with the overall score and a clear disclaimer that the recruiter decides.
 */
import './AIRecommendationCard.css';

const STATUS_CONFIG = {
  recommended: {
    label: 'Recommended',
    icon: '✅',
    colorClass: 'arc--recommended',
    hint: 'Candidate met the evaluation thresholds. Recruiter review still required.',
  },
  needs_review: {
    label: 'Needs Review',
    icon: '🔍',
    colorClass: 'arc--needs-review',
    hint: 'Some areas or signals require recruiter review before any decision.',
  },
  not_recommended: {
    label: 'Not Recommended',
    icon: '⚠️',
    colorClass: 'arc--not-recommended',
    hint: 'Multiple areas were below threshold. Review the full report before any decision.',
  },
};

export default function AIRecommendationCard({ recommendation, candidateInfo }) {
  if (!recommendation) return null;

  const { status = 'needs_review', overallScore = 0, summary = '', nextStep = '' } = recommendation;
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.needs_review;

  const scoreColor = overallScore >= 75
    ? '#86efac'
    : overallScore >= 50
      ? '#fcd34d'
      : '#fca5a5';

  return (
    <div className={`arc-card ${config.colorClass}`} id="arc-card">
      <div className="arc-card-top">
        <div className="arc-icon-wrap">
          <span className="arc-icon">{config.icon}</span>
        </div>

        <div className="arc-body">
          <div className="arc-label-row">
            <span className="arc-status-label">{config.label}</span>
            <span className="arc-hint">{config.hint}</span>
          </div>
          <p className="arc-summary">{summary}</p>
          {nextStep && (
            <div className="arc-next-step">
              <strong>Next Step:</strong> {nextStep}
            </div>
          )}
        </div>

        <div className="arc-score-wrap">
          <svg className="arc-gauge" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="32" stroke="rgba(255,255,255,0.07)" strokeWidth="8" fill="none" />
            <circle
              cx="40" cy="40" r="32"
              stroke={scoreColor}
              strokeWidth="8"
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${2 * Math.PI * 32}`}
              strokeDashoffset={`${2 * Math.PI * 32 * (1 - overallScore / 100)}`}
              transform="rotate(-90 40 40)"
              style={{ transition: 'stroke-dashoffset 1s ease' }}
            />
          </svg>
          <div className="arc-score-center">
            <span className="arc-score-num" style={{ color: scoreColor }}>{overallScore}</span>
            <span className="arc-score-denom">/100</span>
          </div>
        </div>
      </div>

      <div className="arc-disclaimer">
        🔒 AI signals are for review assistance only. The recruiter is the sole decision-maker.
        No candidate is automatically accepted or rejected by this system.
      </div>
    </div>
  );
}
