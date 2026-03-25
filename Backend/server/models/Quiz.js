const mongoose = require("mongoose");

const quizSchema = new mongoose.Schema({
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job" },
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
});

module.exports = mongoose.model("Quiz", quizSchema);
