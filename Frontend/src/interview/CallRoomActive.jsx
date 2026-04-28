import { useEffect, useState, useRef } from 'react';
import AgentChatPanel from './AgentChatPanel';
import StreamojiAvatarWrapper from './StreamojiAvatarWrapper';
import { useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import PublicLayout from '../layouts/PublicLayout';
import './CallRoomActive.css';

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001';
const SPEECH_STACK_URL = import.meta.env.VITE_SPEECH_STACK_URL || 'http://localhost:8012';
const VOICE_API_URL = `${API_BASE}/api/voice`;
const MIN_AUDIO_BLOB_BYTES = 2048;

// Voice-activity-detection endpointing: record the *whole* utterance, only
// cut when the candidate has actually been silent. This prevents Whisper
// from receiving mid-sentence chunks ("My name is" → fragmented transcript).
// Kept snappy so the agent replies fast — natural end-of-sentence silence is
// ~700–900ms, anything longer makes the AI feel laggy.
const VAD_POLL_INTERVAL_MS = 40;
const VAD_RMS_THRESHOLD = 0.015;     // normalized mic energy above → voice
const VAD_START_RMS_THRESHOLD = 0.020; // slightly higher to arm recording
const VAD_SILENCE_MS = 600;          // silence needed to end an utterance
const VAD_MIN_UTTERANCE_MS = 400;    // min voice duration to bother sending
const VAD_MAX_UTTERANCE_MS = 30000;  // hard cap to avoid runaway blobs

// Short merge window on top of VAD so breath-pauses between clauses get
// concatenated into one coherent answer before it is shipped to the agent.
// Kept tight so the agent receives the answer quickly after the candidate
// stops talking — total perceived latency ≈ VAD_SILENCE_MS + this.
const STT_FINALIZE_SILENCE_MS = 220;
const STT_MIN_FINAL_TEXT_LEN = 2;
const STT_MIN_FINAL_WORDS = 2;
const STT_MIN_FINAL_CHARS = 6;
const AGENT_TTS_FALLBACK_MS = Math.max(0, Number(import.meta.env.VITE_AGENT_TTS_FALLBACK_MS || 45000));

const FILLER_TOKENS = new Set([
  'uh', 'um', 'hmm', 'huh', 'boom', 'hello', 'please', 'ok', 'okay', 'all', 'right', 'yes', 'no', 'i', 'the',
]);

// Phrases that faster-whisper (especially tiny/base models) hallucinates from
// silence, breathing, or background noise. These are NOT real candidate
// answers — drop them before they reach the agent. Match is on the
// normalized (lowercased, punctuation-stripped, single-spaced) form.
const WHISPER_HALLUCINATION_PHRASES = new Set([
  'thank you',
  'thanks',
  'thank you very much',
  'thank you so much',
  'thanks for watching',
  'thanks for watching!',
  'thank you for watching',
  'subtitles by the amara org community',
  "i'll see you in the next video",
  'see you in the next video',
  'bye',
  'bye bye',
  'goodbye',
  "that's it",
  "that's all",
  'okay bye',
  'we are going to come home',
  "we're going to come home",
  'i think it is a good day now',
  "i think it's a good day now",
  "i think it's a good day now it's not a good day",
  'you',
  'yeah',
  'yeah yeah',
  'mm hmm',
  'mhm',
  'uh huh',
  'oh',
  'oh oh',
  'hello hello',
]);

const isWhisperHallucination = (text) => {
  const cleaned = String(text || '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (!cleaned) return true;
  if (WHISPER_HALLUCINATION_PHRASES.has(cleaned)) return true;

  // Repeated single token like "thank you thank you thank you" — common
  // hallucination shape.
  const tokens = cleaned.split(' ');
  if (tokens.length >= 2 && tokens.length <= 12) {
    const unique = new Set(tokens);
    if (unique.size === 1) return true;
    // "thank you" repeated as a 2-gram across the whole string
    if (unique.size === 2 && tokens.length % 2 === 0) {
      const bigram = `${tokens[0]} ${tokens[1]}`;
      if (WHISPER_HALLUCINATION_PHRASES.has(bigram)) {
        const allMatch = tokens.every((tok, i) =>
          tok === (i % 2 === 0 ? tokens[0] : tokens[1]),
        );
        if (allMatch) return true;
      }
    }
  }

  return false;
};

const normalizeForEcho = (s) =>
  String(s || '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

const isLikelyEcho = (sttText, agentText) => {
  const a = normalizeForEcho(sttText);
  const b = normalizeForEcho(agentText);
  if (!a || !b) return false;
  if (b.includes(a) || a.includes(b)) return true;
  const aTokens = new Set(a.split(' '));
  const bTokens = new Set(b.split(' '));
  if (aTokens.size < 3) return false;
  let overlap = 0;
  aTokens.forEach((t) => {
    if (bTokens.has(t)) overlap += 1;
  });
  return overlap / aTokens.size >= 0.7;
};

const hasSentenceEnding = (text) => /[.!?…]\s*$/.test(String(text || '').trim());

const normalizeTranscriptText = (text) =>
  String(text || '')
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/[“”]/g, '"')
    .replaceAll('’', "'")
    .trim();

const stripLeadingTranscriptNoise = (text) =>
  normalizeTranscriptText(text)
    .replace(/^(?:thank you(?: very much)?|thanks|positive|negative|neutral)(?:[.!?,:;\s]+)(?=\S)/i, '')
    .trim();

const collapseRepeatedTokens = (text, maxRepeat = 2) => {
  const tokens = normalizeTranscriptText(text).split(' ');
  if (!tokens.length) return '';

  const out = [];
  let prev = '';
  let repeats = 0;
  for (const tok of tokens) {
    const norm = tok.toLowerCase();
    if (norm === prev) {
      repeats += 1;
    } else {
      prev = norm;
      repeats = 1;
    }
    if (repeats <= maxRepeat) out.push(tok);
  }
  return out.join(' ').trim();
};

const isLowSignalSegment = (text) => {
  const cleaned = normalizeTranscriptText(text).toLowerCase();
  if (!cleaned) return true;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (!words.length) return true;

  const meaningful = words.filter((w) => !FILLER_TOKENS.has(w));
  if (!meaningful.length && words.length <= 3) return true;
  if (words.length <= 2 && meaningful.length <= 1) return true;
  return false;
};

const isGoodFinalTranscript = (text) => {
  const cleaned = normalizeTranscriptText(text);
  if (!cleaned) return false;

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= STT_MIN_FINAL_WORDS) return true;
  if (cleaned.length >= STT_MIN_FINAL_CHARS && hasSentenceEnding(cleaned)) return true;
  return false;
};

const collectSttCustomTerms = (room) => {
  if (!room) return [];

  const bag = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text) bag.push(text);
  };
  const pushMany = (values) => {
    if (!Array.isArray(values)) return;
    values.forEach(push);
  };

  push(room?.job?.title);
  pushMany(room?.job?.skills);
  pushMany(room?.job?.languages);
  push(room?.job?.location);

  push(room?.initiator?.name);
  push(room?.initiator?.domain);
  push(room?.initiator?.enterprise?.name);
  push(room?.initiator?.enterprise?.industry);
  push(room?.initiator?.enterprise?.location);
  push(room?.initiator?.enterprise?.website);
  push(room?.initiator?.profile?.domain);
  pushMany(room?.initiator?.profile?.skills);

  const uniq = [];
  const seen = new Set();
  bag.forEach((term) => {
    const normalized = term.replaceAll(/\s+/g, ' ').trim();
    if (!normalized || normalized.length < 2 || normalized.length > 64) return;
    const lower = normalized.toLowerCase();
    if (seen.has(lower)) return;
    seen.add(lower);
    uniq.push(normalized);
  });

  return uniq.slice(0, 120);
};

const parseTranscriptionPayload = (payload) => {
  // Direct speech-stack payload shape.
  const directText = String(payload?.transcription?.text || '').trim();
  if (directText) {
    return {
      text: directText,
      sentiment: payload?.overall_sentiment || { label: 'NEUTRAL', score: 0 },
    };
  }

  // Backend voice route normalized payload shape.
  const apiText = String(payload?.text || '').trim();
  const sentimentFromSummary = payload?.summary?.sentiment;
  const sentiment = sentimentFromSummary || payload?.overall_sentiment || { label: 'NEUTRAL', score: 0 };

  return {
    text: apiText,
    sentiment,
  };
};

const isTokenExpired = (jwtToken) => {
  if (!jwtToken) return true;

  try {
    const payload = JSON.parse(atob(jwtToken.split('.')[1] || ''));
    if (!payload?.exp) return true;
    return payload.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
};

const CallRoomActive = () => {
  const { roomId } = useParams();
  const [room, setRoom] = useState(null);
  const [roomDbId, setRoomDbId] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isRH, setIsRH] = useState(false);
  const [loading, setLoading] = useState(true);
  const [socketClient, setSocketClient] = useState(null);
  
  const fullRecorderRef = useRef(null);   // single long-running recorder (full call)
  const allAudioChunksRef = useRef([]);   // chunks from the full recorder
  const allMimeTypeRef = useRef('');      // mimeType for the full recording blob
  const streamRef = useRef(null);
  const socketRef = useRef(null);
  const recordingActiveRef = useRef(false);
  const lastTranscriptRef = useRef('');

  // VAD-based utterance recorder (per-utterance, not per-slice)
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const vadTimerRef = useRef(null);
  const utteranceRecorderRef = useRef(null);
  const utteranceChunksRef = useRef([]);
  const utteranceMimeRef = useRef('');
  const utteranceStartedAtRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const isInUtteranceRef = useRef(false);
  const roomDbIdRef = useRef(null);
  const isRHRef = useRef(false);
  const latestAgentTtsRef = useRef(null);
  const activeAgentAudioRef = useRef(null);
  const activeAgentAudioUrlRef = useRef('');
  const latestAgentTtsRequestIdRef = useRef(0);
  const lastAgentVoiceKeyRef = useRef('');
  const agentTtsFallbackTimerRef = useRef(null);
  // When the Streamoji avatar widget reports ready, it stores its imperative
  // actions ({ avatarSpeak, replayAvatarSpeak, ... }) here. While this ref
  // is non-null we route NIM-generated agent text through avatarSpeak()
  // instead of playing ElevenLabs audio — the avatar speaks + lip-syncs.
  const streamojiActionsRef = useRef(null);
  const streamojiSpeakKeyRef = useRef('');

  // STT → Agent auto-send: finalize after N ms of silence
  const lastSttSegmentRef = useRef(null);
  const sttSilenceTimerRef = useRef(null);
  const sttLastSentIdRef = useRef(null); // track sent segments to avoid duplicates
  const sttPendingReplyRef = useRef({
    text: '',
    sentiment: null,
    startedAt: 0,
    updatedAt: 0,
  });
  const introKickoffTimerRef = useRef(null);
  const introKickoffAttemptsRef = useRef(0);
  const introStartRequestedRef = useRef(false);
  const agentSessionReadyRef = useRef(false);
  const agentSpeakingRef = useRef(false);
  const agentThinkingRef = useRef(false); // waiting for agent reply after we sent candidate-turn
  const lastAgentTextRef = useRef('');
  const recentAgentTextsRef = useRef([]); // rolling window for echo filtering
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [agentThinking, setAgentThinking] = useState(false);
  const [draftText, setDraftText] = useState(''); // live in-progress STT for chat bubble

  const clearIntroKickoffRetry = () => {
    if (introKickoffTimerRef.current) {
      clearTimeout(introKickoffTimerRef.current);
      introKickoffTimerRef.current = null;
    }
    introKickoffAttemptsRef.current = 0;
  };

  const tryStartAgentIntro = ({ force = false, prepare = false } = {}) => {
    if (isRHRef.current || agentSessionReadyRef.current || !roomDbIdRef.current) return;
    if (introStartRequestedRef.current) return;
    if (!force && !prepare && !recordingActiveRef.current) return;

    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      if (introKickoffAttemptsRef.current >= 6 || (!prepare && !recordingActiveRef.current)) return;
      if (introKickoffTimerRef.current) return;
      introKickoffTimerRef.current = setTimeout(() => {
        introKickoffTimerRef.current = null;
        introKickoffAttemptsRef.current += 1;
        tryStartAgentIntro({ prepare });
      }, 700);
      return;
    }

    clearIntroKickoffRetry();
    introStartRequestedRef.current = true;
    console.log(prepare ? 'Preparing interview intro voice' : 'Requesting interview intro from candidate start');
    socket.emit('agent:start-session', {
      roomId,
      roomDbId: roomDbIdRef.current,
      phase: 'intro',
      prepareTts: prepare,
    });
  };

  const setMicEnabled = (enabled) => {
    const stream = streamRef.current;
    if (!stream) return;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = enabled;
    });
  };

  const token = localStorage.getItem('token');
  const userId = localStorage.getItem('userId');

  const emitAgentThinkingState = (thinking) => {
    globalThis.dispatchEvent(
      new CustomEvent('agent-thinking', { detail: { thinking } }),
    );
  };

  const emitAgentSpeechState = (speaking, text = '', extras = {}) => {
    globalThis.dispatchEvent(
      new CustomEvent('agent-speech', {
        detail: { speaking, text, ...extras },
      }),
    );
  };

  const stopAgentAudioPlayback = ({ emitStopped = false } = {}) => {
    const activeAudio = activeAgentAudioRef.current;
    if (activeAudio) {
      activeAudio.onended = null;
      activeAudio.onerror = null;
      try {
        activeAudio.pause();
        activeAudio.currentTime = 0;
      } catch (_) {
        // Ignore playback cleanup failures.
      }
      activeAgentAudioRef.current = null;
    }

    if (activeAgentAudioUrlRef.current) {
      URL.revokeObjectURL(activeAgentAudioUrlRef.current);
      activeAgentAudioUrlRef.current = '';
    }

    if (emitStopped) {
      emitAgentSpeechState(false);
    }
  };

  const clearAgentTtsFallback = () => {
    if (agentTtsFallbackTimerRef.current) {
      clearTimeout(agentTtsFallbackTimerRef.current);
      agentTtsFallbackTimerRef.current = null;
    }
  };

  const playAgentAudioBlob = async (blob, text, { announceStart = false } = {}) => {
    if (!(blob instanceof Blob) || blob.size <= 0) {
      return false;
    }

    stopAgentAudioPlayback();

    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    audio.preload = 'auto';
    activeAgentAudioRef.current = audio;
    activeAgentAudioUrlRef.current = objectUrl;

    // Wait briefly for the audio metadata so we can pass the real duration
    // to the avatar — the lipsync engine uses it to time visemes against
    // the audio, so without it visemes get distributed against an estimate
    // and the mouth/audio drift apart for longer answers.
    const announceWithDuration = () => {
      if (!announceStart) return;
      const audioMs = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration * 1000
        : 0;
      emitAgentSpeechState(true, text, audioMs ? { durationMs: audioMs } : {});
    };

    if (announceStart) {
      // If metadata is already available, announce now; otherwise wait once
      // for `loadedmetadata`. Cap the wait at 250 ms so a stuck/missing
      // metadata event never blocks the avatar from animating at all.
      if (audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0) {
        announceWithDuration();
      } else {
        let announced = false;
        const announceOnce = () => {
          if (announced) return;
          announced = true;
          announceWithDuration();
        };
        audio.addEventListener('loadedmetadata', announceOnce, { once: true });
        setTimeout(announceOnce, 250);
      }
    }

    return new Promise((resolve) => {
      let settled = false;

      const finish = () => {
        if (activeAgentAudioRef.current === audio) {
          activeAgentAudioRef.current = null;
        }
        if (activeAgentAudioUrlRef.current === objectUrl) {
          URL.revokeObjectURL(objectUrl);
          activeAgentAudioUrlRef.current = '';
        }
        emitAgentSpeechState(false);
        if (!settled) {
          settled = true;
          resolve(true);
        }
      };

      audio.onended = finish;
      audio.onerror = () => {
        console.warn('Agent TTS playback failed');
        finish();
      };

      audio.play().catch((error) => {
        console.warn('Unable to autoplay agent TTS audio:', error);
        finish();
      });
    });
  };

  const fetchAgentTtsAudio = async (text) => {
    const body = JSON.stringify({
      text,
      language: 'en',
    });

    try {
      const response = await fetch(`${SPEECH_STACK_URL}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`direct speech stack ${response.status}: ${errText}`);
      }

      return await response.blob();
    } catch (directError) {
      console.warn(
        'Direct Speech Stack TTS unavailable, falling back to backend /api/voice/tts:',
        directError?.message || directError,
      );

      const fallbackResponse = await fetch(`${VOICE_API_URL}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!fallbackResponse.ok) {
        const fallbackErr = await fallbackResponse.text();
        throw new Error(`voice backend ${fallbackResponse.status}: ${fallbackErr}`);
      }

      return await fallbackResponse.blob();
    }
  };

  const requestAgentTtsPlayback = async (text, voiceKey = '') => {
    const normalizedText = String(text || '').trim();
    if (!normalizedText || isRHRef.current) return;

    const requestId = Date.now() + Math.random();
    latestAgentTtsRequestIdRef.current = requestId;
    if (voiceKey) {
      lastAgentVoiceKeyRef.current = voiceKey;
    }

    stopAgentAudioPlayback();

    try {
      const blob = await fetchAgentTtsAudio(normalizedText);
      if (requestId !== latestAgentTtsRequestIdRef.current) {
        return;
      }

      latestAgentTtsRef.current = {
        blob,
        text: normalizedText,
        createdAt: Date.now(),
      };
      await playAgentAudioBlob(blob, normalizedText, { announceStart: true });
    } catch (error) {
      if (requestId !== latestAgentTtsRequestIdRef.current) {
        return;
      }

      latestAgentTtsRef.current = null;
      emitAgentSpeechState(false);
      console.error('Failed to generate ElevenLabs audio for agent message:', error);
    }
  };

  const playPreparedAgentTts = async () => {
    const latest = latestAgentTtsRef.current;
    if (!latest?.blob || isRHRef.current) return false;
    // Streamoji owns the voice when its widget is up — don't replay
    // a stale ElevenLabs blob on top of Streamoji's TTS.
    if (streamojiActionsRef.current?.avatarSpeak) return false;
    await playAgentAudioBlob(latest.blob, latest.text || room?.currentQuestion || '', { announceStart: true });
    return true;
  };

  useEffect(() => {
    latestAgentTtsRequestIdRef.current += 1;
    lastAgentVoiceKeyRef.current = '';
    latestAgentTtsRef.current = null;
    clearAgentTtsFallback();
    stopAgentAudioPlayback({ emitStopped: true });
  }, [roomId]);

  // Fetch room details
  useEffect(() => {
    const fetchRoom = async () => {
      try {
        const response = await fetch(`${API_BASE}/api/call-rooms/by-room/${encodeURIComponent(roomId)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        if (data.success && data.room) {
          setRoom(data.room);
          setRoomDbId(data.room._id);
          setIsRH(data.room.initiator?._id === userId);
        } else {
          console.warn('Room not found or invalid response:', data);
        }
      } catch (error) {
        console.error('Failed to fetch room:', error);
      } finally {
        setLoading(false);
      }
    };

    if (roomId && token && userId) {
      fetchRoom();
    } else {
      setLoading(false);
    }
  }, [roomId, token, userId]);

  // Set up Socket.IO
  useEffect(() => {
    roomDbIdRef.current = roomDbId;
  }, [roomDbId]);

  useEffect(() => {
    isRHRef.current = isRH;
  }, [isRH]);

  useEffect(() => {
    if (isRH || !roomDbId || !socketClient?.connected) return;
    tryStartAgentIntro({ prepare: true });
  }, [isRH, roomDbId, socketClient]);

  // Capture Streamoji's imperative actions when its widget reports ready,
  // and clear them on teardown. While streamojiActionsRef is non-null,
  // handleAgentMessage routes NIM-generated text through avatarSpeak()
  // instead of triggering ElevenLabs playback — Streamoji owns the voice.
  useEffect(() => {
    if (globalThis.__streamojiActions) {
      streamojiActionsRef.current = globalThis.__streamojiActions;
    }
    const onReady = (ev) => {
      streamojiActionsRef.current = ev.detail || null;
    };
    const onTeardown = () => {
      streamojiActionsRef.current = null;
    };
    globalThis.addEventListener('streamoji:ready', onReady);
    globalThis.addEventListener('streamoji:teardown', onTeardown);
    return () => {
      globalThis.removeEventListener('streamoji:ready', onReady);
      globalThis.removeEventListener('streamoji:teardown', onTeardown);
    };
  }, []);

  useEffect(() => {
    if (!token || isTokenExpired(token)) {
      return undefined;
    }

    socketRef.current = io(API_BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 1200,
    });
    setSocketClient(socketRef.current);

    socketRef.current.on('connect_error', (error) => {
      if (error?.message === 'TOKEN_EXPIRED') {
        console.warn('Socket session expired in active room. Please login again.');
        socketRef.current?.disconnect();
      }
    });
    socketRef.current.on('connect', () => {
      tryStartAgentIntro({ prepare: true });
    });

    // Join room-specific channel
    socketRef.current.emit('join-room', { roomId });

    // Listen for transcription updates — auto-send finalized segments to agent after silence
    const handleTranscriptionUpdate = ({ segment, sentiment }) => {
      if (!segment?.text) return;

      // Drop Whisper hallucinations from the RH dashboard feed too so the
      // recruiter doesn't see "Thank you." / "That's it." spam from silence.
      if (isWhisperHallucination(segment.text)) {
        return;
      }

      if (isRHRef.current) {
        setRoom((prev) => {
          if (!prev) return prev;

          const nextSegments = [...(prev.transcription?.segments || []), segment];
          const nextText = `${prev.transcription?.text || ''} ${String(segment.text || '').trim()}`.trim();

          return {
            ...prev,
            transcription: {
              ...prev.transcription,
              text: nextText,
              segments: nextSegments,
              overallSentiment: sentiment || prev.transcription?.overallSentiment || { label: 'NEUTRAL', score: 0 },
            },
          };
        });
        return;
      }

      const nextText = stripLeadingTranscriptNoise(collapseRepeatedTokens(String(segment.text || '').trim()));
      if (!nextText) return;
      if (isLowSignalSegment(nextText)) {
        return;
      }

      // Drop common Whisper hallucinations ("Thank you.", "That's it.", "We're
      // going to come home.", etc.) before they ever reach the agent. tiny/base
      // models emit these from silence + room noise; treating them as real
      // candidate answers throws the conversation off the rails.
      if (isWhisperHallucination(nextText)) {
        console.log('🔇 Dropping Whisper hallucination:', nextText);
        return;
      }

      // Drop segments captured while the AI is speaking or mid-generation —
      // otherwise its own TTS voice feeds back through the mic and gets sent
      // as the "answer", or our in-flight turn collides with a new one.
      if (agentSpeakingRef.current || agentThinkingRef.current) {
        console.log('🔇 Dropping STT segment — agent busy (speaking/thinking)');
        return;
      }
      // Compare against a rolling window of the last 3 agent messages, not
      // just the most recent one, so late-arriving TTS chunks are still
      // filtered out after the agent has already moved to the next question.
      const agentPool = recentAgentTextsRef.current;
      if (agentPool.some((a) => isLikelyEcho(nextText, a))) {
        console.log('🔇 Dropping echoed agent speech:', nextText);
        return;
      }

      const pending = sttPendingReplyRef.current;
      let mergedText = nextText;
      if (pending.text) {
        mergedText = nextText.includes(pending.text) ? nextText : `${pending.text} ${nextText}`;
      }
      const normalizedMerged = normalizeTranscriptText(collapseRepeatedTokens(mergedText));
      if (!normalizedMerged) return;

      console.log('STT segment:', nextText);
      const now = Date.now();
      lastSttSegmentRef.current = { text: normalizedMerged, sentiment, timestamp: now };
      sttPendingReplyRef.current = {
        text: normalizedMerged,
        sentiment: sentiment || pending.sentiment || null,
        startedAt: pending.startedAt || now,
        updatedAt: now,
      };

      // Update the live draft bubble visible in the chat panel — local event
      // for the candidate view, socket broadcast for the RH dashboard.
      setDraftText(normalizedMerged);
      globalThis.dispatchEvent(
        new CustomEvent('candidate-draft-update', {
          detail: { text: normalizedMerged, sentiment },
        }),
      );
      socketRef.current?.emit('candidate:draft', {
        roomId,
        roomDbId: roomDbIdRef.current,
        text: normalizedMerged,
      });

      // Reset silence timer: finalize only after a longer pause so the candidate can finish speaking.
      if (sttSilenceTimerRef.current) clearTimeout(sttSilenceTimerRef.current);
      sttSilenceTimerRef.current = setTimeout(() => {
        const current = sttPendingReplyRef.current;
        if (!current || !roomDbIdRef.current) return;

        const finalText = stripLeadingTranscriptNoise(
          normalizeTranscriptText(collapseRepeatedTokens(String(current.text || ''))),
        );
        if (finalText.length < STT_MIN_FINAL_TEXT_LEN) return;

        if (!isGoodFinalTranscript(finalText)) {
          return;
        }

        // Whisper doesn't always emit terminal punctuation. Finalize on
        // silence alone — the silence timer already waited STT_FINALIZE_SILENCE_MS.

        // Avoid sending the same segment twice
        const segmentId = finalText.toLowerCase();
        if (sttLastSentIdRef.current === segmentId) return;

        console.log('🎤 Auto-sending STT segment to agent:', finalText);
        // Clear draft before forwarding finalized candidate text.
        setDraftText('');
        globalThis.dispatchEvent(
          new CustomEvent('candidate-draft-update', { detail: { text: '', sentiment: null } }),
        );
        socketRef.current?.emit('candidate:draft', {
          roomId,
          roomDbId: roomDbIdRef.current,
          text: '',
        });
        // Always surface the candidate's speech as a real chat bubble — even
        // if the agent session isn't live yet. This is the proof the STT
        // pipeline caught what they said.
        globalThis.dispatchEvent(
          new CustomEvent('candidate-local-message', {
            detail: { text: finalText, sentiment: current.sentiment, ts: Date.now() },
          }),
        );
        if (!agentSessionReadyRef.current) {
          console.log('⏸ Agent session not ready — bubble shown, not forwarding to LLM yet');
          sttLastSentIdRef.current = segmentId;
          sttPendingReplyRef.current = { text: '', sentiment: null, startedAt: 0, updatedAt: 0 };
          return;
        }
        // Lock the turn until the agent replies — mute mic + block new sends.
        agentThinkingRef.current = true;
        setAgentThinking(true);
        emitAgentThinkingState(true);
        setMicEnabled(false);
        socketRef.current?.emit('agent:candidate-turn', {
          roomId,
          roomDbId: roomDbIdRef.current,
          text: finalText,
          sentiment: current.sentiment,
          source: 'voice',
        });
        sttLastSentIdRef.current = segmentId;
        sttPendingReplyRef.current = {
          text: '',
          sentiment: null,
          startedAt: 0,
          updatedAt: 0,
        };
      }, STT_FINALIZE_SILENCE_MS);
    };

    socketRef.current.on('transcription-update', handleTranscriptionUpdate);

    // Listen for agent messages — update room state for candidate view
    const handleAgentMessage = ({ text, skillFocus, difficulty, phase, turnIndex }) => {
      agentSessionReadyRef.current = true;
      clearIntroKickoffRetry();
      agentThinkingRef.current = false; // agent has replied — unlock on TTS end
      setAgentThinking(false);
      emitAgentThinkingState(false);
      lastAgentTextRef.current = text || '';
      if (text) {
        recentAgentTextsRef.current = [text, ...recentAgentTextsRef.current].slice(0, 3);
      }
      // Drop anything captured while the agent was composing its reply so
      // the next STT segment can't contain mixed audio.
      if (sttSilenceTimerRef.current) {
        clearTimeout(sttSilenceTimerRef.current);
        sttSilenceTimerRef.current = null;
      }
      sttPendingReplyRef.current = { text: '', sentiment: null, startedAt: 0, updatedAt: 0 };
      console.log('🤖 Agent message received:', text);

      const normalizedText = String(text || '').trim();
      if (!isRHRef.current && normalizedText) {
        const voiceKey = `${String(roomDbIdRef.current || roomId || '').trim()}::${turnIndex ?? 'na'}::${normalizedText}`;
        lastAgentVoiceKeyRef.current = voiceKey;
        clearAgentTtsFallback();

        // If Streamoji's avatar widget is mounted + ready, route the agent's
        // text through avatarSpeak() so the avatar speaks AND lip-syncs the
        // words. We bypass the ElevenLabs path entirely while Streamoji is
        // the voice — otherwise both would try to play the same answer.
        const streamojiSpeak = streamojiActionsRef.current?.avatarSpeak;
        if (streamojiSpeak) {
          // Stop any in-flight ElevenLabs playback from a prior turn, just
          // in case agent:tts arrives between turns.
          stopAgentAudioPlayback({ emitStopped: false });
          streamojiSpeakKeyRef.current = voiceKey;
          emitAgentSpeechState(true, normalizedText);
          Promise.resolve(streamojiSpeak(normalizedText))
            .catch((err) => console.warn('Streamoji avatarSpeak failed:', err))
            .finally(() => {
              if (streamojiSpeakKeyRef.current === voiceKey) {
                emitAgentSpeechState(false);
              }
            });
        } else if (AGENT_TTS_FALLBACK_MS > 0) {
          // No Streamoji — fall back to backend ElevenLabs (via agent:tts)
          // with a delayed direct-fetch as last resort.
          agentTtsFallbackTimerRef.current = setTimeout(() => {
            if (lastAgentVoiceKeyRef.current === voiceKey) {
              void requestAgentTtsPlayback(normalizedText, voiceKey);
            }
          }, AGENT_TTS_FALLBACK_MS);
        }
      }

      setRoom(prev =>
        prev
          ? {
              ...prev,
              currentQuestion: text,
              currentSkill: skillFocus,
              currentDifficulty: difficulty,
              phase
            }
          : null
      );
    };
    socketRef.current.on('agent:message', handleAgentMessage);

    const handleAgentTts = (payload) => {
      if (payload?.roomId && payload.roomId !== roomId) return;
      if (isRHRef.current) return;
      // Streamoji owns the voice when its widget is mounted and ready —
      // ignore the backend's ElevenLabs push so we don't get two voices.
      if (streamojiActionsRef.current?.avatarSpeak) return;

      const spokenText = String(payload?.text || '').trim();
      const sourceText = String(payload?.sourceText || payload?.text || '').trim();
      if (!spokenText || !payload?.audioBase64) return;

      const voiceKey = `${String(roomDbIdRef.current || roomId || '').trim()}::${payload?.turnIndex ?? 'na'}::${sourceText || spokenText}`;
      if (lastAgentVoiceKeyRef.current && lastAgentVoiceKeyRef.current !== voiceKey) {
        return;
      }

      clearAgentTtsFallback();

      try {
        const binary = globalThis.atob(payload.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }

        const blob = new Blob([bytes], { type: payload.contentType || 'audio/wav' });
        latestAgentTtsRef.current = {
          blob,
          text: spokenText,
          sourceText,
          createdAt: Date.now(),
        };
        if (recordingActiveRef.current) {
          void playAgentAudioBlob(blob, spokenText, { announceStart: true });
        }
      } catch (error) {
        console.error('Failed to play backend ElevenLabs audio:', error);
        void requestAgentTtsPlayback(sourceText || spokenText, voiceKey);
      }
    };
    socketRef.current.on('agent:tts', handleAgentTts);

    // Recover from a failed turn: NIM occasionally returns 502/timeout. When
    // that happens, agentThinkingRef would otherwise stay true forever and
    // every subsequent STT segment would be dropped (mic stuck muted, the
    // interview "stops"). Reset the thinking lock and re-enable the mic so
    // the candidate can simply try again.
    const handleAgentError = (payload) => {
      console.warn('🟥 agent:error received — clearing thinking lock:', payload?.message);
      agentThinkingRef.current = false;
      setAgentThinking(false);
      emitAgentThinkingState(false);
      if (recordingActiveRef.current && !agentSpeakingRef.current) {
        setMicEnabled(true);
      }
    };
    socketRef.current.on('agent:error', handleAgentError);

    // Candidate-side: AgentChatPanel emits 'agent-speech' around each TTS
    // utterance. We mute STT while the agent is speaking so the AI's own
    // voice doesn't feed back as the candidate's answer.
    const handleAgentSpeech = (ev) => {
      const speaking = !!ev?.detail?.speaking;
      agentSpeakingRef.current = speaking;
      setAgentSpeaking(speaking);
      // Physically mute the mic track, not just a flag — prevents the TTS
      // from being captured and then transcribed as the candidate's answer.
      setMicEnabled(!speaking && !agentThinkingRef.current);
      if (speaking) {
        if (sttSilenceTimerRef.current) {
          clearTimeout(sttSilenceTimerRef.current);
          sttSilenceTimerRef.current = null;
        }
        sttPendingReplyRef.current = { text: '', sentiment: null, startedAt: 0, updatedAt: 0 };
      }
    };
    globalThis.addEventListener('agent-speech', handleAgentSpeech);

    // Listen for call end
    socketRef.current.on('call-room-ended', () => {
      alert('Call ended by other party');
      // Redirect or close
    });

    return () => {
      recordingActiveRef.current = false;
      latestAgentTtsRequestIdRef.current += 1;
      lastAgentVoiceKeyRef.current = '';
      latestAgentTtsRef.current = null;
      clearAgentTtsFallback();
      stopAgentAudioPlayback({ emitStopped: true });
      if (sttSilenceTimerRef.current) {
        clearTimeout(sttSilenceTimerRef.current);
        sttSilenceTimerRef.current = null;
      }
      clearIntroKickoffRetry();
      introStartRequestedRef.current = false;
      sttPendingReplyRef.current = {
        text: '',
        sentiment: null,
        startedAt: 0,
        updatedAt: 0,
      };
      agentSessionReadyRef.current = false;
      stopVad();
      if (fullRecorderRef.current?.state === 'recording') {
        fullRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach(track => track.stop());
      globalThis.removeEventListener('agent-speech', handleAgentSpeech);
      socketRef.current?.off('transcription-update');
      socketRef.current?.off('agent:message');
      socketRef.current?.off('agent:tts');
      socketRef.current?.off('agent:error');
      socketRef.current?.off('call-room-ended');
      socketRef.current?.off('connect');
      socketRef.current?.disconnect();
      socketRef.current?.off('connect_error');
      socketRef.current?.off('transcription-update', handleTranscriptionUpdate);
      socketRef.current?.off('agent:tts', handleAgentTts);
      socketRef.current?.disconnect();
      setSocketClient(null);
    };
  }, [roomId, token]);

  const stopMicrophoneStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
  };

  const getRecorderMimeType = () => {
    const preferredTypes = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/webm',
      'audio/ogg',
    ];
    return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) || '';
  };

  const startUtteranceRecorder = () => {
    if (!streamRef.current || !recordingActiveRef.current) return;

    const mimeType = getRecorderMimeType();
    utteranceMimeRef.current = mimeType || 'audio/webm';
    const recorder = mimeType
      ? new MediaRecorder(streamRef.current, { mimeType })
      : new MediaRecorder(streamRef.current);

    utteranceChunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        utteranceChunksRef.current.push(event.data);
      }
    };

    recorder.onstop = async () => {
      const blob = new Blob(utteranceChunksRef.current, {
        type: utteranceMimeRef.current || 'audio/webm',
      });
      utteranceChunksRef.current = [];
      if (blob.size >= MIN_AUDIO_BLOB_BYTES) {
        await sendAudioToSpeechStack(blob);
      }
    };

    utteranceRecorderRef.current = recorder;
    // request small timeslices so we capture audio continuously even if the
    // utterance is long — MediaRecorder still produces a single valid blob.
    recorder.start(250);
  };

  const stopUtteranceRecorder = () => {
    const recorder = utteranceRecorderRef.current;
    utteranceRecorderRef.current = null;
    if (recorder && recorder.state === 'recording') {
      try { recorder.stop(); } catch (err) { console.warn('utterance stop failed', err); }
    }
  };

  const vadTick = () => {
    if (!recordingActiveRef.current) return;
    const analyser = analyserRef.current;
    if (!analyser) return;

    // Don't arm a new utterance while the AI is speaking or composing — its
    // TTS would be captured and misread as the candidate's answer.
    const gated = agentSpeakingRef.current || agentThinkingRef.current;

    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / buf.length);

    const now = Date.now();

    if (!isInUtteranceRef.current) {
      if (!gated && rms >= VAD_START_RMS_THRESHOLD) {
        isInUtteranceRef.current = true;
        utteranceStartedAtRef.current = now;
        lastVoiceAtRef.current = now;
        startUtteranceRecorder();
      }
    } else {
      if (rms >= VAD_RMS_THRESHOLD) {
        lastVoiceAtRef.current = now;
      }
      const silenceFor = now - lastVoiceAtRef.current;
      const utteranceLen = now - utteranceStartedAtRef.current;

      const endBySilence = silenceFor >= VAD_SILENCE_MS && utteranceLen >= VAD_MIN_UTTERANCE_MS;
      const endByCap = utteranceLen >= VAD_MAX_UTTERANCE_MS;
      const endByGate = gated && utteranceLen >= VAD_MIN_UTTERANCE_MS;

      if (endBySilence || endByCap || endByGate) {
        isInUtteranceRef.current = false;
        stopUtteranceRecorder();
      }
    }

    vadTimerRef.current = setTimeout(vadTick, VAD_POLL_INTERVAL_MS);
  };

  const startVad = () => {
    if (!streamRef.current || vadTimerRef.current) return;

    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) {
      console.warn('Web Audio API unavailable; falling back to single continuous recorder');
      // Fallback: start one long recorder so we still capture something.
      startUtteranceRecorder();
      return;
    }

    const audioContext = new AudioCtx();
    const source = audioContext.createMediaStreamSource(streamRef.current);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);

    audioContextRef.current = audioContext;
    analyserRef.current = analyser;
    isInUtteranceRef.current = false;
    utteranceStartedAtRef.current = 0;
    lastVoiceAtRef.current = 0;

    vadTimerRef.current = setTimeout(vadTick, VAD_POLL_INTERVAL_MS);
  };

  const stopVad = () => {
    if (vadTimerRef.current) {
      clearTimeout(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    stopUtteranceRecorder();
    if (audioContextRef.current) {
      try { audioContextRef.current.close(); } catch (err) { /* noop */ }
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    isInUtteranceRef.current = false;
  };

  // Start audio recording
  const startRecording = async () => {
    try {
      if (recordingActiveRef.current) {
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48000,
          sampleSize: 16,
        },
      });
      streamRef.current = stream;
      recordingActiveRef.current = true;
      lastTranscriptRef.current = '';

      // ── Full-call recorder (one continuous session = valid single WebM) ──
      const mimeType = getRecorderMimeType();
      allMimeTypeRef.current = mimeType || 'audio/webm';
      allAudioChunksRef.current = [];

      const fullRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      fullRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          allAudioChunksRef.current.push(event.data);
        }
      };
      fullRecorderRef.current = fullRecorder;
      fullRecorder.start();   // no timeslice → one big blob on stop()

      // ── VAD-driven per-utterance recorder for transcription ────────────
      startVad();
      setIsRecording(true);

      void playPreparedAgentTts();

      // Candidate-initiated fallback: if the interviewer voice was not ready
      // from preloading, kick it off now and play when it arrives.
      tryStartAgentIntro({ force: true });
    } catch (error) {
      console.error('Failed to start recording:', error);
      alert('Failed to access microphone');
    }
  };

  const stopRecording = () => {
    recordingActiveRef.current = false;

    stopVad();
    stopMicrophoneStream();

    // Stop the full-call recorder — triggers ondataavailable then onstop
    if (fullRecorderRef.current?.state === 'recording') {
      fullRecorderRef.current.stop();
    }

    clearIntroKickoffRetry();

    setIsRecording(false);
  };

  // Resolves once the full-call recorder's onstop fires (data is ready)
  const waitForFullRecording = () =>
    new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };

      const rec = fullRecorderRef.current;
      if (!rec || rec.state === 'inactive') { done(); return; }

      rec.addEventListener('stop', done, { once: true });
      setTimeout(done, 8000); // safety fallback
    });

  const sendAudioToSpeechStack = async (audioBlob) => {
    try {
      const formData = new FormData();
      const ext = audioBlob.type.includes('ogg') ? 'ogg' : 'webm';
      formData.append('audio', audioBlob, `recording.${ext}`);
      const customTerms = collectSttCustomTerms(room);
      if (customTerms.length) {
        formData.append('custom_terms', JSON.stringify(customTerms));
      }

      let data = null;
      let text = '';
      let sentiment;

      // Primary path: direct Speech Stack API.
      try {
        const response = await fetch(`${SPEECH_STACK_URL}/api/transcribe-sentiment`, {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`direct speech stack ${response.status}: ${errText}`);
        }

        data = await response.json();
      } catch (directError) {
        // Fallback path: backend voice route (works even when :8012 is down).
        console.warn('Direct Speech Stack unavailable, falling back to backend /api/voice/transcribe:', directError?.message || directError);
        const fallbackResponse = await fetch(`${VOICE_API_URL}/transcribe`, {
          method: 'POST',
          body: formData,
        });

        if (!fallbackResponse.ok) {
          const fallbackErr = await fallbackResponse.text();
          console.error('Voice fallback request failed:', fallbackResponse.status, fallbackErr);
          return;
        }

        data = await fallbackResponse.json();
      }

      const parsed = parseTranscriptionPayload(data);
      text = parsed.text;
      sentiment = parsed.sentiment;

      if (text && roomDbId) {
        lastTranscriptRef.current = text;

        // Send transcription to backend
        await fetch(`${API_BASE}/api/call-rooms/${roomDbId}/update-transcription`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            segment: { text, timestamp: new Date() },
            sentiment
          })
        });

        // Emit via socket
        socketRef.current?.emit('update-call-transcription', {
          roomId,
          roomDbId,
          segment: { text, timestamp: new Date() },
          sentiment
        });
      }
    } catch (error) {
      console.error('Failed to send audio to Speech Stack:', error);
    }
  };

  const uploadRecording = async (dbId) => {
    if (!allAudioChunksRef.current.length) return;
    try {
      const mimeType = allMimeTypeRef.current || 'audio/webm';
      const ext = mimeType.includes('ogg') ? 'ogg' : 'webm';
      const fullBlob = new Blob(allAudioChunksRef.current, { type: mimeType });
      const formData = new FormData();
      formData.append('audio', fullBlob, `recording.${ext}`);
      await fetch(`${API_BASE}/api/call-rooms/${dbId}/upload-audio`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });
    } catch (error) {
      console.error('Failed to upload recording:', error);
    }
  };

  const endCall = async () => {
    try {
      // Stop both recorders, then wait until the full-call recorder has
      // flushed its data (ondataavailable + onstop) before we upload.
      if (recordingActiveRef.current || fullRecorderRef.current?.state === 'recording') {
        stopRecording();
        await waitForFullRecording();
      }

      const response = await fetch(`${API_BASE}/api/call-rooms/${roomDbId}/end-call`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      const data = await response.json();
      if (data.success) {
        // allAudioChunksRef is fully populated now — upload in background
        uploadRecording(roomDbId);
        socketRef.current?.emit('end-call-room', { roomId, roomDbId });
        alert('Call ended');
        globalThis.history.back();
      }
    } catch (error) {
      console.error('Failed to end call:', error);
    }
  };

  if (loading) {
    return (
      <PublicLayout>
        <div className="loading">Loading call room...</div>
      </PublicLayout>
    );
  }

  return (
    <PublicLayout>
      <div className="call-room-active">
        <div className="call-header">
          <h1>Interview Call - {room?.roomId}</h1>
          <div className="call-info">
            <span className="badge-recording">🔴 Recording</span>
            <span className="call-duration">Duration: {room?.recordingStartedAt ? Math.round((new Date() - new Date(room.recordingStartedAt)) / 1000) : 0}s</span>
          </div>
        </div>

        <div className="call-container">
          {!isRH && (
            <div className="streamoji-widget-layer" aria-label="AI interviewer avatar">
              <StreamojiAvatarWrapper />
            </div>
          )}

          {/* Audio Controls — prominent recording button */}
          <div className="audio-section">
            <div className="microphone-indicator">
              <div className={`indicator-dot ${isRecording ? 'recording' : ''}`}></div>
              {isRecording ? 'Microphone Active' : 'Microphone Off'}
            </div>

            <div className="control-buttons">
              {!isRecording ? (
                <button className="btn-start-recording" onClick={startRecording}>
                  🎤 Start Recording
                </button>
              ) : (
                <button className="btn-stop-recording" onClick={stopRecording}>
                  ⏹ Stop Recording
                </button>
              )}

              <button className="btn-end-call" onClick={endCall} disabled={!roomDbId}>
                📞 End Call
              </button>
            </div>
          </div>

          {/* Adaptive AI interviewer panel — visible to both RH and candidate — BELOW RECORDING BUTTON */}
          {roomDbId && (
            <div className="agent-panel-wrapper" style={{ margin: '16px 0' }}>
              <AgentChatPanel
                socket={socketClient}
                roomId={roomId}
                roomDbId={roomDbId}
                isRH={isRH}
                candidateDraftText={!isRH ? draftText : null}
              />
            </div>
          )}

          {/* RH Dashboard - Transcription View */}
          {isRH && (
            <div className="rh-dashboard">
              <div className="dashboard-header">
                <h2>Interview Dashboard</h2>
                <span className="candidate-info">
                  Candidate: {room?.candidate?.email}
                </span>
              </div>

              <div className="transcription-panel">
                <h3>Live Transcription & Sentiment</h3>
                <div className="transcription-feed">
                  {room?.transcription?.segments?.length === 0 ? (
                    <p className="placeholder">Waiting for audio...</p>
                  ) : (
                    room?.transcription?.segments?.map((segment, idx) => (
                      <div key={idx} className="transcript-item">
                        <span className="segment-text">{segment.text}</span>
                        <span
                          className="segment-sentiment"
                          style={{
                            backgroundColor: segment.sentiment?.label === 'POSITIVE' ? '#4CAF50' :
                                           segment.sentiment?.label === 'NEGATIVE' ? '#f44336' : '#9E9E9E'
                          }}
                        >
                          {segment.sentiment?.label}
                        </span>
                        <span className="segment-time">
                          {new Date(segment.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    ))
                  )}
                </div>

                {room?.transcription?.overallSentiment && (
                  <div className="overall-sentiment">
                    <p><strong>Overall Sentiment:</strong></p>
                    <div
                      className="sentiment-badge"
                      style={{
                        backgroundColor: room.transcription.overallSentiment.label === 'POSITIVE' ? '#4CAF50' :
                                       room.transcription.overallSentiment.label === 'NEGATIVE' ? '#f44336' : '#9E9E9E'
                      }}
                    >
                      {room.transcription.overallSentiment.label} ({(room.transcription.overallSentiment.score || 0).toFixed(2)})
                    </div>
                  </div>
                )}

                {room?.transcription?.text && (
                  <div className="full-transcript">
                    <p><strong>Full Transcript:</strong></p>
                    <textarea readOnly value={room.transcription.text} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Candidate View — messenger-style status bar */}
          {!isRH && (
            <div className="candidate-view candidate-view--messenger" style={{ position: 'relative' }}>
              <div
                className="messenger-statusbar"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '10px 14px',
                  background: agentSpeaking
                    ? '#eff6ff'
                    : agentThinking
                    ? '#fef3c7'
                    : isRecording
                    ? '#ecfdf5'
                    : '#f1f5f9',
                  border: '1px solid #e2e8f0',
                  borderRadius: 10,
                  marginTop: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      background: agentSpeaking
                        ? '#3b82f6'
                        : agentThinking
                        ? '#f59e0b'
                        : isRecording
                        ? '#10b981'
                        : '#94a3b8',
                      boxShadow: isRecording || agentSpeaking ? '0 0 0 4px rgba(59,130,246,0.15)' : 'none',
                    }}
                  />
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#1e293b' }}>
                    {agentSpeaking
                      ? '🤖 AI is speaking — please listen'
                      : isRecording
                      ? '🎤 Listening — speak naturally, pause ~5s when done'
                      : '👆 Click "🎤 Start Recording" to begin'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </PublicLayout>
  );
};

export default CallRoomActive;
