import { useState } from 'react';
import PropTypes from 'prop-types';
import {
  AlertCircle, AlertTriangle, Check, ChevronDown, ChevronUp,
  FileText, Loader2, Sparkles, X,
} from 'lucide-react';
import { Actions } from '../wizardReducer';
import { TOTAL_STEPS } from '../wizardConfig';
import { generateDescription } from '../wizardApi';
import {
  Field, StepHeader, Textarea, WizardCard,
} from '../components/FormPrimitives';
import { flattenCandidate, SECTION_ORDER } from '../utils/flattenCandidate';
import { aiErrorTone, mapAiError } from '../utils/aiErrors';
import { cn } from '../../../lib/utils';

/**
 * Step 4 — Job Description.
 * Two tabs: Write Description (textarea) and AI Generate (Gemini → candidates).
 * Selecting a candidate flattens it deterministically (utils/flattenCandidate.js)
 * and switches to the Write tab so the recruiter can edit before continuing.
 */
export default function Step4Description({ state, dispatch }) {
  const [tab, setTab] = useState('write');
  const [appliedBanner, setAppliedBanner] = useState(null);

  const setFields = (fields) => dispatch({ type: Actions.SET_FIELDS, fields });

  const handleManualChange = (e) => {
    setFields({ description: e.target.value, descriptionSource: 'manual' });
    if (appliedBanner) setAppliedBanner(null);
  };

  const handleApplyCandidate = (candidate) => {
    const flat = flattenCandidate(candidate);
    setFields({ description: flat, descriptionSource: 'ai' });
    setTab('write');
    setAppliedBanner('Description applied. You can still edit it before continuing.');
  };

  return (
    <WizardCard>
      <StepHeader
        stepNumber={4}
        totalSteps={TOTAL_STEPS}
        title="Job Description"
        subtitle="Write the description yourself, or let our AI draft 2–3 on-brand variations from the job details and your company context."
      />

      <div
        role="tablist"
        aria-label="Description source"
        className="mb-6 grid grid-cols-2 gap-1.5 rounded-xl border border-[#36d1dc]/15 bg-[#0b0c2a]/60 p-1.5"
      >
        <TabButton active={tab === 'write'} onClick={() => setTab('write')}>
          <FileText size={16} className="mr-2" /> Write Description
        </TabButton>
        <TabButton active={tab === 'ai'} onClick={() => setTab('ai')}>
          <Sparkles size={16} className="mr-2" /> AI Generate
        </TabButton>
      </div>

      {tab === 'write' ? (
        <WriteTab
          description={state.data.description || ''}
          onChange={handleManualChange}
          appliedBanner={appliedBanner}
          onDismissBanner={() => setAppliedBanner(null)}
        />
      ) : (
        <AIGenerateTab state={state} onApplyCandidate={handleApplyCandidate} />
      )}
    </WizardCard>
  );
}

Step4Description.propTypes = {
  state:    PropTypes.object.isRequired,
  dispatch: PropTypes.func.isRequired,
};

// ── Tabs ──────────────────────────────────────────────────────────────────────

function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      role="tab"
      onClick={onClick}
      aria-selected={active}
      className={cn(
        'inline-flex items-center justify-center px-4 py-2.5 rounded-lg text-sm font-semibold transition-all',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5b86e5]/60',
        active
          ? 'bg-gradient-to-br from-[#5b86e5] to-[#36d1dc] text-white shadow-md shadow-[#5b86e5]/20'
          : 'text-slate-300 hover:bg-white/5 hover:text-white'
      )}
    >
      {children}
    </button>
  );
}
TabButton.propTypes = {
  active:   PropTypes.bool,
  onClick:  PropTypes.func.isRequired,
  children: PropTypes.node,
};

// ── Write tab ─────────────────────────────────────────────────────────────────

function WriteTab({ description, onChange, appliedBanner, onDismissBanner }) {
  return (
    <div>
      {appliedBanner && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          <Check size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{appliedBanner}</span>
          <button
            type="button"
            onClick={onDismissBanner}
            aria-label="Dismiss"
            className="text-emerald-300 hover:text-white"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <Field label="Description" required htmlFor="job-description">
        <Textarea
          id="job-description"
          rows={14}
          value={description}
          onChange={onChange}
          placeholder="Enter or paste the job description here…"
        />
      </Field>

      <div className="mt-2 flex justify-between text-xs text-slate-400">
        <span>
          {description.trim().length === 0
            ? 'A description is required to publish.'
            : 'Looks good.'}
        </span>
        <span>{description.length} character{description.length === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}
WriteTab.propTypes = {
  description:     PropTypes.string.isRequired,
  onChange:        PropTypes.func.isRequired,
  appliedBanner:   PropTypes.string,
  onDismissBanner: PropTypes.func.isRequired,
};

// ── AI Generate tab ───────────────────────────────────────────────────────────

function AIGenerateTab({ state, onApplyCandidate }) {
  const [requirements, setRequirements] = useState('');
  const [candidates, setCandidates]     = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError]               = useState(null);

  const hasContext = Boolean(state.data.companyContextId);

  const handleGenerate = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    setError(null);
    try {
      const result = await generateDescription({
        companyContextId: state.data.companyContextId || undefined,
        userRequirements: requirements.trim() || undefined,
        title:            state.data.title || undefined,
        seniorityLevel:   state.data.seniorityLevel || undefined,
        employmentType:   state.data.employmentType || undefined,
        workspaceType:    state.data.workspaceType || undefined,
        location:         state.data.location || undefined,
        salary:           state.data.salary || undefined,
        skills:           state.data.skills?.length ? state.data.skills : undefined,
        languages:        state.data.languages?.length ? state.data.languages : undefined,
      });
      setCandidates(Array.isArray(result) ? result : []);
    } catch (err) {
      setError(mapAiError(err));
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div>
      <div className="mb-5 flex items-start gap-3 rounded-xl border border-[#5b86e5]/30 bg-gradient-to-br from-[#5b86e5]/15 to-[#36d1dc]/10 px-4 py-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#5b86e5] to-[#36d1dc] text-white">
          <Sparkles size={18} />
        </span>
        <div>
          <h4 className="text-sm font-semibold text-white">AI-Powered Job Description Generator</h4>
          <p className="mt-0.5 text-xs text-slate-300">
            Describe skills, responsibilities, culture. We&apos;ll do the rest.
          </p>
        </div>
      </div>

      {!hasContext && (
        <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200 flex items-start gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>
            No Company Context selected. Generation will run with reduced brand context — go back to Step 2 for on-brand results.
          </span>
        </div>
      )}

      <Field
        label="Job Requirements"
        hint="A short brief that anchors generation. The job details from Step 3 (title, seniority, skills, etc.) are sent automatically."
        htmlFor="ai-requirements"
      >
        <Textarea
          id="ai-requirements"
          rows={3}
          value={requirements}
          onChange={(e) => setRequirements(e.target.value)}
          placeholder="e.g. Cloud Engineer position at NextHire to scale our interview infrastructure"
        />
      </Field>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={isGenerating}
          className={cn(
            'inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-gradient-to-br from-[#5b86e5] to-[#36d1dc] text-white font-semibold hover:brightness-110',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          {isGenerating
            ? <Loader2 size={16} className="animate-spin" />
            : <Sparkles size={16} />
          }
          {isGenerating ? 'Generating…' : 'Generate Descriptions'}
        </button>
        {candidates.length > 0 && (
          <span className="text-xs text-slate-400">
            {candidates.length} candidate{candidates.length === 1 ? '' : 's'} generated
          </span>
        )}
      </div>

      {error && <GenerationErrorBanner error={error} onDismiss={() => setError(null)} />}

      {candidates.length > 0 && (
        <div className="mt-6 space-y-3">
          {candidates.map((c, idx) => (
            <CandidateCard
              key={idx}
              index={idx}
              candidate={c}
              onApply={() => onApplyCandidate(c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
AIGenerateTab.propTypes = {
  state:            PropTypes.object.isRequired,
  onApplyCandidate: PropTypes.func.isRequired,
};

// ── Error banner (uses shared mapAiError / aiErrorTone) ───────────────────────

function GenerationErrorBanner({ error, onDismiss }) {
  const baseTone = aiErrorTone(error) === 'warning'
    ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
    : 'border-rose-500/40 bg-rose-500/10 text-rose-200';

  return (
    <div className={cn('mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm', baseTone)}>
      <AlertCircle size={16} className="shrink-0 mt-0.5" />
      <p className="flex-1">{error.message}</p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="opacity-70 hover:opacity-100"
      >
        <X size={14} />
      </button>
    </div>
  );
}
GenerationErrorBanner.propTypes = {
  error:     PropTypes.shape({ kind: PropTypes.string, message: PropTypes.string.isRequired }).isRequired,
  onDismiss: PropTypes.func.isRequired,
};

// ── Candidate card ────────────────────────────────────────────────────────────
//
// The card's visible textual content is structurally identical to what
// flattenCandidate() returns: same section labels, same bullet style, same
// order. Use This Description is therefore a no-surprise action.

function CandidateCard({ candidate, index, onApply }) {
  const [isExpanded, setIsExpanded] = useState(true);

  return (
    <article className="rounded-xl border border-[#36d1dc]/20 bg-[#0b0c2a]/50 p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-[#c9f9ff]">Candidate {index + 1}</h4>
        <button
          type="button"
          onClick={() => setIsExpanded((v) => !v)}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? 'Collapse candidate' : 'Expand candidate'}
          className="text-slate-400 hover:text-slate-200 p-1"
        >
          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
      </div>

      {isExpanded && (
        <div className="mt-3 space-y-4 text-sm">
          {SECTION_ORDER.map((section) => (
            <SectionView key={section.key} section={section} value={candidate[section.key]} />
          ))}
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={onApply}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[#36d1dc]/40 bg-[#131c26] text-[#c9f9ff] font-medium hover:border-[#36d1dc] hover:bg-[#5b86e5]/10"
        >
          <Check size={14} /> Use This Description
        </button>
      </div>
    </article>
  );
}
CandidateCard.propTypes = {
  candidate: PropTypes.object.isRequired,
  index:     PropTypes.number.isRequired,
  onApply:   PropTypes.func.isRequired,
};

function SectionView({ section, value }) {
  if (section.kind === 'bullets') {
    if (!Array.isArray(value) || value.length === 0) return null;
    return (
      <section>
        <h5 className="text-xs font-semibold uppercase tracking-wider text-[#36d1dc]">{section.label}</h5>
        <ul className="mt-1.5 text-slate-200 space-y-1">
          {value.map((item, i) => (
            <li key={i}>• {item}</li>
          ))}
        </ul>
      </section>
    );
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  return (
    <section>
      <h5 className="text-xs font-semibold uppercase tracking-wider text-[#36d1dc]">{section.label}</h5>
      <p className="mt-1.5 text-slate-200 leading-relaxed whitespace-pre-line">{value.trim()}</p>
    </section>
  );
}
SectionView.propTypes = {
  section: PropTypes.shape({
    key:   PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    kind:  PropTypes.oneOf(['paragraph', 'bullets']).isRequired,
  }).isRequired,
  value: PropTypes.any,
};
