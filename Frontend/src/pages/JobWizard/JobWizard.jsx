import { useCallback, useEffect, useReducer } from 'react';
import PropTypes from 'prop-types';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { ArrowLeft, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import Stepper from './components/Stepper';
import WizardFooter from './components/WizardFooter';
import { STEPS, TOTAL_STEPS } from './wizardConfig';
import {
  Actions,
  initialWizardState,
  isStepSkipped,
  isStepValid,
  wizardReducer,
} from './wizardReducer';
import { createDraft, loadJob, publishJob, updateJob } from './wizardApi';
import Step1Department     from './steps/Step1Department';
import Step2CompanyContext from './steps/Step2CompanyContext';
import Step3JobDetails     from './steps/Step3JobDetails';
import Step4Description    from './steps/Step4Description';
import Step5InterviewType  from './steps/Step5InterviewType';
import Step6Questions      from './steps/Step6Questions';
import Step7Evaluation     from './steps/Step7Evaluation';
import Step8ReviewPublish  from './steps/Step8ReviewPublish';
import { cn } from '../../lib/utils';

/**
 * 8-step wizard container. Works in two modes:
 *   - Routed page  (props undefined → reads useParams; renders full-screen)
 *   - Drawer popup (parent passes entrepriseId/onClose/onPublished + inDrawer)
 *
 * In drawer mode the wizard fills its container's height, the header swaps
 * "Back to profile" for an X close button, and a successful publish calls
 * onPublished + onClose instead of navigating away.
 */
export default function JobWizard({
  mode = 'new',
  entrepriseId: entrepriseIdProp,
  jobId: jobIdProp,
  inDrawer = false,
  onClose,
  onPublished,
}) {
  const params = useParams();
  const navigate = useNavigate();
  const entrepriseId = entrepriseIdProp || params.id;
  const jobIdParam   = jobIdProp        || params.jobId;

  const { isAuthenticated, loading: authLoading } = useAuth();

  const [state, dispatch] = useReducer(wizardReducer, initialWizardState);

  useEffect(() => {
    if (authLoading) return;
    // Only redirect for the standalone-route mode. In drawer mode the parent
    // page already gated auth before opening the drawer.
    if (!inDrawer && !isAuthenticated) navigate('/login');
  }, [authLoading, isAuthenticated, navigate, inDrawer]);

  useEffect(() => {
    if (mode !== 'edit' || !jobIdParam) return;
    let cancelled = false;
    (async () => {
      dispatch({ type: Actions.LOAD_BEGIN });
      try {
        const job = await loadJob(jobIdParam);
        if (!cancelled) dispatch({ type: Actions.LOAD_SUCCESS, job });
      } catch (err) {
        if (cancelled) return;
        const msg = err?.response?.data?.message || err.message || 'Failed to load draft';
        dispatch({ type: Actions.LOAD_ERROR, error: msg });
        toast.error(msg);
      }
    })();
    return () => { cancelled = true; };
  }, [mode, jobIdParam]);

  const isFirstStep = state.currentStep === 1;
  const isLastStep  = state.currentStep === TOTAL_STEPS;
  const canContinue = isStepValid(state.currentStep, state.data);

  const handleSaveDraft = useCallback(async () => {
    dispatch({ type: Actions.SAVE_BEGIN });
    try {
      const payload = buildSavePayload(state.data);
      const job = state.jobId
        ? await updateJob(state.jobId, payload)
        : await createDraft(payload);
      const wasNew = !state.jobId;
      dispatch({ type: Actions.SAVE_SUCCESS, job });
      toast.success('Draft saved');
      // Only update the URL when we're driving the routed standalone view.
      // The drawer keeps the new jobId in component state — no URL change.
      if (!inDrawer && wasNew && job?._id) {
        navigate(`/entreprise/${entrepriseId}/jobs/${job._id}/edit`, { replace: true });
      }
    } catch (err) {
      const msg = err?.response?.data?.message || err.message || 'Save failed';
      dispatch({ type: Actions.SAVE_ERROR, error: msg });
      toast.error(msg);
    }
  }, [state.jobId, state.data, entrepriseId, navigate, inDrawer]);

  const handleContinue = useCallback(() => dispatch({ type: Actions.CONTINUE }), []);
  const handleBack     = useCallback(() => dispatch({ type: Actions.BACK }),     []);
  const handleGoToStep = useCallback((step) => dispatch({ type: Actions.GO_TO_STEP, step }), []);

  const handlePublish = useCallback(async () => {
    if (!state.jobId) {
      toast.info('Save the draft first before publishing');
      return;
    }
    dispatch({ type: Actions.PUBLISH_BEGIN });
    try {
      await publishJob(state.jobId);
      dispatch({ type: Actions.PUBLISH_SUCCESS });
      toast.success('Job published!');
      if (inDrawer) {
        onPublished?.();
        onClose?.();
      } else {
        navigate(`/entreprise/${entrepriseId}`);
      }
    } catch (err) {
      const status = err?.response?.status;
      const data   = err?.response?.data;
      const msg    = data?.message || err.message || 'Publish failed';

      // 409 with "already published" — the job is OPEN in the DB (typically
      // because a prior attempt server-saved the status transition but
      // crashed on a follow-up step). Treat as success so the wizard closes
      // and the recruiter doesn't get stuck.
      if (status === 409 && /already published/i.test(msg)) {
        dispatch({ type: Actions.PUBLISH_SUCCESS });
        toast.success('Job is already published');
        if (inDrawer) {
          onPublished?.();
          onClose?.();
        } else {
          navigate(`/entreprise/${entrepriseId}`);
        }
        return;
      }

      dispatch({ type: Actions.PUBLISH_ERROR, error: msg, missing: data?.missing });
      toast.error(msg);
    }
  }, [state.jobId, entrepriseId, navigate, inDrawer, onPublished, onClose]);

  return (
    <div
      data-wizard-scope
      className={cn(
        'flex flex-col bg-[#0b0c2a] font-sans text-slate-100',
        inDrawer ? 'h-full' : 'min-h-screen'
      )}
    >
      <Header
        inDrawer={inDrawer}
        onClose={onClose}
        entrepriseId={entrepriseId}
        mode={mode}
        currentStep={state.currentStep}
      />

      <div className="shrink-0 border-b border-[#36d1dc]/15 bg-[#131c26]/60">
        <div className={cn('mx-auto w-full', inDrawer ? 'px-6 py-5' : 'max-w-6xl px-6 py-6')}>
          <Stepper
            steps={STEPS}
            currentStep={state.currentStep}
            furthestStep={state.furthestStep}
            onStepClick={handleGoToStep}
            isSkipped={(n) => isStepSkipped(n, state.data)}
          />
        </div>
      </div>

      <main className={cn(
        'flex-1 mx-auto w-full',
        inDrawer ? 'px-6 py-6 overflow-y-auto' : 'max-w-6xl px-6 py-8'
      )}>
        <MainContent state={state} dispatch={dispatch} />
      </main>

      <WizardFooter
        isFirstStep={isFirstStep}
        isLastStep={isLastStep}
        canContinue={canContinue}
        isSaving={state.status === 'saving'}
        isPublishing={state.status === 'publishing'}
        lastSavedAt={state.lastSavedAt}
        onBack={handleBack}
        onContinue={handleContinue}
        onSaveDraft={handleSaveDraft}
        onPublish={handlePublish}
      />
    </div>
  );
}

JobWizard.propTypes = {
  mode:         PropTypes.oneOf(['new', 'edit']),
  entrepriseId: PropTypes.string,
  jobId:        PropTypes.string,
  inDrawer:     PropTypes.bool,
  onClose:      PropTypes.func,
  onPublished:  PropTypes.func,
};

// ── Internals ─────────────────────────────────────────────────────────────────

function MainContent({ state, dispatch }) {
  if (state.status === 'loading') {
    return <div className="text-slate-400">Loading draft…</div>;
  }
  if (state.loadError) {
    return (
      <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 text-rose-200">
        {state.loadError}
      </div>
    );
  }
  return <StepContent state={state} dispatch={dispatch} />;
}
MainContent.propTypes = {
  state:    PropTypes.object.isRequired,
  dispatch: PropTypes.func.isRequired,
};

function StepContent({ state, dispatch }) {
  switch (state.currentStep) {
    case 1: return <Step1Department     state={state} dispatch={dispatch} />;
    case 2: return <Step2CompanyContext state={state} dispatch={dispatch} />;
    case 3: return <Step3JobDetails     state={state} dispatch={dispatch} />;
    case 4: return <Step4Description    state={state} dispatch={dispatch} />;
    case 5: return <Step5InterviewType  state={state} dispatch={dispatch} />;
    case 6: return <Step6Questions      state={state} dispatch={dispatch} />;
    case 7: return <Step7Evaluation     state={state} dispatch={dispatch} />;
    case 8: return <Step8ReviewPublish  state={state} dispatch={dispatch} />;
    default: return null;
  }
}
StepContent.propTypes = {
  state:    PropTypes.object.isRequired,
  dispatch: PropTypes.func.isRequired,
};

function Header({ inDrawer, onClose, entrepriseId, mode, currentStep }) {
  const navigate = useNavigate();
  const stepLabel = STEPS.find((s) => s.number === currentStep)?.label || '';

  if (inDrawer) {
    return (
      <header className="shrink-0 border-b border-[#36d1dc]/15 bg-[#131c26]">
        <div className="mx-auto w-full px-6 py-4 flex items-center justify-between gap-3">
          <div className="w-9 shrink-0" aria-hidden="true" />
          <h1 className="text-sm md:text-base font-semibold text-white text-center flex-1 truncate">
            <span className="text-slate-400 font-normal">Create Job </span>
            <span className="text-slate-500 font-normal mx-1">—</span>
            {stepLabel}
          </h1>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close wizard"
            className="
              inline-flex h-9 w-9 items-center justify-center rounded-lg
              text-slate-400 hover:text-white hover:bg-white/5
              focus:outline-none focus-visible:ring-2 focus-visible:ring-[#36d1dc]
              focus-visible:ring-offset-2 focus-visible:ring-offset-[#131c26]
              shrink-0
            "
          >
            <X size={18} />
          </button>
        </div>
      </header>
    );
  }

  return (
    <header className="shrink-0 border-b border-[#36d1dc]/15 bg-[#131c26]">
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate(`/entreprise/${entrepriseId}`)}
          className="inline-flex items-center gap-1 text-sm text-slate-300 hover:text-white"
        >
          <ArrowLeft size={16} /> Back to profile
        </button>
        <h1 className="text-lg font-semibold text-white">
          {mode === 'edit' ? 'Edit Job' : 'Create New Job'}
        </h1>
        <div className="w-32" aria-hidden="true" />
      </div>
    </header>
  );
}
Header.propTypes = {
  inDrawer:     PropTypes.bool,
  onClose:      PropTypes.func,
  entrepriseId: PropTypes.string,
  mode:         PropTypes.oneOf(['new', 'edit']),
  currentStep:  PropTypes.number.isRequired,
};

function buildSavePayload(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}
