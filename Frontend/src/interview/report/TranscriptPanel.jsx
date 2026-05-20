/**
 * TranscriptPanel.jsx
 *
 * Displays transcript summary and audio metrics.
 */
import './TranscriptPanel.css';

export default function TranscriptPanel({ report }) {
  if (!report) return null;

  const {
    transcriptSummary,
    transcript,
    audioAnalysis,
  } = report;

  const audio = audioAnalysis || {};

  // Get transcript text
  const transcriptText = transcript?.text || transcript?.fullText || '';
  const transcriptSegments = transcript?.segments || audio.segments || [];

  const sttCompleted = Boolean(
    report.transcriptionAvailable ||
    audio.transcriptionAvailable ||
    transcript?.available
  );
  const hasUsableTranscript = transcriptText.trim().length > 30 || transcriptSegments.length > 0;

  return (
    <div className="transcript-panel">
      <h3 className="transcript-panel__title">Transcript & Audio</h3>

      {/* Summary card */}
      <div className="transcript-summary-card">
        <div className="transcript-summary-card__header">
          <span className="transcript-summary-card__icon">📝</span>
          <h4 className="transcript-summary-card__title">Transcript Summary</h4>
        </div>

        <div className="transcript-summary-card__content">
          {sttCompleted && !hasUsableTranscript && (
            <div className="transcript-unavailable">
              <span className="transcript-unavailable__icon">!</span>
              <p className="transcript-unavailable__text">
                Audio analysis ran successfully, but no usable speech transcript was extracted.
              </p>
            </div>
          )}
          {hasUsableTranscript ? (
            transcriptSummary ? (
              <p className="transcript-summary__text">{transcriptSummary}</p>
            ) : (
              <p className="transcript-summary__placeholder">
                Transcript available but no summary generated.
              </p>
            )
          ) : sttCompleted ? (
            <p className="transcript-summary__placeholder">
              No usable transcript content was extracted.
            </p>
          ) : (
            <div className="transcript-unavailable">
              <span className="transcript-unavailable__icon">🚫</span>
              <p className="transcript-unavailable__text">
                Transcription not available for this interview.
              </p>
              {audio.sttFallback && (
                <p className="transcript-unavailable__reason">
                  Reason: {audio.sttFallbackReason || 'Speech-to-text service unavailable'}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Audio metrics */}
      <div className="audio-metrics-card">
        <div className="audio-metrics-card__header">
          <span className="audio-metrics-card__icon">🎤</span>
          <h4 className="audio-metrics-card__title">Audio Metrics</h4>
        </div>

        <div className="audio-metrics-grid">
          <div className="audio-metric">
            <span className="audio-metric__label">STT Process</span>
            <span className={`audio-metric__value ${sttCompleted ? 'audio-metric__value--success' : ''}`}>
              {sttCompleted ? 'Completed' : 'Not completed'}
            </span>
          </div>

          <div className="audio-metric">
            <span className="audio-metric__label">Usable Transcript</span>
            <span className={`audio-metric__value ${hasUsableTranscript ? 'audio-metric__value--success' : 'audio-metric__value--warning'}`}>
              {hasUsableTranscript ? 'Yes' : 'No'}
            </span>
          </div>

          {audio.language && (
            <div className="audio-metric">
              <span className="audio-metric__label">Detected Language</span>
              <span className="audio-metric__value">{audio.language}</span>
            </div>
          )}

          {audio.longSilenceEvents !== undefined && (
            <div className="audio-metric">
              <span className="audio-metric__label">Long Silence Events</span>
              <span className={`audio-metric__value ${audio.longSilenceEvents > 0 ? 'audio-metric__value--warning' : ''}`}>
                {audio.longSilenceEvents}
              </span>
            </div>
          )}

          {audio.longSilenceSeconds > 0 && (
            <div className="audio-metric">
              <span className="audio-metric__label">Total Silence Duration</span>
              <span className="audio-metric__value">{audio.longSilenceSeconds.toFixed(1)}s</span>
            </div>
          )}

          {transcriptSegments && (
            <div className="audio-metric">
              <span className="audio-metric__label">Speech Segments</span>
              <span className="audio-metric__value">{transcriptSegments.length}</span>
            </div>
          )}

          {audio.wordCount > 0 && (
            <div className="audio-metric">
              <span className="audio-metric__label">Word Count</span>
              <span className="audio-metric__value">{audio.wordCount}</span>
            </div>
          )}

          {audio.sttFallback && (
            <div className="audio-metric audio-metric--notice">
              <span className="audio-metric__label">STT Fallback</span>
              <span className="audio-metric__value audio-metric__value--warning">
                Fallback Mode
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Full transcript preview (if available) */}
      {hasUsableTranscript && transcriptText && (
        <div className="transcript-preview-card">
          <div className="transcript-preview-card__header">
            <span className="transcript-preview-card__icon">📄</span>
            <h4 className="transcript-preview-card__title">Full Transcript Preview</h4>
          </div>
          <div className="transcript-preview-card__content">
            <pre className="transcript-preview__text">
              {transcriptText.length > 500
                ? transcriptText.substring(0, 500) + '...'
                : transcriptText}
            </pre>
            {transcriptText.length > 500 && (
              <p className="transcript-preview__truncated">
                Transcript truncated. Full version available in download.
              </p>
            )}
          </div>
        </div>
      )}

    </div>
  );
}
