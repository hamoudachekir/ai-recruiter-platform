import './ReportQualityCard.css';

const LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export default function ReportQualityCard({ quality }) {
  if (!quality) return null;

  const confidence = String(quality.confidence || 'low').toLowerCase();
  const reasons = quality.reasons || [];
  const missingData = quality.missingData || [];
  const warnings = quality.warnings || [];

  return (
    <section className={`rqc-card rqc-card--${confidence}`}>
      <div className="rqc-head">
        <div>
          <span className="rqc-kicker">Report Quality</span>
          <h3 className="rqc-title">Confidence: {LABELS[confidence] || quality.confidence}</h3>
        </div>
        <span className={`rqc-pill rqc-pill--${quality.isReliableForDecision ? 'ok' : 'review'}`}>
          {quality.isReliableForDecision ? 'Reliable for decision support' : 'Manual review required'}
        </span>
      </div>

      {[...warnings, ...reasons].length > 0 && (
        <div className="rqc-list">
          {[...warnings, ...reasons].map((item, index) => (
            <p key={`${item}-${index}`} className="rqc-item">{item}</p>
          ))}
        </div>
      )}

      {missingData.length > 0 && (
        <div className="rqc-missing">
          <span className="rqc-missing__label">Missing data</span>
          <div className="rqc-tags">
            {missingData.map((item) => (
              <span key={item} className="rqc-tag">{item}</span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
