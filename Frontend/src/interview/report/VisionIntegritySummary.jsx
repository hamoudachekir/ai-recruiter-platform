/**
 * VisionIntegritySummary.jsx
 *
 * Renders the vision integrity metrics grid and the risk badge.
 * Uses only objective language — no emotion/stress/honesty inference.
 */
import './VisionIntegritySummary.css';

const RISK_CONFIG = {
  low:    { label: 'Low Risk',    className: 'vis--low',    icon: '🟢' },
  medium: { label: 'Medium Risk', className: 'vis--medium', icon: '🟡' },
  high:   { label: 'High Risk',   className: 'vis--high',   icon: '🔴' },
};

function Metric({ label, value, flag = false }) {
  return (
    <div className={`vis-metric ${flag ? 'vis-metric--flagged' : ''}`}>
      <span className="vis-metric-label">{label}</span>
      <span className="vis-metric-value">{value ?? '–'}</span>
    </div>
  );
}

export default function VisionIntegritySummary({ visionReport }) {
  if (!visionReport) {
    return (
      <div className="vis-empty">
        No vision integrity data available. Vision monitoring may not have been active during this interview.
      </div>
    );
  }

  const {
    riskLevel = 'low',
    facePresencePercentage = 0,
    lookingAwayTotalSeconds = 0,
    multiplePeopleEvents = 0,
    phoneDetections = 0,
    referenceMaterialDetections = 0,
    additionalScreenDetections = 0,
    cameraBlockedEvents = 0,
    lightingQuality = 'Unknown',
    tabSwitchCount = 0,
    fullscreenExitCount = 0,
    summary = '',
    flaggedMoments = [],
  } = visionReport;

  const config = RISK_CONFIG[String(riskLevel).toLowerCase()] || RISK_CONFIG.low;

  return (
    <div className="vis-root" id="vision-integrity-summary">
      {/* ── Risk badge ── */}
      <div className={`vis-risk-badge ${config.className}`}>
        <span className="vis-risk-icon">{config.icon}</span>
        <div>
          <div className="vis-risk-label">Integrity Risk Level</div>
          <div className="vis-risk-name">{config.label}</div>
        </div>
      </div>

      {/* ── Disclaimer ── */}
      <div className="vis-disclaimer">
        These signals are objective technical observations only. They do not infer cheating, honesty,
        emotion, intent, or any personal characteristic. The recruiter is the final decision-maker.
      </div>

      {/* ── Metrics ── */}
      <div className="vis-metrics-grid">
        <Metric label="Face Presence" value={`${facePresencePercentage}%`} />
        <Metric label="Looking Away" value={`${lookingAwayTotalSeconds}s`} flag={lookingAwayTotalSeconds > 20} />
        <Metric label="Multiple People" value={multiplePeopleEvents} flag={multiplePeopleEvents > 0} />
        <Metric label="Phone Detections" value={phoneDetections} flag={phoneDetections > 0} />
        <Metric label="Reference Materials" value={referenceMaterialDetections} flag={referenceMaterialDetections > 0} />
        <Metric label="Extra Screens" value={additionalScreenDetections} flag={additionalScreenDetections > 0} />
        <Metric label="Camera Blocked" value={cameraBlockedEvents} flag={cameraBlockedEvents > 0} />
        <Metric label="Lighting Quality" value={lightingQuality} />
        <Metric label="Tab Switches" value={tabSwitchCount} flag={tabSwitchCount > 1} />
        <Metric label="Fullscreen Exits" value={fullscreenExitCount} flag={fullscreenExitCount > 0} />
      </div>

      {/* ── Summary ── */}
      {summary && (
        <p className="vis-summary">{summary}</p>
      )}

      {/* ── Flagged moments table ── */}
      {flaggedMoments.length > 0 && (
        <div className="vis-flagged">
          <h4 className="vis-flagged-title">Flagged Moments</h4>
          <div className="vis-flagged-table">
            <div className="vis-flagged-thead">
              <span>Time</span>
              <span>Signal Type</span>
              <span>Severity</span>
              <span>Duration</span>
              <span>Question</span>
            </div>
            {flaggedMoments.map((m, i) => (
              <div key={i} className={`vis-flagged-row vis-flagged-row--${m.severity}`}>
                <span>{m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : '–'}</span>
                <span className="vis-flagged-type">{m.type}</span>
                <span className={`vis-severity vis-severity--${m.severity}`}>{m.severity}</span>
                <span>{m.durationSeconds > 0 ? `${m.durationSeconds}s` : '–'}</span>
                <span>{m.questionId || '–'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
