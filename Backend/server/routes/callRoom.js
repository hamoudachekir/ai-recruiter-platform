const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const CallRoom = require('../models/CallRoom');
const { verifyToken } = require('../middleware/auth');
const { UserModel } = require('../models/user');
const interviewAgent = require('../services/interviewAgentService');
const { generateIntegrityReport } = require('../services/integrityReportService');
const { buildRecruiterReport, buildMockRecruiterReport } = require('../services/recruiterReportService');

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

const VISION_EVENT_TYPES = new Set([
  'CAMERA_UNAVAILABLE',
  'NO_FACE_DETECTED',
  'MULTIPLE_FACES_DETECTED',
  'FACE_NOT_CENTERED',
  'BAD_FACE_DISTANCE',
  'POOR_LIGHTING',
  'LOOKING_AWAY_LONG',
  'CAMERA_BLOCKED',
  'TAB_SWITCH',
  'FULLSCREEN_EXIT',
  'COPY_PASTE',
  // YOLO vision events
  'MULTIPLE_PEOPLE',
  'NO_PERSON_VISIBLE',
  'PHONE_VISIBLE',
  'REFERENCE_MATERIAL_VISIBLE',
  'SCREEN_DEVICE_VISIBLE',
]);

const toDurationLabel = (durationMs) => {
  const seconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  return `${seconds} second${seconds === 1 ? '' : 's'}`;
};

const buildVisionReport = (room) => {
  const vision = room.visionMonitoring || {};
  const summary = vision.summary || {};
  const events = Array.isArray(vision.events) ? vision.events : [];
  const yoloSummary = vision.yoloSummary || {};
  
  // Also check integrityEvents for YOLO events
  const integrityEvents = Array.isArray(room.integrityEvents) ? room.integrityEvents : [];
  const allYoloEvents = integrityEvents.filter((e) => e.source === 'yolov8');

  const faceVisibilityRateValue = summary.totalChecks > 0
    ? Math.round((Number(summary.faceDetectedChecks || 0) / Number(summary.totalChecks || 1)) * 100)
    : 0;

  const absenceEvents = events.filter((e) => e.type === 'NO_FACE_DETECTED');
  const lightingIssues = events.filter((e) => e.type === 'POOR_LIGHTING');
  const positionIssues = events.filter((e) => e.type === 'FACE_NOT_CENTERED' || e.type === 'BAD_FACE_DISTANCE');
  const multipleFacesEvents = events.filter((e) => e.type === 'MULTIPLE_FACES_DETECTED');
  const lookingAwayEvents = events.filter((e) => e.type === 'LOOKING_AWAY_LONG');
  const cameraBlockedEvents = events.filter((e) => e.type === 'CAMERA_BLOCKED');
  const tabSwitchEvents = events.filter((e) => e.type === 'TAB_SWITCH');
  const fullscreenExitEvents = events.filter((e) => e.type === 'FULLSCREEN_EXIT');
  
  // YOLO events from integrityEvents
  const phoneDetections = allYoloEvents.filter((e) => e.type === 'PHONE_VISIBLE');
  const referenceMaterialDetections = allYoloEvents.filter((e) => e.type === 'REFERENCE_MATERIAL_VISIBLE');
  const screenDetections = allYoloEvents.filter((e) => e.type === 'SCREEN_DEVICE_VISIBLE');
  const multiplePeopleDetections = allYoloEvents.filter((e) => e.type === 'MULTIPLE_PEOPLE');
  const noPersonDetections = allYoloEvents.filter((e) => e.type === 'NO_PERSON_VISIBLE');

  let riskScore = 0;
  riskScore += absenceEvents.length * 15;
  riskScore += multipleFacesEvents.length * 25;
  riskScore += lookingAwayEvents.length * 10;
  riskScore += cameraBlockedEvents.length * 20;
  riskScore += tabSwitchEvents.length * 10;
  riskScore += fullscreenExitEvents.length * 10;
  riskScore += lightingIssues.length * 5;
  // YOLO event weights
  riskScore += phoneDetections.length * 15;
  riskScore += referenceMaterialDetections.length * 8;
  riskScore += screenDetections.length * 15;
  riskScore += multiplePeopleDetections.length * 25;
  riskScore += noPersonDetections.length * 12;
  riskScore = Math.min(100, riskScore);

  let riskLevel = 'Low';
  if (riskScore >= 66) riskLevel = 'High';
  else if (riskScore >= 31) riskLevel = 'Medium';

  let explanationParts = [];
  if (absenceEvents.length > 0) explanationParts.push(`${absenceEvents.length} face absence events.`);
  if (multipleFacesEvents.length > 0) explanationParts.push(`${multipleFacesEvents.length} multiple-people events.`);
  if (lookingAwayEvents.length > 0) explanationParts.push(`${lookingAwayEvents.length} looking-away events.`);
  if (cameraBlockedEvents.length > 0) explanationParts.push(`${cameraBlockedEvents.length} camera blocked events.`);
  if (tabSwitchEvents.length > 0) explanationParts.push(`Browser lost focus ${tabSwitchEvents.length} times.`);
  if (fullscreenExitEvents.length > 0) explanationParts.push(`Exited fullscreen ${fullscreenExitEvents.length} times.`);
  // YOLO explanation parts
  if (phoneDetections.length > 0) explanationParts.push(`${phoneDetections.length} phone detection(s).`);
  if (referenceMaterialDetections.length > 0) explanationParts.push(`${referenceMaterialDetections.length} reference material detection(s).`);
  if (screenDetections.length > 0) explanationParts.push(`${screenDetections.length} extra screen detection(s).`);

  const riskExplanation = explanationParts.length > 0
    ? `Risk detected due to: ${explanationParts.join(' ')}`
    : 'No significant integrity risks detected.';

  let cameraQuality = 'Good';
  if (faceVisibilityRateValue < 70 || multipleFacesEvents.length > 0 || absenceEvents.length >= 4) {
    cameraQuality = 'Needs Review';
  } else if (faceVisibilityRateValue < 85 || lightingIssues.length >= 3 || positionIssues.length >= 5) {
    cameraQuality = 'Acceptable';
  }
  
  // YOLO object detection quality
  const yoloEnabled = yoloSummary.totalFramesProcessed > 0;
  const yoloStatus = yoloEnabled 
    ? `YOLO analyzed ${yoloSummary.totalFramesProcessed} frame(s)` 
    : 'Object detection unavailable';

  return {
    generatedAt: new Date(),
    cameraQuality,
    faceVisibilityRate: `${faceVisibilityRateValue}%`,
    multipleFacesDetected: multipleFacesEvents.length > 0 || multiplePeopleDetections.length > 0,
    absenceEvents: absenceEvents.length + noPersonDetections.length,
    lightingIssues: lightingIssues.length,
    positionIssues: positionIssues.length,
    yoloEnabled,
    yoloStatus,
    yoloSummary,
    suspiciousEvents: events
      .filter((e) => ['NO_FACE_DETECTED', 'MULTIPLE_FACES_DETECTED', 'LOOKING_AWAY_LONG', 'TAB_SWITCH', 'CAMERA_BLOCKED', 'FULLSCREEN_EXIT'].includes(e.type))
      .slice(-10)
      .map((e) => ({
        type: e.type,
        duration: toDurationLabel(e.durationMs),
        questionId: e.questionId || '',
      })),
    recommendation: riskLevel === 'High' || cameraQuality === 'Needs Review'
      ? 'Review flagged moments manually. Do not make automatic rejection decisions.'
      : 'Interview session appears normal. Standard review applies.',
    integrityRisk: {
      level: riskLevel,
      score: riskScore,
      explanation: riskExplanation,
    }
  };
};

const finalizeAgentSessionSnapshot = async (callRoomId) => {
  try {
    const interviewId = String(callRoomId || '');
    if (!interviewId) return;

    const snapshot = await interviewAgent.endSession({ interviewId });
    await CallRoom.findByIdAndUpdate(interviewId, {
      $set: { agentSnapshot: snapshot },
    });
  } catch (error) {
    // Ending the room must not fail just because the Python agent service is
    // unavailable. The socket path may also finalize the session; this is a
    // server-side safety net for candidate leave/end-call navigation.
    console.warn('Agent session finalize skipped:', error?.message || error);
  }
};

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
      .populate('initiator', 'email name firstName lastName role domain enterprise profile')
      .populate('candidate', 'email firstName lastName')
      .populate('job', 'title description skills languages location');

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

// Save candidate webcam quality/integrity metadata (no raw video).
router.post('/:roomId([0-9a-fA-F]{24})/vision-monitoring', verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId);
    if (!callRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const isInitiator = callRoom.initiator.equals(req.user._id);
    const isCandidate = callRoom.candidate && callRoom.candidate.equals(req.user._id);
    if (!isInitiator && !isCandidate) {
      return res.status(403).json({ message: 'Only room participants can update vision monitoring' });
    }

    const {
      precheck,
      event,
      summaryDelta,
      currentQuestionId,
    } = req.body || {};

    if (!callRoom.visionMonitoring) {
      callRoom.visionMonitoring = {};
    }
    if (!callRoom.visionMonitoring.summary) {
      callRoom.visionMonitoring.summary = {};
    }
    if (!Array.isArray(callRoom.visionMonitoring.events)) {
      callRoom.visionMonitoring.events = [];
    }

    if (precheck) {
      callRoom.visionMonitoring.precheck = {
        cameraAvailable: precheck.cameraAvailable ?? callRoom.visionMonitoring.precheck?.cameraAvailable ?? null,
        faceDetected: precheck.faceDetected ?? callRoom.visionMonitoring.precheck?.faceDetected ?? null,
        faceCentered: precheck.faceCentered ?? callRoom.visionMonitoring.precheck?.faceCentered ?? null,
        lightingOk: precheck.lightingOk ?? callRoom.visionMonitoring.precheck?.lightingOk ?? null,
        multipleFacesDetected: precheck.multipleFacesDetected ?? callRoom.visionMonitoring.precheck?.multipleFacesDetected ?? false,
        checkedAt: new Date(),
      };
    }

    if (summaryDelta) {
      const summary = callRoom.visionMonitoring.summary;
      summary.totalChecks = Number(summary.totalChecks || 0) + Number(summaryDelta.totalChecks || 0);
      summary.faceDetectedChecks = Number(summary.faceDetectedChecks || 0) + Number(summaryDelta.faceDetectedChecks || 0);
      summary.noFaceChecks = Number(summary.noFaceChecks || 0) + Number(summaryDelta.noFaceChecks || 0);
      summary.multipleFacesChecks = Number(summary.multipleFacesChecks || 0) + Number(summaryDelta.multipleFacesChecks || 0);
      summary.lightingIssueChecks = Number(summary.lightingIssueChecks || 0) + Number(summaryDelta.lightingIssueChecks || 0);
      summary.positionIssueChecks = Number(summary.positionIssueChecks || 0) + Number(summaryDelta.positionIssueChecks || 0);
      summary.distanceIssueChecks = Number(summary.distanceIssueChecks || 0) + Number(summaryDelta.distanceIssueChecks || 0);
      summary.lastUpdatedAt = new Date();
    }

    if (event) {
      if (!VISION_EVENT_TYPES.has(event.type)) {
        return res.status(400).json({ message: `Unsupported vision event type: ${event.type}` });
      }
      callRoom.visionMonitoring.events.push({
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
        type: event.type,
        severity: event.severity || 'info',
        message: event.message || '',
        questionId: event.questionId || currentQuestionId || '',
        durationMs: Number(event.durationMs || 0),
        meta: {
          brightness: Number(event.meta?.brightness ?? event.brightness ?? 0) || undefined,
          faceCount: Number(event.meta?.faceCount ?? event.faceCount ?? 0) || undefined,
          faceRatio: Number(event.meta?.faceRatio ?? event.faceRatio ?? 0) || undefined,
          centerOffsetX: Number(event.meta?.centerOffsetX ?? 0) || undefined,
          centerOffsetY: Number(event.meta?.centerOffsetY ?? 0) || undefined,
        },
      });
    }

    await callRoom.save();

    res.json({
      success: true,
      message: 'Vision monitoring updated',
      visionMonitoring: callRoom.visionMonitoring,
    });
  } catch (error) {
    console.error('Vision monitoring update error:', error);
    res.status(500).json({ message: error.message });
  }
});

router.post('/:roomId([0-9a-fA-F]{24})/vision-report/finalize', verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId);
    if (!callRoom) {
      return res.status(404).json({ message: 'Room not found' });
    }

    const isInitiator = callRoom.initiator.equals(req.user._id);
    const isCandidate = callRoom.candidate && callRoom.candidate.equals(req.user._id);
    if (!isInitiator && !isCandidate) {
      return res.status(403).json({ message: 'Only room participants can finalize the vision report' });
    }

    callRoom.visionMonitoring = callRoom.visionMonitoring || {};
    callRoom.visionMonitoring.report = buildVisionReport(callRoom);
    callRoom.integrityReport = await generateIntegrityReport({
      room: callRoom,
      events: callRoom.integrityEvents || [],
    });
    await callRoom.save();
    void finalizeAgentSessionSnapshot(callRoom._id);

    res.json({
      success: true,
      report: callRoom.visionMonitoring.report,
      integrityReport: callRoom.integrityReport,
    });
  } catch (error) {
    console.error('Finalize vision report error:', error);
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
    callRoom.visionMonitoring = callRoom.visionMonitoring || {};
    callRoom.visionMonitoring.report = buildVisionReport(callRoom);
    callRoom.integrityReport = await generateIntegrityReport({
      room: callRoom,
      events: callRoom.integrityEvents || [],
    });
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

// ── Recruiter Report ──────────────────────────────────────────────────────────

/**
 * GET /api/call-rooms/:roomId/report
 * Returns the stored recruiterReport (or a mock if not yet generated).
 * Only the room initiator (RH) can access this.
 */
router.get('/:roomId([0-9a-fA-F]{24})/report', verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId)
      .populate('candidate', 'email firstName lastName')
      .populate('initiator', 'email firstName lastName')
      .populate('job', 'title skills');

    if (!callRoom) return res.status(404).json({ message: 'Room not found' });

    // Only initiator (RH) may read the report
    if (!callRoom.initiator._id.equals(req.user._id)) {
      return res.status(403).json({ message: 'Only the recruiter can access this report' });
    }

    if (callRoom.recruiterReport) {
      return res.json({ success: true, report: callRoom.recruiterReport, source: 'stored' });
    }

    // Auto-build on first access if the interview has ended
    if (callRoom.status === 'ended') {
      try {
        const report = buildRecruiterReport(callRoom);
        callRoom.recruiterReport = report;
        await callRoom.save();
        return res.json({ success: true, report, source: 'generated' });
      } catch (buildError) {
        console.warn('Report build failed, returning mock:', buildError.message);
        return res.json({ success: true, report: buildMockRecruiterReport(), source: 'mock' });
      }
    }

    // Interview not ended yet
    return res.json({ success: true, report: null, source: 'not_ready' });
  } catch (error) {
    console.error('GET report error:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * POST /api/call-rooms/:roomId/generate-report
 * (Re-)generates and stores the full recruiter report.
 * Only the initiator (RH) may trigger this.
 */
router.post('/:roomId([0-9a-fA-F]{24})/generate-report', verifyToken, async (req, res) => {
  try {
    const callRoom = await CallRoom.findById(req.params.roomId)
      .populate('candidate', 'email firstName lastName')
      .populate('initiator', 'email firstName lastName')
      .populate('job', 'title skills');

    if (!callRoom) return res.status(404).json({ message: 'Room not found' });

    if (!callRoom.initiator._id.equals(req.user._id)) {
      return res.status(403).json({ message: 'Only the recruiter can generate a report' });
    }

    let report;
    let source = 'generated';
    try {
      report = buildRecruiterReport(callRoom);
    } catch (buildError) {
      console.warn('Report build failed, using mock:', buildError.message);
      report = buildMockRecruiterReport();
      source = 'mock';
    }

    callRoom.recruiterReport = report;
    await callRoom.save();

    res.json({ success: true, report, source });
  } catch (error) {
    console.error('Generate report error:', error);
    res.status(500).json({ message: error.message });
  }
});

/**
 * PATCH /api/call-rooms/:roomId/recruiter-decision
 * Saves the recruiter's final decision (accept / reject / needs_review).
 * Body: { status: 'accepted'|'rejected'|'needs_review', notes?: string }
 */
router.patch('/:roomId([0-9a-fA-F]{24})/recruiter-decision', verifyToken, async (req, res) => {
  try {
    const { status, notes } = req.body || {};
    const allowedStatuses = ['accepted', 'rejected', 'needs_review'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        message: `status must be one of: ${allowedStatuses.join(', ')}`,
      });
    }

    const callRoom = await CallRoom.findById(req.params.roomId)
      .populate('initiator', 'email firstName lastName');

    if (!callRoom) return res.status(404).json({ message: 'Room not found' });

    if (!callRoom.initiator._id.equals(req.user._id)) {
      return res.status(403).json({ message: 'Only the recruiter can submit a decision' });
    }

    const decision = {
      status,
      notes: String(notes || ''),
      decidedAt: new Date().toISOString(),
    };

    // Patch the decision inside the stored report if present
    if (callRoom.recruiterReport) {
      callRoom.recruiterReport = {
        ...callRoom.recruiterReport,
        recruiterDecision: decision,
      };
    }

    // Also store at room level for quick lookups
    callRoom.rhDecision = decision;
    callRoom.markModified('recruiterReport');
    await callRoom.save();

    res.json({ success: true, decision });
  } catch (error) {
    console.error('Recruiter decision error:', error);
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
