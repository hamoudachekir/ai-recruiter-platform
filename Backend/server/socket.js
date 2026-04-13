const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const { RTCSessionDescription, RTCPeerConnection, RTCIceCandidate } = require('wrtc');
const UserModel = require('./models/user');
const Message = require('./models/Message');
const CallRoom = require('./models/CallRoom');
const { startVoiceEngineRealtimeWorker } = require('./services/voiceEngineService');

const activeConnections = new Map();
const userSockets = new Map();
const isProd = process.env.NODE_ENV === 'production';

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

    socket.on('error', (err) => {
      console.error('Socket error:', err.message);
    });
  });

  return io;
};

module.exports = setupSocket;