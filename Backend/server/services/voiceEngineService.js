const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const SERVER_DIR = path.resolve(__dirname, '..');
const BACKEND_DIR = path.resolve(SERVER_DIR, '..');
const REPO_DIR = path.resolve(BACKEND_DIR, '..');
const LOCAL_VENV_PYTHON = path.join(REPO_DIR, '.venv', 'Scripts', 'python.exe');
const DEFAULT_PYTHON = process.env.VOICE_ENGINE_PYTHON
  || process.env.PYTHON
  || (fs.existsSync(LOCAL_VENV_PYTHON) ? LOCAL_VENV_PYTHON : 'python');

const toBuffer = (chunk) => {
  if (Buffer.isBuffer(chunk)) return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'base64');
  return Buffer.from(chunk || []);
};

const buildWavBuffer = (chunks, sampleRate = 16000, channels = 1, bitsPerSample = 16) => {
  const pcmData = Buffer.concat((Array.isArray(chunks) ? chunks : []).map(toBuffer));
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
};

const writeTempWav = async (buffer) => {
  const tempDir = path.join(os.tmpdir(), 'voice-engine');
  await fsp.mkdir(tempDir, { recursive: true });
  const tempPath = path.join(tempDir, `${uuidv4()}.wav`);
  await fsp.writeFile(tempPath, buffer);
  return tempPath;
};

const parseMaybeBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
};

const parseVoiceEngineStdout = (stdout) => {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error('Failed to parse voice engine output: empty stdout');
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch (_) {
      // Continue scanning until a valid JSON line is found.
    }
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const maybeJson = text.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(maybeJson);
    } catch (_) {
      // Fall through to final error.
    }
  }

  throw new Error('Failed to parse voice engine output: no JSON payload detected');
};

const startVoiceEngineRealtimeWorker = (overrides = {}, handlers = {}) => {
  const whisperModel = String(overrides.whisperModel || process.env.VOICE_ENGINE_WHISPER_MODEL || 'medium');
  const whisperDevice = String(overrides.whisperDevice || process.env.VOICE_ENGINE_WHISPER_DEVICE || 'cpu');
  const whisperComputeType = String(overrides.whisperComputeType || process.env.VOICE_ENGINE_WHISPER_COMPUTE_TYPE || 'int8');
  const language = String(overrides.language ?? process.env.VOICE_ENGINE_LANGUAGE ?? 'en').trim();
  const singleSpeakerLabel = String(
    overrides.singleSpeakerLabel || process.env.VOICE_ENGINE_SINGLE_SPEAKER_LABEL || 'CANDIDATE',
  ).trim() || 'CANDIDATE';

  const pythonArgs = [
    '-m',
    'voice_engine.realtime_worker',
    '--sample-rate', String(overrides.sampleRate || process.env.VOICE_ENGINE_SAMPLE_RATE || 16000),
    '--channels', String(overrides.channels || process.env.VOICE_ENGINE_CHANNELS || 1),
    '--vad-threshold', String(overrides.vadThreshold || process.env.VOICE_ENGINE_VAD_THRESHOLD || 0.5),
    '--min-speech-ms', String(overrides.minSpeechMs || process.env.VOICE_ENGINE_MIN_SPEECH_MS || 320),
    '--min-silence-ms', String(overrides.minSilenceMs || process.env.VOICE_ENGINE_MIN_SILENCE_MS || 850),
    '--max-chunk-ms', String(overrides.maxChunkMs || process.env.VOICE_ENGINE_MAX_CHUNK_MS || 1800),
    '--max-trailing-silence-ms', String(overrides.maxTrailingSilenceMs || process.env.VOICE_ENGINE_MAX_TRAILING_SILENCE_MS || 180),
    '--min-chunk-rms', String(overrides.minChunkRms || process.env.VOICE_ENGINE_MIN_CHUNK_RMS || 0.015),
    '--min-speech-ratio', String(overrides.minSpeechRatio || process.env.VOICE_ENGINE_MIN_SPEECH_RATIO || 0.42),
    '--min-avg-logprob', String(overrides.minAvgLogprob || process.env.VOICE_ENGINE_MIN_AVG_LOGPROB || -0.65),
    '--max-no-speech-prob', String(overrides.maxNoSpeechProb || process.env.VOICE_ENGINE_MAX_NO_SPEECH_PROB || 0.35),
    '--partial-emit-ms', String(overrides.partialEmitMs || process.env.VOICE_ENGINE_PARTIAL_EMIT_MS || 700),
    '--partial-emit-ms', String(overrides.partialEmitMs || process.env.VOICE_ENGINE_PARTIAL_EMIT_MS || 700),
    '--whisper-model', whisperModel,
    '--whisper-device', whisperDevice,
    '--whisper-compute-type', whisperComputeType,
    '--single-speaker-label', singleSpeakerLabel,
  ];

  if (language && language.toLowerCase() !== 'auto') {
    pythonArgs.push('--language', language);
  }

  const child = spawn(DEFAULT_PYTHON, pythonArgs, {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PYTHONPATH: [BACKEND_DIR, SERVER_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    },
    windowsHide: true,
  });

  let stdoutBuffer = '';
  let stderr = '';
  let closeCode = null;
  let closeSignal = null;
  let isClosed = false;
  let stdinClosed = false;
  let stdinErrored = false;
  let stopRequested = false;
  let stopForceKilled = false;

  const handleStdinError = (error) => {
    stdinErrored = true;

    const code = String(error?.code || '').toUpperCase();
    const benignCloseError = (
      code === 'EOF'
      || code === 'EPIPE'
      || code === 'ECANCELED'
      || code === 'ERR_STREAM_DESTROYED'
    );

    if (!benignCloseError) {
      const message = error?.message || 'unknown stdin error';
      stderr += `\n[realtime-stdin] ${message}`;
      if (handlers.onStderr) handlers.onStderr(`[realtime-stdin] ${message}`);
      if (handlers.onError) handlers.onError(error);
    }
  };

  if (child.stdin) {
    child.stdin.on('error', handleStdinError);
    child.stdin.on('close', () => {
      stdinClosed = true;
    });
    child.stdin.on('finish', () => {
      stdinClosed = true;
    });
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');

    let newlineIndex = stdoutBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

      if (line) {
        try {
          const payload = JSON.parse(line);
          if (handlers.onMessage) handlers.onMessage(payload);
        } catch (_) {
          // Ignore non-JSON lines.
        }
      }

      newlineIndex = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    stderr += text;
    if (handlers.onStderr) handlers.onStderr(text);
  });

  child.on('error', (error) => {
    if (handlers.onError) handlers.onError(error);
  });

  child.on('close', (code, signal) => {
    closeCode = code;
    closeSignal = signal;
    isClosed = true;

    const trailing = stdoutBuffer.trim();
    if (trailing) {
      try {
        const payload = JSON.parse(trailing);
        if (handlers.onMessage) handlers.onMessage(payload);
      } catch (_) {
        // Ignore trailing non-JSON output.
      }
    }

    if (handlers.onClose) {
      handlers.onClose({
        code,
        signal,
        stderr: stderr.trim(),
        stopRequested,
        stopForceKilled,
      });
    }
  });

  const sendChunk = (chunk) => {
    if (!chunk) return false;
    if (isClosed || stdinClosed || stdinErrored || !child.stdin || child.stdin.destroyed || !child.stdin.writable) {
      return false;
    }

    const buffer = toBuffer(chunk);
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(buffer.length, 0);
    const framedPayload = Buffer.concat([header, buffer]);

    try {
      child.stdin.write(framedPayload, (error) => {
        if (error) handleStdinError(error);
      });
    } catch (error) {
      handleStdinError(error);
      return false;
    }

    return true;
  };

  const stop = (timeoutMs = 12000) => {
    return new Promise((resolve, reject) => {
      stopRequested = true;

      if (isClosed) {
        if (closeCode === 0) {
          resolve();
        } else if (closeSignal === 'SIGTERM' || closeSignal === 'SIGINT') {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `realtime worker exited with code ${closeCode}`));
        }
        return;
      }

      let settled = false;

      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };

      const settleResolve = () => settle(resolve);
      const settleReject = (error) => settle(reject, error);

      const timer = setTimeout(() => {
        if (!isClosed) {
          stopForceKilled = true;
          child.kill('SIGTERM');
          // Avoid noisy timeout failures on slower CPU transcriptions during flush.
          settleResolve();
        }
      }, timeoutMs);

      child.once('close', (code) => {
        if (code === 0) {
          settleResolve();
        } else {
          const signalClosed = closeSignal === 'SIGTERM' || closeSignal === 'SIGINT';
          if (signalClosed) {
            settleResolve();
          } else {
            settleReject(new Error(stderr.trim() || `realtime worker exited with code ${code}`));
          }
        }
      });

      if (child.stdin && !child.stdin.destroyed && child.stdin.writable && !stdinClosed) {
        try {
          child.stdin.end((error) => {
            if (error) handleStdinError(error);
          });
          stdinClosed = true;
        } catch (error) {
          handleStdinError(error);
        }
      }
    });
  };

  const kill = () => {
    stopRequested = true;
    stopForceKilled = true;
    if (!isClosed) child.kill('SIGTERM');
  };

  return {
    sendChunk,
    stop,
    kill,
  };
};

const runVoiceEngineAnalysis = (audioPath, overrides = {}) => {
  return new Promise((resolve, reject) => {
    const enableDiarization = parseMaybeBoolean(
      overrides.enableDiarization ?? process.env.VOICE_ENGINE_ENABLE_DIARIZATION,
      false,
    );
    const singleSpeakerLabel = String(
      overrides.singleSpeakerLabel || process.env.VOICE_ENGINE_SINGLE_SPEAKER_LABEL || 'CANDIDATE',
    ).trim() || 'CANDIDATE';

    const whisperModel = String(overrides.whisperModel || process.env.VOICE_ENGINE_WHISPER_MODEL || 'medium');
    const whisperDevice = String(overrides.whisperDevice || process.env.VOICE_ENGINE_WHISPER_DEVICE || 'cpu');
    const whisperComputeType = String(overrides.whisperComputeType || process.env.VOICE_ENGINE_WHISPER_COMPUTE_TYPE || 'int8');
    const language = String(overrides.language ?? process.env.VOICE_ENGINE_LANGUAGE ?? 'en').trim();

    const pythonArgs = [
      '-m',
      'voice_engine.cli',
      audioPath,
      '--sample-rate', String(overrides.sampleRate || process.env.VOICE_ENGINE_SAMPLE_RATE || 16000),
      '--channels', String(overrides.channels || process.env.VOICE_ENGINE_CHANNELS || 1),
      '--vad-threshold', String(overrides.vadThreshold || process.env.VOICE_ENGINE_VAD_THRESHOLD || 0.4),
      '--min-speech-ms', String(overrides.minSpeechMs || process.env.VOICE_ENGINE_MIN_SPEECH_MS || 220),
      '--min-silence-ms', String(overrides.minSilenceMs || process.env.VOICE_ENGINE_MIN_SILENCE_MS || 850),
      '--speech-pad-ms', String(overrides.speechPadMs || process.env.VOICE_ENGINE_SPEECH_PAD_MS || 220),
      '--whisper-model', whisperModel,
      '--whisper-device', whisperDevice,
      '--whisper-compute-type', whisperComputeType,
      '--single-speaker-label', singleSpeakerLabel,
      '--max-speakers', String(overrides.maxSpeakers || process.env.VOICE_ENGINE_MAX_SPEAKERS || 2),
      '--min-speakers', String(overrides.minSpeakers || process.env.VOICE_ENGINE_MIN_SPEAKERS || 2),
    ];

    if (overrides.saveDir) { pythonArgs.push('--save-dir', overrides.saveDir); }

      if (enableDiarization) {
      pythonArgs.push('--enable-diarization');
    }

    if (language && language.toLowerCase() !== 'auto') {
      pythonArgs.push('--language', language);
    }

    const hfToken = overrides.hfToken || process.env.VOICE_ENGINE_HF_TOKEN || process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
    if (enableDiarization && hfToken) {
      pythonArgs.push('--hf-token', String(hfToken));
    }

    const child = spawn(DEFAULT_PYTHON, pythonArgs, {
      cwd: BACKEND_DIR,
      env: {
        ...process.env,
        PYTHONPATH: [BACKEND_DIR, SERVER_DIR, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `voice_engine exited with code ${code}`));
      }

      try {
        resolve(parseVoiceEngineStdout(stdout));
      } catch (error) {
        reject(new Error(`Failed to parse voice engine output: ${error.message}`));
      }
    });
  });
};

module.exports = {
  buildWavBuffer,
  runVoiceEngineAnalysis,
  startVoiceEngineRealtimeWorker,
  writeTempWav,
};
