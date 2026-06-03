import { useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { AlertCircle, Check, Edit3, ExternalLink, Pencil } from 'lucide-react';
import { Actions, isStepSkipped } from '../wizardReducer';
import { TOTAL_STEPS } from '../wizardConfig';
import { listCompanyContexts, listDepartments } from '../wizardApi';
import { StepHeader, WizardCard } from '../components/FormPrimitives';
import { cn } from '../../../lib/utils';

const FIELD_LABELS = {
  departmentId:        'Department',
  companyContextId:    'Company Context',
  title:               'Job Title',
  location:            'Location',
  interviewLanguage:   'Interview Language',
  seniorityLevel:      'Seniority Level',
  employmentType:      'Employment Type',
  workspaceType:       'Workspace Type',
  description:         'Job Description',
  predefinedQuestions: 'Custom Questions',
};

const MISSING_TO_STEP = {
  departmentId:        1,
  companyContextId:    2,
  title:               3,
  location:            3,
  interviewLanguage:   3,
  seniorityLevel:      3,
  employmentType:      3,
  workspaceType:       3,
  description:         4,
  predefinedQuestions: 6,
};

const INTERVIEW_TYPE_LABEL = {
  ai_dynamic: 'AI-Powered Dynamic Interview',
  hybrid:     'Hybrid Interview',
  predefined: 'Pre-defined Questions',
};

const STAGE_LABEL = { beginning: 'Beginning', middle: 'Middle', end: 'End' };

/**
 * Step 8 — Review & Publish.
 * Read-only summary cards grouped by step with per-card Edit links.
 * Surfaces server-side missing fields from PUBLISH_ERROR as a banner
 * with Go-to-step buttons. Publish itself is triggered from the WizardFooter.
 */
export default function Step8ReviewPublish({ state, dispatch }) {
  const { data, missingFields } = state;

  const [departments, setDepartments] = useState([]);
  const [contexts, setContexts]       = useState([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listDepartments(), listCompanyContexts()])
      .then(([deps, ctxs]) => {
        if (cancelled) return;
        setDepartments(deps || []);
        setContexts(ctxs || []);
      })
      .catch(() => { /* silent — names just won't resolve */ });
    return () => { cancelled = true; };
  }, []);

  const department = useMemo(
    () => departments.find((d) => d._id === data.departmentId),
    [departments, data.departmentId]
  );
  const context = useMemo(
    () => contexts.find((c) => c._id === data.companyContextId),
    [contexts, data.companyContextId]
  );

  const stepsWithMissing = useMemo(() => {
    const s = new Set();
    for (const f of missingFields || []) if (MISSING_TO_STEP[f]) s.add(MISSING_TO_STEP[f]);
    return s;
  }, [missingFields]);

  const goTo = (step) => dispatch({ type: Actions.GO_TO_STEP, step });
  const step6Skipped = isStepSkipped(6, data);

  return (
    <div className="space-y-4">
      <StepHeader
        stepNumber={8}
        totalSteps={TOTAL_STEPS}
        title="Review & Publish"
        subtitle="Final read-through. Click Edit on any card to jump back, or Publish to go live."
      />

      {missingFields.length > 0 && (
        <MissingFieldsBanner missing={missingFields} onGoTo={goTo} />
      )}

      <SummaryCard title="Department" step={1} invalid={stepsWithMissing.has(1)} onEdit={goTo}>
        {department ? (
          <div>
            <p className="text-slate-100 font-medium">{department.name}</p>
            {department.description && (
              <p className="text-sm text-slate-400 mt-1">{department.description}</p>
            )}
          </div>
        ) : (
          <Muted>Not selected</Muted>
        )}
      </SummaryCard>

      <SummaryCard title="Company Context" step={2} invalid={stepsWithMissing.has(2)} onEdit={goTo}>
        {context ? <ContextSummary context={context} /> : <Muted>Not selected</Muted>}
      </SummaryCard>

      <SummaryCard title="Job Details" step={3} invalid={stepsWithMissing.has(3)} onEdit={goTo}>
        <JobDetailsSummary data={data} />
      </SummaryCard>

      <SummaryCard title="Description" step={4} invalid={stepsWithMissing.has(4)} onEdit={goTo}>
        <DescriptionSummary description={data.description} source={data.descriptionSource} />
      </SummaryCard>

      <SummaryCard title="Interview Type" step={5} onEdit={goTo}>
        <p className="text-slate-100 font-medium">
          {INTERVIEW_TYPE_LABEL[data.interviewType] || data.interviewType || 'Not selected'}
        </p>
      </SummaryCard>

      {!step6Skipped && (
        <SummaryCard title="Questions" step={6} invalid={stepsWithMissing.has(6)} onEdit={goTo}>
          <QuestionsSummary
            questions={data.predefinedQuestions}
            interviewType={data.interviewType}
          />
        </SummaryCard>
      )}

      <SummaryCard title="Evaluation" step={7} onEdit={goTo}>
        <EvaluationSummary config={data.evaluationConfig} />
      </SummaryCard>
    </div>
  );
}
Step8ReviewPublish.propTypes = {
  state:    PropTypes.object.isRequired,
  dispatch: PropTypes.func.isRequired,
};

// ── Summary card shell ────────────────────────────────────────────────────────

function SummaryCard({ title, step, invalid, onEdit, children }) {
  return (
    <article
      className={cn(
        'rounded-xl border p-5 transition-colors',
        invalid
          ? 'border-rose-500/40 bg-rose-500/5'
          : 'border-[#36d1dc]/15 bg-[#131c26]/70'
      )}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-[#36d1dc] font-semibold">
            Step {step}{invalid && <span className="ml-2 text-rose-300">Missing required</span>}
          </p>
          <h3 className="mt-0.5 text-lg font-semibold text-white">{title}</h3>
        </div>
        <button
          type="button"
          onClick={() => onEdit(step)}
          className="inline-flex items-center gap-1 text-sm text-[#36d1dc] hover:text-[#c9f9ff]"
        >
          <Pencil size={12} /> Edit
        </button>
      </div>
      {children}
    </article>
  );
}
SummaryCard.propTypes = {
  title:    PropTypes.string.isRequired,
  step:     PropTypes.number.isRequired,
  invalid:  PropTypes.bool,
  onEdit:   PropTypes.func.isRequired,
  children: PropTypes.node,
};

// ── Section summaries ─────────────────────────────────────────────────────────

function ContextSummary({ context }) {
  const colors = context.brandColors || {};
  const colorKeys = ['primary', 'secondary', 'accent'].filter((k) => colors[k]);
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-slate-100 font-medium">{context.name}</p>
          {context.industry && <p className="text-xs text-slate-400 mt-0.5">{context.industry}</p>}
        </div>
        {context.website && (
          <a
            href={context.website}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-[#36d1dc] hover:underline shrink-0"
          >
            <ExternalLink size={12} /> Visit
          </a>
        )}
      </div>
      {context.description && (
        <p className="mt-2 text-sm text-slate-300 leading-relaxed line-clamp-3">{context.description}</p>
      )}
      {colorKeys.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-3">
          {colorKeys.map((k) => (
            <div key={k} className="flex items-center gap-1.5">
              <span
                className="inline-block w-4 h-4 rounded border border-white/10"
                style={{ backgroundColor: colors[k] }}
                aria-hidden="true"
              />
              <span className="text-xs text-slate-400 font-mono">{colors[k]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
ContextSummary.propTypes = { context: PropTypes.object.isRequired };

function JobDetailsSummary({ data }) {
  const rows = [
    ['Title',             data.title],
    ['Company',           data.companyName],
    ['Location',          data.location],
    ['Salary',            data.salary ? `€${data.salary}` : null],
    ['Interview Language', data.interviewLanguage],
    ['Seniority',         data.seniorityLevel],
    ['Employment Type',   data.employmentType],
    ['Workspace',         data.workspaceType],
    ['Record video',      data.recordApplicantVideo ? 'Yes' : 'No'],
  ].filter(([, v]) => v != null && v !== '');

  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-slate-400">{label}</dt>
            <dd className="text-slate-100 text-right">{value}</dd>
          </div>
        ))}
      </dl>
      {(data.languages?.length > 0 || data.skills?.length > 0) && (
        <div className="mt-3 pt-3 border-t border-[#36d1dc]/10 space-y-2">
          {data.languages?.length > 0 && (
            <TagSet label="Languages" items={data.languages} />
          )}
          {data.skills?.length > 0 && (
            <TagSet label="Skills" items={data.skills} />
          )}
        </div>
      )}
    </div>
  );
}
JobDetailsSummary.propTypes = { data: PropTypes.object.isRequired };

function TagSet({ label, items }) {
  return (
    <div>
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => (
          <span
            key={it}
            className="inline-flex items-center rounded-md bg-[#5b86e5]/15 text-[#c9f9ff] border border-[#36d1dc]/25 px-2 py-0.5 text-xs"
          >
            {it}
          </span>
        ))}
      </div>
    </div>
  );
}
TagSet.propTypes = {
  label: PropTypes.string.isRequired,
  items: PropTypes.arrayOf(PropTypes.string).isRequired,
};

function DescriptionSummary({ description, source }) {
  if (!description || !description.trim()) return <Muted>No description yet</Muted>;
  const preview = description.length > 400
    ? description.slice(0, 400).trimEnd() + '…'
    : description;
  return (
    <div>
      <p className="whitespace-pre-line text-sm text-slate-200 leading-relaxed">{preview}</p>
      <p className="mt-2 text-xs text-slate-500">
        {description.length} character{description.length === 1 ? '' : 's'}
        {source === 'ai' && (
          <span className="ml-2 inline-flex items-center gap-1 text-[#36d1dc]">
            <Edit3 size={11} /> AI-generated (then edited)
          </span>
        )}
      </p>
    </div>
  );
}
DescriptionSummary.propTypes = {
  description: PropTypes.string,
  source:      PropTypes.string,
};

function QuestionsSummary({ questions, interviewType }) {
  if (!Array.isArray(questions) || questions.length === 0) {
    if (interviewType === 'predefined') {
      return <Muted className="text-rose-300">Required for pre-defined interviews — none added.</Muted>;
    }
    return <Muted>No custom questions — Nour generates everything dynamically.</Muted>;
  }
  return (
    <div>
      <p className="text-sm text-slate-300 mb-2">{questions.length} question{questions.length === 1 ? '' : 's'}</p>
      <ol className="space-y-1.5 text-sm">
        {questions.slice(0, 5).map((q) => (
          <li key={q.id} className="flex items-start gap-2 text-slate-200">
            <span className="text-[10px] uppercase tracking-wider text-[#36d1dc] font-semibold w-16 shrink-0 pt-0.5">
              {STAGE_LABEL[q.stage] || q.stage}
            </span>
            <span className="flex-1">{q.text || <em className="text-slate-500">(empty)</em>}</span>
          </li>
        ))}
        {questions.length > 5 && (
          <li className="text-xs text-slate-400 italic">+ {questions.length - 5} more</li>
        )}
      </ol>
    </div>
  );
}
QuestionsSummary.propTypes = {
  questions:     PropTypes.array,
  interviewType: PropTypes.string,
};

function EvaluationSummary({ config }) {
  if (!config) {
    return <Muted>Using runtime defaults.</Muted>;
  }
  const hasCriteria = Array.isArray(config.criteria) && config.criteria.length > 0;
  return (
    <div className="space-y-2 text-sm">
      {config.interviewStyle && (
        <p className="text-slate-200"><span className="text-slate-400">Interview style:</span> {config.interviewStyle}</p>
      )}
      {(typeof config.minDifficulty === 'number' || typeof config.maxDifficulty === 'number') && (
        <p className="text-slate-200">
          <span className="text-slate-400">Difficulty range:</span>{' '}
          {config.minDifficulty ?? '—'} to {config.maxDifficulty ?? '—'} (1–5 scale)
        </p>
      )}
      {hasCriteria && (
        <div>
          <p className="text-slate-400 mb-1">Scoring criteria:</p>
          <ul className="space-y-0.5">
            {config.criteria.map((c, i) => (
              <li key={i} className="flex items-center justify-between text-slate-200">
                <span>{c.name || <em className="text-slate-500">(unnamed)</em>}</span>
                <span className="text-[#36d1dc] font-mono">{c.weight}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {config.trackResilience && (
        <p className="text-slate-200 flex items-center gap-1">
          <Check size={12} className="text-emerald-400" /> Resilience score tracking enabled
        </p>
      )}
      {!hasCriteria && !config.interviewStyle &&
       typeof config.minDifficulty !== 'number' &&
       typeof config.maxDifficulty !== 'number' &&
       !config.trackResilience && (
        <Muted>Using runtime defaults.</Muted>
      )}
    </div>
  );
}
EvaluationSummary.propTypes = { config: PropTypes.object };

function Muted({ children, className }) {
  return <p className={cn('text-sm text-slate-400 italic', className)}>{children}</p>;
}
Muted.propTypes = {
  children:  PropTypes.node,
  className: PropTypes.string,
};

// ── Missing-fields banner ─────────────────────────────────────────────────────

function MissingFieldsBanner({ missing, onGoTo }) {
  return (
    <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4">
      <div className="flex items-start gap-2">
        <AlertCircle size={18} className="text-rose-300 shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-rose-200 font-semibold">Cannot publish — required fields missing:</p>
          <ul className="mt-2 space-y-1">
            {missing.map((field) => {
              const step = MISSING_TO_STEP[field];
              return (
                <li key={field} className="flex items-center gap-2 text-sm">
                  <span className="text-rose-200">• {FIELD_LABELS[field] || field}</span>
                  {step && (
                    <button
                      type="button"
                      onClick={() => onGoTo(step)}
                      className="text-xs underline text-rose-300 hover:text-white"
                    >
                      Edit in Step {step}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
MissingFieldsBanner.propTypes = {
  missing: PropTypes.arrayOf(PropTypes.string).isRequired,
  onGoTo:  PropTypes.func.isRequired,
};
