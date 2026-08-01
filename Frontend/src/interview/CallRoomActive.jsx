import { useEffect, useState, useRef } from "react";
import AgentChatPanel from "./AgentChatPanel";
import InterviewAvatar from "./InterviewAvatar";
import VisionMonitor from "./VisionMonitor";
import FaceVerification from "./FaceVerification";
import { useParams } from "react-router-dom";
import { io } from "socket.io-client";
import useIntegrityEvents from "./hooks/useIntegrityEvents";
import PublicLayout from "../layouts/PublicLayout";
import { containsProfanity } from "./utils/profanityFilter";
import "./CallRoomActive.css";

// ── Browser extension noise filter ──────────────────────────────────────────────────
// Suppress "Unchecked runtime.lastError" and "Receiving end does not exist"
// from browser extensions so they don't pollute the interview console output.
// These are benign extension-to-extension messages, not backend failures.
(function suppressExtensionNoise() {
  const _origError = console.error.bind(console);
  console.error = (...args) => {
    const msg = String(args[0] || "");
    if (
      msg.includes("Unchecked runtime.lastError") ||
      msg.includes("Receiving end does not exist") ||
      msg.includes("The message port closed before a response was received")
    ) {
      return; // extension noise — skip
    }
    _origError(...args);
  };
})();

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
const SPEECH_STACK_URL =
  import.meta.env.VITE_SPEECH_STACK_URL || "http://localhost:8012";
const VOICE_API_URL = `${API_BASE}/api/voice`;
const FACE_RECHECK_INTERVAL_MS = Number(
  import.meta.env.VITE_FACE_VERIFY_PERIODIC_INTERVAL_MS || 45000,
);
const MIN_AUDIO_BLOB_BYTES = 2048;

// Voice-activity-detection endpointing: record the *whole* utterance, only
// cut when the candidate has actually been silent. This prevents Whisper
// from receiving mid-sentence chunks ("My name is" → fragmented transcript).
// Kept snappy so the agent replies fast — natural end-of-sentence silence is
// ~700–900ms, anything longer makes the AI feel laggy.
const VAD_POLL_INTERVAL_MS = 40;
const VAD_RMS_THRESHOLD = 0.015; // normalized mic energy above → voice
const VAD_START_RMS_THRESHOLD = 0.02; // slightly higher to arm recording
const VAD_SILENCE_MS = 550; // silence needed to end an utterance (snappier turn-taking)
const VAD_MIN_UTTERANCE_MS = 400; // min voice duration to bother sending
const VAD_MAX_UTTERANCE_MS = 30000; // hard cap to avoid runaway blobs

// Short merge window on top of VAD so breath-pauses between clauses get
// concatenated into one coherent answer before it is shipped to the agent.
// Kept tight so the agent receives the answer quickly after the candidate
// stops talking — total perceived latency ≈ VAD_SILENCE_MS + this.
const STT_FINALIZE_SILENCE_MS = 1800;
const STT_MIN_FINAL_TEXT_LEN = 2;
// Lowered from 4 → 2: allow short but valid technical answers like "Node.js backend",
// "I used React", "Yes I did". Hallucination filters still apply.
const STT_MIN_FINAL_WORDS = 2;
const STT_MIN_FINAL_CHARS = 4; // min chars for a valid short answer
// Min chars for the semantic short-answer path (below STT_MIN_FINAL_WORDS)
const STT_SEMANTIC_SHORT_MIN_CHARS = 3;
// faster-whisper avg_logprob is per-token mean log probability. Empirically:
// real candidate speech sits ~ -0.30 to -0.75; hallucinations from silence/
// breath cluster around -0.90 and below. -0.85 is a safer drop floor than
// -1.0 — the looser bar previously let through "I'm sorry. I don't know."
// rambling hallucinations.
const STT_MIN_AVG_LOGPROB = -0.85;
// faster-whisper no_speech_prob > 0.4 is a strong "this segment was silence"
// signal. The previous 0.6 bar let mid-confidence silence rambles through.
const STT_MAX_NO_SPEECH_PROB = 0.6;
// Hold the mic muted for this long after the agent's TTS audio ends. Speakers
// (especially Bluetooth/laptop) emit a 200–400 ms acoustic tail that the mic
// would otherwise pick up and the STT would transcribe as the candidate.
// Kept short (600 ms) so the candidate can answer immediately after a
// question — long dead zones cause the start of the first answer to be
// dropped by VAD before it ever arms an utterance.
const POST_TTS_MIC_DEAD_ZONE_MS = 600;
// How long to wait for backend agent:tts before triggering local TTS fetch.
// Kept intentionally short (300 ms) — just enough time for agent:tts to arrive
// on the same socket before we fall back. No external TTS vendors are used.
const AGENT_TTS_FALLBACK_MS = Math.max(
  0,
  Number(import.meta.env.VITE_AGENT_TTS_FALLBACK_MS || 300),
);
const AGENT_TURN_STALL_MS = Math.max(
  60000,
  Number(import.meta.env.VITE_AGENT_TURN_STALL_MS || 180000),
);

const FILLER_TOKENS = new Set([
  "uh",
  "um",
  "hmm",
  "huh",
  "boom",
  "hello",
  "please",
  "ok",
  "okay",
  "all",
  "right",
  "yes",
  "no",
  "i",
  "the",
]);

const TURN_STATE_LABELS = {
  agent_speaking: "AI is speaking...",
  candidate_listening: "Listening — answer naturally",
  candidate_answering: "Listening — answer naturally",
  candidate_submitting: "Processing your answer...",
  agent_thinking: "AI is thinking...",
  error_recoverable: "Response interrupted — retrying...",
};

const COMMON_STT_HALLUCINATIONS = [
  "thank you",
  "thank you thank you",
  "thanks for watching",
  "thank you for watching",
  "i think of it",
  "i think of it's going to be",
  "i think of its going to be",
  "this is the minute",
  "i'm going to",
  "im going to",
  "going to be going to be",
  "subtitles by the amara org community",
];

const STRONG_FILLER_TOKENS = new Set([
  ...FILLER_TOKENS,
  "like",
  "actually",
  "basically",
  "just",
  "so",
  "well",
  "maybe",
  "probably",
  "kind",
  "of",
  "you",
  "know",
]);

const normalizeForQuality = (text) =>
  String(text || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s']/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

const wordTokens = (text) =>
  normalizeForQuality(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

const getRepetitionRatio = (tokens) => {
  if (!tokens.length) return 1;
  const unique = new Set(tokens);
  return (tokens.length - unique.size) / tokens.length;
};

const hasRepeatedPhrase = (tokens, phraseLength = 2) => {
  if (tokens.length < phraseLength * 3) return false;
  const counts = new Map();
  for (let i = 0; i <= tokens.length - phraseLength; i += 1) {
    const phrase = tokens.slice(i, i + phraseLength).join(" ");
    counts.set(phrase, (counts.get(phrase) || 0) + 1);
    if (counts.get(phrase) >= 3) return true;
  }
  return false;
};

const candidateAnswerHash = (text) =>
  normalizeForQuality(text)
    .replaceAll(/\b(?:uh|um|hmm|okay|ok)\b/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

function isValidCandidateAnswer(text, sttMeta = {}) {
  const cleaned = normalizeTranscriptText(text);
  const normalized = normalizeForQuality(cleaned);
  const tokens = wordTokens(cleaned);

  if (!normalized) return { valid: false, reason: "empty" };
  if (sttMeta.source === "typed") {
    const singleRepeatedToken =
      tokens.length === 1 && /^([a-z0-9])\1{2,}$/i.test(tokens[0]);
    const repeatedCharText = /^([a-z0-9])\1{2,}$/i.test(
      normalized.replace(/\s+/g, ""),
    );
    const onlyKeyboardNoise =
      tokens.length <= 2 &&
      tokens.every((token) => /^([a-z0-9])\1{2,}$/i.test(token));
    if (singleRepeatedToken || repeatedCharText || onlyKeyboardNoise) {
      return { valid: false, reason: "typed_low_signal" };
    }
  }
  if (sttMeta.source !== "typed" && tokens.length < STT_MIN_FINAL_WORDS) {
    // Below the minimum token threshold. Allow if the text itself is long enough
    // to be a valid short technical answer (e.g. "ReactJS", single-word tech term).
    if (normalized.length >= STT_SEMANTIC_SHORT_MIN_CHARS) {
      // Pass through — hallucination / filler filters will catch real noise below.
    } else {
      return { valid: false, reason: "semantic_short_response_validation" };
    }
  }
  if (
    sttMeta.source !== "typed" &&
    Number(sttMeta.speechDurationMs || 0) > 0 &&
    Number(sttMeta.speechDurationMs) < VAD_MIN_UTTERANCE_MS
  ) {
    return {
      valid: false,
      reason: `speech_too_short_${Number(sttMeta.speechDurationMs)}ms`,
    };
  }
  if (
    typeof sttMeta.avgLogprob === "number" &&
    sttMeta.avgLogprob < STT_MIN_AVG_LOGPROB
  ) {
    return {
      valid: false,
      reason: `low_avg_logprob_${sttMeta.avgLogprob.toFixed(2)}`,
    };
  }
  if (
    typeof sttMeta.noSpeechProb === "number" &&
    sttMeta.noSpeechProb > STT_MAX_NO_SPEECH_PROB
  ) {
    return {
      valid: false,
      reason: `high_no_speech_${sttMeta.noSpeechProb.toFixed(2)}`,
    };
  }

  const repetitionRatio = getRepetitionRatio(tokens);
  if (sttMeta.source !== "typed" && repetitionRatio > 0.45) {
    return {
      valid: false,
      reason: `high_repetition_${repetitionRatio.toFixed(2)}`,
    };
  }
  if (
    sttMeta.source !== "typed" &&
    (hasRepeatedPhrase(tokens, 2) || hasRepeatedPhrase(tokens, 3))
  ) {
    return { valid: false, reason: "repeated_phrase" };
  }

  if (sttMeta.source !== "typed") {
    const mostlyFiller =
      tokens.length <= 10 &&
      tokens.filter((token) => !STRONG_FILLER_TOKENS.has(token)).length <=
        Math.max(1, Math.floor(tokens.length * 0.35));
    if (mostlyFiller) return { valid: false, reason: "mostly_filler" };
  }

  if (isWhisperHallucination(cleaned))
    return { valid: false, reason: "known_whisper_hallucination" };
  if (
    sttMeta.source !== "typed" &&
    COMMON_STT_HALLUCINATIONS.some((phrase) => normalized.includes(phrase))
  ) {
    return { valid: false, reason: "common_stt_hallucination" };
  }

  return { valid: true, reason: "ok" };
}

// Phrases that faster-whisper (especially tiny/base models) hallucinates from
// silence, breathing, or background noise. These are NOT real candidate
// answers — drop them before they reach the agent. Match is on the
// normalized (lowercased, punctuation-stripped, single-spaced) form.
const WHISPER_HALLUCINATION_PHRASES = new Set([
  "thank you",
  "thanks",
  "thank you very much",
  "thank you so much",
  "thanks for watching",
  "thanks for watching!",
  "thank you for watching",
  "subtitles by the amara org community",
  "i'll see you in the next video",
  "see you in the next video",
  "bye",
  "bye bye",
  "goodbye",
  "that's it",
  "that's all",
  "okay bye",
  "we are going to come home",
  "we're going to come home",
  "i think it is a good day now",
  "i think it's a good day now",
  "i think it's a good day now it's not a good day",
  "you",
  "yeah",
  "yeah yeah",
  "mm hmm",
  "mhm",
  "uh huh",
  "oh",
  "oh oh",
  "hello hello",
  "and i was beginning",
  "from the more than that is",
  "i'm going to say",
  // Short plausible-sounding fragments Whisper invents from silence/breath.
  // These are NOT real candidate answers — drop them.
  "you're on",
  "youre on",
  "you are on",
  "you're on it",
  "i'm on",
  "i'm on it",
  "let's go",
  "lets go",
  "go on",
  "come on",
  "i'm here",
  "i'm okay",
  "im okay",
  // Polite-apology hallucinations — Whisper's favourite fabrication shape
  // when the candidate is silent or breathing.
  "i'm sorry",
  "im sorry",
  "sorry",
  "i don't know",
  "i dont know",
  "i'm not sure",
  "im not sure",
  "not sure",
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
  // Polite-apology rambles: 2+ "I'm sorry / I don't know / I'm not sure"
  // clauses in the same segment with little else. Whisper produces these
  // from background noise + breath. Real candidate apologies almost never
  // chain like this.
  /\b(?:i'?m\s+sorry|i\s+don'?t\s+know|i'?m\s+not\s+sure)\b.*\b(?:i'?m\s+sorry|i\s+don'?t\s+know|i'?m\s+not\s+sure)\b/i,
  // "I think it's it" / "I think it is it" — impossible English structure
  // unique to Whisper hallucinations.
  /\bi\s+think\s+it'?s\s+it\b/i,
  // "I don't know if you go out of it" / "if I go out of it" — Whisper
  // signature filler chain with no semantic content.
  /\b(?:i\s+don'?t\s+know\s+)?if\s+(?:you|i|we|they)\s+go\s+(?:out\s+of\s+it|on)\b/i,
  // "I'm just a lot of me" / "I'm just a lot of [pronoun]" — nonsense
  // pattern Whisper emits from silence.
  /\bi'?m\s+just\s+a\s+lot\s+of\s+(?:me|you|us|them|him|her)\b/i,
  // Three+ "I" / "I'm" tokens in a short window with no concrete nouns —
  // strong rambling hallucination signal.
  /\b(?:i|i'?m)\s+\S+\s+(?:i|i'?m)\s+\S+\s+(?:i|i'?m)\s+\S+\s+(?:i|i'?m)\b/i,
];

const normalizeAgentLanguage = (value, fallback = "en") => {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (
    normalized.startsWith("fr") ||
    normalized === "french" ||
    normalized === "français" ||
    normalized === "francais"
  )
    return "fr";
  if (
    normalized.startsWith("en") ||
    normalized === "english" ||
    normalized === "anglais"
  )
    return "en";
  return fallback;
};

const detectRequestedAgentLanguage = (text) => {
  const normalized = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return null;

  const frenchSignals = [
    "speak french",
    "speak frensh",
    "ask me in french",
    "ask me in frensh",
    "continue in french",
    "turn this convo in french",
    "turn this convo in frensh",
    "turn this conversation in french",
    "turn this conversation in frensh",
    "french language",
    "frensh language",
    "parle francais",
    "parlez francais",
    "en francais",
    "francais stp",
    "francais svp",
  ];
  if (frenchSignals.some((phrase) => normalized.includes(phrase))) return "fr";

  const englishSignals = [
    "speak english",
    "ask me in english",
    "continue in english",
    "parle anglais",
    "en anglais",
  ];
  if (englishSignals.some((phrase) => normalized.includes(phrase))) return "en";

  return null;
};

const isWhisperHallucination = (text) => {
  const raw = String(text || "");
  const cleaned = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, " ")
    .replaceAll(/\s+/g, " ")
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
  const tokens = cleaned.split(" ");
  if (tokens.length >= 2 && tokens.length <= 12) {
    const unique = new Set(tokens);
    if (unique.size === 1) return true;
    // "thank you" repeated as a 2-gram across the whole string
    if (unique.size === 2 && tokens.length % 2 === 0) {
      const bigram = `${tokens[0]} ${tokens[1]}`;
      if (WHISPER_HALLUCINATION_PHRASES.has(bigram)) {
        const allMatch = tokens.every(
          (tok, i) => tok === (i % 2 === 0 ? tokens[0] : tokens[1]),
        );
        if (allMatch) return true;
      }
    }
  }

  return false;
};

const normalizeForEcho = (s) =>
  String(s || "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();

const isLikelyEcho = (sttText, agentText) => {
  const a = normalizeForEcho(sttText);
  const b = normalizeForEcho(agentText);
  if (!a || !b) return false;
  if (b.includes(a) || a.includes(b)) return true;
  const aTokens = new Set(a.split(" "));
  const bTokens = new Set(b.split(" "));
  if (aTokens.size < 3) return false;
  let overlap = 0;
  aTokens.forEach((t) => {
    if (bTokens.has(t)) overlap += 1;
  });
  return overlap / aTokens.size >= 0.7;
};

const hasSentenceEnding = (text) =>
  /[.!?…]\s*$/.test(String(text || "").trim());

const normalizeTranscriptText = (text) =>
  String(text || "")
    .replaceAll(/\s+/g, " ")
    .replaceAll(/[“”]/g, '"')
    .replaceAll("’", "'")
    .trim();

const stripLeadingTranscriptNoise = (text) =>
  normalizeTranscriptText(text)
    .replace(
      /^(?:thank you(?: very much)?|thanks|positive|negative|neutral)(?:[.!?,:;\s]+)(?=\S)/i,
      "",
    )
    .trim();

const collapseRepeatedTokens = (text, maxRepeat = 2) => {
  const tokens = normalizeTranscriptText(text).split(" ");
  if (!tokens.length) return "";

  const out = [];
  let prev = "";
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
  return out.join(" ").trim();
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
  if (cleaned.length >= STT_MIN_FINAL_CHARS && hasSentenceEnding(cleaned))
    return true;
  return false;
};

const collectSttCustomTerms = (room) => {
  if (!room) return [];

  const bag = [];
  const push = (value) => {
    const text = String(value || "").trim();
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
    const normalized = term.replaceAll(/\s+/g, " ").trim();
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
  const directText = String(direct?.text || "").trim();
  if (directText) {
    return {
      text: directText,
      sentiment: payload?.overall_sentiment || { label: "NEUTRAL", score: 0 },
      avgLogprob:
        typeof direct?.avg_logprob === "number" ? direct.avg_logprob : null,
      noSpeechProb:
        typeof direct?.no_speech_prob === "number"
          ? direct.no_speech_prob
          : null,
    };
  }

  // Backend voice route normalized payload shape.
  const apiText = String(payload?.text || "").trim();
  const sentimentFromSummary = payload?.summary?.sentiment;
  const sentiment = sentimentFromSummary ||
    payload?.overall_sentiment || { label: "NEUTRAL", score: 0 };

  return {
    text: apiText,
    sentiment,
    avgLogprob:
      typeof payload?.avg_logprob === "number" ? payload.avg_logprob : null,
    noSpeechProb:
      typeof payload?.no_speech_prob === "number"
        ? payload.no_speech_prob
        : null,
  };
};

const isTokenExpired = (jwtToken) => {
  if (!jwtToken) return true;

  try {
    const payload = JSON.parse(atob(jwtToken.split(".")[1] || ""));
    if (!payload?.exp) return true;
    return payload.exp * 1000 <= Date.now();
  } catch {
    return true;
  }
};

function captureFaceCheckFrame(videoEl, quality = 0.58) {
  if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
  const maxWidth = 320;
  const scale = Math.min(1, maxWidth / videoEl.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(videoEl.videoWidth * scale);
  canvas.height = Math.round(videoEl.videoHeight * scale);
  canvas.getContext("2d").drawImage(videoEl, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", quality);
}

function isGoodFaceVerificationFrame(status) {
  if (!status) return false;
  if (!status.facePresent || status.multipleFaces) return false;
  if (status.lightingQuality === "poor") return false;
  return true;
}

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
  // null = not yet verified, 'matched' = ok to start, mismatch/uncertain/error states block.
  const [faceVerifStatus, setFaceVerifStatus] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const webcamVideoRef = useRef(null);
  const webcamStreamRef = useRef(null);
  const fullRecordingStreamRef = useRef(null);
  const elapsedTimerRef = useRef(null);
  const conversationRef = useRef(null);
  const latestVisionStatusRef = useRef(null);
  const faceRecheckTimerRef = useRef(null);

  const fullRecorderRef = useRef(null); // single long-running recorder (full call)
  const allAudioChunksRef = useRef([]); // chunks from the full recorder
  const allMimeTypeRef = useRef(""); // mimeType for the full recording blob
  const streamRef = useRef(null);
  const socketRef = useRef(null);
  const recordingActiveRef = useRef(false);
  const lastTranscriptRef = useRef("");

  // VAD-based utterance recorder (per-utterance, not per-slice)
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  // Dedicated clone of the mic track for the VAD analyser. It is never muted,
  // so toggling the main track's .enabled for TTS can't leave the analyser
  // stuck reading silence (a known Chromium MediaStreamAudioSourceNode bug).
  const vadAnalyserTrackRef = useRef(null);
  const vadLogAtRef = useRef(0);
  const vadTimerRef = useRef(null);
  const utteranceRecorderRef = useRef(null);
  const utteranceChunksRef = useRef([]);
  const utteranceMimeRef = useRef("");
  const utteranceStartedAtRef = useRef(0);
  const utteranceDurationMsRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const isInUtteranceRef = useRef(false);
  const roomDbIdRef = useRef(null);
  const isRHRef = useRef(false);
  const latestAgentTtsRef = useRef(null);
  const activeAgentAudioRef = useRef(null);
  const activeAgentAudioUrlRef = useRef("");
  const latestAgentTtsRequestIdRef = useRef(0);
  const lastAgentVoiceKeyRef = useRef("");
  const agentLanguageRef = useRef("en");
  const agentTtsFallbackTimerRef = useRef(null);
  // Single-flight TTS lock: prevents double TTS playback when agent:tts
  // and a local fallback fetch both try to play for the same turn.
  const ttsInProgressRef = useRef(false);
  const activeTtsMessageIdRef = useRef(null);
  // When the Streamoji avatar widget reports ready, it stores its imperative
  // actions ({ avatarSpeak, replayAvatarSpeak, ... }) here. The primary
  // voice path is the local backend TTS pipeline; this ref is kept for
  // avatar lip-sync compatibility.
  const streamojiActionsRef = useRef(null);
  const streamojiSpeakKeyRef = useRef("");

  // STT → Agent auto-send: finalize after N ms of silence
  const lastSttSegmentRef = useRef(null);
  const sttSilenceTimerRef = useRef(null);
  const sttLastSentIdRef = useRef(null); // track sent segments to avoid duplicates
  // Hold the mic muted briefly after the agent's TTS audio ends so the
  // speaker's acoustic tail can't be transcribed as the candidate.
  const postTtsDeadZoneTimerRef = useRef(null);
  const postTtsDeadZoneActiveRef = useRef(false);
  const ttsEndedAtRef = useRef(0);
  const isTtsPlayingRef = useRef(false);
  const sttPendingReplyRef = useRef({
    text: "",
    sentiment: null,
    startedAt: 0,
    updatedAt: 0,
    meta: null,
  });
  const introKickoffTimerRef = useRef(null);
  const introKickoffAttemptsRef = useRef(0);
  const introStartRequestedRef = useRef(false);
  const agentSessionReadyRef = useRef(false);
  const lastHandledAgentMsgKeyRef = useRef("");
  const lastPlayedTtsVoiceKeyRef = useRef("");
  const agentSpeakingRef = useRef(false);
  const agentThinkingRef = useRef(false); // waiting for agent reply after we sent candidate-turn
  const lastAgentTextRef = useRef("");
  const recentAgentTextsRef = useRef([]); // rolling window for echo filtering
  const turnStateRef = useRef("candidate_listening");
  const currentQuestionIdRef = useRef("");
  const lastSubmittedQuestionIdRef = useRef("");
  const lastSubmittedAnswerHashRef = useRef("");
  const lastSubmittedAnswerAtRef = useRef(0);
  const pendingCandidateTurnRef = useRef(null);
  const agentTurnStallTimerRef = useRef(null);
  const isTypingAnswerRef = useRef(false);
  const recentSubmittedAnswerHashesRef = useRef(new Map());
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [agentThinking, setAgentThinking] = useState(false);
  const [draftText, setDraftText] = useState(""); // live in-progress STT for chat bubble
  const [turnState, setTurnState] = useState("candidate_listening");
  const [recoverableAgentError, setRecoverableAgentError] = useState("");
  const [agentRetrying, setAgentRetrying] = useState(false);
  const [lastAgentMessageText, setLastAgentMessageText] = useState("");

  const setInterviewTurnState = (nextState, reason = "") => {
    const oldState = turnStateRef.current;
    if (oldState === nextState) return;
    turnStateRef.current = nextState;
    setTurnState(nextState);
    console.log(
      `[TurnState] ${oldState} -> ${nextState}${reason ? ` (${reason})` : ""}`,
    );
    if (nextState === "agent_speaking") {
      console.log("[TurnState] agent_speaking: muting STT");
    }
    if (nextState === "candidate_listening") {
      console.log("[TurnState] candidate_listening: accepting STT");
    }
  };

  const clearVoiceDraft = (reason = "") => {
    if (sttSilenceTimerRef.current) {
      clearTimeout(sttSilenceTimerRef.current);
      sttSilenceTimerRef.current = null;
    }
    sttPendingReplyRef.current = {
      text: "",
      sentiment: null,
      startedAt: 0,
      updatedAt: 0,
      meta: null,
    };
    setDraftText("");
    socketRef.current?.emit("candidate:draft", {
      roomId,
      roomDbId: roomDbIdRef.current,
      text: "",
    });
    if (reason) console.log(`[STT] voice draft cleared: ${reason}`);
  };

  const clearAgentTurnStallTimer = () => {
    if (agentTurnStallTimerRef.current) {
      clearTimeout(agentTurnStallTimerRef.current);
      agentTurnStallTimerRef.current = null;
    }
  };

  const canAcceptSttNow = () => {
    const now = Date.now();
    const state = turnStateRef.current;
    if (
      agentSpeakingRef.current ||
      isTtsPlayingRef.current ||
      state === "agent_speaking"
    ) {
      return { ok: false, reason: "during_tts" };
    }
    if (
      agentThinkingRef.current ||
      state === "agent_thinking" ||
      state === "candidate_submitting"
    ) {
      return { ok: false, reason: "agent_busy" };
    }
    if (
      now < ttsEndedAtRef.current + POST_TTS_MIC_DEAD_ZONE_MS ||
      postTtsDeadZoneActiveRef.current
    ) {
      return { ok: false, reason: "post_tts_dead_zone" };
    }
    if (isTypingAnswerRef.current) {
      return { ok: false, reason: "typed_answer_in_progress" };
    }
    return { ok: true, reason: "ok" };
  };

  const shouldBlockDuplicateAnswer = (
    answerHash,
    questionId,
    { retry = false } = {},
  ) => {
    if (retry) return { blocked: false, reason: "retry" };
    const now = Date.now();
    const recent = recentSubmittedAnswerHashesRef.current;
    for (const [hash, sentAt] of recent.entries()) {
      if (now - sentAt > 10000) recent.delete(hash);
    }
    if (
      lastSubmittedQuestionIdRef.current &&
      lastSubmittedQuestionIdRef.current === questionId
    ) {
      return {
        blocked: true,
        reason: `question_already_submitted_${questionId}`,
      };
    }
    if (
      answerHash &&
      (recent.has(answerHash) ||
        (lastSubmittedAnswerHashRef.current === answerHash &&
          now - lastSubmittedAnswerAtRef.current < 10000))
    ) {
      return { blocked: true, reason: "same_answer_recently_sent" };
    }
    if (
      pendingCandidateTurnRef.current?.turnId ||
      agentThinkingRef.current ||
      turnStateRef.current === "agent_thinking"
    ) {
      return { blocked: true, reason: "agent_thinking" };
    }
    return { blocked: false, reason: "ok" };
  };

  const emitCandidateTurnWithAck = (payload) =>
    new Promise((resolve, reject) => {
      const sock = socketRef.current;
      if (!sock?.connected) {
        reject(new Error("Socket is not connected"));
        return;
      }

      const onAck = (err, response) => {
        if (err) {
          reject(
            err instanceof Error
              ? err
              : new Error(err?.message || "candidate turn ack timeout"),
          );
          return;
        }
        resolve(response || {});
      };

      if (typeof sock.timeout === "function") {
        sock.timeout(10000).emit("agent:candidate-turn", payload, onAck);
        return;
      }

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("candidate turn ack timeout"));
      }, 10000);

      sock.emit("agent:candidate-turn", payload, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response || {});
      });
    });

  const startAgentTurnStallTimer = (turnId) => {
    clearAgentTurnStallTimer();
    const turnSentAt = Date.now();
    agentTurnStallTimerRef.current = setTimeout(() => {
      if (
        !agentThinkingRef.current ||
        pendingCandidateTurnRef.current?.turnId !== turnId
      )
        return;
      console.error(
        `[AgentTurn] failed final turnId=${turnId} reason=no_agent_response_${Math.round(
          (Date.now() - turnSentAt) / 1000,
        )}s`,
      );
      setRecoverableAgentError(
        "The interviewer response was interrupted. You can retry the AI response.",
      );
      setInterviewTurnState("error_recoverable", "agent response timeout");
      agentThinkingRef.current = false;
      setAgentThinking(false);
      emitAgentThinkingState(false);
      if (recordingActiveRef.current && !agentSpeakingRef.current) {
        setMicEnabled(true);
      }
    }, AGENT_TURN_STALL_MS);
  };

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
      if (introKickoffAttemptsRef.current >= 6 || !recordingActiveRef.current)
        return;
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
    console.log(
      prepare
        ? "Preparing interview intro voice"
        : "Requesting interview intro from candidate start",
    );
    socket.emit("agent:start-session", {
      roomId,
      roomDbId: roomDbIdRef.current,
      phase: "intro",
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

  const token = localStorage.getItem("token");
  const userId = localStorage.getItem("userId");

  useIntegrityEvents({
    active: isRecording && cameraOn && !isRH,
    interviewId: roomDbId,
    questionId: room?.currentQuestion || "",
    token,
    apiBase: API_BASE,
    visionState: visionStatus,
    videoRef: webcamVideoRef,
  });

  useEffect(() => {
    latestVisionStatusRef.current = visionStatus;
  }, [visionStatus]);

  useEffect(() => {
    if (
      !isRecording ||
      !cameraOn ||
      isRH ||
      faceVerifStatus !== "matched" ||
      !roomId ||
      !token
    ) {
      if (faceRecheckTimerRef.current) {
        clearInterval(faceRecheckTimerRef.current);
        faceRecheckTimerRef.current = null;
      }
      return undefined;
    }

    const runPeriodicFaceCheck = async () => {
      const status = latestVisionStatusRef.current;
      if (!isGoodFaceVerificationFrame(status)) return;

      const frame = captureFaceCheckFrame(webcamVideoRef.current);
      if (!frame) return;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5500);
        const response = await fetch(
          `${API_BASE}/api/call-rooms/${roomId}/face-verify/check`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ frame }),
            signal: controller.signal,
          },
        );
        clearTimeout(timeoutId);
        const data = await response.json().catch(() => null);
        if (data?.pauseInterview) {
          setFaceVerifStatus("not_matched");
          setRecoverableAgentError("Identity check needs recruiter review.");
          setTimeout(() => setRecoverableAgentError(""), 5000);
        }
      } catch (error) {
        console.warn(
          "[FaceVerify/check] periodic check failed:",
          error?.message || error,
        );
      }
    };

    faceRecheckTimerRef.current = setInterval(
      runPeriodicFaceCheck,
      FACE_RECHECK_INTERVAL_MS,
    );
    return () => {
      clearInterval(faceRecheckTimerRef.current);
      faceRecheckTimerRef.current = null;
    };
  }, [isRecording, cameraOn, isRH, faceVerifStatus, roomId, token]);

  const emitAgentThinkingState = (thinking) => {
    globalThis.dispatchEvent(
      new CustomEvent("agent-thinking", { detail: { thinking } }),
    );
  };

  const emitAgentSpeechState = (speaking, text = "", extras = {}) => {
    globalThis.dispatchEvent(
      new CustomEvent("agent-speech", {
        detail: { speaking, text, ...extras },
      }),
    );
  };

  const markAgentThinking = (thinking, reason = "") => {
    agentThinkingRef.current = thinking;
    setAgentThinking(thinking);
    emitAgentThinkingState(thinking);
    if (thinking) {
      setInterviewTurnState("agent_thinking", reason || "agent generating");
      setMicEnabled(false);
    }
  };

  const submitCandidateTurn = async ({
    text,
    source = "voice",
    sentiment = null,
    sttMeta = null,
    retry = false,
    retryAttempt = 0,
    turnId: existingTurnId = "",
    suppressLocalMessage = false,
  }) => {
    const answerSource = source === "typed" ? "typed" : "voice";
    const answerText = normalizeTranscriptText(text);
    if (!answerText) return false;

    if (containsProfanity(answerText)) {
      console.warn(`[AgentTurn] blocked profanity source=${answerSource}`);
      setRecoverableAgentError(
        "Please avoid inappropriate language in your answer.",
      );
      setInterviewTurnState("candidate_listening", "profanity blocked");
      if (answerSource === "typed") {
        isTypingAnswerRef.current = false;
      }
      setTimeout(() => setRecoverableAgentError(""), 3500);
      return false;
    }

    if (answerSource === "typed") {
      isTypingAnswerRef.current = false;
      clearVoiceDraft("typed answer submitted");
    }

    const validation = isValidCandidateAnswer(answerText, {
      ...(sttMeta || {}),
      source: answerSource,
    });
    if (!validation.valid) {
      console.log(
        `[STT] rejected reason=${validation.reason} text="${answerText}"`,
      );
      return false;
    }

    const questionId =
      currentQuestionIdRef.current ||
      `question:${candidateAnswerHash(lastAgentTextRef.current || room?.currentQuestion || "intro")}`;
    const answerHash = candidateAnswerHash(answerText);
    const duplicate = shouldBlockDuplicateAnswer(answerHash, questionId, {
      retry,
    });
    if (duplicate.blocked) {
      console.log(`[AgentTurn] duplicate blocked reason=${duplicate.reason}`);
      return false;
    }

    if (!agentSessionReadyRef.current && !retry) {
      console.log("[AgentTurn] blocked reason=agent_session_not_ready");
      return false;
    }

    const requestedLanguage = detectRequestedAgentLanguage(answerText);
    if (requestedLanguage) {
      agentLanguageRef.current = requestedLanguage;
    }

    const turnId =
      existingTurnId ||
      `turn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const payload = {
      roomId,
      roomDbId: roomDbIdRef.current,
      questionId,
      turnId,
      answerText,
      answerSource,
      text: answerText,
      source: answerSource,
      sentiment,
      requestedLanguage,
      timestamp: Date.now(),
      retryAttempt,
    };

    pendingCandidateTurnRef.current = {
      ...payload,
      sentiment,
      sttMeta,
      retryCount: retryAttempt,
      answerHash,
      localMessageShown: suppressLocalMessage,
    };

    lastSubmittedQuestionIdRef.current = questionId;
    lastSubmittedAnswerHashRef.current = answerHash;
    lastSubmittedAnswerAtRef.current = Date.now();
    recentSubmittedAnswerHashesRef.current.set(answerHash, Date.now());

    clearVoiceDraft("candidate turn submitted");
    setRecoverableAgentError("");
    setAgentRetrying(retryAttempt > 0);
    setInterviewTurnState("candidate_submitting", `${answerSource} submit`);
    agentThinkingRef.current = true;
    setAgentThinking(true);
    emitAgentThinkingState(true);
    setMicEnabled(false);

    if (!suppressLocalMessage) {
      globalThis.dispatchEvent(
        new CustomEvent("candidate-local-message", {
          detail: {
            text: answerText,
            sentiment,
            source: answerSource,
            ts: Date.now(),
            turnId,
            questionId,
          },
        }),
      );
    }

    console.log(
      `[AgentTurn] submit start turnId=${turnId} questionId=${questionId} source=${answerSource}`,
    );

    try {
      const ack = await emitCandidateTurnWithAck(payload);
      if (!ack?.ok) {
        throw new Error(ack?.message || "Candidate turn was not accepted");
      }
      console.log(
        `[AgentTurn] ack received turnId=${turnId}${ack.duplicate ? " duplicate=true" : ""}`,
      );
      setInterviewTurnState("agent_thinking", "agent ack received");
      startAgentTurnStallTimer(turnId);
      return true;
    } catch (error) {
      console.warn(
        `[AgentTurn] failed final turnId=${turnId} reason=${error?.message || error}`,
      );
      if (
        /inappropriate language|PROFANITY_BLOCKED/i.test(
          String(error?.message || error),
        )
      ) {
        setRecoverableAgentError(
          "Please avoid inappropriate language in your answer.",
        );
        setInterviewTurnState("candidate_listening", "profanity blocked");
        agentThinkingRef.current = false;
        setAgentThinking(false);
        emitAgentThinkingState(false);
        setAgentRetrying(false);
        setTimeout(() => setRecoverableAgentError(""), 3500);
        return false;
      }
      setRecoverableAgentError(
        "The interviewer response was interrupted. You can retry the AI response.",
      );
      setInterviewTurnState(
        "error_recoverable",
        "candidate turn submit failed",
      );
      agentThinkingRef.current = false;
      setAgentThinking(false);
      emitAgentThinkingState(false);
      setAgentRetrying(false);
      if (recordingActiveRef.current && !agentSpeakingRef.current) {
        setMicEnabled(true);
      }
      return false;
    }
  };

  const retryPendingAgentTurn = () => {
    const pending = pendingCandidateTurnRef.current;
    if (!pending?.turnId || !pending?.answerText) return;
    const nextAttempt = Number(pending.retryCount || 0) + 1;
    console.log(
      `[AgentTurn] aborted retrying turnId=${pending.turnId} attempt=${nextAttempt}`,
    );
    setRecoverableAgentError(
      "The interviewer response was interrupted. Retrying...",
    );
    setAgentRetrying(true);
    void submitCandidateTurn({
      text: pending.answerText,
      source: pending.answerSource || pending.source || "voice",
      sentiment: pending.sentiment || null,
      sttMeta: pending.sttMeta || null,
      retry: true,
      retryAttempt: nextAttempt,
      turnId: pending.turnId,
      suppressLocalMessage: true,
    });
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
      activeAgentAudioUrlRef.current = "";
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

  const playAgentAudioBlob = async (
    blob,
    text,
    { announceStart = false } = {},
  ) => {
    if (!recordingActiveRef.current || isRHRef.current) {
      return false;
    }

    if (!(blob instanceof Blob) || blob.size <= 0) {
      return false;
    }

    stopAgentAudioPlayback();

    const objectUrl = URL.createObjectURL(blob);
    const audio = new Audio(objectUrl);
    audio.preload = "auto";
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
      const audioMs =
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : 0;
      console.log("[TTS] started");
      emitAgentSpeechState(true, text, audioMs ? { durationMs: audioMs } : {});
    };

    if (announceStart) {
      // If metadata is already available, announce now; otherwise wait once
      // for `loadedmetadata`. Cap the wait at 250 ms so a stuck/missing
      // metadata event never blocks the avatar from animating at all.
      if (
        audio.readyState >= 1 &&
        Number.isFinite(audio.duration) &&
        audio.duration > 0
      ) {
        announceWithDuration();
      } else {
        let announced = false;
        const announceOnce = () => {
          if (announced) return;
          announced = true;
          announceWithDuration();
        };
        audio.addEventListener("loadedmetadata", announceOnce, { once: true });
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
          activeAgentAudioUrlRef.current = "";
        }
        console.log("[TTS] ended");
        emitAgentSpeechState(false);
        if (!settled) {
          settled = true;
          resolve(true);
        }
      };

      audio.onended = finish;
      audio.onerror = () => {
        console.warn("Agent TTS playback failed");
        finish();
      };

      audio.play().catch((error) => {
        console.warn("Unable to autoplay agent TTS audio:", error);
        finish();
      });
    });
  };

  const fetchAgentTtsAudio = async (text) => {
    const language = normalizeAgentLanguage(
      agentLanguageRef.current,
      detectRequestedAgentLanguage(text) || "en",
    );
    // Do NOT specify provider — let the backend TTS service choose its default.
    // The Python speech stack defaults to Edge TTS (no API key required).
    // Hardcoding 'edge' here is unnecessary and causes Bing connection errors
    // when the stack falls back to a direct Bing call in restricted environments.
    const body = JSON.stringify({ text, language });

    try {
      const response = await fetch(`${SPEECH_STACK_URL}/api/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`[TTS] speech stack ${response.status}: ${errText}`);
      }

      return await response.blob();
    } catch (directError) {
      console.warn(
        "[TTS] direct speech stack unavailable, trying backend voice API:",
        directError?.message || directError,
      );

      const fallbackResponse = await fetch(`${VOICE_API_URL}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (!fallbackResponse.ok) {
        const fallbackErr = await fallbackResponse.text();
        throw new Error(
          `[TTS] backend voice API ${fallbackResponse.status}: ${fallbackErr}`,
        );
      }

      return await fallbackResponse.blob();
    }
  };

  const requestAgentTtsPlayback = async (text, voiceKey = "") => {
    const normalizedText = String(text || "").trim();
    if (!normalizedText || isRHRef.current) return;

    // ── Single-flight TTS lock ──────────────────────────────────────────────
    // If a TTS blob is already playing, do not start another.
    if (ttsInProgressRef.current) {
      console.log(
        "[TTS] requestAgentTtsPlayback: skipped (TTS already in progress)",
      );
      return;
    }

    const messageId = voiceKey || normalizedText.slice(0, 80);
    const requestId = Date.now() + Math.random();
    latestAgentTtsRequestIdRef.current = requestId;
    activeTtsMessageIdRef.current = messageId;

    if (voiceKey) {
      lastAgentVoiceKeyRef.current = voiceKey;
      // Mark this voiceKey as played so handleAgentTts won't double-play.
      lastPlayedTtsVoiceKeyRef.current = voiceKey;
    }

    stopAgentAudioPlayback();

    try {
      console.log(`[TTS] fetching local TTS for messageId=${messageId}`);
      const blob = await fetchAgentTtsAudio(normalizedText);

      // Stale check: a newer request superseded this one.
      if (requestId !== latestAgentTtsRequestIdRef.current) {
        console.log("[TTS] requestAgentTtsPlayback: stale request discarded");
        return;
      }
      // Also skip if agent:tts already started playing via handleAgentTts.
      if (
        ttsInProgressRef.current &&
        activeTtsMessageIdRef.current !== messageId
      ) {
        console.log(
          "[TTS] requestAgentTtsPlayback: different TTS already playing, discarding",
        );
        return;
      }

      ttsInProgressRef.current = true;
      latestAgentTtsRef.current = {
        blob,
        text: normalizedText,
        createdAt: Date.now(),
      };

      if (recordingActiveRef.current) {
        await playAgentAudioBlob(blob, normalizedText, { announceStart: true });
      }
    } catch (error) {
      if (requestId !== latestAgentTtsRequestIdRef.current) return;

      // ── TTS failure recovery ─────────────────────────────────────────────
      // TTS generation failed. Reset all speaking/playing flags so STT can
      // resume and the interview does not deadlock on agent_speaking state.
      console.error(
        "[TTS] local TTS generation failed:",
        error?.message || error,
      );
      ttsInProgressRef.current = false;
      activeTtsMessageIdRef.current = null;
      agentSpeakingRef.current = false;
      isTtsPlayingRef.current = false;
      latestAgentTtsRef.current = null;
      emitAgentSpeechState(false);
      // Transition immediately to candidate_listening so the mic re-enables.
      if (recordingActiveRef.current) {
        setInterviewTurnState("candidate_listening", "tts_failed_recovery");
        setMicEnabled(true);
      }
    } finally {
      ttsInProgressRef.current = false;
      activeTtsMessageIdRef.current = null;
    }
  };

  const playPreparedAgentTts = async () => {
    const latest = latestAgentTtsRef.current;
    if (!latest?.blob || isRHRef.current || !recordingActiveRef.current)
      return false;
    await playAgentAudioBlob(
      latest.blob,
      latest.text || room?.currentQuestion || "",
      { announceStart: true },
    );
    return true;
  };

  useEffect(() => {
    latestAgentTtsRequestIdRef.current += 1;
    lastAgentVoiceKeyRef.current = "";
    lastPlayedTtsVoiceKeyRef.current = "";
    agentLanguageRef.current = "en";
    latestAgentTtsRef.current = null;
    ttsInProgressRef.current = false;
    activeTtsMessageIdRef.current = null;
    clearAgentTtsFallback();
    stopAgentAudioPlayback({ emitStopped: true });
  }, [roomId]);

  // Fetch room details
  useEffect(() => {
    const fetchRoom = async () => {
      try {
        console.log("🔍 Fetching room details for roomId:", roomId);
        const response = await fetch(
          `${API_BASE}/api/call-rooms/by-room/${encodeURIComponent(roomId)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        console.log("🔍 Room fetch response status:", response.status);
        const data = await response.json();
        console.log("🔍 Room fetch response data:", data);
        if (data.success && data.room) {
          console.log("✅ Room loaded successfully:", data.room.roomId);
          const currentIsRH = data.room.initiator?._id === userId;
          setRoom(data.room);
          setRoomDbId(data.room._id);
          setIsRH(currentIsRH);
          setVisionReport(data.room.visionMonitoring?.report || null);
          if (
            !currentIsRH &&
            data.room.candidate &&
            data.room.candidate.faceProfile?.enrolled !== true
          ) {
            setFaceVerifStatus("not_enrolled");
          }
        } else {
          console.warn("❌ Room not found or invalid response:", data);
        }
      } catch (error) {
        console.error("❌ Failed to fetch room:", error);
      } finally {
        setLoading(false);
      }
    };

    if (roomId && token && userId) {
      fetchRoom();
    } else {
      console.log("⏭️ Skipping room fetch - missing:", {
        roomId: !!roomId,
        token: !!token,
        userId: !!userId,
      });
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

  // Capture Streamoji's imperative actions when its widget reports ready.
  // Local backend TTS is the primary voice path; Streamoji is kept for
  // avatar lip-sync compatibility only.
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
    globalThis.addEventListener("streamoji:ready", onReady);
    globalThis.addEventListener("streamoji:teardown", onTeardown);
    return () => {
      globalThis.removeEventListener("streamoji:ready", onReady);
      globalThis.removeEventListener("streamoji:teardown", onTeardown);
    };
  }, []);

  useEffect(() => {
    if (!token || isTokenExpired(token)) {
      console.log("⏭️ Skipping socket setup - missing or expired token");
      return undefined;
    }

    console.log("🔌 Setting up socket.io connection to:", API_BASE);
    socketRef.current = io(API_BASE, {
      auth: { token },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 3,
      reconnectionDelay: 1200,
    });
    setSocketClient(socketRef.current);

    socketRef.current.on("connect", () => {
      console.log("✅ Socket connected");
      // Candidate interview intro is started explicitly by the "Start Call" button.
    });

    socketRef.current.on("connect_error", (error) => {
      console.error("❌ Socket connection error:", error?.message);
      if (error?.message === "TOKEN_EXPIRED") {
        console.warn(
          "Socket session expired in active room. Please login again.",
        );
        socketRef.current?.disconnect();
      }
    });

    // Join room-specific channel
    console.log("📍 Emitting join-room with roomId:", roomId);
    socketRef.current.emit("join-room", { roomId });

    // Listen for transcription updates — auto-send finalized voice answers after silence
    const handleTranscriptionUpdate = ({ segment, sentiment }) => {
      if (!segment?.text) {
        console.log("[STT] rejected reason=empty_segment");
        return;
      }

      if (isRHRef.current) {
        setRoom((prev) => {
          if (!prev) return prev;

          const nextSegments = [
            ...(prev.transcription?.segments || []),
            segment,
          ];
          const nextText =
            `${prev.transcription?.text || ""} ${String(segment.text || "").trim()}`.trim();

          return {
            ...prev,
            transcription: {
              ...prev.transcription,
              text: nextText,
              segments: nextSegments,
              overallSentiment: sentiment ||
                prev.transcription?.overallSentiment || {
                  label: "NEUTRAL",
                  score: 0,
                },
            },
          };
        });
        return;
      }

      const gate = canAcceptSttNow();
      if (!gate.ok) {
        if (
          gate.reason === "during_tts" ||
          gate.reason === "post_tts_dead_zone"
        ) {
          console.log(`[STT] ignored during TTS reason=${gate.reason}`);
        } else {
          console.log(`[STT] rejected reason=${gate.reason}`);
        }
        return;
      }

      const nextText = stripLeadingTranscriptNoise(
        collapseRepeatedTokens(String(segment.text || "").trim()),
      );
      if (!nextText) return;
      if (isLowSignalSegment(nextText)) {
        console.log(`[STT] rejected reason=low_signal text="${nextText}"`);
        return;
      }

      // Drop common Whisper hallucinations ("Thank you.", "That's it.", "We're
      // going to come home.", etc.) before they ever reach the agent. tiny/base
      // models emit these from silence + room noise; treating them as real
      // candidate answers throws the conversation off the rails.
      if (isWhisperHallucination(nextText)) {
        console.log(
          `[STT] rejected reason=known_whisper_hallucination text="${nextText}"`,
        );
        return;
      }

      // Compare against a rolling window of the last 3 agent messages, not
      // just the most recent one, so late-arriving TTS chunks are still
      // filtered out after the agent has already moved to the next question.
      const agentPool = recentAgentTextsRef.current;
      if (agentPool.some((a) => isLikelyEcho(nextText, a))) {
        console.log(`[STT] rejected reason=agent_echo text="${nextText}"`);
        return;
      }

      const sttMeta = {
        source: "voice",
        avgLogprob:
          typeof segment.avgLogprob === "number"
            ? segment.avgLogprob
            : typeof segment.avg_logprob === "number"
              ? segment.avg_logprob
              : null,
        noSpeechProb:
          typeof segment.noSpeechProb === "number"
            ? segment.noSpeechProb
            : typeof segment.no_speech_prob === "number"
              ? segment.no_speech_prob
              : null,
        speechDurationMs: Number(
          segment.speechDurationMs || segment.durationMs || 0,
        ),
      };

      const pending = sttPendingReplyRef.current;
      let mergedText = nextText;
      if (pending.text) {
        mergedText = nextText.includes(pending.text)
          ? nextText
          : `${pending.text} ${nextText}`;
      }
      const normalizedMerged = normalizeTranscriptText(
        collapseRepeatedTokens(mergedText),
      );
      if (!normalizedMerged) return;

      console.log(`[STT] accepted candidate segment text="${nextText}"`);
      const now = Date.now();
      lastSttSegmentRef.current = {
        text: normalizedMerged,
        sentiment,
        timestamp: now,
        meta: sttMeta,
      };
      sttPendingReplyRef.current = {
        text: normalizedMerged,
        sentiment: sentiment || pending.sentiment || null,
        startedAt: pending.startedAt || now,
        updatedAt: now,
        meta: { ...(pending.meta || {}), ...sttMeta },
      };
      setInterviewTurnState("candidate_answering", "voice segment accepted");

      // Update the live draft bubble visible in the chat panel — local event
      // for the candidate view, socket broadcast for the RH dashboard.
      setDraftText(normalizedMerged);
      globalThis.dispatchEvent(
        new CustomEvent("candidate-draft-update", {
          detail: { text: normalizedMerged, sentiment },
        }),
      );
      socketRef.current?.emit("candidate:draft", {
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
          normalizeTranscriptText(
            collapseRepeatedTokens(String(current.text || "")),
          ),
        );
        if (finalText.length < STT_MIN_FINAL_TEXT_LEN) return;

        if (!isGoodFinalTranscript(finalText)) {
          console.log(
            `[STT] rejected reason=too_short_for_auto_send text="${finalText}"`,
          );
          clearVoiceDraft("voice answer too short");
          return;
        }

        const finalGate = canAcceptSttNow();
        if (!finalGate.ok) {
          console.log(
            `[STT] rejected reason=${finalGate.reason} text="${finalText}"`,
          );
          clearVoiceDraft("final gate closed");
          return;
        }

        const validation = isValidCandidateAnswer(finalText, {
          ...(current.meta || {}),
          source: "voice",
        });
        if (!validation.valid) {
          console.log(
            `[STT] rejected reason=${validation.reason} text="${finalText}"`,
          );
          clearVoiceDraft("voice answer failed validation");
          return;
        }

        const segmentId = candidateAnswerHash(finalText);
        if (sttLastSentIdRef.current === segmentId) {
          console.log("[STT] rejected reason=same_segment_already_sent");
          clearVoiceDraft("duplicate voice answer");
          return;
        }

        sttLastSentIdRef.current = segmentId;
        void submitCandidateTurn({
          text: finalText,
          source: "voice",
          sentiment: current.sentiment,
          sttMeta: current.meta || sttMeta,
        });
      }, STT_FINALIZE_SILENCE_MS);
    };

    socketRef.current.on("transcription-update", handleTranscriptionUpdate);

    // Listen for agent messages — update room state for candidate view
    const handleAgentMessage = ({
      text,
      skillFocus,
      difficulty,
      phase,
      turnIndex,
      language,
      turnId,
      questionId,
    }) => {
      // broadcastAgentMessage fans this event to both the room channel AND
      // the participant's direct socket. If the candidate is already in the
      // room they receive it twice. Drop the duplicate before any TTS or
      // state logic runs — a second event would re-arm the TTS fallback timer
      // after agent:tts already fired and cancelled it, causing double speech.
      const msgKey = `${turnIndex ?? "na"}::${String(text || "")
        .trim()
        .slice(0, 80)}`;
      if (msgKey && msgKey === lastHandledAgentMsgKeyRef.current) {
        console.log("[handleAgentMessage] duplicate dropped key=", msgKey);
        return;
      }
      lastHandledAgentMsgKeyRef.current = msgKey;

      agentSessionReadyRef.current = true;
      agentLanguageRef.current = normalizeAgentLanguage(
        language,
        agentLanguageRef.current,
      );
      clearIntroKickoffRetry();
      clearAgentTurnStallTimer();
      if (turnId) {
        console.log(`[AgentTurn] response received turnId=${turnId}`);
      }
      agentThinkingRef.current = false; // agent has replied — unlock on TTS end
      setAgentThinking(false);
      emitAgentThinkingState(false);
      pendingCandidateTurnRef.current = null;
      setRecoverableAgentError("");
      setAgentRetrying(false);
      lastAgentTextRef.current = text || "";
      setLastAgentMessageText(text || "");
      // The questionId we generate for the next candidate answer must be
      // distinct from the previous one — otherwise shouldBlockDuplicateAnswer
      // will reject the reply as "question_already_submitted_<id>". The
      // backend doesn't always send a stable questionId and turnIndex
      // sometimes lands on the same value across consecutive turns, so we
      // hash the agent's text + a fresh timestamp to guarantee uniqueness
      // per question.
      const nextQuestionKey = String(
        questionId ||
          (turnIndex != null
            ? `t${turnIndex}_${candidateAnswerHash(text || "")}`
            : "") ||
          candidateAnswerHash(text || `question-${Date.now()}`) ||
          `question-${Date.now()}`,
      );
      currentQuestionIdRef.current = nextQuestionKey;
      // The previous question is now answered — unblock the duplicate
      // detector so the candidate's reply to this new question isn't
      // silently dropped.
      lastSubmittedQuestionIdRef.current = "";
      lastSubmittedAnswerHashRef.current = "";
      lastSubmittedAnswerAtRef.current = 0;
      sttLastSentIdRef.current = "";
      if (text) {
        recentAgentTextsRef.current = [
          text,
          ...recentAgentTextsRef.current,
        ].slice(0, 3);
      }
      // Drop anything captured while the agent was composing its reply so
      // the next STT segment can't contain mixed audio.
      if (sttSilenceTimerRef.current) {
        clearTimeout(sttSilenceTimerRef.current);
        sttSilenceTimerRef.current = null;
      }
      clearVoiceDraft("agent message received");
      console.log("🤖 Agent message received:", text, {
        skillFocus,
        difficulty,
        phase,
        turnIndex,
        language: agentLanguageRef.current,
        turnId,
      });

      const normalizedText = String(text || "").trim();
      if (!isRHRef.current && normalizedText) {
        agentSpeakingRef.current = true;
        setAgentSpeaking(true);
        setInterviewTurnState("agent_speaking", "agent response received");
        setMicEnabled(false);
        const voiceKey = `${String(roomDbIdRef.current || roomId || "").trim()}::${turnIndex ?? "na"}::${normalizedText}`;
        lastAgentVoiceKeyRef.current = voiceKey;
        clearAgentTtsFallback();

        // Allow backend agent:tts to arrive first (via socket — same
        // connection, so it should arrive in order within a few ms). If
        // it does not arrive within AGENT_TTS_FALLBACK_MS, trigger a local
        // backend TTS fetch as a safety net. No external TTS vendors used.
        if (AGENT_TTS_FALLBACK_MS > 0) {
          console.log(
            `[TTS] waiting ${AGENT_TTS_FALLBACK_MS}ms for backend agent:tts...`,
          );
          agentTtsFallbackTimerRef.current = setTimeout(() => {
            // Only fire if agent:tts hasn't already played for this turn.
            if (
              lastAgentVoiceKeyRef.current === voiceKey &&
              lastPlayedTtsVoiceKeyRef.current !== voiceKey &&
              !ttsInProgressRef.current
            ) {
              console.log(
                `[TTS] agent:tts not received, triggering local TTS fallback`,
              );
              void requestAgentTtsPlayback(normalizedText, voiceKey);
            }
          }, AGENT_TTS_FALLBACK_MS);
        }
      }

      setRoom((prev) =>
        prev
          ? {
              ...prev,
              currentQuestion: text,
              currentSkill: skillFocus,
              currentDifficulty: difficulty,
              phase,
            }
          : null,
      );
    };
    socketRef.current.on("agent:message", handleAgentMessage);

    const handleAgentThinking = (payload) => {
      if (payload?.roomId && payload.roomId !== roomId) return;
      if (payload?.turnId) {
        console.log(`[AgentTurn] thinking received turnId=${payload.turnId}`);
      }
      agentThinkingRef.current = true;
      setAgentThinking(true);
      emitAgentThinkingState(true);
      setInterviewTurnState("agent_thinking", "backend thinking");
      setMicEnabled(false);
    };
    socketRef.current.on("agent:thinking", handleAgentThinking);

    const handleAgentTts = (payload) => {
      if (payload?.roomId && payload.roomId !== roomId) return;
      if (isRHRef.current) return;

      const spokenText = String(payload?.text || "").trim();
      const sourceText = String(
        payload?.sourceText || payload?.text || "",
      ).trim();
      if (!spokenText || !payload?.audioBase64) return;
      agentLanguageRef.current = normalizeAgentLanguage(
        payload?.language,
        agentLanguageRef.current,
      );

      const voiceKey = `${String(roomDbIdRef.current || roomId || "").trim()}::${payload?.turnIndex ?? "na"}::${sourceText || spokenText}`;
      if (
        lastAgentVoiceKeyRef.current &&
        lastAgentVoiceKeyRef.current !== voiceKey
      ) {
        return;
      }

      // Dedup: a second agent:tts for the same turn (can happen when both the
      // RH panel and candidate view both trigger agent:start-session) must not
      // play again after the first one already started playback.
      if (lastPlayedTtsVoiceKeyRef.current === voiceKey) {
        console.log(
          "[handleAgentTts] duplicate TTS dropped voiceKey=",
          voiceKey,
        );
        return;
      }
      lastPlayedTtsVoiceKeyRef.current = voiceKey;

      // Cancel any in-flight local fallback fetch so it doesn't race.
      latestAgentTtsRequestIdRef.current += 1;
      clearAgentTtsFallback();

      // ── Single-flight TTS lock ─────────────────────────────────────────────
      if (ttsInProgressRef.current) {
        console.log("[TTS] handleAgentTts: skipped (TTS already in progress)");
        return;
      }
      ttsInProgressRef.current = true;
      activeTtsMessageIdRef.current = voiceKey;

      try {
        const binary = globalThis.atob(payload.audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }

        const blob = new Blob([bytes], {
          type: payload.contentType || "audio/wav",
        });
        latestAgentTtsRef.current = {
          blob,
          text: spokenText,
          sourceText,
          createdAt: Date.now(),
        };
        console.log(`[TTS] playing backend TTS voiceKey=${voiceKey}`);
        // Play backend TTS immediately. recordingActiveRef check is intentionally
        // skipped so the agent introduces themselves before Start Call is clicked.
        void playAgentAudioBlob(blob, spokenText, { announceStart: true });
      } catch (error) {
        // ── TTS decode failure ────────────────────────────────────────────
        // Do NOT call requestAgentTtsPlayback here — that risks infinite recursion.
        // Instead, recover state cleanly so the interview continues without audio.
        console.error(
          "[TTS] backend TTS decode/play failed:",
          error?.message || error,
        );
        ttsInProgressRef.current = false;
        activeTtsMessageIdRef.current = null;
        agentSpeakingRef.current = false;
        isTtsPlayingRef.current = false;
        emitAgentSpeechState(false);
        if (recordingActiveRef.current) {
          setInterviewTurnState(
            "candidate_listening",
            "backend_tts_decode_failed",
          );
          setMicEnabled(true);
        }
      } finally {
        ttsInProgressRef.current = false;
        activeTtsMessageIdRef.current = null;
      }
    };
    socketRef.current.on("agent:tts", handleAgentTts);

    const handleAgentTtsUnavailable = (payload) => {
      if (payload?.roomId && payload.roomId !== roomId) return;
      if (isRHRef.current) return;
      const fallbackText = String(payload?.text || "").trim();
      if (!fallbackText) return;
      agentLanguageRef.current = normalizeAgentLanguage(
        payload?.language,
        agentLanguageRef.current,
      );
      clearAgentTtsFallback();
      void requestAgentTtsPlayback(fallbackText);
    };
    socketRef.current.on("agent:tts-unavailable", handleAgentTtsUnavailable);

    // Recover from a failed turn: NIM occasionally returns 502/timeout. When
    // that happens, agentThinkingRef would otherwise stay true forever and
    // every subsequent STT segment would be dropped (mic stuck muted, the
    // interview "stops"). Reset the thinking lock and re-enable the mic so
    // the candidate can simply try again.
    const handleAgentError = (payload) => {
      const rawMessage = String(payload?.message || "");
      const code =
        payload?.code ||
        (/abort/i.test(rawMessage) ? "AGENT_ABORTED" : "AGENT_FAILED");
      const turnId =
        payload?.turnId || pendingCandidateTurnRef.current?.turnId || "";
      console.warn(
        `[AgentTurn] failed final turnId=${turnId || "unknown"} code=${code}`,
      );
      clearAgentTurnStallTimer();

      const pending = pendingCandidateTurnRef.current;
      if (code === "FACE_VERIFICATION_REQUIRED") {
        setFaceVerifStatus(
          payload?.status === "not_enrolled" ? "not_enrolled" : null,
        );
        if (
          recordingActiveRef.current ||
          fullRecorderRef.current?.state === "recording"
        ) {
          stopRecording();
        } else {
          setMicEnabled(false);
        }
        setInterviewStarting(false);
        setRecoverableAgentError(
          payload?.message ||
            "Face verification must be matched before starting the interview.",
        );
        setInterviewTurnState(
          "error_recoverable",
          "face verification required",
        );
        return;
      }

      const retryableAbort =
        ["AGENT_ABORTED", "AGENT_TIMEOUT"].includes(code) &&
        payload?.retryable !== false;
      if (
        retryableAbort &&
        pending?.turnId &&
        Number(pending.retryCount || 0) < 1
      ) {
        setRecoverableAgentError(
          "The interviewer response was interrupted. Retrying...",
        );
        setInterviewTurnState("error_recoverable", "agent aborted");
        setAgentRetrying(true);
        setTimeout(() => {
          retryPendingAgentTurn();
        }, 500);
        return;
      }

      agentThinkingRef.current = false;
      setAgentThinking(false);
      emitAgentThinkingState(false);
      setAgentRetrying(false);
      setRecoverableAgentError(
        payload?.retryable
          ? "The interviewer response was interrupted. You can retry the AI response."
          : "The interviewer response failed. Please try again.",
      );
      setInterviewTurnState("error_recoverable", "agent error");
      if (recordingActiveRef.current && !agentSpeakingRef.current) {
        setMicEnabled(true);
      }
    };
    socketRef.current.on("agent:error", handleAgentError);

    // Candidate-side: AgentChatPanel emits 'agent-speech' around each TTS
    // utterance. We mute STT while the agent is speaking so the AI's own
    // voice doesn't feed back as the candidate's answer.
    const handleAgentSpeech = (ev) => {
      const speaking = !!ev?.detail?.speaking;
      agentSpeakingRef.current = speaking;
      setAgentSpeaking(speaking);

      if (speaking) {
        isTtsPlayingRef.current = true;
        setInterviewTurnState("agent_speaking", "tts started");
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
        clearVoiceDraft("agent tts started");
        return;
      }

      // ── TTS ended — release all TTS locks ──────────────────────────────────
      isTtsPlayingRef.current = false;
      ttsInProgressRef.current = false;
      activeTtsMessageIdRef.current = null;
      ttsEndedAtRef.current = Date.now();
      console.log(
        "[TTS] ended; releasing TTS lock and resetting speaking state",
      );
      // TTS just finished — the agent's turn is over. Clear thinking flag so
      // the mic-reenable check below doesn't get stuck.
      agentThinkingRef.current = false;
      setAgentThinking(false);
      emitAgentThinkingState(false);
      // Speech just ended. Hold the mic muted for POST_TTS_MIC_DEAD_ZONE_MS
      // so speaker tail / room reverb can't be transcribed as a candidate answer.
      if (postTtsDeadZoneTimerRef.current) {
        clearTimeout(postTtsDeadZoneTimerRef.current);
      }
      postTtsDeadZoneActiveRef.current = true;
      setMicEnabled(false);
      postTtsDeadZoneTimerRef.current = setTimeout(() => {
        postTtsDeadZoneTimerRef.current = null;
        postTtsDeadZoneActiveRef.current = false;
        // Re-enable STT: explicitly unlock so the first candidate voice
        // response always works, even after the very first question.
        agentSpeakingRef.current = false;
        if (recordingActiveRef.current && !agentThinkingRef.current) {
          setMicEnabled(true);
          console.log(
            "[VoiceLifecycle] post-TTS dead zone ended → candidate_listening (STT active)",
          );
          setInterviewTurnState(
            "candidate_listening",
            "post-tts dead zone ended",
          );
        }
      }, POST_TTS_MIC_DEAD_ZONE_MS);
    };
    globalThis.addEventListener("agent-speech", handleAgentSpeech);

    // Listen for call end
    socketRef.current.on("call-room-ended", () => {
      alert("Call ended by other party");
      // Redirect or close
    });

    return () => {
      recordingActiveRef.current = false;
      latestAgentTtsRequestIdRef.current += 1;
      lastAgentVoiceKeyRef.current = "";
      latestAgentTtsRef.current = null;
      clearAgentTtsFallback();
      clearAgentTurnStallTimer();
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
        text: "",
        sentiment: null,
        startedAt: 0,
        updatedAt: 0,
        meta: null,
      };
      pendingCandidateTurnRef.current = null;
      agentSessionReadyRef.current = false;
      lastHandledAgentMsgKeyRef.current = "";
      lastPlayedTtsVoiceKeyRef.current = "";
      stopVad();
      if (fullRecorderRef.current?.state === "recording") {
        fullRecorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      globalThis.removeEventListener("agent-speech", handleAgentSpeech);
      socketRef.current?.off("transcription-update");
      socketRef.current?.off("agent:message");
      socketRef.current?.off("agent:thinking");
      socketRef.current?.off("agent:tts");
      socketRef.current?.off("agent:tts-unavailable");
      socketRef.current?.off("agent:error");
      socketRef.current?.off("call-room-ended");
      socketRef.current?.off("connect");
      socketRef.current?.disconnect();
      socketRef.current?.off("connect_error");
      socketRef.current?.off("transcription-update", handleTranscriptionUpdate);
      socketRef.current?.off("agent:message", handleAgentMessage);
      socketRef.current?.off("agent:thinking", handleAgentThinking);
      socketRef.current?.off("agent:tts", handleAgentTts);
      socketRef.current?.off(
        "agent:tts-unavailable",
        handleAgentTtsUnavailable,
      );
      socketRef.current?.off("agent:error", handleAgentError);
      socketRef.current?.disconnect();
      setSocketClient(null);
    };
  }, [roomId, token]);

  const stopMicrophoneStream = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setMicReady(false);
  };

  const getRecorderMimeType = () => {
    const preferredTypes = [
      "audio/webm;codecs=opus",
      "audio/ogg;codecs=opus",
      "audio/webm",
      "audio/ogg",
    ];
    return (
      preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) || ""
    );
  };

  const getFullRecorderMimeType = () => {
    const preferredTypes = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=h264,opus",
      "video/webm",
    ];
    return (
      preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) || ""
    );
  };

  const createFullRecordingStream = () => {
    const micStream = streamRef.current;
    const camStream = webcamStreamRef.current;
    const combined = new MediaStream();

    const micTrack = micStream?.getAudioTracks?.()[0];
    const camTrack = camStream?.getVideoTracks?.()[0];

    if (micTrack) {
      // IMPORTANT: Clone the track then explicitly force it enabled.
      //
      // setMicEnabled(false) calls track.enabled = false on streamRef.current
      // tracks to gate the STT pipeline. MediaStreamTrack.clone() inherits
      // the CURRENT enabled state of the source track, so if the mic was
      // already muted (which happens before createFullRecordingStream is
      // called in startRecording), the clone starts muted and since
      // setMicEnabled() only touches streamRef.current tracks (not clones)
      // the recording audio track stays silent for the entire interview.
      //
      // Forcing enabled = true here ensures the full recording ALWAYS
      // captures the candidate's voice regardless of STT-gate state.
      const clonedAudioTrack = micTrack.clone();
      clonedAudioTrack.enabled = true;
      combined.addTrack(clonedAudioTrack);
    }
    if (camTrack) {
      combined.addTrack(camTrack.clone());
    }

    return combined;
  };

  const startUtteranceRecorder = () => {
    if (!streamRef.current || !recordingActiveRef.current) return;

    const mimeType = getRecorderMimeType();
    utteranceMimeRef.current = mimeType || "audio/webm";
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
        type: utteranceMimeRef.current || "audio/webm",
      });
      utteranceChunksRef.current = [];
      if (blob.size >= MIN_AUDIO_BLOB_BYTES) {
        await sendAudioToSpeechStack(blob, {
          speechDurationMs: utteranceDurationMsRef.current || 0,
          capturedAt: Date.now(),
        });
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
    utteranceDurationMsRef.current = utteranceStartedAtRef.current
      ? Date.now() - utteranceStartedAtRef.current
      : 0;
    if (recorder && recorder.state === "recording") {
      try {
        recorder.stop();
      } catch (err) {
        console.warn("utterance stop failed", err);
      }
    }
  };

  const vadTick = () => {
    if (!recordingActiveRef.current) return;
    const analyser = analyserRef.current;
    if (!analyser) return;

    // Don't arm a new utterance while the AI is speaking or composing — its
    // TTS would be captured and misread as the candidate's answer. The post-
    // TTS dead zone covers the speaker tail / room reverb after audio ends.
    // Also gate while the MAIN mic is muted (TTS mute or user mute) — the
    // analyser reads its own always-live capture, but we must not arm an
    // utterance the per-utterance recorder (main stream) would record as silence.
    const micTrack = streamRef.current?.getAudioTracks?.()[0];
    const micLive = micTrack ? micTrack.enabled !== false : true;
    const gated = !canAcceptSttNow().ok || !micLive;

    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sumSq = 0;
    for (let i = 0; i < buf.length; i++) sumSq += buf[i] * buf[i];
    const rms = Math.sqrt(sumSq / buf.length);

    const now = Date.now();

    // Throttled mic-energy diagnostic (~1/s) so we can see whether the analyser
    // is actually receiving samples when the candidate speaks.
    if (now - vadLogAtRef.current > 1000) {
      vadLogAtRef.current = now;
      console.log(
        `[VAD] rms=${rms.toFixed(4)} gated=${gated} inUtterance=${isInUtteranceRef.current} (start≥${VAD_START_RMS_THRESHOLD})`,
      );
    }

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

      const endBySilence =
        silenceFor >= VAD_SILENCE_MS && utteranceLen >= VAD_MIN_UTTERANCE_MS;
      const endByCap = utteranceLen >= VAD_MAX_UTTERANCE_MS;
      const endByGate = gated && utteranceLen >= VAD_MIN_UTTERANCE_MS;

      if (endBySilence || endByCap || endByGate) {
        isInUtteranceRef.current = false;
        stopUtteranceRecorder();
      }
    }

    vadTimerRef.current = setTimeout(vadTick, VAD_POLL_INTERVAL_MS);
  };

  const startVad = async () => {
    if (!streamRef.current || vadTimerRef.current) return;

    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioCtx) {
      console.warn(
        "Web Audio API unavailable; falling back to single continuous recorder",
      );
      // Fallback: start one long recorder so we still capture something.
      startUtteranceRecorder();
      return;
    }

    streamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });

    // The VAD analyser must keep "hearing" the candidate even while the main
    // mic track is muted (track.enabled=false) during agent speech/thinking.
    //
    // DO NOT open a second getUserMedia() on the same physical mic for this:
    // Chromium returns a permanently SILENT stream for a second capture of the
    // same device (dual-capture), which makes the analyser read rms=0 forever
    // and breaks STT entirely.
    //
    // Instead we tap a CLONE of the main mic track. A cloned MediaStreamTrack
    // has an INDEPENDENT `enabled` flag, so when setMicEnabled(false) disables
    // the source track during TTS, this clone stays enabled and keeps feeding
    // the candidate's audio to the analyser. We still gate *arming an utterance*
    // on the main mic's enabled state + canAcceptSttNow() in vadTick below, so
    // the agent's own TTS is never armed/recorded as a candidate answer.
    let analyserStream;
    const mainAudioTrack = streamRef.current.getAudioTracks()[0];
    if (mainAudioTrack) {
      const analyserTrack = mainAudioTrack.clone();
      analyserTrack.enabled = true; // independent of the source track's mute state
      vadAnalyserTrackRef.current = analyserTrack;
      analyserStream = new MediaStream([analyserTrack]);
    } else {
      vadAnalyserTrackRef.current = null;
      analyserStream = streamRef.current;
    }
    if (vadTimerRef.current) {
      // startVad was called again while awaiting — abort this duplicate.
      // (Defensive: no awaits remain above, but keep the guard.)
      if (vadAnalyserTrackRef.current) {
        try {
          vadAnalyserTrackRef.current.stop();
        } catch (err) {
          /* noop */
        }
        vadAnalyserTrackRef.current = null;
      }
      return;
    }

    const audioContext = new AudioCtx();
    const source = audioContext.createMediaStreamSource(analyserStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);

    // AudioContext can start in `suspended` state even after a user gesture
    // in some browser/version combos — resume explicitly so analyser polls
    // actually receive samples.
    if (audioContext.state === "suspended") {
      audioContext.resume().catch((err) => {
        console.warn("[VAD] audioContext.resume failed:", err?.message || err);
      });
    }

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
      try {
        audioContextRef.current.close();
      } catch (err) {
        /* noop */
      }
      audioContextRef.current = null;
    }
    if (vadAnalyserTrackRef.current) {
      try {
        vadAnalyserTrackRef.current.stop();
      } catch (err) {
        /* noop */
      }
      vadAnalyserTrackRef.current = null;
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
      console.error("Failed to access microphone:", error);
      alert("Failed to access microphone. Please check browser permissions.");
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
        alert("Enable the microphone first.");
        return;
      }
      if (!cameraOn) {
        alert("Enable the camera first (required to start the call UI).");
        return;
      }
      if (!isRH && faceVerifStatus !== "matched") {
        alert(
          "Face verification must be matched before starting the interview.",
        );
        return;
      }

      const stream = streamRef.current;
      recordingActiveRef.current = true;

      // ── Full-call recorder (camera + mic when available) ────────────────────
      // MUST be created BEFORE setMicEnabled(false) so createFullRecordingStream
      // clones the mic track while it is still enabled. Although the clone itself
      // also forces enabled=true (see createFullRecordingStream), keeping the
      // order correct adds a second safety layer.
      const fullRecordingStream = createFullRecordingStream();
      fullRecordingStreamRef.current = fullRecordingStream;
      const mimeType = getFullRecorderMimeType();
      allMimeTypeRef.current = mimeType || "video/webm";
      allAudioChunksRef.current = [];

      const fullRecorder = mimeType
        ? new MediaRecorder(fullRecordingStream, { mimeType })
        : new MediaRecorder(fullRecordingStream);

      // Initialise the VAD AudioContext / analyser BEFORE muting the mic.
      // createMediaStreamSource() captures the audio track's enabled state at
      // construction time on Chromium browsers — wiring it against a disabled
      // track caused the first candidate responses to be invisible to VAD.
      startVad();

      // Pre-warm the per-utterance MediaRecorder so the first detected speech
      // segment isn't truncated while the recorder is still spinning up.
      try {
        const warmRec = new MediaRecorder(streamRef.current);
        warmRec.start();
        setTimeout(() => {
          try {
            if (warmRec.state === "recording") warmRec.stop();
          } catch (_err) { /* ignore */ }
        }, 80);
      } catch (_err) { /* recorder warm-up is best-effort */ }

      // Disable the STT-gating mic AFTER the recorder stream is built and VAD
      // is wired against a live track.
      setMicEnabled(false);
      agentThinkingRef.current = true;
      setAgentThinking(true);
      emitAgentThinkingState(true);
      setInterviewTurnState("agent_thinking", "waiting for intro");
      lastTranscriptRef.current = "";

      fullRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          allAudioChunksRef.current.push(event.data);
        }
      };
      fullRecorder.onstop = () => {
        if (fullRecordingStreamRef.current) {
          fullRecordingStreamRef.current
            .getTracks()
            .forEach((track) => track.stop());
          fullRecordingStreamRef.current = null;
        }
      };
      fullRecorderRef.current = fullRecorder;
      // Use a 10-second timeslice so chunks are collected progressively.
      // This protects against data loss if the tab crashes during a long
      // interview — we still have all chunks up to the last flush.
      fullRecorder.start(10000);

      // ── VAD-driven per-utterance recorder for transcription ────────────
      // (startVad already ran above, before we muted the mic — that ordering
      // is what makes the first candidate response audible to STT.)
      setIsRecording(true);

      console.log(
        "[VoiceLifecycle] Start Call pressed — attempting playback of prepared TTS",
      );

      void playPreparedAgentTts().then((played) => {
        if (played) {
          // Cached TTS blob is playing. tryStartAgentIntro may still run but
          // agentSessionReadyRef is true so it exits early — no duplicate session.
          console.log(
            "[VoiceLifecycle] playPreparedAgentTts played cached blob",
          );
        } else if (lastAgentTextRef.current && agentSessionReadyRef.current) {
          // Agent already sent its first message but no blob was cached (e.g.
          // agent:tts arrived while recording was off and wasn't stored).
          // Trigger a single local TTS fetch. The fallback timer guard inside
          // requestAgentTtsPlayback prevents re-fetching if agent:tts arrives
          // on the socket at the same time.
          console.log(
            "[VoiceLifecycle] no cached TTS — requesting local TTS for existing message",
          );
          void requestAgentTtsPlayback(
            lastAgentTextRef.current,
            lastAgentVoiceKeyRef.current,
          );
        }
        // If agentSessionReadyRef is false, tryStartAgentIntro below will request
        // the session and agent:tts will arrive via socket — no local fetch needed.
      });

      // Candidate explicitly started the interview. Always request intro with
      // TTS preparation so first turn appears as text + speech together.
      setInterviewStarting(true);
      tryStartAgentIntro({ force: true, prepare: true });
    } catch (error) {
      console.error("Failed to start recording:", error);
      alert("Failed to access microphone");
    }
  };

  const stopRecording = () => {
    recordingActiveRef.current = false;
    agentThinkingRef.current = false;
    setAgentThinking(false);
    emitAgentThinkingState(false);
    setInterviewTurnState("candidate_listening", "recording stopped");
    setRecoverableAgentError("");
    setAgentRetrying(false);

    stopVad();
    stopMicrophoneStream();
    clearAgentTtsFallback();
    stopAgentAudioPlayback({ emitStopped: true });

    // Stop the full-call recorder — triggers ondataavailable then onstop
    if (fullRecorderRef.current?.state === "recording") {
      fullRecorderRef.current.stop();
    } else if (fullRecordingStreamRef.current) {
      fullRecordingStreamRef.current
        .getTracks()
        .forEach((track) => track.stop());
      fullRecordingStreamRef.current = null;
    }

    clearIntroKickoffRetry();

    setIsRecording(false);
  };

  // Resolves once the full-call recorder's onstop fires (data is ready)
  const waitForFullRecording = () =>
    new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const rec = fullRecorderRef.current;
      if (!rec || rec.state === "inactive") {
        done();
        return;
      }

      rec.addEventListener("stop", done, { once: true });
      setTimeout(done, 8000); // safety fallback
    });

  const sendAudioToSpeechStack = async (audioBlob, captureMeta = {}) => {
    try {
      const gate = canAcceptSttNow();
      if (!gate.ok) {
        console.log(`[STT] ignored during TTS reason=${gate.reason}`);
        return;
      }

      const formData = new FormData();
      const ext = audioBlob.type.includes("ogg") ? "ogg" : "webm";
      formData.append("audio", audioBlob, `recording.${ext}`);
      const customTerms = collectSttCustomTerms(room);
      if (customTerms.length) {
        formData.append("custom_terms", JSON.stringify(customTerms));
      }

      let data = null;
      let text = "";
      let sentiment;

      // Primary path: direct Speech Stack API.
      try {
        const response = await fetch(
          `${SPEECH_STACK_URL}/api/transcribe-sentiment`,
          {
            method: "POST",
            body: formData,
          },
        );

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`direct speech stack ${response.status}: ${errText}`);
        }

        data = await response.json();
      } catch (directError) {
        // Fallback path: backend voice route (works even when :8012 is down).
        console.warn(
          "Direct Speech Stack unavailable, falling back to backend /api/voice/transcribe:",
          directError?.message || directError,
        );
        const fallbackResponse = await fetch(`${VOICE_API_URL}/transcribe`, {
          method: "POST",
          body: formData,
        });

        if (!fallbackResponse.ok) {
          const fallbackErr = await fallbackResponse.text();
          console.error(
            "Voice fallback request failed:",
            fallbackResponse.status,
            fallbackErr,
          );
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
      if (
        text &&
        parsed.avgLogprob != null &&
        parsed.avgLogprob < STT_MIN_AVG_LOGPROB
      ) {
        console.log(
          "🔇 Dropping low-confidence STT segment:",
          text,
          `(avg_logprob=${parsed.avgLogprob.toFixed(2)} < ${STT_MIN_AVG_LOGPROB})`,
        );
        return;
      }
      if (
        text &&
        parsed.noSpeechProb != null &&
        parsed.noSpeechProb > STT_MAX_NO_SPEECH_PROB
      ) {
        console.log(
          "🔇 Dropping silence-classified STT segment:",
          text,
          `(no_speech_prob=${parsed.noSpeechProb.toFixed(2)} > ${STT_MAX_NO_SPEECH_PROB})`,
        );
        return;
      }

      if (text && roomDbId) {
        lastTranscriptRef.current = text;
        const segmentPayload = {
          text,
          timestamp: new Date(),
          avgLogprob: parsed.avgLogprob,
          noSpeechProb: parsed.noSpeechProb,
          speechDurationMs: captureMeta.speechDurationMs || 0,
        };

        // Send transcription to backend
        await fetch(
          `${API_BASE}/api/call-rooms/${roomDbId}/update-transcription`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              segment: segmentPayload,
              sentiment,
            }),
          },
        );

        // Emit via socket
        socketRef.current?.emit("update-call-transcription", {
          roomId,
          roomDbId,
          segment: segmentPayload,
          sentiment,
        });
      }
    } catch (error) {
      console.error("Failed to send audio to Speech Stack:", error);
    }
  };

  const uploadRecording = async (dbId) => {
    if (!allAudioChunksRef.current.length) return;
    try {
      const mimeType = allMimeTypeRef.current || "audio/webm";
      const ext = mimeType.includes("ogg") ? "ogg" : "webm";
      const fullBlob = new Blob(allAudioChunksRef.current, { type: mimeType });
      const formData = new FormData();
      formData.append("audio", fullBlob, `recording.${ext}`);
      const response = await fetch(
        `${API_BASE}/api/call-rooms/${dbId}/upload-audio`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        },
      );
      if (!response.ok) {
        const message = await response.text();
        throw new Error(`upload failed (${response.status}): ${message}`);
      }
      return true;
    } catch (error) {
      // The interview must still finish even if upload fails.
      console.warn("Recording upload failed, interview will still end:", error);
      return false;
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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
        webcamStreamRef.current = stream;
        if (webcamVideoRef.current) webcamVideoRef.current.srcObject = stream;
        setCameraOn(true);
      } catch (e) {
        console.warn("[Camera] access denied or unavailable:", e.message);
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
      if (
        recordingActiveRef.current ||
        fullRecorderRef.current?.state === "recording"
      ) {
        stopRecording();
        await waitForFullRecording();
      }

      const response = await fetch(
        `${API_BASE}/api/call-rooms/${roomDbId}/end-call`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        },
      );

      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.message || `End call failed (${response.status})`);
      }

      if (data.room?.visionMonitoring?.report) {
        setVisionReport(data.room.visionMonitoring.report);
      }

      const uploadOk = await uploadRecording(roomDbId);
      if (!uploadOk) {
        console.warn(
          "Interview ended without a saved local recording. " +
            "LangGraph analysis may fail until recording upload succeeds.",
        );
      }
      socketRef.current?.emit("agent:end-session", { roomId, roomDbId });
      socketRef.current?.emit("end-call-room", { roomId, roomDbId });
      globalThis.history.back();
    } catch (error) {
      console.error("Failed to end call:", error);
      alert(error?.message || "Failed to end call. Please try again.");
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

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

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
            <span className="cr-timer">
              {mm}:{ss}
            </span>
          </div>
          <div className="cr-header__right">
            {isRecording && <span className="cr-badge-rec">● REC</span>}
            <button
              className="cr-btn-end"
              onClick={endCall}
              disabled={!roomDbId || endingCall}
            >
              {endingCall ? "Leaving..." : "Leave"}
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
              {!isRH ? (
                <InterviewAvatar />
              ) : (
                <div className="cr-tile__placeholder">RH View</div>
              )}
              <div
                className={`cr-tile__status ${agentSpeaking ? "speaking" : agentThinking ? "thinking" : "idle"}`}
              >
                {turnState === "agent_speaking"
                  ? "AI is speaking..."
                  : turnState === "agent_thinking"
                    ? "AI is thinking..."
                    : turnState === "candidate_submitting"
                      ? "Processing your answer..."
                      : turnState === "candidate_answering"
                        ? "Listening..."
                        : "Listening"}
              </div>

              {/* Picture-in-Picture: candidate cam overlaid on avatar */}
              {!isRH && (
                <div className="cr-pip cr-pip--medium">
                  <div className="cr-pip__label">You</div>
                  <video
                    ref={webcamVideoRef}
                    autoPlay
                    muted
                    playsInline
                    className={`cr-cam-video${cameraOn ? "" : " cr-cam-video--off"}`}
                  />
                  {!cameraOn && (
                    <div className="cr-cam-placeholder">
                      <span>📷</span>
                      <span>Camera off</span>
                    </div>
                  )}
                  {/* Face verification — transparent overlay on live camera feed */}
                  {cameraOn &&
                    !isRecording &&
                    faceVerifStatus === "not_enrolled" && (
                      <div className="cr-face-required">
                        <strong>Profile photo required</strong>
                        <span>
                          Please upload a clear profile photo before starting
                          the interview
                        </span>
                      </div>
                    )}
                  {cameraOn &&
                    !isRecording &&
                    faceVerifStatus !== "not_enrolled" &&
                    faceVerifStatus !== "matched" &&
                    roomId && (
                      <FaceVerification
                        roomId={roomId}
                        webcamRef={webcamVideoRef}
                        visionStatus={visionStatus}
                        token={token}
                        onVerified={(status) =>
                          setFaceVerifStatus(
                            status === "matched"
                              ? "matched"
                              : status || "failed",
                          )
                        }
                      />
                    )}
                </div>
              )}
            </div>

            {/* VisionMonitor runs in background for integrity monitoring.
                The UI card is hidden (hideUI=true) for cleaner Google Meet-style layout.
                Monitoring data is still captured and sent to backend. */}
            {!isRH && (
              <VisionMonitor
                active={cameraOn}
                interviewId={roomDbId}
                questionId={room?.currentQuestion || ""}
                token={token}
                apiBase={API_BASE}
                roomStatus={isRecording ? "active" : room?.status || "waiting"}
                videoRef={webcamVideoRef}
                onStatusChange={setVisionStatus}
                hideUI={true}
              />
            )}

            {/* Control bar */}
            {!isRH && (
              <div className="cr-controls">
                <button
                  className={`cr-ctrl cr-ctrl--start${!isRecording && micReady && cameraOn && faceVerifStatus === "matched" ? " cr-ctrl--active" : ""}`}
                  onClick={async () => {
                    await startRecording();
                    // On small screens, Conversation can be below the fold.
                    setTimeout(() => {
                      conversationRef.current?.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                      });
                    }, 60);
                  }}
                  disabled={
                    isRecording ||
                    !micReady ||
                    !cameraOn ||
                    faceVerifStatus !== "matched"
                  }
                >
                  <span className="cr-ctrl__icon">▶️</span>
                  <span className="cr-ctrl__label">Start Call</span>
                </button>
                <button
                  className={`cr-ctrl${isRecording || micReady ? " cr-ctrl--active" : ""}`}
                  onClick={
                    isRecording
                      ? stopRecording
                      : micReady
                        ? stopMicrophoneStream
                        : requestMicrophoneStream
                  }
                >
                  <span className="cr-ctrl__icon">
                    {isRecording ? "🔴" : micReady ? "🎙️" : "🎤"}
                  </span>
                  <span className="cr-ctrl__label">
                    {isRecording
                      ? "Mute"
                      : micReady
                        ? "Disable Mic"
                        : "Enable Mic"}
                  </span>
                </button>
                <button
                  className={`cr-ctrl${cameraOn ? " cr-ctrl--active" : ""}`}
                  onClick={toggleCamera}
                >
                  <span className="cr-ctrl__icon">
                    {cameraOn ? "📷" : "📷"}
                  </span>
                  <span className="cr-ctrl__label">
                    {cameraOn ? "Stop Video" : "Start Video"}
                  </span>
                </button>
                <button
                  className="cr-ctrl cr-ctrl--end"
                  onClick={endCall}
                  disabled={!roomDbId || endingCall}
                >
                  <span className="cr-ctrl__icon">📞</span>
                  <span className="cr-ctrl__label">
                    {endingCall ? "Ending..." : "End Call"}
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* Right column — chat + transcript */}
          <div className="cr-right">
            {/* Status bar */}
            {!isRH && (
              <div
                className={`cr-statusbar${agentSpeaking ? " cr-statusbar--speaking" : agentThinking ? " cr-statusbar--thinking" : isRecording ? " cr-statusbar--listening" : ""}`}
              >
                <span className="cr-statusbar__dot" />
                <span className="cr-statusbar__text">
                  {isRecording
                    ? recoverableAgentError && turnState === "error_recoverable"
                      ? recoverableAgentError
                      : TURN_STATE_LABELS[turnState] ||
                        "Listening — answer naturally"
                    : !micReady
                      ? "Enable microphone to begin"
                      : !cameraOn
                        ? "Enable camera to begin"
                        : visionStatus?.message || "Click Start Call"}
                </span>
                {turnState === "error_recoverable" &&
                  pendingCandidateTurnRef.current?.turnId &&
                  !agentRetrying && (
                    <button
                      type="button"
                      className="cr-statusbar__retry"
                      onClick={retryPendingAgentTurn}
                    >
                      Retry AI response
                    </button>
                  )}
              </div>
            )}

            {/* Agent chat panel */}
            {socketClient && roomId && (
              <div className="cr-chat" ref={conversationRef}>
                <div className="cr-chat-header">
                  <span className="cr-chat-header__icon">💬</span>
                  <div>
                    <div className="cr-chat-header__title">Conversation</div>
                    <div className="cr-chat-header__sub">
                      Interview transcript
                    </div>
                  </div>
                </div>
                <AgentChatPanel
                  socket={socketClient}
                  roomId={roomId}
                  roomDbId={roomDbId}
                  isRH={isRH}
                  candidateDraftText={!isRH ? draftText : null}
                  interviewStarting={interviewStarting}
                  turnState={turnState}
                  turnStatusLabel={TURN_STATE_LABELS[turnState] || ""}
                  submitDisabled={
                    !isRH &&
                    (faceVerifStatus !== "matched" ||
                      agentRetrying ||
                      turnState === "candidate_submitting")
                  }
                  inputDisabled={
                    !isRH && (!roomDbId || faceVerifStatus !== "matched")
                  }
                  onTypingChange={(typing) => {
                    isTypingAnswerRef.current = !!typing;
                    if (typing && sttSilenceTimerRef.current) {
                      clearTimeout(sttSilenceTimerRef.current);
                      sttSilenceTimerRef.current = null;
                    }
                  }}
                  onCandidateAnswerSubmit={(answerText) =>
                    submitCandidateTurn({
                      text: answerText,
                      source: "typed",
                      sentiment: null,
                    })
                  }
                  onSubmitVoiceDraft={() =>
                    submitCandidateTurn({
                      text: draftText,
                      source: "voice",
                      sentiment: sttPendingReplyRef.current?.sentiment || null,
                      sttMeta: sttPendingReplyRef.current?.meta || null,
                    })
                  }
                  canSubmitVoiceDraft={
                    !!draftText && turnState === "candidate_answering"
                  }
                  recoverableAgentError={recoverableAgentError}
                  onRetryAgentResponse={retryPendingAgentTurn}
                  agentRetrying={agentRetrying}
                  initialAgentMessage={
                    room?.currentQuestion ||
                    lastAgentMessageText ||
                    lastAgentTextRef.current ||
                    ""
                  }
                  initialAgentPhase={room?.phase || ""}
                  initialAgentDifficulty={room?.currentDifficulty ?? null}
                  initialAgentSkill={room?.currentSkill || ""}
                  initialAgentTurnIndex={currentQuestionIdRef.current || null}
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
                        <span className="cr-seg__time">
                          {new Date(seg.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    ))
                  )}
                </div>

                {/* Overall sentiment block intentionally omitted — emotion
                    classification is not part of the recruitment decision. */}

                {room?.transcription?.text && (
                  <div className="cr-full-transcript">
                    <p>
                      <strong>Full Transcript:</strong>
                    </p>
                    <textarea readOnly value={room.transcription.text} />
                  </div>
                )}

                {room?.visionMonitoring?.report || visionReport ? (
                  <div className="cr-vision-report">
                    <div className="cr-vision-report__header">
                      <h3>Vision Monitoring</h3>
                      <span>
                        {(visionReport || room?.visionMonitoring?.report)
                          ?.cameraQuality || "Unknown"}
                      </span>
                    </div>
                    <div className="cr-vision-report__grid">
                      <div>
                        <span>Face visibility</span>
                        <strong>
                          {(visionReport || room?.visionMonitoring?.report)
                            ?.faceVisibilityRate || "0%"}
                        </strong>
                      </div>
                      <div>
                        <span>Absence events</span>
                        <strong>
                          {(visionReport || room?.visionMonitoring?.report)
                            ?.absenceEvents || 0}
                        </strong>
                      </div>
                      <div>
                        <span>Lighting issues</span>
                        <strong>
                          {(visionReport || room?.visionMonitoring?.report)
                            ?.lightingIssues || 0}
                        </strong>
                      </div>
                      <div>
                        <span>Position issues</span>
                        <strong>
                          {(visionReport || room?.visionMonitoring?.report)
                            ?.positionIssues || 0}
                        </strong>
                      </div>
                    </div>
                    <p className="cr-vision-report__recommendation">
                      {
                        (visionReport || room?.visionMonitoring?.report)
                          ?.recommendation
                      }
                    </p>
                  </div>
                ) : null}
              </div>
            )}
          </div>
          {/* cr-right */}
        </main>
        {/* cr-main */}
      </div>
      {/* cr-root */}
    </PublicLayout>
  );
};

export default CallRoomActive;
