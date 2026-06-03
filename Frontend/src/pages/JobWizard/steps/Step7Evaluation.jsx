import PropTypes from 'prop-types';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { Actions } from '../wizardReducer';
import { INTERVIEW_STYLES, TOTAL_STEPS } from '../wizardConfig';
import {
  Field, SelectInput, StepHeader, TextInput, Toggle, WizardCard,
} from '../components/FormPrimitives';
import { cn } from '../../../lib/utils';

const STYLE_INFO = {
  friendly:       { label: 'Friendly',       difficulty: '1–4', desc: 'Warm, supportive tone. Good for entry- to mid-level.' },
  strict:         { label: 'Strict',         difficulty: '2–5', desc: 'Rigorous and demanding. Pushes candidates to depth.' },
  senior:         { label: 'Senior',         difficulty: '3–5', desc: 'Higher baseline difficulty for senior+ roles.' },
  junior:         { label: 'Junior',         difficulty: '1–3', desc: 'Forgiving range. Built for first-job candidates.' },
  fast_screening: { label: 'Fast Screening', difficulty: '1–3', desc: 'Quick first-round screen. Lower bar, broader coverage.' },
};

const DEFAULT_CRITERIA = [
  { name: 'Technical skills',  weight: 40 },
  { name: 'Communication',     weight: 25 },
  { name: 'Problem-solving',   weight: 25 },
  { name: 'Culture fit',       weight: 10 },
];

const EMPTY_EC = { criteria: [], trackResilience: false };

/**
 * Step 7 — Evaluation Criteria.
 * Maps directly to the agent's vocabulary:
 *   - interviewStyle (drives STYLE_DIFFICULTY_RANGES at session bootstrap)
 *   - minDifficulty/maxDifficulty (1–5, optional overrides)
 *   - criteria[{name, weight}] — weights sum to 100 enforced live
 *   - trackResilience (boolean)
 * No skillIRT — the agent has no concept of per-skill bounds today.
 *
 * Entire step is optional. Defaults apply at runtime if evaluationConfig
 * is left null.
 */
export default function Step7Evaluation({ state, dispatch }) {
  const ec = state.data.evaluationConfig || EMPTY_EC;

  const update = (patch) => {
    dispatch({
      type: Actions.SET_FIELDS,
      fields: { evaluationConfig: { ...ec, ...patch } },
    });
  };

  const setCriteria = (next) => update({ criteria: next });

  const addCriterion = () => {
    setCriteria([...(ec.criteria || []), { name: '', weight: 0 }]);
  };

  const updateCriterion = (idx, patch) => {
    setCriteria((ec.criteria || []).map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };

  const removeCriterion = (idx) => {
    setCriteria((ec.criteria || []).filter((_, i) => i !== idx));
  };

  const useRecommendedDefaults = () => {
    setCriteria(DEFAULT_CRITERIA);
  };

  const resetStep = () => {
    dispatch({ type: Actions.SET_FIELDS, fields: { evaluationConfig: null } });
  };

  const criteria = ec.criteria || [];
  const weightSum = criteria.reduce((acc, c) => acc + (Number(c.weight) || 0), 0);
  const weightOk  = criteria.length === 0 || Math.abs(weightSum - 100) < 0.01;
  const allNamesOk = criteria.every((c) => c.name && c.name.trim());

  const customRange = typeof ec.minDifficulty === 'number' || typeof ec.maxDifficulty === 'number';

  const toggleCustomRange = (on) => {
    if (on) {
      update({ minDifficulty: 1, maxDifficulty: 5 });
    } else {
      const { minDifficulty: _a, maxDifficulty: _b, ...rest } = ec;
      dispatch({ type: Actions.SET_FIELDS, fields: { evaluationConfig: rest } });
    }
  };

  const setBound = (key, raw) => {
    const n = Number.parseInt(raw, 10);
    const clamped = Number.isFinite(n) ? Math.min(Math.max(n, 1), 5) : 1;
    update({ [key]: clamped });
  };

  return (
    <WizardCard>
      <StepHeader
        stepNumber={7}
        totalSteps={TOTAL_STEPS}
        title="Evaluation Criteria"
        subtitle="Configure how the AI agents weigh and assess candidates. Everything here is optional — sensible defaults apply if you skip it."
      />

      {state.data.evaluationConfig && (
        <button
          type="button"
          onClick={resetStep}
          className="text-xs text-slate-400 hover:text-slate-200 underline mb-4"
        >
          Reset to defaults (skip this step)
        </button>
      )}

      <div className="space-y-6">
        {/* Interview style */}
        <Field
          label="Interview Style"
          hint="Drives the difficulty range and tone of the questions Nour generates."
          htmlFor="ec-style"
        >
          <SelectInput
            id="ec-style"
            value={ec.interviewStyle || ''}
            onChange={(e) => update({ interviewStyle: e.target.value || undefined })}
          >
            <option value="">Use agent default</option>
            {INTERVIEW_STYLES.map((s) => (
              <option key={s} value={s}>
                {STYLE_INFO[s]?.label || s} (difficulty {STYLE_INFO[s]?.difficulty || '1–5'})
              </option>
            ))}
          </SelectInput>
          {ec.interviewStyle && STYLE_INFO[ec.interviewStyle] && (
            <p className="mt-1 text-xs text-slate-400">{STYLE_INFO[ec.interviewStyle].desc}</p>
          )}
        </Field>

        {/* Difficulty range override */}
        <div>
          <Toggle
            checked={customRange}
            onChange={toggleCustomRange}
            label="Override the default difficulty range"
            hint="By default the style above sets the range. Override only when you need a specific bracket."
          />
          {customRange && (
            <div className="mt-3 grid grid-cols-2 gap-3 max-w-md">
              <Field label="Min difficulty (1–5)" htmlFor="ec-min">
                <TextInput
                  id="ec-min"
                  type="number"
                  min="1"
                  max="5"
                  value={ec.minDifficulty ?? 1}
                  onChange={(e) => setBound('minDifficulty', e.target.value)}
                />
              </Field>
              <Field label="Max difficulty (1–5)" htmlFor="ec-max">
                <TextInput
                  id="ec-max"
                  type="number"
                  min="1"
                  max="5"
                  value={ec.maxDifficulty ?? 5}
                  onChange={(e) => setBound('maxDifficulty', e.target.value)}
                />
              </Field>
              {typeof ec.minDifficulty === 'number' &&
               typeof ec.maxDifficulty === 'number' &&
               ec.minDifficulty > ec.maxDifficulty && (
                <p className="col-span-2 text-xs text-rose-400 flex items-center gap-1">
                  <AlertTriangle size={12} /> Min difficulty must be less than or equal to max.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Scoring criteria */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-slate-200">Scoring Criteria</label>
            {criteria.length === 0 ? (
              <button
                type="button"
                onClick={useRecommendedDefaults}
                className="text-xs text-[#36d1dc] hover:underline"
              >
                Use recommended starting points
              </button>
            ) : (
              <WeightSummary sum={weightSum} ok={weightOk} />
            )}
          </div>

          {criteria.length === 0 ? (
            <p className="text-sm text-slate-400 italic">
              No criteria set — the report uses defaults at runtime.
            </p>
          ) : (
            <ul className="space-y-2">
              {criteria.map((c, idx) => (
                <li key={idx} className="flex items-center gap-2">
                  <TextInput
                    value={c.name}
                    onChange={(e) => updateCriterion(idx, { name: e.target.value })}
                    placeholder="Criterion name"
                    className="flex-1"
                  />
                  <div className="relative w-28">
                    <TextInput
                      type="number"
                      min="0"
                      max="100"
                      value={c.weight ?? 0}
                      onChange={(e) => updateCriterion(idx, { weight: Number(e.target.value) || 0 })}
                      className="pr-6"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">%</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeCriterion(idx)}
                    aria-label="Remove criterion"
                    className="text-slate-400 hover:text-rose-400 p-1.5"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={addCriterion}
              className="inline-flex items-center gap-1 text-sm text-[#36d1dc] hover:underline"
            >
              <Plus size={14} /> Add criterion
            </button>
            {criteria.length > 0 && !allNamesOk && (
              <span className="text-xs text-rose-400 flex items-center gap-1">
                <AlertTriangle size={12} /> Every criterion needs a name.
              </span>
            )}
          </div>
        </div>
      </div>
    </WizardCard>
  );
}
Step7Evaluation.propTypes = {
  state:    PropTypes.object.isRequired,
  dispatch: PropTypes.func.isRequired,
};

function WeightSummary({ sum, ok }) {
  return (
    <div
      className={cn(
        'text-xs px-2 py-1 rounded-md font-medium',
        ok
          ? 'bg-emerald-500/15 text-emerald-300'
          : 'bg-amber-500/15 text-amber-200'
      )}
    >
      Total: {sum}%{' '}
      {ok ? '✓' : sum < 100 ? `(need ${100 - sum} more)` : `(over by ${sum - 100})`}
    </div>
  );
}
WeightSummary.propTypes = {
  sum: PropTypes.number.isRequired,
  ok:  PropTypes.bool.isRequired,
};
