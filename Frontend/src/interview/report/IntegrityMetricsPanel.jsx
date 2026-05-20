/**
 * IntegrityMetricsPanel.jsx
 *
 * Displays vision monitoring, audio analysis, and integrity alerts.
 */
import './IntegrityMetricsPanel.css';

export default function IntegrityMetricsPanel({ report }) {
  if (!report) return null;

  const {
    visionMonitoring,
    audioAnalysis,
    integrity,
    integrityAlerts,
    humanReviewRequired,
  } = report;

  const vision = visionMonitoring || {};
  const audio = audioAnalysis || {};

  // Format face visibility
  const faceVisiblePercent = vision.faceVisiblePercent ??
    (vision.faceVisibilityRate ? parseFloat(vision.faceVisibilityRate) : null);

  // Get camera quality
  const cameraQuality = vision.cameraQuality || 'Unknown';

  // Determine quality badge
  const getQualityBadge = (quality) => {
    const q = String(quality).toLowerCase();
    if (q.includes('good') || q.includes('excellent')) {
      return { className: 'quality--good', icon: '✓' };
    }
    if (q.includes('review') || q.includes('needs') || q.includes('fair')) {
      return { className: 'quality--warning', icon: '⚠' };
    }
    if (q.includes('poor') || q.includes('bad')) {
      return { className: 'quality--poor', icon: '✗' };
    }
    return { className: 'quality--neutral', icon: '?' };
  };

  const cameraBadge = getQualityBadge(cameraQuality);

  return (
    <div className="integrity-metrics-panel">
      <h3 className="integrity-metrics-panel__title">Integrity & Monitoring</h3>

      <div className="integrity-metrics-grid">
        {/* Vision Monitoring Card */}
        <div className="metrics-card metrics-card--vision">
          <div className="metrics-card__header">
            <span className="metrics-card__icon">👁️</span>
            <h4 className="metrics-card__title">Vision Monitoring</h4>
          </div>

          <div className="metrics-card__content">
            <div className="metric-row">
              <span className="metric-row__label">Face Visibility</span>
              <span className="metric-row__value">
                {faceVisiblePercent !== null && faceVisiblePercent !== undefined
                  ? `${Number(faceVisiblePercent).toFixed(1)}%`
                  : 'N/A'}
              </span>
            </div>

            <div className="metric-row">
              <span className="metric-row__label">Absence Events</span>
              <span className={`metric-row__value ${vision.absenceEvents > 0 ? 'metric-row__value--warning' : ''}`}>
                {vision.absenceEvents ?? 0}
              </span>
            </div>

            {vision.multipleFacesDetected !== undefined && (
              <div className="metric-row">
                <span className="metric-row__label">Multiple Faces</span>
                <span className={`metric-row__value ${vision.multipleFacesDetected ? 'metric-row__value--warning' : ''}`}>
                  {vision.multipleFacesDetected ? 'Yes ⚠' : 'No ✓'}
                </span>
              </div>
            )}

            <div className="metric-row">
              <span className="metric-row__label">Camera Quality</span>
              <span className={`metric-row__value ${cameraBadge.className}`}>
                {cameraBadge.icon} {cameraQuality}
              </span>
            </div>

            {vision.tabSwitchEvents !== undefined && vision.tabSwitchEvents > 0 && (
              <div className="metric-row">
                <span className="metric-row__label">Tab Switches</span>
                <span className="metric-row__value metric-row__value--warning">
                  {vision.tabSwitchEvents}
                </span>
              </div>
            )}

            {vision.fullscreenExitEvents !== undefined && vision.fullscreenExitEvents > 0 && (
              <div className="metric-row">
                <span className="metric-row__label">Fullscreen Exits</span>
                <span className="metric-row__value metric-row__value--warning">
                  {vision.fullscreenExitEvents}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Audio Analysis Card */}
        <div className="metrics-card metrics-card--audio">
          <div className="metrics-card__header">
            <span className="metrics-card__icon">🎤</span>
            <h4 className="metrics-card__title">Audio Analysis</h4>
          </div>

          <div className="metrics-card__content">
            <div className="metric-row">
              <span className="metric-row__label">Transcription</span>
              <span className={`metric-row__value ${audio.transcriptionAvailable ? 'metric-row__value--success' : ''}`}>
                {audio.transcriptionAvailable ? 'Available ✓' : 'Not Available'}
              </span>
            </div>

            {audio.sttFallback && (
              <div className="metric-row metric-row--notice">
                <span className="metric-row__label">STT Status</span>
                <span className="metric-row__value metric-row__value--warning">
                  Fallback Mode
                </span>
              </div>
            )}

            {audio.sttFallbackReason && (
              <div className="metric-row metric-row--subtle">
                <span className="metric-row__label">Fallback Reason</span>
                <span className="metric-row__value">{audio.sttFallbackReason}</span>
              </div>
            )}

            <div className="metric-row">
              <span className="metric-row__label">Long Silence Events</span>
              <span className={`metric-row__value ${audio.longSilenceEvents > 0 ? 'metric-row__value--warning' : ''}`}>
                {audio.longSilenceEvents ?? 0}
              </span>
            </div>

            {audio.longSilenceSeconds > 0 && (
              <div className="metric-row">
                <span className="metric-row__label">Total Silence Duration</span>
                <span className="metric-row__value">
                  {audio.longSilenceSeconds.toFixed(1)}s
                </span>
              </div>
            )}

            {audio.silenceEvents !== undefined && (
              <div className="metric-row">
                <span className="metric-row__label">Total Silence Events</span>
                <span className="metric-row__value">{audio.silenceEvents}</span>
              </div>
            )}
          </div>
        </div>

        {/* Integrity Summary Card */}
        <div className="metrics-card metrics-card--integrity">
          <div className="metrics-card__header">
            <span className="metrics-card__icon">🛡️</span>
            <h4 className="metrics-card__title">Integrity Summary</h4>
          </div>

          <div className="metrics-card__content">
            <div className="metric-row">
              <span className="metric-row__label">Total Alerts</span>
              <span className={`metric-row__value ${(integrity?.totalAlerts || integrityAlerts?.length || 0) > 0 ? 'metric-row__value--warning' : ''}`}>
                {integrity?.totalAlerts ?? integrityAlerts?.length ?? 0}
              </span>
            </div>

            {integrity?.highSeverityCount > 0 && (
              <div className="metric-row">
                <span className="metric-row__label">High Severity</span>
                <span className="metric-row__value metric-row__value--danger">
                  {integrity.highSeverityCount}
                </span>
              </div>
            )}

            {integrity?.mediumSeverityCount > 0 && (
              <div className="metric-row">
                <span className="metric-row__label">Medium Severity</span>
                <span className="metric-row__value metric-row__value--warning">
                  {integrity.mediumSeverityCount}
                </span>
              </div>
            )}

            {integrity?.lowSeverityCount > 0 && (
              <div className="metric-row">
                <span className="metric-row__label">Low Severity</span>
                <span className="metric-row__value">
                  {integrity.lowSeverityCount}
                </span>
              </div>
            )}

            {humanReviewRequired && (
              <div className="metric-row metric-row--highlight">
                <span className="metric-row__label">Human Review</span>
                <span className="metric-row__value metric-row__value--warning">
                  Required ⚠️
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
