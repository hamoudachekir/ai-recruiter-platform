/**
 * FinalRecommendationPanel.jsx
 *
 * Shows the enhanced final recommendation based on Q&A, job match,
 * integrity signals, and report quality.
 *
 * Decisions: proceed | manual_review | technical_follow_up |
 *            insufficient_data | not_recommended
 */
import './FinalRecommendationPanel.css';

const DECISION_CONFIG = {
  proceed: {
    icon:  '✅',
    label: 'Proceed with Recruiter Review',
    cls:   'frp-card--proceed',
  },
  manual_review: {
    icon:  '🔍',
    label: 'Manual Review Required',
    cls:   'frp-card--review',
  },
  technical_follow_up: {
    icon:  '🔧',
    label: 'Technical Follow-up Recommended',
    cls:   'frp-card--followup',
  },
  insufficient_data: {
    icon:  '📭',
    label: 'Insufficient Data',
    cls:   'frp-card--insufficient',
  },
  not_recommended: {
    icon:  '❌',
    label: 'Not Recommended',
    cls:   'frp-card--not-recommended',
  },
};

export default function FinalRecommendationPanel({ report }) {
  if (!report) return null;

  const enhanced = report.enhancedRecommendation;
  const legacy   = report.finalRecommendation;

  // Prefer enhanced recommendation
  const decision  = enhanced?.decision || legacy?.status || 'manual_review';
  const label     = enhanced?.label || legacy?.label || 'Manual Review Required';
  const summary   = enhanced?.summary || legacy?.summary || '';
  const nextStep  = enhanced?.nextStep || legacy?.nextStep || '';
  const reasons   = enhanced?.reasons || [];

  const cfg = DECISION_CONFIG[decision] || DECISION_CONFIG.manual_review;

  return (
    <section className={`frp-card ${cfg.cls}`}>
      <div className="frp-top">
        <span className="frp-icon">{cfg.icon}</span>
        <div className="frp-top-text">
          <p className="frp-eyebrow">Final Recommendation</p>
          <h3 className="frp-title">{label}</h3>
        </div>
      </div>

      <p className="frp-summary">{summary}</p>

      {reasons.length > 0 && (
        <div className="frp-reasons">
          <p className="frp-reasons__label">Reasons:</p>
          <ul className="frp-reasons__list">
            {reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {nextStep && (
        <div className="frp-next-step">
          <span className="frp-next-step__label">Next Step</span>
          <p className="frp-next-step__text">{nextStep}</p>
        </div>
      )}

      <div className="frp-disclaimer">
        ⚠️ The AI does not automatically reject or accept any candidate.
        All hiring decisions are made by the recruiter.
      </div>
    </section>
  );
}
