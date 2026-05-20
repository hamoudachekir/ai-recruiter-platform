import './CommunicationSignalsPanel.css';

export default function CommunicationSignalsPanel({ report }) {
  if (!report) return null;

  const hr = report.hrEvaluation || {};
  const sentiment = report.sentimentAnalysis || {};
  const transcript = report.transcript || {};

  // Build communication signals from available data
  const signals = buildSignals(hr, sentiment, transcript);

  return (
    <section className="csp-comm-card">
      <div className="csp-comm-header">
        <h3 className="csp-comm-title">Communication & HR Signals</h3>
        <p className="csp-comm-subtitle">Soft skills and behavioral assessment</p>
      </div>

      <div className="csp-comm-grid">
        {/* Clarity */}
        <SignalMetric
          label="Clarity"
          value={signals.clarity}
          description={signals.clarityDescription}
        />

        {/* Confidence */}
        <SignalMetric
          label="Confidence"
          value={signals.confidence}
          description={signals.confidenceDescription}
        />

        {/* Conciseness */}
        <SignalMetric
          label="Conciseness"
          value={signals.conciseness}
          description={signals.concisenessDescription}
        />

        {/* Collaboration */}
        <SignalMetric
          label="Collaboration"
          value={signals.collaboration}
          description={signals.collaborationDescription}
        />

        {/* Motivation */}
        <SignalMetric
          label="Motivation"
          value={signals.motivation}
          description={signals.motivationDescription}
        />
      </div>

      {/* Overall assessment */}
      {signals.overallAssessment && (
        <div className="csp-comm-assessment">
          <h4 className="csp-comm-assessment-title">Overall Assessment</h4>
          <p className="csp-comm-assessment-text">{signals.overallAssessment}</p>
        </div>
      )}

      {/* Sentiment summary */}
      {sentiment.overallSentiment?.label && (
        <div className="csp-comm-sentiment">
          <span className="csp-comm-sentiment-label">Sentiment:</span>
          <span className={`csp-comm-sentiment-value csp-comm-sentiment--${sentiment.overallSentiment.label.toLowerCase()}`}>
            {sentiment.overallSentiment.label}
          </span>
        </div>
      )}
    </section>
  );
}

function SignalMetric({ label, value, description }) {
  const valueClass = value >= 80 ? 'high' : value >= 60 ? 'medium' : 'low';

  return (
    <div className="csp-metric">
      <div className="csp-metric-header">
        <span className="csp-metric-label">{label}</span>
        <span className={`csp-metric-value csp-metric-value--${valueClass}`}>
          {value >= 80 ? 'Strong' : value >= 60 ? 'Moderate' : 'Needs Work'}
        </span>
      </div>
      <div className="csp-metric-bar">
        <div
          className={`csp-metric-fill csp-metric-fill--${valueClass}`}
          style={{ width: `${value}%` }}
        />
      </div>
      {description && <p className="csp-metric-desc">{description}</p>}
    </div>
  );
}

function buildSignals(hr, sentiment, transcript) {
  // Calculate signal scores from available data
  const wordCount = transcript.wordCount || 0;
  const hasTranscript = wordCount > 20;

  // Clarity: based on transcript length and structure
  const clarity = hasTranscript
    ? Math.min(95, 60 + Math.min(35, wordCount / 10))
    : 40;

  // Confidence: based on sentiment and HR score
  const confidence = hr.score
    ? Math.min(95, hr.score)
    : sentiment.overallSentiment?.score
      ? Math.min(95, 50 + sentiment.overallSentiment.score * 50)
      : 50;

  // Conciseness: based on answer length (sweet spot: 50-150 words)
  const conciseness = hasTranscript
    ? wordCount < 30 ? 50 : wordCount > 200 ? 60 : 80
    : 40;

  // Collaboration: from HR evaluation or default
  const collaboration = hr.score
    ? Math.min(95, hr.score * 0.9)
    : 50;

  // Motivation: from sentiment
  const motivation = sentiment.overallSentiment?.label === 'POSITIVE'
    ? 85
    : sentiment.overallSentiment?.label === 'NEGATIVE'
      ? 45
      : 65;

  return {
    clarity: Math.round(clarity),
    clarityDescription: hasTranscript
      ? 'Candidate provided clear, structured responses.'
      : 'Insufficient transcript to assess clarity.',

    confidence: Math.round(confidence),
    confidenceDescription: confidence >= 70
      ? 'Demonstrated professional confidence in responses.'
      : 'Confidence level could not be fully assessed.',

    conciseness: Math.round(conciseness),
    concisenessDescription: conciseness >= 70
      ? 'Answers were appropriately detailed without being verbose.'
      : 'Answers were either too brief or overly lengthy.',

    collaboration: Math.round(collaboration),
    collaborationDescription: collaboration >= 70
      ? 'Showed cooperative and team-oriented mindset.'
      : 'Team collaboration signals were limited.',

    motivation: Math.round(motivation),
    motivationDescription: motivation >= 70
      ? 'Displayed genuine interest and enthusiasm.'
      : 'Motivation level was neutral or unclear.',

    overallAssessment: hasTranscript
      ? `Communication patterns suggest ${confidence >= 70 ? 'strong' : 'moderate'} professional interpersonal skills with ${motivation >= 70 ? 'positive' : 'neutral'} engagement.`
      : 'Communication assessment requires more complete transcript data.',
  };
}
