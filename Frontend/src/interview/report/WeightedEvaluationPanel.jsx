/**
 * WeightedEvaluationPanel.jsx
 *
 * Renders the weighted evaluation produced from the job's configured
 * evaluation criteria (Step 7 of the Create Job wizard):
 *   - 4-tier hiring recommendation (Strong Hire / Hire / Maybe / No Hire)
 *   - weighted overall score
 *   - per-criterion breakdown with weight + score bars
 *
 * Hides itself when the interview produced no criteria breakdown.
 *
 * Props:
 *   data {object|null} report.weightedEvaluation
 */
import './WeightedEvaluationPanel.css';

const TIER_CLASS = {
  strong_hire: 'we-rec--strong',
  hire: 'we-rec--hire',
  maybe: 'we-rec--maybe',
  no_hire: 'we-rec--no',
};

function barClass(pct) {
  if (pct >= 75) return 'we-bar-fill--good';
  if (pct >= 50) return 'we-bar-fill--mid';
  return 'we-bar-fill--low';
}

export default function WeightedEvaluationPanel({ data }) {
  if (!data || !Array.isArray(data.criteria) || data.criteria.length === 0) {
    return null;
  }

  const rec = data.recommendation || {};
  const tier = String(rec.tier || 'maybe').toLowerCase();
  const overallPct = Math.round(Number(data.overallPct) || 0);

  return (
    <div className="we-panel">
      <div className="we-panel__head">
        <h3 className="we-panel__title">Weighted Evaluation</h3>
        <span className="we-panel__subtitle">
          Scored against this job&apos;s evaluation criteria
        </span>
      </div>

      {/* Hiring recommendation banner */}
      <div className={`we-rec ${TIER_CLASS[tier] || 'we-rec--maybe'}`}>
        <div className="we-rec__left">
          <span className="we-rec__label">{rec.label || 'Maybe'}</span>
          <span className="we-rec__summary">{rec.summary || ''}</span>
        </div>
        <div className="we-rec__score">
          <span className="we-rec__score-value">{overallPct}%</span>
          <span className="we-rec__score-caption">weighted score</span>
        </div>
      </div>

      {/* Per-criterion breakdown */}
      <div className="we-criteria">
        {data.criteria.map((c) => {
          const pct = Math.round(Number(c.scorePct) || 0);
          return (
            <div className="we-crit" key={c.name}>
              <div className="we-crit__row">
                <span className="we-crit__name">{c.name}</span>
                <span className="we-crit__weight">weight {Math.round(c.weight)}%</span>
                <span className="we-crit__score">{pct}%</span>
              </div>
              <div className="we-bar">
                <div className={`we-bar-fill ${barClass(pct)}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="we-crit__meta">
                {c.answers} answer{c.answers === 1 ? '' : 's'} · contributes {Number(c.weightedPoints).toFixed(1)} pts
              </div>
            </div>
          );
        })}
      </div>

      {(data.strengths?.length > 0 || data.concerns?.length > 0) && (
        <div className="we-notes">
          {data.strengths?.length > 0 && (
            <div className="we-notes__col">
              <span className="we-notes__title we-notes__title--good">Strengths</span>
              <ul>
                {data.strengths.map((s, i) => <li key={`s-${i}`}>{s}</li>)}
              </ul>
            </div>
          )}
          {data.concerns?.length > 0 && (
            <div className="we-notes__col">
              <span className="we-notes__title we-notes__title--bad">Areas to verify</span>
              <ul>
                {data.concerns.map((c, i) => <li key={`c-${i}`}>{c}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
