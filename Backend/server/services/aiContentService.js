// Provider-agnostic LLM wrapper for wizard content generation.
//
// Replaces the older Gemini-only service. Defaults to Groq (OpenAI-compatible)
// since the rest of the platform — interview agent, messaging bot — already
// runs on it. The only env that needs to be set is GROQ_API_KEY; GROQ_MODEL
// defaults to the same gpt-oss-120b the agent uses.
//
// Public surface matches the old geminiContentService so the wizard routes
// don't need a rewrite — just a require() swap and a code-prefix update.

const OpenAI = require('openai').default || require('openai');

const PROVIDER = (process.env.LLM_PROVIDER || 'groq').toLowerCase();
const TIMEOUT_MS = Number.parseInt(
  process.env.AI_CONTENT_TIMEOUT_MS || process.env.GEMINI_TIMEOUT_MS || '25000',
  10
);

// Groq config — OpenAI-compatible endpoint, JSON-mode supported.
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL   = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

const groqClient = GROQ_API_KEY
  ? new OpenAI({ apiKey: GROQ_API_KEY, baseURL: GROQ_BASE_URL })
  : null;

function stripMarkdownFences(text) {
  if (typeof text !== 'string') return text;
  let s = text.trim();
  if (s.startsWith('```')) {
    const firstNewline = s.indexOf('\n');
    s = firstNewline === -1 ? s.slice(3) : s.slice(firstNewline + 1);
  }
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

function makeError(message, code, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

/**
 * Call the configured LLM and return the parsed JSON object.
 *
 * Throws errors tagged with `.code`:
 *   AI_NOT_CONFIGURED  — missing API key for the active provider
 *   AI_TIMEOUT         — exceeded TIMEOUT_MS
 *   AI_FETCH_FAILED    — network / DNS / connection failure
 *   AI_HTTP_ERROR      — non-2xx response (also exposes .status)
 *   AI_PARSE_ERROR     — response wasn't valid JSON (exposes .rawText preview)
 *
 * Callers should map all of these to a clean 502 to the wizard frontend.
 */
async function generateJson({ prompt, temperature = 0.4, maxTokens = 2048 }) {
  if (PROVIDER !== 'groq') {
    throw makeError(
      `LLM_PROVIDER=${PROVIDER} is not supported by aiContentService (only 'groq')`,
      'AI_NOT_CONFIGURED'
    );
  }
  if (!groqClient) {
    throw makeError('GROQ_API_KEY is not configured', 'AI_NOT_CONFIGURED');
  }

  // AbortController + setTimeout — Groq SDK forwards the signal to the fetch
  // call so cancellation works the same way it did with the Gemini wrapper.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let completion;
  try {
    completion = await groqClient.chat.completions.create(
      {
        model: GROQ_MODEL,
        temperature,
        max_tokens: maxTokens,
        // JSON-mode — guarantees the assistant emits a single valid JSON
        // object so we never have to parse around prose.
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a helpful assistant. Always respond with a single valid JSON object that matches the schema described in the user prompt. Do not include any explanatory text outside the JSON.',
          },
          { role: 'user', content: prompt },
        ],
      },
      { signal: controller.signal }
    );
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
      throw makeError(`AI request timed out after ${TIMEOUT_MS}ms`, 'AI_TIMEOUT');
    }
    if (error?.status) {
      throw makeError(
        error.message || `AI request failed (${error.status})`,
        'AI_HTTP_ERROR',
        { status: error.status }
      );
    }
    error.code = error.code || 'AI_FETCH_FAILED';
    throw error;
  }
  clearTimeout(timer);

  const rawText = completion?.choices?.[0]?.message?.content;
  const parsed = safeJsonParse(rawText);
  if (parsed === null) {
    throw makeError('AI returned malformed JSON', 'AI_PARSE_ERROR', {
      rawText: typeof rawText === 'string' ? rawText.slice(0, 500) : String(rawText),
    });
  }
  return parsed;
}

module.exports = {
  generateJson,
  stripMarkdownFences,
  safeJsonParse,
  // Useful for diagnostics / logs.
  PROVIDER,
  MODEL: GROQ_MODEL,
};
