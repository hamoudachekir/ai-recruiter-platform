require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const passport = require('passport');
const fs = require('fs');
const fsp = require('fs/promises');
const multer = require('multer');
const path = require('path');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { UserModel } = require('./models/user');
const JobModel = require('./models/job');
const swaggerUi = require("swagger-ui-express");
const swaggerJsdoc = require("swagger-jsdoc");
const axios = require('axios');
const fetch = require("node-fetch");
const http = require('http');
const socketIO = require('socket.io');
const { exec } = require('child_process');
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174',
];
const configuredOrigins = (process.env.ALLOWED_FRONTEND_URLS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredOrigins]);
const ApplicationModel = require('./models/Application'); // Chemin exact vers le model
const uploadCV = require("./middleware/uploadCV");
const quizRateLimiter = require("./middleware/quizRateLimit");
const validateQuizSubmission = require("./middleware/quizSecurityValidation");
const QuizModel = require("./models/Quiz");
const CandidateQuizModel = require("./models/CandidateQuiz");
const QuizResultModel = require("./models/QuizResultModel");
const Application = require("./models/Application");
const messageRoutes = require('./routes/messages');
const Message = require('./models/Message');
const CallRoom = require('./models/CallRoom');
const interviewAgent = require('./services/interviewAgentService');
const voiceRoutes = require('./routes/voiceRoute');
const { requestSpeechStackTts } = require('./services/speechStackService');
const {
  buildWavBuffer,
  runVoiceEngineAnalysis,
  startVoiceEngineRealtimeWorker,
  writeTempWav,
} = require('./services/voiceEngineService');
const {
  aggregateSegmentSentiment,
  buildCorrectedSegments,
  inferTranscriptionSentiment,
  localCleanTranscriptionText,
  maybeCorrectTranscriptionText,
  maybeSummarizeTranscriptionText,
} = require('./services/voiceTextCorrectionService');
// Create Express app and HTTP server
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = socketIO(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST"],
    credentials: true
  },
  path: '/socket.io/',
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000
});

const SOCKET_TRACE_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.SOCKET_TRACE || '').trim().toLowerCase(),
);

const shouldTraceSocketEvent = (eventName) => {
  const name = String(eventName || '');
  return (
    name.startsWith('agent:')
    || name === 'transcription-update'
    || name === 'update-call-transcription'
    || name === 'voice-stream:result'
    || name === 'voice-stream:partial'
  );
};

const summarizeSocketTraceArg = (value) => {
  if (Buffer.isBuffer(value)) {
    return { __type: 'Buffer', bytes: value.length };
  }

  if (Array.isArray(value)) {
    return { __type: 'Array', length: value.length };
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const out = {};
  const keys = [
    'roomId',
    'roomDbId',
    'interviewId',
    'phase',
    'turnIndex',
    'streamId',
    'sentiment',
    'text',
    'corrected_text',
    'summary',
    'message',
    'sourceUserId',
    'sourceRole',
  ];

  for (const key of keys) {
    if (value[key] == null) continue;
    if (typeof value[key] === 'string') {
      const normalized = value[key].replace(/\s+/g, ' ').trim();
      out[key] = normalized.length > 160 ? `${normalized.slice(0, 160)}…` : normalized;
      continue;
    }
    out[key] = value[key];
  }

  if (value.segment?.text) {
    const segmentText = String(value.segment.text).replace(/\s+/g, ' ').trim();
    out.segmentText = segmentText.length > 160 ? `${segmentText.slice(0, 160)}…` : segmentText;
  }

  if (typeof value.chunkCount === 'number') out.chunkCount = value.chunkCount;
  if (typeof value.chunkBytes === 'number') out.chunkBytes = value.chunkBytes;
  if (!Object.keys(out).length) out.__keys = Object.keys(value).slice(0, 10);

  return out;
};

const traceSocketEvent = (direction, socket, eventName, args) => {
  if (!SOCKET_TRACE_ENABLED || !shouldTraceSocketEvent(eventName)) return;

  const summarizedArgs = Array.isArray(args)
    ? args.slice(0, 3).map((arg) => summarizeSocketTraceArg(arg))
    : [];

  console.log('[SOCKET_TRACE]', {
    direction,
    event: eventName,
    socketId: socket?.id || null,
    userId: socket?.user?.id || null,
    args: summarizedArgs,
  });
};

const normalizeAgentSentiment = (sentiment) => {
  if (!sentiment) return null;

  if (typeof sentiment === 'string') {
    const label = sentiment.trim().toUpperCase();
    return label ? { label, score: 0 } : null;
  }

  if (typeof sentiment === 'object') {
    const rawLabel = String(sentiment.label || sentiment.sentiment || '').trim().toUpperCase();
    const rawScore = Number(sentiment.score);

    return {
      label: rawLabel || 'NEUTRAL',
      score: Number.isFinite(rawScore) ? rawScore : 0,
    };
  }

  return null;
};

const voiceStreamSessions = new Map();
const isProd = process.env.NODE_ENV === 'production';
const uploadsDir = path.resolve(__dirname, 'uploads');

const buildDownloadMeta = (absolutePath) => {
  if (!absolutePath) return null;

  const normalized = path.resolve(String(absolutePath));
  const fileName = path.basename(normalized);

  const uploadsPrefix = `${uploadsDir}${path.sep}`;
  const recordingsPrefix = `${audioDir}${path.sep}`;

  if (normalized === uploadsDir || normalized.startsWith(uploadsPrefix)) {
    return {
      fileName,
      bucket: 'uploads',
      url: `/api/voice/download/${encodeURIComponent(fileName)}?bucket=uploads`,
    };
  }

  if (normalized === audioDir || normalized.startsWith(recordingsPrefix)) {
    return {
      fileName,
      bucket: 'recordings',
      url: `/api/voice/download/${encodeURIComponent(fileName)}?bucket=recordings`,
    };
  }

  return null;
};

// 🔐 Socket.IO authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) {
    if (isProd) {
      return next(new Error("Authentication token missing"));
    }

    socket.user = {
      id: `guest-${socket.id}`,
      role: 'guest',
      email: 'guest@local',
    };
    return next();
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
    socket.user = decoded;
    next();
  } catch (err) {
    if (err?.name === "TokenExpiredError") {
      console.warn(`Socket auth failed: token expired at ${err.expiredAt?.toISOString?.() || err.expiredAt}`);
      return next(new Error("TOKEN_EXPIRED"));
    }

    if (!isProd) {
      console.warn('Socket auth fallback to guest in dev:', err?.message || 'invalid token');
      socket.user = {
        id: `guest-${socket.id}`,
        role: 'guest',
        email: 'guest@local',
      };
      return next();
    }

    console.warn("Socket auth failed:", err?.message || "invalid token");
    return next(new Error("Authentication failed"));
  }
});

// Socket.IO setup
io.on("connection", (socket) => {
  console.log("✅ Client connected:", socket.id, "User ID:", socket.user?.id);

  if (SOCKET_TRACE_ENABLED) {
    socket.onAny((eventName, ...args) => {
      traceSocketEvent('in', socket, eventName, args);
    });

    if (typeof socket.onAnyOutgoing === 'function') {
      socket.onAnyOutgoing((eventName, ...args) => {
        traceSocketEvent('out', socket, eventName, args);
      });
    }
  }

  // Each user joins their own room for private messaging
  if (socket.user?.id) {
    socket.join(socket.user.id);
  }

  // Message handling — DB save is done by the HTTP POST /api/messages/send endpoint.
  // The socket handler only relays the message in real-time to the recipient.
  socket.on("send-message", ({ to, from, text, timestamp }) => {
    io.to(String(to)).emit("receive-message", { from, to, text, timestamp });
  });

  socket.on('join-interview', ({ interviewId }) => {
    const normalizedInterviewId = String(interviewId || '').trim();
    if (!normalizedInterviewId) {
      socket.emit('error', 'Interview ID is required');
      return;
    }

    const room = `interview:${normalizedInterviewId}`;
    socket.join(room);
    socket.to(room).emit('user-connected', socket.user?.id || socket.id);
  });

  socket.on('leave-interview', ({ interviewId }) => {
    const normalizedInterviewId = String(interviewId || '').trim();
    if (!normalizedInterviewId) return;

    const room = `interview:${normalizedInterviewId}`;
    socket.leave(room);
    socket.to(room).emit('user-disconnected', socket.user?.id || socket.id);
  });

  // ── Call Room Socket Events ───────────────────────────────────────────────

  // Subscribe to the public list of available rooms (candidates)
  socket.on('subscribe-to-available-rooms', () => {
    socket.join('available-rooms');
  });

  socket.on('unsubscribe-from-available-rooms', () => {
    socket.leave('available-rooms');
  });

  // Join a specific call room channel (both recruiter and candidate)
  socket.on('join-room', ({ roomId }) => {
    if (roomId) {
      socket.join(`call-room:${roomId}`);
      socket.join(roomId);
    }
  });

  // Recruiter creates a room → broadcast to candidates browsing available rooms
  socket.on('call-room-created', ({ roomId, room }) => {
    io.to('available-rooms').emit('new-call-room', { room });
  });

  // Candidate requests to join → notify the recruiter (by their user ID room)
  socket.on('call-room-join-request', ({ roomId, candidateId, initiatorId }) => {
    if (initiatorId) {
      io.to(String(initiatorId)).emit('candidate-join-request', { roomId, candidateId });
    }
    socket.to(`call-room:${roomId}`).emit('candidate-join-request', { roomId, candidateId });
  });

  // Recruiter confirms → notify the candidate and update available rooms list
  socket.on('confirm-candidate-join', ({ roomId, roomDbId, candidateId }) => {
    if (candidateId) {
      io.to(String(candidateId)).emit('join-confirmed', { roomId, roomDbId });
    }
    socket.to(`call-room:${roomId}`).emit('join-confirmed', { roomId, roomDbId });
    io.to('available-rooms').emit('call-room-status-update', { roomId, roomDbId, status: 'active' });
  });

  // Recruiter rejects → notify the candidate
  socket.on('reject-candidate-join', ({ roomId, roomDbId, candidateId }) => {
    if (candidateId) {
      io.to(String(candidateId)).emit('join-rejected', { roomId, roomDbId });
    }
    socket.to(`call-room:${roomId}`).emit('join-rejected', { roomId, roomDbId });
  });

  // Either party ends the call
  socket.on('end-call-room', ({ roomId, roomDbId }) => {
    socket.to(`call-room:${roomId}`).emit('call-room-ended', { roomId, roomDbId });
    io.to('available-rooms').emit('call-room-status-update', { roomId, roomDbId, status: 'ended' });
  });

  // Transcription update from candidate → forward to recruiter watching the room
  socket.on('update-call-transcription', ({ roomId, roomDbId, segment, sentiment }) => {
    if (!roomId) return;
    io.to(`call-room:${roomId}`).emit('transcription-update', { roomId, roomDbId, segment, sentiment });
  });

  // Live STT/typing draft from candidate → forward to recruiter so the RH chat
  // panel shows a "typing" ghost bubble while the candidate is still speaking.
  socket.on('candidate:draft', ({ roomId, roomDbId, text }) => {
    if (!roomId) return;
    io.to(`call-room:${roomId}`).emit('candidate:draft', {
      roomId,
      roomDbId,
      text: String(text || ''),
      ts: Date.now(),
    });
  });

  // Generic status update relay (e.g. delete)
  socket.on('call-room-status-update', ({ roomId, roomDbId, status }) => {
    io.to('available-rooms').emit('call-room-status-update', { roomId, roomDbId, status });
    socket.to(`call-room:${roomId}`).emit('call-room-status-update', { roomId, roomDbId, status });
  });

  // ============ ADAPTIVE INTERVIEW AGENT EVENTS ============

  const callRoomChannelName = (roomId) => (roomId ? `call-room:${roomId}` : null);
  const resolveDocumentId = (value) => {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value._id) return String(value._id);
    if (typeof value.toString === 'function') return String(value.toString());
    return null;
  };

  const buildAgentMessagePayload = (interviewId, resolvedRoomId, result) => ({
    interviewId,
    roomId: resolvedRoomId,
    phase: result.phase,
    turnIndex: result.turn_index,
    text: result.agent_message?.text,
    difficulty: result.agent_message?.difficulty,
    skillFocus: result.agent_message?.skill_focus,
  });

  const callRoomInterviewStyle = String(process.env.CALL_ROOM_INTERVIEW_STYLE || 'fast_screening').trim() || 'fast_screening';
  const AGENT_TTS_MAX_CHARS = Math.max(80, Number(process.env.AGENT_TTS_MAX_CHARS || 220));

  const broadcastAgentMessage = (roomId, payload) => {
    if (!roomId) return;
    const channel = callRoomChannelName(roomId);
    if (channel) io.to(channel).emit('agent:message', payload);
  };

  const broadcastAgentEnded = (roomId, payload) => {
    if (!roomId) return;
    const channel = callRoomChannelName(roomId);
    if (channel) io.to(channel).emit('agent:ended', payload);
  };

  // Echo a candidate utterance (typed or voice) to every participant in the
  // call-room channel so the RH chat panel sees what the candidate said,
  // not just the agent's reply.
  const broadcastCandidateMessage = (room, payload) => {
    const channel = callRoomChannelName(room?.roomId);
    if (channel) io.to(channel).emit('candidate:message', payload);

    const initiatorId = resolveDocumentId(room?.initiator);
    if (initiatorId) io.to(initiatorId).emit('candidate:message', payload);
  };

  const sendAgentScore = async (roomDbId, roomId, payload) => {
    try {
      let initiatorId = null;

      if (roomDbId) {
        const room = await CallRoom.findById(roomDbId).select('initiator');
        initiatorId = room?.initiator?.toString();
      }

      if (!initiatorId && roomId) {
        const room = await CallRoom.findOne({ roomId }).select('initiator');
        initiatorId = room?.initiator?.toString();
      }

      if (initiatorId) {
        io.to(initiatorId).emit('agent:score', payload);
      }
    } catch (error) {
      console.error('agent:score routing failed:', error?.message || error);
    }
  };

  const buildFastTtsText = (rawText) => {
    const normalized = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return '';

    // Strip common conversational filler that does not add interview value.
    let cleaned = normalized
      .replace(/^(of course\.?\s*)+/i, '')
      .replace(/^(sure\.?\s*)+/i, '')
      .replace(/^(absolutely\.?\s*)+/i, '')
      .replace(/^(no problem[,.!?]*\s*)+/i, '')
      .replace(/^(let me rephrase[:\-]?\s*)+/i, '')
      .trim();

    // Prefer the last explicit question when present for snappier audio prompts.
    const questionParts = cleaned.match(/[^?]*\?/g);
    if (Array.isArray(questionParts) && questionParts.length) {
      cleaned = String(questionParts[questionParts.length - 1] || '').trim();
    }

    if (!cleaned) cleaned = normalized;

    if (cleaned.length > AGENT_TTS_MAX_CHARS) {
      const clipped = cleaned.slice(0, AGENT_TTS_MAX_CHARS);
      const lastPunctuation = Math.max(clipped.lastIndexOf('?'), clipped.lastIndexOf('.'), clipped.lastIndexOf('!'));
      cleaned = (lastPunctuation > 40 ? clipped.slice(0, lastPunctuation + 1) : clipped).trim();
    }

    return cleaned || normalized;
  };

  const sendAgentTtsToCandidate = async (room, payload) => {
    try {
      const candidateId = resolveDocumentId(room?.candidate);
      const normalizedText = String(payload?.text || '').trim();
      if (!candidateId || !normalizedText) return;
      const ttsText = buildFastTtsText(normalizedText);
      if (!ttsText) return;

      const result = await requestSpeechStackTts({
        text: ttsText,
        language: process.env.FW_TTS_LANGUAGE || 'en',
      });

      io.to(candidateId).emit('agent:tts', {
        interviewId: payload.interviewId,
        roomId: payload.roomId,
        phase: payload.phase,
        turnIndex: payload.turnIndex,
        text: ttsText,
        sourceText: normalizedText,
        contentType: result.contentType,
        audioBase64: result.buffer.toString('base64'),
        provider: 'xtts_v2',
      });
    } catch (error) {
      console.error('agent:tts routing failed:', error?.message || error);
    }
  };

  const resolveRoomForAgent = async (roomId, roomDbId) => {
    if (roomDbId) {
      return CallRoom.findById(roomDbId)
        .populate('job', 'title skills description')
        .populate('candidate', 'name email skills profile domain linkedin')
        .populate('initiator', 'name email domain enterprise');
    }

    if (roomId) {
      return CallRoom.findOne({ roomId })
        .populate('job', 'title skills description')
        .populate('candidate', 'name email skills profile domain linkedin')
        .populate('initiator', 'name email domain enterprise');
    }

    return null;
  };

  socket.on('agent:start-session', async ({ roomId, roomDbId, phase = 'intro', prepareTts = false }) => {
    try {
      if (!roomId && !roomDbId) {
        socket.emit('agent:error', { message: 'roomId or roomDbId required' });
        return;
      }

      const room = await resolveRoomForAgent(roomId, roomDbId);
      if (!room) {
        socket.emit('agent:error', { message: 'Call room not found' });
        return;
      }

      const interviewId = room._id.toString();
      const jobTitle = room.job?.title || '';
      const jobSkills = Array.isArray(room.job?.skills) ? room.job.skills : [];
      const enterpriseContext = [
        room.initiator?.enterprise?.name,
        room.initiator?.enterprise?.industry,
        room.initiator?.enterprise?.location,
        room.initiator?.domain,
      ]
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .join(' | ');
      const jobDescription = [room.job?.description || '', enterpriseContext ? `Enterprise context: ${enterpriseContext}` : '']
        .filter(Boolean)
        .join('\n');
      const candidateName = room.candidate?.name || room.candidate?.email || '';
      const profile = room.candidate?.profile || {};
      const linkedin = room.candidate?.linkedin || {};

      const normalizeSkill = (value) => String(value || '').trim().toLowerCase();
      const candidateSkillSources = [
        ...(Array.isArray(room.candidate?.skills) ? room.candidate.skills : []),
        ...(Array.isArray(room.candidate?.profile?.skills) ? room.candidate.profile.skills : []),
      ];
      const candidateSkillSet = new Set(
        candidateSkillSources
          .map((skill) => normalizeSkill(skill))
          .filter(Boolean),
      );
      const matchedSkills = jobSkills.filter((skill) => candidateSkillSet.has(normalizeSkill(skill)));
      const prioritizedSkills = [
        ...matchedSkills,
        ...jobSkills.filter((skill) => !candidateSkillSet.has(normalizeSkill(skill))),
      ];

      const result = await interviewAgent.startSession({
        interviewId,
        jobTitle,
        jobSkills: prioritizedSkills,
        jobDescription,
        candidateName,
        candidateProfile: {
          short_description: profile.shortDescription || '',
          skills: [
            ...(Array.isArray(profile.skills) ? profile.skills.filter(Boolean) : []),
            ...(Array.isArray(linkedin.skills) ? linkedin.skills.filter(Boolean) : []),
          ],
          languages: Array.isArray(profile.languages) ? profile.languages.filter(Boolean) : [],
          domain: profile.domain || room.candidate?.domain || '',
          availability: profile.availability || '',
          experience: [
            ...(Array.isArray(profile.experience)
              ? profile.experience.map((e) => ({
                  title: e?.title || '',
                  company: e?.company || '',
                  duration: e?.duration || '',
                  description: e?.description || '',
                }))
              : []),
            ...(Array.isArray(linkedin.experience)
              ? linkedin.experience.slice(0, 6).map((e) => ({
                  title: e?.title || e?.position || '',
                  company: e?.companyName || e?.company || '',
                  duration: e?.duration || '',
                  description: e?.description || '',
                }))
              : []),
          ],
          linkedin: {
            url: linkedin.url || '',
            headline: linkedin.headline || '',
            current_role: linkedin.currentRole || linkedin.currentPosition || '',
            current_company: linkedin.currentCompany || '',
            about: linkedin.about || '',
            location: linkedin.location || '',
          },
        },
        interviewStyle: callRoomInterviewStyle,
        phase,
      });

      const resolvedRoomId = room.roomId;
      const agentMessagePayload = buildAgentMessagePayload(interviewId, resolvedRoomId, result);
      if (result.resumed) {
        socket.emit('agent:message', agentMessagePayload);
        if (prepareTts) {
          void sendAgentTtsToCandidate(room, agentMessagePayload);
        }
      } else {
        broadcastAgentMessage(resolvedRoomId, agentMessagePayload);
        void sendAgentTtsToCandidate(room, agentMessagePayload);
      }

      await sendAgentScore(interviewId, resolvedRoomId, {
        interviewId,
        roomId: resolvedRoomId,
        phase: result.phase,
        turnIndex: result.turn_index,
        scoring: result.scoring,
        done: result.done,
      });

      console.log(`🤖 Agent session started for ${resolvedRoomId} (phase=${result.phase})`);
    } catch (error) {
      console.error('agent:start-session failed:', error);
      socket.emit('agent:error', { message: error?.message || 'Failed to start agent session' });
    }
  });

  socket.on('agent:candidate-turn', async ({ roomId, roomDbId, text, sentiment, source }) => {
    try {
      if (!text || !String(text).trim()) return;

      const room = await resolveRoomForAgent(roomId, roomDbId);
      if (!room) {
        socket.emit('agent:error', { message: 'interview session not found' });
        return;
      }

      const interviewId = room._id.toString();
      const resolvedRoomId = room.roomId;
      const normalizedSentiment = normalizeAgentSentiment(sentiment);
      const candidateText = String(text || '').trim();
      const candidateSource = String(source || 'voice').toLowerCase();

      broadcastCandidateMessage(room, {
        interviewId,
        roomId: resolvedRoomId,
        text: candidateText,
        sentiment: normalizedSentiment,
        source: candidateSource,
        ts: Date.now(),
      });

      const result = await interviewAgent.candidateTurn({
        interviewId,
        text,
        sentiment: normalizedSentiment,
      });

      const agentMessagePayload = buildAgentMessagePayload(interviewId, resolvedRoomId, result);
      broadcastAgentMessage(resolvedRoomId, agentMessagePayload);
      void sendAgentTtsToCandidate(room, agentMessagePayload);

      await sendAgentScore(interviewId, resolvedRoomId, {
        interviewId,
        roomId: resolvedRoomId,
        phase: result.phase,
        turnIndex: result.turn_index,
        scoring: result.scoring,
        done: result.done,
      });
    } catch (error) {
      console.error('agent:candidate-turn failed:', error);
      socket.emit('agent:error', { message: error?.message || 'Failed to process candidate turn' });
    }
  });

  socket.on('agent:switch-phase', async ({ roomId, roomDbId, phase }) => {
    try {
      const room = await resolveRoomForAgent(roomId, roomDbId);
      if (!room) {
        socket.emit('agent:error', { message: 'session not found' });
        return;
      }

      const interviewId = room._id.toString();
      const resolvedRoomId = room.roomId;
      const result = await interviewAgent.switchPhase({ interviewId, phase });

      const agentMessagePayload = buildAgentMessagePayload(interviewId, resolvedRoomId, result);
      broadcastAgentMessage(resolvedRoomId, agentMessagePayload);
      void sendAgentTtsToCandidate(room, agentMessagePayload);

      await sendAgentScore(interviewId, resolvedRoomId, {
        interviewId,
        roomId: resolvedRoomId,
        phase: result.phase,
        turnIndex: result.turn_index,
        scoring: result.scoring,
        done: result.done,
      });

      console.log(`🤖 Agent phase switched to ${result.phase} for ${resolvedRoomId}`);
    } catch (error) {
      console.error('agent:switch-phase failed:', error);
      socket.emit('agent:error', { message: error?.message || 'Failed to switch agent phase' });
    }
  });

  socket.on('agent:end-session', async ({ roomId, roomDbId }) => {
    try {
      const room = await resolveRoomForAgent(roomId, roomDbId);
      if (!room) return;

      const interviewId = room._id.toString();
      const resolvedRoomId = room.roomId;
      const snapshot = await interviewAgent.endSession({ interviewId });

      broadcastAgentEnded(resolvedRoomId, {
        interviewId,
        roomId: resolvedRoomId,
        snapshot,
      });

      console.log(`🤖 Agent session ended for ${resolvedRoomId}`);
    } catch (error) {
      console.error('agent:end-session failed:', error);
      socket.emit('agent:error', { message: error?.message || 'Failed to end agent session' });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────

  socket.on('voice-stream:start', ({
    streamId,
    interviewId,
    sampleRate = 16000,
    channels = 1,
    language,
    whisperDevice,
    whisperModel,
    realtimeWhisperModel,
    whisperComputeType,
    hfToken,
    enableDiarization,
    singleSpeakerLabel,
    vadThreshold,
    minSpeechMs,
    minSilenceMs,
    maxChunkMs,
    maxTrailingSilenceMs,
    minChunkRms,
    minSpeechRatio,
    minAvgLogprob,
    maxNoSpeechProb,
    partialEmitMs,
    speechPadMs,
  }) => {
    if (!streamId) {
      socket.emit('voice-stream:error', { message: 'streamId is required' });
      return;
    }

    const normalizedInterviewId = String(interviewId || '').trim();
    const interviewRoom = normalizedInterviewId ? `interview:${normalizedInterviewId}` : null;

    if (interviewRoom) {
      socket.join(interviewRoom);
    }

    const normalizedWhisperDevice = String(whisperDevice || 'cpu').trim().toLowerCase() || 'cpu';
    const normalizedLanguage = String(language || '').trim().toLowerCase();
    const defaultModel = normalizedLanguage === 'en' ? 'base.en' : 'base';
    const normalizedWhisperModel = String(whisperModel || defaultModel).trim().toLowerCase() || defaultModel;
    const cpuRealtimeFallbackModel = String(process.env.VOICE_ENGINE_REALTIME_FALLBACK_MODEL || 'small')
      .trim()
      .toLowerCase() || 'small';
    const normalizedRealtimeWhisperModel = String(
      realtimeWhisperModel
      || ((normalizedWhisperDevice === 'cpu' && ['medium', 'large', 'large-v2', 'large-v3'].includes(normalizedWhisperModel))
        ? cpuRealtimeFallbackModel
        : normalizedWhisperModel),
    ).trim().toLowerCase() || normalizedWhisperModel;

    if (normalizedRealtimeWhisperModel !== normalizedWhisperModel) {
      console.warn(
        `Realtime worker model override for stream ${streamId}: ${normalizedWhisperModel} -> ${normalizedRealtimeWhisperModel} on ${normalizedWhisperDevice}`,
      );
    }

    let realtimeWorker = null;
    try {
      realtimeWorker = startVoiceEngineRealtimeWorker(
        {
          sampleRate,
          channels,
          language,
          whisperDevice: normalizedWhisperDevice,
          whisperModel: normalizedRealtimeWhisperModel,
          whisperComputeType,
          singleSpeakerLabel,
          vadThreshold,
          minSpeechMs,
          minSilenceMs,
          maxChunkMs,
          maxTrailingSilenceMs,
          minChunkRms,
          minSpeechRatio,
          minAvgLogprob,
          maxNoSpeechProb,
          partialEmitMs,
        },
        {
          onMessage: (payload) => {
            if (payload?.type === 'ready') {
              socket.emit('voice-stream:worker-ready', {
                streamId,
                realtimeWhisperModel: normalizedRealtimeWhisperModel,
              });
              return;
            }

            if (payload?.type === 'partial' && payload.text) {
              const correctedPartialText = localCleanTranscriptionText(payload.text, language || 'en');
              const partialSentiment = inferTranscriptionSentiment(correctedPartialText || payload.text || '');
              const partialPayload = {
                streamId,
                interviewId: normalizedInterviewId || undefined,
                sourceUserId: socket.user?.id || null,
                sourceRole: String(socket.user?.role || '').toUpperCase() || null,
                corrected_text: correctedPartialText,
                sentiment: partialSentiment.label,
                sentiment_score: partialSentiment.score,
                ...payload,
              };

              socket.emit('voice-stream:partial', partialPayload);
              if (interviewRoom) {
                socket.to(interviewRoom).emit('voice-stream:partial', partialPayload);
              }
            }
          },
          onStderr: (text) => {
            const stderrLine = String(text || '').trim();
            if (!stderrLine) return;
            if (/^Using cache found in\s+/i.test(stderrLine)) return;
            console.warn('Realtime worker stderr:', stderrLine);
          },
          onError: (error) => {
            const code = String(error?.code || '').toUpperCase();
            if (['EOF', 'EPIPE', 'ECANCELED', 'ERR_STREAM_DESTROYED'].includes(code)) {
              return;
            }
            console.warn('Realtime worker error:', error?.message || error);
          },
          onClose: ({ code, signal, stderr, stopRequested }) => {
            const session = voiceStreamSessions.get(streamId);
            if (session) {
              session.realtimeWorker = null;
            }

            const expectedStop = Boolean(stopRequested) || signal === 'SIGTERM' || signal === 'SIGINT';
            if (expectedStop) {
              return;
            }

            if (code !== 0) {
              const stderrText = String(stderr || '').trim();
              const onlyCacheLine = stderrText
                && stderrText
                  .split(/\r?\n/)
                  .filter(Boolean)
                  .every((line) => /^Using cache found in\s+/i.test(line.trim()));

              const reason = (stderrText && !onlyCacheLine)
                ? stderrText
                : `worker exited with code ${code}`;

              socket.emit('voice-stream:error', {
                streamId,
                message: `Realtime worker failed: ${reason}`,
              });
            }
          },
        },
      );
    } catch (error) {
      console.warn('Realtime worker unavailable:', error?.message || error);
    }

    voiceStreamSessions.set(streamId, {
      socketId: socket.id,
      chunks: [],
      chunkCount: 0,
      realtimeWorker,
      interviewId: normalizedInterviewId,
      sampleRate,
      channels,
      language,
      whisperDevice,
      whisperModel: normalizedWhisperModel,
      realtimeWhisperModel: normalizedRealtimeWhisperModel,
      whisperComputeType,
      hfToken,
      enableDiarization,
      singleSpeakerLabel,
      vadThreshold,
      minSpeechMs,
      minSilenceMs,
      maxChunkMs,
      maxTrailingSilenceMs,
      minChunkRms,
      minSpeechRatio,
      minAvgLogprob,
      maxNoSpeechProb,
      partialEmitMs,
      speechPadMs,
    });

    socket.join(`voice:${streamId}`);
    socket.emit('voice-stream:started', {
      streamId,
      whisperModel: normalizedWhisperModel,
      realtimeWhisperModel: normalizedRealtimeWhisperModel,
    });
  });

  socket.on('voice-stream:chunk', ({ streamId, chunk }) => {
    const session = voiceStreamSessions.get(streamId);
    if (!session || session.socketId !== socket.id) {
      socket.emit('voice-stream:error', { streamId, message: 'Unknown voice stream session' });
      return;
    }

    const binaryChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
    session.chunks.push(binaryChunk);
    session.chunkCount = Number(session.chunkCount || 0) + 1;

    // Temporary debug signal to validate that live chunks are received server-side and broadcast to RH.
    const ackPayload = {
      streamId,
      interviewId: session.interviewId || undefined,
      chunkCount: session.chunkCount,
      chunkBytes: binaryChunk.length,
      sourceUserId: socket.user?.id || null,
      receivedAt: Date.now(),
    };
    socket.emit('voice-stream:chunk-ack', ackPayload);

    if (session.interviewId) {
      const room = `interview:${session.interviewId}`;
      socket.to(room).emit('voice-stream:chunk-ack', ackPayload);
    }

    if (session.realtimeWorker) {
      try {
        session.realtimeWorker.sendChunk(binaryChunk);
      } catch (error) {
        console.warn('Realtime worker chunk push failed:', error?.message || error);
        session.realtimeWorker.kill();
        session.realtimeWorker = null;
      }
    }
  });

  socket.on('voice-stream:stop', async ({ streamId }) => {
    const session = voiceStreamSessions.get(streamId);
    if (!session || session.socketId !== socket.id) {
      socket.emit('voice-stream:error', { streamId, message: 'Unknown voice stream session' });
      return;
    }

    voiceStreamSessions.delete(streamId);

    try {
      if (session.realtimeWorker) {
        try {
          await session.realtimeWorker.stop();
        } catch (workerError) {
          console.warn('Realtime worker stop failed:', workerError?.message || workerError);
        }
      }

      const wavBuffer = buildWavBuffer(session.chunks, session.sampleRate, session.channels);
      const tempPath = await writeTempWav(wavBuffer);
      
      // Save audio file with timestamp and interview ID
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const interviewIdPart = session.interviewId ? `${session.interviewId}_` : '';
      const audioFileName = `voice_${interviewIdPart}${timestamp}.wav`;
      const audioFilePath = path.join(audioDir, audioFileName);
      
      try {
        await fsp.copyFile(tempPath, audioFilePath);
        console.log(`✅ Audio saved: ${audioFileName}`);
      } catch (saveError) {
        console.warn('Failed to save audio file:', saveError?.message || saveError);
      }

      try {
        const result = await runVoiceEngineAnalysis(tempPath, {
          sampleRate: session.sampleRate,
          channels: session.channels,
          language: session.language,
          whisperDevice: session.whisperDevice,
          whisperModel: session.whisperModel,
          whisperComputeType: session.whisperComputeType,
          hfToken: session.hfToken,
          enableDiarization: session.enableDiarization,
          singleSpeakerLabel: session.singleSpeakerLabel,
          vadThreshold: session.vadThreshold,
          minSpeechMs: session.minSpeechMs,
          minSilenceMs: session.minSilenceMs,
          speechPadMs: session.speechPadMs,
          saveDir: uploadsDir,
        });

        const correctedText = await maybeCorrectTranscriptionText(result?.text || '', session.language || 'en');
        const summaryText = await maybeSummarizeTranscriptionText(correctedText || result?.text || '', session.language || 'en');
        const correctedSegments = buildCorrectedSegments(result?.segments || [], session.language || 'en');
        const overallSentiment = aggregateSegmentSentiment(correctedSegments);

        const savedFiles = result?.saved_files || {};
        const downloadFiles = {
          wav: buildDownloadMeta(savedFiles.wav),
          txt: buildDownloadMeta(savedFiles.txt),
          pdf: buildDownloadMeta(savedFiles.pdf),
          rawRecording: buildDownloadMeta(audioFilePath),
        };

        socket.emit('voice-stream:result', {
          ...result,
          corrected_text: correctedText || result?.text || '',
          summary: summaryText || result?.summary || '',
          corrected_segments: correctedSegments,
          sentiment_overall: overallSentiment.label,
          sentiment_score: overallSentiment.score,
          sentiment_counts: overallSentiment.counts,
          audioFile: audioFileName,
          audioPath: audioFilePath,
          downloadFiles,
        });

        if (session.interviewId) {
          socket.to(`interview:${session.interviewId}`).emit('voice-stream:result', {
            ...result,
            corrected_text: correctedText || result?.text || '',
            summary: summaryText || result?.summary || '',
            corrected_segments: correctedSegments,
            sentiment_overall: overallSentiment.label,
            sentiment_score: overallSentiment.score,
            sentiment_counts: overallSentiment.counts,
            audioFile: audioFileName,
            audioPath: audioFilePath,
            sourceUserId: socket.user?.id || null,
            downloadFiles,
          });
        }
      } finally {
        fs.promises.unlink(tempPath).catch(() => {});
      }
    } catch (error) {
      socket.emit('voice-stream:error', { streamId, message: error.message });
    }
  });

  socket.on("disconnect", (reason) => {
    const safeReason = String(reason || 'unknown');
    const label = safeReason === 'client namespace disconnect' ? 'info' : 'warn';
    console.log(`Socket ${label}: client disconnected`, {
      socketId: socket.id,
      userId: socket.user?.id || null,
      reason: safeReason,
    });

    for (const [streamId, session] of voiceStreamSessions.entries()) {
      if (session.socketId === socket.id) {
        if (session.realtimeWorker) {
          session.realtimeWorker.kill();
        }
        voiceStreamSessions.delete(streamId);
      }
    }
  });
});

const canSendEmail = () => Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);

const createMailTransporter = () =>
  nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

const sendCandidateDecisionEmail = async ({
  candidateEmail,
  candidateName,
  jobTitle,
  decision,
  recruiterNote,
}) => {
  if (!candidateEmail || !canSendEmail()) return;

  const safeCandidateName = String(candidateName || "Candidate").trim() || "Candidate";
  const safeJobTitle = String(jobTitle || "the position").trim() || "the position";
  const safeDecision = String(decision || "").toUpperCase();
  const safeRecruiterNote = String(recruiterNote || "").trim();
  const isRejected = safeDecision === "REJECTED";

  const subject = isRejected
    ? `Application Update - ${safeJobTitle}`
    : `Next Step - ${safeJobTitle}`;

  const statusLine = isRejected
    ? "After careful review, your application was not selected for this role."
    : "Good news! You have been shortlisted for the interview stage.";

  const noteLine = safeRecruiterNote
    ? `<p><strong>Recruiter note:</strong> ${safeRecruiterNote}</p>`
    : "";

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1f2937;">
      <p>Dear ${safeCandidateName},</p>
      <p>${statusLine}</p>
      <p><strong>Position:</strong> ${safeJobTitle}</p>
      ${noteLine}
      <p>Thank you for your interest in our company.</p>
      <p>Best regards,<br/>Recruitment Team</p>
    </div>
  `;

  const text = [
    `Dear ${safeCandidateName},`,
    "",
    statusLine,
    `Position: ${safeJobTitle}`,
    safeRecruiterNote ? `Recruiter note: ${safeRecruiterNote}` : "",
    "",
    "Thank you for your interest in our company.",
    "Best regards,",
    "Recruitment Team",
  ]
    .filter(Boolean)
    .join("\n");

  const transporter = createMailTransporter();
  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: candidateEmail,
    subject,
    text,
    html,
  });
};

const normalizeSkillList = (skills) => {
  if (!Array.isArray(skills)) return [];
  return skills
    .map((skill) => String(skill || "").trim().toLowerCase())
    .filter(Boolean);
};

const normalizeQuestionType = (typeValue) => String(typeValue || "").trim().toLowerCase();

const sanitizeToQcmQuestions = (questions = []) => {
  if (!Array.isArray(questions)) return [];

  const seen = new Set();
  const sanitized = [];

  questions.forEach((question) => {
    if (!question || typeof question !== "object") return;
    if (normalizeQuestionType(question.type || "QCM") !== "qcm") return;

    const rawOptions = Array.isArray(question.options) ? question.options : [];
    const options = rawOptions
      .slice(0, 4)
      .map((option) => String(option || "").trim());

    if (options.length < 4 || options.some((option) => !option)) {
      return;
    }

    const title = String(question.title || question.question || "Question")
      .replace(/\s*\((unique|variante)\s*\d+\)\s*$/i, "")
      .trim();
    if (!title) return;

    const dedupeKey = title.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    let correctAnswer = Number(question.correctAnswer);
    if (!Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer > 3) {
      correctAnswer = 0;
    }

    sanitized.push({
      ...question,
      title,
      question: title,
      type: "QCM",
      options,
      correctAnswer,
      expectedAnswer: String(question.expectedAnswer || options[correctAnswer] || options[0] || "").trim(),
      explanation: String(question.explanation || "").trim(),
      score: Math.max(1, Number(question.score) || 1),
      timeLimit: Math.max(15, Number(question.timeLimit) || 45),
    });
  });

  return sanitized;
};

const buildQuizRationale = ({ job, candidateProfile = {}, meta = {} }) => {
  const jobSkillsRaw = Array.isArray(job?.skills) ? job.skills : [];
  const jobSkills = normalizeSkillList(jobSkillsRaw);
  const matchedSkills = [];
  const prioritizedSkills = Array.isArray(meta?.skillsUsed) ? meta.skillsUsed.slice(0, 6) : [];

  const rationaleParts = [
    `Quiz généré pour le poste "${job?.title || "N/A"}".`,
    jobSkills.length
      ? `Compétences du poste ciblées: ${jobSkills.slice(0, 8).join(", ")}.`
      : "Le quiz couvre les exigences clés présentes dans la description du poste.",
    prioritizedSkills.length
      ? `Le modèle a priorisé: ${prioritizedSkills.join(", ")}.`
      : "Le modèle a priorisé les compétences techniques explicites du poste.",
  ];

  return {
    matchedSkills,
    rationale: rationaleParts.join(" "),
  };
};

const buildServerFallbackQuestions = ({ job = {}, candidateProfile = {}, totalQuestions = 20 }) => {
  const normalizedTotal = Math.max(1, Math.min(20, Number(totalQuestions) || 20));
  const jobSkills = normalizeSkillList(job?.skills || []);
  const candidateSkills = normalizeSkillList(candidateProfile?.skills || []);
  const prioritizedSkills = Array.from(new Set([...jobSkills, ...candidateSkills])).slice(0, 10);
  const safeSkills = prioritizedSkills.length ? prioritizedSkills : ["problem solving", "communication", "teamwork", "javascript", "sql"];
  const difficulties = ["facile", "moyen", "difficile"];
  const domains = ["technique", "logique", "métier", "analyse"];
  const qcmStems = [
    "Quel énoncé décrit le mieux le rôle de",
    "Dans ce contexte professionnel, quelle proposition est la plus juste pour",
    "Quelle est l'utilisation la plus pertinente de",
    "Quel bénéfice concret apporte",
    "Quelle bonne pratique est la plus liée à",
  ];

  return Array.from({ length: normalizedTotal }, (_, index) => {
    const questionNumber = index + 1;
    const skill = safeSkills[index % safeSkills.length];
    const difficulty = difficulties[index % difficulties.length];
    const domain = domains[index % domains.length];

    const stem = qcmStems[index % qcmStems.length];
    const title = `QCM ${questionNumber}: ${stem} ${skill} ?`;

    const optionVariants = [
      {
        options: [
          `${skill} aide à structurer une solution fiable et maintenable`,
          `${skill} n'a aucun impact sur la qualité du résultat`,
          `${skill} remplace complètement les tests et la validation`,
          `${skill} sert uniquement à la documentation`,
        ],
        correctAnswer: 0,
      },
      {
        options: [
          `${skill} doit être évité dans les projets réels`,
          `${skill} améliore la performance, la qualité ou la robustesse selon le cas`,
          `${skill} annule le besoin de revue de code`,
          `${skill} est utile uniquement pour les profils non techniques`,
        ],
        correctAnswer: 1,
      },
      {
        options: [
          `${skill} ne s'applique jamais en production`,
          `${skill} est seulement une tendance sans usage concret`,
          `${skill} permet de mieux résoudre des problèmes techniques ciblés`,
          `${skill} garantit automatiquement zéro bug`,
        ],
        correctAnswer: 2,
      },
      {
        options: [
          `${skill} supprime le besoin d'architecture et de conception`,
          `${skill} ne concerne que la partie visuelle d'un produit`,
          `${skill} est toujours incompatible avec le travail en équipe`,
          `${skill} est pertinent quand il est choisi selon le besoin métier et technique`,
        ],
        correctAnswer: 3,
      },
    ];

    const selectedVariant = optionVariants[index % optionVariants.length];

    return {
      title,
      question: title,
      type: "QCM",
      domain,
      skills: [skill],
      difficulty,
      options: selectedVariant.options,
      correctAnswer: selectedVariant.correctAnswer,
      expectedAnswer: selectedVariant.options[selectedVariant.correctAnswer],
      explanation: `La bonne réponse identifie la valeur pratique de ${skill}.`,
      score: 1,
      timeLimit: 30,
    };
  });
};

const selectAdaptivePageFallback = ({
  questions = [],
  page = 1,
  pageSize = 5,
  askedQuestionKeys = [],
}) => {
  const safeQuestions = Array.isArray(questions) ? questions : [];
  const safePageSize = Math.max(1, Math.min(10, Number(pageSize) || 5));
  const safePage = Math.max(1, Number(page) || 1);
  const askedSet = new Set(
    (Array.isArray(askedQuestionKeys) ? askedQuestionKeys : []).map((key) => Number(key)).filter(Number.isFinite)
  );

  const remaining = safeQuestions.filter((question) => {
    const key = Number(question?.questionKey);
    if (!Number.isFinite(key)) return true;
    return !askedSet.has(key);
  });

  const start = Math.max(0, (safePage - 1) * safePageSize);
  const selected = remaining.slice(start, start + safePageSize);
  const remainingCount = Math.max(0, remaining.length - (start + selected.length));

  return {
    success: true,
    page: safePage,
    pageSize: safePageSize,
    totalQuestions: safeQuestions.length,
    questions: selected,
    adaptation: {
      mode: "fallback-local-pagination",
      reason: "adaptive-ai-unavailable",
    },
    remainingCount,
    completed: selected.length === 0 || remainingCount === 0,
  };
};

const saveCandidateQuizFromAI = async ({
  jobId,
  candidateId,
  generatedBy = null,
  aiData = {},
  job = {},
  candidateProfile = {},
}) => {
  const questions = Array.isArray(aiData?.questions) ? aiData.questions : [];
  if (!questions.length) {
    return null;
  }

  const meta = aiData?.meta || {};
  const rationaleData = buildQuizRationale({ job, candidateProfile, meta });
  const updatePayload = {
    jobId,
    candidateId,
    questions,
    source: meta?.source || "mistral-api",
    generationMeta: {
      jobTitle: meta?.jobTitle || job?.title || "",
      skillsUsed: Array.isArray(meta?.skillsUsed) ? meta.skillsUsed : [],
      matchedSkills: rationaleData.matchedSkills,
      model: meta?.model || "",
      rationale: rationaleData.rationale,
      difficultyMix: meta?.difficultyMix || {},
      fallbackReason: meta?.fallbackReason || null,
    },
  };

  if (generatedBy && mongoose.Types.ObjectId.isValid(generatedBy)) {
    updatePayload.generatedBy = generatedBy;
  }

  return CandidateQuizModel.findOneAndUpdate(
    { jobId, candidateId },
    updatePayload,
    { upsert: true, new: true }
  );
};

const generateCandidateQuizForJobCandidate = async ({
  jobId,
  candidateId,
  totalQuestions = 20,
  forceMistral = true,
  generatedBy = null,
}) => {
  const job = await JobModel.findById(jobId).select("title description skills location").lean();
  if (!job) {
    throw new Error("Job not found");
  }

  const candidate = await UserModel.findById(candidateId)
    .select("_id")
    .lean();

  if (!candidate) {
    throw new Error("Candidate not found");
  }

  const aiPayload = {
    job: {
      title: job.title || "",
      description: job.description || "",
      skills: Array.isArray(job.skills) ? job.skills : [],
      location: job.location || "",
    },
    totalQuestions: Math.max(1, Math.min(20, Number(totalQuestions) || 10)),
    forceMistral: true,
  };

  const normalizedTotal = Math.max(1, Math.min(20, Number(totalQuestions) || 20));
  let aiData = {};
  let fallbackReason = null;

  try {
    const aiResponse = await axios.post("http://localhost:5003/generate-quiz", aiPayload, {
      timeout: 60000,
    });
    aiData = aiResponse.data || {};
  } catch (error) {
    fallbackReason = error?.response?.data?.message || error?.message || "AI quiz generation failed";
    aiData = {
      questions: buildServerFallbackQuestions({
        job,
        totalQuestions: normalizedTotal,
      }),
      meta: {
        source: "server-job-fallback",
        model: "fallback-local",
        jobTitle: job?.title || "",
        skillsUsed: normalizeSkillList(job?.skills || []).slice(0, 10),
        fallbackReason,
      },
    };
  }

  const aiQuestions = Array.isArray(aiData?.questions) ? aiData.questions : [];
  const sanitizedAiQcmQuestions = sanitizeToQcmQuestions(aiQuestions);

  if (sanitizedAiQcmQuestions.length < normalizedTotal) {
    const emergencyQuestions = buildServerFallbackQuestions({
      job,
      totalQuestions: normalizedTotal,
    });
    aiData = {
      ...aiData,
      questions: sanitizeToQcmQuestions(emergencyQuestions).slice(0, normalizedTotal),
      meta: {
        ...(aiData?.meta || {}),
        source: "server-job-fallback",
        model: "fallback-local",
        fallbackReason:
          fallbackReason
          || `insufficient-valid-questions:${sanitizedAiQcmQuestions.length}/${normalizedTotal}`,
      },
    };
  } else {
    aiData.questions = sanitizedAiQcmQuestions.slice(0, normalizedTotal);
  }

  const savedQuiz = await saveCandidateQuizFromAI({
    jobId,
    candidateId,
    generatedBy,
    aiData,
    job,
    candidateProfile: {},
  });

  return { aiData, savedQuiz };
};

const coachTokenize = (value) => {
  const text = String(value || "").toLowerCase();
  const tokens = text.match(/[a-zA-Zàâäçéèêëîïôöùûüÿñæœ]{3,}/g) || [];
  const stopwords = new Set([
    "avec", "pour", "dans", "sans", "entre", "plus", "moins", "cette", "cela", "that", "this",
    "des", "les", "une", "the", "and", "est", "sont", "sur", "par", "aux", "vous", "your",
  ]);
  return tokens.filter((token) => !stopwords.has(token));
};

const tokenOverlapRatio = (left, right) => {
  const a = new Set(coachTokenize(left));
  const b = new Set(coachTokenize(right));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  a.forEach((token) => {
    if (b.has(token)) overlap += 1;
  });
  return overlap / Math.max(1, b.size);
};

const clampScore = (value) => Math.max(0, Math.min(100, Math.round(value)));

const OPEN_ANSWER_ACCEPT_THRESHOLD = Math.max(
  0,
  Math.min(1, Number(process.env.OPEN_ANSWER_ACCEPT_THRESHOLD || 0.72))
);
const OPEN_ANSWER_REJECT_THRESHOLD = Math.max(
  0,
  Math.min(OPEN_ANSWER_ACCEPT_THRESHOLD, Number(process.env.OPEN_ANSWER_REJECT_THRESHOLD || 0.45))
);

const OPEN_QUESTION_TYPES = new Set(["réponse courte", "mini-exercice"]);

const evaluateOpenAnswerSemiAuto = ({ submittedAnswerText = "", expectedAnswerText = "", questionText = "", skillHints = [] }) => {
  const submitted = String(submittedAnswerText || "").trim();
  const expected = String(expectedAnswerText || "").trim();
  const hints = Array.isArray(skillHints) ? skillHints : [];

  if (!submitted) {
    return {
      isCorrect: false,
      needsHumanReview: false,
      aiSuggestedCorrect: false,
      aiConfidence: 0,
      evaluationMode: "auto-rejected-empty",
    };
  }

  const overlapExpected = expected ? tokenOverlapRatio(submitted, expected) : 0;
  const overlapQuestion = tokenOverlapRatio(submitted, questionText);
  const overlapSkills = tokenOverlapRatio(submitted, hints.join(" "));
  const semanticScore = (overlapExpected * 0.65) + (overlapQuestion * 0.2) + (overlapSkills * 0.15);
  const lengthScore = Math.min(100, Math.round((submitted.length / 260) * 100));
  const aiConfidence = clampScore((semanticScore * 100 * 0.75) + (lengthScore * 0.25));

  if (!expected) {
    const aiSuggestedCorrect = aiConfidence >= 55;
    return {
      isCorrect: aiSuggestedCorrect,
      needsHumanReview: true,
      aiSuggestedCorrect,
      aiConfidence,
      evaluationMode: "ambiguous-no-expected",
    };
  }

  if (overlapExpected >= OPEN_ANSWER_ACCEPT_THRESHOLD) {
    return {
      isCorrect: true,
      needsHumanReview: false,
      aiSuggestedCorrect: true,
      aiConfidence,
      evaluationMode: "auto-accepted",
    };
  }

  if (overlapExpected <= OPEN_ANSWER_REJECT_THRESHOLD) {
    return {
      isCorrect: false,
      needsHumanReview: false,
      aiSuggestedCorrect: false,
      aiConfidence,
      evaluationMode: "auto-rejected",
    };
  }

  const aiSuggestedCorrect = semanticScore >= 0.55;
  return {
    isCorrect: aiSuggestedCorrect,
    needsHumanReview: true,
    aiSuggestedCorrect,
    aiConfidence,
    evaluationMode: "ambiguous-threshold-band",
  };
};

const buildOpenAnswerRubric = ({ answer, question, skillHints = [] }) => {
  const text = String(answer?.selectedAnswerText || "").trim();
  const expected = String(answer?.expectedAnswer || question?.expectedAnswer || "").trim();
  const questionText = String(question?.title || question?.question || answer?.question || "");

  const lengthScore = Math.min(100, Math.round((text.length / 260) * 100));
  const structureBonus = text.includes("\n") || text.includes("-") || text.includes(";") ? 15 : 0;
  const structure = clampScore(lengthScore * 0.6 + structureBonus);

  const exactitudeOverlap = tokenOverlapRatio(text, expected);
  const exactitude = clampScore(exactitudeOverlap * 100);

  const relevanceQuestion = tokenOverlapRatio(text, questionText);
  const relevanceSkills = tokenOverlapRatio(text, skillHints.join(" "));
  const pertinence = clampScore(((relevanceQuestion * 0.6) + (relevanceSkills * 0.4)) * 100);

  const global = clampScore((structure * 0.35) + (exactitude * 0.35) + (pertinence * 0.30));
  const confidence = clampScore((global * 0.7) + (Math.min(100, text.length) * 0.3));

  let feedback = "Réponse correcte mais peut être renforcée en structurant mieux les idées.";
  if (global >= 80) {
    feedback = "Très bonne réponse: claire, pertinente et techniquement solide.";
  } else if (global < 50) {
    feedback = "Réponse à améliorer: manque de structure et de précision technique.";
  }

  return {
    questionIndex: answer?.questionIndex,
    question: answer?.question || questionText,
    rubric: {
      structure,
      exactitude,
      pertinence,
    },
    globalScore: global,
    confidence,
    feedback,
  };
};

const buildSkillNarrative = ({ answersDetailed = [], questions = [] }) => {
  const skillStats = new Map();

  answersDetailed.forEach((answer, index) => {
    const question = questions[index] || {};
    const skills = Array.isArray(question?.skills) && question.skills.length
      ? question.skills
      : [question?.domain || "general"];

    skills.forEach((skillValue) => {
      const skill = String(skillValue || "general").toLowerCase();
      if (!skillStats.has(skill)) {
        skillStats.set(skill, { total: 0, correct: 0, openCount: 0, openScoreSum: 0 });
      }
      const current = skillStats.get(skill);
      current.total += 1;
      if (answer?.isCorrect) current.correct += 1;
      skillStats.set(skill, current);
    });
  });

  const bySkill = [];
  skillStats.forEach((stats, skill) => {
    const successRate = stats.total ? (stats.correct / stats.total) * 100 : 0;
    let level = "À renforcer";
    if (successRate >= 80) level = "Fort";
    else if (successRate >= 60) level = "Intermédiaire";

    const strength = successRate >= 70
      ? `Bonne maîtrise de ${skill}, avec des réponses globalement justes.`
      : `Base présente sur ${skill}, mais la précision reste irrégulière.`;

    const improvementPlan = successRate >= 80
      ? `Approfondir ${skill} via cas avancés et optimisation.`
      : `Réviser ${skill} avec exercices ciblés, puis refaire un mini-quiz pratique.`;

    bySkill.push({
      skill,
      successRate: clampScore(successRate),
      level,
      strength,
      improvementPlan,
    });
  });

  bySkill.sort((left, right) => right.successRate - left.successRate);
  const strongSkills = bySkill.filter((entry) => entry.successRate >= 70).slice(0, 3).map((entry) => entry.skill);
  const weakSkills = bySkill.filter((entry) => entry.successRate < 70).slice(0, 3).map((entry) => entry.skill);

  const summary = {
    strengths: strongSkills,
    improvements: weakSkills,
    narrative: strongSkills.length
      ? `Vos points forts: ${strongSkills.join(", ")}. Priorité d'amélioration: ${weakSkills.join(", ") || "stabilité globale"}.`
      : `Le quiz montre des bases en construction. Priorité: ${weakSkills.join(", ") || "fondamentaux techniques"}.`,
  };

  return { bySkill, summary };
};

const buildRuleBasedCoachFeedback = ({
  answersDetailed = [],
  questions = [],
  job = {},
  score = 0,
  totalQuestions = 0,
}) => {
  const openTypes = new Set(["réponse courte", "mini-exercice"]);
  const openRubric = [];

  answersDetailed.forEach((answer, index) => {
    const question = questions[index] || {};
    const type = String(answer?.questionType || question?.type || "").toLowerCase();
    if (!openTypes.has(type)) return;
    openRubric.push(
      buildOpenAnswerRubric({
        answer,
        question,
        skillHints: Array.isArray(question?.skills) ? question.skills : [],
      })
    );
  });

  const skillNarrative = buildSkillNarrative({ answersDetailed, questions });
  const overallRubricAverage = openRubric.length
    ? clampScore(openRubric.reduce((sum, item) => sum + Number(item?.globalScore || 0), 0) / openRubric.length)
    : null;

  const jobTitle = String(job?.title || "ce poste").trim() || "ce poste";
  const targetSkills = normalizeSkillList(job?.skills || []).slice(0, 6);
  const weakSkills = Array.isArray(skillNarrative?.summary?.improvements)
    ? skillNarrative.summary.improvements.filter(Boolean).slice(0, 3)
    : [];
  const strongSkills = Array.isArray(skillNarrative?.summary?.strengths)
    ? skillNarrative.summary.strengths.filter(Boolean).slice(0, 3)
    : [];

  const totalSafe = Math.max(1, Number(totalQuestions) || 1);
  const scoreRate = Math.round((Math.max(0, Number(score) || 0) / totalSafe) * 100);
  const hiringReadiness = scoreRate >= 75 ? "élevée" : scoreRate >= 55 ? "intermédiaire" : "en progression";

  const actionPlan = [
    weakSkills.length
      ? `Renforcez cette semaine: ${weakSkills.join(", ")} avec 1 exercice pratique par compétence.`
      : "Consolidez vos bases avec des exercices chronométrés orientés poste.",
    targetSkills.length
      ? `Alignez vos réponses sur les besoins du poste: ${targetSkills.join(", ")}.`
      : "Reliez chaque réponse au besoin métier et à l'impact concret attendu.",
    typeof overallRubricAverage === "number" && overallRubricAverage < 70
      ? "Améliorez vos réponses ouvertes avec la structure: contexte → action → résultat mesurable."
      : "Continuez à structurer vos réponses avec des exemples concrets (projet, impact, métrique).",
  ];

  const futureApplicationTips = [
    `Pour votre prochaine candidature sur "${jobTitle}", préparez 2 exemples projet directement liés au poste.`,
    "Préparez 3 réponses STAR (Situation, Tâche, Action, Résultat) sur vos compétences clés.",
    "Avant de postuler à nouveau, refaites un quiz blanc de 20 questions en temps limité.",
  ];

  const coachNarrative = [
    `🎯 Coaching ciblé pour le poste "${jobTitle}".`,
    strongSkills.length ? `Points forts à valoriser en entretien: ${strongSkills.join(", ")}.` : "Vos bases sont présentes et peuvent être mieux mises en valeur.",
    weakSkills.length ? `Axes prioritaires avant la prochaine candidature: ${weakSkills.join(", ")}.` : "Continuez sur cette dynamique avec des cas pratiques orientés poste.",
  ].join(" ");

  return {
    generatedAt: new Date(),
    summary: {
      ...skillNarrative.summary,
      coachEngine: "rule-based",
      coachTitle: `AI Hiring Coach • ${jobTitle}`,
      hiringPerspective: `Niveau de préparation estimé: ${hiringReadiness} (${scoreRate}%).`,
      narrative: coachNarrative,
      openAnswerAverage: overallRubricAverage,
      actionPlan,
      futureApplicationTips,
    },
    bySkill: skillNarrative.bySkill,
    openAnswerRubric: openRubric,
  };
};

const readEnvValueFromFile = (key) => {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return "";
    const content = fs.readFileSync(envPath, "utf8");
    const line = content
      .split(/\r?\n/)
      .find((row) => row.trim().startsWith(`${key}=`));
    if (!line) return "";
    return String(line.split("=").slice(1).join("=") || "").trim();
  } catch (_) {
    return "";
  }
};

const resolveCoachLlmEnabled = () => {
  const raw = String(process.env.COACH_USE_LLM || readEnvValueFromFile("COACH_USE_LLM") || "true").trim().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
};

const resolveCoachMistralConfig = () => {
  const apiKey = String(process.env.MISTRAL_API_KEY || readEnvValueFromFile("MISTRAL_API_KEY") || "").trim();
  const model = String(process.env.MISTRAL_MODEL || readEnvValueFromFile("MISTRAL_MODEL") || "ministral-8b-latest").trim();
  const apiUrl = String(process.env.MISTRAL_API_URL || readEnvValueFromFile("MISTRAL_API_URL") || "https://api.mistral.ai/v1/chat/completions").trim();
  const timeoutMs = Math.max(10000, Number(process.env.COACH_LLM_TIMEOUT_MS || readEnvValueFromFile("COACH_LLM_TIMEOUT_MS") || 60000));
  return { apiKey, model, apiUrl, timeoutMs };
};

const parseCoachJsonResponse = (rawContent) => {
  if (rawContent && typeof rawContent === "object" && !Array.isArray(rawContent)) {
    if (rawContent.summary || rawContent.bySkill) {
      return rawContent;
    }
    if (rawContent.outputSchema && typeof rawContent.outputSchema === "object") {
      return rawContent.outputSchema;
    }
  }

  let normalizedRaw = rawContent;
  if (Array.isArray(rawContent)) {
    normalizedRaw = rawContent
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          return item?.text || item?.content || item?.value || "";
        }
        return "";
      })
      .join(" ");
  } else if (rawContent && typeof rawContent === "object") {
    normalizedRaw = rawContent?.text || rawContent?.content || JSON.stringify(rawContent);
  }

  const content = String(normalizedRaw || "").trim();
  if (!content) return null;

  try {
    const parsed = JSON.parse(content);
    if (parsed?.outputSchema && typeof parsed.outputSchema === "object") {
      return parsed.outputSchema;
    }
    return parsed;
  } catch (_) {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        const parsed = JSON.parse(content.slice(start, end + 1));
        if (parsed?.outputSchema && typeof parsed.outputSchema === "object") {
          return parsed.outputSchema;
        }
        return parsed;
      } catch (__){
        return null;
      }
    }
  }

  return null;
};

const buildAiCoachFeedback = async ({
  answersDetailed = [],
  questions = [],
  job = {},
  score = 0,
  totalQuestions = 0,
}) => {
  const baseCoach = buildRuleBasedCoachFeedback({
    answersDetailed,
    questions,
    job,
    score,
    totalQuestions,
  });

  const coachLlmEnabled = resolveCoachLlmEnabled();
  const mistralConfig = resolveCoachMistralConfig();
  console.log("[AI-COACH] config", {
    coachLlmEnabled,
    hasApiKey: Boolean(mistralConfig.apiKey),
    model: mistralConfig.model,
    apiUrl: mistralConfig.apiUrl,
    timeoutMs: mistralConfig.timeoutMs,
  });

  if (!coachLlmEnabled || !mistralConfig.apiKey) {
    console.warn("[AI-COACH] using rule-based coach due to missing config");
    return {
      ...baseCoach,
      summary: {
        ...baseCoach.summary,
        coachEngine: "rule-based",
        coachFallbackReason: !coachLlmEnabled ? "coach-llm-disabled" : "missing-mistral-api-key",
      },
    };
  }

  const jobTitle = String(job?.title || "ce poste").trim() || "ce poste";
  const targetSkills = normalizeSkillList(job?.skills || []).slice(0, 8);
  const scoreRate = Math.round((Math.max(0, Number(score) || 0) / Math.max(1, Number(totalQuestions) || 1)) * 100);

  const compactSkillStats = (baseCoach?.bySkill || []).slice(0, 8).map((item) => ({
    skill: item?.skill,
    successRate: item?.successRate,
    level: item?.level,
  }));

  const openAverage = baseCoach?.summary?.openAnswerAverage;

  const systemPrompt = [
    "Tu es un coach de recrutement senior.",
    "Ta mission: fournir un feedback motivant, concret et personnalisé pour aider le candidat à réussir ce poste à la prochaine tentative.",
    "Sois précis, orienté action, sans jugement négatif.",
    "Réponds UNIQUEMENT en JSON valide, court et direct.",
  ].join(" ");

  const userPrompt = JSON.stringify({
    task: "Generate personalized hiring coach feedback for a failed/weak quiz attempt",
    locale: "fr",
    role: "candidate",
    context: {
      jobTitle,
      targetSkills,
      score,
      totalQuestions,
      scoreRate,
      openAnswerAverage: openAverage,
      bySkill: compactSkillStats,
    },
    outputSchema: {
      summary: {
        coachTitle: "string",
        hiringPerspective: "string",
        narrative: "string",
        actionPlan: ["string", "string", "string"],
        futureApplicationTips: ["string", "string", "string"],
      },
      bySkill: [
        {
          skill: "string",
          strength: "string",
          improvementPlan: "string",
        },
      ],
    },
    constraints: [
      "narrative max 55 words",
      "actionPlan exactly 3 items",
      "futureApplicationTips exactly 3 items",
      "must mention the job title",
      "must be encouraging and practical",
      "no markdown, no numbering, each item under 14 words",
    ],
  });

  try {
    const llmResponse = await axios.post(
      mistralConfig.apiUrl,
      {
        model: mistralConfig.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 380,
        response_format: { type: "json_object" },
      },
      {
        timeout: mistralConfig.timeoutMs,
        headers: {
          Authorization: `Bearer ${mistralConfig.apiKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    const rawContent = llmResponse?.data?.choices?.[0]?.message?.content || "";
    console.log("[AI-COACH] raw content type", typeof rawContent, Array.isArray(rawContent) ? "array" : "");
    console.log("[AI-COACH] raw content preview", String(
      Array.isArray(rawContent)
        ? rawContent.map((item) => (typeof item === "string" ? item : JSON.stringify(item))).join(" ")
        : (typeof rawContent === "object" ? JSON.stringify(rawContent) : rawContent)
    ).slice(0, 600));
    let parsed = parseCoachJsonResponse(rawContent);
    if (!parsed || typeof parsed !== "object") {
      console.warn("[AI-COACH] first parse failed, retrying with strict-json prompt");
      const retryResponse = await axios.post(
        mistralConfig.apiUrl,
        {
          model: mistralConfig.model,
          messages: [
            {
              role: "system",
              content: "Réponds STRICTEMENT avec un JSON minifié valide. Aucun markdown, aucun lien, aucun texte hors JSON.",
            },
            {
              role: "user",
              content: JSON.stringify({
                summary: {
                  coachTitle: `AI Hiring Coach • ${jobTitle}`,
                  hiringPerspective: "string",
                  narrative: "string",
                  actionPlan: ["string", "string", "string"],
                  futureApplicationTips: ["string", "string", "string"],
                },
                bySkill: compactSkillStats.map((s) => ({
                  skill: s.skill,
                  strength: "string",
                  improvementPlan: "string",
                })),
              }),
            },
          ],
          temperature: 0.1,
          max_tokens: 320,
          response_format: { type: "json_object" },
        },
        {
          timeout: mistralConfig.timeoutMs,
          headers: {
            Authorization: `Bearer ${mistralConfig.apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      const retryRawContent = retryResponse?.data?.choices?.[0]?.message?.content || "";
      parsed = parseCoachJsonResponse(retryRawContent);
      if (!parsed || typeof parsed !== "object") {
        console.warn("[AI-COACH] retry parse failed, attempting line-based coach fallback");
        const lineResponse = await axios.post(
          mistralConfig.apiUrl,
          {
            model: mistralConfig.model,
            messages: [
              {
                role: "system",
                content: "Réponds en texte brut avec EXACTEMENT ces clés en début de ligne, sans markdown.",
              },
              {
                role: "user",
                content: [
                  `JOB_TITLE: ${jobTitle}`,
                  `SCORE_RATE: ${scoreRate}`,
                  "Format strict:",
                  "COACH_TITLE: ...",
                  "HIRING_PERSPECTIVE: ...",
                  "NARRATIVE: ...",
                  "ACTION_1: ...",
                  "ACTION_2: ...",
                  "ACTION_3: ...",
                  "TIP_1: ...",
                  "TIP_2: ...",
                  "TIP_3: ...",
                ].join("\n"),
              },
            ],
            temperature: 0.1,
            max_tokens: 280,
          },
          {
            timeout: mistralConfig.timeoutMs,
            headers: {
              Authorization: `Bearer ${mistralConfig.apiKey}`,
              "Content-Type": "application/json",
            },
          }
        );

        const lineText = String(lineResponse?.data?.choices?.[0]?.message?.content || "");
        const pickLine = (key) => {
          const regex = new RegExp(`^${key}\\s*:\\s*(.+)$`, "im");
          const match = lineText.match(regex);
          return match ? String(match[1] || "").trim() : "";
        };

        const coachTitle = pickLine("COACH_TITLE") || baseCoach?.summary?.coachTitle;
        const hiringPerspective = pickLine("HIRING_PERSPECTIVE") || baseCoach?.summary?.hiringPerspective;
        const narrative = pickLine("NARRATIVE") || baseCoach?.summary?.narrative;
        const actionPlan = [pickLine("ACTION_1"), pickLine("ACTION_2"), pickLine("ACTION_3")].filter(Boolean);
        const tips = [pickLine("TIP_1"), pickLine("TIP_2"), pickLine("TIP_3")].filter(Boolean);

        if (coachTitle || hiringPerspective || narrative) {
          return {
            ...baseCoach,
            summary: {
              ...baseCoach.summary,
              coachEngine: "mistral-llm",
              coachTitle,
              hiringPerspective,
              narrative,
              actionPlan: actionPlan.length ? actionPlan : baseCoach?.summary?.actionPlan || [],
              futureApplicationTips: tips.length ? tips : baseCoach?.summary?.futureApplicationTips || [],
            },
          };
        }

        return {
          ...baseCoach,
          summary: {
            ...baseCoach.summary,
            coachEngine: "rule-based",
            coachFallbackReason: "invalid-json-from-llm",
          },
        };
      }
    }

    const llmSummary = parsed?.summary || {};
    const llmBySkill = Array.isArray(parsed?.bySkill) ? parsed.bySkill : [];

    const mergedBySkill = (baseCoach.bySkill || []).map((baseItem) => {
      const match = llmBySkill.find(
        (item) => String(item?.skill || "").toLowerCase() === String(baseItem?.skill || "").toLowerCase()
      );
      if (!match) return baseItem;

      return {
        ...baseItem,
        strength: String(match?.strength || baseItem.strength || "").trim() || baseItem.strength,
        improvementPlan: String(match?.improvementPlan || baseItem.improvementPlan || "").trim() || baseItem.improvementPlan,
      };
    });

    console.log("[AI-COACH] using mistral-llm coach");
    return {
      ...baseCoach,
      summary: {
        ...baseCoach.summary,
        coachEngine: "mistral-llm",
        coachTitle: String(llmSummary?.coachTitle || baseCoach?.summary?.coachTitle || `AI Hiring Coach • ${jobTitle}`),
        hiringPerspective: String(llmSummary?.hiringPerspective || baseCoach?.summary?.hiringPerspective || ""),
        narrative: String(llmSummary?.narrative || baseCoach?.summary?.narrative || ""),
        actionPlan:
          Array.isArray(llmSummary?.actionPlan) && llmSummary.actionPlan.length
            ? llmSummary.actionPlan.slice(0, 3).map((item) => String(item || "").trim()).filter(Boolean)
            : baseCoach?.summary?.actionPlan || [],
        futureApplicationTips:
          Array.isArray(llmSummary?.futureApplicationTips) && llmSummary.futureApplicationTips.length
            ? llmSummary.futureApplicationTips.slice(0, 3).map((item) => String(item || "").trim()).filter(Boolean)
            : baseCoach?.summary?.futureApplicationTips || [],
      },
      bySkill: mergedBySkill,
    };
  } catch (coachError) {
    console.warn("⚠️ AI coach LLM unavailable, using rule-based fallback:", coachError?.message || coachError);
    return {
      ...baseCoach,
      summary: {
        ...baseCoach.summary,
        coachEngine: "rule-based",
        coachFallbackReason: String(coachError?.message || "llm-call-failed"),
      },
    };
  }
};



// Swagger Configuration
const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "JobMatch API",
      version: "1.0.0",
      description: "API documentation for JobMatch recruitment platform",
    },
    servers: [{
      url: "http://localhost:5173",
    }],
  },
  apis: ["./routes/*.js"],
};

const swaggerSpec = swaggerJsdoc(options);

// Swagger UI Setup
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Middleware
app.use(express.json());
app.use(cookieParser());

// CORS Configuration
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);
app.use('/api/messages', messageRoutes);
app.use('/api/voice', voiceRoutes);

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

// Passport Configuration
passport.use(
  new GoogleStrategy({
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3001/auth/google/callback",
    },
    async(accessToken, refreshToken, profile, done) => {
      try {
        let user = await UserModel.findOne({ email: profile.emails[0].value });

        if (!user) {
          user = await UserModel.create({
            email: profile.emails[0].value,
            name: profile.displayName,
            googleId: profile.id,
            emailVerified: true,
            role: "CANDIDATE",
          });
        }

        user.googleId = profile.id;
        user.googleCalendar = user.googleCalendar || {};
        user.googleCalendar.accessToken = accessToken;
        if (refreshToken) {
          user.googleCalendar.refreshToken = refreshToken;
        }
        user.googleCalendar.connectedAt = new Date();
        user.googleCalendar.calendarId = user.googleCalendar.calendarId || 'primary';
        await user.save();

        return done(null, user);
      } catch (err) {
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async(id, done) => {
  const user = await UserModel.findById(id);
  done(null, user);
});

const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

app.post("/auth/google", async(req, res) => {
  const { credential } = req.body;

  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = payload.email;
    const name = payload.name;
    const googleId = payload.sub;

    let user = await UserModel.findOne({ email });

    if (!user) {
      user = new UserModel({
        email,
        name,
        googleId,
        emailVerified: true,
        role: "CANDIDATE",
      });
      await user.save();
    }

    const token = jwt.sign({ id: user._id, email: user.email },
      process.env.JWT_SECRET_KEY, { expiresIn: "7d" }
    );

    res.status(200).json({
      status: true,
      message: "Google login successful",
      token,
      userId: user._id,
      role: user.role,
    });
  } catch (error) {
    console.error("❌ Google Auth Error:", error);
    res.status(500).json({ message: "Google authentication failed." });
  }
});

// Routes
const userRoutes = require('./routes/userRoute');
const jobRoutes = require('./routes/jobRoute');
const interviewRoutes = require('./routes/interviewRoute');
const callRoomRoutes = require('./routes/callRoom');
const quizRoutes = require('./routes/quizRoute');
const linkedinRoute = require('./routes/linkedinRoute');
const linkedinEnrichRoute = require('./routes/linkedinEnrichRoute');
const schedulingInternalRoute = require('./routes/schedulingInternalRoute');
const recruiterCalendarRoute = require('./routes/recruiterCalendarRoute');

const SCHEDULING_SERVICE_URL = process.env.SCHEDULING_SERVICE_URL || 'http://localhost:5004';
const SCHEDULING_SERVICE_TIMEOUT = Number(process.env.SCHEDULING_SERVICE_TIMEOUT || 12000);



app.use('/api', userRoutes);
app.use('/api', jobRoutes);
app.use('/api/interviews', interviewRoutes);
app.use('/api/call-rooms', callRoomRoutes);
app.use('/quiz', quizRoutes);
app.use('/api/internal/scheduling', schedulingInternalRoute);
app.use('/api/recruiter/calendar', recruiterCalendarRoute);
// Mount a Google callback alias so OAuth clients already configured with
// /auth/google/callback can complete recruiter calendar authorization.
app.use('/auth/google', recruiterCalendarRoute);
app.use('/api/linkedin', linkedinEnrichRoute);
app.use('/api/linkedin', linkedinRoute);
app.use('/auth/linkedin', linkedinRoute);

// Audio recording directory
const audioDir = path.join(__dirname, 'voice-recordings');
if (!fs.existsSync(audioDir)) {
  fs.mkdirSync(audioDir, { recursive: true });
}

const uploadDir = path.join(__dirname, 'uploads');
const resumeUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `resume-${Date.now()}${path.extname(file.originalname)}`)
  }),
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png',
      'image/jpeg',
      'image/jpg'
    ];
    allowedTypes.includes(file.mimetype) ? cb(null, true) : cb(new Error("Unsupported file format."), false);
  }
});

// Authentication Routes
  app.post("/Frontend/login", async (req, res) => {
    try {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
      }

      const user = await UserModel.findOne({ email });

      if (!user) {
        return res.status(401).json({ message: "Invalid email or password!" });
      }

      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch) {
        return res.status(401).json({ message: "Invalid email or password!" });
      }

      if (!user.verificationStatus.emailVerified || user.verificationStatus.status !== 'APPROVED') {
        return res.status(401).json({
          message: "Please verify your email before logging in.",
          emailVerified: false
        });
      }

      const token = jwt.sign(
        { id: user._id, email: user.email },
        process.env.JWT_SECRET_KEY,
        { expiresIn: "7d" }
      );

      
      const userData = {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        profile: user.profile,
        enterprise: user.enterprise,
        picture: user.picture
      };

      return res.json({
        status: true,
        message: "Login successful",
        token,
        userId: user._id,
        role: user.role,
        emailVerified: true,
        userData // ✅ ici tu passes bien l'objet complet
      });
    } catch (err) {
      console.error("Login Error:", err);
      return res.status(500).json({ message: "Server error" });
    }
  });

app.post('/Frontend/register', resumeUpload.single('resume'), async(req, res) => {
    try {
        const { name, email, password, role } = req.body;

        if (!email || !password || !role) {
            return res.status(400).json({ message: 'Email, password, and role are required' });
        }

        const existingUser = await UserModel.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: 'Email already in use.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const verificationCode = Math.floor(100000 + Math.random() * 900000);

        const userData = {
            email,
            name,
            password: hashedPassword,
            role,
            isActive: true,
            verificationCode,
            verificationStatus: {
                status: 'PENDING',
                emailVerified: false
            }
        };

        if (role === "CANDIDATE") {
            userData.profile = {
                resume: "",
            shortDescription: "",
                skills: [],
                phone: "",
                languages: [],
                availability: "Full-time",
                experience: []
            };

            if (req.file) {
                const filePath = path.join(uploadDir, req.file.filename);
                const FormData = require('form-data');
                const form = new FormData();
                form.append('resume', fs.createReadStream(filePath));

                try {
                    const pythonResponse = await axios.post('http://127.0.0.1:5002/upload', form, {
                        headers: {
                            ...form.getHeaders(),
                        },
                    });

                    const resumeData = pythonResponse.data;
                    if (resumeData?.error || !resumeData?.profile) {
                      try {
                        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                      } catch (cleanupError) {
                        console.error('⚠️ Failed to cleanup invalid CV file:', cleanupError.message);
                      }
                      return res.status(400).json({
                        message: 'Invalid CV file. Please upload a real CV document.',
                        details: resumeData?.error || 'CV verification failed'
                      });
                    }

                    userData.profile.resume = `/uploads/${req.file.filename}`;
                    userData.profile.shortDescription = resumeData.profile?.shortDescription || "";
                    userData.profile.skills = resumeData.profile?.skills || [];
                    userData.profile.languages = resumeData.profile?.languages || [];
                    userData.profile.phone = resumeData.profile?.phone || "";
                    userData.profile.experience = Array.isArray(resumeData.profile?.experience)
                      ? resumeData.profile.experience
                      : [];
                    
                    

                    if (resumeData.name) userData.name = resumeData.name;
                } catch (error) {
                  console.error("❌ Resume analysis error:", error.message);

                  if (error.response) {
                    console.error("📨 Erreur IA réponse:", error.response.data);
                    if (error.response.status === 400) {
                      try {
                        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                      } catch (cleanupError) {
                        console.error('⚠️ Failed to cleanup invalid CV file:', cleanupError.message);
                      }
                      return res.status(400).json({
                        message: 'Invalid CV file. Please upload a real CV document.',
                        details: error.response.data?.error || 'CV verification failed'
                      });
                    }
                    return res.status(500).json({ 
                      message: "Error analyzing resume from AI model.",
                      details: error.response.data
                    });
                  } else if (error.request) {
                    console.error("📡 Aucune réponse reçue de l'IA:", error.request);
                    return res.status(500).json({ 
                      message: "No response from AI model.",
                      details: "Check if the Flask server is running on port 5002"
                    });
                  } else {
                    console.error("❗ Autre erreur:", error.message);
                    return res.status(500).json({ 
                      message: "Unexpected error during resume analysis.",
                      details: error.message
                    });
                  }
                  
                }
            }
        }

        if (role === "ENTERPRISE") {
            userData.enterprise = {
                name: req.body.enterpriseName,
                industry: req.body.industry,
                location: req.body.location,
                website: req.body.website,
                description: req.body.description,
                employeeCount: parseInt(req.body.employeeCount || 0)
            };
            userData.jobsPosted = [];
            userData.applications = [];
            userData.interviews = [];
        }

        const newUser = new UserModel(userData);
        await newUser.save();

        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS,
            },
        });

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: '🔐 Verification Code',
            text: `Hello,\n\nYour verification code is: ${verificationCode}\n\nPlease enter this code on the verification page.`,
        };

        await transporter.sendMail(mailOptions);
        res.json({ message: 'User created. A verification code has been sent to your email.' });
    } catch (err) {
        console.error('❌ Registration error:', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post("/Frontend/verify-email", async(req, res) => {
    try {
        const { email, verificationCode } = req.body;
        const user = await UserModel.findOne({ email });

        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        if (user.verificationStatus.emailVerified) {
            return res.status(400).json({ message: "Email already verified." });
        }

        if (user.verificationCode !== parseInt(verificationCode, 10)) {
            return res.status(400).json({ message: "Invalid verification code." });
        }

        user.verificationStatus.emailVerified = true;
        user.verificationStatus.status = "APPROVED";
        user.verificationCode = null;
        await user.save();

        res.json({ message: "Email verified successfully! You can now login." });
    } catch (err) {
        console.error("❌ Verification Error:", err);
        res.status(500).json({ message: "Server error." });
    }
});

// File Upload Configuration
const uploadPicsDir = path.join(__dirname, 'uploadsPics');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

if (!fs.existsSync(uploadPicsDir)) {
    fs.mkdirSync(uploadPicsDir, { recursive: true });
}

app.use("/uploads", express.static(uploadDir));
app.use("/uploadsPics", express.static(uploadPicsDir));
app.use('/uploadsPics', express.static(path.join(__dirname, 'uploadsPics')));
app.use("/voice-recordings", express.static(audioDir));

// Resume Upload Configuration
const resumeStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `temp-${Date.now()}${path.extname(file.originalname)}`),
});
const resumeFileFilter = (req, file, cb) => {
    const allowedTypes = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
    'image/jpg',
    ];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Unsupported file format.'), false);
    }
};

// Profile Picture Upload Configuration
const profileStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadPicsDir),
    filename: (req, file, cb) => {
        const userId = req.body.userId || 'unknown';
        cb(null, `${userId}-profile-${Date.now()}${path.extname(file.originalname)}`);
    },
});
const profileFileFilter = (req, file, cb) => {
    const allowedImageTypes = ['image/jpeg', 'image/png', 'image/gif'];
    if (allowedImageTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Only JPEG, PNG, and GIF formats are supported.'), false);
    }
};

app.get("/Frontend/user/:id", async (req, res) => {
    try {
      console.log("📥 Données reçues pour mise à jour:", req.body);
  
      const user = await UserModel.findById(req.params.id);
      if (!user) return res.status(404).json({ error: "Utilisateur non trouvé" });
  
      // 🔹 Mise à jour des champs de base
      user.name = req.body.name || user.name;
      user.email = req.body.email || user.email;
  
      // 🔐 Mise à jour du mot de passe si fourni
      if (req.body.password && req.body.password.length > 4) {
        const hashedPassword = await bcrypt.hash(req.body.password, 10);
        user.password = hashedPassword;
      }
  
      // 🧩 Mise à jour du profil utilisateur
      if (!user.profile) user.profile = {};
      const profile = req.body.profile || {};
      user.profile.phone = profile.phone ?? user.profile.phone;
      user.profile.resume = profile.resume ?? user.profile.resume;
      user.profile.shortDescription = profile.shortDescription ?? user.profile.shortDescription;
      user.profile.availability = profile.availability ?? user.profile.availability;
      user.profile.skills = profile.skills ?? user.profile.skills;
      user.profile.languages = profile.languages ?? user.profile.languages;
      user.profile.experience = profile.experience ?? user.profile.experience;
      user.markModified("profile");
  
      // 🏢 Mise à jour des données entreprise si role === 'ENTERPRISE'
      if (user.role === "ENTERPRISE" && req.body.enterprise) {
        if (!user.enterprise) user.enterprise = {};
        const ent = req.body.enterprise;
  
        user.enterprise.name = ent.name || user.enterprise.name;
        user.enterprise.picture = ent.picture || user.enterprise.picture;
        user.enterprise.industry = ent.industry || user.enterprise.industry;
        user.enterprise.location = ent.location || user.enterprise.location;
        user.enterprise.website = ent.website || user.enterprise.website;
        user.enterprise.description = ent.description || user.enterprise.description;
        user.enterprise.employeeCount = ent.employeeCount ?? user.enterprise.employeeCount;
  
        user.markModified("enterprise");
      }
  
      await user.save();
      console.log("✅ Utilisateur mis à jour avec succès !");
      return res.status(200).json({ message: "Mise à jour réussie", User: user });
    } catch (error) {
      console.error("❌ Erreur lors de la récupération de l'utilisateur:", error);
      res.status(500).json({ message: "Erreur serveur", error: error.message });
    }
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Nom temporaire (sans userId au début)
        cb(null, `temp-${Date.now()}${path.extname(file.originalname)}`);
    },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "image/png",
    "image/jpeg",
    "image/jpg"
  ];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error("Format de fichier non supporté"), false);
    }
};

const upload = multer({
    storage: multer.diskStorage({
        destination: uploadDir,
        filename: (req, file, cb) => {
            // Nom temporaire au cas où userId est absent
            cb(null, `temp-${Date.now()}${path.extname(file.originalname)}`);
        }
    }),
});

app.get("/Frontend/getUser/:id", async (req, res) => {
  try {
    const userId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(String(userId || ""))) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const user = await UserModel.findById(userId);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      picture: user.picture,
      profile: user.profile || {},
      linkedin: user.linkedin || {},
      enterprise: user.enterprise || {},
    });
  } catch (err) {
    console.error("❌ Error fetching user:", err);
    res.status(500).json({ message: "Server error" });
  }
});

const normalizeExperiencePayload = (value, fallback) => {
  if (value === undefined) {
    return fallback;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!item) return null;

        if (typeof item === "string") {
          const text = item.trim();
          if (!text) return null;
          return {
            title: text,
            company: "",
            duration: "",
            description: "",
          };
        }

        if (typeof item === "object") {
          return {
            title: String(item.title || "").trim(),
            company: String(item.company || "").trim(),
            duration: String(item.duration || "").trim(),
            description: String(item.description || "").trim(),
          };
        }

        return null;
      })
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({
        title: line,
        company: "",
        duration: "",
        description: "",
      }));
  }

  return fallback;
};




app.put("/Frontend/updateUser/:id", async (req, res) => {
  try {
    console.log("📥 Données reçues pour mise à jour:", req.body);

    const user = await UserModel.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Utilisateur non trouvé" });

    // 🔹 Mise à jour des champs de base
    user.name = req.body.name || user.name;
    user.email = req.body.email || user.email;

    // 🔐 Mise à jour du mot de passe si fourni
    if (req.body.password && req.body.password.length > 4) {
      const hashedPassword = await bcrypt.hash(req.body.password, 10);
      user.password = hashedPassword;
    }

    // 🧩 Mise à jour du profil utilisateur
    if (!user.profile) user.profile = {};
    const profile = req.body.profile || {};
    user.profile.phone = profile.phone ?? user.profile.phone;
    user.profile.resume = profile.resume ?? user.profile.resume;
    user.profile.shortDescription = profile.shortDescription ?? user.profile.shortDescription;
    user.profile.availability = profile.availability ?? user.profile.availability;
    user.profile.skills = profile.skills ?? user.profile.skills;
    user.profile.languages = profile.languages ?? user.profile.languages;
    user.profile.experience = normalizeExperiencePayload(profile.experience, user.profile.experience);
    user.markModified("profile");

    // 🏢 Mise à jour des données entreprise si role === 'ENTERPRISE'
    if (user.role === "ENTERPRISE" && req.body.enterprise) {
      if (!user.enterprise) user.enterprise = {};
      const ent = req.body.enterprise;

      user.enterprise.name = ent.name || user.enterprise.name;
      user.enterprise.industry = ent.industry || user.enterprise.industry;
      user.enterprise.location = ent.location || user.enterprise.location;
      user.enterprise.website = ent.website || user.enterprise.website;
      user.enterprise.description = ent.description || user.enterprise.description;
      user.enterprise.employeeCount = ent.employeeCount ?? user.enterprise.employeeCount;

      user.markModified("enterprise");
    }

    // Validate only modified fields so stale unrelated fields (e.g. legacy linkedin.url)
    // do not block profile updates.
    await user.save({ validateModifiedOnly: true });

    console.log("✅ Utilisateur mis à jour avec succès !");
    return res.status(200).json({
      message: "Mise à jour réussie",
      enterprise: user.enterprise,
      picture: user.picture, // 🔁 renvoie aussi la photo
    });

  } catch (error) {
    console.error("❌ Erreur mise à jour utilisateur:", error);
    return res.status(500).json({ error: "Erreur interne du serveur." });
  }
});


app.post('/Frontend/upload-resume', resumeUpload.single('resume'), async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    const user = await UserModel.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const newFilename = `${userId}-${Date.now()}${path.extname(req.file.originalname)}`;
    const newPath = path.join(req.file.destination, newFilename);

    const fsPromises = require('fs').promises;
    await fsPromises.rename(req.file.path, newPath);

    const form = new FormData();
    form.append('resume', fs.createReadStream(newPath));
    const pythonResponse = await axios.post('http://localhost:5002/upload', form, {
      headers: {
        ...form.getHeaders(),
      },
    });

    const resumeData = pythonResponse.data;
    if (resumeData?.error || !resumeData?.profile) {
      try {
        await fsPromises.unlink(newPath);
      } catch (cleanupError) {
        console.error('⚠️ Failed to cleanup invalid CV upload:', cleanupError.message);
      }
      return res.status(400).json({
        error: 'Invalid CV file. Please upload a real CV document.',
        details: resumeData?.error || 'CV verification failed'
      });
    }

    // ✅ Enregistrement dans le bon sous-champ
    user.profile = user.profile || {};
    user.profile.resume = `/uploads/${newFilename}`;
    user.profile.shortDescription = resumeData.profile?.shortDescription || user.profile.shortDescription || "";
    user.profile.phone = resumeData.profile?.phone || user.profile.phone;
    user.profile.skills = resumeData.profile?.skills || user.profile.skills || [];
    user.profile.languages = resumeData.profile?.languages || user.profile.languages || [];
    user.profile.experience = Array.isArray(resumeData.profile?.experience)
      ? resumeData.profile.experience
      : [];

    if (resumeData.name) user.name = user.name || resumeData.name;

    user.markModified("profile");
    await user.save();

    console.log('✅ Resume updated for user:', user);
    res.status(200).json({
      message: 'Resume uploaded and analyzed successfully!',
      resumeUrl: user.profile.resume,
      extractedData: resumeData,
    });
  } catch (error) {
    console.error('❌ Server error during resume upload:', error);
    if (error.response && error.response.status === 400) {
      return res.status(400).json({
        error: 'Invalid CV file. Please upload a real CV document.',
        details: error.response.data?.error || 'CV verification failed'
      });
    }
    res.status(500).json({ error: 'Server error.', details: error.message });
  }
});


const PROFILE_IMAGE_MAX_SIZE = 15 * 1024 * 1024;

const profileUpload = multer({
    storage: multer.diskStorage({
        destination: uploadPicsDir,
        filename: (req, file, cb) => {
            const userId = req.body.userId || 'unknown';
            cb(null, `${userId}-profile-${Date.now()}${path.extname(file.originalname)}`);
        },
    }),
    limits: {
    fileSize: PROFILE_IMAGE_MAX_SIZE
  },
  fileFilter: (req, file, cb) => {
    if (!file?.mimetype?.startsWith('image/')) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  },
});

app.post("/Frontend/upload-profile", (req, res, next) => {
  profileUpload.single("picture")(req, res, (error) => {
    if (!error) {
      return next();
    }

    if (error instanceof multer.MulterError) {
      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "Image too large. Maximum size is 15MB.",
        });
      }

      return res.status(400).json({
        error: `Upload error: ${error.code}`,
      });
    }

    return res.status(400).json({
      error: error.message || "Invalid upload request.",
    });
  });
}, async(req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No image uploaded." });
        }

        const { userId } = req.body;
        if (!userId) {
            return res.status(400).json({ error: "User ID required." });
        }

        const pictureUrl = `/uploadsPics/${req.file.filename}`;

        const user = await UserModel.findByIdAndUpdate(
          userId,
          { $set: { picture: pictureUrl } },
          { new: true, runValidators: false, select: "_id picture" }
        );

        if (!user) {
            return res.status(404).json({ error: "User not found." });
        }

        res.status(200).json({ message: "Profile picture uploaded successfully!", pictureUrl: user.picture });
    } catch (error) {
        console.error("❌ Server error:", error);
        res.status(500).json({ error: "Server error.", details: error.message });
    }
});

app.put("/Frontend/user/:id", async(req, res) => {
    try {
        const user = await UserModel.findById(req.params.id);
        if (!user) return res.status(404).json({ error: "User not found" });

        user.name = req.body.name || user.name;
        user.email = req.body.email || user.email;

        if (req.body.password && req.body.password.length > 4) {
            const hashedPassword = await bcrypt.hash(req.body.password, 10);
            user.password = hashedPassword;
        }

        if (!user.profile) user.profile = {};

        const profile = req.body.profile || {};
        user.profile.phone = profile.phone ?? user.profile.phone;
        user.profile.resume = profile.resume ?? user.profile.resume;
        user.profile.availability = profile.availability ?? user.profile.availability;
        user.profile.skills = profile.skills ?? user.profile.skills;
        user.profile.languages = profile.languages ?? user.profile.languages;
        user.profile.experience = normalizeExperiencePayload(profile.experience, user.profile.experience);

        user.markModified("profile");
        await user.save({ validateModifiedOnly: true });
        
        return res.status(200).json(user);
    } catch (error) {
        console.error("❌ Error updating user:", error);
        return res.status(500).json({ error: "Server error." });
    }
});



app.post("/Frontend/forgot-password", async(req, res) => {
    const { email } = req.body;

    try {
        const user = await UserModel.findOne({ email });
        if (!user) return res.status(404).json({ message: "User not found." });

        const resetToken = jwt.sign({ id: user._id }, process.env.JWT_SECRET_KEY, { expiresIn: '1h' });

        user.resetPasswordToken = resetToken;
        user.resetPasswordExpires = Date.now() + 3600000;
        await user.save();

        const resetLink = `http://localhost:5173/reset-password/${resetToken}`;

        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: "Password Reset Request",
            text: `Click this link to reset your password: ${resetLink}`
        });

        res.json({ message: "✅ Password reset email sent." });
    } catch (error) {
        console.error("❌ Forgot Password Error:", error);
        res.status(500).json({ message: "Server error." });
    }
});

app.post("/Frontend/reset-password/:token", async(req, res) => {
    const { token } = req.params;
    const { password } = req.body;

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
        const user = await UserModel.findById(decoded.id);

        if (!user || user.resetPasswordToken !== token) {
            return res.status(400).json({ message: "Invalid or expired reset token." });
        }

        if (user.resetPasswordExpires < Date.now()) {
            return res.status(400).json({ message: "Password reset link has expired." });
        }

        user.password = await bcrypt.hash(password, 10);
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;

        await user.save();
        res.json({ message: "✅ Password reset successfully." });
    } catch (error) {
        console.error("❌ Reset Password Error:", error);
        res.status(500).json({ message: "Server error." });
    }
});

app.post("/api/grammar-check", async(req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt) {
            return res.status(400).json({ error: "Prompt is required." });
        }

        const response = await fetch("https://api-inference.huggingface.co/models/vennify/t5-base-grammar-correction", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.HF_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ inputs: prompt }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("❌ Hugging Face API Error:", errorText);
            return res.status(response.status).json({ error: "Hugging Face API Error", details: errorText });
        }

        const data = await response.json();
        res.json({ correctedText: data[0]?.generated_text || prompt });
    } catch (error) {
        console.error("❌ Hugging Face API Error:", error);
        res.status(500).json({ error: "Server error." });
    }
});

const audioStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const audioDir = path.join(__dirname, "uploads/audio");
        if (!fs.existsSync(audioDir)) {
            fs.mkdirSync(audioDir, { recursive: true });
        }
        cb(null, audioDir);
    },
    filename: (req, file, cb) => {
        cb(null, `audio-${Date.now()}${path.extname(file.originalname)}`);
    },
});

const audioUpload = multer({ storage: audioStorage });

app.post("/Frontend/transcribe-audio", audioUpload.single("audio"), async(req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: "No audio file uploaded." });
        }

        const audioPath = path.join(__dirname, req.file.path);
        exec(`whisper "${audioPath}" --model medium`, (error, stdout, stderr) => {
            if (error) {
                console.error(`❌ Whisper Error: ${error.message}`);
                return res.status(500).json({ error: "Error during transcription." });
            }
            res.json({ transcript: stdout.trim() });
        });
    } catch (error) {
        console.error("❌ Audio Transcription Error:", error);
        res.status(500).json({ error: "Server error." });
    }
});

const refreshRecommendationIndexSafe = async () => {
  try {
    await axios.post("http://127.0.0.1:5001/refresh-index", {}, {
      timeout: 15000,
      headers: { "Content-Type": "application/json" }
    });
  } catch (error) {
    // Keep job CRUD successful even when recommendation service is unavailable.
    console.warn("Recommendation index refresh skipped:", error.message);
  }
};

app.post("/Frontend/add-job", async (req, res) => {
    try {
      const { title, description, location, salary, entrepriseId, languages, skills } = req.body;
  
      const newJob = new JobModel({
        title,
        description,
        location,
        salary,
        entrepriseId,
        languages,
        skills
      });
  
      await newJob.save();
  
      const user = await UserModel.findById(entrepriseId).select('+jobsPosted');
      if (!user) return res.status(404).json({ error: "Entreprise introuvable" });
  
      if (!Array.isArray(user.jobsPosted)) {
        user.jobsPosted = [];
      }
  
      user.jobsPosted.push({
        jobId: newJob._id,
        title: newJob.title,
        status: "OPEN",
        createdDate: newJob.createdAt
      });
  
      user.markModified('jobsPosted');
      await user.save();

      await refreshRecommendationIndexSafe();
  
      return res.status(201).json({ message: "Job ajouté avec succès", job: newJob });
  
    } catch (error) {
      console.error("❌ Erreur lors de l'ajout du job:", error);
      res.status(500).json({ error: "Erreur serveur" });
    }
});
  
app.get("/Frontend/jobs", async (req, res) => {
    try {
      const jobs = await JobModel.find({ status: { $ne: "CLOSED" } })
        .populate({
          path: 'entrepriseId',
          select: 'enterprise.name name picture'
        })
        .sort({ createdAt: -1 });
  
      res.status(200).json(jobs);
    } catch (error) {
      console.error("❌ Erreur récupération jobs:", error);
      res.status(500).json({ error: "Erreur serveur" });
    }
});
  
app.get("/Frontend/jobs/:id", async (req, res) => {
  try {
    const job = await JobModel.findById(req.params.id).populate("entrepriseId");
    if (!job) {
      return res.status(404).json({ message: "Job non trouvé" });
    }
    res.status(200).json(job);
  } catch (error) {
    console.error("❌ Erreur lors de la récupération du job par ID:", error);
    res.status(500).json({ message: "Erreur serveur" });
  }
});


app.get("/Frontend/jobs-by-entreprise/:id", async (req, res) => {
    try {
      const jobs = await JobModel.find({ entrepriseId: req.params.id }).sort({ createdAt: -1 });
      res.status(200).json(jobs);
    } catch (error) {
      console.error("❌ Erreur récupération jobs entreprise:", error);
      res.status(500).json({ error: "Erreur serveur" });
    }
});
  
app.delete("/Frontend/delete-job/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const deletedJob = await JobModel.findByIdAndDelete(id);
  
      if (!deletedJob) {
        return res.status(404).json({ message: "Job non trouvé" });
      }

      await UserModel.updateOne(
        { _id: deletedJob.entrepriseId },
        { $pull: { jobsPosted: { jobId: deletedJob._id } } }
      );

      await refreshRecommendationIndexSafe();
  
      res.status(200).json({ message: "Job supprimé avec succès" });
    } catch (error) {
      console.error("❌ Erreur lors de la suppression du job :", error);
      res.status(500).json({ message: "Erreur serveur" });
    }
});

app.put("/Frontend/update-job/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { entrepriseId, title, description, location, salary, languages, skills } = req.body;

    if (!entrepriseId) {
      return res.status(400).json({ message: "entrepriseId is required" });
    }

    const job = await JobModel.findById(id);
    if (!job) {
      return res.status(404).json({ message: "Job non trouvé" });
    }

    if (String(job.entrepriseId) !== String(entrepriseId)) {
      return res.status(403).json({ message: "Forbidden: this job does not belong to your enterprise" });
    }

    const normalizeList = (value) => {
      if (!Array.isArray(value)) return [];
      return value.map((item) => String(item || "").trim()).filter(Boolean);
    };

    job.title = String(title || "").trim() || job.title;
    job.description = String(description || "").trim();
    job.location = String(location || "").trim();
    job.salary = Number(salary) || 0;
    job.languages = normalizeList(languages);
    job.skills = normalizeList(skills);

    await job.save();

    await UserModel.updateOne(
      { _id: entrepriseId, "jobsPosted.jobId": job._id },
      {
        $set: {
          "jobsPosted.$.title": job.title,
        }
      }
    );

    await refreshRecommendationIndexSafe();

    return res.status(200).json({ message: "Job mis à jour avec succès", job });
  } catch (error) {
    console.error("❌ Erreur lors de la mise à jour du job :", error);
    res.status(500).json({ message: "Erreur serveur" });
  }
});

app.put("/Frontend/archive-job/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { entrepriseId } = req.body;

    if (!entrepriseId) {
      return res.status(400).json({ message: "entrepriseId is required" });
    }

    const job = await JobModel.findById(id);
    if (!job) {
      return res.status(404).json({ message: "Job non trouvé" });
    }

    if (String(job.entrepriseId) !== String(entrepriseId)) {
      return res.status(403).json({ message: "Forbidden: this job does not belong to your enterprise" });
    }

    job.status = "CLOSED";
    await job.save();

    await UserModel.updateOne(
      { _id: entrepriseId, "jobsPosted.jobId": job._id },
      {
        $set: {
          "jobsPosted.$.status": "CLOSED",
        }
      }
    );

    await refreshRecommendationIndexSafe();

    return res.status(200).json({ message: "Job archivé avec succès", job });
  } catch (error) {
    console.error("❌ Erreur lors de l'archivage du job :", error);
    res.status(500).json({ message: "Erreur serveur" });
  }
});

app.put("/Frontend/unarchive-job/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { entrepriseId } = req.body;

    if (!entrepriseId) {
      return res.status(400).json({ message: "entrepriseId is required" });
    }

    const job = await JobModel.findById(id);
    if (!job) {
      return res.status(404).json({ message: "Job non trouvé" });
    }

    if (String(job.entrepriseId) !== String(entrepriseId)) {
      return res.status(403).json({ message: "Forbidden: this job does not belong to your enterprise" });
    }

    job.status = "OPEN";
    await job.save();

    await UserModel.updateOne(
      { _id: entrepriseId, "jobsPosted.jobId": job._id },
      {
        $set: {
          "jobsPosted.$.status": "OPEN",
        }
      }
    );

    await refreshRecommendationIndexSafe();

    return res.status(200).json({ message: "Job désarchivé avec succès", job });
  } catch (error) {
    console.error("❌ Erreur lors du désarchivage du job :", error);
    res.status(500).json({ message: "Erreur serveur" });
  }
});



app.get("/Frontend/me", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "No token provided." });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);

    const user = await UserModel.findById(decoded.id).select("-password");
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    res.status(200).json(user);
  } catch (error) {
    if (error?.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired.", code: "TOKEN_EXPIRED" });
    }
    console.error("❌ Error in /Frontend/me:", error?.message || error);
    res.status(401).json({ message: "Invalid token.", code: "TOKEN_INVALID" });
  }
});

app.post("/Frontend/apply-job", uploadCV.single("cv"), async (req, res) => {
  try {
    const { jobId, enterpriseId, candidateId, fullName, email, phone } = req.body;

    if (!jobId || !candidateId) {
      return res.status(400).json({ message: "jobId and candidateId are required." });
    }

    const existingApplication = await ApplicationModel.findOne({ jobId, candidateId }).lean();
    if (existingApplication) {
      return res.status(409).json({ message: "Vous avez déjà postulé à cette offre." });
    }

    if (!req.file) {
      return res.status(400).json({ message: "Fichier CV manquant." });
    }

    const newApplication = new ApplicationModel({
      jobId,
      enterpriseId,
      candidateId,
      fullName,
      email,
      phone,
      cv: `/uploads/cvs/${req.file.filename}` // 📎 ajoute bien le champ dans le modèle
    });

    await newApplication.save();

    let quizAutoGenerated = false;
    let quizGenerationError = null;
    try {
      const generationResult = await generateCandidateQuizForJobCandidate({
        jobId,
        candidateId,
        totalQuestions: 20,
        forceMistral: true,
        generatedBy: enterpriseId,
      });
      quizAutoGenerated = Boolean(generationResult?.savedQuiz);
    } catch (generationError) {
      quizGenerationError = generationError?.response?.data || generationError?.message || "Quiz generation failed";
      console.error("❌ Auto quiz generation after apply failed:", quizGenerationError);
    }

    res.status(201).json({
      message: "Candidature envoyée avec succès.",
      quizAutoGenerated,
      quizGenerationError,
    });
  } catch (error) {
    console.error("❌ Backend error:", error);
    res.status(500).json({ message: "Erreur interne du serveur." });
  }
});



app.get("/Frontend/notifications/:enterpriseId", async (req, res) => {
  try {
    const { enterpriseId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(enterpriseId || ""))) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const user = await UserModel.findById(enterpriseId).select("notifications");

    if (!user) return res.status(404).json({ message: "User not found" });

    const notifications = Array.isArray(user.notifications)
      ? [...user.notifications].sort((left, right) => new Date(right?.date || 0) - new Date(left?.date || 0))
      : [];

    res.status(200).json({ notifications });
  } catch (err) {
    console.error("❌ Erreur récupération notifications:", err);
    res.status(500).json({ message: "Erreur serveur" });
  }
});

app.patch("/Frontend/notifications/:enterpriseId/mark-all-seen", async (req, res) => {
  try {
    const { enterpriseId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(enterpriseId || ""))) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const user = await UserModel.findById(enterpriseId).select("notifications");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const updatedNotifications = (user.notifications || []).map((notification) => ({
      ...notification.toObject(),
      seen: true,
    }));

    user.notifications = updatedNotifications;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "All notifications kept",
      notifications: user.notifications || [],
    });
  } catch (err) {
    console.error("❌ Erreur mise à jour notifications:", err);
    return res.status(500).json({ message: "Erreur serveur" });
  }
});

app.patch("/Frontend/notifications/:enterpriseId/:notificationId/seen", async (req, res) => {
  try {
    const { enterpriseId, notificationId } = req.params;
    const seen = req.body?.seen !== false;

    if (!mongoose.Types.ObjectId.isValid(String(enterpriseId || ""))) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    if (!mongoose.Types.ObjectId.isValid(String(notificationId || ""))) {
      return res.status(400).json({ message: "Invalid notification id" });
    }

    const updatedUser = await UserModel.findOneAndUpdate(
      { _id: enterpriseId, "notifications._id": notificationId },
      { $set: { "notifications.$.seen": seen } },
      { new: true }
    ).select("notifications");

    if (!updatedUser) {
      return res.status(404).json({ message: "Notification not found" });
    }

    return res.status(200).json({
      success: true,
      message: seen ? "Notification kept" : "Notification marked unread",
      notifications: updatedUser.notifications || [],
    });
  } catch (err) {
    console.error("❌ Erreur keep notification:", err);
    return res.status(500).json({ message: "Erreur serveur" });
  }
});

app.delete("/Frontend/notifications/:enterpriseId/:notificationId", async (req, res) => {
  try {
    const { enterpriseId, notificationId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(String(enterpriseId || ""))) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    if (!mongoose.Types.ObjectId.isValid(String(notificationId || ""))) {
      return res.status(400).json({ message: "Invalid notification id" });
    }

    const userExists = await UserModel.exists({ _id: enterpriseId });
    if (!userExists) {
      return res.status(404).json({ message: "User not found" });
    }

    const updatedUser = await UserModel.findOneAndUpdate(
      { _id: enterpriseId, "notifications._id": notificationId },
      { $pull: { notifications: { _id: notificationId } } },
      { new: true }
    ).select("notifications");

    if (!updatedUser) {
      return res.status(404).json({ message: "Notification not found" });
    }

    return res.status(200).json({
      success: true,
      message: "Notification cleared",
      notifications: updatedUser.notifications || [],
    });
  } catch (err) {
    console.error("❌ Erreur suppression notification:", err);
    return res.status(500).json({ message: "Erreur serveur" });
  }
});

app.delete("/Frontend/notifications/:enterpriseId", async (req, res) => {
  try {
    const { enterpriseId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(enterpriseId || ""))) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const user = await UserModel.findById(enterpriseId).select("notifications");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const clearedCount = Array.isArray(user.notifications) ? user.notifications.length : 0;
    user.notifications = [];
    await user.save();

    return res.status(200).json({
      success: true,
      message: "All notifications cleared",
      clearedCount,
      notifications: [],
    });
  } catch (err) {
    console.error("❌ Erreur clear notifications:", err);
    return res.status(500).json({ message: "Erreur serveur" });
  }
});


// 📥 Récupérer toutes les candidatures reçues pour une entreprise donnée
app.get("/Frontend/applications/:enterpriseId", async (req, res) => {
  try {
    const { enterpriseId } = req.params;

    const applications = await ApplicationModel.find({ enterpriseId })
      .populate("jobId", "title")
      .populate("candidateId", "name email profile.phone");

    res.status(200).json(applications);
  } catch (error) {
    console.error("❌ Error fetching applications:", error);
    res.status(500).json({ message: "Erreur serveur lors de la récupération des candidatures." });
  }
});

app.put("/Frontend/applications/:applicationId/recruiter-decision", async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { enterpriseId, decision, note = "" } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(applicationId)) {
      return res.status(400).json({ message: "Invalid applicationId" });
    }

    if (!mongoose.Types.ObjectId.isValid(String(enterpriseId || ""))) {
      return res.status(400).json({ message: "enterpriseId is required and must be valid" });
    }

    const normalizedDecision = String(decision || "").toUpperCase();
    const allowedDecisions = new Set(["INTERVIEW", "REJECTED"]);
    if (!allowedDecisions.has(normalizedDecision)) {
      return res.status(400).json({ message: "decision must be INTERVIEW or REJECTED" });
    }

    const application = await ApplicationModel.findById(applicationId);
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    const previousDecision = String(application.recruiterDecision || "").toUpperCase();

    if (String(application.enterpriseId) !== String(enterpriseId)) {
      return res.status(403).json({ message: "Forbidden: application does not belong to this enterprise" });
    }

    if (!application.quizCompleted) {
      return res.status(400).json({
        message: "Candidate has not completed quiz yet. Recruiter decision is allowed only after quiz completion.",
      });
    }

    application.recruiterDecision = normalizedDecision;
    application.recruiterDecisionAt = new Date();
    application.recruiterDecisionBy = enterpriseId;
    application.recruiterDecisionNote = String(note || "").trim();

    await application.save();

    if (previousDecision !== normalizedDecision && mongoose.Types.ObjectId.isValid(String(application.candidateId || ""))) {
      try {
        const [relatedJob, candidateUser] = await Promise.all([
          JobModel.findById(application.jobId).select("title").lean(),
          UserModel.findById(application.candidateId).select("name email").lean(),
        ]);
        const safeJobTitle = relatedJob?.title || "the position";
        const candidateName = candidateUser?.name || "Candidate";
        const candidateEmail = candidateUser?.email || "";

        const candidateMessage = normalizedDecision === "INTERVIEW"
          ? `Good news! Your application for ${safeJobTitle} has been accepted. You are now in the interview stage.`
          : `Update: Your application for ${safeJobTitle} was not selected this time.`;

        await UserModel.updateOne(
          { _id: application.candidateId },
          {
            $push: {
              notifications: {
                type: normalizedDecision === "INTERVIEW" ? "INTERVIEW" : "SYSTEM",
                message: candidateMessage,
                jobId: application.jobId,
                seen: false,
                date: new Date(),
              },
            },
          }
        );

        if (normalizedDecision === "REJECTED") {
          try {
            await sendCandidateDecisionEmail({
              candidateEmail,
              candidateName,
              jobTitle: safeJobTitle,
              decision: normalizedDecision,
              recruiterNote: application.recruiterDecisionNote,
            });
          } catch (candidateEmailError) {
            console.error("❌ Failed to send candidate rejection email:", candidateEmailError);
          }
        }
      } catch (notificationError) {
        console.error("❌ Failed to create candidate notification after recruiter decision:", notificationError);
      }
    }

    let automation = {
      schedulingTriggered: false,
      interviewScheduleId: application?.interviewSchedule?.scheduleId || null,
      scheduleStatus: application?.interviewSchedule?.status || "not_scheduled",
      scheduleError: null,
    };

    if (normalizedDecision === "INTERVIEW") {
      const currentScheduleStatus = application?.interviewSchedule?.status || "not_scheduled";
      const hasReusableSchedule = Boolean(
        application?.interviewSchedule?.scheduleId &&
          ["suggested_slots_ready", "confirmed", "rescheduled"].includes(currentScheduleStatus)
      );

      if (!hasReusableSchedule) {
        application.interviewSchedule.status = "scheduling";
        application.interviewSchedule.lastTriggeredAt = new Date();
        application.interviewSchedule.lastError = "";
        await application.save();

        try {
          const schedulingPayload = {
            candidate_id: String(application.candidateId),
            recruiter_id: String(application.enterpriseId),
            job_id: String(application.jobId),
            application_id: String(application._id),
            interview_type: "video",
            interview_mode: "synchronous",
            duration_minutes: 60,
          };

          const schedulingResponse = await axios.post(
            `${SCHEDULING_SERVICE_URL}/api/scheduling/start`,
            schedulingPayload,
            {
              timeout: SCHEDULING_SERVICE_TIMEOUT,
            }
          );

          const schedulingData = schedulingResponse?.data || {};
          const suggestedSlots = Array.isArray(schedulingData.suggested_slots)
            ? schedulingData.suggested_slots
            : [];

          let autoConfirmStatus = null;
          let autoConfirmError = null;
          let confirmData = null;

          if (schedulingData.interview_schedule_id && suggestedSlots.length > 0) {
            const firstSlot = suggestedSlots[0];

            try {
              const confirmResponse = await axios.post(
                `${SCHEDULING_SERVICE_URL}/api/scheduling/confirm`,
                {
                  interview_schedule_id: schedulingData.interview_schedule_id,
                  selected_slot: {
                    start_time: firstSlot.start_time,
                    end_time: firstSlot.end_time,
                  },
                  location: "Google Meet",
                  notes: "Auto-confirmed after recruiter acceptance",
                },
                {
                  timeout: SCHEDULING_SERVICE_TIMEOUT,
                }
              );

              confirmData = confirmResponse?.data || null;
              autoConfirmStatus = confirmData?.status || null;
            } catch (confirmError) {
              autoConfirmError =
                confirmError?.response?.data?.detail ||
                confirmError?.response?.data?.message ||
                confirmError?.message ||
                "Scheduling confirm call failed";
            }
          }

          const resolvedStatus =
            autoConfirmStatus === "confirmed" || autoConfirmStatus === "rescheduled"
              ? autoConfirmStatus
              : (schedulingData.status || "scheduling");

          application.interviewSchedule.scheduleId = schedulingData.interview_schedule_id || application?.interviewSchedule?.scheduleId || null;
          application.interviewSchedule.status = resolvedStatus;
          application.interviewSchedule.suggestedSlots = suggestedSlots;
          
          if (resolvedStatus === "confirmed" || resolvedStatus === "rescheduled") {
            if (!application.interviewSchedule.confirmedSlot) application.interviewSchedule.confirmedSlot = {};
            application.interviewSchedule.confirmedSlot.start_time = suggestedSlots[0]?.start_time || null;
            application.interviewSchedule.confirmedSlot.end_time = suggestedSlots[0]?.end_time || null;
          }

          application.interviewSchedule.calendarEventId = confirmData?.calendar_event_id || null;
          application.interviewSchedule.meetingLink = confirmData?.meeting_link || null;
          application.interviewSchedule.emailStatus = (resolvedStatus === "confirmed" || resolvedStatus === "rescheduled") ? "sent" : "pending";
          application.interviewSchedule.lastTriggeredAt = new Date();
          application.interviewSchedule.lastError = autoConfirmError ? String(autoConfirmError) : "";

          await application.save();

          automation = {
            schedulingTriggered: Boolean(schedulingData.interview_schedule_id),
            interviewScheduleId: schedulingData.interview_schedule_id || null,
            scheduleStatus: resolvedStatus,
            scheduleError: autoConfirmError ? String(autoConfirmError) : null,
            autoConfirmed:
              resolvedStatus === "confirmed" || resolvedStatus === "rescheduled",
          };
        } catch (schedulingError) {
          const schedulingErrorMessage =
            schedulingError?.response?.data?.detail ||
            schedulingError?.response?.data?.message ||
            schedulingError?.message ||
            "Scheduling service call failed";

          application.interviewSchedule.status = "failed";
          application.interviewSchedule.lastTriggeredAt = new Date();
          application.interviewSchedule.lastError = String(schedulingErrorMessage);
          await application.save();

          automation = {
            schedulingTriggered: false,
            interviewScheduleId: application?.interviewSchedule?.scheduleId || null,
            scheduleStatus: "failed",
            scheduleError: String(schedulingErrorMessage),
          };
        }
      }
    }

    return res.status(200).json({
      message: normalizedDecision === "INTERVIEW"
        ? "Candidate moved to interview stage successfully"
        : "Candidate decision saved successfully",
      application,
      automation,
    });
  } catch (error) {
    console.error("❌ Error saving recruiter decision:", error);
    return res.status(500).json({ message: "Server error while saving recruiter decision" });
  }
});

app.get("/Frontend/job-applications-count/:entrepriseId", async (req, res) => {
  try {
    const { entrepriseId } = req.params;

    const jobs = await JobModel.find({ entrepriseId }).select("_id");
    const jobIds = jobs.map((j) => j._id);

    const counts = await ApplicationModel.aggregate([
      { $match: { jobId: { $in: jobIds } } },
      { $group: { _id: "$jobId", count: { $sum: 1 } } }
    ]);

    const countMap = {};
    counts.forEach(c => {
      countMap[c._id] = c.count;
    });

    res.json(countMap);
  } catch (err) {
    console.error("❌ Error in job-applications-count:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});


// ✅ Récupérer toutes les candidatures pour un job donné
// In your backend route handler
app.get("/Frontend/job-applications/:jobId", async (req, res) => {
    try {
      const { jobId } = req.params;
      const applications = await ApplicationModel.find({ jobId }).populate("candidateId");
      const candidateIds = applications
        .map((application) => application?.candidateId?._id)
        .filter(Boolean);

      const quizResults = await QuizResultModel.find({
        jobId,
        candidateId: { $in: candidateIds },
      })
        .select("candidateId score totalQuestions timeSpentSeconds answers submittedAt")
        .sort({ submittedAt: -1 })
        .lean();

      const historyByCandidateId = new Map();
      quizResults.forEach((result) => {
        const key = String(result.candidateId);
        if (!historyByCandidateId.has(key)) {
          historyByCandidateId.set(key, []);
        }
        historyByCandidateId.get(key).push({
          score: Number(result?.score || 0),
          totalQuestions: Number(result?.totalQuestions || 0),
          timeSpentSeconds: Number(result?.timeSpentSeconds || 0),
          submittedAt: result?.submittedAt || null,
          answers: Array.isArray(result?.answers) ? result.answers : [],
        });
      });

      const candidateQuizzes = await CandidateQuizModel.find({
        jobId,
        candidateId: { $in: candidateIds },
      })
        .select("candidateId questions source generationMeta updatedAt")
        .lean();

      const quizByCandidateId = new Map(
        candidateQuizzes.map((quiz) => [String(quiz.candidateId), quiz])
      );

      const enrichedApplications = applications.map((application) => {
        const candidateId = application?.candidateId?._id ? String(application.candidateId._id) : null;
        const candidateQuiz = candidateId ? quizByCandidateId.get(candidateId) : null;
        const quizHistory = candidateId ? (historyByCandidateId.get(candidateId) || []) : [];
        const questionCount = candidateQuiz?.questions?.length || 0;
        const quizSkillsUsed = Array.isArray(candidateQuiz?.generationMeta?.skillsUsed)
          ? candidateQuiz.generationMeta.skillsUsed
          : [];
        const fallbackRationale = candidateQuiz?.questions?.length
          ? `Ce quiz a été généré à partir du profil du candidat et des exigences du poste, avec un focus sur les domaines: ${[
              ...new Set(candidateQuiz.questions.map((question) => question?.domain).filter(Boolean)),
            ].slice(0, 4).join(", ") || "techniques principales"}.`
          : "";

        const serialized = application.toObject ? application.toObject() : application;
        const legacyAttempt = serialized?.quizScore !== undefined && serialized?.quizScore !== null
          ? {
              score: Number(serialized.quizScore || 0),
              totalQuestions: questionCount,
              timeSpentSeconds: Number(serialized?.quizTimeSpentSeconds || 0),
              submittedAt: serialized?.quizSubmittedAt || serialized?.appliedAt || null,
              answers: Array.isArray(serialized?.quizAnswers) ? serialized.quizAnswers : [],
            }
          : null;
        const normalizedHistory = quizHistory.length
          ? quizHistory
          : (legacyAttempt ? [legacyAttempt] : []);
        const latestAttempt = normalizedHistory[0] || null;

        return {
          ...serialized,
          quizLength: questionCount,
          passingScore: questionCount ? Math.ceil(questionCount / 2) : 0,
          quizSource: candidateQuiz?.source || null,
          quizGeneratedAt: candidateQuiz?.updatedAt || null,
          quizRationale: candidateQuiz?.generationMeta?.rationale || fallbackRationale,
          quizSkillsUsed,
          quizQuestions: Array.isArray(candidateQuiz?.questions)
            ? candidateQuiz.questions.map((question, index) => ({
                questionIndex: index,
                question: question?.title || question?.question || "Question",
                type: question?.type || "QCM",
                expectedAnswer: question?.expectedAnswer || "",
                explanation: question?.explanation || "",
              }))
            : [],
          quizAnswers: Array.isArray(latestAttempt?.answers)
            ? latestAttempt.answers.map((answer) => {
                const questionRef = (candidateQuiz?.questions || [])[Number(answer?.questionIndex)] || null;
                return {
                  ...answer,
                  question: questionRef?.title || questionRef?.question || "Question",
                  questionType: questionRef?.type || answer?.questionType || "QCM",
                  expectedAnswer: questionRef?.expectedAnswer || answer?.expectedAnswer || "",
                };
              })
            : [],
          quizTimeSpentSeconds: Number(latestAttempt?.timeSpentSeconds || 0),
          quizSubmittedAt: latestAttempt?.submittedAt || null,
          quizHistory: normalizedHistory.map((attempt) => ({
            ...attempt,
            answers: Array.isArray(attempt?.answers)
              ? attempt.answers.map((answer) => {
                  const questionRef = (candidateQuiz?.questions || [])[Number(answer?.questionIndex)] || null;
                  return {
                    ...answer,
                    question: questionRef?.title || questionRef?.question || "Question",
                    questionType: questionRef?.type || answer?.questionType || "QCM",
                    expectedAnswer: questionRef?.expectedAnswer || answer?.expectedAnswer || "",
                  };
                })
              : [],
          })),
        };
      });
      
      // Always return an array, even if empty
      res.status(200).json({
        success: true,
        applications: enrichedApplications || [] // Ensure it's always an array
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error fetching applications",
        applications: [] // Return empty array on error
      });
    }
  });

app.get("/Frontend/job-candidate-quizzes/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const applications = await ApplicationModel.find({ jobId })
      .populate("candidateId", "name email profile.skills profile.shortDescription")
      .lean();

    const candidateIds = applications
      .map((application) => application?.candidateId?._id)
      .filter(Boolean);

    const quizzes = await CandidateQuizModel.find({
      jobId,
      candidateId: { $in: candidateIds },
    })
      .select("candidateId questions updatedAt source")
      .lean();

    const quizByCandidateId = new Map(
      quizzes.map((quiz) => [String(quiz.candidateId), quiz])
    );

    const candidates = applications
      .filter((application) => application?.candidateId)
      .map((application) => {
        const candidate = application.candidateId;
        const existingQuiz = quizByCandidateId.get(String(candidate._id));
        return {
          candidateId: candidate._id,
          name: candidate.name,
          email: candidate.email,
          skills: Array.isArray(candidate?.profile?.skills) ? candidate.profile.skills : [],
          shortDescription: candidate?.profile?.shortDescription || "",
          hasQuiz: Boolean(existingQuiz),
          quizQuestionCount: existingQuiz?.questions?.length || 0,
          quizUpdatedAt: existingQuiz?.updatedAt || null,
          quizSource: existingQuiz?.source || null,
        };
      });

    return res.status(200).json({ candidates });
  } catch (error) {
    console.error("❌ Error fetching candidate quizzes:", error);
    return res.status(500).json({ message: "Error fetching candidate quiz list" });
  }
});

app.get("/Frontend/candidate-quiz/:jobId/:candidateId", async (req, res) => {
  try {
    const { jobId, candidateId } = req.params;
    const quiz = await CandidateQuizModel.findOne({ jobId, candidateId }).lean();

    if (!quiz) {
      return res.status(404).json({ message: "No candidate quiz found for this job." });
    }

    return res.status(200).json(quiz);
  } catch (error) {
    console.error("❌ Error fetching candidate quiz:", error);
    return res.status(500).json({ message: "Error fetching candidate quiz" });
  }
});

app.post("/Frontend/save-candidate-quiz", async (req, res) => {
  try {
    const { jobId, candidateId, questions, source = "manual" } = req.body;

    if (!jobId || !candidateId || !Array.isArray(questions)) {
      return res.status(400).json({ message: "jobId, candidateId and questions are required" });
    }

    const savedQuiz = await CandidateQuizModel.findOneAndUpdate(
      { jobId, candidateId },
      {
        jobId,
        candidateId,
        questions,
        source,
      },
      { new: true, upsert: true }
    );

    return res.status(200).json({ message: "Candidate quiz saved", quiz: savedQuiz });
  } catch (error) {
    console.error("❌ Error saving candidate quiz:", error);
    return res.status(500).json({ message: "Error saving candidate quiz" });
  }
});

app.post("/Frontend/generate-quiz-from-profile", async (req, res) => {
  try {
    const { jobId, candidateId = null, totalQuestions = 20, forceMistral = false, generatedBy = null } = req.body;

    if (!jobId) {
      return res.status(400).json({ message: "jobId is required" });
    }

    const job = await JobModel.findById(jobId).select("title description skills location");
    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }

    if (candidateId) {
      const { aiData } = await generateCandidateQuizForJobCandidate({
        jobId,
        candidateId,
        totalQuestions,
        forceMistral,
        generatedBy,
      });
      return res.status(200).json(aiData);
    }

    const aiPayload = {
      job: {
        title: job.title || "",
        description: job.description || "",
        skills: Array.isArray(job.skills) ? job.skills : [],
        location: job.location || "",
      },
      totalQuestions,
      forceMistral: true,
    };

    const aiResponse = await axios.post("http://localhost:5003/generate-quiz", aiPayload, {
      timeout: 60000,
    });

    const aiData = aiResponse.data || {};

    return res.status(200).json(aiData);
  } catch (error) {
    console.error("❌ Error generating quiz from profile:", error.response?.data || error.message);
    return res.status(503).json({
      message: "Quiz AI service unavailable. Start Backend/server/AI/quiz_generation_service.py first.",
      details: error.response?.data || error.message,
    });
  }
});

app.post("/Frontend/adaptive-quiz-page", async (req, res) => {
  try {
    const {
      jobId,
      candidateId,
      page = 1,
      pageSize = 5,
      responseHistory = [],
      askedQuestionKeys = [],
      forceMistral = false,
    } = req.body;

    if (!jobId || !candidateId) {
      return res.status(400).json({ message: "jobId and candidateId are required" });
    }

    // Check if job exists
    const job = await JobModel.findById(jobId).lean();
    if (!job) {
      console.error(`❌ Job not found: ${jobId}`);
      return res.status(404).json({ message: `Job not found: ${jobId}` });
    }

    // Check if candidate exists
    const candidate = await UserModel.findById(candidateId).lean();
    if (!candidate) {
      console.error(`❌ Candidate not found: ${candidateId}`);
      return res.status(404).json({ message: `Candidate not found: ${candidateId}` });
    }

    const existingApplication = await ApplicationModel.findOne({ jobId, candidateId })
      .select("quizCompleted quizSubmittedAt")
      .lean();

    if (existingApplication?.quizCompleted) {
      return res.status(403).json({
        success: false,
        message: "Quiz already completed. You can no longer access this quiz.",
        reason: "quiz-already-completed",
        quizSubmittedAt: existingApplication?.quizSubmittedAt || null,
      });
    }

    let personalizedQuiz = await CandidateQuizModel.findOne({ jobId, candidateId }).lean();
    const existingQuestions = Array.isArray(personalizedQuiz?.questions) ? personalizedQuiz.questions : [];
    const containsLegacyLowQualityTemplate = existingQuestions.some((question) => {
      const title = String(question?.title || question?.question || "").toLowerCase();
      const options = Array.isArray(question?.options) ? question.options : [];
      return options.some((option) =>
        String(option || "").toLowerCase().includes("réservé uniquement aux managers")
      ) || title.includes("(unique") || title.includes("(variante");
    });

    const needsRegeneration =
      !personalizedQuiz ||
      !existingQuestions.length ||
      existingQuestions.length < 20 ||
      containsLegacyLowQualityTemplate;

    if (needsRegeneration) {
      console.log(`📝 Generating new quiz for jobId=${jobId}, candidateId=${candidateId}`);
      const generated = await generateCandidateQuizForJobCandidate({
        jobId,
        candidateId,
        totalQuestions: 20,
        forceMistral,
      });

      personalizedQuiz = {
        questions: Array.isArray(generated?.aiData?.questions) ? generated.aiData.questions : [],
        generationMeta: generated?.savedQuiz?.generationMeta || {},
      };
    }

    const questions = Array.isArray(personalizedQuiz?.questions) ? personalizedQuiz.questions.slice(0, 20) : [];
    if (!questions.length) {
      return res.status(404).json({ message: "No generated quiz available for this candidate" });
    }

    try {
      const aiAdaptiveResponse = await axios.post(
        "http://localhost:5003/adaptive-next-page",
        {
          questions,
          page: Math.max(1, Number(page) || 1),
          pageSize: Math.max(1, Math.min(10, Number(pageSize) || 5)),
          responseHistory: Array.isArray(responseHistory) ? responseHistory : [],
          askedQuestionKeys: Array.isArray(askedQuestionKeys) ? askedQuestionKeys : [],
        },
        { timeout: 30000 }
      );

      return res.status(200).json(aiAdaptiveResponse.data || {});
    } catch (adaptiveError) {
      console.warn("⚠️ Adaptive AI unavailable, using local page fallback:", adaptiveError?.message);
      const fallbackPage = selectAdaptivePageFallback({
        questions,
        page,
        pageSize,
        askedQuestionKeys,
      });
      return res.status(200).json(fallbackPage);
    }
  } catch (error) {
    console.error("❌ Error in adaptive quiz page:", {
      message: error.message,
      jobId: req.body?.jobId,
      candidateId: req.body?.candidateId,
      axiosError: error.response?.status,
      axiosMessage: error.response?.data?.message || error.response?.data?.error,
    });
    return res.status(503).json({
      message: "Quiz generation failed. Ensure job and candidate exist, and quiz service is running.",
      details: error.message,
      axiosDetails: error.response?.data,
    });
  }
});

app.post("/Frontend/create-quiz", async (req, res) => {
  try {
    const { jobId, questions } = req.body;
    const quiz = await QuizModel.findOneAndUpdate(
      { jobId },
      { jobId, questions },
      { upsert: true, new: true }
    );
    res.status(200).json({ message: "Quiz enregistré !", quiz });
  } catch (error) {
    console.error("Erreur création quiz:", error);
    res.status(500).json({ message: "Erreur serveur." });
  }
});


app.get("/Frontend/quiz/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const { candidateId } = req.query;

    if (candidateId) {
      const personalizedQuiz = await CandidateQuizModel.findOne({ jobId, candidateId });
      if (personalizedQuiz) {
        return res.json(personalizedQuiz);
      }
    }

    const quiz = await QuizModel.findOne({ jobId });

    if (!quiz) {
      return res.status(404).json({ message: "Aucun quiz trouvé pour ce job." });
    }

    res.json(quiz);
  } catch (err) {
    console.error("❌ Erreur récupération quiz:", err);
    res.status(500).json({ message: "Erreur serveur" });
  }
});


app.post("/Frontend/submit-quiz", quizRateLimiter, validateQuizSubmission, async (req, res) => {
    try {
  const {
    jobId,
    candidateId,
    answers,
    answersByQuestionKey,
    timeSpentSeconds = 0,
    requireComplete = true,
    completionType = "normal",
  } = req.body;

      const existingApplication = await ApplicationModel.findOne({ jobId, candidateId })
        .select("quizCompleted quizSubmittedAt")
        .lean();

      if (existingApplication?.quizCompleted) {
        return res.status(409).json({
          success: false,
          message: "Quiz already submitted. Retake is not allowed.",
          reason: "quiz-already-completed",
          quizSubmittedAt: existingApplication?.quizSubmittedAt || null,
        });
      }

      const jobContext = await JobModel.findById(jobId)
        .select("title skills description")
        .lean();
  
      // Get candidate-specific quiz first, fallback to generic job quiz
      const personalizedQuiz = await CandidateQuizModel.findOne({ jobId, candidateId });
      const quiz = personalizedQuiz || await QuizModel.findOne({ jobId });
      if (!quiz) {
        return res.status(404).json({ message: "Quiz not found for this job" });
      }
  
      // Calculate score
      let score = 0;
      let pendingReviewCount = 0;
      const answersDetailed = [];
      const keyedAnswers = (answersByQuestionKey && typeof answersByQuestionKey === "object") ? answersByQuestionKey : {};

      const parseOptionAnswerIndex = (value) => {
        if (value === null || value === undefined) {
          return null;
        }
        if (typeof value === "string" && !value.trim()) {
          return null;
        }

        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
          return null;
        }

        return Number.isInteger(numericValue) ? numericValue : null;
      };

      const answeredQuestionsCount = quiz.questions.reduce((count, question, index) => {
        const submittedAnswer =
          keyedAnswers?.[index]
          ?? keyedAnswers?.[String(index)]
          ?? answers?.[index]
          ?? answers?.[String(index)]
          ?? null;

        const hasOptions = Array.isArray(question?.options)
          && question.options.some((option) => String(option || "").trim().length > 0);

        const parsedAnswerIndex = parseOptionAnswerIndex(submittedAnswer);

        const hasAnswer = hasOptions
          ? parsedAnswerIndex !== null
          : (typeof submittedAnswer === "string" && submittedAnswer.trim().length > 0);

        return hasAnswer ? count + 1 : count;
      }, 0);

      if (requireComplete && answeredQuestionsCount < quiz.questions.length) {
        return res.status(400).json({
          message: "Please answer all questions before submitting.",
          totalQuestions: quiz.questions.length,
          answeredQuestions: answeredQuestionsCount,
          missingQuestions: Math.max(0, quiz.questions.length - answeredQuestionsCount),
        });
      }

      quiz.questions.forEach((question, index) => {
        const submittedAnswer =
          keyedAnswers?.[index]
          ?? keyedAnswers?.[String(index)]
          ?? answers?.[index]
          ?? answers?.[String(index)]
          ?? null;
        const hasOptions = Array.isArray(question?.options)
          && question.options.some((option) => String(option || "").trim().length > 0);
        const parsedAnswerIndex = parseOptionAnswerIndex(submittedAnswer);
        const submittedAnswerText = typeof submittedAnswer === "string" ? submittedAnswer.trim() : "";
        const expectedAnswerText = String(question?.expectedAnswer || "").trim();
        const questionType = String(question?.type || "QCM");
        const isOpenQuestion = OPEN_QUESTION_TYPES.has(questionType.toLowerCase());

        let isCorrect = false;
        let needsHumanReview = false;
        let aiSuggestedCorrect = null;
        let aiConfidence = null;
        let evaluationMode = "auto-options";
        if (hasOptions) {
          isCorrect = parsedAnswerIndex === question.correctAnswer;
          aiSuggestedCorrect = isCorrect;
          aiConfidence = 100;
        } else if (submittedAnswerText) {
          if (isOpenQuestion) {
            const openEval = evaluateOpenAnswerSemiAuto({
              submittedAnswerText,
              expectedAnswerText,
              questionText: question?.title || question?.question || "",
              skillHints: Array.isArray(question?.skills) ? question.skills : [],
            });
            isCorrect = openEval.isCorrect;
            needsHumanReview = openEval.needsHumanReview;
            aiSuggestedCorrect = openEval.aiSuggestedCorrect;
            aiConfidence = openEval.aiConfidence;
            evaluationMode = openEval.evaluationMode;
          } else if (!expectedAnswerText) {
            isCorrect = true;
            aiSuggestedCorrect = true;
            aiConfidence = 70;
            evaluationMode = "auto-accepted-no-expected";
          } else {
            isCorrect = submittedAnswerText.toLowerCase() === expectedAnswerText.toLowerCase();
            aiSuggestedCorrect = isCorrect;
            aiConfidence = isCorrect ? 100 : 40;
            evaluationMode = "auto-string-match";
          }
        }

        if (isCorrect) {
          score++;
        }

        if (needsHumanReview) {
          pendingReviewCount += 1;
        }

        answersDetailed.push({
          questionIndex: index,
          question: question?.title || question?.question || "Question",
          questionType,
          selectedAnswerIndex: parsedAnswerIndex,
          selectedAnswerText:
            submittedAnswerText || (parsedAnswerIndex !== null && Array.isArray(question?.options)
              ? String(question.options[parsedAnswerIndex] || "")
              : ""),
          expectedAnswer: String(question?.expectedAnswer || ""),
          isCorrect,
          needsHumanReview,
          aiSuggestedCorrect,
          aiConfidence,
          evaluationMode,
        });
      });

      const normalizedTimeSpent = Math.max(0, Number(timeSpentSeconds) || 0);
      const submittedAt = new Date();
      const aiCoach = await buildAiCoachFeedback({
        answersDetailed,
        questions: Array.isArray(quiz?.questions) ? quiz.questions : [],
        job: jobContext || {},
        score,
        totalQuestions: quiz.questions.length,
      });
  
      // Update application with quiz score
      await ApplicationModel.findOneAndUpdate(
        { jobId, candidateId },
        {
          quizScore: score,
          quizReviewPendingCount: pendingReviewCount,
          quizCompleted: true,
          quizSubmittedAt: submittedAt,
          quizTimeSpentSeconds: normalizedTimeSpent,
          quizAnswers: answersDetailed,
          aiCoach,
        },
        { new: true }
      );

      const normalizeSecurityEvent = (eventType) => {
        const normalized = String(eventType || "").toLowerCase();
        if (["copy-attempt", "copy-hotkey", "cut-attempt", "cut-hotkey"].includes(normalized)) return "copy-attempt";
        if (["paste-attempt", "paste-hotkey"].includes(normalized)) return "paste-attempt";
        if (["devtools-access", "devtools-hotkey"].includes(normalized)) return "devtools-access";
        return null;
      };

      const allowedCompletionType = ["normal", "timeout", "interrupted"].includes(String(completionType || "").toLowerCase())
        ? String(completionType).toLowerCase()
        : "normal";

      const mappedFocusEvents = (Array.isArray(req.body?.focusLossEvents) ? req.body.focusLossEvents : [])
        .map((entry) => ({
          timestamp: entry?.timestamp ? new Date(entry.timestamp) : new Date(),
          type: "lost",
          durationSeconds: Math.max(0, Number(entry?.durationSeconds) || 0),
        }))
        .filter((entry) => !Number.isNaN(entry.timestamp?.getTime?.()));

      const mappedSecurityEvents = (Array.isArray(req.body?.securityEvents) ? req.body.securityEvents : [])
        .map((entry) => {
          const event = normalizeSecurityEvent(entry?.event || entry?.type);
          if (!event) return null;
          return {
            timestamp: entry?.timestamp ? new Date(entry.timestamp) : new Date(),
            event,
          };
        })
        .filter((entry) => entry && !Number.isNaN(entry.timestamp?.getTime?.()));

      const allowedSubmissionFlags = new Set([
        "fast-completion",
        "minimum-time-warning",
        "multiple-focus-losses",
        "copy-paste-attempts",
        "devtools-access",
        "suspicious-pattern",
      ]);

      const middlewareFlags = Array.isArray(req.submissionFlags)
        ? req.submissionFlags.map((flag) => ({
          flag: allowedSubmissionFlags.has(String(flag?.flag || ""))
            ? String(flag.flag)
            : "suspicious-pattern",
          severity: flag.severity || "medium",
          timestamp: new Date(),
        }))
        : [];

      const submissionMetadata = req.submissionMetadata || {};
      const submissionValidation = req.submissionValidation || {
        totalTimeValid: true,
        averageTimePerQuestion: 0,
        duplicateAnswerCount: 0,
        flagged: false,
        flagReason: null,
      };

      const safeSubmissionValidation = {
        ...submissionValidation,
        flagReason: allowedSubmissionFlags.has(String(submissionValidation?.flagReason || ""))
          ? submissionValidation.flagReason
          : null,
      };

      await QuizResultModel.create({
        jobId,
        candidateId,
        score,
        totalQuestions: quiz.questions.length,
        timeSpentSeconds: normalizedTimeSpent,
        answers: answersDetailed.map((answer) => ({
          questionIndex: answer.questionIndex,
          selectedAnswerIndex: answer.selectedAnswerIndex,
          selectedAnswerText: answer.selectedAnswerText,
          isCorrect: answer.isCorrect,
          needsHumanReview: answer.needsHumanReview,
          aiSuggestedCorrect: answer.aiSuggestedCorrect,
          aiConfidence: answer.aiConfidence,
          evaluationMode: answer.evaluationMode,
        })),
        aiCoach,
        submittedAt,
        auditTrail: {
          ipAddress: submissionMetadata.ipAddress || req.ip || req.connection?.remoteAddress || null,
          userAgent: submissionMetadata.userAgent || req.get("user-agent") || null,
          focusEvents: mappedFocusEvents,
          securityEvents: mappedSecurityEvents,
          completionType: allowedCompletionType,
        },
        submissionFlags: middlewareFlags,
        submissionValidation: safeSubmissionValidation,
      });
  
      res.status(200).json({
        success: true,
        score,
        totalQuestions: quiz.questions.length,
        passingScore: Math.ceil(quiz.questions.length / 2),
        timeSpentSeconds: normalizedTimeSpent,
        reviewRequiredCount: pendingReviewCount,
        aiCoach,
      });
    } catch (error) {
      console.error("❌ Error submitting quiz:", error);
      res.status(500).json({
        message: "Server error while processing quiz",
        detail: error?.message || "unknown-error",
      });
    }
  });

const requireAdminAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ message: "Unauthorized: missing token" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
    const user = await UserModel.findById(decoded.id).select("role").lean();

    if (!user || user.role !== "ADMIN") {
      return res.status(403).json({ message: "Forbidden: admin access required" });
    }

    req.authUser = { id: String(decoded.id), role: user.role };
    return next();
  } catch (error) {
    return res.status(401).json({ message: "Unauthorized: invalid token" });
  }
};

const getQuizAuditSubmissions = async (req, res) => {
  try {
    const {
      candidateName,
      candidateId,
      jobId,
      flagType,
      flagged,
      startDate,
      endDate,
      sortBy = "submittedAt",
    } = req.query;

    const filter = {};

    if (candidateId) {
      filter.candidateId = candidateId;
    }

    if (jobId) {
      filter.jobId = jobId;
    }

    if (flagType) {
      filter.submissionFlags = { $elemMatch: { flag: String(flagType).trim() } };
    }

    if (String(flagged).toLowerCase() === "true") {
      filter["submissionValidation.flagged"] = true;
    }

    if (startDate || endDate) {
      filter.submittedAt = {};
      if (startDate) {
        const parsedStart = new Date(startDate);
        if (!Number.isNaN(parsedStart.getTime())) {
          filter.submittedAt.$gte = parsedStart;
        }
      }
      if (endDate) {
        const parsedEnd = new Date(endDate);
        if (!Number.isNaN(parsedEnd.getTime())) {
          parsedEnd.setHours(23, 59, 59, 999);
          filter.submittedAt.$lte = parsedEnd;
        }
      }
      if (!filter.submittedAt.$gte && !filter.submittedAt.$lte) {
        delete filter.submittedAt;
      }
    }

    const sortMap = {
      submittedAt: { submittedAt: -1 },
      score: { score: -1 },
      flagged: { "submissionValidation.flagged": -1, submittedAt: -1 },
    };

    const submissions = await QuizResultModel.find(filter)
      .populate("candidateId", "name email")
      .populate("jobId", "title")
      .sort(sortMap[sortBy] || sortMap.submittedAt)
      .lean();

    const normalizedCandidateName = String(candidateName || "").trim().toLowerCase();
    const filteredByCandidateName = normalizedCandidateName
      ? submissions.filter((submission) => {
        const candidate = submission?.candidateId || {};
        const name = String(candidate?.name || "").toLowerCase();
        const email = String(candidate?.email || "").toLowerCase();
        return name.includes(normalizedCandidateName) || email.includes(normalizedCandidateName);
      })
      : submissions;

    return res.status(200).json(filteredByCandidateName);
  } catch (error) {
    console.error("❌ Error fetching quiz audit submissions:", error);
    return res.status(500).json({ message: "Server error while fetching quiz audit submissions" });
  }
};

app.get("/Frontend/quiz-audit-submissions", requireAdminAuth, getQuizAuditSubmissions);
app.get("/api/quiz-audit-log", requireAdminAuth, getQuizAuditSubmissions);

  app.get('/Frontend/quiz-lengths', async (req, res) => {
    try {
      const quizzes = await QuizModel.find({}, 'jobId questions');
      const lengths = {};
      quizzes.forEach(quiz => {
        lengths[quiz.jobId] = quiz.questions.length;
      });
      res.status(200).json(lengths);
    } catch (error) {
      console.error("Error fetching quiz lengths:", error);
      res.status(500).json({ message: "Error fetching quiz lengths" });
    }
  });

app.get("/Frontend/quiz-results/:jobId", async (req, res) => {
  try {
    const results = await QuizResultModel.find({ jobId })
      .populate("candidateId", "name email");

    res.json(results);
  } catch (err) {
    console.error("❌ Erreur récupération des scores:", err);
    res.status(500).json({ message: "Erreur serveur" });
  }
});

app.put("/Frontend/manual-grade-quiz-answer", async (req, res) => {
  try {
    const { jobId, candidateId, questionIndex, isCorrect } = req.body;

    if (!jobId || !candidateId || !Number.isInteger(Number(questionIndex)) || typeof isCorrect !== "boolean") {
      return res.status(400).json({
        message: "jobId, candidateId, questionIndex (number), and isCorrect (boolean) are required",
      });
    }

    const normalizedQuestionIndex = Number(questionIndex);
    const application = await ApplicationModel.findOne({ jobId, candidateId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    if (!Array.isArray(application.quizAnswers) || !application.quizAnswers[normalizedQuestionIndex]) {
      return res.status(404).json({ message: "Quiz answer not found for this question index" });
    }

    application.quizAnswers[normalizedQuestionIndex].isCorrect = isCorrect;
    application.quizAnswers[normalizedQuestionIndex].needsHumanReview = false;
    application.quizAnswers[normalizedQuestionIndex].evaluationMode = "rh-manual";
    application.quizAnswers[normalizedQuestionIndex].manualReviewedAt = new Date();
    const recalculatedScore = application.quizAnswers.filter((answer) => answer?.isCorrect).length;
    const recalculatedPendingReviews = application.quizAnswers.filter((answer) => answer?.needsHumanReview).length;
    application.quizScore = recalculatedScore;
    application.quizReviewPendingCount = recalculatedPendingReviews;
    application.quizCompleted = true;
    if (!application.quizSubmittedAt) {
      application.quizSubmittedAt = new Date();
    }
    await application.save();

    const latestQuizResult = await QuizResultModel.findOne({ jobId, candidateId }).sort({ submittedAt: -1 });
    let updatedQuizResult = null;
    if (latestQuizResult) {
      latestQuizResult.score = recalculatedScore;
      latestQuizResult.totalQuestions = Array.isArray(application.quizAnswers) ? application.quizAnswers.length : 0;
      latestQuizResult.timeSpentSeconds = Number(application.quizTimeSpentSeconds || 0);
      latestQuizResult.answers = Array.isArray(application.quizAnswers)
        ? application.quizAnswers.map((answer) => ({
            questionIndex: answer.questionIndex,
            selectedAnswerIndex: answer.selectedAnswerIndex,
            selectedAnswerText: answer.selectedAnswerText,
            isCorrect: answer.isCorrect,
            needsHumanReview: answer.needsHumanReview,
            aiSuggestedCorrect: answer.aiSuggestedCorrect,
            aiConfidence: answer.aiConfidence,
            evaluationMode: answer.evaluationMode,
          }))
        : [];
      if (!latestQuizResult.submittedAt) {
        latestQuizResult.submittedAt = application.quizSubmittedAt || new Date();
      }
      updatedQuizResult = await latestQuizResult.save();
    }

    return res.status(200).json({
      message: "Manual grading saved",
      quizScore: recalculatedScore,
      reviewRequiredCount: recalculatedPendingReviews,
      updatedAnswer: application.quizAnswers[normalizedQuestionIndex],
      quizResult: updatedQuizResult,
    });
  } catch (error) {
    console.error("❌ Error while manually grading quiz answer:", error);
    return res.status(500).json({ message: "Server error while saving manual grade" });
  }
});


app.put("/Frontend/ai-grade-quiz-answer", async (req, res) => {
  try {
    const { jobId, candidateId, questionIndex } = req.body;

    if (!jobId || !candidateId || !Number.isInteger(Number(questionIndex))) {
      return res.status(400).json({
        message: "jobId, candidateId and questionIndex (number) are required",
      });
    }

    const normalizedQuestionIndex = Number(questionIndex);
    const application = await ApplicationModel.findOne({ jobId, candidateId });
    if (!application) {
      return res.status(404).json({ message: "Application not found" });
    }

    if (!Array.isArray(application.quizAnswers) || !application.quizAnswers[normalizedQuestionIndex]) {
      return res.status(404).json({ message: "Quiz answer not found for this question index" });
    }

    const answer = application.quizAnswers[normalizedQuestionIndex];
    const answerType = String(answer?.questionType || "").toLowerCase();
    if (!OPEN_QUESTION_TYPES.has(answerType)) {
      return res.status(400).json({ message: "AI grading is only available for open-answer questions" });
    }

    const personalizedQuiz = await CandidateQuizModel.findOne({ jobId, candidateId }).select("questions").lean();
    const genericQuiz = !personalizedQuiz ? await QuizModel.findOne({ jobId }).select("questions").lean() : null;
    const questionRef = ((personalizedQuiz?.questions || genericQuiz?.questions || [])[normalizedQuestionIndex]) || null;

    const aiEvaluation = evaluateOpenAnswerSemiAuto({
      submittedAnswerText: String(answer?.selectedAnswerText || ""),
      expectedAnswerText: String(answer?.expectedAnswer || questionRef?.expectedAnswer || ""),
      questionText: String(answer?.question || questionRef?.title || questionRef?.question || ""),
      skillHints: Array.isArray(questionRef?.skills) ? questionRef.skills : [],
    });

    application.quizAnswers[normalizedQuestionIndex].isCorrect = aiEvaluation.isCorrect;
    application.quizAnswers[normalizedQuestionIndex].needsHumanReview = aiEvaluation.needsHumanReview;
    application.quizAnswers[normalizedQuestionIndex].aiSuggestedCorrect = aiEvaluation.aiSuggestedCorrect;
    application.quizAnswers[normalizedQuestionIndex].aiConfidence = aiEvaluation.aiConfidence;
    application.quizAnswers[normalizedQuestionIndex].evaluationMode = `rh-ai-${aiEvaluation.evaluationMode}`;
    application.quizAnswers[normalizedQuestionIndex].manualReviewedAt = null;

    const recalculatedScore = application.quizAnswers.filter((item) => item?.isCorrect).length;
    const recalculatedPendingReviews = application.quizAnswers.filter((item) => item?.needsHumanReview).length;
    application.quizScore = recalculatedScore;
    application.quizReviewPendingCount = recalculatedPendingReviews;
    application.quizCompleted = true;
    if (!application.quizSubmittedAt) {
      application.quizSubmittedAt = new Date();
    }
    await application.save();

    const latestQuizResult = await QuizResultModel.findOne({ jobId, candidateId }).sort({ submittedAt: -1 });
    let updatedQuizResult = null;
    if (latestQuizResult) {
      latestQuizResult.score = recalculatedScore;
      latestQuizResult.totalQuestions = Array.isArray(application.quizAnswers) ? application.quizAnswers.length : 0;
      latestQuizResult.timeSpentSeconds = Number(application.quizTimeSpentSeconds || 0);
      latestQuizResult.answers = Array.isArray(application.quizAnswers)
        ? application.quizAnswers.map((item) => ({
            questionIndex: item.questionIndex,
            selectedAnswerIndex: item.selectedAnswerIndex,
            selectedAnswerText: item.selectedAnswerText,
            isCorrect: item.isCorrect,
            needsHumanReview: item.needsHumanReview,
            aiSuggestedCorrect: item.aiSuggestedCorrect,
            aiConfidence: item.aiConfidence,
            evaluationMode: item.evaluationMode,
          }))
        : [];
      if (!latestQuizResult.submittedAt) {
        latestQuizResult.submittedAt = application.quizSubmittedAt || new Date();
      }
      updatedQuizResult = await latestQuizResult.save();
    }

    return res.status(200).json({
      message: "AI grading completed",
      quizScore: recalculatedScore,
      reviewRequiredCount: recalculatedPendingReviews,
      updatedAnswer: application.quizAnswers[normalizedQuestionIndex],
      aiEvaluation,
      quizResult: updatedQuizResult,
    });
  } catch (error) {
    console.error("❌ Error while AI grading quiz answer:", error);
    return res.status(500).json({ message: "Server error while processing AI grading" });
  }
});



app.put("/Frontend/update-quiz-score", async (req, res) => {
  try {
    const { jobId, candidateId, score } = req.body;

    console.log("💬 Reçu :", { jobId, candidateId, score });

    // 1. Mettre à jour l'application
    const updatedApplication = await ApplicationModel.findOneAndUpdate(
      {
        jobId: new mongoose.Types.ObjectId(jobId),
        candidateId: new mongoose.Types.ObjectId(candidateId),
      },
      { quizScore: score },
      { new: true }
    );

    if (!updatedApplication) {
      return res.status(404).json({ message: "Application not found" });
    }

    // 2. Créer ou mettre à jour QuizResult
    const quizResult = await QuizResultModel.findOneAndUpdate(
      {
        jobId: new mongoose.Types.ObjectId(jobId),
        candidateId: new mongoose.Types.ObjectId(candidateId),
      },
      {
        jobId: new mongoose.Types.ObjectId(jobId),
        candidateId: new mongoose.Types.ObjectId(candidateId),
        score,
      },
      { new: true, upsert: true } // upsert = crée si n'existe pas
    );

    console.log("✅ Application mise à jour :", updatedApplication);
    console.log("✅ Résultat quiz enregistré :", quizResult);

    res.json({ message: "Quiz score updated in both Application and QuizResult", updatedApplication, quizResult });

  } catch (err) {
    console.error("❌ Erreur :", err);
    res.status(500).json({ message: "Erreur serveur" });
  }
});



app.get("/Frontend/applications-by-candidate/:candidateId", async (req, res) => {
  try {
    const { candidateId } = req.params;

    const applications = await ApplicationModel.find({ candidateId })
      .populate("jobId", "title")
      .sort({ appliedAt: -1 });

    res.status(200).json(applications);
  } catch (err) {
    console.error("❌ Error fetching applications by candidate:", err);
    res.status(500).json({ message: "Erreur lors de la récupération des candidatures." });
  }
});

app.delete("/Frontend/delete-application/:id", async (req, res) => {
  try {
    const id = req.params.id;
    console.log("🧩 ID reçu pour suppression :", id);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID invalide" });
    }

    const deleted = await Application.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ error: "Aucune candidature trouvée." });
    }

    res.status(200).json({ message: "Candidature supprimée avec succès." });
  } catch (error) {
    console.error("❌ Erreur lors de la suppression :", error);
    res.status(500).json({ error: "Erreur serveur lors de la suppression." });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await UserModel.find().select('-password'); // ne pas envoyer le mot de passe
    res.json(users);
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des utilisateurs :", err);
    res.status(500).json({ message: "Erreur serveur" });
  }
});
// Get application statistics by month
app.get('/applications/stats', async (req, res) => {
  try {
      // Get all candidates with their applications
      const candidates = await UserModel.find(
          { role: "CANDIDATE" },
          'applications'
      ).lean();

      // Initialize monthly counts (0-11 for January-December)
      const monthlyCounts = Array(12).fill(0);

      candidates.forEach(candidate => {
          candidate.applications?.forEach(application => {
              if (application.dateSubmitted) {
                  try {
                      const dateValue = application.dateSubmitted.$date || application.dateSubmitted;
                      const applicationDate = new Date(dateValue);
                      
                      if (!isNaN(applicationDate)) {
                          const month = applicationDate.getMonth(); // 0-11
                          monthlyCounts[month]++;
                      }
                  } catch (error) {
                      console.error("Error processing application date:", error);
                  }
              }
          });
      });

      res.status(200).json({
          success: true,
          data: {
              monthlyCounts,
              // You can add more stats here if needed
          }
      });
  } catch (err) {
      console.error("Error fetching application stats:", err);
      res.status(500).json({ 
          success: false,
          message: "Error fetching application statistics",
          error: err.message 
      });
  }
});

app.post('/admins', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // Vérifie si l'admin existe déjà
    const existingAdmin = await UserModel.findOne({ email });
    if (existingAdmin) {
      return res.status(400).json({ message: "Un utilisateur avec cet email existe déjà." });
    }

    // Hachage du mot de passe
    const hashedPassword = await bcrypt.hash(password, 10);

    const newAdmin = new UserModel({
      name,
      email,
      password: hashedPassword,
      role: "ADMIN", // très important
    });

    await newAdmin.save();
    res.status(201).json({ message: "Admin ajouté avec succès.", admin: newAdmin });
  } catch (error) {
    console.error("❌ Erreur lors de l'ajout de l'admin :", error);
    res.status(500).json({ message: "Erreur serveur." });
  }
});
app.get('/Frontend/job/:id', async (req, res) => {
    const { id } = req.params; // Job ID from the URL

    try {
        // Fetch job details
        const job = await JobModel.findById(id)
            .select('title description salary location skills') // Adjust the fields you want to return
            .populate('entrepriseId'); // Populate company information if needed

        if (!job) {
            return res.status(404).json({ message: 'Job not found' });
        }

        // Respond with the job details
        res.json(job);
    } catch (error) {
        console.error('Error fetching job details:', error);
        res.status(500).json({ message: 'Server error' });
    }
});
app.get('/Frontend/candidate/:id', async (req, res) => {
    const { id } = req.params; // Candidate ID from the URL

    try {
        // Fetch candidate profile
        const candidate = await UserModel.findById(id)
            .select('name email profile') // Adjust the fields you want to return
            .populate('applications') // You can populate related fields if necessary
            .populate('interviews'); // Populate interviews if necessary

        if (!candidate) {
            return res.status(404).json({ message: 'Candidate not found' });
        }

        // Respond with the candidate profile
        res.json(candidate);
    } catch (error) {
        console.error('Error fetching candidate profile:', error);
        res.status(500).json({ message: 'Server error' });
    }
});
app.post('/Frontend/predict-score', async (req, res) => {
  try {
    const { jobId, candidateId } = req.body;
    
    // Get job and candidate data
    const [job, candidate] = await Promise.all([
    JobModel.findById(jobId),
      UserModel.findById(candidateId)
    ]);

    if (!job || !candidate) {
      return res.status(404).json({ error: 'Job or candidate not found' });
    }

    // Prepare features for ML model
    const features = {
      domain_match: candidate.profile.domain === job.domain ? 1 : 0,
      experience_match: Math.min(candidate.profile.experienceYears / job.requiredExperience, 1),
      education_match: candidate.profile.education === job.requiredEducation ? 1 : 0,
      skill_match: calculateSkillMatch(candidate.profile.skills, job.skills),
      quiz_score: candidate.quizScore || 0
    };

    // Call Flask ML service
    const mlResponse = await axios.post('http://localhost:7000/predict', features);
    const predictedScore = mlResponse.data.interview_score;

    res.json({
      predictedScore,
      features
    });

  } catch (error) {
    console.error('Error predicting interview score:', error);
    res.status(500).json({ error: 'Failed to predict interview score' });
  }
});

function calculateSkillMatch(candidateSkills, jobSkills) {
  if (!jobSkills || jobSkills.length === 0) return 0;
  if (!candidateSkills || candidateSkills.length === 0) return 0;
  
  const matchedSkills = candidateSkills.filter(skill => 
    jobSkills.includes(skill)
  ).length;
  
  return matchedSkills / jobSkills.length;
}

let predictFromSkillsServiceUnavailableUntil = 0;

const toFiniteRatio = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(1, numeric));
};

const computeWeightedMatchPercent = (matches = {}) => {
  const skillRatio = toFiniteRatio(matches?.skill_match);
  const expRatio = toFiniteRatio(matches?.exp_match);
  const educationRatio = toFiniteRatio(matches?.education_match);
  const weighted = (skillRatio * 0.55) + (expRatio * 0.3) + (educationRatio * 0.15);
  return Math.round(Math.max(0, Math.min(100, weighted * 100)));
};

const buildPredictionPayload = (payload = {}) => {
  const matches = payload?.matches || {};
  const skillPercent = Math.round(toFiniteRatio(matches?.skill_match) * 100);
  const expPercent = Math.round(toFiniteRatio(matches?.exp_match) * 100);
  const educationPercent = Math.round(toFiniteRatio(matches?.education_match) * 100);

  const rawMatchPercent = Number(payload?.match_percent);
  const normalizedMatchPercent = Number.isFinite(rawMatchPercent)
    ? Math.round(Math.max(0, Math.min(100, rawMatchPercent)))
    : computeWeightedMatchPercent(matches);

  return {
    ...payload,
    match_percent: normalizedMatchPercent,
    match_breakdown: {
      skill: skillPercent,
      exp: expPercent,
      education: educationPercent,
    },
  };
};

const buildPredictionFallback = (details, source = 'backend-fallback') => ({
  hired: 0,
  confidence: 0,
  match_percent: 0,
  match_breakdown: {
    skill: 0,
    exp: 0,
    education: 0,
  },
  matches: {
    skill_match: 0,
    exp_match: 0,
    education_match: 0,
  },
  status: 'fallback',
  source,
  details,
});

app.post('/predict-from-skills', async (req, res) => {
  try {
    if (Date.now() < predictFromSkillsServiceUnavailableUntil) {
      return res.status(200).json(
        buildPredictionFallback(
          'ML service is temporarily unavailable. Retry in a few seconds.',
          'circuit-breaker'
        )
      );
    }

    // Ensure experience values are numbers, not arrays
    const requestData = {
      ...req.body,
      candidate_exp: Array.isArray(req.body.candidate_exp) 
        ? req.body.candidate_exp[0] || 0 
        : req.body.candidate_exp || 0,
      required_exp: Array.isArray(req.body.required_exp) 
        ? req.body.required_exp[0] || 1 
        : req.body.required_exp || 1
    };

    const response = await axios.post('http://localhost:5000/predict-from-skills', requestData, {
      timeout: 15000,
    });
    predictFromSkillsServiceUnavailableUntil = 0;
    res.json(buildPredictionPayload(response.data || {}));
  } catch (error) {
    const remoteError = error.response?.data;
    const details =
      (typeof remoteError?.error === 'string' && remoteError.error.trim())
      || (typeof error.message === 'string' && error.message.trim())
      || 'Unknown prediction service error';
    const isServiceUnavailable = !error.response;
    console.error('Error calling Flask service:', remoteError || error.message);

    if (isServiceUnavailable) {
      // Cache unavailability briefly to avoid hammering the offline ML service.
      predictFromSkillsServiceUnavailableUntil = Date.now() + 60000;
      return res.status(200).json(buildPredictionFallback(details));
    }

    res.status(500).json({ 
      error: 'Failed to get prediction',
      details,
      status: 'failed' 
    });
  }
});

const recommendationRoutes = require('./routes/recommendationRoute');
app.use('/api/recommendations', recommendationRoutes);

// 🎙️ Voice Recording API Endpoints
app.get('/api/voice-recordings/list', async (req, res) => {
  try {
    const files = await fsp.readdir(audioDir);
    const wavFiles = files.filter(file => file.endsWith('.wav'));
    
    const recordings = await Promise.all(
      wavFiles.map(async (file) => {
        const filePath = path.join(audioDir, file);
        const stats = await fsp.stat(filePath);
        return {
          filename: file,
          url: `/voice-recordings/${file}`,
          size: stats.size,
          createdAt: stats.birthtime,
          sizeKB: Math.round(stats.size / 1024),
        };
      })
    );
    
    recordings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({
      success: true,
      count: recordings.length,
      recordings,
    });
  } catch (error) {
    console.error('Error listing voice recordings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to list recordings',
      error: error.message,
    });
  }
});

app.get('/api/voice-recordings/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename.endsWith('.wav')) {
      return res.status(400).json({ message: 'Only WAV files allowed' });
    }
    
    const filePath = path.join(audioDir, filename);
    const stats = await fsp.stat(filePath);
    
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': stats.size,
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    
    res.download(filePath);
  } catch (error) {
    console.error('Error downloading recording:', error);
    res.status(404).json({ message: 'Recording not found' });
  }
});

app.delete('/api/voice-recordings/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename.endsWith('.wav')) {
      return res.status(400).json({ message: 'Invalid filename' });
    }
    
    const filePath = path.join(audioDir, filename);
    await fsp.unlink(filePath);
    
    res.json({ success: true, message: `Recording ${filename} deleted` });
  } catch (error) {
    console.error('Error deleting recording:', error);
    res.status(500).json({ message: 'Failed to delete recording' });
  }
});

// Start the server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ Socket.IO available at ws://localhost:${PORT}/socket.io/`);
});
