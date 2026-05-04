/**
 * ScoreBreakdownCards.jsx
 *
 * Five score cards: Technical / Communication / Experience / Behavior / Integrity
 * with animated progress bars.
 */
import './ScoreBreakdownCards.css';

const SCORE_DEFS = [
  { key: 'technicalScore',      label: 'Technical',      max: 40, icon: '🔧', color: '#5b86e5' },
  { key: 'communicationScore',  label: 'Communication',  max: 20, icon: '💬', color: '#36d1dc' },
  { key: 'experienceMatchScore',label: 'Experience Match',max: 20, icon: '📁', color: '#a78bfa' },
  { key: 'behaviorScore',       label: 'Behavior & Attention', max: 10, icon: '🎯', color: '#34d399' },
  { key: 'integrityScore',      label: 'Integrity',      max: 10, icon: '🔒', color: '#f59e0b' },
];

function ScoreBar({ value, max, color }) {
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

  const total = scores.totalScore ?? 0;

  return (
    <div className="sbc-root">
      <div className="sbc-total">
        <span className="sbc-total-label">Total Score</span>
        <span className="sbc-total-value">{total}</span>
        <span className="sbc-total-denom">/ 100</span>
      </div>

      <div className="sbc-grid">
        {SCORE_DEFS.map(def => {
          const value = scores[def.key] ?? 0;
          const pct = Math.round((value / def.max) * 100);
          return (
            <div className="sbc-card" key={def.key} id={`sbc-${def.key}`}>
              <div className="sbc-card-header">
                <span className="sbc-icon">{def.icon}</span>
                <span className="sbc-label">{def.label}</span>
              </div>
              <div className="sbc-value-row">
                <span className="sbc-value" style={{ color: def.color }}>{value}</span>
                <span className="sbc-max">/ {def.max}</span>
              </div>
              <ScoreBar value={value} max={def.max} color={def.color} />
              <span className="sbc-pct">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
