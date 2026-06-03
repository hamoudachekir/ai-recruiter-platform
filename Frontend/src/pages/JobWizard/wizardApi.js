import axios from 'axios';

const API_BASE = 'http://localhost:3001';
const WIZARD_BASE = `${API_BASE}/api/wizard/jobs`;
const DEPT_BASE   = `${API_BASE}/api/departments`;
const CTX_BASE    = `${API_BASE}/api/company-contexts`;

function authHeaders() {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
  return token
    ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

// ── Wizard jobs ───────────────────────────────────────────────────────────────

export async function createDraft(payload = {}) {
  const { data } = await axios.post(WIZARD_BASE, payload, { headers: authHeaders() });
  return data.job;
}

export async function updateJob(id, payload) {
  const { data } = await axios.put(`${WIZARD_BASE}/${id}`, payload, { headers: authHeaders() });
  return data.job;
}

export async function loadJob(id) {
  const { data } = await axios.get(`${WIZARD_BASE}/${id}`, { headers: authHeaders() });
  return data.job;
}

export async function publishJob(id) {
  const { data } = await axios.post(`${WIZARD_BASE}/${id}/publish`, {}, { headers: authHeaders() });
  return data.job;
}

export async function deleteJob(id) {
  await axios.delete(`${WIZARD_BASE}/${id}`, { headers: authHeaders() });
}

export async function listDrafts() {
  const { data } = await axios.get(`${WIZARD_BASE}/drafts`, { headers: authHeaders() });
  return data.drafts;
}

// ── AI endpoints ──────────────────────────────────────────────────────────────

export async function generateDescription(payload) {
  const { data } = await axios.post(`${WIZARD_BASE}/generate-description`, payload, { headers: authHeaders() });
  return data.candidates;
}

export async function suggestQuestions(payload) {
  const { data } = await axios.post(`${WIZARD_BASE}/suggest-questions`, payload, { headers: authHeaders() });
  return data.suggestions;
}

// ── Departments ───────────────────────────────────────────────────────────────

export async function listDepartments() {
  const { data } = await axios.get(DEPT_BASE, { headers: authHeaders() });
  return data.departments;
}

export async function createDepartment(payload) {
  const { data } = await axios.post(DEPT_BASE, payload, { headers: authHeaders() });
  return data.department;
}

export async function updateDepartment(id, payload) {
  const { data } = await axios.put(`${DEPT_BASE}/${id}`, payload, { headers: authHeaders() });
  return data.department;
}

export async function deleteDepartment(id) {
  await axios.delete(`${DEPT_BASE}/${id}`, { headers: authHeaders() });
}

// ── Company contexts ──────────────────────────────────────────────────────────

export async function listCompanyContexts() {
  const { data } = await axios.get(CTX_BASE, { headers: authHeaders() });
  return data.contexts;
}

export async function loadCompanyContext(id) {
  const { data } = await axios.get(`${CTX_BASE}/${id}`, { headers: authHeaders() });
  return data.context;
}

export async function createCompanyContext(payload) {
  const { data } = await axios.post(CTX_BASE, payload, { headers: authHeaders() });
  return data.context;
}

export async function updateCompanyContext(id, payload) {
  const { data } = await axios.put(`${CTX_BASE}/${id}`, payload, { headers: authHeaders() });
  return data.context;
}

export async function deleteCompanyContext(id) {
  await axios.delete(`${CTX_BASE}/${id}`, { headers: authHeaders() });
}
