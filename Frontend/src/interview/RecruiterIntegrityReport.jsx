import EventTimeline from './EventTimeline';
import FlaggedMoments from './FlaggedMoments';
import IntegritySummaryCards from './IntegritySummaryCards';
import './RecruiterIntegrityReport.css';

const normalizeLegacyReport = (report) => {
  if (!report) return null;
  // If report already has the new schema fields, use it as-is but ensure consistency
  if (report.overallRiskLevel || report.overallIntegrityRisk) {
    return {
      ...report,
      overallRiskLevel: report.overallIntegrityRisk || report.overallRiskLevel,
      // Ensure objectiveVisualSignals exists
      objectiveVisualSignals: report.objectiveVisualSignals || {
        facePresencePercentage: report.metrics?.facePresencePercentage ?? (Number(String(report.faceVisibilityRate || '0').replace('%', '')) || 0),
        personCountIssues: report.metrics?.multiplePersonEvents ?? (report.multipleFacesDetected ? 1 : 0),
        phoneDetections: report.metrics?.phoneDetections ?? 0,
        referenceMaterialDetections: report.metrics?.bookDetections ?? 0,
        additionalScreenDetections: report.metrics?.screenDetections ?? 0,
        lookingAwayTotalSeconds: report.metrics?.lookingAwayTotalSeconds ?? 0,
        cameraQualityIssues: (report.metrics?.badLightingEvents || 0) + (report.metrics?.cameraBlockedEvents || 0),
      },
      // Ensure interviewComfortIndicators exists with proper structure
      interviewComfortIndicators: report.interviewComfortIndicators || {
        attentionConsistency: report.metrics?.lookingAwayTotalSeconds > 30 ? 'low' : 'high',
        cameraStability: report.metrics?.cameraBlockedEvents > 2 ? 'unstable' : 'stable',
        interviewPressureIndicator: 'low',
        pressureExplanation: 'The interview had consistent camera presence and stable conditions.',
        importantLimitation: 'This is not emotion detection and must not be used as an automatic hiring decision.',
      },
    };
  }

  // Legacy report conversion
  return {
    overallRiskLevel: String(report.integrityRisk?.level || 'low').toLowerCase(),
    riskScore: Number(report.integrityRisk?.score || 0),
    summary: report.integrityRisk?.explanation || 'No significant integrity signals were detected.',
    keyFindings: report.suspiciousEvents?.length
      ? report.suspiciousEvents.map((event) => `${event.type}: ${event.duration || 'duration not available'}`)
      : ['No suspicious events were detected during this interview.'],
    questionAnalysis: [],
    timelineSummary: report.suspiciousEvents?.length
      ? `${report.suspiciousEvents.length} legacy vision signal(s) were recorded.`
      : 'No flagged integrity events were recorded during this interview.',
    recruiterRecommendation: report.recommendation || 'Standard recruiter review applies.',
    limitations: 'This legacy report is based on structured camera monitoring signals only.',
    metrics: {
      facePresencePercentage: (Number(String(report.faceVisibilityRate || '0').replace('%', '')) || 0),
      noFaceTotalSeconds: 0,
      lookingAwayTotalSeconds: 0,
      multiplePersonEvents: report.multipleFacesDetected ? 1 : 0,
      tabSwitchCount: 0,
      fullscreenExitCount: 0,
    },
    // Add new schema fields for legacy reports
    objectiveVisualSignals: {
      facePresencePercentage: (Number(String(report.faceVisibilityRate || '0').replace('%', '')) || 0),
      personCountIssues: report.multipleFacesDetected ? 1 : 0,
      phoneDetections: 0,
      referenceMaterialDetections: 0,
      additionalScreenDetections: 0,
      lookingAwayTotalSeconds: 0,
      cameraQualityIssues: 0,
    },
    interviewComfortIndicators: {
      attentionConsistency: 'high',
      cameraStability: 'stable',
      interviewPressureIndicator: 'low',
      pressureExplanation: 'Legacy report: comfort indicators not available.',
      importantLimitation: 'This is not emotion detection and must not be used as an automatic hiring decision.',
    },
  };
};

const toTitle = (value) => {
  const text = String(value || 'low').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Low';
};

export default function RecruiterIntegrityReport({
  report,
  events = [],
  recordingUrl = '',
  apiBase = '',
}) {
  const normalizedReport = normalizeLegacyReport(report);

  if (!normalizedReport) {
    return (
      <div className="rir-empty">
        <p>No integrity report is available yet. It will appear after the interview is finalized.</p>
      </div>
    );
  }

  const level = normalizedReport.overallRiskLevel || 'low';
  const score = Number(normalizedReport.riskScore || 0);

  return (
    <div className="rir-container">
      <div className="rir-header">
        <div>
          <h3>AI Interview Integrity Assistant</h3>
          <p>AI signals are assistance only. Final decision belongs to the recruiter.</p>
        </div>
        <span className={`rir-score-badge ${level}`}>
          {toTitle(level)} possible risk ({score}/100)
        </span>
      </div>

      <IntegritySummaryCards report={normalizedReport} events={events} />

      {/* Objective Visual Signals Section */}
      <div className="rir-section rir-section--visual-signals">
        <h4>Objective Visual Signals</h4>
        <p className="rir-section__disclaimer">
          These signals indicate moments that may require recruiter review. They are not proof of misconduct.
        </p>
        <div className="rir-visual-signals-grid">
          <div className="rir-visual-signal">
            <span className="rir-visual-signal__label">Face Presence</span>
            <span className="rir-visual-signal__value">
              {normalizedReport.objectiveVisualSignals?.facePresencePercentage ?? normalizedReport.metrics?.facePresencePercentage ?? 0}%
            </span>
          </div>
          <div className="rir-visual-signal">
            <span className="rir-visual-signal__label">Person Count Issues</span>
            <span className="rir-visual-signal__value">
              {normalizedReport.objectiveVisualSignals?.personCountIssues ?? normalizedReport.metrics?.multiplePersonEvents ?? 0}
            </span>
          </div>
          <div className="rir-visual-signal">
            <span className="rir-visual-signal__label">Phone Detections</span>
            <span className="rir-visual-signal__value">
              {normalizedReport.objectiveVisualSignals?.phoneDetections ?? normalizedReport.metrics?.phoneDetections ?? 0}
            </span>
          </div>
          <div className="rir-visual-signal">
            <span className="rir-visual-signal__label">Reference Materials</span>
            <span className="rir-visual-signal__value">
              {normalizedReport.objectiveVisualSignals?.referenceMaterialDetections ?? normalizedReport.metrics?.bookDetections ?? 0}
            </span>
          </div>
          <div className="rir-visual-signal">
            <span className="rir-visual-signal__label">Extra Screens</span>
            <span className="rir-visual-signal__value">
              {normalizedReport.objectiveVisualSignals?.additionalScreenDetections ?? normalizedReport.metrics?.screenDetections ?? 0}
            </span>
          </div>
          <div className="rir-visual-signal">
            <span className="rir-visual-signal__label">Looking Away</span>
            <span className="rir-visual-signal__value">
              {Math.round(normalizedReport.objectiveVisualSignals?.lookingAwayTotalSeconds ?? normalizedReport.metrics?.lookingAwayTotalSeconds ?? 0)}s
            </span>
          </div>
        </div>
      </div>

      {/* Interview Comfort Indicators Section */}
      {normalizedReport.interviewComfortIndicators && (
        <div className="rir-section rir-section--comfort">
          <h4>Interview Comfort Indicators</h4>
          <p className="rir-section__disclaimer">
            These are <strong>objective technical indicators only</strong> — not emotion detection.
          </p>
          <div className="rir-comfort-grid">
            <div className="rir-comfort-item">
              <span className="rir-comfort-item__label">Attention Consistency</span>
              <span className={`rir-comfort-item__value rir-comfort-item__value--${normalizedReport.interviewComfortIndicators.attentionConsistency}`}>
                {toTitle(normalizedReport.interviewComfortIndicators.attentionConsistency)}
              </span>
            </div>
            <div className="rir-comfort-item">
              <span className="rir-comfort-item__label">Camera Stability</span>
              <span className={`rir-comfort-item__value rir-comfort-item__value--${normalizedReport.interviewComfortIndicators.cameraStability}`}>
                {toTitle(normalizedReport.interviewComfortIndicators.cameraStability)}
              </span>
            </div>
            <div className="rir-comfort-item">
              <span className="rir-comfort-item__label">Interview Pressure Indicator</span>
              <span className={`rir-comfort-item__value rir-comfort-item__value--${normalizedReport.interviewComfortIndicators.interviewPressureIndicator}`}>
                {toTitle(normalizedReport.interviewComfortIndicators.interviewPressureIndicator)}
              </span>
            </div>
          </div>
          {normalizedReport.interviewComfortIndicators.pressureExplanation && (
            <p className="rir-comfort-explanation">
              {normalizedReport.interviewComfortIndicators.pressureExplanation}
            </p>
          )}
          <div className="rir-comfort-warning">
            <strong>⚠️ {normalizedReport.interviewComfortIndicators.importantLimitation}</strong>
          </div>
        </div>
      )}

      <div className="rir-explanation">
        <strong>Summary: </strong>
        {normalizedReport.summary}
      </div>

      {!!normalizedReport.keyFindings?.length && (
        <div className="rir-section">
          <h4>Key Findings</h4>
          <ul className="rir-list">
            {normalizedReport.keyFindings.map((finding, index) => (
              <li key={`${finding}-${index}`}>{finding}</li>
            ))}
          </ul>
        </div>
      )}

      {!!normalizedReport.questionAnalysis?.length && (
        <div className="rir-section">
          <h4>Question-by-question Review</h4>
          <div className="rir-question-list">
            {normalizedReport.questionAnalysis.map((item, index) => (
              <div key={`${item.questionId || 'question'}-${index}`} className="rir-question-card">
                <strong>{item.questionId || 'General'}</strong>
                <span>{item.signalCount || item.signals?.length || 0} signal(s)</span>
                {item.highestSeverity && <span>Highest severity: {item.highestSeverity}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <EventTimeline events={events} />
      <FlaggedMoments events={events} recordingUrl={recordingUrl} apiBase={apiBase} />

      <div className="rir-section">
        <h4>Timeline Summary</h4>
        <p>{normalizedReport.timelineSummary}</p>
      </div>

      <div className="rir-section">
        <h4>Recruiter Recommendation</h4>
        <p>{normalizedReport.recruiterRecommendation}</p>
      </div>

      <div className="rir-limitations">
        <strong>Limitations: </strong>
        {normalizedReport.limitations}
      </div>
    </div>
  );
}
