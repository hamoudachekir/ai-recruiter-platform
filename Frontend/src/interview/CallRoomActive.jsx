import { useEffect, useState, useRef } from 'react';
import AgentChatPanel from './AgentChatPanel';
import InterviewAvatar from './InterviewAvatar';
import VisionMonitor from './VisionMonitor';
import { useParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import useIntegrityEvents from './hooks/useIntegrityEvents';
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
// faster-whisper avg_logprob is per-token mean log probability. Empirically:
// real candidate speech sits ~ -0.30 to -0.80; hallucinations from silence/
// breath cluster around -1.2 and below. -1.0 is the safe drop floor.
const STT_MIN_AVG_LOGPROB = -1.0;
// faster-whisper no_speech_prob > 0.6 is a strong "this segment was silence"
// signal — drop the transcript even if the model produced text from it.
const STT_MAX_NO_SPEECH_PROB = 0.6;
// Hold the mic muted for this long after the agent's TTS audio ends. Speakers
// (especially Bluetooth/laptop) emit a 200–400 ms acoustic tail that the mic
// would otherwise pick up and the STT would transcribe as the candidate.
const POST_TTS_MIC_DEAD_ZONE_MS = 400;
// If backend socket TTS is late/unavailable, trigger client-side TTS quickly
// so the interviewer still speaks right after text appears.
const AGENT_TTS_FALLBACK_MS = Math.max(0, Number(import.meta.env.VITE_AGENT_TTS_FALLBACK_MS || 2500));

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
  'and i was beginning',
  'from the more than that is',
  "i'm going to say",
]);

// Phrasal hallucination patterns: longer outputs whisper fabricates by
// repeating modal/auxiliary structures ("be able to be able to ...",
// "going to be ... going to be ..."). These don't match exactly so we
// detect them by structural shape.
const WHISPER_HALLUCINATION_PATTERNS = [
  // "be able to be able to" repetitions
  /\b(?:be|to be|going to be)\s+able\s+to\s+(?:be\s+able\s+to\s+){1,}/i,
  // "going to ... going to ... going to" with no concrete content
  /\b(?:i'?m|we'?re|you'?re|going)\s+going\s+to\b.*\bgoing\s+to\b.*\bgoing\s+to\b/i,
  // Pure modal-chain hallucinations that have no nouns/verbs of substance
  /^\s*(?:i\s+)?think\s+(?:it'?s|it\s+is)\s+been\s+able\s+to\b/i,
  // "from the more than that is" / "more than that is" filler chains
  /\b(?:from\s+the\s+)?more\s+than\s+that\s+is\b/i,
];

const normalizeAgentLanguage = (value, fallback = 'en') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.startsWith('fr') || normalized === 'french' || normalized === 'français' || normalized === 'francais') return 'fr';
  if (normalized.startsWith('en') || normalized === 'english' || normalized === 'anglais') return 'en';
  return fallback;
};

const detectRequestedAgentLanguage = (text) => {
  const normalized = String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;

  const frenchSignals = [
    'speak french',
    'speak frensh',
    'ask me in french',
    'ask me in frensh',
    'continue in french',
    'turn this convo in french',
    'turn this convo in frensh',
    'turn this conversation in french',
    'turn this conversation in frensh',
    'french language',
    'frensh language',
    'parle francais',
    'parlez francais',
    'en francais',
    'francais stp',
    'francais svp',
  ];
  if (frenchSignals.some((phrase) => normalized.includes(phrase))) return 'fr';

  const englishSignals = [
    'speak english',
    'ask me in english',
    'continue in english',
    'parle anglais',
    'en anglais',
  ];
  if (englishSignals.some((phrase) => normalized.includes(phrase))) return 'en';

  return null;
};

const isWhisperHallucination = (text) => {
  const raw = String(text || '');
  const cleaned = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (!cleaned) return true;
  if (WHISPER_HALLUCINATION_PHRASES.has(cleaned)) return true;

  // Phrasal hallucination patterns (e.g. "able to be able to", "going to be
  // able to be"). Test against the original (with apostrophes) so contraction-
  // sensitive patterns still match.
  for (const pattern of WHISPER_HALLUCINATION_PATTERNS) {
    if (pattern.test(raw) || pattern.test(cleaned)) return true;
  }

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
  const direct = payload?.transcription;
  const directText = String(direct?.text || '').trim();
  if (directText) {
    return {
      text: directText,
      sentiment: payload?.overall_sentiment || { label: 'NEUTRAL', score: 0 },
      avgLogprob: typeof direct?.avg_logprob === 'number' ? direct.avg_logprob : null,
      noSpeechProb: typeof direct?.no_speech_prob === 'number' ? direct.no_speech_prob : null,
    };
  }

  // Backend voice route normalized payload shape.
  const apiText = String(payload?.text || '').trim();
  const sentimentFromSummary = payload?.summary?.sentiment;
  const sentiment = sentimentFromSummary || payload?.overall_sentiment || { label: 'NEUTRAL', score: 0 };

  return {
    text: apiText,
    sentiment,
    avgLogprob: typeof payload?.avg_logprob === 'number' ? payload.avg_logprob : null,
    noSpeechProb: typeof payload?.no_speech_prob === 'number' ? payload.no_speech_prob : null,
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
  const [cameraOn, setCameraOn] = useState(false);
  const [endingCall, setEndingCall] = useState(false);
  // Candidate must enable mic before we start the interview.
  const [micReady, setMicReady] = useState(false);
  const [interviewStarting, setInterviewStarting] = useState(false);
  const [visionStatus, setVisionStatus] = useState(null);
  const [visionReport, setVisionReport] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const webcamVideoRef  = useRef(null);
  const webcamStreamRef = useRef(null);
  const elapsedTimerRef = useRef(null);
  const conversationRef = useRef(null);
  
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
  const agentLanguageRef = useRef('en');
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
  // Hold the mic muted briefly after the agent's TTS audio ends so the
  // speaker's acoustic tail can't be transcribed as the candidate.
  const postTtsDeadZoneTimerRef = useRef(null);
  const postTtsDeadZoneActiveRef = useRef(false);
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
    if (isRHRef.current || agentSessionReadyRef.current) return;
    if (introStartRequestedRef.current) return;
    if (!recordingActiveRef.current) return;

    const socket = socketRef.current;
    if (!socket || !socket.connected) {
      if (introKickoffAttemptsRef.current >= 6 || !recordingActiveRef.current) return;
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

  useIntegrityEvents({
    active: isRecording && cameraOn && !isRH,
    interviewId: roomDbId,
    questionId: room?.currentQuestion || '',
    token,
    apiBase: API_BASE,
    visionState: visionStatus,
    videoRef: webcamVideoRef,
  });

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
    if (!recordingActiveRef.current || isRHRef.current) {
      return false;
    }

    if (!(blob instanceof Blob) || blob.size <= 0) {
      return false;
    }

    stopAgentAudioPlayback();

    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    audio.preload = 'auto';
    // Expose for RealFaceAvatar's Web Audio analyzer
    window.__agentAudioEl = audio;
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
    const language = normalizeAgentLanguage(agentLanguageRef.current, detectRequestedAgentLanguage(text) || 'en');
    const body = JSON.stringify({
      text,
      language,
      provider: 'edge',
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
      if (recordingActiveRef.current) {
        await playAgentAudioBlob(blob, normalizedText, { announceStart: true });
      }
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
    if (!latest?.blob || isRHRef.current || !recordingActiveRef.current) return false;
    await playAgentAudioBlob(latest.blob, latest.text || room?.currentQuestion || '', { announceStart: true });
    return true;
  };

  useEffect(() => {
    latestAgentTtsRequestIdRef.current += 1;
    lastAgentVoiceKeyRef.current = '';
    agentLanguageRef.current = 'en';
    latestAgentTtsRef.current = null;
    clearAgentTtsFallback();
    stopAgentAudioPlayback({ emitStopped: true });
  }, [roomId]);

  // Fetch room details
  useEffect(() => {
    const fetchRoom = async () => {
      try {
        console.log('🔍 Fetching room details for roomId:', roomId);
        const response = await fetch(`${API_BASE}/api/call-rooms/by-room/${encodeURIComponent(roomId)}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        console.log('🔍 Room fetch response status:', response.status);
        const data = await response.json();
        console.log('🔍 Room fetch response data:', data);
        if (data.success && data.room) {
          console.log('✅ Room loaded successfully:', data.room.roomId);
          setRoom(data.room);
          setRoomDbId(data.room._id);
          setIsRH(data.room.initiator?._id === userId);
          setVisionReport(data.room.visionMonitoring?.report || null);
        } else {
          console.warn('❌ Room not found or invalid response:', data);
        }
      } catch (error) {
        console.error('❌ Failed to fetch room:', error);
      } finally {
        setLoading(false);
      }
    };

    if (roomId && token && userId) {
      fetchRoom();
    } else {
      console.log('⏭️ Skipping room fetch - missing:', { roomId: !!roomId, token: !!token, userId: !!userId });
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

  // Elapsed call timer
  useEffect(() => {
    elapsedTimerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(elapsedTimerRef.current);
  }, []);

  // Candidate intro is started by the explicit "Start Call" button
  // (after mic + camera are enabled). Recruiter auto-start is handled by
  // AgentChatPanel, so we don't need to force anything here.

  // Capture Streamoji's imperative actions when its widget reports ready,
  // and clear them on teardown. ElevenLabs remains the primary voice path
  // for recruiter/enterprise agent turns; this ref is kept only for legacy
  // widget compatibility.
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
      console.log('⏭️ Skipping socket setup - missing or expired token');
      return undefined;
    }

    console.log('🔌 Setting up socket.io connection to:', API_BASE);
    socketRef.current = io(API_BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 1200,
    });
    setSocketClient(socketRef.current);

    socketRef.current.on('connect', () => {
      console.log('✅ Socket connected');
      // Candidate interview intro is started explicitly by the "Start Call" button.
    });

    socketRef.current.on('connect_error', (error) => {
      console.error('❌ Socket connection error:', error?.message);
      if (error?.message === 'TOKEN_EXPIRED') {
        console.warn('Socket session expired in active room. Please login again.');
        socketRef.current?.disconnect();
      }
    });

    // Join room-specific channel
    console.log('📍 Emitting join-room with roomId:', roomId);
    socketRef.current.emit('join-room', { roomId });

    // Listen for transcription updates — auto-send finalized segments to agent after silence
    const handleTranscriptionUpdate = ({ segment, sentiment }) => {
      if (!segment?.text) {
        console.log('🔇 Transcription update with empty text, skipping');
        return;
      }

      console.log('📝 Transcription update received:', segment.text, { sentiment });
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
      // as the "answer", or our in-flight turn collides with a new one. Also
      // honour the post-TTS dead zone (speaker tail / reverb).
      if (
        agentSpeakingRef.current ||
        agentThinkingRef.current ||
        postTtsDeadZoneActiveRef.current
      ) {
        console.log('🔇 Dropping STT segment — agent busy or post-TTS dead zone');
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
      console.log('✏️ Updating draft bubble with STT segment:', normalizedMerged);
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
      console.log('📢 Dispatching candidate-local-message event:', finalText);
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
        const requestedLanguage = detectRequestedAgentLanguage(finalText);
        if (requestedLanguage) {
          agentLanguageRef.current = requestedLanguage;
        }
        const sock = socketRef.current;
        const turnSentAt = Date.now();
        console.log('📤 Emitting agent:candidate-turn', {
          connected: !!sock?.connected,
          roomId,
          roomDbId: roomDbIdRef.current,
          chars: finalText.length,
        });
        sock?.emit('agent:candidate-turn', {
          roomId,
          roomDbId: roomDbIdRef.current,
          text: finalText,
          sentiment: current.sentiment,
          source: 'voice',
          requestedLanguage,
        });
        // Surface a clear console error if the backend doesn't reply within
        // 45s. NVIDIA NIM occasionally stalls; without this, the candidate
        // sees only silence and has no way to know what failed.
        const stallTimer = setTimeout(() => {
          if (!agentThinkingRef.current) return;
          console.error(
            `🟥 agent:candidate-turn TIMEOUT after ${Math.round(
              (Date.now() - turnSentAt) / 1000,
            )}s — no agent:message or agent:error from server. ` +
              'Check the Node terminal for "agent:candidate-turn failed:" and the ' +
              'Python agent_server (:8013) terminal for NVIDIA NIM errors.',
          );
          agentThinkingRef.current = false;
          setAgentThinking(false);
          emitAgentThinkingState(false);
          if (recordingActiveRef.current && !agentSpeakingRef.current) {
            setMicEnabled(true);
          }
        }, 45000);
        const clearStallOnce = () => {
          clearTimeout(stallTimer);
          sock?.off('agent:message', clearStallOnce);
          sock?.off('agent:error', clearStallOnce);
        };
        sock?.once('agent:message', clearStallOnce);
        sock?.once('agent:error', clearStallOnce);
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
    const handleAgentMessage = ({ text, skillFocus, difficulty, phase, turnIndex, language }) => {
      agentSessionReadyRef.current = true;
      agentLanguageRef.current = normalizeAgentLanguage(language, agentLanguageRef.current);
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
      console.log('🤖 Agent message received:', text, { skillFocus, difficulty, phase, turnIndex, language: agentLanguageRef.current });

      const normalizedText = String(text || '').trim();
      if (!isRHRef.current && normalizedText) {
        const voiceKey = `${String(roomDbIdRef.current || roomId || '').trim()}::${turnIndex ?? 'na'}::${normalizedText}`;
        lastAgentVoiceKeyRef.current = voiceKey;
        clearAgentTtsFallback();

        // Allow backend agent:tts to arrive first; if it does not, fall back
        // to a direct ElevenLabs fetch after a short delay.
        if (AGENT_TTS_FALLBACK_MS > 0) {
          console.log('🎙️ Setting up ElevenLabs fallback TTS in', AGENT_TTS_FALLBACK_MS, 'ms');
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

      const spokenText = String(payload?.text || '').trim();
      const sourceText = String(payload?.sourceText || payload?.text || '').trim();
      if (!spokenText || !payload?.audioBase64) return;
      agentLanguageRef.current = normalizeAgentLanguage(payload?.language, agentLanguageRef.current);

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
        // Play backend-provided TTS immediately regardless of whether the
        // candidate has started recording. This lets the agent introduce
        // themselves as soon as the candidate joins the room.
        void playAgentAudioBlob(blob, spokenText, { announceStart: true });
      } catch (error) {
        console.error('Failed to play backend ElevenLabs audio:', error);
        void requestAgentTtsPlayback(sourceText || spokenText, voiceKey);
      }
    };
    socketRef.current.on('agent:tts', handleAgentTts);

    const handleAgentTtsUnavailable = (payload) => {
      if (payload?.roomId && payload.roomId !== roomId) return;
      if (isRHRef.current) return;
      const fallbackText = String(payload?.text || '').trim();
      if (!fallbackText) return;
      agentLanguageRef.current = normalizeAgentLanguage(payload?.language, agentLanguageRef.current);
      clearAgentTtsFallback();
      void requestAgentTtsPlayback(fallbackText);
    };
    socketRef.current.on('agent:tts-unavailable', handleAgentTtsUnavailable);

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

      if (speaking) {
        // Cancel any pending mic re-enable from a previous speech end.
        if (postTtsDeadZoneTimerRef.current) {
          clearTimeout(postTtsDeadZoneTimerRef.current);
          postTtsDeadZoneTimerRef.current = null;
        }
        postTtsDeadZoneActiveRef.current = true;
        // Physically mute the mic track, not just a flag — prevents the TTS
        // from being captured and then transcribed as the candidate's answer.
        setMicEnabled(false);
        if (sttSilenceTimerRef.current) {
          clearTimeout(sttSilenceTimerRef.current);
          sttSilenceTimerRef.current = null;
        }
        sttPendingReplyRef.current = { text: '', sentiment: null, startedAt: 0, updatedAt: 0 };
        return;
      }

      // Speech just ended. Hold the mic muted for POST_TTS_MIC_DEAD_ZONE_MS
      // so the speaker tail / room reverb doesn't get captured and
      // transcribed as the candidate's reply.
      if (postTtsDeadZoneTimerRef.current) {
        clearTimeout(postTtsDeadZoneTimerRef.current);
      }
      postTtsDeadZoneActiveRef.current = true;
      setMicEnabled(false);
      postTtsDeadZoneTimerRef.current = setTimeout(() => {
        postTtsDeadZoneTimerRef.current = null;
        postTtsDeadZoneActiveRef.current = false;
        // Only re-enable if nothing else is gating the mic now.
        if (
          recordingActiveRef.current &&
          !agentSpeakingRef.current &&
          !agentThinkingRef.current
        ) {
          setMicEnabled(true);
        }
      }, POST_TTS_MIC_DEAD_ZONE_MS);
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
      if (postTtsDeadZoneTimerRef.current) {
        clearTimeout(postTtsDeadZoneTimerRef.current);
        postTtsDeadZoneTimerRef.current = null;
      }
      postTtsDeadZoneActiveRef.current = false;
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
      socketRef.current?.off('agent:tts-unavailable');
      socketRef.current?.off('agent:error');
      socketRef.current?.off('call-room-ended');
      socketRef.current?.off('connect');
      socketRef.current?.disconnect();
      socketRef.current?.off('connect_error');
      socketRef.current?.off('transcription-update', handleTranscriptionUpdate);
      socketRef.current?.off('agent:tts', handleAgentTts);
      socketRef.current?.off('agent:tts-unavailable', handleAgentTtsUnavailable);
      socketRef.current?.disconnect();
      setSocketClient(null);
    };
  }, [roomId, token]);

  const stopMicrophoneStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    setMicReady(false);
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
    // TTS would be captured and misread as the candidate's answer. The post-
    // TTS dead zone covers the speaker tail / room reverb after audio ends.
    const gated =
      agentSpeakingRef.current ||
      agentThinkingRef.current ||
      postTtsDeadZoneActiveRef.current;

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
  const requestMicrophoneStream = async () => {
    try {
      if (micReady || recordingActiveRef.current) return;
      if (streamRef.current) {
        setMicReady(true);
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
      streamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });

      recordingActiveRef.current = false;
      setMicReady(true);
    } catch (error) {
      console.error('Failed to access microphone:', error);
      alert('Failed to access microphone. Please check browser permissions.');
      setMicReady(false);
    }
  };

  // Start interview (VAD + STT + agent session)
  const startRecording = async () => {
    try {
      if (recordingActiveRef.current) {
        return;
      }

      if (!streamRef.current) {
        alert('Enable the microphone first.');
        return;
      }
      if (!cameraOn) {
        alert('Enable the camera first (required to start the call UI).');
        return;
      }

      const stream = streamRef.current;
      recordingActiveRef.current = true;
      setMicEnabled(true);
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

      void playPreparedAgentTts().then((played) => {
        if (!played && lastAgentTextRef.current) {
          void requestAgentTtsPlayback(lastAgentTextRef.current, lastAgentVoiceKeyRef.current);
        }
      });

      // Candidate explicitly started the interview. Always request intro with
      // TTS preparation so first turn appears as text + speech together.
      setInterviewStarting(true);
      tryStartAgentIntro({ force: true, prepare: true });
    } catch (error) {
      console.error('Failed to start recording:', error);
      alert('Failed to access microphone');
    }
  };

  const stopRecording = () => {
    recordingActiveRef.current = false;

    stopVad();
    stopMicrophoneStream();
    clearAgentTtsFallback();
    stopAgentAudioPlayback({ emitStopped: true });

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

      // Confidence gate: drop low-confidence transcripts before they reach
      // the agent. avg_logprob is mean per-token log probability from
      // faster-whisper; values below STT_MIN_AVG_LOGPROB are typically
      // hallucinations from silence/noise. no_speech_prob > threshold means
      // the model itself thinks the audio was silence.
      if (text && parsed.avgLogprob != null && parsed.avgLogprob < STT_MIN_AVG_LOGPROB) {
        console.log(
          '🔇 Dropping low-confidence STT segment:',
          text,
          `(avg_logprob=${parsed.avgLogprob.toFixed(2)} < ${STT_MIN_AVG_LOGPROB})`,
        );
        return;
      }
      if (text && parsed.noSpeechProb != null && parsed.noSpeechProb > STT_MAX_NO_SPEECH_PROB) {
        console.log(
          '🔇 Dropping silence-classified STT segment:',
          text,
          `(no_speech_prob=${parsed.noSpeechProb.toFixed(2)} > ${STT_MAX_NO_SPEECH_PROB})`,
        );
        return;
      }

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

  const toggleCamera = async () => {
    if (cameraOn) {
      webcamStreamRef.current?.getTracks().forEach((t) => t.stop());
      webcamStreamRef.current = null;
      if (webcamVideoRef.current) webcamVideoRef.current.srcObject = null;
      setCameraOn(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        webcamStreamRef.current = stream;
        if (webcamVideoRef.current) webcamVideoRef.current.srcObject = stream;
        setCameraOn(true);
      } catch (e) {
        console.warn('[Camera] access denied or unavailable:', e.message);
      }
    }
  };

  const endCall = async () => {
    if (!roomDbId || endingCall) return;
    setEndingCall(true);
    clearAgentTtsFallback();
    stopAgentAudioPlayback({ emitStopped: true });
    webcamStreamRef.current?.getTracks().forEach((t) => t.stop());
    clearInterval(elapsedTimerRef.current);

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

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.message || `End call failed (${response.status})`);
      }

      if (data.room?.visionMonitoring?.report) {
        setVisionReport(data.room.visionMonitoring.report);
      }

      await uploadRecording(roomDbId);
      socketRef.current?.emit('agent:end-session', { roomId, roomDbId });
      socketRef.current?.emit('end-call-room', { roomId, roomDbId });
      globalThis.history.back();
    } catch (error) {
      console.error('Failed to end call:', error);
      alert(error?.message || 'Failed to end call. Please try again.');
      setEndingCall(false);
    }
  };

  if (loading) {
    return (
      <PublicLayout>
        <div className="loading">Loading call room...</div>
      </PublicLayout>
    );
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <PublicLayout>
      <div className="cr-root">

        {/* ── Header ─────────────────────────────────────────── */}
        <header className="cr-header">
          <div className="cr-header__left">
            <span className="cr-logo">NextHire</span>
            <span className="cr-room-name">Interview · {room?.roomId}</span>
          </div>
          <div className="cr-header__center">
            <span className="cr-timer">{mm}:{ss}</span>
          </div>
          <div className="cr-header__right">
            {isRecording && <span className="cr-badge-rec">● REC</span>}
            <button className="cr-btn-end" onClick={endCall} disabled={!roomDbId || endingCall}>
              {endingCall ? 'Leaving...' : 'Leave'}
            </button>
          </div>
        </header>

        {/* ── Main grid ──────────────────────────────────────── */}
        <main className="cr-main">

          {/* Left column — video tiles */}
          <div className="cr-left">

            {/* AI Interviewer tile — fills left panel, cam is PiP overlay */}
            <div className="cr-tile cr-tile--ai">
              <div className="cr-tile__label">
                <span className="cr-tile__label-dot" /> AI Interviewer
              </div>
              {!isRH
                ? <InterviewAvatar />
                : <div className="cr-tile__placeholder">RH View</div>}
              <div className={`cr-tile__status ${agentSpeaking ? 'speaking' : agentThinking ? 'thinking' : 'idle'}`}>
                {agentSpeaking ? '🗣 Speaking' : agentThinking ? '💭 Thinking…' : '🎧 Listening'}
              </div>

              {/* Picture-in-Picture: candidate cam overlaid on avatar */}
              {!isRH && (
                <div className="cr-pip">
                  <div className="cr-pip__label">You</div>
                  <video
                    ref={webcamVideoRef}
                    autoPlay
                    muted
                    playsInline
                    className={`cr-cam-video${cameraOn ? '' : ' cr-cam-video--off'}`}
                  />
                  {!cameraOn && (
                    <div className="cr-cam-placeholder">
                      <span>📷</span>
                      <span>Camera off</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {!isRH && (
              <VisionMonitor
                active={cameraOn}
                interviewId={roomDbId}
                questionId={room?.currentQuestion || ''}
                token={token}
                apiBase={API_BASE}
                roomStatus={isRecording ? 'active' : (room?.status || 'waiting')}
                videoRef={webcamVideoRef}
                onStatusChange={setVisionStatus}
              />
            )}

            {/* Control bar */}
            {!isRH && (
              <div className="cr-controls">
                <button
                  className={`cr-ctrl cr-ctrl--start${(!isRecording && micReady && cameraOn) ? ' cr-ctrl--active' : ''}`}
                  onClick={async () => {
                    await startRecording();
                    // On small screens, Conversation can be below the fold.
                    setTimeout(() => {
                      conversationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }, 60);
                  }}
                  disabled={isRecording || !micReady || !cameraOn}
                >
                  <span className="cr-ctrl__icon">▶️</span>
                  <span className="cr-ctrl__label">Start Call</span>
                </button>
                <button
                  className={`cr-ctrl${isRecording || micReady ? ' cr-ctrl--active' : ''}`}
                  onClick={isRecording
                    ? stopRecording
                    : micReady
                      ? stopMicrophoneStream
                      : requestMicrophoneStream
                  }
                >
                  <span className="cr-ctrl__icon">{isRecording ? '🔴' : micReady ? '🎙️' : '🎤'}</span>
                  <span className="cr-ctrl__label">
                    {isRecording ? 'Mute' : micReady ? 'Disable Mic' : 'Enable Mic'}
                  </span>
                </button>
                <button
                  className={`cr-ctrl${cameraOn ? ' cr-ctrl--active' : ''}`}
                  onClick={toggleCamera}
                >
                  <span className="cr-ctrl__icon">{cameraOn ? '📷' : '📷'}</span>
                  <span className="cr-ctrl__label">{cameraOn ? 'Stop Video' : 'Start Video'}</span>
                </button>
                <button className="cr-ctrl cr-ctrl--end" onClick={endCall} disabled={!roomDbId || endingCall}>
                  <span className="cr-ctrl__icon">📞</span>
                  <span className="cr-ctrl__label">{endingCall ? 'Ending...' : 'End Call'}</span>
                </button>
              </div>
            )}
          </div>

          {/* Right column — chat + transcript */}
          <div className="cr-right">

            {/* Status bar */}
            {!isRH && (
              <div className={`cr-statusbar${agentSpeaking ? ' cr-statusbar--speaking' : agentThinking ? ' cr-statusbar--thinking' : isRecording ? ' cr-statusbar--listening' : ''}`}>
                <span className="cr-statusbar__dot" />
                <span className="cr-statusbar__text">
                  {agentSpeaking
                    ? 'AI is speaking — please listen'
                    : agentThinking
                    ? 'AI is thinking…'
                    : isRecording
                    ? 'Listening — speak naturally, then pause'
                        : !micReady
                          ? 'Enable microphone to begin'
                          : !cameraOn
                            ? 'Enable camera to begin'
                            : visionStatus?.message || 'Click Start Call'}
                </span>
              </div>
            )}

            {/* Agent chat panel */}
            {(socketClient && roomId) && (
              <div className="cr-chat" ref={conversationRef}>
                <div className="cr-chat-header">
                  <span className="cr-chat-header__icon">💬</span>
                  <div>
                    <div className="cr-chat-header__title">Conversation</div>
                    <div className="cr-chat-header__sub">Interview transcript</div>
                  </div>
                </div>
                <AgentChatPanel
                  socket={socketClient}
                  roomId={roomId}
                  roomDbId={roomDbId}
                  isRH={isRH}
                  candidateDraftText={!isRH ? draftText : null}
                  interviewStarting={interviewStarting}
                />
              </div>
            )}

            {/* RH transcript panel */}
            {isRH && (
              <div className="cr-transcript">
                <div className="cr-transcript__header">
                  <h2>Interview Dashboard</h2>
                  <span>{room?.candidate?.email}</span>
                </div>
                <div className="cr-transcript__feed">
                  {room?.transcription?.segments?.length === 0 ? (
                    <p className="cr-transcript__empty">Waiting for audio…</p>
                  ) : (
                    room?.transcription?.segments?.map((seg, idx) => (
                      // Per-segment sentiment label intentionally omitted —
                      // emotion is not used in the recruitment decision.
                      <div key={idx} className="cr-seg">
                        <span className="cr-seg__text">{seg.text}</span>
                        <span className="cr-seg__time">{new Date(seg.timestamp).toLocaleTimeString()}</span>
                      </div>
                    ))
                  )}
                </div>

                {/* Overall sentiment block intentionally omitted — emotion
                    classification is not part of the recruitment decision. */}

                {room?.transcription?.text && (
                  <div className="cr-full-transcript">
                    <p><strong>Full Transcript:</strong></p>
                    <textarea readOnly value={room.transcription.text} />
                  </div>
                )}

                {room?.visionMonitoring?.report || visionReport ? (
                  <div className="cr-vision-report">
                    <div className="cr-vision-report__header">
                      <h3>Vision Monitoring</h3>
                      <span>{(visionReport || room?.visionMonitoring?.report)?.cameraQuality || 'Unknown'}</span>
                    </div>
                    <div className="cr-vision-report__grid">
                      <div>
                        <span>Face visibility</span>
                        <strong>{(visionReport || room?.visionMonitoring?.report)?.faceVisibilityRate || '0%'}</strong>
                      </div>
                      <div>
                        <span>Absence events</span>
                        <strong>{(visionReport || room?.visionMonitoring?.report)?.absenceEvents || 0}</strong>
                      </div>
                      <div>
                        <span>Lighting issues</span>
                        <strong>{(visionReport || room?.visionMonitoring?.report)?.lightingIssues || 0}</strong>
                      </div>
                      <div>
                        <span>Position issues</span>
                        <strong>{(visionReport || room?.visionMonitoring?.report)?.positionIssues || 0}</strong>
                      </div>
                    </div>
                    <p className="cr-vision-report__recommendation">
                      {(visionReport || room?.visionMonitoring?.report)?.recommendation}
                    </p>
                  </div>
                ) : null}
              </div>
            )}

          </div>{/* cr-right */}
        </main>{/* cr-main */}
      </div>{/* cr-root */}
    </PublicLayout>
  );
};

export default CallRoomActive;
