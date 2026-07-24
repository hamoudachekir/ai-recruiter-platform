import { useMemo, useState, useLayoutEffect, useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import {
  analyzeJob,
  exportTailoredPdf,
  generateCoverLetter,
  tailorCv,
} from './cvTailoringApi';
import { wordDiff, buildChanges, mergeCv } from './cvDiff';
import { printHtml } from './printCv';
import CvPaper from './CvPaper';
import CvDocument from './CvDocument';
import ResumeViewerModal from '../../profileFront/ResumeViewerModal';
import './cvTailoring.css';

const A4_W = 794;
const A4_H = 1123;
const FIT_ZOOM = 0.68;

const TEMPLATES = [
  { id: 'editorial', label: 'Éditorial' },
  { id: 'classic', label: 'Classique' },
  { id: 'modern', label: 'Moderne' },
  { id: 'compact', label: 'Compact' },
];

// The 12 built-in Reactive Resume templates (server-side PDF render), applied
// only when generating via "Générer le PDF" / "Utiliser ce CV" — confirmed
// against the running v4.4.6 instance (see app/mapping.py RXRESUME_TEMPLATES).
const RXRESUME_TEMPLATES = [
  'Rhyhorn', 'Azurill', 'Bronzor', 'Chikorita', 'Ditto', 'Gengar',
  'Glalie', 'Kakuna', 'Leafish', 'Nosepass', 'Onyx', 'Pikachu',
].map((label) => ({ id: label.toLowerCase(), label }));

// The self-hosted Reactive Resume serves a sample preview image per template.
const RX_URL = import.meta.env.VITE_RXRESUME_URL || 'http://localhost:3000';
const rxThumb = (id) => `${RX_URL}/templates/jpg/${id}.jpg`;

function fileUrl(raw) {
  if (raw?.startsWith('/uploads')) return `http://localhost:3001${raw}`;
  return raw;
}

function DiffText({ original, proposed }) {
  const nodes = wordDiff(original, proposed).map((p, i) => {
    if (p.type === 'add') return <mark key={i} className="diff-add">{p.text}</mark>;
    if (p.type === 'del') return <del key={i} className="diff-del">{p.text}</del>;
    return <span key={i}>{p.text}</span>;
  });
  return <p className="review-diff">{nodes.reduce((acc, el, i) => (i ? [...acc, ' ', el] : [el]), [])}</p>;
}
DiffText.propTypes = { original: PropTypes.string, proposed: PropTypes.string };

export default function TailorCvPanel({ jobId = null, onClose = null, embedded = false }) {
  const [jobText, setJobText] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [company, setCompany] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [jdOpen, setJdOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [decisions, setDecisions] = useState({}); // id -> true | false | undefined
  const [edits, setEdits] = useState({}); // id -> user-edited text
  const [editingId, setEditingId] = useState(null);
  const [tab, setTab] = useState('pending');
  const [template, setTemplate] = useState('editorial');
  const [rxTemplate, setRxTemplate] = useState('rhyhorn');
  const [previewMode, setPreviewMode] = useState('cv'); // 'cv' | 'rx'
  const [rxImgError, setRxImgError] = useState(false);
  const [pdf, setPdf] = useState(null);
  const [showDoc, setShowDoc] = useState(false);
  const [finalPdf, setFinalPdf] = useState(null); // { url, title } — server-generated PDF viewer
  const [fitAnalysis, setFitAnalysis] = useState(null);
  const [applicationId, setApplicationId] = useState(null);
  const [coverLetter, setCoverLetter] = useState('');
  const [letterLanguage, setLetterLanguage] = useState('fr');

  // Preview controls
  const [showDiff, setShowDiff] = useState(false);
  const [zoom, setZoom] = useState(FIT_ZOOM);
  const [fitZoom, setFitZoom] = useState(FIT_ZOOM);
  const [zoomTouched, setZoomTouched] = useState(false);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [reviewH, setReviewH] = useState(null); // left column height = right pane height (desktop)
  const docRef = useRef(null);
  const paneRef = useRef(null);
  const printRef = useRef(null);
  const jdRef = useRef(null); // job-description textarea — focused on open
  const historyRef = useRef({ past: [], future: [] });
  // Cache of the last server-generated PDF, keyed by (template + merged CV) so
  // "Voir le CV final" / "Télécharger PDF" don't regenerate when nothing changed.
  const exportedRef = useRef({ key: '', path: '' });

  const changes = useMemo(
    () => (result ? buildChanges(result.cv_json, result.tailored_cv_json) : []),
    [result],
  );
  const merged = useMemo(
    () => (result ? mergeCv(result.cv_json, result.tailored_cv_json, decisions, edits) : null),
    [result, decisions, edits],
  );

  // Keyword-match score (client-side, against the merged CV).
  const keywords = result?.keywords || [];
  const mergedText = useMemo(() => (merged ? JSON.stringify(merged).toLowerCase() : ''), [merged]);
  const matchedKw = keywords.filter((k) => mergedText.includes(String(k).toLowerCase()));
  const missingKw = keywords.filter((k) => !mergedText.includes(String(k).toLowerCase()));
  const pct = keywords.length ? Math.round((matchedKw.length * 100) / keywords.length) : 0;
  let scoreBadge = { label: 'À travailler', cls: 'score-badge--warn' };
  if (pct >= 75) scoreBadge = { label: 'Excellent', cls: 'score-badge--ok' };
  else if (pct >= 40) scoreBadge = { label: 'Bien', cls: 'score-badge--mid' };

  // Undo / redo over {decisions, edits}.
  function commit(nextDecisions, nextEdits) {
    const h = historyRef.current;
    h.past.push({ decisions, edits });
    if (h.past.length > 60) h.past.shift();
    h.future = [];
    setDecisions(nextDecisions);
    setEdits(nextEdits);
  }
  function undo() {
    const h = historyRef.current;
    if (!h.past.length) return;
    h.future.push({ decisions, edits });
    const prev = h.past.pop();
    setDecisions(prev.decisions); setEdits(prev.edits);
  }
  function redo() {
    const h = historyRef.current;
    if (!h.future.length) return;
    h.past.push({ decisions, edits });
    const next = h.future.pop();
    setDecisions(next.decisions); setEdits(next.edits);
  }

  const setDecision = (id, value) => commit({ ...decisions, [id]: value }, edits);
  const setAll = (value) => commit(Object.fromEntries(changes.map((c) => [c.id, value])), edits);
  const clampZoom = (z) => Math.min(1.4, Math.max(0.4, Math.round(z * 100) / 100));

  // Selecting a PDF template (from the picker or the gallery) shows it live
  // in the right pane so the candidate sees what the generated PDF will use.
  function pickRxTemplate(id) {
    setRxTemplate(id);
    setRxImgError(false);
    setPreviewMode('rx');
  }

  useLayoutEffect(() => {
    if (!docRef.current) return;
    const pages = Math.max(1, Math.ceil(docRef.current.offsetHeight / A4_H));
    setPageCount(pages);
    setPage((p) => Math.min(p, pages));
  }, [merged, showDiff, template, previewMode]);

  // Fit the A4 sheet to the pane width so it never overflows; the user can
  // still zoom manually afterwards.
  useLayoutEffect(() => {
    function refit() {
      if (!paneRef.current) return;
      const w = paneRef.current.clientWidth - 26;
      const f = Math.min(1, Math.max(0.4, Math.round((w / A4_W) * 100) / 100));
      setFitZoom(f);
      setZoom((z) => (zoomTouched ? z : f));
    }
    refit();
    window.addEventListener('resize', refit);
    return () => window.removeEventListener('resize', refit);
  }, [result, zoomTouched]);

  // Match the left review column's height to the right preview pane so both
  // sides line up (top and bottom) at every zoom/preview state. On mobile the
  // layout is single-column, so we release the constraint.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return undefined;
    const mq = window.matchMedia('(min-width: 1001px)');
    const measure = () => setReviewH(mq.matches ? pane.offsetHeight : null);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(pane);
    window.addEventListener('resize', measure);
    mq.addEventListener?.('change', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      mq.removeEventListener?.('change', measure);
    };
  }, [result, previewMode]);

  // On open (panel/modal mount, before any result), drop the caret straight
  // into the job-description field and scroll it into view so the candidate can
  // paste immediately.
  useEffect(() => {
    if (result) return undefined;
    const t = setTimeout(() => {
      jdRef.current?.focus();
      jdRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needsJobText = !jobId;
  const canGenerate = Boolean(jobId) || jobText.trim().length > 0;

  async function runTailor() {
    if (!canGenerate) {
      setError('Collez la description du poste pour générer un CV adapté.');
      return;
    }
    setLoading(true); setError(''); setPdf(null); setPhase('Analyse de l’offre et reformulation…');
    try {
      if (jobText.trim()) {
        const fit = await analyzeJob({ jobText, jobTitle, company, sourceUrl });
        setFitAnalysis(fit.analysis);
        setApplicationId(fit.application_id);
      }
      setResult(await tailorCv(jobId, jobText));
      setDecisions({}); setEdits({}); setEditingId(null); setPage(1); setTab('pending'); setJdOpen(false);
      historyRef.current = { past: [], future: [] };
    } catch (e) {
      setError(e.response?.data?.detail?.message || e.response?.data?.message || 'Échec de la reformulation. Réessayez dans une minute.');
    } finally { setLoading(false); setPhase(''); }
  }

  async function runCoverLetter() {
    if (!jobText.trim()) {
      setError('Collez la description du poste pour générer la lettre.');
      return;
    }
    setLoading(true); setError(''); setPhase('Génération de la lettre de motivation…');
    try {
      const out = await generateCoverLetter({
        jobText,
        jobTitle,
        company,
        language: letterLanguage,
      });
      setCoverLetter(out.content);
    } catch (e) {
      setError(e.response?.data?.detail || e.response?.data?.message || 'Lettre indisponible.');
    } finally { setLoading(false); setPhase(''); }
  }

  async function copyCoverLetter() {
    if (!coverLetter) return;
    await navigator.clipboard.writeText(coverLetter);
  }

  const rxLabel = RXRESUME_TEMPLATES.find((t) => t.id === rxTemplate)?.label || rxTemplate;
  const candidateName = result?.cv_json?.name || 'candidat';

  // Generate (or reuse) the real Reactive Resume PDF for the current merged CV
  // and chosen template — the single source of truth for view/download/attach.
  async function ensureServerPdf() {
    const key = `${rxTemplate}|${JSON.stringify(merged)}`;
    if (exportedRef.current.key === key && exportedRef.current.path) return exportedRef.current.path;
    const out = await exportTailoredPdf({ jobId, cvJson: result.cv_json, tailored: merged, attach: false, template: rxTemplate });
    if (!out?.pdf_path) throw new Error('PDF indisponible');
    exportedRef.current = { key, path: out.pdf_path };
    setPdf(out);
    return out.pdf_path;
  }

  async function runExport(attach) {
    if (!merged) return;
    setLoading(true); setError(''); setPdf(null); setPhase(`Génération du PDF (modèle ${rxLabel})…`);
    try {
      const out = await exportTailoredPdf({ jobId, cvJson: result.cv_json, tailored: merged, attach, template: rxTemplate });
      setPdf(out);
      if (out?.pdf_path) exportedRef.current = { key: `${rxTemplate}|${JSON.stringify(merged)}`, path: out.pdf_path };
    } catch (e) {
      const detail = e.response?.data?.detail;
      setError(typeof detail === 'string' ? detail
        : detail?.message || e.response?.data?.message || 'Génération du PDF indisponible.');
    } finally { setLoading(false); setPhase(''); }
  }

  // "Voir le CV final": show the REAL generated PDF (chosen Reactive Resume
  // template, candidate's data). Falls back to the local render if the PDF
  // service is down.
  async function viewFinal() {
    if (!merged) return;
    setLoading(true); setError(''); setPhase(`Génération du CV final (modèle ${rxLabel})…`);
    try {
      const p = await ensureServerPdf();
      setFinalPdf({ url: fileUrl(p), title: `CV — ${candidateName} (${rxLabel})` });
    } catch {
      setShowDoc(true);
      setError('Reactive Resume indisponible — aperçu local affiché (le modèle PDF choisi n’est pas appliqué).');
    } finally { setLoading(false); setPhase(''); }
  }

  // "Télécharger PDF": download the same generated PDF (same template as the
  // preview). Local print remains only as a fallback when the service is down.
  async function downloadPdf() {
    setLoading(true); setError(''); setPhase(`Génération du PDF (modèle ${rxLabel})…`);
    try {
      const url = fileUrl(await ensureServerPdf());
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `CV - ${candidateName} - ${rxLabel}.pdf`;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(objectUrl);
      } catch {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    } catch {
      printHtml(printRef.current?.innerHTML, `CV — ${candidateName}`);
    } finally { setLoading(false); setPhase(''); }
  }

  const verified = result?.verification?.passed;
  const counts = {
    pending: changes.filter((c) => decisions[c.id] === undefined).length,
    accepted: changes.filter((c) => decisions[c.id] === true).length,
    declined: changes.filter((c) => decisions[c.id] === false).length,
  };
  const visibleChanges = changes.filter((c) => {
    if (tab === 'accepted') return decisions[c.id] === true;
    if (tab === 'declined') return decisions[c.id] === false;
    return decisions[c.id] === undefined;
  });

  return (
    <div className={`tailor-panel cv-tailoring-scope${embedded ? ' tailor-panel--embedded' : ''}`}>
      <div className="editor-header">
        <div>
          <h3>{jobId ? 'Adapter mon CV à cette offre ✨' : 'Adapter mon CV à une offre ✨'}</h3>
          <p className="tailor-panel__sub">L’IA propose, vous décidez — chaque changement se reflète en direct sur le CV.</p>
        </div>
        <div className="editor-header__actions">
          {result && !loading && <button className="hd-btn" onClick={runTailor}>↻ Régénérer</button>}
          {result && (
            <button className="hd-btn hd-btn--dark" onClick={downloadPdf} disabled={loading}>⬇ Télécharger PDF</button>
          )}
          {onClose && <button className="hd-close" onClick={onClose} aria-label="Fermer">×</button>}
        </div>
      </div>

      {(!result || jdOpen) ? (
        <div className="tailor-jd-block">
          <label className="tailor-jd-label" htmlFor="tailor-jd">
            Description du poste {needsJobText ? '(requis)' : '(optionnel)'}
          </label>
          <div className="copilot-meta-grid">
            <input type="text" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)}
              placeholder="Intitulé du poste (optionnel)" disabled={loading} />
            <input type="text" value={company} onChange={(e) => setCompany(e.target.value)}
              placeholder="Entreprise (optionnel)" disabled={loading} />
            <input type="url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="Lien de l’offre (optionnel)" disabled={loading} />
          </div>
          <textarea id="tailor-jd" className="tailor-jd-input" ref={jdRef}
            placeholder={needsJobText
              ? 'Collez ici la description du poste visé (LinkedIn, Indeed…) — indispensable ici, aucune offre de page n’est en contexte.'
              : 'Collez ici la description du poste (LinkedIn, Indeed…) pour cibler la reformulation. Sinon, l’offre de cette page est utilisée.'}
            value={jobText} onChange={(e) => setJobText(e.target.value)} disabled={loading} />
          <p className="tailor-jd-hint">Aucun fait n’est inventé : seuls le vocabulaire, le phrasé et l’ordre changent.</p>
          {result && <button className="jd-toggle" onClick={() => setJdOpen(false)}>▲ Réduire</button>}
        </div>
      ) : (
        <button className="jd-toggle jd-toggle--closed" onClick={() => setJdOpen(true)}>
          🎯 Offre ciblée {jobText.trim() ? '(texte collé)' : '(offre de la page)'} ▼
        </button>
      )}

      {!result && !loading && (
        <div className="tailor-hero">
          <div className="hero-steps">
            <div className="hero-step"><span>1</span><p>{needsJobText ? 'Collez la description du poste visé' : 'Collez l’offre — ou gardez celle de la page'}</p></div>
            <div className="hero-step"><span>2</span><p>L’IA adapte votre CV, sans rien inventer</p></div>
            <div className="hero-step"><span>3</span><p>Validez chaque changement, téléchargez le PDF</p></div>
          </div>
          <button className="tailor-panel__cta tailor-panel__cta--xl" onClick={runTailor} disabled={!canGenerate}>
            ✨ Générer le CV adapté
          </button>
        </div>
      )}
      {loading && <div className="tailor-panel__loading"><span className="spinner" /> {phase}</div>}
      {error && <div className="tailor-panel__error">{error}</div>}

      {fitAnalysis && (
        <div className="copilot-fit">
          <div className="copilot-fit__score">
            <strong>{fitAnalysis.score}%</strong>
            <span className={`score-badge ${fitAnalysis.recommendation === 'apply' ? 'score-badge--ok' : fitAnalysis.recommendation === 'consider' ? 'score-badge--mid' : 'score-badge--warn'}`}>
              {fitAnalysis.recommendation === 'apply' ? 'Postuler' : fitAnalysis.recommendation === 'consider' ? 'À évaluer' : 'Faible priorité'}
            </span>
          </div>
          <div>
            <p><strong>Correspondances :</strong> {(fitAnalysis.matched_skills || []).join(', ') || 'Aucune compétence explicite détectée'}</p>
            {!!fitAnalysis.missing_skills?.length && <p><strong>Écarts :</strong> {fitAnalysis.missing_skills.join(', ')}</p>}
            {applicationId && <small>Offre enregistrée dans le suivi local · #{applicationId}</small>}
          </div>
          <div className="copilot-letter-actions">
            <select value={letterLanguage} onChange={(e) => setLetterLanguage(e.target.value)}>
              <option value="fr">Lettre FR</option>
              <option value="en">Cover letter EN</option>
            </select>
            <button type="button" onClick={runCoverLetter} disabled={loading}>Générer la lettre</button>
          </div>
        </div>
      )}

      {coverLetter && (
        <div className="copilot-letter">
          <div className="copilot-letter__head">
            <h4>Lettre de motivation</h4>
            <button type="button" onClick={copyCoverLetter}>Copier</button>
          </div>
          <textarea value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} />
        </div>
      )}

      {result && (
        <div className="tailor-review-layout">
          <div className="review-col" style={reviewH ? { height: reviewH, maxHeight: reviewH } : undefined}>
            {verified
              ? <div className="badge-verified">✅ Aucune information inventée — vérifié</div>
              : <div className="badge-review">⚠️ À vérifier : {(result?.verification?.invented_entities || []).slice(0, 5).join(', ') || 'quelques formulations'}</div>}

            {!!keywords.length && (
              <div className="score-panel">
                <div className="score-panel__top">
                  <span className="score-pct">{pct}%</span>
                  <span className={`score-badge ${scoreBadge.cls}`}>{scoreBadge.label}</span>
                </div>
                <p className="score-line">
                  <strong>{matchedKw.length} / {keywords.length}</strong> mots-clés de l’offre intégrés
                  {missingKw.length > 0 && <> · {missingKw.length} restants</>}
                </p>
                <div className="score-segs">
                  {keywords.slice(0, 16).map((k) => (
                    <span key={k} className={`seg${mergedText.includes(String(k).toLowerCase()) ? ' seg--on' : ''}`} title={k} />
                  ))}
                </div>
                {!!missingKw.length && (
                  <div className="score-missing">
                    {missingKw.slice(0, 8).map((k) => <span className="kw-chip" key={k}>{k}</span>)}
                    {missingKw.length > 8 && <span className="kw-chip kw-chip--more">+{missingKw.length - 8}</span>}
                  </div>
                )}
              </div>
            )}

            <div className="review-tabs">
              <button className={tab === 'pending' ? 'rt-on' : ''} onClick={() => setTab('pending')}>À valider <b>{counts.pending}</b></button>
              <button className={tab === 'accepted' ? 'rt-on' : ''} onClick={() => setTab('accepted')}>Acceptés <b>{counts.accepted}</b></button>
              <button className={tab === 'declined' ? 'rt-on' : ''} onClick={() => setTab('declined')}>Refusés <b>{counts.declined}</b></button>
            </div>

            {visibleChanges.length === 0 && (
              <div className="review-summary"><h4>
                {tab === 'pending' ? 'Tout est validé — rien à examiner ici.' : 'Aucun changement dans cet onglet.'}
              </h4></div>
            )}

            {visibleChanges.map((c) => {
              const state = decisions[c.id];
              const editing = editingId === c.id;
              const edited = edits[c.id];
              const shown = edited != null ? edited : c.proposed;
              return (
                <div className={`review-card${state === true ? ' review-card--accepted' : ''}${state === false ? ' review-card--declined' : ''}`} key={c.id}>
                  <div className="review-card__head">
                    <span className="review-card__label">
                      <span className="rc-dot" /> {c.label}
                      {edited != null && <span className="edited-tag"> · ✎ édité</span>}
                    </span>
                    {state === true && <span className="review-status review-status--on">Accepté ✓</span>}
                    {state === false && <span className="review-status review-status--off">Refusé</span>}
                    {state === undefined && <span className="review-status review-status--pending">À valider</span>}
                  </div>

                  {state !== true && (
                    <div className="rc-box rc-box--orig">
                      <span className="rc-box__label">Original</span>
                      <p className="review-diff">{c.original || '—'}</p>
                    </div>
                  )}

                  {editing ? (
                    <textarea className="review-edit" value={shown} autoFocus
                      onChange={(e) => setEdits((x) => ({ ...x, [c.id]: e.target.value }))} />
                  ) : state !== false && (
                    <div className="rc-box rc-box--new">
                      <span className="rc-box__label">Proposé</span>
                      {state === true
                        ? <p className="review-diff">{shown}</p>
                        : <DiffText original={c.original} proposed={shown} />}
                    </div>
                  )}

                  <div className="review-actions">
                    <button className={`ra-ghost${state === false ? ' decline-on' : ''}`}
                      onClick={() => setDecision(c.id, state === false ? undefined : false)}>Refuser</button>
                    <button className={`ra-accept${state === true ? ' accept-on' : ''}`}
                      onClick={() => setDecision(c.id, state === true ? undefined : true)}>Accepter la révision</button>
                    <button className="ra-edit" onClick={() => {
                      if (editing) { setEditingId(null); } else { commit({ ...decisions, [c.id]: true }, edits); setEditingId(c.id); }
                    }}>{editing ? '✓ Terminer' : 'Éditer'}</button>
                  </div>
                </div>
              );
            })}

            {!!(result.changes_applied || []).length && (
              <div className="review-summary">
                <h4>Résumé de l’IA</h4>
                <ul>{result.changes_applied.map((c, i) => <li key={i}>{c}</li>)}</ul>
              </div>
            )}
          </div>

          <div className="cv-preview-pane" ref={paneRef}>
            <div className="preview-mode">
              <button className={previewMode === 'cv' ? 'pm-on' : ''} onClick={() => setPreviewMode('cv')}>
                📝 Contenu du CV
              </button>
              <button className={previewMode === 'rx' ? 'pm-on' : ''} onClick={() => setPreviewMode('rx')}>
                🎨 Modèle PDF ({rxLabel})
              </button>
            </div>

            {previewMode === 'rx' && (
              <div className="rx-preview">
                <div className="rx-thumbs">
                  {RXRESUME_TEMPLATES.map((t) => (
                    <button key={t.id} type="button"
                      className={`rx-thumb${rxTemplate === t.id ? ' rx-thumb--on' : ''}`}
                      onClick={() => { setRxTemplate(t.id); setRxImgError(false); }}>
                      <img src={rxThumb(t.id)} alt={t.label} loading="lazy" />
                      <span>{t.label}</span>
                    </button>
                  ))}
                </div>
                <div className="rx-preview__stage">
                  {rxImgError ? (
                    <div className="rx-preview__fallback">
                      Aperçu indisponible — Reactive Resume ne répond pas sur {RX_URL}.
                      Le choix du modèle sera tout de même appliqué à la génération du PDF.
                    </div>
                  ) : (
                    <img key={rxTemplate} className="rx-preview__img"
                      src={rxThumb(rxTemplate)}
                      alt={`Modèle ${rxTemplate}`}
                      onError={() => setRxImgError(true)} />
                  )}
                </div>
                <p className="rx-preview__note">
                  Modèle « {rxLabel} » (exemple) — vos données y seront appliquées
                  avec « Voir le CV final » ou « Télécharger PDF ».
                </p>
              </div>
            )}

            {previewMode === 'cv' && (<>
            <div className="template-bar">
              <span className="template-bar__label">Modèle</span>
              {TEMPLATES.map((t) => (
                <button key={t.id} className={template === t.id ? 'tp-on' : ''} onClick={() => setTemplate(t.id)}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className="preview-bar">
              <div className="preview-bar__group">
                <button className="pill pill--green" onClick={() => setAll(true)}>✓ Tout accepter</button>
                <button className={`pill pill--blue${showDiff ? ' pill--pressed' : ''}`} onClick={() => setShowDiff((v) => !v)}>👁 Modifs</button>
                <button className="pill pill--red" onClick={() => setAll(false)}>✗ Tout refuser</button>
              </div>
              <div className="preview-bar__group">
                <button onClick={undo} disabled={!historyRef.current.past.length} aria-label="Annuler">↺</button>
                <button onClick={redo} disabled={!historyRef.current.future.length} aria-label="Rétablir">↻</button>
                <button onClick={() => { setZoomTouched(true); setZoom((z) => clampZoom(z - 0.1)); }} aria-label="Zoom arrière">−</button>
                <button className="pb-zoom" onClick={() => { setZoomTouched(true); setZoom(zoom === 1 ? fitZoom : 1); }}>{Math.round(zoom * 100)}%</button>
                <button onClick={() => { setZoomTouched(true); setZoom((z) => clampZoom(z + 0.1)); }} aria-label="Zoom avant">+</button>
              </div>
            </div>

            <div className="a4-viewport" style={{ width: A4_W * zoom, height: A4_H * zoom }}>
              <div className="a4-scaler" style={{ transform: `scale(${zoom})` }}>
                <div className="a4-doc" ref={docRef} style={{ transform: `translateY(${-(page - 1) * A4_H}px)` }}>
                  <CvPaper cv={result.cv_json} tailored={merged} original={result.cv_json} diff={showDiff} template={template} />
                </div>
              </div>
            </div>

            <div className="preview-pager">
              <button disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>◄</button>
              <span>Page {page} / {pageCount}</span>
              <button disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>►</button>
              <span className="preview-counter">· {counts.accepted + counts.declined}/{changes.length} validés</span>
            </div>
            </>)}
          </div>
        </div>
      )}

      {result && (
        <div className="tailor-panel__actions">
          <button className="btn-primary" onClick={viewFinal} disabled={loading}>Voir le CV final</button>

          <label className="rx-template-picker">
            <span>Modèle PDF (Reactive Resume)</span>
            <select value={rxTemplate} onChange={(e) => pickRxTemplate(e.target.value)} disabled={loading}>
              {RXRESUME_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </label>

          <button onClick={() => runExport(false)} disabled={loading}>Générer le PDF</button>
          {jobId && (
            <button onClick={() => runExport(true)} disabled={loading}>Utiliser ce CV pour ma candidature</button>
          )}
        </div>
      )}

      {pdf && (
        <div className="tailor-panel__pdf">
          {pdf.pdf_path && <a href={fileUrl(pdf.pdf_path)} target="_blank" rel="noreferrer">📄 Ouvrir le PDF</a>}
          {pdf.attached && <span> ✅ CV rattaché à votre candidature</span>}
          {pdf.attached && pdf.pdfUnavailable && <span> · PDF serveur indisponible — utilisez « ⬇ Télécharger PDF »</span>}
          {pdf.noApplication && <span>⚠️ Aucune candidature pour cette offre — postulez d’abord (Apply), puis réessayez.</span>}
        </div>
      )}

      {finalPdf && (
        <ResumeViewerModal url={finalPdf.url} title={finalPdf.title} onClose={() => setFinalPdf(null)} />
      )}

      {showDoc && result && (
        <CvDocument cv={result.cv_json} tailored={merged} template={template} onClose={() => setShowDoc(false)} />
      )}

      {result && (
        <div className="offscreen" aria-hidden="true" ref={printRef}>
          <CvPaper cv={result.cv_json} tailored={merged} template={template} />
        </div>
      )}
    </div>
  );
}

TailorCvPanel.propTypes = {
  jobId: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
  onClose: PropTypes.func,
  embedded: PropTypes.bool,
};
