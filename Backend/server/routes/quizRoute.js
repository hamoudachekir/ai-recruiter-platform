const express = require("express");
const router = express.Router();
const QuizModel = require("../models/Quiz");

router.get("/job/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const quiz = await QuizModel.findOne({ jobId }).lean();

    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found for this job" });
    }

    return res.status(200).json(quiz);
  } catch (err) {
    console.error("❌ Error fetching quiz by job:", err.message);
    return res.status(500).json({ message: "Server error", error: err.message });
  }
});

// GET /quiz/all-quizzes - Fetch all quizzes
router.get("/all-quizzes", async (req, res) => {
  try {
    const quizzes = await QuizModel.find({})
      .populate({
        path: "jobPostId",
        select: "title", // Only include title
        strictPopulate: false, // Avoid crash if jobPostId doesn't exist
      })
      .lean();

    const formattedQuizzes = quizzes.map((quiz) => ({
      _id: quiz._id,
      jobPostId: quiz.jobPostId?._id || null,
      jobTitle: quiz.jobPostId?.title || "No Job Title",
      questions: (quiz.questions || []).map((question) => ({
        question: question.question,
        options: question.options,
        correctAnswer: question.correctAnswer,
      })),
    }));

    res.status(200).json(formattedQuizzes);
  } catch (err) {
    console.error("❌ Error fetching quizzes:", err.message);
    res.status(500).json({ message: "Erreur serveur : " + err.message });
  }
});

module.exports = router;
