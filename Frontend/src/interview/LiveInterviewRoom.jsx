import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import './LiveInterviewRoom.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
const DEFAULT_ROOM = 'voice-live-room-1';
const AUDIO_WORKLET_NAME = 'pcm-capture-processor';

const parseQuery = () => {
  if (!globalThis.window?.location?.search) {
    return { room: DEFAULT_ROOM, role: 'candidate' };
  }

  const params = new URLSearchParams(globalThis.window.location.search);
  const room = String(params.get('room') || DEFAULT_ROOM).trim() || DEFAULT_ROOM;
  const rawRole = String(params.get('role') || 'candidate').trim().toLowerCase();
  const role = rawRole === 'rh' ? 'rh' : 'candidate';
  return { room, role };
};

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

    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
      accum += buffer[i];
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

const buildSegmentKey = (segment) => `${segment?.streamId || 'stream'}-${segment?.turn_index || 0}`;

const mergeSegments = (previous, incoming) => {
  const next = [...previous];
  const key = buildSegmentKey(incoming);
  const index = next.findIndex((segment) => buildSegmentKey(segment) === key);

  if (index >= 0) {
    next[index] = { ...next[index], ...incoming };
  } else {
    next.push(incoming);
  }

  return next.sort((a, b) => {
    const streamCompare = String(a?.streamId || '').localeCompare(String(b?.streamId || ''));
    if (streamCompare !== 0) return streamCompare;
    return Number(a?.turn_index || 0) - Number(b?.turn_index || 0);
  });
};

const getDisplaySegmentText = (segment) => String(segment?.corrected_text || segment?.text || '').trim();

const normalizeSentiment = (value) => {
  const normalized = String(value || 'NEUTRAL').trim().toUpperCase();
  if (normalized === 'POSITIVE' || normalized === 'NEGATIVE') return normalized;
  return 'NEUTRAL';
};

const formatMs = (value) => `${Math.round(Number(value || 0))} ms`;

const LiveInterviewRoom = () => {
  const initial = parseQuery();
  const [role, setRole] = useState(initial.role);
  const [roomId, setRoomId] = useState(initial.room);
  const [status, setStatus] = useState('connecting');
  const [isRecording, setIsRecording] = useState(false);
  const [ackCount, setAckCount] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [segments, setSegments] = useState([]);
  const [streamResult, setStreamResult] = useState(null);

  const socketRef = useRef(null);
  const streamIdRef = useRef('');
  const localAudioStreamRef = useRef(null);
  const liveAudioContextRef = useRef(null);
  const liveSourceNodeRef = useRef(null);
  const liveProcessorRef = useRef(null);
  const liveSilentGainRef = useRef(null);

  const transcriptText = useMemo(() => {
    return segments
      .map((segment) => getDisplaySegmentText(segment))
      .filter(Boolean)
      .join(' ')
      .trim();
  }, [segments]);

  const downloadEntries = useMemo(() => {
    if (role !== 'rh') return [];

    const files = streamResult?.downloadFiles || {};
    return [
      { key: 'rawRecording', label: 'Download Recording', payload: files.rawRecording },
      { key: 'txt', label: 'Download TXT', payload: files.txt },
      { key: 'pdf', label: 'Download PDF', payload: files.pdf },
    ];
  }, [role, streamResult]);

  const summaryText = useMemo(() => {
    if (role !== 'rh') return '';
    return String(streamResult?.summary || '').trim();
  }, [role, streamResult]);

  const liveSentiment = useMemo(() => {
    if (role !== 'rh') return 'NEUTRAL';
    const lastSegment = segments.at(-1) || null;
    return normalizeSentiment(lastSegment?.sentiment || streamResult?.sentiment_overall || 'NEUTRAL');
  }, [role, segments, streamResult]);

  const cleanupAudio = useCallback(() => {
    if (liveProcessorRef.current) {
      try {
        liveProcessorRef.current.disconnect();
      } catch (error) {
        console.warn('Live processor cleanup failed:', error);
      }
      liveProcessorRef.current.port?.close?.();
      liveProcessorRef.current = null;
    }

    if (liveSilentGainRef.current) {
      try {
        liveSilentGainRef.current.disconnect();
      } catch (error) {
        console.warn('Live gain cleanup failed:', error);
      }
      liveSilentGainRef.current = null;
    }

    if (liveSourceNodeRef.current) {
      try {
        liveSourceNodeRef.current.disconnect();
      } catch (error) {
        console.warn('Live source cleanup failed:', error);
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

  useEffect(() => {
    const token = localStorage.getItem('token');
    const socket = io(API_BASE_URL, {
      auth: token ? { token } : {},
      path: '/socket.io/',
      transports: ['polling', 'websocket'],
      reconnection: true,
      reconnectionAttempts: 8,
      reconnectionDelay: 700,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setStatus('connected');
      setErrorMessage('');
      if (roomId.trim()) {
        socket.emit('join-interview', { interviewId: roomId.trim() });
      }
    });

    socket.on('connect_error', (error) => {
      setStatus('error');
      setErrorMessage(error?.message || 'Socket connection failed');
    });

    socket.on('voice-stream:partial', (payload) => {
      if (!payload?.text) return;
      setSegments((prev) => mergeSegments(prev, payload));
    });

    socket.on('voice-stream:chunk-ack', (payload) => {
      const sid = streamIdRef.current;
      if (sid && payload?.streamId === sid) {
        setAckCount(Number(payload?.chunkCount || 0));
      }
    });

    socket.on('voice-stream:result', (payload) => {
      setStreamResult(payload || null);
      if (Array.isArray(payload?.corrected_segments) && payload.corrected_segments.length > 0) {
        setSegments(payload.corrected_segments);
      }
    });

    socket.on('voice-stream:error', (payload) => {
      setErrorMessage(payload?.message || 'Live stream error');
    });

    return () => {
      cleanupAudio();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [cleanupAudio, roomId]);

  const joinRoom = useCallback(() => {
    if (!socketRef.current?.connected) return;
    const normalized = roomId.trim();
    if (!normalized) return;

    socketRef.current.emit('join-interview', { interviewId: normalized });
    setSegments([]);
    setStreamResult(null);
  }, [roomId]);

  const startCandidateStream = useCallback(async () => {
    if (role !== 'candidate') return;
    if (!socketRef.current?.connected) {
      setErrorMessage('Socket not connected');
      return;
    }

    try {
      setErrorMessage('');
      setAckCount(0);
      setSegments([]);
      setStreamResult(null);

      const streamId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      streamIdRef.current = streamId;

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

      socketRef.current.emit('voice-stream:start', {
        streamId,
        interviewId: roomId.trim(),
        language: 'en',
        whisperModel: 'base.en',
        realtimeWhisperModel: 'base.en',
        sampleRate: 16000,
        channels: 1,
        minSpeechMs: 220,
        minSilenceMs: 260,
        maxChunkMs: 900,
        maxTrailingSilenceMs: 120,
        minChunkRms: 0.01,
        minSpeechRatio: 0.28,
        minAvgLogprob: -0.8,
        maxNoSpeechProb: 0.45,
        partialEmitMs: 450,
      });

      const liveAudioContext = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      await liveAudioContext.resume();
      await liveAudioContext.audioWorklet.addModule(new URL('./pcmCaptureWorklet.js', import.meta.url));

      const sourceNode = liveAudioContext.createMediaStreamSource(stream);
      const processor = new AudioWorkletNode(liveAudioContext, AUDIO_WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        processorOptions: {
          chunkSize: 2048,
        },
      });
      const silentGain = liveAudioContext.createGain();
      silentGain.gain.value = 0;

      processor.port.onmessage = (event) => {
        const payload = event?.data;
        let inputData = null;
        if (payload instanceof Float32Array) {
          inputData = payload;
        } else if (payload instanceof ArrayBuffer) {
          inputData = new Float32Array(payload);
        }

        if (!inputData || inputData.length === 0) return;

        const downsampled = downsampleBuffer(inputData, liveAudioContext.sampleRate, 16000);
        const int16 = floatTo16BitPCM(downsampled);

        if (int16.length > 0 && socketRef.current?.connected) {
          socketRef.current.emit('voice-stream:chunk', {
            streamId: streamIdRef.current,
            chunk: int16.buffer,
          });
        }
      };

      sourceNode.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(liveAudioContext.destination);

      liveAudioContextRef.current = liveAudioContext;
      liveSourceNodeRef.current = sourceNode;
      liveProcessorRef.current = processor;
      liveSilentGainRef.current = silentGain;
      setIsRecording(true);
      setStatus('recording');
    } catch (error) {
      cleanupAudio();
      setStatus('error');
      setErrorMessage(error?.message || 'Unable to start stream');
    }
  }, [cleanupAudio, role, roomId]);

  const stopCandidateStream = useCallback(() => {
    if (!socketRef.current?.connected || !streamIdRef.current) {
      cleanupAudio();
      return;
    }

    if (liveProcessorRef.current?.port) {
      liveProcessorRef.current.port.postMessage({ type: 'stop' });
    }

    socketRef.current.emit('voice-stream:stop', { streamId: streamIdRef.current });
    cleanupAudio();
    setStatus('connected');
  }, [cleanupAudio]);

  return (
    <div className="live-interview-room-page">
      <div className="live-interview-room-card">
        <h1>Live Interview Room</h1>
        <p>
          Open this page in two tabs with the same room. Candidate speaks, RH sees live transcript.
        </p>

        <div className="live-interview-row">
          <label>
            <span>Role</span>
            <select value={role} onChange={(event) => setRole(event.target.value === 'rh' ? 'rh' : 'candidate')}>
              <option value="candidate">Candidate</option>
              <option value="rh">RH</option>
            </select>
          </label>
          <label>
            <span>Room ID</span>
            <input value={roomId} onChange={(event) => setRoomId(event.target.value)} />
          </label>
          <button type="button" onClick={joinRoom}>Join Room</button>
        </div>

        <div className="live-interview-status">
          <span>Status: {status}</span>
          <span>Role: {role.toUpperCase()}</span>
          <span>ACK: {ackCount}</span>
        </div>

        {errorMessage && <div className="live-interview-error">{errorMessage}</div>}

        {role === 'candidate' && (
          <div className="live-interview-actions">
            <button type="button" disabled={isRecording} onClick={startCandidateStream}>
              Start Candidate Stream
            </button>
            <button type="button" disabled={!isRecording} onClick={stopCandidateStream}>
              Stop Candidate Stream
            </button>
          </div>
        )}

        {role === 'candidate' && (
          <div className="live-interview-result">
            <h2>Candidate View</h2>
            <div className="live-interview-transcript-box">
              <p>
                {isRecording
                  ? 'You are live. Keep speaking clearly. The RH interface receives the transcript in real time.'
                  : 'Press Start Candidate Stream and begin speaking.'}
              </p>
            </div>
          </div>
        )}

        {role === 'rh' && (
          <div className="live-interview-result">
            <h2>Live Transcript</h2>
            <p>{segments.length} segment(s)</p>
            <p>
              Sentiment:
              {' '}
              <span className={`live-sentiment-badge sentiment-${liveSentiment.toLowerCase()}`}>
                {liveSentiment}
              </span>
            </p>
            <div className="live-interview-transcript-box">
              <p>{transcriptText || 'Waiting for candidate speech...'}</p>
            </div>
          </div>
        )}

        {role === 'rh' && segments.length > 0 && (
          <div className="live-interview-result">
            <h2>Structured Segments</h2>
            <div className="live-interview-segments">
              {segments.map((segment, index) => (
                <div key={`${buildSegmentKey(segment)}-${index}`} className="live-interview-segment-item">
                  <strong>{segment?.speaker || 'CANDIDATE'}</strong>
                  <small>{segment?.sourceUserId || 'unknown-user'}</small>
                  <small>
                    <span className={`live-sentiment-badge sentiment-${normalizeSentiment(segment?.sentiment).toLowerCase()}`}>
                      {normalizeSentiment(segment?.sentiment)}
                    </span>
                  </small>
                  <span>{getDisplaySegmentText(segment)}</span>
                  <small>{formatMs(segment?.start_ms)} - {formatMs(segment?.end_ms)}</small>
                </div>
              ))}
            </div>
          </div>
        )}

        {role === 'rh' && streamResult && (
          <div className="live-interview-result">
            <h2>Final Result</h2>
            <div className="live-interview-transcript-box">
              <p>{String(streamResult?.corrected_text || streamResult?.text || '')}</p>
            </div>

            {summaryText && (
              <>
                <h2 style={{ marginTop: '0.9rem' }}>Interview Summary</h2>
                <div className="live-interview-transcript-box">
                  <p>{summaryText}</p>
                </div>
              </>
            )}

            {downloadEntries.length > 0 && (
              <div className="live-interview-actions" style={{ marginTop: '0.8rem' }}>
                {downloadEntries.map((entry) => (
                  entry?.payload?.url ? (
                    <a
                      key={entry.key}
                      className="live-interview-download-link"
                      href={`${API_BASE_URL}${entry.payload.url}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {entry.label}
                    </a>
                  ) : (
                    <button
                      key={entry.key}
                      type="button"
                      disabled
                      title="Will be available after final transcription is generated"
                    >
                      {entry.label}
                    </button>
                  )
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default LiveInterviewRoom;
