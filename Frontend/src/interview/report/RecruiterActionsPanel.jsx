import './RecruiterActionsPanel.css';

export default function RecruiterActionsPanel({ report }) {
  if (!report) return null;

  const decision = report.recruiterDecisionSummary || {};
  const quality = report.reportQuality || {};
  const jobFit = report.jobFitAnalysis || {};

  // Determine recommended actions based on report state
  const actions = buildRecommendedActions(decision, quality, jobFit, report);

  return (
    <section className="rap-card">
      <div className="rap-header">
        <h3 className="rap-title">Recommended Recruiter Actions</h3>
        <p className="rap-subtitle">Clear next steps based on interview analysis</p>
      </div>

      <div className="rap-actions">
        {actions.map((action, index) => (
          <div
            key={index}
            className={`rap-action rap-action--${action.priority}`}
          >
            <div className="rap-action-header">
              <span className={`rap-priority rap-priority--${action.priority}`}>
                {action.priority === 'high' ? 'High Priority' : action.priority === 'medium' ? 'Medium' : 'Suggested'}
              </span>
              {action.time && <span className="rap-time">{action.time}</span>}
            </div>
            <p className="rap-action-text">{action.text}</p>
            {action.reason && (
              <p className="rap-action-reason">{action.reason}</p>
            )}
          </div>
        ))}
      </div>

      {/* Quick decision buttons */}
      <div className="rap-decisions">
        <h4 className="rap-decisions-title">Quick Actions</h4>
        <div className="rap-buttons">
          <button className="rap-btn rap-btn--primary">
            Schedule Follow-Up Interview
          </button>
          <button className="rap-btn rap-btn--secondary">
            Share Report with Team
          </button>
          <button className="rap-btn rap-btn--neutral">
            Export to ATS
          </button>
        </div>
      </div>
    </section>
  );
}

function buildRecommendedActions(decision, quality, jobFit, report) {
  const actions = [];

  // High priority: Transcript issues
  if (quality.missingData?.includes('transcript')) {
    actions.push({
      priority: 'high',
      text: 'Review recording manually — transcript was not fully captured',
      reason: 'Automated analysis is limited without complete transcript',
      time: 'Before any decision',
    });
  }

  // High priority: Integrity concerns
  if (report.integrityAlerts?.length > 0) {
    const alert = report.integrityAlerts[0];
    actions.push({
      priority: 'high',
      text: `Verify integrity concern: ${alert.message || 'Check interview integrity'}`,
      reason: 'Potential issue detected during interview monitoring',
      time: 'Before proceeding',
    });
  }

  // Medium priority: Missing skills
  const missingSkills = jobFit.missingOrUnverifiedSkills || [];
  if (missingSkills.length > 0) {
    actions.push({
      priority: 'medium',
      text: `Ask about missing skills: ${missingSkills.slice(0, 3).join(', ')}${missingSkills.length > 3 ? '...' : ''}`,
      reason: 'Required skills not demonstrated in this interview',
      time: 'In next interview',
    });
  }

  // Medium priority: Technical follow-up
  const technicalScore = report.technicalEvaluation?.score;
  if (technicalScore && technicalScore < 70) {
    actions.push({
      priority: 'medium',
      text: 'Schedule technical assessment or coding exercise',
      reason: 'Technical score suggests need for deeper validation',
      time: 'Within 3 days',
    });
  }

  // Low priority: Standard follow-up
  if (actions.length === 0) {
    actions.push({
      priority: 'low',
      text: 'Proceed to final interview stage',
      reason: 'Candidate demonstrated required skills and passed integrity checks',
      time: 'Standard workflow',
    });
  }

  // Always add review recommendation
  actions.push({
    priority: 'low',
    text: 'Review transcript highlights with hiring manager',
    reason: 'Share key insights from interview analysis',
    time: 'Before decision',
  });

  return actions;
}
