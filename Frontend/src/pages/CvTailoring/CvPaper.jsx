import PropTypes from 'prop-types';
import { wordDiff } from './cvDiff';

// Pure "paper" resume — editorial single-column layout. Rendered inline (panel
// preview) or inside the CvDocument overlay (which adds print support).
// When `diff` is set, changed prose (summary + experience descriptions) is
// highlighted in green — used only for the on-screen preview, never for print.

function stripHtml(s) {
  return (s || '').replace(/<[^>]*>/g, '').trim();
}

function DiffInline({ before, after }) {
  const nodes = wordDiff(before, after)
    .filter((p) => p.type !== 'del')
    .map((p, i) => (p.type === 'add'
      ? <mark key={i} className="cv-hl">{p.text}</mark>
      : <span key={i}>{p.text}</span>));
  return nodes.reduce((acc, el, i) => (i ? [...acc, ' ', el] : [el]), []);
}
DiffInline.propTypes = { before: PropTypes.string, after: PropTypes.string };

export default function CvPaper({ cv, tailored, printRoot, diff, original, template = 'editorial' }) {
  const basics = cv || {};
  const profile = basics.profile || {};
  const origProfile = (original || {}).profile || {};
  const t = tailored || {};

  const name = basics.name || 'Candidat';
  const headline = profile.domain || t.experiences?.[0]?.title || '';
  const email = basics.email || profile.email || '';
  const phone = basics.phone || profile.phone || '';
  const location = basics.location || '';
  const languages = profile.languages || [];
  const skills = (t.skills || []).slice(0, 32);
  const experiences = (t.experiences || []).filter((e) => e.title || e.company || e.description);
  const education = (t.education?.length ? t.education : basics.education || [])
    .map(stripHtml).filter(Boolean);
  const certifications = (profile.certifications || []).map(stripHtml).filter(Boolean);
  const projects = (profile.projects || []).map(stripHtml).filter(Boolean);
  const summary = stripHtml(t.summary);
  const origSummary = stripHtml(origProfile.shortDescription || origProfile.resume || '');
  const contact = [email, phone, location].filter(Boolean);

  return (
    <article className={`cv-doc cv-t-${template}${printRoot ? ' cv-print-root' : ''}`}>
      <header className="cv-head">
        <h1 className="cv-name">{name}</h1>
        {headline && <p className="cv-role">{headline}</p>}
        {!!contact.length && (
          <p className="cv-contact-row">
            {contact.map((c, i) => <span key={i}>{c}</span>)}
          </p>
        )}
      </header>

      {summary && (
        <section className="cv-row">
          <div className="cv-label">Profil</div>
          <div className="cv-body">
            <p className="cv-p">{diff ? <DiffInline before={origSummary} after={summary} /> : summary}</p>
          </div>
        </section>
      )}

      {!!experiences.length && (
        <section className="cv-row">
          <div className="cv-label">Expérience</div>
          <div className="cv-body">
            {experiences.map((e, i) => {
              const desc = stripHtml(e.description);
              const od = stripHtml((origProfile.experience?.[i] || {}).description);
              return (
                <div className="cv-xp" key={i}>
                  <div className="cv-xp-top">
                    <span className="cv-xp-role">{e.title || 'Poste'}</span>
                    {e.duration && <span className="cv-xp-date">{e.duration}</span>}
                  </div>
                  {e.company && <div className="cv-xp-org">{e.company}</div>}
                  {desc && <p className="cv-p">{diff ? <DiffInline before={od} after={desc} /> : desc}</p>}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {!!projects.length && (
        <section className="cv-row">
          <div className="cv-label">Projets</div>
          <div className="cv-body">
            {projects.map((p, i) => <p className="cv-p cv-edu" key={i}>{p}</p>)}
          </div>
        </section>
      )}

      {!!skills.length && (
        <section className="cv-row">
          <div className="cv-label">Compétences</div>
          <div className="cv-body"><p className="cv-inline">{skills.join('  ·  ')}</p></div>
        </section>
      )}

      {!!education.length && (
        <section className="cv-row">
          <div className="cv-label">Formation</div>
          <div className="cv-body">
            {education.map((ed, i) => <p className="cv-p cv-edu" key={i}>{ed}</p>)}
          </div>
        </section>
      )}

      {!!certifications.length && (
        <section className="cv-row">
          <div className="cv-label">Certifications</div>
          <div className="cv-body">
            {certifications.map((c, i) => <p className="cv-p cv-edu" key={i}>{c}</p>)}
          </div>
        </section>
      )}

      {!!languages.length && (
        <section className="cv-row">
          <div className="cv-label">Langues</div>
          <div className="cv-body"><p className="cv-inline">{languages.join('  ·  ')}</p></div>
        </section>
      )}
    </article>
  );
}

CvPaper.propTypes = {
  cv: PropTypes.object,
  tailored: PropTypes.object,
  original: PropTypes.object,
  printRoot: PropTypes.bool,
  diff: PropTypes.bool,
  template: PropTypes.string,
};
