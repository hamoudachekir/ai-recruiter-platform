/**
 * RecruiterDecisionBox.jsx
 *
 * Lets the recruiter accept, reject, or mark a candidate for review.
 *
 * Rules enforced by design:
 *  - No action is taken automatically.
 *  - All three buttons always visible — recruiter chooses.
 *  - Notes field is provided for context.
 *  - Reject button requires an extra confirmation step.
 */
import { useState } from 'react';
import './RecruiterDecisionBox.css';

const STATUS_LABELS = {
  pending:      { label: 'Pending', icon: '⏳', className: 'rdb-status--pending' },
  accepted:     { label: 'Accepted', icon: '✅', className: 'rdb-status--accepted' },
  rejected:     { label: 'Not Progressing', icon: '⛔', className: 'rdb-status--rejected' },
  needs_review: { label: 'Needs Review', icon: '🔍', className: 'rdb-status--review' },
};

export default function RecruiterDecisionBox({ currentDecision, recommendation, onSubmit }) {
  const [notes, setNotes] = useState(currentDecision?.notes || '');
  const [rejectConfirm, setRejectConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const existing = currentDecision?.status;
  const existingConfig = STATUS_LABELS[existing] || STATUS_LABELS.pending;

  const handleSubmit = async (status) => {
    setSubmitting(true);
    try {
      await onSubmit?.(status, notes);
    } finally {
      setSubmitting(false);
      setRejectConfirm(false);
    }
  };

  return (
    <div className="rdb-root" id="recruiter-decision-box">
      {/* ── AI suggestion ── */}
      {recommendation && (
        <div className="rdb-suggestion">
          <span className="rdb-suggestion-label">AI Evaluation Suggestion</span>
          <span className={`rdb-suggestion-value rdb-suggestion--${recommendation.status}`}>
            {recommendation.status === 'recommended'   ? '✅ Recommended' :
             recommendation.status === 'needs_review'  ? '🔍 Needs Review' :
                                                         '⚠️ Not Recommended'}
          </span>
          <span className="rdb-suggestion-note">
            This is a suggestion only. The final decision belongs to the recruiter.
          </span>
        </div>
      )}

      {/* ── Current status ── */}
      {existing && existing !== 'pending' && (
        <div className={`rdb-current ${existingConfig.className}`}>
          <span className="rdb-current-icon">{existingConfig.icon}</span>
          <div>
            <div className="rdb-current-label">Current Decision</div>
            <div className="rdb-current-value">{existingConfig.label}</div>
            {currentDecision?.decidedAt && (
              <div className="rdb-current-time">
                {new Date(currentDecision.decidedAt).toLocaleString()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Notes ── */}
      <div className="rdb-notes-wrap">
        <label className="rdb-notes-label" htmlFor="rdb-notes">
          Recruiter Notes <span className="rdb-notes-optional">(optional)</span>
        </label>
        <textarea
          id="rdb-notes"
          className="rdb-notes"
          value={notes}
          onChange={e => setNotes(e.target.value)}
          placeholder="Add context, observations, or follow-up actions…"
          rows={4}
        />
        <p className="rdb-notes-hint">
          Notes are saved alongside the decision and visible only to your team.
        </p>
      </div>

      {/* ── Decision buttons ── */}
      <div className="rdb-actions">
        <button
          id="rdb-btn-accept"
          className="rdb-btn rdb-btn--accept"
          onClick={() => handleSubmit('accepted')}
          disabled={submitting}
        >
          ✅ Accept Candidate
        </button>

        <button
          id="rdb-btn-review"
          className="rdb-btn rdb-btn--review"
          onClick={() => handleSubmit('needs_review')}
          disabled={submitting}
        >
          🔍 Mark for Review
        </button>

        {!rejectConfirm ? (
          <button
            id="rdb-btn-reject-init"
            className="rdb-btn rdb-btn--reject-init"
            onClick={() => setRejectConfirm(true)}
            disabled={submitting}
          >
            ⛔ Not Progressing
          </button>
        ) : (
          <div className="rdb-reject-confirm">
            <p>Are you sure? This marks the candidate as not progressing. They are not auto-rejected by the AI.</p>
            <div className="rdb-reject-confirm-actions">
              <button
                id="rdb-btn-reject-confirm"
                className="rdb-btn rdb-btn--reject"
                onClick={() => handleSubmit('rejected')}
                disabled={submitting}
              >
                Confirm — Not Progressing
              </button>
              <button
                className="rdb-btn rdb-btn--cancel"
                onClick={() => setRejectConfirm(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="rdb-footer-note">
        🔒 All decisions are logged with a timestamp. No decision is made automatically by the AI system.
      </div>
    </div>
  );
}
