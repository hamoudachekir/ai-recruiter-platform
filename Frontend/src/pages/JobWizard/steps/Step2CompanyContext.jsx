import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import {
  AlertCircle,
  Building2,
  Check,
  ChevronDown,
  ExternalLink,
  Info,
  Loader2,
  Plus,
} from 'lucide-react';
import { Actions } from '../wizardReducer';
import { TOTAL_STEPS } from '../wizardConfig';
import { listCompanyContexts, createCompanyContext } from '../wizardApi';
import {
  Field,
  FIELD_BASE,
  StepHeader,
  TextInput,
  Textarea,
  WizardCard,
} from '../components/FormPrimitives';
import { cn } from '../../../lib/utils';

const HEX_RE = /^#([0-9a-f]{3}){1,2}$/i;
const COLOR_KEYS = ['primary', 'secondary', 'accent'];
const COLOR_DEFAULTS = { primary: '#5b86e5', secondary: '#36d1dc', accent: '#ff8a5b' };

const emptyNewContext = {
  name: '',
  website: '',
  industry: '',
  description: '',
  brandColors: { ...COLOR_DEFAULTS },
};

/**
 * Step 2 — Company Context.
 * Required. Selecting a context snapshots its name into companyName (used in
 * Step 3) so the wizard's Job Details can pre-fill consistently.
 */
export default function Step2CompanyContext({ state, dispatch }) {
  const [contexts, setContexts]   = useState([]);
  const [loading, setLoading]     = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [isOpen, setIsOpen]           = useState(false);
  const [search, setSearch]           = useState('');
  const [isAdding, setIsAdding]       = useState(false);
  const [newContext, setNewContext]   = useState(emptyNewContext);
  const [isCreating, setIsCreating]   = useState(false);
  const [createError, setCreateError] = useState(null);

  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listCompanyContexts();
        if (cancelled) return;
        setContexts(list || []);
        if (!state.data.companyContextId && (list || []).length === 1) {
          const only = list[0];
          dispatch({
            type: Actions.SET_FIELDS,
            fields: {
              companyContextId: only._id,
              companyName: state.data.companyName?.trim() ? state.data.companyName : only.name,
            },
          });
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err?.response?.data?.message || err.message || 'Failed to load contexts');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    () => contexts.find((c) => c._id === state.data.companyContextId),
    [contexts, state.data.companyContextId]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contexts;
    return contexts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.industry || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q)
    );
  }, [contexts, search]);

  const handleSelect = (ctx) => {
    dispatch({
      type: Actions.SET_FIELDS,
      fields: {
        companyContextId: ctx._id,
        companyName: state.data.companyName?.trim() ? state.data.companyName : ctx.name,
      },
    });
    setIsOpen(false);
    setSearch('');
  };

  const resetAddForm = () => {
    setIsAdding(false);
    setNewContext(emptyNewContext);
    setCreateError(null);
  };

  const handleCreate = async () => {
    if (!newContext.name.trim() || isCreating) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      const colors = {};
      for (const key of COLOR_KEYS) {
        const v = newContext.brandColors[key];
        if (v && HEX_RE.test(v)) colors[key] = v;
      }
      const payload = {
        name:        newContext.name.trim(),
        website:     newContext.website.trim() || undefined,
        industry:    newContext.industry.trim() || undefined,
        description: newContext.description.trim() || undefined,
        brandColors: Object.keys(colors).length ? colors : undefined,
      };
      const ctx = await createCompanyContext(payload);
      setContexts((prev) => [...prev, ctx].sort((a, b) => a.name.localeCompare(b.name)));
      dispatch({
        type: Actions.SET_FIELDS,
        fields: {
          companyContextId: ctx._id,
          companyName: state.data.companyName?.trim() ? state.data.companyName : ctx.name,
        },
      });
      resetAddForm();
      setIsOpen(false);
    } catch (err) {
      setCreateError(err?.response?.data?.message || err.message || 'Failed to create');
    } finally {
      setIsCreating(false);
    }
  };

  const updateNew = (patch) => setNewContext((prev) => ({ ...prev, ...patch }));
  const updateColor = (key, value) =>
    setNewContext((prev) => ({ ...prev, brandColors: { ...prev.brandColors, [key]: value } }));

  const openCreateForm = () => {
    setIsAdding(true);
    setIsOpen(true);
  };

  return (
    <WizardCard>
      <StepHeader
        stepNumber={2}
        totalSteps={TOTAL_STEPS}
        title="Choose Company Context"
        subtitle="This is how Nour and the technical agent will represent your brand during interviews."
      />

      <div className="mt-4 flex items-start gap-3 rounded-xl border border-[#5b86e5]/30 bg-[#5b86e5]/10 px-4 py-3">
        <Info size={18} className="mt-0.5 shrink-0 text-[#36d1dc]" />
        <div className="text-sm text-slate-200 leading-relaxed">
          <p>
            Select a company context to help <span className="font-medium text-white">Nour</span> understand your
            company&apos;s values and culture. <span className="font-medium text-white">This step is mandatory.</span>
          </p>
          <p className="mt-1 text-slate-300/80">
            This helps provide a more personalized interview experience for candidates.
          </p>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-200">Select Company Context</h3>
        <button
          type="button"
          onClick={openCreateForm}
          className="inline-flex items-center gap-1 text-sm text-[#36d1dc] hover:underline"
        >
          Create new context <ExternalLink size={12} />
        </button>
      </div>

      <div ref={containerRef} className="relative mt-2">
        <button
          type="button"
          onClick={() => setIsOpen((o) => !o)}
          aria-expanded={isOpen}
          className={cn(
            FIELD_BASE,
            'flex items-center justify-between text-left h-auto py-3 px-3'
          )}
        >
          <div className="flex items-center gap-3 min-w-0">
            <ContextAvatar context={selected} />
            <div className="min-w-0">
              {selected ? (
                <>
                  <div className="text-base font-semibold text-white truncate">{selected.name}</div>
                  {selected.industry && (
                    <div className="text-xs text-slate-400 truncate">{selected.industry}</div>
                  )}
                </>
              ) : (
                <div className="text-slate-500">Select a company context</div>
              )}
            </div>
          </div>
          <ChevronDown
            size={18}
            className={cn('text-[#36d1dc] transition-transform shrink-0', isOpen && 'rotate-180')}
          />
        </button>

        {isOpen && (
          <div className="absolute z-20 mt-1 w-full rounded-lg border border-[#36d1dc]/25 bg-[#131c26] shadow-xl shadow-black/40">
            <div className="p-2 border-b border-[#36d1dc]/15">
              <TextInput
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search contexts..."
              />
            </div>

            {!isAdding && (
              <button
                type="button"
                onClick={() => setIsAdding(true)}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-emerald-300 border-b border-[#36d1dc]/15 hover:bg-emerald-500/10"
              >
                <Plus size={14} /> Create new context
              </button>
            )}

            {isAdding && (
              <div className="p-3 border-b border-[#36d1dc]/15 space-y-3 bg-[#0b0c2a]/40">
                <Field label="Name" required htmlFor="new-ctx-name">
                  <TextInput
                    id="new-ctx-name"
                    autoFocus
                    value={newContext.name}
                    onChange={(e) => updateNew({ name: e.target.value })}
                    placeholder="e.g. NextHire"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Website" htmlFor="new-ctx-website">
                    <TextInput
                      id="new-ctx-website"
                      value={newContext.website}
                      onChange={(e) => updateNew({ website: e.target.value })}
                      placeholder="https://..."
                    />
                  </Field>
                  <Field label="Industry" htmlFor="new-ctx-industry">
                    <TextInput
                      id="new-ctx-industry"
                      value={newContext.industry}
                      onChange={(e) => updateNew({ industry: e.target.value })}
                      placeholder="e.g. HR Technology"
                    />
                  </Field>
                </div>
                <Field
                  label="Description / brand voice"
                  hint="Used by the AI agents to keep interviews on-brand."
                  htmlFor="new-ctx-desc"
                >
                  <Textarea
                    id="new-ctx-desc"
                    rows={3}
                    value={newContext.description}
                    onChange={(e) => updateNew({ description: e.target.value })}
                    placeholder="We build AI-powered hiring tools..."
                  />
                </Field>

                <div>
                  <p className="block text-sm font-medium text-slate-200 mb-1.5">Brand colors</p>
                  <div className="grid grid-cols-3 gap-2">
                    {COLOR_KEYS.map((key) => (
                      <div key={key} className="flex flex-col gap-1">
                        <input
                          type="color"
                          aria-label={`${key} color`}
                          value={newContext.brandColors[key] || COLOR_DEFAULTS[key]}
                          onChange={(e) => updateColor(key, e.target.value)}
                          className="h-9 w-full rounded-lg border border-[#36d1dc]/25 bg-[#131c26] cursor-pointer"
                        />
                        <span className="text-xs text-slate-400 capitalize">{key}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {createError && (
                  <div className="text-xs text-rose-400 flex items-start gap-1">
                    <AlertCircle size={12} className="mt-0.5 shrink-0" /> {createError}
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={!newContext.name.trim() || isCreating}
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
                  No contexts {search ? 'match your search.' : 'yet — create one above.'}
                </li>
              )}
              {filtered.map((ctx) => {
                const isSelected = ctx._id === state.data.companyContextId;
                return (
                  <li key={ctx._id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(ctx)}
                      className={cn(
                        'w-full flex items-start justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-[#5b86e5]/15',
                        isSelected && 'bg-[#5b86e5]/20'
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <ContextAvatar context={ctx} small />
                        <div className="min-w-0">
                          <div className="text-slate-100 font-medium truncate">{ctx.name}</div>
                          {ctx.industry && (
                            <div className="text-xs text-slate-400 truncate">{ctx.industry}</div>
                          )}
                        </div>
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

      {selected && <ContextDetails context={selected} />}
    </WizardCard>
  );
}

Step2CompanyContext.propTypes = {
  state: PropTypes.shape({
    data: PropTypes.shape({
      companyContextId: PropTypes.string,
      companyName:      PropTypes.string,
    }).isRequired,
  }).isRequired,
  dispatch: PropTypes.func.isRequired,
};

function ContextAvatar({ context, small = false }) {
  const size = small ? 'h-7 w-7' : 'h-10 w-10';
  const iconSize = small ? 14 : 18;
  const primary = context?.brandColors?.primary || '#5b86e5';
  const accent  = context?.brandColors?.secondary || '#36d1dc';
  return (
    <div
      className={cn(
        size,
        'shrink-0 rounded-lg flex items-center justify-center text-white shadow-inner shadow-black/30'
      )}
      style={{ background: `linear-gradient(135deg, ${primary} 0%, ${accent} 100%)` }}
      aria-hidden="true"
    >
      <Building2 size={iconSize} />
    </div>
  );
}

ContextAvatar.propTypes = {
  context: PropTypes.shape({
    brandColors: PropTypes.object,
  }),
  small: PropTypes.bool,
};

function DetailField({ label, children }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1 text-sm text-slate-100">{children}</div>
    </div>
  );
}

DetailField.propTypes = {
  label: PropTypes.string.isRequired,
  children: PropTypes.node.isRequired,
};

function ContextDetails({ context }) {
  const colors = context.brandColors || {};
  const hasColors = COLOR_KEYS.some((k) => colors[k]);

  return (
    <div className="mt-6 rounded-xl border border-[#36d1dc]/20 bg-[#0b0c2a]/40 p-5">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <DetailField label="Website">
          {context.website ? (
            <a
              href={context.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[#36d1dc] hover:underline break-all"
            >
              {context.website}
              <ExternalLink size={12} className="shrink-0" />
            </a>
          ) : (
            <span className="text-slate-500">—</span>
          )}
        </DetailField>
        <DetailField label="Industry">
          {context.industry || <span className="text-slate-500">—</span>}
        </DetailField>
      </div>

      <div className="mt-5">
        <DetailField label="Description">
          {context.description
            ? <span className="leading-relaxed text-slate-200">{context.description}</span>
            : <span className="text-slate-500">—</span>}
        </DetailField>
      </div>

      {hasColors && (
        <div className="mt-5">
          <p className="text-xs uppercase tracking-wide text-slate-500">Brand Colors</p>
          <div className="mt-2 flex flex-wrap gap-4">
            {COLOR_KEYS.map((key) =>
              colors[key] ? (
                <div key={key} className="flex items-center gap-2">
                  <span
                    className="inline-block w-7 h-7 rounded-md border border-white/10 shadow-inner shadow-black/40"
                    style={{ backgroundColor: colors[key] }}
                    aria-hidden="true"
                  />
                  <span className="text-sm font-mono text-slate-200">{colors[key]}</span>
                </div>
              ) : null
            )}
          </div>
        </div>
      )}
    </div>
  );
}

ContextDetails.propTypes = {
  context: PropTypes.shape({
    name:        PropTypes.string.isRequired,
    industry:    PropTypes.string,
    website:     PropTypes.string,
    description: PropTypes.string,
    brandColors: PropTypes.object,
  }).isRequired,
};
