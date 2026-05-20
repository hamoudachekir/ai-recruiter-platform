/**
 * EvaluationsPanel.jsx
 *
 * Displays technical and HR evaluation in recruiter-friendly language.
 */
import './EvaluationsPanel.css';

export default function EvaluationsPanel({ report }) {
  if (!report) return null;

  const { technicalEvaluation, hrEvaluation } = report;
  const transcript = report.transcript || {};
  const audio = report.audioAnalysis || {};
  const transcriptText = String(transcript.fullText || transcript.text || '');
  const transcriptSegments = transcript.segments || audio.segments || [];
  const hasUsableTranscript = transcriptText.trim().length > 30 || transcriptSegments.length > 0;
  const technicalIsFallback = technicalEvaluation?.source === 'fallback';
  const hrUnavailable = !hrEvaluation || hrEvaluation.score == null || hrEvaluation.source === 'unavailable';

  const renderSource = (evaluation) => evaluation && (
    <div className="eval-source-row">
      <span>Source: <strong>{evaluation.source || 'deterministic'}</strong></span>
      <span>Confidence: <strong>{evaluation.confidence || 'low'}</strong></span>
    </div>
  );

  const renderStrengthsWeaknesses = (strengths, weaknesses) => {
    if (!hasUsableTranscript || (!(strengths?.length) && !(weaknesses?.length))) {
      return null;
    }

    return (
      <div className="eval-sw">
        {strengths && strengths.length > 0 && (
          <div className="eval-sw__section">
            <h5 className="eval-sw__title eval-sw__title--strengths">Strengths</h5>
            <ul className="eval-sw__list">
              {strengths.map((s, i) => (
                <li key={i} className="eval-sw__item eval-sw__item--strength">{s}</li>
              ))}
            </ul>
          </div>
        )}

        {weaknesses && weaknesses.length > 0 && (
          <div className="eval-sw__section">
            <h5 className="eval-sw__title eval-sw__title--weaknesses">Areas to Explore</h5>
            <ul className="eval-sw__list">
              {weaknesses.map((w, i) => (
                <li key={i} className="eval-sw__item eval-sw__item--weakness">{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="evaluations-panel">
      <h3 className="evaluations-panel__title">Candidate Evaluation</h3>

      {!hasUsableTranscript && (
        <div className="evaluations-limited">
          Candidate evaluation is limited because no usable transcript content was extracted.
        </div>
      )}

      <div className="evaluations-grid">
        <div className={`eval-card eval-card--technical ${!hasUsableTranscript ? 'eval-card--limited' : ''}`}>
          <div className="eval-card__header">
            <span className="eval-card__icon">Tech</span>
            <div className="eval-card__title-group">
              <h4 className="eval-card__title">Technical Evaluation</h4>
              {technicalEvaluation?.score != null ? (
                <span className="eval-card__score">
                  Score: <strong>{technicalEvaluation.score}</strong>/100
                </span>
              ) : (
                <span className="eval-card__score eval-card__score--muted">Not enough evidence</span>
              )}
            </div>
          </div>

          <div className="eval-card__content">
            {technicalIsFallback && (
              <span className="eval-badge eval-badge--fallback">Fallback score</span>
            )}
            {renderSource(technicalEvaluation)}
            {technicalIsFallback && (
              <p className="eval-meaning">
                This score is a default baseline and should not be used alone for hiring decisions.
              </p>
            )}
            {technicalEvaluation?.explanation && (
              <p className="eval-explanation">{technicalEvaluation.explanation}</p>
            )}
            {technicalEvaluation?.summary && (
              <div className="eval-summary">
                <h5 className="eval-summary__title">Summary</h5>
                <p className="eval-summary__text">{technicalEvaluation.summary}</p>
              </div>
            )}

            {technicalEvaluation?.technicalInsights && hasUsableTranscript && (
              <div className="eval-insights">
                <h5 className="eval-insights__title">Technical Insights</h5>
                <p className="eval-insights__text">{technicalEvaluation.technicalInsights}</p>
              </div>
            )}

            {renderStrengthsWeaknesses(
              technicalEvaluation?.strengths,
              technicalEvaluation?.weaknesses
            )}

            {!technicalEvaluation && (
              <p className="eval-card__empty">Technical evaluation not available.</p>
            )}
          </div>
        </div>

        <div className={`eval-card eval-card--hr ${hrUnavailable ? 'eval-card--limited' : ''}`}>
          <div className="eval-card__header">
            <span className="eval-card__icon">HR</span>
            <div className="eval-card__title-group">
              <h4 className="eval-card__title">HR Evaluation</h4>
              {hrEvaluation?.score != null ? (
                <span className="eval-card__score">
                  Score: <strong>{hrEvaluation.score}</strong>/100
                </span>
              ) : (
                <span className="eval-card__score eval-card__score--muted">Not enough evidence</span>
              )}
            </div>
          </div>

          <div className="eval-card__content">
            {renderSource(hrEvaluation)}
            {hrUnavailable && (
              <div className="eval-unavailable">
                Not enough evidence to evaluate communication, motivation, teamwork, or problem-solving.
              </div>
            )}
            {hrEvaluation?.explanation && (
              <p className="eval-explanation">{hrEvaluation.explanation}</p>
            )}
            {hrEvaluation?.summary && !hrUnavailable && (
              <div className="eval-summary">
                <h5 className="eval-summary__title">Summary</h5>
                <p className="eval-summary__text">{hrEvaluation.summary}</p>
              </div>
            )}

            {hrEvaluation?.hrInsights && hasUsableTranscript && (
              <div className="eval-insights">
                <h5 className="eval-insights__title">HR Insights</h5>
                <p className="eval-insights__text">{hrEvaluation.hrInsights}</p>
              </div>
            )}

            {hrEvaluation?.communicationAnalysis?.summary && !hrUnavailable && (
              <div className="eval-comm">
                <h5 className="eval-comm__title">Communication Analysis</h5>
                <p className="eval-comm__text">{hrEvaluation.communicationAnalysis.summary}</p>
              </div>
            )}

            {!hrUnavailable && renderStrengthsWeaknesses(
              hrEvaluation?.strengths,
              hrEvaluation?.weaknesses
            )}

            {!hrEvaluation && (
              <p className="eval-card__empty">HR evaluation not available.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
