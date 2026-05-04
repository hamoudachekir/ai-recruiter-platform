const express = require('express');
const router = express.Router();
const { UserModel } = require('../models/user');
const JobModel = require('../models/job');
const Interview = require('../models/interview');
const CallRoom = require('../models/CallRoom');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { analyzeSnapshot } = require('../services/visionLLMService');
const { generateIntegrityReport, buildMockIntegrityReport } = require('../services/integrityReportService');
const yoloVisionService = require('../services/yoloVisionService');
// Configure email transporter
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE || 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  }
});

const ANALYSIS_SERVICE_URL = process.env.ANALYSIS_SERVICE_URL || 'http://127.0.0.1:8090';
const interviewVideoDir = path.join(__dirname, '../uploads/interviews');
if (!fs.existsSync(interviewVideoDir)) {
  fs.mkdirSync(interviewVideoDir, { recursive: true });
}

const integritySnapshotDir = path.join(__dirname, '../uploads/integrity-snapshots');
if (!fs.existsSync(integritySnapshotDir)) {
  fs.mkdirSync(integritySnapshotDir, { recursive: true });
}

const INTEGRITY_EVENT_TYPE_MAP = {
  NO_FACE: 'NO_FACE_DETECTED',
  MULTIPLE_PEOPLE: 'MULTIPLE_FACES_DETECTED',
  BAD_LIGHTING: 'POOR_LIGHTING',
  FACE_TOO_FAR: 'BAD_FACE_DISTANCE',
  LOOKING_AWAY_LONG: 'LOOKING_AWAY_LONG',
  CAMERA_BLOCKED: 'CAMERA_BLOCKED',
  TAB_SWITCH: 'TAB_SWITCH',
  FULLSCREEN_EXIT: 'FULLSCREEN_EXIT',
  COPY_PASTE: 'COPY_PASTE',
};

const SEVERITY_TO_LEGACY = {
  low: 'info',
  medium: 'warning',
  high: 'critical',
};

const resolveCallRoom = async (id) => {
  if (!id) return null;
  if (mongoose.isValidObjectId(id)) {
    const byId = await CallRoom.findById(id)
      .populate('candidate', 'email firstName lastName name')
      .populate('initiator', 'email firstName lastName name enterprise domain')
      .populate('job', 'title description skills');
    if (byId) return byId;
  }
  return CallRoom.findOne({ roomId: id })
    .populate('candidate', 'email firstName lastName name')
    .populate('initiator', 'email firstName lastName name enterprise domain')
    .populate('job', 'title description skills');
};

const normalizeSeverity = (value) => {
  const severity = String(value || '').trim().toLowerCase();
  if (severity === 'high' || severity === 'medium' || severity === 'low') return severity;
  return 'low';
};

const saveSnapshotBase64 = (interviewId, snapshotBase64) => {
  const raw = String(snapshotBase64 || '').trim();
  if (!raw) return null;

  const match = raw.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
  const mime = match?.[1] || 'image/jpeg';
  const base64 = match?.[2] || raw;
  if (!base64 || base64.length > 6 * 1024 * 1024) return null;

  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const safeId = String(interviewId).replace(/[^a-zA-Z0-9_-]/g, '');
  const targetDir = path.join(integritySnapshotDir, safeId);
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  const fileName = `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(targetDir, fileName), Buffer.from(base64, 'base64'));
  return `/uploads/integrity-snapshots/${safeId}/${fileName}`;
};

const readSnapshotAsDataUrl = (snapshotUrl) => {
  const relative = String(snapshotUrl || '').replace(/^\/uploads\//, '');
  if (!relative || relative.includes('..')) return '';
  const filePath = path.join(__dirname, '../uploads', relative);
  if (!fs.existsSync(filePath)) return '';
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
};

const interviewVideoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const targetDir = path.join(interviewVideoDir, req.params.interviewId, 'raw');
    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
    cb(null, targetDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4';
    cb(null, `interview_video${ext}`);
  },
});
const interviewVideoUpload = multer({
  storage: interviewVideoStorage,
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1GB
});

// Generate meeting link with custom format
const generateMeetingLink = (interviewId) => {
  return `${process.env.FRONTEND_URL || 'http://localhost:5173'}/interview/${interviewId}`;
};

// Send interview confirmation email
const sendInterviewEmail = async (interviewData) => {
  try {
    const { candidateEmail, candidateName, enterpriseName, jobTitle, date, meeting } = interviewData;

    const formattedDate = new Date(date).toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });

    const mailOptions = {
      from: `"${enterpriseName} Hiring Team" <${process.env.EMAIL_USER}>`,
      to: candidateEmail,
      subject: `Interview Scheduled: ${jobTitle} at ${enterpriseName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
          <div style="background-color: #2563eb; padding: 20px; text-align: center;">
            <h1 style="color: white; margin: 0;">Interview Scheduled</h1>
          </div>
          
          <div style="padding: 20px;">
            <p>Dear ${candidateName},</p>
            
            <p>Thank you for your application! We're pleased to invite you to interview for the <strong>${jobTitle}</strong> position at ${enterpriseName}.</p>
            
            <div style="background: #f8fafc; border-left: 4px solid #2563eb; padding: 15px; margin: 20px 0;">
              <h3 style="margin-top: 0; color: #2563eb;">Interview Details</h3>
              
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; width: 120px; font-weight: bold;">Date & Time:</td>
                  <td style="padding: 8px 0;">${formattedDate}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Interview Type:</td>
                  <td style="padding: 8px 0; text-transform: capitalize;">${meeting.type}</td>
                </tr>
                ${meeting.type === 'Virtual' ? `
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Meeting Link:</td>
                  <td style="padding: 8px 0;">
                    <a href="${meeting.link}" style="color: #2563eb; text-decoration: none;">
                      ${meeting.link}
                    </a>
                  </td>
                </tr>
                ` : `
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Location:</td>
                  <td style="padding: 8px 0;">${meeting.link}</td>
                </tr>
                `}
                ${meeting.details ? `
                <tr>
                  <td style="padding: 8px 0; font-weight: bold; vertical-align: top;">Notes:</td>
                  <td style="padding: 8px 0;">${meeting.details}</td>
                </tr>
                ` : ''}
              </table>
            </div>

            <div style="margin: 20px 0;">
              <h4 style="margin-bottom: 10px;">What to Expect:</h4>
              <ul style="padding-left: 20px; margin-top: 0;">
                <li>Duration: Approximately 45-60 minutes</li>
                <li>Format: ${meeting.type === 'Virtual' ? 'Video call' : 'In-person meeting'}</li>
                <li>Participants: Hiring manager and team members</li>
              </ul>
            </div>

            <div style="margin: 20px 0;">
              <h4 style="margin-bottom: 10px;">How to Prepare:</h4>
              <ul style="padding-left: 20px; margin-top: 0;">
                <li>Review the job description</li>
                <li>Prepare examples of your relevant experience</li>
                ${meeting.type === 'Virtual' ? `
                <li>Test your audio/video setup beforehand</li>
                <li>Find a quiet, well-lit space</li>
                ` : `
                <li>Plan to arrive 10 minutes early</li>
                <li>Bring copies of your resume</li>
                `}
              </ul>
            </div>

            <p>If you need to reschedule or have any questions, please reply to this email.</p>

            <p style="margin-top: 30px;">We look forward to speaking with you!</p>
            
            <p>Best regards,<br/>
            <strong>The ${enterpriseName} Hiring Team</strong></p>
          </div>
          
          <div style="background-color: #f3f4f6; padding: 15px; text-align: center; font-size: 12px; color: #6b7280;">
            <p>This is an automated message. Please do not reply directly to this email.</p>
          </div>
        </div>
      `,
      text: `Dear ${candidateName},\n\n` +
        `We're pleased to invite you to interview for the ${jobTitle} position at ${enterpriseName}.\n\n` +
        `Interview Details:\n` +
        `Date & Time: ${formattedDate}\n` +
        `Type: ${meeting.type}\n` +
        `${meeting.type === 'Virtual' ? `Meeting Link: ${meeting.link}\n` : `Location: ${meeting.link}\n`}` +
        `${meeting.details ? `Notes: ${meeting.details}\n` : ''}\n` +
        `What to Expect:\n` +
        `- Duration: Approximately 45-60 minutes\n` +
        `- Format: ${meeting.type === 'Virtual' ? 'Video call' : 'In-person meeting'}\n` +
        `- Participants: Hiring manager and team members\n\n` +
        `How to Prepare:\n` +
        `- Review the job description\n` +
        `- Prepare examples of your relevant experience\n` +
        `${meeting.type === 'Virtual' ? 
          `- Test your audio/video setup beforehand\n` + 
          `- Find a quiet, well-lit space\n` : 
          `- Plan to arrive 10 minutes early\n` + 
          `- Bring copies of your resume\n`}\n\n` +
        `If you need to reschedule or have any questions, please reply to this email.\n\n` +
        `We look forward to speaking with you!\n\n` +
        `Best regards,\n` +
        `The ${enterpriseName} Hiring Team`
    };

    await transporter.sendMail(mailOptions);
    console.log('Interview confirmation email sent to:', candidateEmail);
  } catch (error) {
    console.error('Error sending interview email:', error);
  }
};

// Schedule a new interview
router.post('/', async (req, res) => {
  try {
    const { jobId, enterpriseId, candidateId, date, meeting } = req.body;

    // Validate IDs
    if (!mongoose.Types.ObjectId.isValid(jobId) || 
        !mongoose.Types.ObjectId.isValid(enterpriseId) || 
        !mongoose.Types.ObjectId.isValid(candidateId)) {
      return res.status(400).json({ message: "Invalid IDs provided" });
    }

    // Get prediction from ML model
    const prediction = await axios.post('http://localhost:3001/Frontend/predict-score', {
      jobId,
      candidateId
    });

    // Find the job, enterprise and candidate
    const [job, enterprise, candidate] = await Promise.all([
      JobModel.findById(jobId),
      UserModel.findById(enterpriseId),
      UserModel.findById(candidateId)
    ]);

    if (!job) {
      return res.status(404).json({ message: "Job not found" });
    }
    if (!enterprise || !enterprise.enterprise) {
      return res.status(404).json({ message: "Enterprise not found" });
    }
    if (!candidate) {
      return res.status(404).json({ message: "Candidate not found" });
    }

    const interviewId = new mongoose.Types.ObjectId();
    
    const meetingData = {
      type: meeting.type,
      details: meeting.notes || '',
      link: meeting.type === 'Virtual' 
        ? (meeting.link || generateMeetingLink(interviewId))
        : enterprise.enterprise.location || 'Office Location'
    };

    const newInterview = {
      _id: interviewId,
      jobId: job._id,
      enterpriseId: enterprise._id,
      candidateId: candidate._id,
      date: new Date(date),
      status: 'Scheduled',
      meeting: meetingData,
      evaluation: {
        predictedScore: prediction.data.predictedScore
      },
      mlFeatures: prediction.data.features,
      createdAt: new Date()
    };

    // Save interview to the database
    await new Interview(newInterview).save();

    // Add interview to both enterprise and candidate
    await Promise.all([ 
      UserModel.findByIdAndUpdate(enterpriseId, {
        $push: { 
          interviews: newInterview
        }
      }),
      UserModel.findByIdAndUpdate(candidateId, {
        $push: { 
          interviews: newInterview
        }
      })
    ]);

    // Send email in background
    sendInterviewEmail({
      candidateEmail: candidate.email,
      candidateName: candidate.name,
      enterpriseName: enterprise.enterprise.name,
      jobTitle: job.title,
      date: newInterview.date,
      meeting: meetingData
    });

    res.status(201).json({
      ...newInterview,
      meeting: {
        ...meetingData,
        link: meetingData.link || generateMeetingLink(interviewId)
      }
    });
  } catch (error) {
    console.error('Error scheduling interview:', error);
    res.status(500).json({ message: 'Server error' });
  }
});
router.get('/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const enterpriseId = req.query.enterpriseId;

    if (!mongoose.Types.ObjectId.isValid(jobId) || !mongoose.Types.ObjectId.isValid(enterpriseId)) {
      return res.status(400).json({ message: "Invalid IDs provided" });
    }

    const enterprise = await UserModel.findById(enterpriseId)
      .select('interviews')
      .populate({
        path: 'interviews.candidateId',
        select: 'name email picture profile'
      })
      .populate('interviews.jobId', 'title');

    if (!enterprise) {
      return res.status(404).json({ message: "Enterprise not found" });
    }

    const jobInterviews = enterprise.interviews
      .filter(interview => interview.jobId && interview.jobId._id.toString() === jobId)
      .map(interview => ({
        _id: interview._id,
        jobId: interview.jobId._id,
        jobTitle: interview.jobId.title,
        candidateId: interview.candidateId,
        date: interview.date,
        status: interview.status,
        meeting: interview.meeting,
        createdAt: interview.createdAt
      }));

    res.json(jobInterviews);
  } catch (error) {
    console.error('Error fetching job interviews:', error);
    res.status(500).json({ message: 'Server error' });
  }
});
router.put('/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { enterpriseId, candidateId, status } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id) || 
        !mongoose.Types.ObjectId.isValid(enterpriseId) || 
        !mongoose.Types.ObjectId.isValid(candidateId)) {
      return res.status(400).json({ message: "Invalid IDs provided" });
    }

    // Validate status
    const validStatuses = ['Scheduled', 'Completed', 'Cancelled', 'Rescheduled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    // Update in both enterprise's and candidate's records
    await Promise.all([
      UserModel.updateOne(
        { 
          _id: enterpriseId,
          'interviews._id': new mongoose.Types.ObjectId(id) 
        },
        { 
          $set: { 
            'interviews.$.status': status,
            'interviews.$.updatedAt': new Date()
          } 
        }
      ),
      UserModel.updateOne(
        { 
          _id: candidateId,
          'interviews._id': new mongoose.Types.ObjectId(id) 
        },
        { 
          $set: { 
            'interviews.$.status': status,
            'interviews.$.updatedAt': new Date()
          } 
        }
      )
    ]);

    res.json({ message: "Interview status updated successfully" });
  } catch (error) {
    console.error('Error updating interview status:', error);
    res.status(500).json({ message: 'Server error' });
  }
});
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid interview ID" });
    }

    // Find users who have this interview
    const [enterprise, candidate] = await Promise.all([
      UserModel.findOne({ 'interviews._id': id })
        .select('interviews enterprise')
        .populate('interviews.jobId', 'title'),
      UserModel.findOne({ 'interviews.candidateId': id })
        .select('name email picture profile')
    ]);

    if (!enterprise || !candidate) {
      return res.status(404).json({ message: "Interview not found" });
    }

    const interview = enterprise.interviews.find(i => i._id.toString() === id);

    if (!interview) {
      return res.status(404).json({ message: "Interview not found" });
    }

    const response = {
      _id: interview._id,
      jobId: interview.jobId,
      jobTitle: interview.jobId?.title || 'No title',
      enterprise: enterprise.enterprise,
      candidate: {
        _id: candidate._id,
        name: candidate.name,
        email: candidate.email,
        picture: candidate.picture,
        profile: candidate.profile
      },
      date: interview.date,
      status: interview.status,
      meeting: interview.meeting,
      createdAt: interview.createdAt
    };

    res.json(response);
  } catch (error) {
    console.error('Error fetching interview:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Upload recorded interview video for post-interview multimodal analysis.
router.post('/:interviewId/video/upload', interviewVideoUpload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No video file uploaded' });
    }
    return res.json({
      success: true,
      interviewId: req.params.interviewId,
      videoPath: req.file.path,
    });
  } catch (error) {
    console.error('Interview video upload error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:interviewId/vision-event', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const room = await resolveCallRoom(interviewId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Interview/call room not found' });
    }

    const payload = req.body?.event || req.body || {};
    const type = String(payload.type || '').trim().toUpperCase();
    if (!type) {
      return res.status(400).json({ success: false, message: 'Integrity event type is required' });
    }

    const severity = normalizeSeverity(payload.severity);
    const shouldStoreSnapshot = (severity === 'medium' || severity === 'high') && payload.snapshotBase64;
    const snapshotUrl = shouldStoreSnapshot
      ? saveSnapshotBase64(room._id, payload.snapshotBase64)
      : undefined;
    const llmAnalysis = snapshotUrl
      ? await analyzeSnapshot(payload.snapshotBase64)
      : undefined;

    const eventDoc = {
      type,
      severity,
      timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date(),
      questionId: String(payload.questionId || ''),
      durationSeconds: Number(payload.durationSeconds || 0),
      confidence: Math.max(0, Math.min(1, Number(payload.confidence ?? 0.7))),
      evidence: String(payload.evidence || ''),
      snapshotUrl,
      llmAnalysis,
    };

    room.integrityEvents = Array.isArray(room.integrityEvents) ? room.integrityEvents : [];
    room.integrityEvents.push(eventDoc);

    room.visionMonitoring = room.visionMonitoring || {};
    room.visionMonitoring.events = Array.isArray(room.visionMonitoring.events) ? room.visionMonitoring.events : [];
    const legacyType = INTEGRITY_EVENT_TYPE_MAP[type];
    if (legacyType) {
      room.visionMonitoring.events.push({
        timestamp: eventDoc.timestamp,
        type: legacyType,
        severity: SEVERITY_TO_LEGACY[severity] || 'info',
        message: eventDoc.evidence,
        questionId: eventDoc.questionId,
        durationMs: eventDoc.durationSeconds * 1000,
        meta: {},
      });
    }

    await room.save();
    const savedEvent = room.integrityEvents[room.integrityEvents.length - 1];
    return res.json({ success: true, event: savedEvent });
  } catch (error) {
    console.error('Integrity vision event error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:interviewId/analyze-snapshot', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const room = await resolveCallRoom(interviewId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Interview/call room not found' });
    }

    const eventId = String(req.body?.eventId || '');
    const event = eventId
      ? room.integrityEvents?.id?.(eventId) || room.integrityEvents?.find((item) => String(item._id) === eventId)
      : null;
    const snapshotBase64 = req.body?.snapshotBase64 || readSnapshotAsDataUrl(event?.snapshotUrl);

    if (!snapshotBase64) {
      return res.status(400).json({ success: false, message: 'No snapshot available for analysis' });
    }

    const analysis = await analyzeSnapshot(snapshotBase64);
    if (event) {
      event.llmAnalysis = analysis;
      await room.save();
    }

    return res.json({ success: true, analysis });
  } catch (error) {
    console.error('Snapshot analysis error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:interviewId/final-integrity-report', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const room = await resolveCallRoom(interviewId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Interview/call room not found' });
    }

    const report = await generateIntegrityReport({
      room,
      events: room.integrityEvents || [],
    });
    room.integrityReport = report;
    await room.save();
    return res.json({ success: true, report });
  } catch (error) {
    console.error('Final integrity report error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:interviewId/integrity-report', async (req, res) => {
  try {
    if (String(req.query?.mock || '').toLowerCase() === 'true') {
      return res.json({ success: true, report: buildMockIntegrityReport(), mock: true });
    }

    const { interviewId } = req.params;
    const room = await resolveCallRoom(interviewId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Interview/call room not found' });
    }

    if (!room.integrityReport?.generatedAt) {
      const report = await generateIntegrityReport({
        room,
        events: room.integrityEvents || [],
      });
      room.integrityReport = report;
      await room.save();
    }

    return res.json({
      success: true,
      report: room.integrityReport,
      events: room.integrityEvents || [],
    });
  } catch (error) {
    console.error('Get integrity report error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post('/:interviewId/yolo-detect-frame', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const room = await resolveCallRoom(interviewId);
    if (!room) {
      return res.status(404).json({ success: false, message: 'Interview/call room not found' });
    }

    const { frameBase64, candidateId, questionId } = req.body || {};

    if (!frameBase64) {
      return res.status(400).json({ success: false, message: 'frameBase64 is required' });
    }

    // Call YOLO service
    const yoloResult = await yoloVisionService.detectFrame({
      interviewId,
      candidateId,
      questionId,
      frameBase64,
    });

    // Create integrity events from YOLO detections
    const integrityEvents = yoloVisionService.createIntegrityEvents(yoloResult, {
      interviewId,
      questionId,
      timestamp: new Date().toISOString(),
    });

    // Store events in room
    if (integrityEvents.length > 0) {
      room.integrityEvents = Array.isArray(room.integrityEvents) ? room.integrityEvents : [];
      room.integrityEvents.push(...integrityEvents);
      await room.save();
    }

    // Store YOLO summary in vision monitoring
    room.visionMonitoring = room.visionMonitoring || {};
    room.visionMonitoring.yoloSummary = room.visionMonitoring.yoloSummary || {
      totalFramesProcessed: 0,
      lastProcessedAt: null,
      personCountIssues: 0,
      phoneDetections: 0,
      bookDetections: 0,
      screenDetections: 0,
    };
    
    if (yoloResult.success) {
      room.visionMonitoring.yoloSummary.totalFramesProcessed += 1;
      room.visionMonitoring.yoloSummary.lastProcessedAt = new Date();
      
      if (yoloResult.summary.personCount > 1) {
        room.visionMonitoring.yoloSummary.personCountIssues += 1;
      }
      if (yoloResult.summary.phoneDetected) {
        room.visionMonitoring.yoloSummary.phoneDetections += 1;
      }
      if (yoloResult.summary.bookDetected) {
        room.visionMonitoring.yoloSummary.bookDetections += 1;
      }
      if (yoloResult.summary.laptopDetected || yoloResult.summary.tvDetected) {
        room.visionMonitoring.yoloSummary.screenDetections += 1;
      }
      
      await room.save();
    }

    return res.json({
      success: true,
      yoloEnabled: yoloVisionService.getConfig().enabled,
      yoloAvailable: yoloResult.success,
      summary: yoloResult.summary,
      eventsCreated: integrityEvents.length,
      events: integrityEvents.map(e => ({ type: e.type, severity: e.severity, evidence: e.evidence })),
      processingTimeMs: yoloResult.processingTimeMs,
      error: yoloResult.error || null,
    });
  } catch (error) {
    console.error('YOLO detect frame error:', error);
    return res.status(500).json({ 
      success: false, 
      message: error.message,
      yoloEnabled: yoloVisionService.getConfig().enabled,
    });
  }
});

router.get('/:interviewId/yolo-health', async (req, res) => {
  try {
    const health = await yoloVisionService.checkHealth();
    return res.json({
      success: true,
      ...health,
      config: yoloVisionService.getConfig(),
    });
  } catch (error) {
    console.error('YOLO health check error:', error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

router.post('/:interviewId/analyze-video', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const response = await axios.post(`${ANALYSIS_SERVICE_URL}/api/interviews/${interviewId}/analyze-video`, {
      force: Boolean(req.body?.force),
    });
    return res.status(response.status).json(response.data);
  } catch (error) {
    console.error('Analyze interview video error:', error?.response?.data || error.message);
    return res.status(error?.response?.status || 500).json({
      success: false,
      message: error?.response?.data?.detail || error.message,
    });
  }
});

router.get('/:interviewId/analysis-status', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const response = await axios.get(`${ANALYSIS_SERVICE_URL}/api/interviews/${interviewId}/analysis-status`);
    return res.status(response.status).json(response.data);
  } catch (error) {
    const status = error?.response?.status;
    const networkCode = error?.code;
    if (status === 404 || networkCode === 'ECONNREFUSED' || networkCode === 'ENOTFOUND' || networkCode === 'ETIMEDOUT') {
      return res.status(200).json({
        success: true,
        job: null,
        available: false,
        message: status === 404 ? 'No analysis job found for this interview' : 'Analysis service unavailable',
      });
    }

    return res.status(error?.response?.status || 500).json({
      success: false,
      message: error?.response?.data?.detail || error.message,
    });
  }
});

router.get('/:interviewId/final-report', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const response = await axios.get(`${ANALYSIS_SERVICE_URL}/api/interviews/${interviewId}/final-report`);
    return res.status(response.status).json(response.data);
  } catch (error) {
    return res.status(error?.response?.status || 500).json({
      success: false,
      message: error?.response?.data?.detail || error.message,
    });
  }
});

router.post('/:interviewId/final-report', async (req, res) => {
  try {
    const { interviewId } = req.params;
    const response = await axios.post(`${ANALYSIS_SERVICE_URL}/api/interviews/${interviewId}/final-report`, {
      report: req.body?.report || req.body || {},
    });
    return res.status(response.status).json(response.data);
  } catch (error) {
    return res.status(error?.response?.status || 500).json({
      success: false,
      message: error?.response?.data?.detail || error.message,
    });
  }
});

module.exports = router;
