import PropTypes from 'prop-types';
import { Check, Minus } from 'lucide-react';
import { cn } from '../../../lib/utils';

/**
 * Horizontal numbered stepper. Four visual states per step:
 *   completed — passed through; emerald circle with check
 *   current   — on this step now; gradient circle with number
 *   skipped   — not applicable for this interview type; dashed gray with minus
 *   locked    — not yet reachable; muted outline
 */

function StepIcon({ isCompleted, skipped, number }) {
  if (isCompleted) return <Check size={16} strokeWidth={3} />;
  if (skipped) return <Minus size={14} strokeWidth={3} />;
  return number;
}
StepIcon.propTypes = {
  isCompleted: PropTypes.bool,
  skipped:     PropTypes.bool,
  number:      PropTypes.number.isRequired,
};

function getButtonClasses({ isCompleted, isCurrent, skipped, isLocked }) {
  if (isCompleted) {
    return 'bg-emerald-500 text-white hover:bg-emerald-600 cursor-pointer shadow-[0_0_0_3px_rgba(16,185,129,0.18)]';
  }
  if (isCurrent) {
    return 'bg-gradient-to-br from-[#5b86e5] to-[#36d1dc] text-white ring-4 ring-[#36d1dc]/25';
  }
  if (skipped) {
    return 'border border-dashed border-slate-600 bg-transparent text-slate-500 cursor-not-allowed';
  }
  if (isLocked) {
    return 'border-2 border-slate-700 bg-[#0b0c2a] text-slate-500 cursor-not-allowed';
  }
  return 'border-2 border-[#36d1dc]/40 bg-[#131c26] text-slate-200 cursor-pointer hover:border-[#36d1dc]';
}

function getLabelClasses({ isCompleted, isCurrent, skipped, isLocked }) {
  if (isCurrent)   return 'font-semibold text-[#c9f9ff]';
  if (isCompleted) return 'text-emerald-300 font-medium';
  if (skipped)     return 'text-slate-500 italic';
  if (isLocked)    return 'text-slate-500';
  return 'text-slate-300';
}

function StepItem({ step, currentStep, furthestStep, isSkipped, onStepClick, isFirst }) {
  const skipped     = isSkipped(step.number);
  const isCurrent   = step.number === currentStep;
  const isCompleted = !isCurrent && !skipped && step.number <= furthestStep;
  const isLocked    = !skipped && step.number > furthestStep;
  const isClickable = !skipped && !isLocked && !isCurrent;
  const connectorActive = step.number <= furthestStep;

  const buttonLabel = skipped
    ? `Step ${step.number}: ${step.label} (skipped)`
    : `Step ${step.number}: ${step.label}`;

  const flags = { isCompleted, isCurrent, skipped, isLocked };

  return (
    <li className="relative flex-1 flex flex-col items-center px-1 min-w-0">
      {!isFirst && (
        <div
          aria-hidden="true"
          className={cn(
            'absolute top-[18px] left-[-50%] right-1/2 h-0.5',
            connectorActive ? 'bg-emerald-500' : 'bg-slate-700/60'
          )}
        />
      )}

      <button
        type="button"
        disabled={!isClickable}
        onClick={() => isClickable && onStepClick?.(step.number)}
        aria-current={isCurrent ? 'step' : undefined}
        aria-label={buttonLabel}
        title={skipped ? 'Skipped for this interview type' : undefined}
        className={cn(
          'relative z-10 w-9 h-9 rounded-full flex items-center justify-center text-sm font-semibold transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c2a]',
          getButtonClasses(flags)
        )}
      >
        <StepIcon isCompleted={isCompleted} skipped={skipped} number={step.number} />
      </button>

      <span className={cn('mt-2 text-xs text-center w-full px-0.5 leading-tight', getLabelClasses(flags))}>
        {step.label}
      </span>
    </li>
  );
}
StepItem.propTypes = {
  step: PropTypes.shape({
    number: PropTypes.number.isRequired,
    label:  PropTypes.string.isRequired,
  }).isRequired,
  currentStep:  PropTypes.number.isRequired,
  furthestStep: PropTypes.number.isRequired,
  isSkipped:    PropTypes.func.isRequired,
  onStepClick:  PropTypes.func,
  isFirst:      PropTypes.bool,
};

export default function Stepper({
  steps,
  currentStep,
  furthestStep,
  onStepClick,
  isSkipped = () => false,
}) {
  return (
    <nav aria-label="Wizard steps">
      <ol className="flex items-start">
        {steps.map((step, idx) => (
          <StepItem
            key={step.number}
            step={step}
            currentStep={currentStep}
            furthestStep={furthestStep}
            isSkipped={isSkipped}
            onStepClick={onStepClick}
            isFirst={idx === 0}
          />
        ))}
      </ol>
    </nav>
  );
}
Stepper.propTypes = {
  steps: PropTypes.arrayOf(
    PropTypes.shape({
      number: PropTypes.number.isRequired,
      label:  PropTypes.string.isRequired,
    })
  ).isRequired,
  currentStep:  PropTypes.number.isRequired,
  furthestStep: PropTypes.number.isRequired,
  onStepClick:  PropTypes.func,
  isSkipped:    PropTypes.func,
};
