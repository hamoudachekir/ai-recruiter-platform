const express = require('express');
const multer = require('multer');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runVoiceEngineAnalysis } = require('../services/voiceEngineService');
const { requestSpeechStackTts } = require('../services/speechStackService');

const router = express.Router();
const upload = multer({ dest: path.join(os.tmpdir(), 'voice-engine-upload') });
const UPLOADS_DIR = path.resolve(__dirname, '..', 'uploads');
const RECORDINGS_DIR = path.resolve(__dirname, '..', 'voice-recordings');

const parseMaybeNumber = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

const parseMaybeBoolean = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
};

const normalizeTranscriptText = (turns = []) => turns
  .map((turn) => String(turn?.text || '').trim())
  .filter(Boolean)
  .join(' ')
  .trim();

const normalizeVoiceAnalysisResult = (result, overrides = {}) => {
  const turns = Array.isArray(result?.turns) ? result.turns : [];
  const segments = Array.isArray(result?.segments)
    ? result.segments
    : turns.map((turn) => ({
      speaker: turn?.speaker,
      start_ms: turn?.start_ms,
      end_ms: turn?.end_ms,
      text: turn?.text,
      language: turn?.language,
      words: turn?.words || [],
      silence_before_ms: turn?.silence_before_ms || 0,
    }));

  const text = String(result?.text || normalizeTranscriptText(turns)).trim();
  const language = String(result?.language || overrides.language || 'fr').trim() || 'fr';

  return {
    ok: result?.ok !== false,
    status: result?.status || 'ok',
    text,
    language,
    segments,
    turns: turns.length > 0 ? turns : segments,
    turn_count: Number.isFinite(result?.turn_count) ? result.turn_count : Math.max(turns.length, segments.length),
    summary: result?.summary ?? null,
    saved_files: result?.saved_files || null,
    raw: result,
  };
};

const normalizeOverrides = (body = {}) => ({
  sampleRate: parseMaybeNumber(body.sampleRate),
  channels: parseMaybeNumber(body.channels),
  vadThreshold: parseMaybeNumber(body.vadThreshold),
  minSpeechMs: parseMaybeNumber(body.minSpeechMs),
  minSilenceMs: parseMaybeNumber(body.minSilenceMs),
  speechPadMs: parseMaybeNumber(body.speechPadMs),
  whisperModel: body.whisperModel,
  whisperDevice: body.whisperDevice,
  whisperComputeType: body.whisperComputeType,
  language: body.language,
  hfToken: body.hfToken,
  enableDiarization: parseMaybeBoolean(body.enableDiarization),
  singleSpeakerLabel: body.singleSpeakerLabel,
  maxSpeakers: parseMaybeNumber(body.maxSpeakers),
  minSpeakers: parseMaybeNumber(body.minSpeakers),
});

router.get('/health', (req, res) => {
  res.status(200).json({ ok: true, service: 'voice-engine' });
});

router.post('/tts', async (req, res) => {
  try {
    const text = String(req.body?.text || '').trim();
    if (!text) {
      return res.status(400).json({ ok: false, message: 'text is required' });
    }

    const result = await requestSpeechStackTts({
      text,
      rate: parseMaybeNumber(req.body?.rate),
      volume: parseMaybeNumber(req.body?.volume),
      voiceId: req.body?.voiceId || req.body?.voice_id || null,
      language: req.body?.language || null,
    });

    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', result.contentDisposition);
    return res.status(200).send(result.buffer);
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

router.get('/download/:fileName', async (req, res) => {
  const fileName = path.basename(String(req.params.fileName || ''));
  const bucket = String(req.query.bucket || 'uploads').trim().toLowerCase();

  const baseDir = bucket === 'recordings' ? RECORDINGS_DIR : UPLOADS_DIR;
  const resolvedPath = path.resolve(baseDir, fileName);
  const basePrefix = `${baseDir}${path.sep}`;

  if (resolvedPath !== baseDir && !resolvedPath.startsWith(basePrefix)) {
    return res.status(400).json({ ok: false, message: 'invalid file path' });
  }

  try {
    const stat = await fsp.stat(resolvedPath);
    if (!stat.isFile()) {
      return res.status(404).json({ ok: false, message: 'file not found' });
    }

    return res.download(resolvedPath, fileName);
  } catch (error) {
    console.warn('Voice download failed:', error?.message || error);
    return res.status(404).json({ ok: false, message: 'file not found' });
  }
});

router.post('/analyze', upload.single('audio'), async (req, res) => {
  return handleVoiceAnalysis(req, res);
});

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  return handleVoiceAnalysis(req, res);
});

async function handleVoiceAnalysis(req, res) {
  const filePath = req.file?.path;

  if (!filePath) {
    return res.status(400).json({ ok: false, message: 'audio file is required' });
  }

  try {
    const overrides = normalizeOverrides(req.body);
    // Explicitly ask the python engine to save the testing artifacts so users can track them
    overrides.saveDir = path.join(path.resolve(__dirname, '..'), 'uploads');

    const result = await runVoiceEngineAnalysis(filePath, overrides);
    return res.status(200).json(normalizeVoiceAnalysisResult(result, overrides));
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  } finally {
    await fsp.unlink(filePath).catch(() => {});
  }
}

module.exports = router;
