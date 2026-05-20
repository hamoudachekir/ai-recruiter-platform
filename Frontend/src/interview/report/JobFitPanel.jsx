import './JobFitPanel.css';

function getJobFitAnalysis(report) {
  // Use jobFitAnalysis from backend if available
  const analysis = report?.jobFitAnalysis;
  if (analysis) {
    return {
      fitLevel: analysis.fitLevel || 'unknown',
      confidence: analysis.confidence || 'low',
      matchedSkills: analysis.matchedSkills || [],
      missingSkills: analysis.missingOrUnverifiedSkills || [],
      summary: analysis.summary || 'Job fit analysis unavailable.',
      followUpQuestions: analysis.followUpQuestions || [],
    };
  }

  // Fallback for legacy reports
  const jobTitle = report?.jobTitle;
  const isJobLinked = report?.jobMetadataStatus === 'linked' ||
    (jobTitle && jobTitle !== 'Role' && !jobTitle.toLowerCase().includes('not linked'));

  if (!isJobLinked) {
    return {
      fitLevel: 'unknown',
      confidence: 'low',
      matchedSkills: [],
      missingSkills: [],
      summary: 'Job fit unavailable because no job offer is linked to this interview room.',
      followUpQuestions: [],
    };
  }

  // Basic fallback if we have job but no detailed analysis
  return {
    fitLevel: 'unknown',
    confidence: 'low',
    matchedSkills: [],
    missingSkills: [],
    summary: `Job "${jobTitle}" is linked but detailed fit analysis is not available.`,
    followUpQuestions: ['Review the transcript against job requirements manually.'],
  };
}

function fitLevelLabel(level) {
  const labels = {
    strong: 'Strong Fit',
    moderate: 'Moderate Fit',
    weak: 'Weak Fit',
    unknown: 'Unknown',
  };
  return labels[level] || 'Unknown';
}

export default function JobFitPanel({ report }) {
  if (!report) return null;

  const analysis = getJobFitAnalysis(report);
  const hasSkills = analysis.matchedSkills.length > 0;
  const hasQuestions = analysis.followUpQuestions.length > 0;

  return (
    <section className="jfp-card">
      <div className="jfp-card__header">
        <div>
          <p className="jfp-card__eyebrow">Job Fit Analysis</p>
          <h3 className="jfp-card__title">{fitLevelLabel(analysis.fitLevel)}</h3>
        </div>
        <span className={`jfp-status jfp-status--${analysis.fitLevel}`}>
          {analysis.confidence} confidence
        </span>
      </div>

      <p className="jfp-summary">{analysis.summary}</p>

      {hasSkills && (
        <div className="jfp-skills">
          <h4 className="jfp-subtitle">Skills Detected</h4>
          <div className="jfp-skills__list">
            {analysis.matchedSkills.map((skill, index) => (
              <span key={index} className="jfp-skill">{skill}</span>
            ))}
          </div>
        </div>
      )}

      {analysis.missingSkills.length > 0 && (
        <div className="jfp-missing">
          <h4 className="jfp-subtitle">Missing or Unverified Skills</h4>
          <ul className="jfp-list">
            {analysis.missingSkills.map((skill, index) => (
              <li key={index}>{skill}</li>
            ))}
          </ul>
        </div>
      )}

      {hasQuestions && (
        <div className="jfp-followup">
          <h4 className="jfp-subtitle">Suggested Follow-Up Questions</h4>
          <ul className="jfp-list">
            {analysis.followUpQuestions.map((question, index) => (
              <li key={index}>{question}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
