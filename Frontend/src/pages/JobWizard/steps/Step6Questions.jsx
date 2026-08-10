import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import {
  AlertCircle, ChevronDown, ChevronUp, Loader2, Plus, Sparkles, Trash2, X,
} from 'lucide-react';
import { Actions } from '../wizardReducer';
import { QUESTION_STAGES, TOTAL_STEPS } from '../wizardConfig';
import { suggestQuestions } from '../wizardApi';
import {
  Field, SelectInput, StepHeader, TextInput, WizardCard,
} from '../components/FormPrimitives';
import { mapAiError, aiErrorTone } from '../utils/aiErrors';
import { cn } from '../../../lib/utils';

const MAX_QUESTIONS = 10;
const STAGE_LABEL = { beginning: 'Beginning', middle: 'Middle', end: 'End' };

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeQuestion(overrides = {}) {
  return {
    id:    makeId(),
    text:  '',
    stage: 'middle',
    order: 0,
    ...overrides,
  };
}

/**
 * Step 6 — Questions.
 * Only meaningful for `hybrid` and `predefined`. ai_dynamic skips this step in
 * the reducer, but we render a defensive notice in case it's reached anyway.
 *
 * Custom questions persist in data.predefinedQuestions; their order is
 * always re-normalized to the array index on every write.
 */
export default function Step6Questions({ state, dispatch }) {
  const { data } = state;
  const interviewType = data.interviewType;
  const questions = useMemo(
    () => (Array.isArray(data.predefinedQuestions) ? data.predefinedQuestions : []),
    [data.predefinedQuestions]
  );

  // Defensive: this step shouldn't render for ai_dynamic — the Stepper
  // disables clicks and CONTINUE/BACK skip over it — but if state gets
  // out of sync, give the user an escape hatch.
  if (interviewType === 'ai_dynamic') {
    return (
      <WizardCard>
        <StepHeader
          stepNumber={6}
          totalSteps={TOTAL_STEPS}
          title="Questions"
          subtitle="This step is skipped for AI-Powered Dynamic interviews."
        />
        <button
          type="button"
          onClick={() => dispatch({ type: Actions.GO_TO_STEP, step: 5 })}
          className="mt-2 inline-flex items-center gap-1 text-sm text-[#36d1dc] hover:underline"
        >
          Go to Step 5 to change interview type
        </button>
      </WizardCard>
    );
  }

  const setQuestions = (next) => {
    const reordered = next.map((q, i) => ({ ...q, order: i }));
    dispatch({ type: Actions.SET_FIELDS, fields: { predefinedQuestions: reordered } });
  };

  const updateQuestion = (idx, patch) => {
    setQuestions(questions.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  };

  const deleteQuestion = (idx) => {
    setQuestions(questions.filter((_, i) => i !== idx));
  };

  const addQuestion = () => {
    if (questions.length >= MAX_QUESTIONS) return;
    setQuestions([...questions, makeQuestion()]);
  };

  const moveQuestion = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= questions.length) return;
    const next = [...questions];
    [next[idx], next[target]] = [next[target], next[idx]];
    setQuestions(next);
  };

  const addSuggestion = (suggestion) => {
    if (questions.length >= MAX_QUESTIONS) return;
    setQuestions([
      ...questions,
      makeQuestion({
        text:  suggestion.text,
        stage: QUESTION_STAGES.includes(suggestion.stage) ? suggestion.stage : 'middle',
      }),
    ]);
  };

  return (
    <WizardCard>
      <StepHeader
        stepNumber={6}
        totalSteps={TOTAL_STEPS}
        title="Questions"
        subtitle={
          interviewType === 'predefined'
            ? 'Every candidate answers the same questions in the same order. Add at least one to publish.'
            : 'Add up to 10 anchor questions. Cyriness will dynamically generate the rest from the resume and job description.'
        }
      />

      <div className="flex items-center justify-between mb-4">
        <div className="text-sm">
          <span className="text-[#c9f9ff] font-semibold">{questions.length}</span>
          <span className="text-slate-400"> / {MAX_QUESTIONS} questions</span>
        </div>
        <SuggestionsLauncher state={state} onAdd={addSuggestion} addedTexts={questions.map((q) => q.text.toLowerCase())} questionsCount={questions.length} />
      </div>

      {questions.length === 0 ? (
        <EmptyState interviewType={interviewType} onAdd={addQuestion} />
      ) : (
        <ul className="space-y-3">
          {questions.map((q, idx) => (
            <li key={q.id}>
              <QuestionRow
                question={q}
                index={idx}
                isFirst={idx === 0}
                isLast={idx === questions.length - 1}
                onChange={(patch) => updateQuestion(idx, patch)}
                onDelete={() => deleteQuestion(idx)}
                onMove={(dir) => moveQuestion(idx, dir)}
              />
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={addQuestion}
        disabled={questions.length >= MAX_QUESTIONS}
        className={cn(
          'mt-4 inline-flex items-center gap-1 px-4 py-2 rounded-lg border border-[#36d1dc]/30 bg-[#131c26] text-[#c9f9ff] font-medium hover:border-[#36d1dc]/60 hover:bg-[#131c26]/80',
          'disabled:opacity-40 disabled:cursor-not-allowed'
        )}
      >
        <Plus size={14} /> Add Question
        {questions.length >= MAX_QUESTIONS && <span className="text-xs text-slate-400 ml-1">(max reached)</span>}
      </button>
    </WizardCard>
  );
}
Step6Questions.propTypes = {
  state:    PropTypes.object.isRequired,
  dispatch: PropTypes.func.isRequired,
};

// ── Question row ──────────────────────────────────────────────────────────────

function QuestionRow({ question, index, isFirst, isLast, onChange, onDelete, onMove }) {
  return (
    <div className="rounded-lg border border-[#36d1dc]/15 bg-[#0b0c2a]/50 p-3 flex items-start gap-2">
      <div className="flex flex-col gap-0.5 pt-1">
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={isFirst}
          aria-label="Move up"
          className="text-slate-500 hover:text-[#36d1dc] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={isLast}
          aria-label="Move down"
          className="text-slate-500 hover:text-[#36d1dc] disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <ChevronDown size={14} />
        </button>
      </div>

      <span className="inline-flex items-center justify-center w-6 h-6 mt-1 rounded-md bg-[#5b86e5]/20 text-[#c9f9ff] text-xs font-semibold shrink-0">
        {index + 1}
      </span>

      <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-[140px_1fr] gap-2">
        <div>
          <label htmlFor={`q-stage-${question.id}`} className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
            Ask during
          </label>
          <SelectInput
            id={`q-stage-${question.id}`}
            value={question.stage}
            onChange={(e) => onChange({ stage: e.target.value })}
          >
            {QUESTION_STAGES.map((s) => (
              <option key={s} value={s}>{STAGE_LABEL[s]}</option>
            ))}
          </SelectInput>
        </div>
        <div>
          <label htmlFor={`q-text-${question.id}`} className="block text-[10px] uppercase tracking-wider text-slate-500 mb-1">
            Question
          </label>
          <TextInput
            id={`q-text-${question.id}`}
            value={question.text}
            onChange={(e) => onChange({ text: e.target.value })}
            placeholder="Walk me through a time you…"
          />
        </div>
      </div>

      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete question"
        className="text-slate-400 hover:text-rose-400 p-1.5 mt-1 shrink-0"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
QuestionRow.propTypes = {
  question: PropTypes.shape({
    id:    PropTypes.string.isRequired,
    text:  PropTypes.string.isRequired,
    stage: PropTypes.string.isRequired,
  }).isRequired,
  index:    PropTypes.number.isRequired,
  isFirst:  PropTypes.bool,
  isLast:   PropTypes.bool,
  onChange: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onMove:   PropTypes.func.isRequired,
};

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ interviewType, onAdd }) {
  const isRequired = interviewType === 'predefined';
  return (
    <div className={cn(
      'rounded-lg border border-dashed p-8 text-center',
      isRequired ? 'border-amber-500/30 bg-amber-500/5' : 'border-[#36d1dc]/20 bg-[#0b0c2a]/30'
    )}>
      <p className={cn('text-sm', isRequired ? 'text-amber-200' : 'text-slate-400')}>
        {isRequired
          ? 'You need at least one question to publish a pre-defined interview.'
          : 'No questions added yet. Hybrid interviews work fine with zero — Cyriness fills the gaps adaptively.'}
      </p>
      <button
        type="button"
        onClick={onAdd}
        className="mt-3 inline-flex items-center gap-1 px-4 py-2 rounded-lg border border-[#36d1dc]/30 bg-[#131c26] text-[#c9f9ff] font-medium hover:border-[#36d1dc]/60"
      >
        <Plus size={14} /> Add your first question
      </button>
    </div>
  );
}
EmptyState.propTypes = {
  interviewType: PropTypes.string,
  onAdd:         PropTypes.func.isRequired,
};

// ── Suggestions ───────────────────────────────────────────────────────────────

function SuggestionsLauncher({ state, onAdd, addedTexts, questionsCount }) {
  const [isOpen, setIsOpen]   = useState(false);
  const [items, setItems]     = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  const handleOpen = async () => {
    setIsOpen(true);
    if (items.length > 0) return;
    await fetchSuggestions();
  };

  const fetchSuggestions = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await suggestQuestions({
        title:          state.data.title || undefined,
        seniorityLevel: state.data.seniorityLevel || undefined,
        skills:         state.data.skills?.length ? state.data.skills : undefined,
        languages:      state.data.languages?.length ? state.data.languages : undefined,
        description:    state.data.description || undefined,
        interviewType:  state.data.interviewType,
        count:          8,
      });
      setItems(Array.isArray(result) ? result : []);
    } catch (err) {
      setError(mapAiError(err));
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={isOpen ? () => setIsOpen(false) : handleOpen}
        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-[#36d1dc]/30 bg-[#131c26] text-[#c9f9ff] font-medium hover:border-[#36d1dc]/60"
      >
        <Sparkles size={14} />
        View Suggestions
      </button>

      {isOpen && (
        <SuggestionsPanel
          loading={loading}
          error={error}
          items={items}
          onClose={() => setIsOpen(false)}
          onRetry={fetchSuggestions}
          onAdd={onAdd}
          addedTexts={addedTexts}
          questionsCount={questionsCount}
        />
      )}
    </div>
  );
}
SuggestionsLauncher.propTypes = {
  state:          PropTypes.object.isRequired,
  onAdd:          PropTypes.func.isRequired,
  addedTexts:     PropTypes.arrayOf(PropTypes.string).isRequired,
  questionsCount: PropTypes.number.isRequired,
};

function SuggestionsPanel({ loading, error, items, onClose, onRetry, onAdd, addedTexts, questionsCount }) {
  const addedSet = new Set(addedTexts);
  return (
    <div className="absolute right-0 mt-2 z-20 w-[420px] max-w-[90vw] rounded-xl border border-[#36d1dc]/20 bg-[#0b0c2a] shadow-2xl shadow-black/40">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#36d1dc]/15">
        <h4 className="text-sm font-semibold text-white">AI-suggested questions</h4>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close suggestions"
          className="text-slate-400 hover:text-white"
        >
          <X size={14} />
        </button>
      </div>

      <div className="p-3 max-h-[60vh] overflow-auto">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-400 py-6 justify-center">
            <Loader2 size={14} className="animate-spin" /> Generating suggestions…
          </div>
        )}

        {error && (
          <div className={cn(
            'flex items-start gap-2 rounded-lg border p-3 text-sm',
            aiErrorTone(error) === 'warning'
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
          )}>
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <p className="flex-1">{error.message}</p>
            <button
              type="button"
              onClick={onRetry}
              className="text-xs underline opacity-90 hover:opacity-100"
            >
              Retry
            </button>
          </div>
        )}

        {!loading && !error && items.length === 0 && (
          <p className="text-sm text-slate-400 py-6 text-center">
            No suggestions yet. Click <button onClick={onRetry} className="underline text-[#36d1dc]">retry</button> to generate.
          </p>
        )}

        {items.length > 0 && (
          <ul className="space-y-2">
            {items.map((s, idx) => {
              const isAdded = addedSet.has(s.text.toLowerCase());
              const isFull  = questionsCount >= MAX_QUESTIONS;
              return (
                <li
                  key={idx}
                  className="rounded-lg border border-[#36d1dc]/15 bg-[#131c26]/60 p-3"
                >
                  <p className="text-sm text-slate-100 leading-snug">{s.text}</p>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-[#36d1dc] font-semibold">
                      {STAGE_LABEL[s.stage] || 'Middle'}
                      {s.category && <span className="ml-2 text-slate-500 normal-case tracking-normal">{s.category}</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => onAdd(s)}
                      disabled={isAdded || isFull}
                      className={cn(
                        'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium',
                        isAdded
                          ? 'bg-emerald-500/15 text-emerald-300 cursor-default'
                          : 'border border-[#36d1dc]/30 text-[#c9f9ff] hover:bg-[#5b86e5]/15',
                        isFull && !isAdded && 'opacity-40 cursor-not-allowed'
                      )}
                    >
                      {isAdded ? 'Added' : (<><Plus size={12} /> Add</>)}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
SuggestionsPanel.propTypes = {
  loading:        PropTypes.bool,
  error:          PropTypes.object,
  items:          PropTypes.array,
  onClose:        PropTypes.func.isRequired,
  onRetry:        PropTypes.func.isRequired,
  onAdd:          PropTypes.func.isRequired,
  addedTexts:     PropTypes.arrayOf(PropTypes.string).isRequired,
  questionsCount: PropTypes.number.isRequired,
};
