import axios from 'axios';

const authHeaders = () => ({
  headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
});

export async function tailorCv(jobId, jobText) {
  const { data } = await axios.post('/api/cv/tailor', { jobId, jobText: jobText || undefined }, authHeaders());
  return data; // { tailored_cv_json, changes_applied, verification, cv_json }
}

export async function analyzeJob({ jobText, jobTitle, company, sourceUrl }) {
  const { data } = await axios.post(
    '/api/cv/copilot/analyze',
    { jobText, jobTitle, company, sourceUrl },
    authHeaders()
  );
  return data;
}

export async function generateCoverLetter({ jobText, jobTitle, company, language }) {
  const { data } = await axios.post(
    '/api/cv/copilot/cover-letter',
    { jobText, jobTitle, company, language },
    authHeaders()
  );
  return data;
}

export async function getCopilotApplications() {
  const { data } = await axios.get('/api/cv/copilot/applications', authHeaders());
  return data;
}

export async function updateCopilotApplication(applicationId, update) {
  const { data } = await axios.patch(
    `/api/cv/copilot/applications/${applicationId}`,
    update,
    authHeaders()
  );
  return data;
}

export async function exportTailoredPdf({ jobId, cvJson, tailored, attach, template }) {
  const { data } = await axios.post(
    '/api/cv/tailor/export',
    { jobId, cv_json: cvJson, tailored_cv_json: tailored, attach: Boolean(attach), template: template || undefined },
    authHeaders()
  );
  return data; // { pdf_path, resume_id, attached, applicationId }
}

export async function getTailored(applicationId) {
  const { data } = await axios.get(`/api/cv/tailored/${applicationId}`, authHeaders());
  return data;
}
