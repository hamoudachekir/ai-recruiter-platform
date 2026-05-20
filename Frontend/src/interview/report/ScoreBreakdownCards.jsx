/**
 * ScoreBreakdownCards.jsx
 *
 * Five score cards: Technical / Communication / Experience / Behavior / Integrity
 * with animated progress bars.
 */
import './ScoreBreakdownCards.css';

const SCORE_DEFS = [
  { key: 'technical', legacyKey: 'technicalScore', label: 'Technical', color: '#5b86e5' },
  { key: 'hr', legacyKey: 'hrScore', label: 'HR', color: '#36d1dc' },
  { key: 'integrity', legacyKey: 'integrityScore', label: 'Integrity', color: '#f59e0b' },
];

function ScoreBar({ value, max, color }) {
  if (value == null) return null;
  const pct = Math.round((value / max) * 100);
  return (
    <div className="sbc-bar-track">
      <div
        className="sbc-bar-fill"
        style={{ width: `${pct}%`, background: color }}
      />
    </div>
  );
}

export default function ScoreBreakdownCards({ scores }) {
  if (!scores) return <p className="sbc-empty">Score data not available.</p>;

  const total = scores.totalScore ?? null;

  return (
    <div className="sbc-root">
      <div className="sbc-total">
        <span className="sbc-total-label">Total Score</span>
        <span className="sbc-total-value">{total ?? 'Review'}</span>
        <span className="sbc-total-denom">/ 100</span>
      </div>

      <div className="sbc-grid">
        {SCORE_DEFS.map(def => {
          const detail = scores[def.key] || {};
          const value = detail.score ?? scores[def.legacyKey] ?? null;
          const pct = value == null ? null : Math.round(value);
          return (
            <div className="sbc-card" key={def.key} id={`sbc-${def.key}`}>
              <div className="sbc-card-header">
                <span className="sbc-label">{def.label}</span>
              </div>
              <div className="sbc-value-row">
                <span className={`sbc-value ${value == null ? 'sbc-value--text' : ''}`} style={{ color: def.color }}>
                  {value ?? 'Not enough evidence'}
                </span>
                {value != null && <span className="sbc-max">/ 100</span>}
              </div>
              <ScoreBar value={value} max={100} color={def.color} />
              {pct != null && <span className="sbc-pct">{pct}%</span>}
              <span className="sbc-source">{detail.source || (value == null ? 'unavailable' : 'deterministic')}</span>
              {detail.explanation && <p className="sbc-explanation">{detail.explanation}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
