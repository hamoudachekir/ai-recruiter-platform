import { useMemo } from "react";
import "./SkillsEvidencePanel.css";

import { detectSkillsFromTranscript } from "./detectSkillsFromTranscript";

export default function SkillsEvidencePanel({ report, job, room }) {
  // Source 1 — what the backend pipeline already extracted.
  const backendDemonstrated = report?.technicalEvaluation?.demonstratedSkills || [];
  const backendMentioned = report?.technicalEvaluation?.mentionedSkills || [];
  const backendMatched = report?.jobFitAnalysis?.matchedSkills || [];
  const backendMissing = report?.jobFitAnalysis?.missingOrUnverifiedSkills || [];

  const backendHasAny =
    backendDemonstrated.length > 0 ||
    backendMentioned.length > 0 ||
    backendMatched.length > 0;

  // Source 2 — client-side detection from the transcript when the backend
  // returned nothing. Job's required skills (when available) are used to
  // populate matched / missing.
  const jobSkills = useMemo(() => {
    const fromJobProp = Array.isArray(job?.skills) ? job.skills : [];
    const fromRoomJob = Array.isArray(room?.job?.skills) ? room.job.skills : [];
    const fromReport = Array.isArray(report?.jobRequiredSkills)
      ? report.jobRequiredSkills
      : [];
    // Dedupe while preserving order.
    const seen = new Set();
    return [...fromJobProp, ...fromRoomJob, ...fromReport].filter((s) => {
      const k = String(s).trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [job, room, report]);

  const detected = useMemo(
    () => (backendHasAny ? null : detectSkillsFromTranscript(report, jobSkills)),
    [backendHasAny, report, jobSkills],
  );

  if (!report) return null;

  const demonstrated = backendHasAny
    ? backendDemonstrated
    : detected?.demonstrated || [];
  const mentioned = backendHasAny ? backendMentioned : detected?.mentioned || [];
  const matched = backendHasAny ? backendMatched : detected?.matched || [];
  const missing = backendHasAny ? backendMissing : detected?.missing || [];

  const fallbackUsed = !backendHasAny && (detected?.detectedFromTranscript || false);
  const hasAnySkills =
    demonstrated.length > 0 || mentioned.length > 0 || matched.length > 0;

  return (
    <section className="sep-card">
      <div className="sep-header">
        <h3 className="sep-title">Skills & Technical Evidence</h3>
        <p className="sep-subtitle">
          What the candidate demonstrated during the interview
          {fallbackUsed && (
            <span className="sep-badge" title="Skills extracted from the interview transcript on the client.">
              · auto-detected from transcript
            </span>
          )}
        </p>
      </div>

      {!hasAnySkills ? (
        <div className="sep-empty">
          <p>No specific skills detected in the interview transcript.</p>
          <p className="sep-hint">
            {fallbackUsed
              ? "The candidate's answers did not contain known technical keywords. Review the recording manually."
              : "Review the recording manually to assess technical skills."}
          </p>
        </div>
      ) : (
        <div className="sep-grid">
          {/* Demonstrated Skills */}
          {demonstrated.length > 0 && (
            <div className="sep-category">
              <h4 className="sep-category-title">
                <span className="sep-icon sep-icon--demonstrated">✓</span>
                Demonstrated Skills
              </h4>
              <div className="sep-skills">
                {demonstrated.map((skill) => (
                  <span
                    key={`d-${skill}`}
                    className="sep-skill sep-skill--demonstrated"
                  >
                    {skill}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Matched Skills (from job fit) */}
          {matched.length > 0 && (
            <div className="sep-category">
              <h4 className="sep-category-title">
                <span className="sep-icon sep-icon--matched">★</span>
                Job-Matched Skills
              </h4>
              <div className="sep-skills">
                {matched.map((skill) => (
                  <span
                    key={`m-${skill}`}
                    className="sep-skill sep-skill--matched"
                  >
                    {skill}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Mentioned but Not Verified */}
          {mentioned.length > 0 && (
            <div className="sep-category">
              <h4 className="sep-category-title">
                <span className="sep-icon sep-icon--mentioned">~</span>
                Mentioned (Not Verified)
              </h4>
              <div className="sep-skills">
                {mentioned.map((skill) => (
                  <span
                    key={`men-${skill}`}
                    className="sep-skill sep-skill--mentioned"
                  >
                    {skill}
                  </span>
                ))}
              </div>
              <p className="sep-note">
                Candidate mentioned these but did not clearly demonstrate them.
              </p>
            </div>
          )}

          {/* Missing Skills */}
          {missing.length > 0 && (
            <div className="sep-category">
              <h4 className="sep-category-title">
                <span className="sep-icon sep-icon--missing">✗</span>
                Missing for Role
              </h4>
              <div className="sep-skills">
                {missing.map((skill) => (
                  <span
                    key={`mis-${skill}`}
                    className="sep-skill sep-skill--missing"
                  >
                    {skill}
                  </span>
                ))}
              </div>
              <p className="sep-note">
                Required skills not demonstrated in this interview.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
