const mongoose = require("mongoose");

const quizResultSchema = new mongoose.Schema({
  candidateId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
  score: { type: Number, required: true },
  totalQuestions: { type: Number, default: 0 },
  timeSpentSeconds: { type: Number, default: 0 },
  answers: [
    {
      questionIndex: { type: Number, required: true },
      selectedAnswerIndex: { type: Number, default: null },
      selectedAnswerText: { type: String, default: "" },
      isCorrect: { type: Boolean, default: false },
      needsHumanReview: { type: Boolean, default: false },
      aiSuggestedCorrect: { type: Boolean, default: null },
      aiConfidence: { type: Number, default: null },
      evaluationMode: { type: String, default: "auto-options" },
    },
  ],
  aiCoach: { type: mongoose.Schema.Types.Mixed, default: null },
  submittedAt: { type: Date, default: Date.now },
  // Security & Audit Trail Fields
  auditTrail: {
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    focusEvents: [
      {
        timestamp: { type: Date, default: Date.now },
        type: { type: String, enum: ["lost", "restored"], required: true },
        durationSeconds: { type: Number, default: 0 },
      },
    ],
    securityEvents: [
      {
        timestamp: { type: Date, default: Date.now },
        event: {
          type: String,
          enum: ["copy-attempt", "devtools-access", "paste-attempt"],
          required: true,
        },
      },
    ],
    completionType: {
      type: String,
      enum: ["normal", "timeout", "interrupted"],
      default: "normal",
    },
  },
  submissionFlags: [
    {
      flag: {
        type: String,
        enum: [
          "fast-completion",
          "minimum-time-warning",
          "multiple-focus-losses",
          "copy-paste-attempts",
          "devtools-access",
          "suspicious-pattern",
        ],
        required: true,
      },
      severity: { type: String, enum: ["low", "medium", "high"], default: "medium" },
      timestamp: { type: Date, default: Date.now },
    },
  ],
  submissionValidation: {
    totalTimeValid: { type: Boolean, default: true },
    averageTimePerQuestion: { type: Number, default: 0 },
    duplicateAnswerCount: { type: Number, default: 0 },
    flagged: { type: Boolean, default: false },
    flagReason: { type: String, default: null },
  },
});

module.exports = mongoose.model("QuizResult", quizResultSchema);
