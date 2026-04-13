const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const CallRoom = require('../models/CallRoom');
const { verifyToken } = require('../middleware/auth');
const { UserModel } = require('../models/user');

// ── Multer storage for call recordings ────────────────
const recordingsDir = path.join(__dirname, '../uploads/recordings');
if (!fs.existsSync(recordingsDir)) {
  fs.mkdirSync(recordingsDir, { recursive: true });
}

const recordingStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, recordingsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.webm';
    cb(null, `recording-${req.params.roomId}-${Date.now()}${ext}`);
  }
});

const uploadRecordingMiddleware = multer({
  storage: recordingStorage,
  limits: { fileSize: 250 * 1024 * 1024 } // 250 MB max
});

// Create a new call room (RH initiates)
router.post('/create', verifyToken, async (req, res) => {
  try {
    const { jobId } = req.body;
    
    const user = await UserModel.findById(req.user._id);
    const role = user?.role?.toLowerCase();
    if (!user || (role !== 'rh' && role !== 'enterprise')) {
      return res.status(403).json({ message: 'Only RH/Enterprise users can create rooms' });
    }

    // Generate unique room ID
    const roomId = `room-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const callRoom = new CallRoom({
      roomId,
      initiator: req.user._id,
      initiatorRole: role,
      job: jobId || undefined,
      status: 'waiting_confirmation'
    });

    await callRoom.save();
    await callRoom.populate('initiator', 'email firstName lastName');

    res.status(201).json({
      success: true,
      message: 'Call room created successfully',
      room: callRoom
    });
  } catch (error) {
    console.error('Create call room error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get available rooms for candidates to join
router.get('/available', verifyToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user._id);
    const role = user?.role?.toLowerCase();
    if (!user || role !== 'candidate') {
      return res.status(403).json({ message: 'Only candidates can view available rooms' });
    }

    const waitingRooms = await CallRoom.find({ 
      status: 'waiting_confirmation',
      candidate: { $eq: null }
    })
    .populate('initiator', 'email firstName lastName')
    .populate('job', 'title company')
    .sort({ createdAt: -1 });

    res.json({
      success: true,
      rooms: waitingRooms
    });
  } catch (error) {
    console.error('Get available rooms error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get room details by public roomId slug (e.g. room-1775729693597-6hp5799xp)
router.get('/by-room/:publicRoomId', verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findOne({ roomId: req.params.publicRoomId })
      .populate('initiator', 'email firstName lastName')
      .populate('candidate', 'email firstName lastName')
      .populate('job', 'title company');

    if (!callRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const isInitiator = callRoom.initiator._id.equals(req.user._id);
    const isCandidate = callRoom.candidate && callRoom.candidate._id.equals(req.user._id);

    if (!isInitiator && !isCandidate) {
      return res.status(403).json({ message: 'Not authorized to view this room' });
    }

    res.json({
      success: true,
      room: callRoom
    });
  } catch (error) {
    console.error('Get room by public id error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Candidate requests to join a room
router.post('/:roomId([0-9a-fA-F]{24})/request-join', verifyToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user._id);
    const role = user?.role?.toLowerCase();
    if (!user || role !== 'candidate') {
      return res.status(403).json({ message: 'Only candidates can request to join' });
    }

    const callRoom = await CallRoom.findById(req.params.roomId);
    if (!callRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (callRoom.status !== 'waiting_confirmation') {
      return res.status(400).json({ message: 'Room is not available for joining' });
    }

    if (callRoom.candidate) {
      return res.status(400).json({ message: 'Someone already requested to join this room' });
    }

    callRoom.candidate = req.user._id;
    callRoom.candidateJoinRequestedAt = new Date();
    await callRoom.save();
    await callRoom.populate('candidate', 'email firstName lastName');

    res.json({
      success: true,
      message: 'Join request sent',
      room: callRoom
    });
  } catch (error) {
    console.error('Request join error:', error);
    res.status(500).json({ message: error.message });
  }
});

// RH confirms candidate join
router.post('/:roomId([0-9a-fA-F]{24})/confirm-join', verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId);
    if (!callRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!callRoom.initiator.equals(req.user._id)) {
      return res.status(403).json({ message: 'Only room initiator can confirm' });
    }

    if (!callRoom.candidate) {
      return res.status(400).json({ message: 'No candidate has requested to join' });
    }

    callRoom.status = 'active';
    callRoom.candidateJoinConfirmedAt = new Date();
    callRoom.recordingStartedAt = new Date();
    await callRoom.save();
    await callRoom.populate('candidate', 'email firstName lastName');

    res.json({
      success: true,
      message: 'Candidate confirmed, recording started',
      room: callRoom
    });
  } catch (error) {
    console.error('Confirm join error:', error);
    res.status(500).json({ message: error.message });
  }
});

// RH rejects candidate join
router.post('/:roomId([0-9a-fA-F]{24})/reject-join', verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId);
    if (!callRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!callRoom.initiator.equals(req.user._id)) {
      return res.status(403).json({ message: 'Only room initiator can reject' });
    }

    callRoom.candidate = null;
    callRoom.candidateJoinRequestedAt = null;
    callRoom.status = 'waiting_confirmation';
    await callRoom.save();

    res.json({
      success: true,
      message: 'Candidate rejected',
      room: callRoom
    });
  } catch (error) {
    console.error('Reject join error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get room details (both RH and candidate)
router.get('/rh/my-rooms', verifyToken, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user._id);
    const role = user?.role?.toLowerCase();
    if (!user || (role !== 'rh' && role !== 'enterprise')) {
      return res.status(403).json({ message: 'Only RH/Enterprise users can access this' });
    }

    const myRooms = await CallRoom.find({ 
      initiator: req.user._id
    })
    .populate('candidate', 'email firstName lastName')
    .populate('job', 'title company')
    .sort({ createdAt: -1 });

    res.json({
      success: true,
      rooms: myRooms
    });
  } catch (error) {
    console.error('Get RH rooms error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Delete room from RH dashboard
router.delete('/:roomId([0-9a-fA-F]{24})', verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId);
    if (!callRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    if (!callRoom.initiator.equals(req.user._id)) {
      return res.status(403).json({ message: 'Only room initiator can delete this room' });
    }

    const deletedRoom = {
      _id: callRoom._id,
      roomId: callRoom.roomId,
      status: callRoom.status,
    };

    await callRoom.deleteOne();

    res.json({
      success: true,
      message: 'Room deleted successfully',
      room: deletedRoom,
    });
  } catch (error) {
    console.error('Delete room error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Get room details (both RH and candidate)
router.get('/:roomId([0-9a-fA-F]{24})', verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId)
      .populate('initiator', 'email firstName lastName')
      .populate('candidate', 'email firstName lastName')
      .populate('job', 'title company');

    if (!callRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    // Check authorization
    const isInitiator = callRoom.initiator._id.equals(req.user._id);
    const isCandidate = callRoom.candidate && callRoom.candidate._id.equals(req.user._id);

    if (!isInitiator && !isCandidate) {
      return res.status(403).json({ message: 'Not authorized to view this room' });
    }

    res.json({
      success: true,
      room: callRoom
    });
  } catch (error) {
    console.error('Get room error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Update room with transcription data
router.post('/:roomId([0-9a-fA-F]{24})/update-transcription', verifyToken, async (req, res) => {
  try {
    const { text, segments, overallSentiment, segment, sentiment } = req.body;
    const callRoom = await CallRoom.findById(req.params.roomId);

    if (!callRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const isInitiator = callRoom.initiator.equals(req.user._id);
    const isCandidate = callRoom.candidate && callRoom.candidate.equals(req.user._id);
    if (!isInitiator && !isCandidate) {
      return res.status(403).json({ message: 'Only room participants can update transcription' });
    }

    if (text) callRoom.transcription.text = text;
    if (segments) callRoom.transcription.segments = segments;
    if (overallSentiment) callRoom.transcription.overallSentiment = overallSentiment;

    if (segment?.text) {
      const normalizedSegment = {
        text: segment.text,
        timestamp: segment.timestamp ? new Date(segment.timestamp) : new Date(),
        sentiment: sentiment || segment.sentiment || { label: 'NEUTRAL', score: 0 },
      };
      callRoom.transcription.segments.push(normalizedSegment);
      callRoom.transcription.text = `${callRoom.transcription.text || ''} ${segment.text}`.trim();
      if (sentiment) {
        callRoom.transcription.overallSentiment = sentiment;
      }
    }

    await callRoom.save();

    res.json({
      success: true,
      message: 'Transcription updated',
      room: callRoom
    });
  } catch (error) {
    console.error('Update transcription error:', error);
    res.status(500).json({ message: error.message });
  }
});

// End call
router.post('/:roomId([0-9a-fA-F]{24})/end-call', verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId);
    if (!callRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const isInitiator = callRoom.initiator.equals(req.user._id);
    const isCandidate = callRoom.candidate && callRoom.candidate.equals(req.user._id);
    if (!isInitiator && !isCandidate) {
      return res.status(403).json({ message: 'Only room participants can end call' });
    }

    callRoom.status = 'ended';
    callRoom.recordingEndedAt = new Date();
    await callRoom.save();

    res.json({
      success: true,
      message: 'Call ended',
      room: callRoom
    });
  } catch (error) {
    console.error('End call error:', error);
    res.status(500).json({ message: error.message });
  }
});

// Upload audio recording for a call room
router.post('/:roomId([0-9a-fA-F]{24})/upload-audio', verifyToken, uploadRecordingMiddleware.single('audio'), async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId);
    if (!callRoom) return res.status(404).json({ message: 'Room not found' });

    const isInitiator = callRoom.initiator.equals(req.user._id);
    const isCandidate = callRoom.candidate && callRoom.candidate.equals(req.user._id);
    if (!isInitiator && !isCandidate) {
      return res.status(403).json({ message: 'Not authorized to upload audio for this room' });
    }

    if (!req.file) return res.status(400).json({ message: 'No audio file provided' });

    callRoom.recordingUrl = `/uploads/recordings/${req.file.filename}`;
    await callRoom.save();

    res.json({ success: true, recordingUrl: callRoom.recordingUrl });
  } catch (error) {
    console.error('Upload audio error:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
