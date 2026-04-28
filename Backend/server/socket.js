const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const { RTCSessionDescription, RTCPeerConnection, RTCIceCandidate } = require('wrtc');
const UserModel = require('./models/user');
const Message = require('./models/Message');
const CallRoom = require('./models/CallRoom');
const { startVoiceEngineRealtimeWorker } = require('./services/voiceEngineService');
const interviewAgent = require('./services/interviewAgentService');
const Job = require('./models/job');

const activeConnections = new Map();
const userSockets = new Map();
const isProd = process.env.NODE_ENV === 'production';

// Tracks interview sessions that have already been started via the Python
// agent. Both the RH auto-start effect and the candidate's intro kick-off
// race to emit `agent:start-session`; without this map, each call resets
// Python state and the intro is broadcast twice ("D1" duplicates in the
// dashboard). When a second start request arrives within AGENT_STICKY_MS,
// we just re-broadcast the cached intro payload instead of re-starting.
const activeAgentSessions = new Map(); // interviewId -> { startedAt, payload }
const AGENT_STICKY_MS = 60000;

const toNodeBuffer = (chunk) => {
  if (!chunk) return null;
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'base64');
  if (chunk?.type === 'Buffer' && Array.isArray(chunk?.data)) return Buffer.from(chunk.data);
  return null;
};

const setupSocket = (server) => {
  const io = socketIO(server, {
    cors: {
      origin: "http://localhost:5173",
      methods: ["GET", "POST"],
      credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        if (isProd) return next(new Error('Authentication token required'));

        socket.user = {
          id: `guest-${socket.id}`,
          email: 'guest@local',
          role: 'guest',
        };
        userSockets.set(socket.user.id, socket.id);
        return next();
      }

      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);
      } catch (error) {
        if (isProd) return next(new Error('Authentication failed'));
        console.warn('Socket token verification failed in dev mode, falling back to guest:', error?.message);

        socket.user = {
          id: `guest-${socket.id}`,
          email: 'guest@local',
          role: 'guest',
        };
        userSockets.set(socket.user.id, socket.id);
        return next();
      }

      const user = await UserModel.findById(decoded.id);
      if (!user) {
        if (isProd) return next(new Error('User not found'));
        socket.user = {
          id: `guest-${socket.id}`,
          email: 'guest@local',
          role: 'guest',
        };
        userSockets.set(socket.user.id, socket.id);
        return next();
      }

      socket.user = {
        id: user._id.toString(),
        email: user.email,
        role: user.role
      };

      userSockets.set(user._id.toString(), socket.id);
      next();
    } catch (err) {
      console.error('Socket auth error:', err);
      return next(new Error('Authentication failed'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user?.id;
    console.log('✅ Client connected:', userId);

    socket.join(userId);

    const heartbeatInterval = setInterval(() => {
      socket.emit('ping');
    }, 5000);

    socket.on('pong', () => {
      console.log('❤️ Heartbeat from:', userId);
    });

    socket.on('send-message', async ({ to, from, text, timestamp }) => {
      try {
        const newMessage = new Message({
          from,
          to,
          text,
          timestamp: new Date(timestamp)
        });

        await newMessage.save();

        // Emit to recipient
        const recipientSocketId = userSockets.get(to);
        if (recipientSocketId) {
          io.to(recipientSocketId).emit('receive-message', {
            from,
            to,
            text,
            timestamp: newMessage.timestamp
          });
        }

        // If message is to bot, handle bot response
        if (to === 'bot') {
          const response = await fetch('http://localhost:3001/api/messages/bot/interaction', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${socket.handshake.auth.token}`
            },
            body: JSON.stringify({ userId: from, message: text })
          });

          const { reply } = await response.json();

          const botMessage = new Message({
            from: 'bot',
            to: from,
            text: reply,
            timestamp: new Date()
          });

          await botMessage.save();

          const senderSocketId = userSockets.get(from);
          if (senderSocketId) {
            io.to(senderSocketId).emit('receive-message', {
              from: 'bot',
              to: from,
              text: reply,
              timestamp: botMessage.timestamp
            });
          }
        }
      } catch (err) {
        console.error("Error sending message:", err);
      }
    });

    socket.on("notify-candidate", ({ to, message }) => {
      const recipientSocketId = userSockets.get(to);
      if (recipientSocketId) {
        io.to(recipientSocketId).emit(`notification-${to}`, { message });
        console.log(`🔔 Notification sent to candidate ${to}: ${message}`);
      }
    });

    socket.on('join-interview', ({ interviewId }) => {
      if (!interviewId) return socket.emit('error', 'Interview ID is required');
      socket.join(interviewId);
      console.log(`👥 User ${userId} joined interview ${interviewId}`);
      socket.to(interviewId).emit('user-connected', { userId });
    });

    socket.on('join-room', ({ roomId }) => {
      if (!roomId) return;
      socket.join(roomId);
      console.log(`👥 User ${userId} joined room ${roomId}`);
    });

    socket.on('offer', async ({ interviewId, offer }) => {
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
          iceCandidatePoolSize: 10
        });

        activeConnections.set(userId, pc);

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            socket.to(interviewId).emit('ice-candidate', {
              userId,
              candidate: event.candidate
            });
          }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        socket.to(interviewId).emit('answer', {
          userId,
          answer
        });
      } catch (err) {
        console.error('Offer handling error:', err);
        socket.emit('error', 'Failed to handle offer');
      }
    });

    socket.on('answer', async ({ interviewId, answer }) => {
      try {
        const pc = activeConnections.get(userId);
        if (!pc) throw new Error('Peer connection not found');
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      } catch (err) {
        console.error('Answer handling error:', err);
        socket.emit('error', 'Failed to handle answer');
      }
    });

    socket.on('ice-candidate', async ({ interviewId, candidate }) => {
      try {
        const pc = activeConnections.get(userId);
        if (!pc) throw new Error('Peer connection not found');
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('ICE candidate error:', err);
        socket.emit('error', 'Failed to handle ICE candidate');
      }
    });

    let liveWorker = null;
    let liveInterviewId = null;

    const cleanupLiveVoice = () => {
      if (liveWorker) {
        liveWorker.stop().catch(() => {});
        liveWorker = null;
      }
    };

    socket.on('start-voice-test', (payload = {}) => {
      const { interviewId, ...overrides } = payload || {};
      liveInterviewId = interviewId || null;

      console.log(`🎤 Starting live voice test for user ${userId}`);
      cleanupLiveVoice();

      // Tune defaults for earlier chunk flush while still avoiding excessive noise.
      const liveOverrides = {
        minSpeechMs: 220,
        minSilenceMs: 260,
        maxChunkMs: 900,
        maxTrailingSilenceMs: 120,
        minSpeechRatio: 0.3,
        ...overrides,
      };

      liveWorker = startVoiceEngineRealtimeWorker(liveOverrides, {
        onMessage: (payload) => {
          socket.emit('voice-segment-update', payload);

          if (liveInterviewId) {
            socket.to(liveInterviewId).emit('voice-segment-update', {
              ...payload,
              fromUserId: userId,
            });
          }
        },
        onError: (err) => console.error('Realtime worker error:', err),
        onStderr: (err) => console.log('Worker stderr:', err)
      });

      socket.emit('voice-stream-ready', { ok: true, interviewId: liveInterviewId });
    });

    socket.on('voice-audio', (chunk) => {
      const normalizedChunk = toNodeBuffer(chunk);
      if (!normalizedChunk || normalizedChunk.length === 0) return;

      if (liveWorker) {
        liveWorker.sendChunk(normalizedChunk);
      }
    });

    socket.on('stop-voice-test', () => {
      console.log(`🛑 Stopping live voice test for user ${userId}`);
      if (liveWorker) {
        liveWorker.stop().then((summary) => {
          socket.emit('voice-test-completed', summary);

          if (liveInterviewId) {
            socket.to(liveInterviewId).emit('voice-test-completed', {
              ...summary,
              fromUserId: userId,
            });
          }
        }).catch(() => {});
        liveWorker = null;
      }

      liveInterviewId = null;
    });

    socket.on('disconnect', () => {
      clearInterval(heartbeatInterval);

      cleanupLiveVoice();
      liveInterviewId = null;

      const pc = activeConnections.get(userId);
      if (pc) {
        pc.close();
        activeConnections.delete(userId);
      }
      userSockets.delete(userId);
      console.log('❌ Client disconnected:', userId);
    });

    // ============ CALL ROOM EVENTS ============
    
    // Candidate requests notification when a new room is created
    socket.on('subscribe-to-available-rooms', () => {
      socket.join('available-rooms');
      console.log(`✅ User ${userId} subscribed to available rooms`);
    });

    socket.on('unsubscribe-from-available-rooms', () => {
      socket.leave('available-rooms');
      console.log(`❌ User ${userId} unsubscribed from available rooms`);
    });

    // RH creates a call room (broadcast to candidates)
    socket.on('call-room-created', ({ roomId, room }) => {
      console.log(`📞 Call room created: ${roomId} by ${userId}`);
      io.to('available-rooms').emit('new-call-room', { roomId, room });
    });

    // Candidate requests to join a room
    socket.on('call-room-join-request', ({ roomId, candidateId, initiatorId }) => {
      const initiatorSocketId = userSockets.get(initiatorId);
      if (initiatorSocketId) {
        io.to(initiatorSocketId).emit('candidate-join-request', { roomId, candidateId });
        console.log(`🔔 RH notified: Candidate ${candidateId} requested to join room ${roomId}`);
      }
    });

    // RH confirms candidate join - start recording
    socket.on('confirm-candidate-join', ({ roomId, roomDbId, candidateId }) => {
      if (roomDbId) {
        socket.join(roomDbId);
      }
      if (roomId) {
        socket.join(roomId);
      }
      const candidateSocketId = userSockets.get(candidateId);
      if (candidateSocketId) {
        io.to(candidateSocketId).emit('join-confirmed', { roomId, roomDbId });
        console.log(`✅ Candidate ${candidateId} confirmed for room ${roomId}`);
      }
      // Leave available rooms
      io.to('available-rooms').emit('call-room-status-update', { roomId, roomDbId, status: 'active' });
    });

    // RH rejects candidate join
    socket.on('reject-candidate-join', ({ roomId, roomDbId, candidateId }) => {
      const candidateSocketId = userSockets.get(candidateId);
      if (candidateSocketId) {
        io.to(candidateSocketId).emit('join-rejected', { roomId, roomDbId });
        console.log(`❌ Candidate ${candidateId} rejected for room ${roomId}`);
      }
    });

    // Update transcription in real-time for RH dashboard
    socket.on('update-call-transcription', async ({ roomId, roomDbId, text, segment, sentiment }) => {
      if (!roomId && !roomDbId) return;

      try {
        let room = null;
        if (roomDbId) {
          room = await CallRoom.findById(roomDbId).select('initiator roomId');
        }
        if (!room && roomId) {
          room = await CallRoom.findOne({ roomId }).select('initiator roomId');
        }

        if (room?.initiator) {
          const initiatorSocketId = userSockets.get(room.initiator.toString());
          if (initiatorSocketId) {
            io.to(initiatorSocketId).emit('transcription-update', {
              text,
              segment,
              sentiment,
              fromUserId: userId,
              roomId: room.roomId,
            });
          }
        }
      } catch (error) {
        console.error('Failed direct RH transcription emit:', error?.message || error);
      }

      if (roomId) {
        socket.to(roomId).emit('transcription-update', {
          text,
          segment,
          sentiment,
          fromUserId: userId
        });
      }
      if (roomDbId) {
        socket.to(roomDbId).emit('transcription-update', {
          text,
          segment,
          sentiment,
          fromUserId: userId
        });
      }

      console.log(`📝 Transcription updated for room ${roomId || roomDbId}`);
    });

    // End call room
    socket.on('end-call-room', ({ roomId, roomDbId }) => {
      if (roomDbId) {
        io.to(roomDbId).emit('call-room-ended', { roomId, roomDbId });
        socket.leave(roomDbId);
      }
      if (roomId) {
        io.to(roomId).emit('call-room-ended', { roomId, roomDbId });
        socket.leave(roomId);
      }
      console.log(`🛑 Call room ${roomId || roomDbId} ended`);
    });

    // ============ ADAPTIVE INTERVIEW AGENT EVENTS ============
    // The RH dashboard drives this: start -> (candidate answers stream in) ->
    // optional switch-phase -> end. Agent messages broadcast to both rooms;
    // scoring details go only to the initiator (RH).

    const agentRoomKeys = (roomId, roomDbId) => [roomId, roomDbId].filter(Boolean);
    const normalizeInterviewStyle = (style) => {
      const normalized = String(style || 'friendly').trim().toLowerCase().replace(/[\s-]+/g, '_');
      return ['friendly', 'strict', 'senior', 'junior', 'fast_screening'].includes(normalized)
        ? normalized
        : 'friendly';
    };

    const broadcastAgentMessage = async (roomId, roomDbId, payload) => {
      agentRoomKeys(roomId, roomDbId).forEach((key) => {
        io.to(key).emit('agent:message', payload);
      });
      // Also push directly to participants' sockets so neither side misses it.
      try {
        const participants = roomDbId
          ? await CallRoom.findById(roomDbId).select('initiator candidate')
          : roomId
          ? await CallRoom.findOne({ roomId }).select('initiator candidate')
          : null;
        [participants?.initiator, participants?.candidate]
          .filter(Boolean)
          .map((x) => x.toString())
          .forEach((uid) => {
            const sid = userSockets.get(uid);
            if (sid) io.to(sid).emit('agent:message', payload);
          });
      } catch (_) {}
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
        if (!initiatorId) return;
        const initiatorSocketId = userSockets.get(initiatorId);
        if (initiatorSocketId) {
          io.to(initiatorSocketId).emit('agent:score', payload);
        }
      } catch (err) {
        console.error('agent:score routing failed:', err?.message || err);
      }
    };

    socket.on('agent:start-session', async ({ roomId, roomDbId, phase = 'intro', restart = false, interviewStyle = 'friendly' }) => {
      let interviewIdForCleanup = null;
      try {
        if (!roomId && !roomDbId) {
          return socket.emit('agent:error', { message: 'roomId or roomDbId required' });
        }

        const query = roomDbId ? { _id: roomDbId } : { roomId };
        const room = await CallRoom.findOne(query)
          .populate('job', 'title skills description')
          .populate('candidate', 'name email profile domain linkedin')
          .populate('initiator', 'name email domain enterprise');

        if (!room) return socket.emit('agent:error', { message: 'Call room not found' });

        const interviewId = room._id.toString();
        interviewIdForCleanup = interviewId;
        const normalizedInterviewStyle = normalizeInterviewStyle(interviewStyle);

        // Idempotency guard: RH auto-start and candidate kick-off both race to
        // emit this event. If we already started within the sticky window
        // and the caller didn't ask for an explicit restart, skip Python and
        // just re-broadcast the cached intro so latecomers see it. A pending
        // marker (payload=null) blocks simultaneous races from both hitting
        // Python while the first call is still in flight.
        const existing = activeAgentSessions.get(interviewId);
        if (existing && !restart && Date.now() - existing.startedAt < AGENT_STICKY_MS) {
          if (existing.payload) {
            broadcastAgentMessage(room.roomId, interviewId, existing.payload);
            if (existing.scoring) {
              await sendAgentScore(interviewId, room.roomId, existing.scoring);
            }
          }
          return;
        }

        activeAgentSessions.set(interviewId, { startedAt: Date.now(), payload: null, scoring: null });
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
        const profileExperience = Array.isArray(profile.experience)
          ? profile.experience.map((e) => ({
              title: e.title || '',
              company: e.company || '',
              duration: e.duration || '',
              description: e.description || '',
            }))
          : [];
        const linkedinExperience = Array.isArray(linkedin.experience)
          ? linkedin.experience.slice(0, 6).map((e) => ({
              title: e?.title || e?.position || '',
              company: e?.companyName || e?.company || '',
              duration: e?.duration || '',
              description: e?.description || '',
            }))
          : [];

        const candidateProfile = {
          short_description: profile.shortDescription || '',
          skills: [
            ...(Array.isArray(profile.skills) ? profile.skills.filter(Boolean) : []),
            ...(Array.isArray(linkedin.skills) ? linkedin.skills.filter(Boolean) : []),
          ],
          languages: Array.isArray(profile.languages) ? profile.languages.filter(Boolean) : [],
          domain: profile.domain || room.candidate?.domain || '',
          availability: profile.availability || '',
          experience: [...profileExperience, ...linkedinExperience],
          linkedin: {
            url: linkedin.url || '',
            headline: linkedin.headline || '',
            current_role: linkedin.currentRole || linkedin.currentPosition || '',
            current_company: linkedin.currentCompany || '',
            about: linkedin.about || '',
            location: linkedin.location || '',
          },
        };

        const result = await interviewAgent.startSession({
          interviewId,
          jobTitle,
          jobSkills,
          jobDescription,
          candidateName,
          candidateProfile,
          interviewStyle: normalizedInterviewStyle,
          phase,
        });

        const introPayload = {
          interviewId, roomId: room.roomId,
          phase: result.phase,
          interviewStyle: result.interview_style || normalizedInterviewStyle,
          turnIndex: result.turn_index,
          text: result.agent_message?.text,
          difficulty: result.agent_message?.difficulty,
          skillFocus: result.agent_message?.skill_focus,
        };
        const introScoring = {
          interviewId, roomId: room.roomId,
          phase: result.phase,
          interviewStyle: result.interview_style || normalizedInterviewStyle,
          turnIndex: result.turn_index,
          scoring: result.scoring,
          done: result.done,
        };

        activeAgentSessions.set(interviewId, {
          startedAt: Date.now(),
          payload: introPayload,
          scoring: introScoring,
        });

        broadcastAgentMessage(room.roomId, interviewId, introPayload);
        await sendAgentScore(interviewId, room.roomId, introScoring);

        console.log(`🤖 Agent session started for ${room.roomId} (phase=${result.phase})`);
      } catch (err) {
        console.error('agent:start-session failed:', err);
        // Drop the pending marker so a follow-up emit can retry cleanly.
        if (interviewIdForCleanup) {
          const entry = activeAgentSessions.get(interviewIdForCleanup);
          if (entry && !entry.payload) activeAgentSessions.delete(interviewIdForCleanup);
        }
        socket.emit('agent:error', { message: err.message });
      }
    });

    // Relay the candidate's live STT draft to the other party so both sides
    // see an in-progress "typing" bubble in the chat panel. Fire-and-forget.
    socket.on('candidate:draft', async ({ roomId, roomDbId, text }) => {
      try {
        if (!roomId && !roomDbId) return;
        const interviewId = roomDbId || (roomId && (await CallRoom.findOne({ roomId }).select('_id'))?._id?.toString());
        const payload = { interviewId, roomId, text: String(text || ''), ts: Date.now() };
        agentRoomKeys(roomId, interviewId).forEach((key) => {
          io.to(key).emit('candidate:draft', payload);
        });
        try {
          const participants = interviewId
            ? await CallRoom.findById(interviewId).select('initiator candidate')
            : null;
          [participants?.initiator, participants?.candidate]
            .filter(Boolean)
            .map((x) => x.toString())
            .forEach((uid) => {
              const sid = userSockets.get(uid);
              if (sid) io.to(sid).emit('candidate:draft', payload);
            });
        } catch (_) {}
      } catch (_) {}
    });

    socket.on('agent:candidate-turn', async ({ roomId, roomDbId, text, sentiment, source }) => {
      try {
        if (!text || !text.trim()) return;
        const interviewId = roomDbId || (roomId && (await CallRoom.findOne({ roomId }).select('_id'))?._id?.toString());
        if (!interviewId) {
          return socket.emit('agent:error', { message: 'interview session not found' });
        }

        const normalizedSource = String(source || 'voice').toLowerCase();

        // Echo the candidate's message to both parties so the chat thread is a
        // true WhatsApp-style log for RH and candidate alike. We broadcast to
        // the room AND directly to the initiator + candidate user sockets,
        // so the bubble still shows up even if a side hasn't rejoined the
        // room channel after a reconnect.
        const candidateBubble = {
          interviewId,
          roomId,
          text: text.trim(),
          sentiment: sentiment || null,
          source: normalizedSource,
          ts: Date.now(),
        };
        agentRoomKeys(roomId, interviewId).forEach((key) => {
          io.to(key).emit('candidate:message', candidateBubble);
        });
        try {
          const participants = await CallRoom.findById(interviewId).select('initiator candidate roomId');
          const roomIdResolved = participants?.roomId || roomId;
          candidateBubble.roomId = roomIdResolved;
          [participants?.initiator, participants?.candidate]
            .filter(Boolean)
            .map((x) => x.toString())
            .forEach((uid) => {
              const sid = userSockets.get(uid);
              if (sid) io.to(sid).emit('candidate:message', candidateBubble);
            });
        } catch (_) {}

        // Keep recruiter transcription dashboard in sync for typed answers too.
        if (normalizedSource === 'text') {
          try {
            const roomForTranscript = await CallRoom.findById(interviewId);
            if (roomForTranscript) {
              const normalizedSentiment = sentiment || { label: 'NEUTRAL', score: 0 };
              const segment = {
                text: candidateBubble.text,
                sentiment: normalizedSentiment,
                timestamp: new Date(),
              };

              roomForTranscript.transcription.segments.push(segment);
              roomForTranscript.transcription.text = `${roomForTranscript.transcription.text || ''} ${candidateBubble.text}`.trim();
              roomForTranscript.transcription.overallSentiment = normalizedSentiment;
              await roomForTranscript.save();

              const transcriptionPayload = {
                text: roomForTranscript.transcription.text,
                segment,
                sentiment: normalizedSentiment,
                fromUserId: userId,
                roomId: roomForTranscript.roomId || roomId,
              };

              if (roomForTranscript.roomId) {
                io.to(roomForTranscript.roomId).emit('transcription-update', transcriptionPayload);
              }

              const initiatorSocketId = roomForTranscript.initiator
                ? userSockets.get(roomForTranscript.initiator.toString())
                : null;
              if (initiatorSocketId) {
                io.to(initiatorSocketId).emit('transcription-update', transcriptionPayload);
              }
            }
          } catch (transcriptionErr) {
            console.error('Failed to persist typed transcription segment:', transcriptionErr?.message || transcriptionErr);
          }
        }

        const result = await interviewAgent.candidateTurn({ interviewId, text, sentiment });

        broadcastAgentMessage(roomId, interviewId, {
          interviewId, roomId,
          phase: result.phase,
          interviewStyle: result.interview_style,
          turnIndex: result.turn_index,
          text: result.agent_message?.text,
          difficulty: result.agent_message?.difficulty,
          skillFocus: result.agent_message?.skill_focus,
        });

        await sendAgentScore(interviewId, roomId, {
          interviewId, roomId,
          phase: result.phase,
          interviewStyle: result.interview_style,
          turnIndex: result.turn_index,
          scoring: result.scoring,
          done: result.done,
        });
      } catch (err) {
        console.error('agent:candidate-turn failed:', err);
        socket.emit('agent:error', { message: err.message });
      }
    });

    socket.on('agent:switch-phase', async ({ roomId, roomDbId, phase }) => {
      try {
        const interviewId = roomDbId || (roomId && (await CallRoom.findOne({ roomId }).select('_id'))?._id?.toString());
        if (!interviewId) return socket.emit('agent:error', { message: 'session not found' });

        const result = await interviewAgent.switchPhase({ interviewId, phase });

        broadcastAgentMessage(roomId, interviewId, {
          interviewId, roomId,
          phase: result.phase,
          interviewStyle: result.interview_style,
          turnIndex: result.turn_index,
          text: result.agent_message?.text,
          difficulty: result.agent_message?.difficulty,
          skillFocus: result.agent_message?.skill_focus,
        });

        await sendAgentScore(interviewId, roomId, {
          interviewId, roomId,
          phase: result.phase,
          interviewStyle: result.interview_style,
          turnIndex: result.turn_index,
          scoring: result.scoring,
          done: result.done,
        });

        console.log(`🤖 Agent phase switched to ${result.phase} for ${roomId || interviewId}`);
      } catch (err) {
        console.error('agent:switch-phase failed:', err);
        socket.emit('agent:error', { message: err.message });
      }
    });

    socket.on('agent:end-session', async ({ roomId, roomDbId }) => {
      try {
        const interviewId = roomDbId || (roomId && (await CallRoom.findOne({ roomId }).select('_id'))?._id?.toString());
        if (!interviewId) return;
        const snapshot = await interviewAgent.endSession({ interviewId });
        activeAgentSessions.delete(interviewId);
        agentRoomKeys(roomId, interviewId).forEach((key) =>
          io.to(key).emit('agent:ended', { interviewId, roomId, snapshot, report: snapshot?.report || null })
        );
        console.log(`🤖 Agent session ended for ${roomId || interviewId}`);
      } catch (err) {
        console.error('agent:end-session failed:', err);
        socket.emit('agent:error', { message: err.message });
      }
    });

    socket.on('error', (err) => {
      console.error('Socket error:', err.message);
    });
  });

  return io;
};

module.exports = setupSocket;
