// Thin HTTP client for the Python interview_agent FastAPI service.
// The agent service lives at http://localhost:8013 (override via INTERVIEW_AGENT_URL).

const DEFAULT_URL = process.env.INTERVIEW_AGENT_URL || 'http://localhost:8013';
// 150s gives the Python agent room to do 2 NIM attempts at 60s each + backoff
// without the Node fetch aborting first. Override via INTERVIEW_AGENT_TIMEOUT_MS.
const AGENT_TIMEOUT_MS = Number(process.env.INTERVIEW_AGENT_TIMEOUT_MS || 150000);

async function agentRequest(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  try {
    const res = await fetch(`${DEFAULT_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!res.ok) {
      const detailValue = data?.detail || data?.raw || res.statusText;
      const detail = typeof detailValue === 'string'
        ? detailValue
        : JSON.stringify(detailValue);
      throw new Error(`Agent ${path} ${res.status}: ${detail}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function startSession({
  interviewId,
  jobTitle,
  jobSkills,
  jobDescription,
  candidateName,
  candidateProfile,
  interviewStyle = 'friendly',
  phase = 'intro',
  preferredLanguage = 'en',
}) {
  return agentRequest('/session/start', {
    interview_id: interviewId,
    job_title: jobTitle || '',
    job_skills: Array.isArray(jobSkills) ? jobSkills : [],
    job_description: jobDescription || '',
    candidate_name: candidateName || '',
    candidate_profile: candidateProfile || {},
    interview_style: interviewStyle || 'friendly',
    phase,
    preferred_language: preferredLanguage || 'en',
  });
}

async function candidateTurn({ interviewId, text, sentiment, preferredLanguage }) {
  return agentRequest('/session/turn', {
    interview_id: interviewId,
    text,
    sentiment: sentiment || null,
    preferred_language: preferredLanguage || null,
  });
}

async function switchPhase({ interviewId, phase }) {
  return agentRequest('/session/switch', { interview_id: interviewId, phase });
}

async function endSession({ interviewId }) {
  return agentRequest('/session/end', { interview_id: interviewId });
}

async function health() {
  return agentRequest('/health');
}

module.exports = {
  startSession,
  candidateTurn,
  switchPhase,
  endSession,
  health,
};
