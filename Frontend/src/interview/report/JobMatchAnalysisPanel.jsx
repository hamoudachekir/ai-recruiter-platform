import './JobMatchAnalysisPanel.css';

export default function JobMatchAnalysisPanel({ report, job }) {
  if (!report) return null;

  const jobFit = report.jobFitAnalysis || {};
  const technical = report.technicalEvaluation || {};
  const hr = report.hrEvaluation || {};

  // Communication Fit: prefer the HR/communication evaluation score, but when
  // it's absent (e.g. no HR-phase score was computed) derive it from the
  // candidate's answered-question scores so it shows a real value instead of
  // "N/A". Both are on the same 0-100 scale as Technical Fit.
  const answeredEvals = (report.questionEvaluations || []).filter((e) =>
    String(e?.answer || e?.answerText || '').trim(),
  );
  const derivedComm = answeredEvals.length
    ? Math.round(
        answeredEvals.reduce((sum, e) => sum + (Number(e.score) || 0), 0) /
          answeredEvals.length,
      )
    : 0;
  const commScore = Number(hr.score) > 0 ? Number(hr.score) : derivedComm;
  const commGrade = hr.grade || gradeFromScore(commScore);

  // Calculate overall fit
  const overallFit = jobFit.fitLevel || calculateFitLevel(technical.score, commScore);
  const fitPercent = jobFit.confidence === 'high' ? 75 : jobFit.confidence === 'medium' ? 60 : 45;

  const matchedSkills = jobFit.matchedSkills || [];
  const missingSkills = jobFit.missingOrUnverifiedSkills || [];

  return (
    <section className="jma-card">
      <div className="jma-header">
        <h3 className="jma-title">Job Match Analysis</h3>
        <div className={`jma-fit-badge jma-fit-badge--${overallFit}`}>
          {formatFitLabel(overallFit)} ({fitPercent}%)
        </div>
      </div>

      {/* Fit breakdown */}
      <div className="jma-breakdown">
        <FitMetric
          label="Technical Fit"
          score={technical.score || 0}
          grade={technical.grade || gradeFromScore(technical.score)}
        />
        <FitMetric
          label="Communication Fit"
          score={commScore}
          grade={commGrade}
        />
      </div>

      {/* Strong areas */}
      {matchedSkills.length > 0 && (
        <div className="jma-section jma-section--positive">
          <h4 className="jma-section-title">Strong Areas</h4>
          <ul className="jma-list">
            {matchedSkills.map((skill, index) => (
              <li key={index} className="jma-list-item jma-list-item--positive">
                {skill}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Areas needing validation */}
      {missingSkills.length > 0 && (
        <div className="jma-section jma-section--attention">
          <h4 className="jma-section-title">Needs Validation</h4>
          <ul className="jma-list">
            {missingSkills.map((skill, index) => (
              <li key={index} className="jma-list-item jma-list-item--attention">
                {skill}
              </li>
            ))}
          </ul>
          <p className="jma-hint">
            These required skills were not demonstrated in this interview.
          </p>
        </div>
      )}

      {/* Recruiter follow-up suggestions */}
      <div className="jma-followup">
        <h4 className="jma-followup-title">Suggested Recruiter Follow-Up</h4>
        <FollowUpSuggestions
          missingSkills={missingSkills}
          technicalScore={technical.score}
          hrScore={commScore}
        />
      </div>
    </section>
  );
}

function FitMetric({ label, score, grade }) {
  const level = score >= 80 ? 'high' : score >= 60 ? 'medium' : 'low';

  return (
    <div className="jma-metric">
      <span className="jma-metric-label">{label}</span>
      <div className="jma-metric-value">
        <span className={`jma-score jma-score--${level}`}>{score || 'N/A'}</span>
        <span className="jma-grade">{grade}</span>
      </div>
    </div>
  );
}

function FollowUpSuggestions({ missingSkills, technicalScore, hrScore }) {
  const suggestions = [];

  if (missingSkills.length > 0) {
    suggestions.push(
      `Ask candidate about ${missingSkills.slice(0, 3).join(', ')}${missingSkills.length > 3 ? ' and other missing skills' : ''} in next interview.`
    );
  }

  if (technicalScore && technicalScore < 70) {
    suggestions.push('Consider technical assessment or coding exercise to validate skills.');
  }

  if (hrScore && hrScore < 60) {
    suggestions.push('Schedule culture fit interview with team members.');
  }

  if (suggestions.length === 0) {
    suggestions.push('Candidate shows strong alignment. Proceed to final interview stage.');
  }

  return (
    <ul className="jma-suggestions">
      {suggestions.map((suggestion, index) => (
        <li key={index} className="jma-suggestion">
          <span className="jma-suggestion-number">{index + 1}</span>
          {suggestion}
        </li>
      ))}
    </ul>
  );
}

function calculateFitLevel(technicalScore, hrScore) {
  if (!technicalScore && !hrScore) return 'unknown';

  const avg = ((technicalScore || 0) + (hrScore || 0)) / 2;

  if (avg >= 80) return 'strong';
  if (avg >= 60) return 'moderate';
  if (avg >= 40) return 'weak';
  return 'unknown';
}

function formatFitLabel(fitLevel) {
  const labels = {
    strong: 'Strong Match',
    moderate: 'Moderate Match',
    weak: 'Weak Match',
    unknown: 'Unknown',
  };
  return labels[fitLevel] || 'Unknown';
}

// Derive a short descriptive label from a 0-100 score when the backend
// didn't populate a grade. Mirrors the standard A/B/C bands but uses words
// the recruiter can read at a glance.
function gradeFromScore(score) {
  const n = Number(score);
  if (!Number.isFinite(n) || n <= 0) return 'N/A';
  if (n >= 90) return 'Excellent';
  if (n >= 80) return 'Strong';
  if (n >= 70) return 'Good';
  if (n >= 60) return 'Fair';
  if (n >= 40) return 'Weak';
  return 'Poor';
}
