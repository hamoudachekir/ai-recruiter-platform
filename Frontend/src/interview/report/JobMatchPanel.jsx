/**
 * JobMatchPanel.jsx
 *
 * Shows the full job match evaluation:
 * - Job title / company / location
 * - Match score and fit level
 * - Matched vs missing skills
 * - Responsibility coverage
 * - Language match
 * - Recruiter follow-up questions
 *
 * If job not linked, shows a clear message.
 */
import './JobMatchPanel.css';

function FitBadge({ fitLevel }) {
  const map = {
    strong:   { label: 'Strong Fit',   cls: 'jmp-badge--strong' },
    moderate: { label: 'Moderate Fit', cls: 'jmp-badge--moderate' },
    weak:     { label: 'Weak Fit',     cls: 'jmp-badge--weak' },
    unknown:  { label: 'Unknown',      cls: 'jmp-badge--unknown' },
  };
  const cfg = map[fitLevel] || map.unknown;
  return <span className={`jmp-badge ${cfg.cls}`}>{cfg.label}</span>;
}

function CoverageIcon({ status }) {
  if (status === 'covered')          return <span className="jmp-cov-icon jmp-cov-icon--covered">✓</span>;
  if (status === 'partially_covered') return <span className="jmp-cov-icon jmp-cov-icon--partial">~</span>;
  return <span className="jmp-cov-icon jmp-cov-icon--missing">✗</span>;
}

function ScoreRing({ score }) {
  if (score == null) {
    return (
      <div className="jmp-ring jmp-ring--unknown">
        <span className="jmp-ring__label">N/A</span>
      </div>
    );
  }
  const color = score >= 75 ? '#22c55e' : score >= 55 ? '#f59e0b' : '#ef4444';
  return (
    <div className="jmp-ring" style={{ '--ring-color': color }}>
      <span className="jmp-ring__value" style={{ color }}>{score}</span>
      <span className="jmp-ring__unit">/100</span>
    </div>
  );
}

export default function JobMatchPanel({ report }) {
  if (!report) return null;

  const jme = report.jobMatchEvaluation;
  const ctx = report.jobContext;

  // Job not linked
  if (!ctx || !ctx.linked) {
    return (
      <section className="jmp-root">
        <div className="jmp-header">
          <p className="jmp-eyebrow">Job Match</p>
          <h3 className="jmp-title">Job Match Evaluation</h3>
        </div>
        <div className="jmp-unavailable">
          <span className="jmp-unavailable__icon">💼</span>
          <p className="jmp-unavailable__text">
            Job matching unavailable because no job is linked to this interview.
          </p>
        </div>
      </section>
    );
  }

  const score        = jme?.score ?? null;
  const fitLevel     = jme?.fitLevel || 'unknown';
  const confidence   = jme?.confidence || 'low';
  const matched      = jme?.matchedSkills || [];
  const missing      = jme?.missingOrUnverifiedSkills || [];
  const matchedLangs = jme?.matchedLanguages || [];
  const missingLangs = jme?.missingOrUnverifiedLanguages || [];
  const coverage     = jme?.responsibilityCoverage || [];
  const followUps    = jme?.recruiterFollowUpQuestions || [];
  const summary      = jme?.summary || '';

  return (
    <section className="jmp-root">
      {/* Header */}
      <div className="jmp-header">
        <div>
          <p className="jmp-eyebrow">Job Match</p>
          <h3 className="jmp-title">Job Match Evaluation</h3>
        </div>
        <div className="jmp-header-right">
          <FitBadge fitLevel={fitLevel} />
          <span className="jmp-confidence">{confidence} confidence</span>
        </div>
      </div>

      {/* Job context */}
      <div className="jmp-job-info">
        <div className="jmp-job-info__row">
          <strong>{ctx.title}</strong>
          {ctx.companyName && <span className="jmp-job-info__company">@ {ctx.companyName}</span>}
        </div>
        {ctx.location && <div className="jmp-job-info__location">📍 {ctx.location}</div>}
        {ctx.salary && <div className="jmp-job-info__salary">💰 {ctx.salary}</div>}
      </div>

      {/* Score + summary */}
      <div className="jmp-score-row">
        <ScoreRing score={score} />
        <p className="jmp-summary">{summary}</p>
      </div>

      {/* Skills */}
      <div className="jmp-two-col">
        {matched.length > 0 && (
          <div className="jmp-skills-box jmp-skills-box--matched">
            <h4 className="jmp-box-title">✅ Matched Skills</h4>
            <div className="jmp-chips">
              {matched.map(s => (
                <span key={s} className="jmp-chip jmp-chip--matched">{s}</span>
              ))}
            </div>
          </div>
        )}
        {missing.length > 0 && (
          <div className="jmp-skills-box jmp-skills-box--missing">
            <h4 className="jmp-box-title">❌ Missing / Unverified</h4>
            <div className="jmp-chips">
              {missing.map(s => (
                <span key={s} className="jmp-chip jmp-chip--missing">{s}</span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Languages */}
      {(ctx.requiredLanguages || []).length > 0 && (
        <div className="jmp-section">
          <h4 className="jmp-section-title">🌐 Languages</h4>
          <div className="jmp-chips">
            {(ctx.requiredLanguages || []).map(lang => {
              const isMatched = matchedLangs.includes(lang);
              return (
                <span
                  key={lang}
                  className={`jmp-chip ${isMatched ? 'jmp-chip--matched' : 'jmp-chip--missing'}`}
                >
                  {lang}
                  {isMatched ? ' ✓' : ' ?'}
                </span>
              );
            })}
          </div>
          {missingLangs.length > 0 && (
            <p className="jmp-section-note">
              Language verification requires manual recruiter assessment.
            </p>
          )}
        </div>
      )}

      {/* Responsibility coverage */}
      {coverage.length > 0 && (
        <div className="jmp-section">
          <h4 className="jmp-section-title">📋 Responsibility Coverage</h4>
          <div className="jmp-coverage-list">
            {coverage.map((item, i) => (
              <div key={i} className="jmp-coverage-item">
                <CoverageIcon status={item.status} />
                <div className="jmp-coverage-text">
                  <p className="jmp-coverage-resp">{item.responsibility}</p>
                  {item.evidence && (
                    <p className="jmp-coverage-evidence">"{item.evidence}"</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recruiter follow-up questions */}
      {followUps.length > 0 && (
        <div className="jmp-section jmp-section--followup">
          <h4 className="jmp-section-title">💡 Recruiter Follow-up Questions</h4>
          <ol className="jmp-followup-list">
            {followUps.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
