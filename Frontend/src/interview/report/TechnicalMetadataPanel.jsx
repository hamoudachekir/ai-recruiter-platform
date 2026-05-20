import { useState } from 'react';
import './TechnicalMetadataPanel.css';

export default function TechnicalMetadataPanel({ report, job }) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!report) return null;

  const metadata = report._metadata || {};
  const polish = report.polish || {};
  const quality = report.reportQuality || {};

  return (
    <section className="tmp-card">
      <button
        className="tmp-header"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
      >
        <div className="tmp-title-group">
          <h3 className="tmp-title">Technical Metadata</h3>
          <p className="tmp-subtitle">
            System diagnostics and analysis pipeline details
          </p>
        </div>
        <span className={`tmp-chevron ${isExpanded ? 'tmp-chevron--expanded' : ''}`}>
          ▼
        </span>
      </button>

      {isExpanded && (
        <div className="tmp-content">
          {/* Pipeline Info */}
          <div className="tmp-section">
            <h4 className="tmp-section-title">Analysis Pipeline</h4>
            <dl className="tmp-dl">
              <div className="tmp-dl-row">
                <dt>Interview ID</dt>
                <dd>{report.interviewId}</dd>
              </div>
              <div className="tmp-dl-row">
                <dt>Generated</dt>
                <dd>{formatDate(report.generatedAt)}</dd>
              </div>
              <div className="tmp-dl-row">
                <dt>Pipeline Status</dt>
                <dd>{job?.status || 'completed'}</dd>
              </div>
              <div className="tmp-dl-row">
                <dt>Analysis Version</dt>
                <dd>{metadata.graphVersion || '1.0'}</dd>
              </div>
              <div className="tmp-dl-row">
                <dt>Transcript Source</dt>
                <dd>{quality.transcriptSource || 'Speech-to-text pipeline'}</dd>
              </div>
            </dl>
          </div>

          {/* LLM Polish Info */}
          <div className="tmp-section">
            <h4 className="tmp-section-title">LLM Polish</h4>
            <dl className="tmp-dl">
              <div className="tmp-dl-row">
                <dt>Provider</dt>
                <dd>{polish.provider || 'N/A'}</dd>
              </div>
              <div className="tmp-dl-row">
                <dt>Model</dt>
                <dd>{polish.model || 'N/A'}</dd>
              </div>
              <div className="tmp-dl-row">
                <dt>Status</dt>
                <dd className={polish.success === false ? 'tmp-error' : ''}>
                  {polish.success === true ? 'Success' : polish.success === false ? 'Failed' : 'N/A'}
                </dd>
              </div>
              {polish.userFriendlyMessage && (
                <div className="tmp-dl-row">
                  <dt>Message</dt>
                  <dd>{polish.userFriendlyMessage}</dd>
                </div>
              )}
            </dl>
          </div>

          {/* Deterministic Note */}
          <div className="tmp-note">
            <strong>Note:</strong> Scores, integrity metrics, and transcript availability are
            deterministic source-of-truth values. LLM polish improves wording only
            and does not change measured values.
          </div>
        </div>
      )}
    </section>
  );
}

function formatDate(dateString) {
  if (!dateString) return 'N/A';
  try {
    return new Date(dateString).toLocaleString();
  } catch {
    return dateString;
  }
}
