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

  // Parent shareable room created by the company for this job. When a candidate
  // joins via the shared link a new CallRoom is spawned with these two refs
  // populated so every candidate session is auto-linked to job + company.
  jobInterviewRoom: { type: mongoose.Schema.Types.ObjectId, ref: 'JobInterviewRoom', index: true },
  company: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },

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
  
  // Face identity verification (1:1 matching, candidate photo vs live frame).
  // No raw frames stored. No race/gender/age analysis.
  // Not used as a standalone hiring decision — recruiter review required for mismatches.
  faceVerification: {
    required: { type: Boolean, default: false },
    status: {
      type: String,
      enum: [
        'pending', 'matched', 'uncertain', 'not_matched', 'failed', 'skipped',
        'not_enrolled', 'multiple_faces', 'no_face', 'low_quality',
        'liveness_failed', 'disabled',
      ],
      default: 'pending',
    },
    allowInterview: { type: Boolean, default: false },
    provider: { type: String, default: 'insightface' },
    model: { type: String, default: 'buffalo_l' },
    metric: { type: String, default: 'cosine_similarity' },
    similarity: Number,
    medianSimilarity: Number,
    bestSimilarity: Number,
    distance: Number,
    bestDistance: Number,
    threshold: Number,
    attempts: { type: Number, default: 0 },
    consecutiveMismatches: { type: Number, default: 0 },
    matchingFrames: { type: Number, default: 0 },
    totalFrames: { type: Number, default: 0 },
    validFrames: { type: Number, default: 0 },
    verifiedFrames: { type: Number, default: 0 },
    framesChecked: { type: Number, default: 0 },
    requiredFrames: { type: Number, default: 3 },
    minMatchingFrames: { type: Number, default: 2 },
    livenessPassed: { type: Boolean, default: false },
    livenessChallenge: String,
    failOpen: { type: Boolean, default: false },
    checkedAt: Date,
    events: [{
      _id: false,
      type: {
        type: String,
        enum: [
          'START_CHECK', 'PERIODIC_CHECK',
          'IDENTITY_MATCH', 'IDENTITY_MISMATCH',
          'UNCERTAIN', 'MULTIPLE_FACES', 'NO_FACE', 'LOW_QUALITY',
          'NOT_ENROLLED', 'LIVENESS_FAILED', 'IDENTITY_SERVICE_ERROR',
        ],
      },
      status: String,
      score: Number,
      similarity: Number,
      distance: Number,
      metric: String,
      threshold: Number,
      matchingFrames: Number,
      totalFrames: Number,
      livenessScore: Number,
      timestamp: { type: Date, default: Date.now },
      note: String,
      subType: String,
    }],
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
