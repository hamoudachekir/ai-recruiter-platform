import './InterviewEvidencePanel.css';

function formatDuration(report) {
  if (report?.duration) return report.duration;
  const seconds = Number(report?.durationSeconds || 0);
  if (!seconds) return 'N/A';
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function getEvidence(report) {
  // Prefer new evidenceSummary from backend if available
  const evidenceSummary = report?.evidenceSummary;
  if (evidenceSummary) {
    return {
      sttCompleted: evidenceSummary.sttProcessCompleted ?? false,
      hasUsableTranscript: evidenceSummary.usableTranscript ?? false,
      segmentCount: evidenceSummary.speechSegments ?? 0,
      wordCount: evidenceSummary.transcriptWords ?? 0,
      candidateAnswersDetected: evidenceSummary.candidateAnswersDetected ?? false,
      technicalEvidenceAvailable: evidenceSummary.technicalEvidenceAvailable ?? false,
      hrEvidenceAvailable: evidenceSummary.hrEvidenceAvailable ?? false,
      evidenceLevel: evidenceSummary.evidenceLevel ?? 'none',
      duration: formatDuration(report),
    };
  }

  // Fallback to computing from transcript/audio
  const transcript = report?.transcript || {};
  const audio = report?.audioAnalysis || {};
  const fullText = String(transcript.fullText || transcript.text || '');
  const segments = transcript.segments || audio.segments || [];
  const sttCompleted = Boolean(
    report?.transcriptionAvailable ||
    transcript.available ||
    audio.transcriptionAvailable
  );
  const hasUsableTranscript = fullText.trim().length > 30 || segments.length > 0;
  const wordCount = transcript.wordCount || audio.wordCount || 0;
  const technicalSource = report?.technicalEvaluation?.source || report?.scoreBreakdown?.technical?.source;
  const hrSource = report?.hrEvaluation?.source || report?.scoreBreakdown?.hr?.source;

  return {
    sttCompleted,
    hasUsableTranscript,
    segmentCount: segments.length,
    wordCount,
    candidateAnswersDetected: hasUsableTranscript && wordCount > 0,
    technicalEvidenceAvailable: hasUsableTranscript && technicalSource !== 'fallback',
    hrEvidenceAvailable: hasUsableTranscript && hrSource !== 'unavailable' && report?.hrEvaluation?.score != null,
    evidenceLevel: hasUsableTranscript ? (wordCount >= 100 ? 'sufficient' : 'limited') : 'none',
    duration: formatDuration(report),
  };
}

function EvidenceMetric({ label, value, tone = 'neutral' }) {
  return (
    <div className={`iep-metric iep-metric--${tone}`}>
      <span className="iep-metric__label">{label}</span>
      <span className="iep-metric__value">{value}</span>
    </div>
  );
}

export default function InterviewEvidencePanel({ report }) {
  if (!report) return null;
  const evidence = getEvidence(report);

  return (
    <section className="iep-card">
      <div className="iep-card__header">
        <div>
          <p className="iep-card__eyebrow">Interview Evidence</p>
          <h3 className="iep-card__title">What the system captured</h3>
        </div>
        <span className={`iep-status ${evidence.hasUsableTranscript ? 'iep-status--ok' : 'iep-status--warn'}`}>
          {evidence.hasUsableTranscript ? 'Usable evidence captured' : 'Evidence limited'}
        </span>
      </div>

      {!evidence.hasUsableTranscript && (
        <div className="iep-warning">
          Not enough verbal evidence was captured to evaluate the candidate's technical and HR skills.
        </div>
      )}

      <div className="iep-grid">
        <EvidenceMetric
          label="STT Process"
          value={evidence.sttCompleted ? 'Completed' : 'Not completed'}
          tone={evidence.sttCompleted ? 'success' : 'warning'}
        />
        <EvidenceMetric
          label="Usable Transcript"
          value={evidence.hasUsableTranscript ? 'Yes' : 'No'}
          tone={evidence.hasUsableTranscript ? 'success' : 'warning'}
        />
        <EvidenceMetric label="Speech Segments" value={evidence.segmentCount} />
        <EvidenceMetric label="Interview Duration" value={evidence.duration} />
        <EvidenceMetric
          label="Candidate Answers"
          value={evidence.candidateAnswersDetected ? 'Detected' : 'Not detected'}
          tone={evidence.candidateAnswersDetected ? 'success' : 'warning'}
        />
        <EvidenceMetric
          label="Technical Evidence"
          value={evidence.technicalEvidenceAvailable ? 'Available' : 'Not usable'}
          tone={evidence.technicalEvidenceAvailable ? 'success' : 'warning'}
        />
        <EvidenceMetric
          label="HR Evidence"
          value={evidence.hrEvidenceAvailable ? 'Available' : 'Not usable'}
          tone={evidence.hrEvidenceAvailable ? 'success' : 'warning'}
        />
        <EvidenceMetric label="Transcript Words" value={evidence.wordCount} />
      </div>
    </section>
  );
}
