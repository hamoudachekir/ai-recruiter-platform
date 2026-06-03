import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { AlertCircle, Check, ChevronDown, Loader2, Plus } from 'lucide-react';
import { Actions } from '../wizardReducer';
import { TOTAL_STEPS } from '../wizardConfig';
import { listDepartments, createDepartment } from '../wizardApi';
import {
  Field,
  FIELD_BASE,
  StepHeader,
  TextInput,
  Textarea,
  WizardCard,
} from '../components/FormPrimitives';
import { cn } from '../../../lib/utils';

/**
 * Step 1 — Department.
 * Searchable dropdown of existing departments scoped to the calling enterprise,
 * plus an inline "Add New Department" form that creates and auto-selects.
 */
export default function Step1Department({ state, dispatch }) {
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading]         = useState(true);
  const [loadError, setLoadError]     = useState(null);

  const [isOpen, setIsOpen]           = useState(false);
  const [search, setSearch]           = useState('');
  const [isAdding, setIsAdding]       = useState(false);
  const [newName, setNewName]         = useState('');
  const [newDesc, setNewDesc]         = useState('');
  const [isCreating, setIsCreating]   = useState(false);
  const [createError, setCreateError] = useState(null);

  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listDepartments();
        if (!cancelled) setDepartments(list || []);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err?.response?.data?.message || err.message || 'Failed to load departments');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onClickAway = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickAway);
    return () => document.removeEventListener('mousedown', onClickAway);
  }, []);

  const selected = useMemo(
    () => departments.find((d) => d._id === state.data.departmentId),
    [departments, state.data.departmentId]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return departments;
    return departments.filter(
      (d) =>
        d.name.toLowerCase().includes(q) ||
        (d.description || '').toLowerCase().includes(q)
    );
  }, [departments, search]);

  const handleSelect = (dept) => {
    dispatch({ type: Actions.SET_FIELDS, fields: { departmentId: dept._id } });
    setIsOpen(false);
    setSearch('');
  };

  const resetAddForm = () => {
    setIsAdding(false);
    setNewName('');
    setNewDesc('');
    setCreateError(null);
  };

  const handleCreate = async () => {
    if (!newName.trim() || isCreating) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      const dept = await createDepartment({
        name: newName.trim(),
        description: newDesc.trim() || undefined,
      });
      setDepartments((prev) => [...prev, dept].sort((a, b) => a.name.localeCompare(b.name)));
      dispatch({ type: Actions.SET_FIELDS, fields: { departmentId: dept._id } });
      resetAddForm();
      setIsOpen(false);
    } catch (err) {
      setCreateError(err?.response?.data?.message || err.message || 'Failed to create');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <WizardCard>
      <StepHeader
        stepNumber={1}
        totalSteps={TOTAL_STEPS}
        title="Choose a Department"
        subtitle="Pick where this role will live. You can add a new one if it doesn't exist yet."
      />

      <div ref={containerRef} className="relative max-w-xl">
        <button
          type="button"
          onClick={() => setIsOpen((o) => !o)}
          aria-expanded={isOpen}
          className={cn(FIELD_BASE, 'flex items-center justify-between text-left')}
        >
          <span className={selected ? 'text-white' : 'text-slate-500'}>
            {selected ? selected.name : 'Select a department'}
          </span>
          <ChevronDown
            size={16}
            className={cn('text-[#36d1dc] transition-transform', isOpen && 'rotate-180')}
          />
        </button>

        {isOpen && (
          <div className="absolute z-20 mt-1 w-full rounded-lg border border-[#36d1dc]/25 bg-[#131c26] shadow-xl shadow-black/40">
            <div className="p-2 border-b border-[#36d1dc]/15">
              <TextInput
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search departments..."
              />
            </div>

            <button
              type="button"
              onClick={() => setIsAdding(true)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-emerald-300 border-b border-[#36d1dc]/15 hover:bg-emerald-500/10"
            >
              <Plus size={14} /> Add New Department
            </button>

            {isAdding && (
              <div className="p-3 border-b border-[#36d1dc]/15 space-y-3 bg-[#0b0c2a]/40">
                <Field label="Name" required htmlFor="new-dept-name">
                  <TextInput
                    id="new-dept-name"
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="e.g. Engineering"
                  />
                </Field>
                <Field label="Description (optional)" htmlFor="new-dept-desc">
                  <Textarea
                    id="new-dept-desc"
                    rows={2}
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                    placeholder="What does this department do?"
                  />
                </Field>
                {createError && (
                  <div className="text-xs text-rose-400 flex items-start gap-1">
                    <AlertCircle size={12} className="mt-0.5 shrink-0" /> {createError}
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={!newName.trim() || isCreating}
                    className={cn(
                      'inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-gradient-to-br from-[#5b86e5] to-[#36d1dc] text-white text-sm font-medium hover:brightness-110',
                      'disabled:opacity-40 disabled:cursor-not-allowed'
                    )}
                  >
                    {isCreating && <Loader2 size={12} className="animate-spin" />}
                    Create
                  </button>
                  <button
                    type="button"
                    onClick={resetAddForm}
                    className="px-3 py-1.5 rounded-md text-sm text-slate-300 hover:bg-white/5"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <ul className="max-h-60 overflow-auto">
              {loading && (
                <li className="px-3 py-2 text-sm text-slate-400 flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Loading…
                </li>
              )}
              {loadError && (
                <li className="px-3 py-2 text-sm text-rose-400 flex items-center gap-2">
                  <AlertCircle size={14} /> {loadError}
                </li>
              )}
              {!loading && !loadError && filtered.length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-500 italic">
                  No departments {search ? 'match your search.' : 'yet — create one above.'}
                </li>
              )}
              {filtered.map((dept) => {
                const isSelected = dept._id === state.data.departmentId;
                return (
                  <li key={dept._id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(dept)}
                      className={cn(
                        'w-full flex items-start justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-[#5b86e5]/15',
                        isSelected && 'bg-[#5b86e5]/20'
                      )}
                    >
                      <div className="min-w-0">
                        <div className="text-slate-100 font-medium">{dept.name}</div>
                        {dept.description && (
                          <div className="text-xs text-slate-400 mt-0.5 truncate">{dept.description}</div>
                        )}
                      </div>
                      {isSelected && <Check size={14} className="text-emerald-400 mt-1 shrink-0" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {selected && (
        <div className="mt-5 max-w-xl rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
          <span className="text-emerald-300 font-medium">{selected.name}</span>
          {selected.description && <span className="text-slate-300 ml-2">— {selected.description}</span>}
        </div>
      )}
    </WizardCard>
  );
}

Step1Department.propTypes = {
  state: PropTypes.shape({
    data: PropTypes.shape({ departmentId: PropTypes.string }).isRequired,
  }).isRequired,
  dispatch: PropTypes.func.isRequired,
};
