/**
 * AnalysisStatusPanel.jsx
 *
 * Displays the current analysis status and provides Generate/Re-run buttons.
 * Shows structured error messages when analysis fails.
 */
import { useState, useCallback } from 'react';
import {
  startReportAnalysis,
  formatAnalysisError,
  determineReportStatus,
} from '../../services/analysisApi';
import './AnalysisStatusPanel.css';

const STATUS_CONFIG = {
  none: {
    icon: '📄',
    title: 'No Report Generated',
    message: 'Generate a comprehensive interview report with AI analysis.',
    badge: 'Not Started',
    badgeClass: 'status-badge--neutral',
  },
  pending: {
    icon: '⏳',
    title: 'Analysis Pending',
    message: 'Initializing analysis pipeline...',
    badge: 'Pending',
    badgeClass: 'status-badge--pending',
  },
  running: {
    icon: '⚙️',
    title: 'Generating Interview Report',
    message: 'Processing video, audio, and transcript...',
    badge: 'Running',
    badgeClass: 'status-badge--running',
  },
  completed: {
    icon: '✅',
    title: 'Report Completed',
    message: 'Analysis complete. View the detailed report below.',
    badge: 'Completed',
    badgeClass: 'status-badge--completed',
  },
  failed: {
    icon: '❌',
    title: 'Analysis Failed',
    message: 'Report generation encountered an error.',
    badge: 'Failed',
    badgeClass: 'status-badge--failed',
  },
};

export default function AnalysisStatusPanel({
  interviewId,
  job,
  report,
  onStatusChange,
  onReportGenerated,
}) {
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState(null);

  const status = determineReportStatus(job, report);
  const config = STATUS_CONFIG[status];

  const handleGenerate = useCallback(
    async (force = false) => {
      setIsGenerating(true);
      setError(null);

      try {
        const result = await startReportAnalysis(interviewId, force);

        if (result.success) {
          onStatusChange({
            status: result.status,
            jobId: result.jobId,
            message: result.message,
          });

          // If completed immediately (cached), fetch the report
          if (result.status === 'completed' && result.report) {
            onReportGenerated(result.report);
          }
        } else if (result.error) {
          setError(result.error);
        }
      } catch (err) {
        setError({
          code: 'request_failed',
          message: err.message || 'Failed to start analysis',
        });
      } finally {
        setIsGenerating(false);
      }
    },
    [interviewId, onStatusChange, onReportGenerated]
  );

  const clearError = () => setError(null);

  const renderButtons = () => {
    if (isGenerating) {
      return (
        <button className="analysis-btn analysis-btn--loading" disabled>
          <span className="analysis-btn__spinner" />
          {status === 'running' ? 'Analysis Running...' : 'Starting Analysis...'}
        </button>
      );
    }

    if (status === 'none' || status === 'failed') {
      return (
        <button
          className="analysis-btn analysis-btn--primary"
          onClick={() => handleGenerate(false)}
          disabled={isGenerating}
        >
          {status === 'failed' ? '🔄 Retry Analysis' : '⚡ Generate Report'}
        </button>
      );
    }

    if (status === 'completed') {
      return (
        <button
          className="analysis-btn analysis-btn--secondary"
          onClick={() => handleGenerate(true)}
          disabled={isGenerating}
        >
          🔄 Re-run Analysis
        </button>
      );
    }

    // Running or pending - no button, just status
    return null;
  };

  return (
    <div className={`analysis-status-panel analysis-status-panel--${status}`}>
      <div className="analysis-status-panel__header">
        <div className="analysis-status-panel__icon">{config.icon}</div>
        <div className="analysis-status-panel__info">
          <h3 className="analysis-status-panel__title">{config.title}</h3>
          <span className={`status-badge ${config.badgeClass}`}>{config.badge}</span>
        </div>
      </div>

      <p className="analysis-status-panel__message">{config.message}</p>

      {/* Progress indicator for running state */}
      {(status === 'running' || status === 'pending') && job && (
        <div className="analysis-progress">
          <div className="analysis-progress__bar">
            <div
              className="analysis-progress__fill"
              style={{ width: `${job.progress || 0}%` }}
            />
          </div>
          <div className="analysis-progress__info">
            <span className="analysis-progress__percent">{job.progress || 0}%</span>
            <span className="analysis-progress__step">
              {job.currentStep || 'Initializing...'}
            </span>
          </div>
        </div>
      )}

      {/* Structured error display */}
      {error && (
        <div className="analysis-error">
          <div className="analysis-error__header">
            <span className="analysis-error__icon">⚠️</span>
            <span className="analysis-error__title">Analysis Error</span>
          </div>
          <p className="analysis-error__message">{formatAnalysisError(error)}</p>
          {error.step && (
            <p className="analysis-error__step">Failed during step: {error.step}</p>
          )}
          <button className="analysis-error__dismiss" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}

      {/* Action buttons */}
      <div className="analysis-status-panel__actions">{renderButtons()}</div>

      {/* Deterministic note */}
      <p className="analysis-status-panel__note">
        <span className="analysis-note__icon">🛡️</span>
        Scores and integrity metrics are calculated using deterministic rules.
        LLM polish only improves wording and does not change measured values.
      </p>
    </div>
  );
}
