/**
 * Edge TTS — direct WebSocket client for Node.js.
 *
 * Uses the same endpoint as the Python edge-tts library.
 * No extra npm packages needed — depends only on `ws` (already installed via socket.io).
 *
 * Voice: controlled by EDGE_TTS_VOICE env var (default en-US-EmmaNeural)
 * Rate:  controlled by EDGE_TTS_RATE  env var (default +5%)
 *
 * MULTILINGUAL SUPPORT:
 * - Automatic voice selection based on language code
 * - Language-specific speaking rates
 * - Multilingual neural voices where available
 * - Comprehensive logging for voice selection
 */

'use strict';

const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const TIMEOUT_MS = 20_000;

/* XML-safe escape for SSML text */
const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

/**
 * Voice mapping for multilingual TTS support.
 * Maps language codes to Edge TTS neural voices.
 */
const VOICE_MAPPING = {
  // English variants
  'en': 'en-US-EmmaNeural',
  'en-us': 'en-US-EmmaNeural',
  'en-gb': 'en-GB-SoniaNeural',
  'en-au': 'en-AU-NatashaNeural',
  'en-ca': 'en-CA-ClaraNeural',

  // French variants
  'fr': 'fr-FR-DeniseNeural',
  'fr-fr': 'fr-FR-DeniseNeural',
  'fr-ca': 'fr-CA-SylvieNeural',
  'fr-be': 'fr-BE-CharlineNeural',
  'fr-ch': 'fr-CH-ArianeNeural',

  // Arabic variants
  'ar': 'ar-SA-ZariyahNeural',
  'ar-sa': 'ar-SA-ZariyahNeural',
  'ar-eg': 'ar-EG-SalmaNeural',
  'ar-ae': 'ar-AE-FatimaNeural',

  // Spanish
  'es': 'es-ES-ElviraNeural',
  'es-es': 'es-ES-ElviraNeural',
  'es-mx': 'es-MX-DaliaNeural',

  // German
  'de': 'de-DE-KatjaNeural',
  'de-de': 'de-DE-KatjaNeural',

  // Italian
  'it': 'it-IT-ElsaNeural',
  'it-it': 'it-IT-ElsaNeural',

  // Portuguese
  'pt': 'pt-BR-FranciscaNeural',
  'pt-br': 'pt-BR-FranciscaNeural',
  'pt-pt': 'pt-PT-RaquelNeural',

  // Dutch
  'nl': 'nl-NL-ColetteNeural',
  'nl-nl': 'nl-NL-ColetteNeural',

  // Multilingual voices (premium natural sound)
  'multilingual': 'fr-FR-RemyMultilingualNeural',
};

/**
 * Language-specific speaking rates.
 * Some languages sound better at different speeds.
 */
const LANGUAGE_RATES = {
  'en': '+5%',      // English - slightly faster (default)
  'en-us': '+5%',
  'en-gb': '+5%',
  'fr': '+0%',      // French - natural pace
  'fr-fr': '+0%',
  'fr-ca': '+0%',
  'ar': '-5%',      // Arabic - slightly slower for clarity
  'ar-sa': '-5%',
  'es': '+0%',      // Spanish - natural pace
  'de': '+0%',      // German - natural pace
  'it': '+0%',      // Italian - natural pace
  'pt': '+0%',      // Portuguese - natural pace
  'nl': '+0%',      // Dutch - natural pace
  'default': '+5%', // Default fallback
};

/**
 * Select the appropriate voice for a given language code.
 * Logs the selection for debugging.
 *
 * @param {string} languageCode - ISO language code (e.g., 'en', 'fr', 'ar')
 * @returns {string} Edge TTS voice name
 */
function selectVoiceForLanguage(languageCode) {
  const normalized = String(languageCode || '').trim().toLowerCase();

  // Check for exact match first
  if (VOICE_MAPPING[normalized]) {
    const voice = VOICE_MAPPING[normalized];
    console.log(`[TTS] language=${normalized} voice=${voice} (exact match)`);
    return voice;
  }

  // Check for base language match (e.g., 'fr-FR' -> 'fr')
  const baseLanguage = normalized.split('-')[0];
  if (VOICE_MAPPING[baseLanguage]) {
    const voice = VOICE_MAPPING[baseLanguage];
    console.log(`[TTS] language=${normalized} voice=${voice} (base match: ${baseLanguage})`);
    return voice;
  }

  // Check environment variable overrides
  const envVar = `EDGE_TTS_${baseLanguage.toUpperCase()}_VOICE`;
  if (process.env[envVar]) {
    const voice = process.env[envVar];
    console.log(`[TTS] language=${normalized} voice=${voice} (env override: ${envVar})`);
    return voice;
  }

  // Fallback to default
  const defaultVoice = process.env.EDGE_TTS_VOICE || 'en-US-EmmaNeural';
  console.log(`[TTS] language=${normalized} voice=${defaultVoice} (fallback, no mapping found)`);
  return defaultVoice;
}

/**
 * Get the appropriate speaking rate for a language.
 *
 * @param {string} languageCode - ISO language code
 * @returns {string} Rate string (e.g., '+5%', '+0%', '-5%')
 */
function selectRateForLanguage(languageCode) {
  const normalized = String(languageCode || '').trim().toLowerCase();

  // Check for exact match
  if (LANGUAGE_RATES[normalized]) {
    return LANGUAGE_RATES[normalized];
  }

  // Check for base language match
  const baseLanguage = normalized.split('-')[0];
  if (LANGUAGE_RATES[baseLanguage]) {
    return LANGUAGE_RATES[baseLanguage];
  }

  // Check environment variable override
  const envVar = `EDGE_TTS_${baseLanguage.toUpperCase()}_RATE`;
  if (process.env[envVar]) {
    return process.env[envVar];
  }

  // Default fallback
  return process.env.EDGE_TTS_RATE || '+5%';
}

/**
 * @deprecated Use selectVoiceForLanguage instead
 */
function voiceLanguage(voice, language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized.startsWith('fr')) return 'fr-FR';
  const voiceMatch = String(voice || '').match(/^([a-z]{2}-[A-Z]{2})-/);
  return voiceMatch?.[1] || 'en-US';
}

/**
 * @deprecated Use selectVoiceForLanguage instead
 */
function defaultVoiceForLanguage(language) {
  return selectVoiceForLanguage(language);
}

function buildSsml(text, voice, rate, language) {
  const xmlLanguage = voiceLanguage(voice, language);
  return `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${xmlLanguage}'>` +
    `<voice name='${voice}'>` +
    `<prosody rate='${rate}'>${xmlEscape(text)}</prosody>` +
    `</voice></speak>`;
}

function buildConfigMessage() {
  return JSON.stringify({
    context: {
      synthesis: {
        audio: {
          metadataoptions: {
            sentenceBoundaryEnabled: 'false',
            wordBoundaryEnabled: 'false',
          },
          outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
        },
      },
    },
  });
}

function timestamp() {
  return new Date().toISOString();
}

/**
 * Synthesise text via Edge TTS and return a Buffer of MP3 audio.
 *
 * Automatically selects appropriate voice and rate based on language.
 *
 * @param {string} text
 * @param {string} [voice] - Optional specific voice (overrides language selection)
 * @param {string} [rate] - Optional specific rate (overrides language selection)
 * @param {string} [language] - Language code for voice selection (e.g., 'en', 'fr', 'ar')
 * @returns {Promise<Buffer>}
 */
function synthesizeEdgeTts(text, voice, rate, language) {
  // Use provided voice or auto-select based on language
  const v = voice || selectVoiceForLanguage(language);
  // Use provided rate or auto-select based on language
  const r = rate || selectRateForLanguage(language);

  console.log(`[TTS] synthesizing text="${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" voice=${v} rate=${r}`);

  return new Promise((resolve, reject) => {
    const connId  = randomUUID().replace(/-/g, '').toUpperCase();
    const wssUrl  = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
                    `?TrustedClientToken=${TRUSTED_TOKEN}&ConnectionId=${connId}`;

    const ws = new WebSocket(wssUrl, {
      headers: {
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
        'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      },
    });

    const audioChunks = [];
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch {}
      if (err) {
        reject(err);
      } else if (audioChunks.length === 0) {
        reject(new Error('Edge TTS returned no audio data'));
      } else {
        resolve(Buffer.concat(audioChunks));
      }
    };

    const timer = setTimeout(
      () => finish(new Error(`Edge TTS timed out after ${TIMEOUT_MS}ms`)),
      TIMEOUT_MS,
    );

    ws.on('open', () => {
      const ts = timestamp();

      /* 1 — speech config */
      ws.send(
        `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        buildConfigMessage(),
      );

      /* 2 — SSML */
      const reqId = randomUUID().replace(/-/g, '').toUpperCase();
      ws.send(
        `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` +
        buildSsml(text, v, r, language),
      );
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        /* Binary frame: starts with a 2-byte header-length field, then headers, then audio */
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);

        /* Find the double CRLF that separates headers from audio payload */
        const sep = Buffer.from('\r\n\r\n');
        const sepIdx = buf.indexOf(sep);
        if (sepIdx !== -1) {
          const payload = buf.slice(sepIdx + 4);
          if (payload.length > 0) audioChunks.push(payload);
        }
      } else {
        const msg = data.toString('utf8');
        if (msg.includes('Path:turn.end')) {
          finish(null);
        }
      }
    });

    ws.on('error', (err) => finish(err));
    ws.on('close', () => finish(null));
  });
}

module.exports = {
  synthesizeEdgeTts,
  selectVoiceForLanguage,
  selectRateForLanguage,
  VOICE_MAPPING,
  LANGUAGE_RATES,
};
