import PropTypes from 'prop-types';
import { AlertTriangle, Check, Layers, ListChecks, Sparkles } from 'lucide-react';
import { Actions } from '../wizardReducer';
import { TOTAL_STEPS } from '../wizardConfig';
import { StepHeader, WizardCard } from '../components/FormPrimitives';
import { cn } from '../../../lib/utils';

/**
 * Step 5 — Interview Type.
 * Three radio-style cards. The choice drives:
 *   - whether Step 6 (Questions) is rendered (ai_dynamic skips Step 6)
 *   - the agent's behavior at interview time (read at session bootstrap)
 *
 * Selecting ai_dynamic with existing predefinedQuestions prompts a confirm
 * because the reducer's SET_FIELDS auto-clears predefinedQuestions to match
 * the Mongoose pre-validate hook's constraint.
 */

const TYPES = [
  {
    value:       'ai_dynamic',
    icon:        Sparkles,
    title:       'AI-Powered Dynamic Interview',
    badge:       'Recommended',
    description: 'Let Nour and the technical agent conduct fully adaptive interviews driven by the candidate resume and the job description. No predefined questions.',
  },
  {
    value:       'hybrid',
    icon:        Layers,
    title:       'Hybrid Interview',
    description: 'Combine AI-generated adaptive questions with your own custom anchors at specific stages of the interview.',
  },
  {
    value:       'predefined',
    icon:        ListChecks,
    title:       'Pre-defined Questions',
    description: 'Every applicant answers the same screening questions in the same order. Best for highly standardized hiring.',
  },
];

export default function Step5InterviewType({ state, dispatch }) {
  const selected = state.data.interviewType || 'ai_dynamic';
  const customQuestionCount = Array.isArray(state.data.predefinedQuestions)
    ? state.data.predefinedQuestions.length
    : 0;

  const handleSelect = (type) => {
    // Guard the destructive transition: switching to ai_dynamic clears any
    // custom questions because the Mongoose hook rejects that combination.
    if (
      type === 'ai_dynamic' &&
      selected !== 'ai_dynamic' &&
      customQuestionCount > 0
    ) {
      const word = customQuestionCount === 1 ? 'question' : 'questions';
      const ok = window.confirm(
        `Switching to AI Dynamic will discard your ${customQuestionCount} custom ${word}. Continue?`
      );
      if (!ok) return;
    }
    dispatch({ type: Actions.SET_FIELDS, fields: { interviewType: type } });
  };

  const willClearQuestions =
    selected !== 'ai_dynamic' && customQuestionCount > 0;

  return (
    <WizardCard>
      <StepHeader
        stepNumber={5}
        totalSteps={TOTAL_STEPS}
        title="Interview Type"
        subtitle="Choose how the automated interview runs for this job. You can always change this later."
      />

      {willClearQuestions && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <span>
            You have {customQuestionCount} custom {customQuestionCount === 1 ? 'question' : 'questions'} from Step 6.
            Selecting <strong>AI-Powered Dynamic</strong> will discard them.
          </span>
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-4">
        {TYPES.map((type) => (
          <InterviewTypeCard
            key={type.value}
            type={type}
            selected={selected === type.value}
            onSelect={() => handleSelect(type.value)}
          />
        ))}
      </div>

      <p className="mt-5 text-xs text-slate-500 leading-relaxed max-w-2xl">
        {selected === 'ai_dynamic' && (
          <>Step 6 is skipped — the agent generates questions adaptively at interview time.</>
        )}
        {selected === 'hybrid' && (
          <>Step 6 opens next. Add up to 10 anchor questions; the agent fills the rest.</>
        )}
        {selected === 'predefined' && (
          <>Step 6 opens next. Add at least one question — the agent will ask only the questions you define.</>
        )}
      </p>
    </WizardCard>
  );
}
Step5InterviewType.propTypes = {
  state:    PropTypes.object.isRequired,
  dispatch: PropTypes.func.isRequired,
};

function InterviewTypeCard({ type, selected, onSelect }) {
  const Icon = type.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group relative text-left rounded-xl border p-5 transition-all duration-150',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#36d1dc] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c2a]',
        selected
          ? 'border-[#36d1dc] bg-[#5b86e5]/15 shadow-[0_0_0_2px_rgba(54,209,220,0.25)]'
          : 'border-[#36d1dc]/20 bg-[#131c26]/50 hover:border-[#36d1dc]/50 hover:bg-[#131c26]/80'
      )}
    >
      <div className="flex items-start justify-between">
        <div
          className={cn(
            'p-2 rounded-lg transition-colors',
            selected
              ? 'bg-gradient-to-br from-[#5b86e5]/30 to-[#36d1dc]/30 text-[#36d1dc]'
              : 'bg-[#0b0c2a] text-slate-400 group-hover:text-[#36d1dc]'
          )}
        >
          <Icon size={20} />
        </div>
        {type.badge && (
          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold">
            {type.badge}
          </span>
        )}
      </div>
      <h3 className={cn('mt-4 font-semibold', selected ? 'text-white' : 'text-slate-100')}>
        {type.title}
      </h3>
      <p className="mt-1.5 text-sm text-slate-400 leading-relaxed">{type.description}</p>
      {selected && (
        <div className="mt-3 inline-flex items-center gap-1 text-xs text-emerald-300 font-medium">
          <Check size={12} strokeWidth={3} /> Selected
        </div>
      )}
    </button>
  );
}
InterviewTypeCard.propTypes = {
  type: PropTypes.shape({
    value:       PropTypes.string.isRequired,
    icon:        PropTypes.elementType.isRequired,
    title:       PropTypes.string.isRequired,
    badge:       PropTypes.string,
    description: PropTypes.string.isRequired,
  }).isRequired,
  selected: PropTypes.bool,
  onSelect: PropTypes.func.isRequired,
};
