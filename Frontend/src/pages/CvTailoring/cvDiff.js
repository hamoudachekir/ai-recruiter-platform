// Client-side diff/merge utilities for the tailoring review flow.
// The panel holds both the original cv_json and the proposed tailored_cv_json,
// so per-section changes, word-level highlights, edits, and accept/decline
// merging all happen here without another API round-trip.

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const splitList = (s) => (s || '').split(/[,·]/).map((x) => x.trim()).filter(Boolean);
const splitPipes = (s) => (s || '').split('|').map((x) => x.trim()).filter(Boolean);

// Word-level diff (LCS). Returns [{ type: 'same'|'add'|'del', text }].
export function wordDiff(oldText, newText) {
  const a = norm(oldText).split(' ').filter(Boolean);
  const b = norm(newText).split(' ').filter(Boolean);
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  const push = (type, word) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += ` ${word}`;
    else out.push({ type, text: word });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; }
    else { push('add', b[j]); j++; }
  }
  while (i < n) { push('del', a[i]); i++; }
  while (j < m) { push('add', b[j]); j++; }
  return out;
}

// List the reviewable changes between the original CV and the AI proposal.
// Experience changes are description-level (titles/companies/dates are facts).
export function buildChanges(cvJson, tailored) {
  const p = cvJson?.profile || {};
  const t = tailored || {};
  const changes = [];

  const origSummary = p.shortDescription || p.resume || '';
  if (norm(origSummary) !== norm(t.summary)) {
    changes.push({ id: 'summary', kind: 'summary', label: 'Profil', original: origSummary, proposed: t.summary || '' });
  }

  const origExp = p.experience || [];
  (t.experiences || []).forEach((e, i) => {
    const o = origExp[i] || {};
    if (norm(o.description) !== norm(e.description)) {
      changes.push({
        id: `exp-${i}`,
        kind: 'experience',
        index: i,
        label: `Expérience — ${e.title || o.title || `#${i + 1}`}`,
        original: o.description || '',
        proposed: e.description || '',
      });
    }
  });

  const oSkills = (p.skills || []).join(', ');
  const nSkills = (t.skills || []).join(', ');
  if (norm(oSkills) !== norm(nSkills)) {
    changes.push({ id: 'skills', kind: 'skills', label: 'Compétences (ordre & sélection)', original: oSkills, proposed: nSkills });
  }

  const oEdu = (cvJson?.education || []).join(' | ');
  const nEdu = (t.education || []).join(' | ');
  if (norm(oEdu) !== norm(nEdu)) {
    changes.push({ id: 'education', kind: 'education', label: 'Formation', original: oEdu, proposed: nEdu });
  }

  return changes;
}

// Build the final CV. For each section: declined -> original value; accepted or
// pending -> the user's edit if any, else the AI proposal. `decisions[id]`:
// false = declined, anything else = kept. `edits[id]` = user-overridden text.
export function mergeCv(cvJson, tailored, decisions = {}, edits = {}) {
  const p = cvJson?.profile || {};
  const t = JSON.parse(JSON.stringify(tailored || {}));
  const kept = (id) => decisions[id] !== false;
  const edit = (id) => edits[id];

  if (!kept('summary')) t.summary = p.shortDescription || p.resume || '';
  else if (edit('summary') != null) t.summary = edit('summary');

  t.experiences = (t.experiences || []).map((e, i) => {
    const id = `exp-${i}`;
    const o = (p.experience || [])[i] || {};
    let description = e.description;
    if (!kept(id)) description = o.description ?? e.description;
    else if (edit(id) != null) description = edit(id);
    return { ...e, description };
  });

  if (!kept('skills')) t.skills = p.skills || [];
  else if (edit('skills') != null) t.skills = splitList(edit('skills'));

  if (!kept('education')) t.education = cvJson?.education || [];
  else if (edit('education') != null) t.education = splitPipes(edit('education'));

  return t;
}
