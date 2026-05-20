import './NextStepsPanel.css';

function fallbackSteps(report) {
  const transcript = report?.transcript || {};
  const audio = report?.audioAnalysis || {};
  const fullText = String(transcript.fullText || transcript.text || '');
  const segments = transcript.segments || audio.segments || [];
  const hasUsableTranscript = fullText.trim().length > 30 || segments.length > 0;
  const jobMissing = !report?.jobTitle || String(report.jobTitle).toLowerCase() === 'role';

  if (report?.humanReviewRequired || !hasUsableTranscript || report?.reportQuality?.confidence === 'low') {
    const steps = [
      'Review the interview recording manually.',
      'Confirm whether the candidate was alone during the interview.',
    ];
    steps.push(hasUsableTranscript
      ? 'Use the transcript to prepare focused follow-up questions.'
      : 'Ask a follow-up technical interview because transcript evidence is missing.');
    if (jobMissing) steps.push('Verify the job position is correctly linked to the interview room.');
    if (!hasUsableTranscript) steps.push('Re-run analysis only if recording or audio extraction was fixed.');
    return steps;
  }

  return [
    'Review transcript evidence and score explanations.',
    'Use any weak areas as follow-up questions.',
    "Record the recruiter's final decision in the applicant workflow.",
  ];
}

export default function NextStepsPanel({ report }) {
  if (!report) return null;
  const summary = report.recruiterDecisionSummary || {};
  const steps = summary.nextSteps?.length ? summary.nextSteps : fallbackSteps(report);

  return (
    <section className="nsp-card">
      <div className="nsp-card__header">
        <p className="nsp-card__eyebrow">Recommended Next Steps</p>
        <h3 className="nsp-card__title">What RH should do next</h3>
      </div>

      <ol className="nsp-list">
        {steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
    </section>
  );
}
