/**
 * Edge TTS — direct WebSocket client for Node.js.
 *
 * Uses the same endpoint as the Python edge-tts library.
 * No extra npm packages needed — depends only on `ws` (already installed via socket.io).
 *
 * Voice: controlled by EDGE_TTS_VOICE env var (default en-US-EmmaNeural)
 * Rate:  controlled by EDGE_TTS_RATE  env var (default +5%)
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

function voiceLanguage(voice, language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized.startsWith('fr')) return 'fr-FR';
  const voiceMatch = String(voice || '').match(/^([a-z]{2}-[A-Z]{2})-/);
  return voiceMatch?.[1] || 'en-US';
}

function defaultVoiceForLanguage(language) {
  const normalized = String(language || '').trim().toLowerCase();
  if (normalized.startsWith('fr')) {
    return process.env.EDGE_TTS_FR_VOICE || 'fr-FR-DeniseNeural';
  }
  return process.env.EDGE_TTS_EN_VOICE || process.env.EDGE_TTS_VOICE || 'en-US-EmmaNeural';
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
 * @param {string} text
 * @param {string} [voice]
 * @param {string} [rate]
 * @param {string} [language]
 * @returns {Promise<Buffer>}
 */
function synthesizeEdgeTts(text, voice, rate, language) {
  const v = voice || defaultVoiceForLanguage(language);
  const r = rate  || process.env.EDGE_TTS_RATE  || '+5%';

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

module.exports = { synthesizeEdgeTts };
