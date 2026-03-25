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
  submittedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("QuizResult", quizResultSchema);
