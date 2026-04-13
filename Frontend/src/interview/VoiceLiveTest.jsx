import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import './VoiceLiveTest.css';

const VOICE_API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
const SUPPORTED_WHISPER_MODELS = new Set(['small', 'base', 'base.en']);
const SUPPORTED_AUDIO_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

const normalizeVoiceLanguage = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized === 'auto' ? 'fr' : normalized;
};

const normalizeWhisperModel = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return SUPPORTED_WHISPER_MODELS.has(normalized) ? normalized : 'small';
};

const getEffectiveModel = (language, selectedModel) => {
  const normalizedLanguage = String(language || '').trim().toLowerCase();
  const normalizedModel = normalizeWhisperModel(selectedModel);

  if (normalizedLanguage === 'en' && normalizedModel === 'small') {
    return 'base.en';
  }

  return normalizedModel;
};

const getSupportedAudioMimeType = () => {
  if (typeof MediaRecorder === 'undefined') return '';
  return SUPPORTED_AUDIO_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || '';
};

const formatMilliseconds = (value) => `${Math.round(Number(value || 0))} ms`;

const downsampleBuffer = (buffer, inputSampleRate, outputSampleRate) => {
  if (outputSampleRate >= inputSampleRate) return buffer;

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      accum += buffer[index];
      count += 1;
    }

    result[offsetResult] = accum / (count || 1);
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
};

const floatTo16BitPCM = (float32Buffer) => {
  const output = new Int16Array(float32Buffer.length);
  for (let i = 0; i < float32Buffer.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Buffer[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
};

const getInitialRoomId = () => {
  if (globalThis.window === undefined) return 'voice-live-room-1';

  const params = new URLSearchParams(globalThis.window.location.search || '');
  const fromQuery = String(params.get('room') || '').trim();
  if (fromQuery) {
    localStorage.setItem('voiceLiveRoomId', fromQuery);
    return fromQuery;
  }

  return localStorage.getItem('voiceLiveRoomId') || 'voice-live-room-1';
};

const mergeIncomingSegment = (previous, payload) => {
  const next = [...previous];
  const index = next.findIndex((segment) => segment.turn_index === payload.turn_index);

  if (index >= 0) {
    next[index] = payload;
  } else {
    next.push(payload);
  }

  return next.sort((a, b) => Number(a?.turn_index || 0) - Number(b?.turn_index || 0));
};

const VoiceLiveTest = () => {
  const { loading: authLoading } = useAuth();

  const [status, setStatus] = useState('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [micLevel, setMicLevel] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [finalSummary, setFinalSummary] = useState(null);
  const [segments, setSegments] = useState([]);
  const [debugAckCount, setDebugAckCount] = useState(0);
  const [debugLastAck, setDebugLastAck] = useState(null);
  const [selectedLanguage, setSelectedLanguage] = useState(() =>
    normalizeVoiceLanguage(localStorage.getItem('voiceLanguage') || 'fr'),
  );
  const [selectedModel, setSelectedModel] = useState(() =>
    normalizeWhisperModel(localStorage.getItem('voiceWhisperModel') || 'base.en'),
  );
  const [roomId, setRoomId] = useState(getInitialRoomId);

  const socketRef = useRef(null);
  const streamIdRef = useRef('');
  const localAudioStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const liveAudioContextRef = useRef(null);
  const liveSourceNodeRef = useRef(null);
  const liveProcessorRef = useRef(null);
  const meterAudioContextRef = useRef(null);
  const meterSourceNodeRef = useRef(null);
  const meterAnalyserRef = useRef(null);
  const meterFrameRef = useRef(0);

  const transcriptText = useMemo(() => {
    return segments
      .map((segment) => String(segment?.text || '').trim())
      .filter(Boolean)
      .join(' ')
      .trim();
  }, [segments]);

  const effectiveModel = useMemo(() => getEffectiveModel(selectedLanguage, selectedModel), [selectedLanguage, selectedModel]);

  const handleLanguageChange = (event) => {
    const value = event.target.value;
    setSelectedLanguage(value);
    localStorage.setItem('voiceLanguage', value);
  };

  const handleModelChange = (event) => {
    const value = event.target.value;
    setSelectedModel(value);
    localStorage.setItem('voiceWhisperModel', value);
  };

  const handleRoomChange = (event) => {
    const value = event.target.value;
    setRoomId(value);
    localStorage.setItem('voiceLiveRoomId', value);
  };

  const cleanupVoiceStream = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (error) {
        console.warn('Recorder stop during cleanup failed:', error);
      }
    }

    mediaRecorderRef.current = null;

    if (liveProcessorRef.current) {
      try {
        liveProcessorRef.current.disconnect();
      } catch (error) {
        console.warn('Live processor disconnect failed:', error);
      }
      liveProcessorRef.current.onaudioprocess = null;
      liveProcessorRef.current = null;
    }

    if (liveSourceNodeRef.current) {
      try {
        liveSourceNodeRef.current.disconnect();
      } catch (error) {
        console.warn('Live source disconnect failed:', error);
      }
      liveSourceNodeRef.current = null;
    }

    if (liveAudioContextRef.current) {
      liveAudioContextRef.current.close().catch(() => {});
      liveAudioContextRef.current = null;
    }

    if (localAudioStreamRef.current) {
      localAudioStreamRef.current.getTracks().forEach((track) => track.stop());
      localAudioStreamRef.current = null;
    }

    setIsRecording(false);
  }, []);

  const cleanupMicMeter = useCallback(() => {
    if (meterFrameRef.current) {
      cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = 0;
    }

    if (meterSourceNodeRef.current) {
      try {
        meterSourceNodeRef.current.disconnect();
      } catch (error) {
        console.warn('Meter source disconnect failed:', error);
      }
      meterSourceNodeRef.current = null;
    }

    meterAnalyserRef.current = null;

    if (meterAudioContextRef.current) {
      meterAudioContextRef.current.close().catch(() => {});
      meterAudioContextRef.current = null;
    }

    setMicLevel(0);
  }, []);

  const startMicMeter = useCallback(async (stream) => {
    cleanupMicMeter();

    try {
      const meterAudioContext = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      await meterAudioContext.resume();

      const meterSourceNode = meterAudioContext.createMediaStreamSource(stream);
      const analyser = meterAudioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.85;
      meterSourceNode.connect(analyser);

      const waveform = new Float32Array(analyser.fftSize);
      const tick = () => {
        analyser.getFloatTimeDomainData(waveform);

        let energy = 0;
        for (const sample of waveform) {
          energy += sample * sample;
        }

        const rms = Math.sqrt(energy / waveform.length) || 0;
        setMicLevel(Math.round(Math.min(1, rms * 4) * 100));
        meterFrameRef.current = requestAnimationFrame(tick);
      };

      meterAudioContextRef.current = meterAudioContext;
      meterSourceNodeRef.current = meterSourceNode;
      meterAnalyserRef.current = analyser;
      tick();
    } catch (error) {
      cleanupMicMeter();
      console.warn('Mic meter start failed:', error);
    }
  }, [cleanupMicMeter]);

  const cleanupAll = useCallback(() => {
    cleanupVoiceStream();
    cleanupMicMeter();
  }, [cleanupVoiceStream, cleanupMicMeter]);

  useEffect(() => {
    if (authLoading) return;

    const token = localStorage.getItem('token');
    const socket = io(VOICE_API_BASE_URL, {
      auth: token ? { token } : {},
      path: '/socket.io/',
      transports: ['polling', 'websocket'],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 700,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setStatus('ready');
      setErrorMessage('');

      const normalizedRoomId = String(roomId || '').trim();
      if (normalizedRoomId) {
        socket.emit('join-interview', { interviewId: normalizedRoomId });
      }
    });

    socket.on('connect_error', (error) => {
      setStatus('error');
      setErrorMessage(error?.message || 'Connexion socket impossible.');
    });

    socket.on('voice-segment-update', (payload) => {
      if (payload?.type !== 'partial') return;
      if (streamIdRef.current && payload?.streamId && payload.streamId !== streamIdRef.current) return;
      setSegments((previous) => mergeIncomingSegment(previous, payload));
    });

    socket.on('voice-stream:partial', (payload) => {
      if (payload?.type !== 'partial') return;
      if (streamIdRef.current && payload?.streamId && payload.streamId !== streamIdRef.current) return;
      setSegments((previous) => mergeIncomingSegment(previous, payload));
    });

    socket.on('voice-stream:result', (result) => {
      setFinalSummary(result || null);
      setStatus('ready');
      setIsSubmitting(false);
    });

    socket.on('voice-stream:error', (payload) => {
      setStatus('error');
      setIsSubmitting(false);
      setErrorMessage(payload?.message || 'Live stream error');
    });

    socket.on('voice-stream:chunk-ack', (payload) => {
      if (streamIdRef.current && payload?.streamId && payload.streamId !== streamIdRef.current) return;
      setDebugAckCount(Number(payload?.chunkCount || 0));
      setDebugLastAck(payload || null);
    });

    socket.on('voice-test-completed', (summary) => {
      setFinalSummary(summary || null);
      setStatus('ready');
      setIsSubmitting(false);
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      cleanupAll();
    };
  }, [authLoading, cleanupAll, roomId]);

  useEffect(() => {
    if (!socketRef.current?.connected) return;

    const normalizedRoomId = String(roomId || '').trim();
    if (!normalizedRoomId) return;

    socketRef.current.emit('join-interview', { interviewId: normalizedRoomId });
  }, [roomId, status]);

  const startRecording = useCallback(async () => {
    if (isRecording || isSubmitting) return;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setStatus('error');
      setErrorMessage('Le navigateur ne prend pas en charge l enregistrement audio.');
      return;
    }

    if (!socketRef.current?.connected) {
      setStatus('error');
      setErrorMessage('Socket non connecte.');
      return;
    }

    try {
      setErrorMessage('');
      setFinalSummary(null);
      setSegments([]);
      setDebugAckCount(0);
      setDebugLastAck(null);
      setMicLevel(0);
      setIsSubmitting(true);

      if (roomId?.trim()) {
        socketRef.current.emit('join-interview', { interviewId: roomId.trim() });
      }

      const streamId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      streamIdRef.current = streamId;

      socketRef.current.emit('voice-stream:start', {
        streamId,
        interviewId: roomId?.trim() || null,
        language: selectedLanguage,
        whisperModel: effectiveModel,
        sampleRate: 16000,
        channels: 1,
        minSpeechMs: 280,
        minSilenceMs: 360,
        maxChunkMs: 1600,
        maxTrailingSilenceMs: 180,
      });

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });

      localAudioStreamRef.current = stream;
      await startMicMeter(stream);

      const liveAudioContext = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      await liveAudioContext.resume();

      const sourceNode = liveAudioContext.createMediaStreamSource(stream);
      const processor = liveAudioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0);
        const downsampled = downsampleBuffer(inputData, liveAudioContext.sampleRate, 16000);
        const int16 = floatTo16BitPCM(downsampled);

        if (int16.length > 0 && socketRef.current?.connected) {
          socketRef.current.emit('voice-stream:chunk', { streamId: streamIdRef.current, chunk: int16.buffer });
        }
      };

      sourceNode.connect(processor);
      processor.connect(liveAudioContext.destination);

      liveAudioContextRef.current = liveAudioContext;
      liveSourceNodeRef.current = sourceNode;
      liveProcessorRef.current = processor;

      setStatus('recording');
      setIsRecording(true);
    } catch (error) {
      cleanupAll();
      setStatus('error');
      setIsSubmitting(false);
      setErrorMessage(`Micro inaccessible: ${error?.message || 'permission refused'}`);
    }
  }, [cleanupAll, cleanupMicMeter, effectiveModel, isRecording, isSubmitting, roomId, selectedLanguage, startMicMeter]);

  const stopRecording = useCallback(() => {
    if (!isRecording) {
      return;
    }

    setStatus('processing');

    if (socketRef.current?.connected) {
      socketRef.current.emit('voice-stream:stop', { streamId: streamIdRef.current });
    }

    cleanupAll();
  }, [cleanupAll, isRecording]);

  const resetSession = useCallback(() => {
    cleanupAll();
    setStatus('ready');
    setErrorMessage('');
    setSegments([]);
    setFinalSummary(null);
    setDebugAckCount(0);
    setDebugLastAck(null);
    setIsSubmitting(false);
  }, [cleanupAll]);

  return (
    <div className="voice-live-test-page">
      <div className="voice-live-test-card">
        <h1>Live Speech-to-Text Test</h1>
        <p>
          Real-time transcription is streamed over Socket.IO. Recruiter and candidate can join the same room ID.
        </p>

        <div className="voice-live-test-status">
          <span>Recorder: {status}</span>
          <span>Language: {selectedLanguage.toUpperCase()}</span>
          <span>Model: {effectiveModel}</span>
          <span>Debug ACK: {debugAckCount}</span>
        </div>

        {debugLastAck && (
          <div className="voice-live-test-processing">
            DEBUG: chunk #{debugLastAck.chunkCount} ({debugLastAck.chunkBytes} bytes) from {debugLastAck.sourceUserId || 'unknown'}
          </div>
        )}

        <div className="voice-live-test-config">
          <label>
            <span>Language</span>
            <select value={selectedLanguage} onChange={handleLanguageChange}>
              <option value="fr">French</option>
              <option value="en">English</option>
              <option value="auto">Auto detect</option>
            </select>
          </label>
          <label>
            <span>Whisper model</span>
            <select value={selectedModel} onChange={handleModelChange}>
              <option value="small">small (recommended)</option>
              <option value="base">base</option>
              <option value="base.en">base.en (English only)</option>
            </select>
          </label>
          <label>
            <span>Live room ID</span>
            <input type="text" value={roomId} onChange={handleRoomChange} placeholder="voice-live-room-1" />
          </label>
        </div>

        <div className="voice-live-test-meter">
          <div className="voice-live-test-meter-head">
            <span>Mic level</span>
            <strong>{micLevel}%</strong>
          </div>
          <progress className="voice-live-test-meter-track" value={micLevel} max={100} aria-label="Microphone level" />
        </div>

        {errorMessage && <div className="voice-live-test-error">{errorMessage}</div>}

        <div className="voice-live-test-actions">
          <button type="button" onClick={startRecording} disabled={status === 'recording' || isSubmitting}>
            Start Live STT
          </button>
          <button type="button" onClick={stopRecording} disabled={status !== 'recording'}>
            Stop
          </button>
          <button type="button" onClick={resetSession} disabled={status === 'loading'}>
            Reset
          </button>
        </div>

        {status === 'processing' && (
          <div className="voice-live-test-processing">
            Finalizing stream...
          </div>
        )}

        {transcriptText && (
          <div className="voice-live-test-result">
            <h2>Live Transcript</h2>
            <p>{segments.length} segment(s)</p>
            <div className="voice-live-test-transcript">
              <p>{transcriptText}</p>
            </div>
          </div>
        )}

        {Array.isArray(segments) && segments.length > 0 && (
          <div className="voice-live-test-result">
            <h2>Structured Segments</h2>
            <p>{segments.length} segment(s) received live</p>
            <div className="voice-live-test-turns">
              {segments.map((segment, index) => (
                <div key={`${segment.speaker || 'segment'}-${segment.start_ms || 0}-${index}`} className="voice-live-test-turn">
                  <strong>{segment.speaker || 'SPEAKER'}</strong>
                  <span>{segment.text || ''}</span>
                  <small>
                    {formatMilliseconds(segment.start_ms)} - {formatMilliseconds(segment.end_ms)}
                  </small>
                </div>
              ))}
            </div>
          </div>
        )}

        {finalSummary && (
          <div className="voice-live-test-result">
            <h2>Stream Summary</h2>
            <div className="voice-live-test-transcript">
              <p>{JSON.stringify(finalSummary)}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default VoiceLiveTest;