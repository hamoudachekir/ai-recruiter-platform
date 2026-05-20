import './SystemMetadataPanel.css';

function formatDate(value) {
  if (!value) return 'N/A';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function display(value) {
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  return value || 'N/A';
}

export default function SystemMetadataPanel({ report, job }) {
  if (!report) return null;

  const polish = report.polish || {};
  const metadata = report._metadata || {};
  const audio = report.audioAnalysis || {};

  // Check job metadata status
  const jobStatus = report.jobMetadataStatus;
  const isJobLinked = jobStatus === 'linked' ||
    (report.jobId && report.jobTitle && !report.jobTitle.toLowerCase().includes('not linked'));

  const transcriptSource = audio.sttFallback
    ? `Fallback STT${audio.sttFallbackReason ? `: ${audio.sttFallbackReason}` : ''}`
    : audio.transcriptionAvailable || report.transcriptionAvailable
      ? 'Speech-to-text pipeline'
      : 'Unavailable';

  const rows = [
    ['Interview ID', report.interviewId],
    ['Generated Date', report.generatedAt || metadata.generatedAt],
    ['Pipeline Status', job?.status || 'completed'],
    ['Analysis Version', metadata.graphVersion],
    ['Transcript Source', transcriptSource],
    ['Job Metadata Status', isJobLinked ? 'Linked' : (jobStatus === 'missing' ? 'Not linked' : 'Unknown')],
    ['LLM Polish Provider', polish.provider],
    ['LLM Polish Model', polish.model],
    ['LLM Polish Status', polish.success === false ? 'Failed' : polish.success === true ? 'Success' : metadata.polishStatus],
    ['Non-Destructive Polish', polish.nonDestructive],
  ];

  // Use user-friendly message if available, otherwise fall back to legacy error
  const polishUserMessage = polish.userFriendlyMessage;
  const polishDebugError = polish.debugError || polish.error;

  return (
    <section className="smp-card">
      <div className="smp-card__header">
        <p className="smp-card__eyebrow">System Metadata</p>
        <h3 className="smp-card__title">Pipeline details</h3>
      </div>

      <div className="smp-grid">
        {rows.map(([label, value]) => (
          <div className="smp-item" key={label}>
            <span className="smp-item__label">{label}</span>
            <span className="smp-item__value">
              {label.includes('Date') ? formatDate(value) : display(value)}
            </span>
          </div>
        ))}
      </div>

      {/* Show user-friendly polish message */}
      {polish.success === false && polishUserMessage && (
        <div className="smp-warning">
          <span className="smp-warning__icon">⚠️</span>
          {polishUserMessage}
        </div>
      )}

      {/* Show debug error details (for technical troubleshooting) */}
      {polishDebugError && (
        <details className="smp-debug">
          <summary>Technical error details</summary>
          <pre className="smp-debug__code">{polishDebugError}</pre>
        </details>
      )}

      <div className="smp-note">
        Scores, integrity metrics, transcript availability, and report-quality fields are deterministic source-of-truth values.
        LLM polish may improve wording only and must not change measured values.
      </div>
    </section>
  );
}
