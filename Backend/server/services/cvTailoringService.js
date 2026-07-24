const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const TAILORING_URL = process.env.CV_TAILORING_SERVICE_URL || 'http://localhost:8014';
const PARSER_URL = process.env.CV_PARSER_URL || 'http://127.0.0.1:5002';

// Map a stored resume path ("/uploads/cvs/x.pdf") to an absolute disk path
// under the server's uploadDir. Returns null if no resume path is stored.
function resolveCvFilePath(user, uploadDir) {
  const stored = user?.profile?.resume;
  if (!stored || typeof stored !== 'string') return null;
  const rel = stored.replace(/^\/uploads\//, '');
  return path.join(uploadDir, rel);
}

function buildApplicationUpdate({ pdf_path, tailored_cv_json, changes_applied }) {
  return {
    tailoredCvPath: pdf_path || null,
    tailoredCvJson: tailored_cv_json || null,
    tailoredCvChanges: Array.isArray(changes_applied) ? changes_applied : [],
    tailoredCvGeneratedAt: new Date(),
  };
}

async function parseCv(absPath) {
  if (!fs.existsSync(absPath)) {
    const err = new Error('Original CV file not found on disk');
    err.statusCode = 502;
    throw err;
  }
  const form = new FormData();
  form.append('resume', fs.createReadStream(absPath));
  const { data } = await axios.post(`${PARSER_URL}/upload`, form, { headers: form.getHeaders() });
  return data;
}

// Fallback CV source when the parser (5002) is unavailable or there is no CV
// file on disk: build the internal cv_json from the candidate's stored
// structured profile. Note: education is not stored on the profile, so it is
// left empty here (same limitation the parser fallback documents).
function buildCvJsonFromProfile(user) {
  const p = user?.profile || {};
  return {
    name: user?.name || '',
    email: user?.email || '',
    phone: p.phone || '',
    role: 'CANDIDATE',
    domain: p.domain || '',
    profile: {
      resume: p.shortDescription || '',
      shortDescription: p.shortDescription || '',
      skills: Array.isArray(p.skills) ? p.skills : [],
      phone: p.phone || '',
      languages: Array.isArray(p.languages) ? p.languages : [],
      availability: p.availability || 'Full-time',
      domain: p.domain || '',
      experience: Array.isArray(p.experience)
        ? p.experience.map((e) => ({
            title: e.title || '',
            company: e.company || '',
            duration: e.duration || '',
            description: e.description || '',
          }))
        : [],
      // Factual pass-through sections (never sent to the LLM for rewriting;
      // rendered as-is on the final CV).
      certifications: Array.isArray(p.certifications) ? p.certifications : [],
      projects: Array.isArray(p.projects) ? p.projects : [],
    },
    education: Array.isArray(p.education) ? p.education : [],
  };
}

async function callTailor({ candidateId, jobId, cvJson, jobText }) {
  const { data } = await axios.post(`${TAILORING_URL}/tailor`, {
    candidate_id: candidateId, job_id: jobId, cv_json: cvJson,
    job_text: jobText || null,
  });
  return data;
}

async function analyzeJob({ candidateId, cvJson, jobText, jobTitle, company, sourceUrl }) {
  const { data } = await axios.post(`${TAILORING_URL}/analyze`, {
    candidate_id: candidateId,
    cv_json: cvJson,
    job_text: jobText,
    job_title: jobTitle || '',
    company: company || '',
    source_url: sourceUrl || '',
  });
  return data;
}

async function generateCoverLetter({ cvJson, jobText, jobTitle, company, language }) {
  const { data } = await axios.post(`${TAILORING_URL}/cover-letter`, {
    cv_json: cvJson,
    job_text: jobText,
    job_title: jobTitle || '',
    company: company || '',
    language: language || 'fr',
  });
  return data;
}

async function listCopilotApplications(candidateId) {
  const { data } = await axios.get(`${TAILORING_URL}/applications/${candidateId}`);
  return data;
}

async function updateCopilotApplication({ candidateId, applicationId, status, notes }) {
  const { data } = await axios.patch(
    `${TAILORING_URL}/applications/${candidateId}/${applicationId}`,
    { status, notes }
  );
  return data;
}

async function callExport({ candidateId, jobId, cvJson, tailored, template }) {
  const { data } = await axios.post(`${TAILORING_URL}/export-pdf`, {
    candidate_id: candidateId, job_id: jobId, cv_json: cvJson, tailored_cv_json: tailored,
    template: template || null,
  });
  return data;
}

module.exports = {
  resolveCvFilePath,
  buildApplicationUpdate,
  parseCv,
  buildCvJsonFromProfile,
  callTailor,
  analyzeJob,
  generateCoverLetter,
  listCopilotApplications,
  updateCopilotApplication,
  callExport,
};
