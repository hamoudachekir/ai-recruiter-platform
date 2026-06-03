/**
 * Maps an axios error from the AI endpoints (generate-description /
 * suggest-questions) into a structured { kind, message, retryAfter? }
 * the UI can render in a banner.
 *
 * Returns `kind` in:
 *   'rate-limit'  — 429
 *   'ai-failure'  — 502 (model returned malformed/empty)
 *   'config'      — 503 (server-side misconfiguration)
 *   'bad-request' — 400 (validation rejected the payload)
 *   'network'     — no err.response (DNS, CORS, offline)
 *   'unknown'     — everything else
 */
export function mapAiError(err) {
  const status = err?.response?.status;
  const data   = err?.response?.data;

  if (status === 429) {
    return {
      kind: 'rate-limit',
      message: `Too many AI requests. ${data?.retryAfter ? `Try again in ${data.retryAfter}.` : 'Wait a moment and try again.'}`,
      retryAfter: data?.retryAfter,
    };
  }
  if (status === 502) {
    return {
      kind: 'ai-failure',
      message: 'AI generation failed — the model returned an invalid or empty response. Try again.',
    };
  }
  if (status === 503) {
    return {
      kind: 'config',
      message: 'AI service is not configured. Contact your administrator.',
    };
  }
  if (status === 400) {
    return {
      kind: 'bad-request',
      message: data?.message || 'The request was rejected. Check your inputs and try again.',
    };
  }
  if (!err?.response) {
    return {
      kind: 'network',
      message: 'Network error — check your connection and try again.',
    };
  }
  return {
    kind: 'unknown',
    message: data?.message || err?.message || 'Something went wrong. Try again.',
  };
}

// Tone hint for banner styling — rate-limit is recoverable (amber), everything
// else is an error (rose). Centralized so both Step 4 and Step 6 stay consistent.
export function aiErrorTone(error) {
  return error?.kind === 'rate-limit' ? 'warning' : 'error';
}
