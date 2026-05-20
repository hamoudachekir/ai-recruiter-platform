/**
 * SkillsExtractedPanel.jsx
 *
 * Shows detected skills (from candidate answers only),
 * missing/unverified skills, evidence snippets, grouped by category.
 */
import './SkillsExtractedPanel.css';

function ConfidenceDot({ confidence }) {
  const map = { high: '#22c55e', medium: '#f59e0b', low: '#ef4444' };
  return (
    <span
      className="sep-confidence-dot"
      style={{ background: map[confidence] || '#9ca3af' }}
      title={`Confidence: ${confidence}`}
    />
  );
}

function SkillCard({ item }) {
  return (
    <div className="sep-skill-card">
      <div className="sep-skill-card__top">
        <ConfidenceDot confidence={item.confidence} />
        <span className="sep-skill-card__name">{item.skill}</span>
        <span className="sep-skill-card__mentions">{item.mentions}x</span>
      </div>
      {Array.isArray(item.evidence) && item.evidence.length > 0 && (
        <p className="sep-skill-card__evidence">
          &ldquo;{item.evidence[0].slice(0, 120)}&hellip;&rdquo;
        </p>
      )}
    </div>
  );
}

const CATEGORY_LABELS = {
  frontend:   '🖥 Frontend',
  backend:    '⚙️ Backend',
  database:   '🗄 Database',
  devops:     '🔧 DevOps',
  cloud:      '☁️ Cloud',
  process:    '📋 Process / API',
  ai_ml:      '🤖 AI / ML',
  softSkills: '🤝 Soft Skills',
};

export default function SkillsExtractedPanel({ report }) {
  if (!report) return null;

  const data = report.skillsExtractedFromInterview;
  if (!data) return null;

  const detected = data.detectedSkills || [];
  const missing  = data.missingFromInterview || [];
  const categories = data.categories || {};
  const note = data.note;

  if (detected.length === 0 && missing.length === 0) {
    return (
      <section className="sep-root">
        <div className="sep-header">
          <p className="sep-eyebrow">Skills Extraction</p>
          <h3 className="sep-title">Skills Extracted from Interview</h3>
        </div>
        <div className="sep-empty">
          <span className="sep-empty__icon">🔍</span>
          <p>{note || 'No skills were detected in candidate answers.'}</p>
        </div>
      </section>
    );
  }

  // Group detected skills by category
  const filledCategories = Object.entries(CATEGORY_LABELS).filter(
    ([key]) => Array.isArray(categories[key]) && categories[key].length > 0
  );

  return (
    <section className="sep-root">
      <div className="sep-header">
        <div>
          <p className="sep-eyebrow">Skills Extraction</p>
          <h3 className="sep-title">Skills Extracted from Interview</h3>
          <p className="sep-subtitle">
            Based on candidate answers only. Skills mentioned only by the AI are excluded.
          </p>
        </div>
        <div className="sep-summary">
          <div className="sep-stat">
            <span className="sep-stat__value sep-stat__value--green">{detected.length}</span>
            <span className="sep-stat__label">Detected</span>
          </div>
          <div className="sep-stat">
            <span className="sep-stat__value sep-stat__value--red">{missing.length}</span>
            <span className="sep-stat__label">Missing</span>
          </div>
        </div>
      </div>

      {/* By category */}
      {filledCategories.length > 0 && (
        <div className="sep-categories">
          {filledCategories.map(([key, label]) => (
            <div key={key} className="sep-category">
              <h4 className="sep-category__label">{label}</h4>
              <div className="sep-category__chips">
                {categories[key].map(skill => (
                  <span key={skill} className="sep-chip sep-chip--detected">{skill}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detailed cards */}
      {detected.length > 0 && (
        <div className="sep-section">
          <h4 className="sep-section__title">Detected Skills with Evidence</h4>
          <div className="sep-skill-grid">
            {detected.map(item => (
              <SkillCard key={item.skill} item={item} />
            ))}
          </div>
          <div className="sep-legend">
            <span><span className="sep-confidence-dot" style={{ background: '#22c55e' }} /> High confidence (3+ mentions)</span>
            <span><span className="sep-confidence-dot" style={{ background: '#f59e0b' }} /> Medium (2 mentions)</span>
            <span><span className="sep-confidence-dot" style={{ background: '#ef4444' }} /> Low (1 mention)</span>
          </div>
        </div>
      )}

      {/* Missing skills */}
      {missing.length > 0 && (
        <div className="sep-section">
          <h4 className="sep-section__title">Missing or Unverified Job Skills</h4>
          <p className="sep-section__sub">
            These skills are required by the job but were not mentioned in candidate answers.
          </p>
          <div className="sep-missing-chips">
            {missing.map(skill => (
              <span key={skill} className="sep-chip sep-chip--missing">{skill}</span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
