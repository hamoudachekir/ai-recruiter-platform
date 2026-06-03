import { INITIAL_DATA, TOTAL_STEPS } from './wizardConfig';

// ── Skip rules ────────────────────────────────────────────────────────────────
// One rule today; extend here when other conditional steps appear.

export function isStepSkipped(stepNumber, data) {
  // Step 6 (Questions) is skipped when the interview is fully AI-generated.
  // The Mongoose pre-validate hook rejects predefinedQuestions with this type,
  // so SET_FIELDS also clears predefinedQuestions when ai_dynamic is selected.
  return stepNumber === 6 && data?.interviewType === 'ai_dynamic';
}

export function nextVisibleStep(from, data) {
  let n = from + 1;
  while (n <= TOTAL_STEPS && isStepSkipped(n, data)) n++;
  return Math.min(n, TOTAL_STEPS);
}

export function prevVisibleStep(from, data) {
  let n = from - 1;
  while (n >= 1 && isStepSkipped(n, data)) n--;
  return Math.max(n, 1);
}

// ── Per-step validation (drives the Continue/Publish disabled state) ──────────

export function isStepValid(stepNumber, data) {
  switch (stepNumber) {
    case 1: return Boolean(data.departmentId);
    case 2: return Boolean(data.companyContextId);
    case 3: return (
      isFilled(data.title) &&
      isFilled(data.location) &&
      isFilled(data.interviewLanguage) &&
      isFilled(data.seniorityLevel) &&
      isFilled(data.employmentType) &&
      isFilled(data.workspaceType)
    );
    case 4: return isFilled(data.description);
    case 5: return Boolean(data.interviewType);
    case 6: {
      // Predefined requires at least one question; hybrid allows 0.
      // Whichever count, every question that exists needs non-empty text.
      const qs = Array.isArray(data.predefinedQuestions) ? data.predefinedQuestions : [];
      if (data.interviewType === 'predefined' && qs.length === 0) return false;
      return qs.every((q) => q?.text && q.text.trim().length > 0);
    }
    case 7: {
      // Optional step — defaults apply at runtime when evaluationConfig is null.
      const ec = data.evaluationConfig;
      if (!ec) return true;
      if (Array.isArray(ec.criteria) && ec.criteria.length > 0) {
        if (ec.criteria.some((c) => !c?.name || !c.name.trim())) return false;
        const sum = ec.criteria.reduce((acc, c) => acc + (Number(c?.weight) || 0), 0);
        if (Math.abs(sum - 100) > 0.01) return false;
      }
      if (typeof ec.minDifficulty === 'number' && typeof ec.maxDifficulty === 'number') {
        if (ec.minDifficulty > ec.maxDifficulty) return false;
      }
      return true;
    }
    case 8: return true;  // Review step — Publish enabled
    default: return true;
  }
}

function isFilled(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  return true;
}

// ── State shape ───────────────────────────────────────────────────────────────

export const initialWizardState = {
  jobId:         null,
  status:        'idle',
  loadError:     null,
  saveError:     null,
  lastSavedAt:   null,

  currentStep:   1,
  furthestStep:  1,

  data:          { ...INITIAL_DATA },
  errors:        {},
  missingFields: [],
};

// ── Actions ───────────────────────────────────────────────────────────────────

export const Actions = {
  RESET:           'RESET',

  SET_FIELDS:      'SET_FIELDS',
  SET_ERRORS:      'SET_ERRORS',
  CLEAR_ERRORS:    'CLEAR_ERRORS',

  GO_TO_STEP:      'GO_TO_STEP',
  CONTINUE:        'CONTINUE',
  BACK:            'BACK',

  LOAD_BEGIN:      'LOAD_BEGIN',
  LOAD_SUCCESS:    'LOAD_SUCCESS',
  LOAD_ERROR:      'LOAD_ERROR',

  SAVE_BEGIN:      'SAVE_BEGIN',
  SAVE_SUCCESS:    'SAVE_SUCCESS',
  SAVE_ERROR:      'SAVE_ERROR',

  PUBLISH_BEGIN:   'PUBLISH_BEGIN',
  PUBLISH_SUCCESS: 'PUBLISH_SUCCESS',
  PUBLISH_ERROR:   'PUBLISH_ERROR',
};

// ── Reducer ───────────────────────────────────────────────────────────────────

export function wizardReducer(state, action) {
  switch (action.type) {
    case Actions.RESET:
      return { ...initialWizardState };

    case Actions.SET_FIELDS: {
      const merged = { ...state.data, ...action.fields };

      // Switching to ai_dynamic must clear predefinedQuestions — Mongoose
      // pre-validate rejects predefinedQuestions when interviewType === 'ai_dynamic'.
      if (action.fields.interviewType === 'ai_dynamic') {
        merged.predefinedQuestions = [];
      }

      // Clear errors for any fields the user just touched.
      const touchedKeys = Object.keys(action.fields);
      const clearKeys = action.clearErrorsFor || touchedKeys;
      const errors = { ...state.errors };
      for (const key of clearKeys) delete errors[key];

      // Drop any touched field from the publish-time missingFields list.
      // The Step 8 banner reflects the last publish attempt; as the user
      // fills in missing fields, the corresponding entries disappear.
      let missingFields = state.missingFields;
      if (missingFields.length > 0) {
        const touched = new Set(touchedKeys);
        missingFields = missingFields.filter((f) => !touched.has(f));
      }

      return { ...state, data: merged, errors, missingFields };
    }

    case Actions.SET_ERRORS:
      return { ...state, errors: { ...state.errors, ...action.errors } };

    case Actions.CLEAR_ERRORS:
      return { ...state, errors: {}, missingFields: [] };

    case Actions.GO_TO_STEP: {
      const target = clampStep(action.step);
      if (target > state.furthestStep) return state;
      if (isStepSkipped(target, state.data)) return state;
      return { ...state, currentStep: target };
    }

    case Actions.CONTINUE: {
      const next = nextVisibleStep(state.currentStep, state.data);
      return {
        ...state,
        currentStep:  next,
        furthestStep: Math.max(state.furthestStep, next),
      };
    }

    case Actions.BACK: {
      const prev = prevVisibleStep(state.currentStep, state.data);
      return { ...state, currentStep: prev };
    }

    case Actions.LOAD_BEGIN:
      return { ...state, status: 'loading', loadError: null };

    case Actions.LOAD_SUCCESS: {
      const job = action.job || {};
      const data = mergeJobIntoData(job);
      let resumeAt = inferResumeStep(job);
      // If the inferred resume step is one we'd skip, walk forward.
      if (isStepSkipped(resumeAt, data)) resumeAt = nextVisibleStep(resumeAt - 1, data);
      return {
        ...state,
        status:        'idle',
        loadError:     null,
        jobId:         job._id || job.id || null,
        data,
        currentStep:   resumeAt,
        furthestStep:  Math.max(resumeAt, state.furthestStep),
        lastSavedAt:   Date.now(),
      };
    }

    case Actions.LOAD_ERROR:
      return { ...state, status: 'idle', loadError: action.error || 'Failed to load job' };

    case Actions.SAVE_BEGIN:
      return { ...state, status: 'saving', saveError: null };

    case Actions.SAVE_SUCCESS:
      return {
        ...state,
        status:      'idle',
        saveError:   null,
        jobId:       action.job?._id || action.job?.id || state.jobId,
        lastSavedAt: Date.now(),
      };

    case Actions.SAVE_ERROR:
      return { ...state, status: 'idle', saveError: action.error || 'Save failed' };

    case Actions.PUBLISH_BEGIN:
      return { ...state, status: 'publishing', saveError: null, missingFields: [] };

    case Actions.PUBLISH_SUCCESS:
      return { ...state, status: 'idle', saveError: null, missingFields: [] };

    case Actions.PUBLISH_ERROR:
      return {
        ...state,
        status:        'idle',
        saveError:     action.error || 'Publish failed',
        missingFields: Array.isArray(action.missing) ? action.missing : [],
      };

    default:
      return state;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clampStep(n) {
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(Math.trunc(n), 1), TOTAL_STEPS);
}

function mergeJobIntoData(job) {
  const data = { ...INITIAL_DATA };
  for (const key of Object.keys(INITIAL_DATA)) {
    if (job[key] !== undefined && job[key] !== null) data[key] = job[key];
  }
  return data;
}

function inferResumeStep(job) {
  if (!job) return 1;
  if (!job.departmentId)                       return 1;
  if (!job.companyContextId)                   return 2;
  if (!job.title)                              return 3;
  if (!job.description)                        return 4;
  if (!job.interviewType)                      return 5;
  if (job.interviewType === 'predefined' &&
      (!Array.isArray(job.predefinedQuestions) || job.predefinedQuestions.length === 0)) {
    return 6;
  }
  if (!job.evaluationConfig)                   return 7;
  return 8;
}
