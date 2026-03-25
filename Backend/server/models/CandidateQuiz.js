const mongoose = require("mongoose");

const candidateQuizSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    candidateId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    source: { type: String, default: "mistral-api" },
    generationMeta: {
      jobTitle: { type: String, default: "" },
      skillsUsed: { type: [String], default: [] },
      matchedSkills: { type: [String], default: [] },
      model: { type: String, default: "" },
      rationale: { type: String, default: "" },
      difficultyMix: { type: mongoose.Schema.Types.Mixed, default: {} },
      fallbackReason: { type: String, default: null },
    },
    questions: [
      {
        title: String,
        question: String,
        type: {
          type: String,
          enum: ["QCM", "vrai-faux", "réponse courte", "mini-exercice"],
          default: "QCM",
        },
        domain: String,
        skills: [String],
        difficulty: {
          type: String,
          enum: ["facile", "moyen", "difficile"],
          default: "moyen",
        },
        options: [String],
        correctAnswer: Number,
        expectedAnswer: String,
        explanation: String,
        score: { type: Number, default: 1 },
        timeLimit: { type: Number, default: 60 },
      },
    ],
  },
  { timestamps: true }
);

candidateQuizSchema.index({ jobId: 1, candidateId: 1 }, { unique: true });

module.exports = mongoose.model("CandidateQuiz", candidateQuizSchema);
