// Thin HTTP client for the Python interview_agent FastAPI service.
// The agent service lives at http://localhost:8013 (override via INTERVIEW_AGENT_URL).

const DEFAULT_URL = process.env.INTERVIEW_AGENT_URL || 'http://localhost:8013';
// Keep this longer than a single slow LLM turn. The Python interviewer can do
// provider retries/backoff; aborting at 30s cuts off valid responses and leaves
// the room stuck on "AI is thinking".
const AGENT_TIMEOUT_MS = Number(process.env.INTERVIEW_AGENT_TIMEOUT_MS || 150000);

async function agentRequest(path, body) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, AGENT_TIMEOUT_MS);

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
  } catch (error) {
    if (error?.name === 'AbortError' || /abort/i.test(String(error?.message || ''))) {
      const wrapped = new Error(timedOut
        ? 'Agent request timed out before the interviewer responded.'
        : 'Agent request was interrupted before the interviewer responded.');
      wrapped.code = timedOut ? 'AGENT_TIMEOUT' : 'AGENT_ABORTED';
      wrapped.retryable = true;
      wrapped.cause = error;
      throw wrapped;
    }
    throw error;
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
