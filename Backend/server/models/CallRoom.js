const mongoose = require('mongoose');

const callRoomSchema = new mongoose.Schema({
  // Room identification
  roomId: { type: String, unique: true, required: true, index: true },
  
  // Initiator (RH/Enterprise)
  initiator: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  initiatorRole: { type: String, enum: ['rh', 'enterprise'], default: 'rh' },
  
  // Candidate
  candidate: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  
  // Job reference (optional)
  job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
  
  // Room status flow
  status: { 
    type: String, 
    enum: ['waiting_confirmation', 'active', 'ended', 'rejected'], 
    default: 'waiting_confirmation',
    index: true
  },
  
  // Candidate join request tracking
  candidateJoinRequestedAt: Date,
  candidateJoinConfirmedAt: Date,
  
  // Recording timeline
  recordingStartedAt: Date,
  recordingEndedAt: Date,
  
  // Transcription & sentiment data
  transcription: {
    text: { type: String, default: '' },
    segments: [{
      text: String,
      sentiment: {
        label: { type: String, enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'], default: 'NEUTRAL' },
        score: Number
      },
      timestamp: Date
    }],
    overallSentiment: {
      label: { type: String, enum: ['POSITIVE', 'NEUTRAL', 'NEGATIVE'], default: 'NEUTRAL' },
      score: Number
    }
  },
  
  // Files
  recordingUrl: String,
  transcriptUrl: String,
  
  // Notes
  rhNotes: String,

  // Ethical vision monitoring: only interview quality / integrity metadata.
  // No raw video, no emotion/personality scoring, no automatic rejection.
  visionMonitoring: {
    precheck: {
      cameraAvailable: { type: Boolean, default: null },
      faceDetected: { type: Boolean, default: null },
      faceCentered: { type: Boolean, default: null },
      lightingOk: { type: Boolean, default: null },
      multipleFacesDetected: { type: Boolean, default: false },
      checkedAt: Date,
    },
    events: [{
      timestamp: { type: Date, default: Date.now },
      type: {
        type: String,
        enum: [
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
        ],
      },
      severity: { type: String, enum: ['info', 'warning', 'critical'], default: 'info' },
      message: String,
      questionId: String,
      durationMs: Number,
      meta: {
        brightness: Number,
        faceCount: Number,
        faceRatio: Number,
        centerOffsetX: Number,
        centerOffsetY: Number,
      },
    }],
    summary: {
      totalChecks: { type: Number, default: 0 },
      faceDetectedChecks: { type: Number, default: 0 },
      noFaceChecks: { type: Number, default: 0 },
      multipleFacesChecks: { type: Number, default: 0 },
      lightingIssueChecks: { type: Number, default: 0 },
      positionIssueChecks: { type: Number, default: 0 },
      distanceIssueChecks: { type: Number, default: 0 },
      lastUpdatedAt: Date,
    },
    report: {
      generatedAt: Date,
      cameraQuality: String,
      faceVisibilityRate: String,
      multipleFacesDetected: Boolean,
      absenceEvents: Number,
      lightingIssues: Number,
      positionIssues: Number,
      suspiciousEvents: [{
        _id: false,
        type: { type: String },
        duration: String,
        questionId: String,
      }],
      recommendation: String,
      integrityRisk: {
        level: { type: String, enum: ['Low', 'Medium', 'High'], default: 'Low' },

        score: { type: Number, default: 0 },
        explanation: String,
      },
    },
  },

  // AI Interview Integrity Assistant data. These are review signals only:
  // no automatic rejection, no emotion/personality/identity inference.
  integrityEvents: [{
    type: { type: String },
    severity: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    timestamp: { type: Date, default: Date.now },
    questionId: String,
    durationSeconds: Number,
    confidence: Number,
    evidence: String,
    snapshotUrl: String,
    llmAnalysis: mongoose.Schema.Types.Mixed,
  }],

  integrityReport: {
    generatedAt: Date,
    overallRiskLevel: { type: String, enum: ['low', 'medium', 'high'], default: 'low' },
    riskScore: { type: Number, default: 0 },
    summary: String,
    keyFindings: [String],
    questionAnalysis: [mongoose.Schema.Types.Mixed],
    timelineSummary: String,
    recruiterRecommendation: String,
    limitations: String,
    metrics: mongoose.Schema.Types.Mixed,
    llmProvider: String,
    llmError: String,
  },
  
  // Final interview agent snapshot (conversation transcript, evaluation, etc)
  agentSnapshot: mongoose.Schema.Types.Mixed,

  // Live conversation messages
  messages: [{
    role: { type: String, enum: ['agent', 'candidate', 'system'] },
    text: String,
    timestamp: { type: Date, default: Date.now },
    sentiment: mongoose.Schema.Types.Mixed
  }],

  // Full recruiter report generated after interview ends
  recruiterReport: mongoose.Schema.Types.Mixed,

  // Quick-access recruiter decision (also duplicated inside recruiterReport)
  rhDecision: {
    status: { type: String, enum: ['pending', 'accepted', 'rejected', 'needs_review'], default: 'pending' },
    notes: { type: String, default: '' },
    decidedAt: { type: String, default: '' },
  },

  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.models.CallRoom || mongoose.model('CallRoom', callRoomSchema);
