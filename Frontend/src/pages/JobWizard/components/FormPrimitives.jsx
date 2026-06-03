import PropTypes from 'prop-types';
import { cn } from '../../../lib/utils';

/**
 * Dark-theme form primitives matching the NextHire navy/teal palette.
 * Used by every step component so the look stays consistent.
 */

// Labeled wrapper. Optional hint and inline error.
export function Field({ label, hint, error, required, children, className, htmlFor }) {
  return (
    <div className={cn('flex flex-col', className)}>
      {label && (
        <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-200 mb-1.5">
          {label}
          {required && <span className="text-rose-400 ml-0.5">*</span>}
        </label>
      )}
      {children}
      {hint && !error && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
      {error && <p className="mt-1 text-xs text-rose-400">{error}</p>}
    </div>
  );
}
Field.propTypes = {
  label:     PropTypes.node,
  hint:      PropTypes.node,
  error:     PropTypes.node,
  required:  PropTypes.bool,
  children:  PropTypes.node,
  className: PropTypes.string,
  htmlFor:   PropTypes.string,
};

export const FIELD_BASE =
  'w-full rounded-lg border border-[#36d1dc]/25 bg-[#131c26] px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-[#5b86e5] focus:ring-2 focus:ring-[#5b86e5]/30 focus:outline-none disabled:opacity-50';

export function TextInput({ className, error, ...props }) {
  return (
    <input
      {...props}
      className={cn(
        FIELD_BASE,
        error && 'border-rose-500/60 focus:border-rose-500 focus:ring-rose-500/30',
        className
      )}
    />
  );
}
TextInput.propTypes = {
  className: PropTypes.string,
  error:     PropTypes.bool,
};

export function Textarea({ className, error, rows = 4, ...props }) {
  return (
    <textarea
      {...props}
      rows={rows}
      className={cn(
        FIELD_BASE,
        'resize-y min-h-[88px]',
        error && 'border-rose-500/60 focus:border-rose-500 focus:ring-rose-500/30',
        className
      )}
    />
  );
}
Textarea.propTypes = {
  className: PropTypes.string,
  error:     PropTypes.bool,
  rows:      PropTypes.number,
};

export function SelectInput({ className, error, children, style, ...props }) {
  return (
    <select
      {...props}
      // colorScheme: 'light' tells the browser to render the OPEN dropdown
      // menu using light system colors (white background, dark text) instead
      // of inheriting Windows/macOS dark mode — which was making the picked
      // value invisible (white-on-white) on some setups.
      // The inline color + backgroundColor force the CLOSED select to keep
      // the dark navy wizard theme regardless of OS dark mode.
      style={{ colorScheme: 'light', color: '#ffffff', backgroundColor: '#131c26', ...style }}
      className={cn(
        FIELD_BASE,
        'appearance-none bg-[length:1rem] bg-no-repeat pr-9',
        'bg-[image:url("data:image/svg+xml,%3Csvg%20xmlns=%27http://www.w3.org/2000/svg%27%20viewBox=%270%200%2020%2020%27%20fill=%27%2336d1dc%27%3E%3Cpath%20d=%27M5.23%207.21a.75.75%200%200%201%201.06.02L10%2011.06l3.71-3.83a.75.75%200%200%201%201.08%201.04l-4.25%204.39a.75.75%200%200%201-1.08%200L5.21%208.27a.75.75%200%200%201%20.02-1.06z%27/%3E%3C/svg%3E")]',
        'bg-[right_0.625rem_center]',
        '[&>option]:bg-white [&>option]:text-black',
        error && 'border-rose-500/60 focus:border-rose-500 focus:ring-rose-500/30',
        className
      )}
    >
      {children}
    </select>
  );
}
SelectInput.propTypes = {
  className: PropTypes.string,
  error:     PropTypes.bool,
  children:  PropTypes.node,
  style:     PropTypes.object,
};

export function Toggle({ checked, onChange, label, hint, disabled, className }) {
  return (
    <div className={cn('flex items-start gap-3', disabled && 'opacity-50', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={typeof label === 'string' ? label : undefined}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-[#5b86e5] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0c2a]',
          checked ? 'bg-gradient-to-r from-[#5b86e5] to-[#36d1dc]' : 'bg-slate-700',
          disabled ? 'cursor-not-allowed' : 'cursor-pointer'
        )}
      >
        <span
          className={cn(
            'inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0.5'
          )}
        />
      </button>
      {(label || hint) && (
        <div className="flex flex-col">
          {label && <span className="text-sm font-medium text-slate-100">{label}</span>}
          {hint  && <span className="text-xs text-slate-400">{hint}</span>}
        </div>
      )}
    </div>
  );
}
Toggle.propTypes = {
  checked:   PropTypes.bool,
  onChange:  PropTypes.func,
  label:     PropTypes.node,
  hint:      PropTypes.node,
  disabled:  PropTypes.bool,
  className: PropTypes.string,
};

// Container styling reused by every step's content area.
export function WizardCard({ children, className }) {
  return (
    <div
      className={cn(
        'rounded-xl border border-[#36d1dc]/15 bg-[#131c26]/70 shadow-[0_1px_2px_rgba(0,0,0,0.3)] p-6',
        className
      )}
    >
      {children}
    </div>
  );
}
WizardCard.propTypes = {
  children:  PropTypes.node,
  className: PropTypes.string,
};

// Step header (eyebrow + title + optional subtitle).
export function StepHeader({ stepNumber, totalSteps, title, subtitle }) {
  return (
    <div className="mb-6">
      <p className="text-xs uppercase tracking-wider text-[#36d1dc] font-semibold">
        Step {stepNumber}{totalSteps ? ` of ${totalSteps}` : ''}
      </p>
      <h2 className="mt-1 text-2xl font-semibold text-white">{title}</h2>
      {subtitle && <p className="mt-1.5 text-sm text-slate-400">{subtitle}</p>}
    </div>
  );
}
StepHeader.propTypes = {
  stepNumber: PropTypes.number.isRequired,
  totalSteps: PropTypes.number,
  title:      PropTypes.node.isRequired,
  subtitle:   PropTypes.node,
};
