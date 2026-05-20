import './RecruiterDecisionSummary.css';

function formatLabel(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function getTranscriptState(report) {
  const transcript = report?.transcript || {};
  const audio = report?.audioAnalysis || {};
  const fullText = String(transcript.fullText || transcript.text || '');
  const segments = transcript.segments || audio.segments || [];
  return {
    hasUsableTranscript: fullText.trim().length > 30 || segments.length > 0,
    segmentCount: segments.length,
    wordCount: transcript.wordCount || audio.wordCount || 0,
  };
}

function buildFallbackSummary(report) {
  const quality = report?.reportQuality || {};
  const vision = report?.visionMonitoring || {};
  const audio = report?.audioAnalysis || {};
  const finalRecommendation = report?.finalRecommendation || {};
  const transcriptState = getTranscriptState(report);
  const confidence = String(quality.confidence || 'low').toLowerCase();
  const manualReview = report?.humanReviewRequired || confidence === 'low' || !transcriptState.hasUsableTranscript;

  const blockers = [...(quality.missingData || [])];
  if (!transcriptState.hasUsableTranscript) blockers.push('Transcript content unavailable');
  if (report?.hrEvaluation?.score == null) blockers.push('HR evaluation unavailable');
  if (!report?.jobTitle || String(report.jobTitle).toLowerCase() === 'role') blockers.push('Job title unavailable');

  const keyFindings = [];
  const facePercent = (vision.faceVisiblePercent ?? parseFloat(String(vision.faceVisibilityRate || '0'))) || 0;
  keyFindings.push(`Face visibility was ${facePercent >= 90 ? 'high' : facePercent >= 70 ? 'acceptable' : 'low'} at ${Number(facePercent).toFixed(1)}%.`);
  keyFindings.push((vision.absenceEvents || 0) > 0
    ? `${vision.absenceEvents} absence event(s) were detected.`
    : 'No absence events were detected.');
  if (vision.multipleFacesDetected) keyFindings.push('Multiple faces were detected, which requires review.');
  if ((audio.longSilenceEvents || 0) > 0) {
    keyFindings.push(`${audio.longSilenceEvents} long silence event(s) totaled ${Number(audio.longSilenceSeconds || 0).toFixed(1)} seconds.`);
  }
  keyFindings.push(transcriptState.hasUsableTranscript
    ? `Usable transcript evidence contains ${transcriptState.wordCount} word(s) across ${transcriptState.segmentCount} speech segment(s).`
    : 'No usable transcript content was extracted.');

  return {
    decision: manualReview ? 'manual_review' : 'proceed',
    label: manualReview ? 'Manual Review Required' : 'Proceed With Recruiter Review',
    confidence,
    riskLevel: manualReview ? 'medium' : 'low',
    shortReason: finalRecommendation.summary || (manualReview
      ? 'The report requires manual review because the available evidence is incomplete or flagged.'
      : 'Interview evidence is sufficient and no critical integrity blockers were detected.'),
    recruiterAction: finalRecommendation.nextStep || (manualReview
      ? 'Review the recording manually before making a hiring decision.'
      : 'Review the transcript and score explanations, then decide whether to advance the candidate.'),
    keyFindings,
    blockers: [...new Set(blockers.filter(Boolean))],
  };
}

export default function RecruiterDecisionSummary({ report }) {
  if (!report) return null;

  const summary = report.recruiterDecisionSummary || buildFallbackSummary(report);
  const decision = String(summary.decision || 'manual_review').toLowerCase();
  const confidence = String(summary.confidence || report.reportQuality?.confidence || 'low').toLowerCase();
  const riskLevel = String(summary.riskLevel || 'medium').toLowerCase();
  const findings = summary.keyFindings || [];
  const blockers = summary.blockers || [];

  // New fields from backend
  const oneSentenceSummary = summary.oneSentenceSummary;
  const whyThisDecision = summary.whyThisDecision || [];
  const topWarnings = summary.topWarnings || [];

  return (
    <section className={`rds-card rds-card--${decision}`}>
      <div className="rds-card__top">
        <div>
          <p className="rds-card__eyebrow">Recruiter Decision Summary</p>
          <h2 className="rds-card__title">{summary.label || 'Manual Review Required'}</h2>
          <p className="rds-card__subtitle">{formatLabel(confidence)} confidence report</p>
        </div>
        <div className="rds-card__badges">
          <span className={`rds-badge rds-badge--${decision}`}>{formatLabel(decision)}</span>
          <span className={`rds-badge rds-badge--confidence-${confidence}`}>{formatLabel(confidence)} Confidence</span>
          <span className={`rds-badge rds-badge--risk-${riskLevel}`}>{formatLabel(riskLevel)} Risk</span>
        </div>
      </div>

      {/* One-sentence summary for quick recruiter understanding */}
      {oneSentenceSummary && (
        <p className="rds-card__one-liner">{oneSentenceSummary}</p>
      )}

      {/* Top warnings - most critical items first */}
      {topWarnings.length > 0 && (
        <div className="rds-warnings">
          <h4 className="rds-warnings__title">⚠️ Top Warnings</h4>
          <ul className="rds-warnings__list">
            {topWarnings.map((warning, index) => (
              <li key={index} className="rds-warning-item">{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.shortReason && !oneSentenceSummary && (
        <p className="rds-card__reason">{summary.shortReason}</p>
      )}

      <div className="rds-card__grid">
        <div className="rds-card__section">
          <h3 className="rds-card__section-title">
            {whyThisDecision.length > 0 ? 'Why This Decision' : 'Why'}
          </h3>
          {whyThisDecision.length > 0 ? (
            <ul className="rds-list">
              {whyThisDecision.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          ) : findings.length > 0 ? (
            <ul className="rds-list">
              {findings.map((finding, index) => (
                <li key={index}>{finding}</li>
              ))}
            </ul>
          ) : (
            <p className="rds-muted">No key findings were captured.</p>
          )}
        </div>

        <div className="rds-card__section">
          <h3 className="rds-card__section-title">Recommended Action</h3>
          <p className="rds-action">{summary.recruiterAction || 'Review the report before deciding.'}</p>
          {blockers.length > 0 && (
            <div className="rds-blockers">
              <span className="rds-blockers__label">Blockers</span>
              <div className="rds-blockers__items">
                {blockers.map((blocker, index) => (
                  <span key={index} className="rds-blocker">{blocker}</span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
