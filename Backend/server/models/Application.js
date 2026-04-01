const mongoose = require("mongoose");

const applicationSchema = new mongoose.Schema({
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
  enterpriseId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  candidateId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  fullName: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  appliedAt: { type: Date, default: Date.now },
  cv: { type: String }, // si tu l’as
  quizScore: { type: Number }, // ✅ Ajoute cette ligne
  quizCompleted: { type: Boolean, default: false },
  quizSubmittedAt: { type: Date },
  recruiterDecision: {
    type: String,
    enum: ["PENDING", "INTERVIEW", "REJECTED"],
    default: "PENDING",
  },
  recruiterDecisionAt: { type: Date, default: null },
  recruiterDecisionBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  recruiterDecisionNote: { type: String, default: "" },
  interviewSchedule: {
    scheduleId: { type: String, default: null },
    status: {
      type: String,
      enum: [
        "not_scheduled",
        "scheduling",
        "suggested_slots_ready",
        "confirmed",
        "rescheduled",
        "cancelled",
        "failed",
      ],
      default: "not_scheduled",
    },
    suggestedSlots: [
      {
        start_time: { type: String, default: "" },
        end_time: { type: String, default: "" },
        score: { type: Number, default: 0 },
      },
    ],
    confirmedSlot: {
      start_time: { type: String, default: null },
      end_time: { type: String, default: null },
    },
    calendarEventId: { type: String, default: null },
    meetingLink: { type: String, default: null },
    emailStatus: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
    },
    lastTriggeredAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  quizTimeSpentSeconds: { type: Number, default: 0 },
  quizReviewPendingCount: { type: Number, default: 0 },
  quizAnswers: [
    {
      questionIndex: { type: Number, required: true },
      question: { type: String, default: "" },
      questionType: { type: String, default: "QCM" },
      selectedAnswerIndex: { type: Number, default: null },
      selectedAnswerText: { type: String, default: "" },
      expectedAnswer: { type: String, default: "" },
      isCorrect: { type: Boolean, default: false },
      needsHumanReview: { type: Boolean, default: false },
      aiSuggestedCorrect: { type: Boolean, default: null },
      aiConfidence: { type: Number, default: null },
      evaluationMode: { type: String, default: "auto-options" },
      manualReviewedAt: { type: Date, default: null },
    },
  ],
  aiCoach: { type: mongoose.Schema.Types.Mixed, default: null },
});


module.exports = mongoose.model("Application", applicationSchema);
