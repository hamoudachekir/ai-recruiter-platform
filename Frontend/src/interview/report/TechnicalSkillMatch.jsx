/**
 * TechnicalSkillMatch.jsx
 *
 * Shows matched, missing, strong, and weak skills with skill chip groups.
 */
import './TechnicalSkillMatch.css';

function SkillGroup({ label, skills, variant }) {
  if (!Array.isArray(skills) || skills.length === 0) return null;
  return (
    <div className={`tsm-group tsm-group--${variant}`}>
      <span className="tsm-group-label">{label}</span>
      <div className="tsm-chips">
        {skills.map((skill, i) => (
          <span key={`${skill}-${i}`} className={`tsm-chip tsm-chip--${variant}`}>
            {skill}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function TechnicalSkillMatch({ analysis }) {
  if (!analysis) {
    return <p className="tsm-empty">Technical analysis not available.</p>;
  }

  const { detectedSkills = [], matchedSkills = [], missingSkills = [], strengths = [], weaknesses = [] } = analysis;

  return (
    <div className="tsm-root" id="technical-skill-match">
      {/* Summary bar */}
      <div className="tsm-summary">
        <div className="tsm-stat">
          <span className="tsm-stat-num tsm-stat-num--blue">{detectedSkills.length}</span>
          <span className="tsm-stat-label">Skills Detected</span>
        </div>
        <div className="tsm-stat">
          <span className="tsm-stat-num tsm-stat-num--green">{matchedSkills.length}</span>
          <span className="tsm-stat-label">Matched</span>
        </div>
        <div className="tsm-stat">
          <span className="tsm-stat-num tsm-stat-num--red">{missingSkills.length}</span>
          <span className="tsm-stat-label">Missing</span>
        </div>
        <div className="tsm-stat">
          <span className="tsm-stat-num tsm-stat-num--emerald">{strengths.length}</span>
          <span className="tsm-stat-label">Strong</span>
        </div>
        <div className="tsm-stat">
          <span className="tsm-stat-num tsm-stat-num--amber">{weaknesses.length}</span>
          <span className="tsm-stat-label">Needs Work</span>
        </div>
      </div>

      <div className="tsm-groups">
        <SkillGroup label="✅ Matched Skills" skills={matchedSkills} variant="matched" />
        <SkillGroup label="❌ Missing Skills" skills={missingSkills} variant="missing" />
        <SkillGroup label="⭐ Strong Skills" skills={strengths} variant="strong" />
        <SkillGroup label="⚡ Needs Improvement" skills={weaknesses} variant="weak" />
        {detectedSkills.length > 0 && matchedSkills.length === 0 && missingSkills.length === 0 && (
          <SkillGroup label="🔍 All Detected Skills" skills={detectedSkills} variant="detected" />
        )}
      </div>

      {detectedSkills.length === 0 && missingSkills.length === 0 && (
        <div className="tsm-no-data">
          <p>No skill data was extracted from the transcript. This may occur when transcript capture was unavailable.</p>
        </div>
      )}
    </div>
  );
}
