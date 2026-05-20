import './IntegrityTrustPanel.css';

function getFacePercent(vision) {
  if (vision?.faceVisiblePercent != null) return Number(vision.faceVisiblePercent);
  return parseFloat(String(vision?.faceVisibilityRate || '0')) || 0;
}

function buildTrustCheck(report) {
  // Use trustSummary from backend if available (new recruiter-first format)
  const trustSummary = report?.trustSummary;
  if (trustSummary) {
    const metrics = trustSummary.metrics || {};
    return {
      status: trustSummary.status || 'needs_review',
      label: trustSummary.label || 'Needs Review',
      reasons: trustSummary.reasons || [],
      metrics: {
        facePercent: metrics.faceVisibilityPercent ?? 0,
        absenceEvents: metrics.absenceEvents ?? 0,
        multipleFaces: metrics.multipleFacesDetected ?? false,
        longSilenceEvents: metrics.longSilenceEvents ?? 0,
        longSilenceSeconds: metrics.longSilenceSeconds ?? 0,
        totalAlerts: metrics.totalAlerts ?? 0,
        integrityScore: report?.integrityScore,
      },
    };
  }

  // Fallback to computing from legacy fields
  const vision = report?.visionMonitoring || {};
  const audio = report?.audioAnalysis || {};
  const alerts = report?.integrityAlerts || [];
  const facePercent = getFacePercent(vision);
  const absenceEvents = Number(vision.absenceEvents || 0);
  const multipleFaces = Boolean(vision.multipleFacesDetected);
  const longSilenceEvents = Number(audio.longSilenceEvents || audio.silenceEvents || 0);
  const longSilenceSeconds = Number(audio.longSilenceSeconds || 0);
  const integrityScore = report?.integrityScore;

  let status = 'passed';
  if (facePercent < 50 || absenceEvents >= 4 || (integrityScore != null && integrityScore < 60)) {
    status = 'failed';
  } else if (
    multipleFaces ||
    facePercent < 70 ||
    absenceEvents > 0 ||
    longSilenceEvents > 0 ||
    alerts.length > 0 ||
    report?.humanReviewRequired
  ) {
    status = 'needs_review';
  }

  const reasons = [];
  reasons.push(facePercent >= 90
    ? `Face visibility was good: ${facePercent.toFixed(1)}%.`
    : `Face visibility was ${facePercent.toFixed(1)}%.`);
  reasons.push(absenceEvents > 0
    ? `${absenceEvents} absence event(s) were detected.`
    : 'No absence events were detected.');
  if (multipleFaces) reasons.push('Multiple faces were detected.');
  if (longSilenceEvents > 0) reasons.push(`${longSilenceEvents} long silence event(s) totaled ${longSilenceSeconds.toFixed(1)} seconds.`);
  if (alerts.length > 0) reasons.push(`${alerts.length} integrity alert(s) require review.`);

  return {
    status,
    label: statusLabel(status),
    reasons,
    metrics: {
      facePercent,
      absenceEvents,
      multipleFaces,
      longSilenceEvents,
      longSilenceSeconds,
      totalAlerts: alerts.length,
      integrityScore,
    },
  };
}

function statusLabel(status) {
  if (status === 'passed') return 'Passed';
  if (status === 'failed') return 'Failed';
  return 'Needs Review';
}

export default function IntegrityTrustPanel({ report }) {
  if (!report) return null;
  const trust = buildTrustCheck(report);

  return (
    <section className="itp-card">
      <div className="itp-card__header">
        <div>
          <p className="itp-card__eyebrow">Integrity & Trust Check</p>
          <h3 className="itp-card__title">Trust Status: {statusLabel(trust.status)}</h3>
        </div>
        <span className={`itp-status itp-status--${trust.status}`}>{statusLabel(trust.status)}</span>
      </div>

      <div className="itp-body">
        <div className="itp-reasons">
          <h4 className="itp-subtitle">Reason</h4>
          <ul>
            {trust.reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
          </ul>
        </div>

        <div className="itp-metrics">
          <div className="itp-metric">
            <span>Face Visibility</span>
            <strong>{trust.metrics.facePercent.toFixed(1)}%</strong>
          </div>
          <div className="itp-metric">
            <span>Absence Events</span>
            <strong>{trust.metrics.absenceEvents}</strong>
          </div>
          <div className="itp-metric">
            <span>Multiple Faces</span>
            <strong>{trust.metrics.multipleFaces ? 'Yes' : 'No'}</strong>
          </div>
          <div className="itp-metric">
            <span>Long Silence Events</span>
            <strong>{trust.metrics.longSilenceEvents}</strong>
          </div>
          <div className="itp-metric">
            <span>Total Silence Duration</span>
            <strong>{trust.metrics.longSilenceSeconds.toFixed(1)}s</strong>
          </div>
          <div className="itp-metric">
            <span>Total Alerts</span>
            <strong>{trust.metrics.totalAlerts}</strong>
          </div>
        </div>
      </div>
    </section>
  );
}
