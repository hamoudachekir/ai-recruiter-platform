import PropTypes from 'prop-types';
import { ChevronLeft, ChevronRight, Save, Send, Loader2 } from 'lucide-react';
import { cn } from '../../../lib/utils';

/**
 * Sticky footer matching the NextHire dark theme.
 * Back (left) — Status (center) — Save draft + Continue / Publish (right).
 */
export default function WizardFooter({
  isFirstStep = false,
  isLastStep  = false,
  canContinue = true,
  isSaving = false,
  isPublishing = false,
  lastSavedAt = null,
  onBack,
  onContinue,
  onSaveDraft,
  onPublish,
}) {
  const statusLabel = getStatusLabel(isSaving, lastSavedAt);

  return (
    <div className="sticky bottom-0 z-20 border-t border-[#36d1dc]/15 bg-[#0b0c2a]/95 backdrop-blur">
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between gap-4">
        <div className="min-w-[100px]">
          {!isFirstStep && (
            <button
              type="button"
              onClick={onBack}
              disabled={isSaving || isPublishing}
              className={cn(
                'inline-flex items-center gap-1 px-4 py-2 rounded-lg text-slate-200 hover:bg-white/5 font-medium',
                'disabled:opacity-40 disabled:cursor-not-allowed'
              )}
            >
              <ChevronLeft size={16} /> Back
            </button>
          )}
        </div>

        <div className="text-xs text-slate-400 truncate" aria-live="polite">
          {statusLabel}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSaveDraft}
            disabled={isSaving || isPublishing}
            className={cn(
              'inline-flex items-center gap-1 px-4 py-2 rounded-lg border border-[#36d1dc]/30 bg-[#131c26] text-slate-100 hover:border-[#36d1dc]/60 hover:bg-[#131c26]/80 font-medium',
              'disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Save as draft
          </button>

          {isLastStep ? (
            <button
              type="button"
              onClick={onPublish}
              disabled={!canContinue || isPublishing || isSaving}
              className={cn(
                'inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-500 text-white font-semibold hover:bg-emerald-600 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]',
                'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none'
              )}
            >
              {isPublishing ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              Publish
            </button>
          ) : (
            <button
              type="button"
              onClick={onContinue}
              disabled={!canContinue || isSaving || isPublishing}
              className={cn(
                'inline-flex items-center gap-1 px-5 py-2 rounded-lg bg-gradient-to-br from-[#5b86e5] to-[#36d1dc] text-white font-semibold hover:brightness-110',
                'disabled:opacity-40 disabled:cursor-not-allowed disabled:from-slate-600 disabled:to-slate-600 disabled:brightness-100'
              )}
            >
              Continue <ChevronRight size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

WizardFooter.propTypes = {
  isFirstStep:  PropTypes.bool,
  isLastStep:   PropTypes.bool,
  canContinue:  PropTypes.bool,
  isSaving:     PropTypes.bool,
  isPublishing: PropTypes.bool,
  lastSavedAt:  PropTypes.number,
  onBack:       PropTypes.func,
  onContinue:   PropTypes.func,
  onSaveDraft:  PropTypes.func,
  onPublish:    PropTypes.func,
};

function getStatusLabel(isSaving, lastSavedAt) {
  if (isSaving) return 'Saving draft…';
  if (lastSavedAt) return `Saved at ${formatTime(lastSavedAt)}`;
  return '';
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
