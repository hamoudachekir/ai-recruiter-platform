const fetch = require('node-fetch');
const { synthesizeEdgeTts } = require('./edgeTtsService');

const SPEECH_STACK_TIMEOUT_MS = Number(process.env.SPEECH_STACK_TIMEOUT_MS || 8000);

const getSpeechStackBaseUrl = () => (
  process.env.SPEECH_STACK_URL
  || process.env.SPEECH_STACK_API
  || process.env.VITE_SPEECH_STACK_URL
  || 'http://127.0.0.1:8012'
).trim().replace(/\/+$/, '');

const buildSpeechStackUrl = (pathname = '') => {
  const suffix = String(pathname || '').trim();
  const baseUrl = getSpeechStackBaseUrl();
  if (!suffix) return baseUrl;
  return `${baseUrl}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
};

const readErrorText = async (response) => {
  try {
    const text = await response.text();
    if (!text) return response.statusText;

    try {
      const parsed = JSON.parse(text);
      const detail = parsed?.detail || parsed?.message || parsed?.raw;
      if (detail) {
        return typeof detail === 'string' ? detail : JSON.stringify(detail);
      }
    } catch (_) {
      // Response was plain text; fall through.
    }

    return text;
  } catch (_) {
    return response.statusText;
  }
};

async function requestSpeechStackTts({
  text,
  rate = 175,
  volume = 1.0,
  voiceId = null,
  language = null,
  provider = null,
}) {
  const normalizedText = String(text || '').trim();
  if (!normalizedText) {
    throw new Error('TTS text is required');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPEECH_STACK_TIMEOUT_MS);

  try {
    const response = await fetch(buildSpeechStackUrl('/api/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: normalizedText,
        rate: Number.isFinite(Number(rate)) ? Number(rate) : 175,
        volume: Number.isFinite(Number(volume)) ? Number(volume) : 1.0,
        voice_id: voiceId || undefined,
        language: language || undefined,
        provider: provider || undefined,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = await readErrorText(response);
      throw new Error(`Speech Stack TTS ${response.status}: ${detail}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    return {
      buffer,
      bytes: buffer.length,
      contentType: response.headers.get('content-type') || 'audio/wav',
      contentDisposition: response.headers.get('content-disposition') || 'inline; filename=tts.wav',
      speechStackUrl: buildSpeechStackUrl('/api/tts'),
    };
  } catch (error) {
    clearTimeout(timer);
    /* Python speech stack unreachable — fall back to Edge TTS directly */
    const isUnreachable = error?.code === 'ECONNREFUSED'
      || error?.code === 'ENOTFOUND'
      || error?.name === 'AbortError'
      || (error?.message || '').includes('ECONNREFUSED');

    if (isUnreachable) {
      console.warn('[speechStack] fallback → Edge TTS (python stack unreachable)');
      const buffer = await synthesizeEdgeTts(normalizedText, voiceId, undefined, language);
      return {
        buffer,
        bytes: buffer.length,
        contentType: 'audio/mpeg',
        contentDisposition: 'inline; filename=tts.mp3',
        speechStackUrl: 'edge-tts-direct',
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  getSpeechStackBaseUrl,
  buildSpeechStackUrl,
  requestSpeechStackTts,
};
