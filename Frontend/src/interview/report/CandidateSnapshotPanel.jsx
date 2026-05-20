import './CandidateSnapshotPanel.css';

export default function CandidateSnapshotPanel({ report, room }) {
  if (!report) return null;

  const candidate = {
    name: report.candidateName || room?.candidate?.name || 'Unknown Candidate',
    email: report.candidateEmail || room?.candidate?.email || '',
    duration: formatDuration(report.durationSeconds),
  };

  const job = {
    title: report.jobTitle || room?.job?.title || 'Job not linked',
    isLinked: report.jobMetadataStatus === 'linked',
  };

  return (
    <section className="csp-card">
      <div className="csp-header">
        <div className="csp-avatar">
          {candidate.name.charAt(0).toUpperCase()}
        </div>
        <div className="csp-info">
          <h3 className="csp-name">{candidate.name}</h3>
          <p className="csp-email">{candidate.email}</p>
        </div>
      </div>

      <div className="csp-details">
        <div className="csp-detail">
          <span className="csp-label">Position</span>
          <span className={`csp-value ${!job.isLinked ? 'csp-value--missing' : ''}`}>
            {job.title}
          </span>
        </div>
        <div className="csp-detail">
          <span className="csp-label">Interview Duration</span>
          <span className="csp-value">{candidate.duration}</span>
        </div>
        <div className="csp-detail">
          <span className="csp-label">Report Status</span>
          <span className="csp-value csp-value--success">Analysis Complete</span>
        </div>
      </div>
    </section>
  );
}

function formatDuration(seconds) {
  if (!seconds) return 'N/A';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}
