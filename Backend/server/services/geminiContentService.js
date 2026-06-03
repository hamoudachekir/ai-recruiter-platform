// Thin Gemini wrapper for wizard content generation.
//
// Match the existing pattern in services/integrityReportService.js (REST fetch,
// responseMimeType: 'application/json'), but add: AbortController timeout,
// markdown-fence stripping, and structured error codes so the caller can map
// to a clean 502 instead of a 500/stack trace.

const GEMINI_DEFAULT_MODEL = process.env.GEMINI_WIZARD_MODEL || 'gemini-1.5-flash';
const GEMINI_TIMEOUT_MS = Number.parseInt(process.env.GEMINI_TIMEOUT_MS || '25000', 10);

function stripMarkdownFences(text) {
  if (typeof text !== 'string') return text;
  let s = text.trim();
  // Leading ```json or ``` on its own line
  if (s.startsWith('```')) {
    const firstNewline = s.indexOf('\n');
    s = firstNewline === -1 ? s.slice(3) : s.slice(firstNewline + 1);
  }
  // Trailing ```
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}

function safeJsonParse(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(stripMarkdownFences(text));
  } catch {
    return null;
  }
}

/**
 * Call Gemini and return the parsed JSON object.
 *
 * Throws errors tagged with `.code`:
 *   GEMINI_NOT_CONFIGURED  — missing GEMINI_API_KEY env
 *   GEMINI_TIMEOUT         — exceeded GEMINI_TIMEOUT_MS
 *   GEMINI_FETCH_FAILED    — network / DNS / connection failure
 *   GEMINI_HTTP_ERROR      — non-2xx response (also exposes .status)
 *   GEMINI_PARSE_ERROR     — response wasn't valid JSON (exposes .rawText preview)
 *
 * Callers should map all of these to a clean 502 to the wizard frontend.
 */
async function generateJson({ prompt, model = GEMINI_DEFAULT_MODEL, temperature = 0.4 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured');
    err.code = 'GEMINI_NOT_CONFIGURED';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          generationConfig: { temperature, responseMimeType: 'application/json' },
          contents: [{ parts: [{ text: prompt }] }],
        }),
        signal: controller.signal,
      }
    );
  } catch (error) {
    clearTimeout(timer);
    if (error.name === 'AbortError') {
      const err = new Error(`Gemini request timed out after ${GEMINI_TIMEOUT_MS}ms`);
      err.code = 'GEMINI_TIMEOUT';
      throw err;
    }
    error.code = error.code || 'GEMINI_FETCH_FAILED';
    throw error;
  }
  clearTimeout(timer);

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data?.error?.message || `Gemini request failed (${response.status})`);
    err.code = 'GEMINI_HTTP_ERROR';
    err.status = response.status;
    throw err;
  }

  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  const parsed = safeJsonParse(rawText);
  if (parsed === null) {
    const err = new Error('Gemini returned malformed JSON');
    err.code = 'GEMINI_PARSE_ERROR';
    err.rawText = typeof rawText === 'string' ? rawText.slice(0, 500) : String(rawText);
    throw err;
  }
  return parsed;
}

module.exports = { generateJson, stripMarkdownFences, safeJsonParse };
