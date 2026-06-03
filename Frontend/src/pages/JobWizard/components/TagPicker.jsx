import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';

/**
 * Reusable tag input matching the NextHire dark theme. Ports the Enter/comma
 * UX from the existing form in EntrepriseProfile.jsx:
 *
 *   - Enter OR comma commits the typed value as a tag
 *   - Backspace on empty input removes the last tag
 *   - Suggestions filter by current input, case-insensitively
 *   - "Add '<custom>'" entry appears when no suggestion matches
 *   - Case-insensitive dedup against existing values
 *   - Removable chips
 */
export default function TagPicker({
  values = [],
  onChange,
  suggestions = [],
  allowCustom = true,
  placeholder = 'Type and press Enter',
  ariaLabel,
  disabled = false,
  className,
}) {
  const [input, setInput] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const inputRef = useRef(null);

  const lowerSet = useMemo(
    () => new Set(values.map((v) => String(v).toLowerCase())),
    [values]
  );

  const filteredSuggestions = useMemo(() => {
    const q = input.trim().toLowerCase();
    return suggestions.filter(
      (s) => s.toLowerCase().includes(q) && !lowerSet.has(s.toLowerCase())
    );
  }, [input, suggestions, lowerSet]);

  const trimmedInput = input.trim();
  const showCustomAdd =
    allowCustom &&
    trimmedInput.length > 0 &&
    filteredSuggestions.length === 0 &&
    !lowerSet.has(trimmedInput.toLowerCase());

  const addTag = (raw) => {
    const v = String(raw).trim();
    if (!v) return;
    if (lowerSet.has(v.toLowerCase())) {
      setInput('');
      return;
    }
    onChange?.([...values, v]);
    setInput('');
  };

  const removeTag = (tag) => {
    onChange?.(values.filter((v) => v !== tag));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (trimmedInput) addTag(trimmedInput);
    } else if (e.key === 'Backspace' && !input && values.length > 0) {
      e.preventDefault();
      onChange?.(values.slice(0, -1));
    } else if (e.key === 'Escape') {
      setIsOpen(false);
    }
  };

  useEffect(() => {
    const onClickAway = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, []);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div
        className={cn(
          'flex flex-wrap items-center gap-1.5 min-h-[44px] w-full rounded-lg border border-[#36d1dc]/25 bg-[#131c26] px-2 py-1.5',
          'focus-within:ring-2 focus-within:ring-[#5b86e5]/40 focus-within:border-[#5b86e5]',
          disabled && 'opacity-50 pointer-events-none'
        )}
      >
        {values.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-md bg-white text-black border border-[#36d1dc]/30 px-2 py-0.5 text-sm font-medium"
          >
            {tag}
            <button
              type="button"
              aria-label={`Remove ${tag}`}
              onClick={() => removeTag(tag)}
              className="rounded hover:bg-black/10 p-0.5 text-slate-600 hover:text-black"
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          aria-label={ariaLabel}
          value={input}
          onChange={(e) => { setInput(e.target.value); setIsOpen(true); }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={values.length === 0 ? placeholder : ''}
          disabled={disabled}
          className="flex-1 min-w-[120px] bg-transparent outline-none border-0 px-1 py-0.5 text-sm text-white placeholder:text-slate-500"
        />
      </div>

      {isOpen && !disabled && (filteredSuggestions.length > 0 || showCustomAdd) && (
        <div className="absolute z-20 mt-1 w-full max-h-56 overflow-auto rounded-lg border border-[#36d1dc]/25 bg-[#131c26] shadow-xl shadow-black/40">
          {filteredSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => addTag(s)}
              className="block w-full text-left px-3 py-2 text-sm text-slate-100 hover:bg-[#5b86e5]/15 hover:text-[#c9f9ff]"
            >
              {s}
            </button>
          ))}
          {showCustomAdd && (
            <button
              type="button"
              onClick={() => addTag(trimmedInput)}
              className={cn(
                'block w-full text-left px-3 py-2 text-sm text-emerald-300 hover:bg-emerald-500/10',
                filteredSuggestions.length > 0 && 'border-t border-[#36d1dc]/15'
              )}
            >
              Add &ldquo;{trimmedInput}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}

TagPicker.propTypes = {
  values:      PropTypes.arrayOf(PropTypes.string),
  onChange:    PropTypes.func.isRequired,
  suggestions: PropTypes.arrayOf(PropTypes.string),
  allowCustom: PropTypes.bool,
  placeholder: PropTypes.string,
  ariaLabel:   PropTypes.string,
  disabled:    PropTypes.bool,
  className:   PropTypes.string,
};
