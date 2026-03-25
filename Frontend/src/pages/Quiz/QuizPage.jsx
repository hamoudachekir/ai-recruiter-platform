import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import "./QuizPage.css";

const TARGET_QUIZ_QUESTION_COUNT = 20;
const QUIZ_DURATION_SECONDS = 5 * 60;
const QUESTIONS_PER_PAGE = 5;

const cleanQuestionPrefix = (value) =>
  String(value || "")
    .replace(/^(qcm|vrai\/?faux|réponse courte|mini-exercice)\s*\d+\s*:\s*/i, "")
    .trim();

const getQuestionTextForDisplay = (question) => {
  const raw = String(question?.question || question?.title || "Question").trim();
  const cleaned = cleanQuestionPrefix(raw);
  return cleaned || raw || "Question";
};

const QuizPage = () => {
  const { jobId } = useParams();
  const [questions, setQuestions] = useState([]);
  const [questionOrder, setQuestionOrder] = useState([]);
  const [answers, setAnswers] = useState({});
  const [responseHistory, setResponseHistory] = useState([]);
  const [submitted, setSubmitted] = useState(false);
  const [score, setScore] = useState(0);
  const [quizStartTime, setQuizStartTime] = useState(null);
  const [currentPageStartedAt, setCurrentPageStartedAt] = useState(null);
  const [totalQuizTimeSeconds, setTotalQuizTimeSeconds] = useState(0);
  const [totalQuestionTarget, setTotalQuestionTarget] = useState(TARGET_QUIZ_QUESTION_COUNT);
  const [timeLeftSeconds, setTimeLeftSeconds] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLoadingNextPage, setIsLoadingNextPage] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [isLoadingQuiz, setIsLoadingQuiz] = useState(true);
  const [quizLoadError, setQuizLoadError] = useState("");
  const [quizStarted, setQuizStarted] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMoreAdaptivePages, setHasMoreAdaptivePages] = useState(true);
  const [aiCoach, setAiCoach] = useState(null);
  const [showUnansweredHints, setShowUnansweredHints] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const fetchQuiz = async () => {
      setIsLoadingQuiz(true);
      setQuizLoadError("");

      try {
        const userId = localStorage.getItem("userId");
        if (!userId) {
          throw new Error("Utilisateur non connecté");
        }

        const adaptiveRes = await axios.post("http://localhost:3001/Frontend/adaptive-quiz-page", {
          jobId,
          candidateId: userId,
          page: 1,
          pageSize: QUESTIONS_PER_PAGE,
          askedQuestionKeys: [],
          responseHistory: [],
          forceMistral: false,
        });

        const loadedQuestions = Array.isArray(adaptiveRes?.data?.questions) ? adaptiveRes.data.questions : [];
        setQuestions(loadedQuestions);
        setQuestionOrder(loadedQuestions.map((question) => question?.questionKey));
        setResponseHistory([]);
        setHasMoreAdaptivePages(!adaptiveRes?.data?.completed);
        const backendTarget = Math.max(
          TARGET_QUIZ_QUESTION_COUNT,
          Number(adaptiveRes?.data?.totalQuestions) || TARGET_QUIZ_QUESTION_COUNT
        );
        setTotalQuestionTarget(backendTarget);

        const normalizedQuizTime = loadedQuestions.length > 0 ? QUIZ_DURATION_SECONDS : 0;
        setTotalQuizTimeSeconds(normalizedQuizTime);
        setTimeLeftSeconds(normalizedQuizTime);
        setQuizStartTime(null);
        setCurrentPageStartedAt(null);
        setQuizStarted(false);
        setCurrentPage(1);
        setAnswers({});

        if (!loadedQuestions.length) {
          setQuizLoadError("Aucun quiz disponible pour cette candidature. Réessayez dans quelques secondes.");
        } else {
          setQuizLoadError("");
        }
      } catch (err) {
        console.error("Erreur de chargement du quiz :", err);
        setQuestions([]);
        setQuestionOrder([]);
        setResponseHistory([]);
        setHasMoreAdaptivePages(true);
        setTotalQuestionTarget(TARGET_QUIZ_QUESTION_COUNT);
        setTotalQuizTimeSeconds(0);
        setTimeLeftSeconds(0);
        setQuizStartTime(null);
        setCurrentPageStartedAt(null);
        setQuizLoadError("Impossible de charger votre quiz pour le moment.");
      } finally {
        setIsLoadingQuiz(false);
      }
    };

    fetchQuiz();
  }, [jobId]);

  const handleStartQuiz = () => {
    if (!questions.length) {
      return;
    }

    setQuizStarted(true);
    setQuizStartTime(Date.now());
    setCurrentPageStartedAt(Date.now());
    setSubmitError("");
    setCurrentPage(1);
  };

  const handleAnswer = (qIndex, answerIndex) => {
    setAnswers({ ...answers, [qIndex]: answerIndex });
    setSubmitError("");
  };

  const handleTextAnswer = (qIndex, textValue) => {
    setAnswers({ ...answers, [qIndex]: textValue });
    setSubmitError("");
  };

  const isQuestionAnswered = (question, answerValue) => {
    const hasOptions = Array.isArray(question?.options)
      && question.options.some((option) => String(option || "").trim().length > 0);

    if (hasOptions) {
      return typeof answerValue === "number";
    }

    return typeof answerValue === "string" && answerValue.trim().length > 0;
  };

  const getMissingQuestionNumbers = (questionList, startIndex = 0) =>
    questionList.reduce((missing, question, index) => {
      const absoluteIndex = startIndex + index;
      if (!isQuestionAnswered(question, answers?.[absoluteIndex])) {
        missing.push(absoluteIndex + 1);
      }
      return missing;
    }, []);

  const handleSubmit = async (triggeredByTimer = false) => {
    if (isSubmitting || submitted) return;

    if (!triggeredByTimer) {
      const allLoadedQuestionsAnswered =
        questions.length > 0
        && questions.every((question, index) => isQuestionAnswered(question, answers?.[index]));

      if (!allLoadedQuestionsAnswered) {
        const missingQuestions = getMissingQuestionNumbers(questions, 0);
        setShowUnansweredHints(true);
        setSubmitError(`Questions non répondues: ${missingQuestions.join(", ")}.`);
        return;
      }
    }

    try {
      setIsSubmitting(true);
      setSubmitError("");
      const userId = localStorage.getItem("userId");
      const answersByQuestionKey = {};
      Object.entries(answers || {}).forEach(([localIndex, value]) => {
        const key = questionOrder?.[Number(localIndex)];
        if (typeof key === "number") {
          answersByQuestionKey[key] = value;
        }
      });

      const timeSpentSeconds = quizStartTime
        ? Math.max(0, Math.round((Date.now() - quizStartTime) / 1000))
        : 0;

      const submitRes = await axios.post("http://localhost:3001/Frontend/submit-quiz", {
        jobId,
        candidateId: userId,
        answers,
        answersByQuestionKey,
        timeSpentSeconds,
        requireComplete: !triggeredByTimer,
      });

      const computedScore = submitRes?.data?.score ?? 0;
      setScore(computedScore);
      setAiCoach(submitRes?.data?.aiCoach || null);
      setSubmitted(true);
      setShowUnansweredHints(false);

      if (triggeredByTimer) {
        console.log("⏱️ Quiz auto-submitted because timer reached zero.");
      }

      setTimeout(() => {
        navigate("/");
      }, 12000);
    } catch (err) {
      console.error("Erreur lors de l'envoi du score :", err);
      setSubmitError("Impossible de soumettre le quiz. Veuillez réessayer.");
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (submitted || isSubmitting || !quizStarted || timeLeftSeconds <= 0 || questions.length === 0) {
      return;
    }

    const interval = setInterval(() => {
      setTimeLeftSeconds((previousValue) => {
        if (previousValue <= 1) {
          clearInterval(interval);
          handleSubmit(true);
          return 0;
        }
        return previousValue - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [submitted, isSubmitting, quizStarted, questions.length, timeLeftSeconds]);

  const answeredCount = questions.reduce(
    (count, question, idx) => (isQuestionAnswered(question, answers[idx]) ? count + 1 : count),
    0
  );

  const progressPercentage = questions.length ? Math.floor((answeredCount / questions.length) * 100) : 0;
  const minutes = Math.floor(timeLeftSeconds / 60);
  const seconds = timeLeftSeconds % 60;
  const formattedTime = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  const isTimeWarning = timeLeftSeconds <= 300;
  const totalMinutes = Math.floor(totalQuizTimeSeconds / 60);
  const totalSeconds = totalQuizTimeSeconds % 60;
  const formattedTotalTime = `${String(totalMinutes).padStart(2, "0")}:${String(totalSeconds).padStart(2, "0")}`;
  const totalPages = Math.max(1, Math.ceil(questions.length / QUESTIONS_PER_PAGE));
  const currentPageSafe = Math.min(currentPage, totalPages);
  const pageStartIndex = (currentPageSafe - 1) * QUESTIONS_PER_PAGE;
  const pageEndIndex = pageStartIndex + QUESTIONS_PER_PAGE;
  const visibleQuestions = questions.slice(pageStartIndex, pageEndIndex);
  const isLastPage = currentPageSafe === totalPages && !hasMoreAdaptivePages;
  const currentPageAnsweredCount = visibleQuestions.reduce((count, question, idx) => {
    const localIndex = pageStartIndex + idx;
    return isQuestionAnswered(question, answers?.[localIndex]) ? count + 1 : count;
  }, 0);
  const isCurrentPageComplete = visibleQuestions.length > 0 && currentPageAnsweredCount === visibleQuestions.length;
  const missingCurrentPageQuestionNumbers = getMissingQuestionNumbers(visibleQuestions, pageStartIndex);

  const buildCurrentPageHistoryEntries = () => {
    const now = Date.now();
    const elapsedSeconds = currentPageStartedAt
      ? Math.max(1, Math.round((now - currentPageStartedAt) / 1000))
      : QUESTIONS_PER_PAGE * 20;
    const answeredEntries = visibleQuestions
      .map((question, idx) => {
        const localIndex = pageStartIndex + idx;
        const questionKey = questionOrder?.[localIndex];
        if (typeof questionKey !== "number") {
          return null;
        }
        const answer = answers?.[localIndex];
        if (answer === undefined || answer === null || (typeof answer === "string" && !answer.trim())) {
          return null;
        }
        return { questionKey, answer };
      })
      .filter(Boolean);

    if (!answeredEntries.length) {
      return [];
    }

    const perQuestionTime = Math.max(5, Math.round(elapsedSeconds / answeredEntries.length));
    return answeredEntries.map((entry) => ({ ...entry, timeSpentSeconds: perQuestionTime }));
  };

  const mergeResponseHistory = (existing, additions) => {
    const map = new Map();
    (Array.isArray(existing) ? existing : []).forEach((entry) => {
      if (typeof entry?.questionKey === "number") {
        map.set(entry.questionKey, entry);
      }
    });
    (Array.isArray(additions) ? additions : []).forEach((entry) => {
      if (typeof entry?.questionKey === "number") {
        map.set(entry.questionKey, entry);
      }
    });
    return Array.from(map.values());
  };

  const goToNextPage = async () => {
    if (isLoadingNextPage || isSubmitting) {
      return;
    }

    if (!isCurrentPageComplete) {
      setShowUnansweredHints(true);
      setSubmitError(`Questions non répondues sur cette page: ${missingCurrentPageQuestionNumbers.join(", ")}.`);
      return;
    }

    setShowUnansweredHints(false);
    setSubmitError("");

    const additions = buildCurrentPageHistoryEntries();
    const mergedHistory = mergeResponseHistory(responseHistory, additions);
    setResponseHistory(mergedHistory);

    const canMoveOnLoadedPages = currentPageSafe < totalPages;
    if (canMoveOnLoadedPages) {
      setCurrentPage((prev) => Math.min(prev + 1, totalPages));
      setCurrentPageStartedAt(Date.now());
      return;
    }

    if (!hasMoreAdaptivePages) {
      return;
    }

    try {
      setIsLoadingNextPage(true);
      const userId = localStorage.getItem("userId");
      const adaptiveRes = await axios.post("http://localhost:3001/Frontend/adaptive-quiz-page", {
        jobId,
        candidateId: userId,
        page: totalPages + 1,
        pageSize: QUESTIONS_PER_PAGE,
        askedQuestionKeys: questionOrder,
        responseHistory: mergedHistory,
      });

      const nextQuestions = Array.isArray(adaptiveRes?.data?.questions) ? adaptiveRes.data.questions : [];
      if (nextQuestions.length) {
        setQuestions((prev) => [...prev, ...nextQuestions]);
        setQuestionOrder((prev) => [...prev, ...nextQuestions.map((question) => question?.questionKey)]);
        setCurrentPage((prev) => prev + 1);
        setCurrentPageStartedAt(Date.now());
      }

      setHasMoreAdaptivePages(!adaptiveRes?.data?.completed);
      if (adaptiveRes?.data?.totalQuestions) {
        setTotalQuestionTarget((prev) => Math.max(prev, Number(adaptiveRes.data.totalQuestions) || prev));
      }
    } catch (error) {
      console.error("Erreur chargement page adaptative:", error);
      setSubmitError("Impossible de charger la page suivante du quiz.");
    } finally {
      setIsLoadingNextPage(false);
    }
  };

  const goToPreviousPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
    setCurrentPageStartedAt(Date.now());
  };

  return (
    <div className="quiz-container">
      <h2 className="quiz-title">📝 Quiz Candidat</h2>

      {isLoadingQuiz && (
        <div className="quiz-start-card">
          <p>Chargement de votre quiz personnalisé...</p>
        </div>
      )}

      {!isLoadingQuiz && !submitted && !quizStarted && questions.length > 0 && (
        <div className="quiz-start-card">
          <p className="mb-2">Votre quiz est prêt. Confirmez pour démarrer maintenant.</p>
          <div className="quiz-info-row">
            <span>Questions: <strong>{totalQuestionTarget}</strong></span>
            <span>Durée: <strong>{formattedTotalTime}</strong></span>
          </div>
          <button className="start-btn" onClick={handleStartQuiz}>
            Commencer le quiz
          </button>
        </div>
      )}

      {!isLoadingQuiz && !submitted && !questions.length && (
        <div className="quiz-start-card">
          <p className="quiz-empty-state">{quizLoadError || "Quiz indisponible pour le moment."}</p>
          <button className="start-btn" onClick={() => navigate("/")}>Retour à l'accueil</button>
        </div>
      )}

      {!submitted && quizStarted && questions.length > 0 && (
        <div className="quiz-status-bar">
          <div className="quiz-stat">
            <span className="quiz-stat-label">Questions</span>
            <span className="quiz-stat-value">{answeredCount}/{totalQuestionTarget}</span>
          </div>
          <div className={`quiz-timer ${isTimeWarning ? "warning" : ""}`}>
            <span className="quiz-stat-label">Temps restant</span>
            <span className="quiz-stat-value">{formattedTime}</span>
          </div>
        </div>
      )}
  
      {!submitted && quizStarted && questions.length > 0 && (
        <>
          <div className="quiz-page-indicator">Page {currentPageSafe} / {totalPages}</div>
          <div className="progress-container">
            <div className="progress-bar" style={{ width: `${progressPercentage}%` }}>
              {progressPercentage}%
            </div>
          </div>
          <p className="question-indicator">
            {answeredCount} / {totalQuestionTarget} questions répondues
          </p>
        </>
      )}
  
      {!submitted && quizStarted && questions.length > 0 ? (
        <>
          {visibleQuestions.map((q, idx) => {
            const globalIndex = pageStartIndex + idx;
            const key = `${String(q?.title || q?.question || "question")}-${globalIndex}`;
            const displayQuestionText = getQuestionTextForDisplay(q);
            const isCurrentQuestionAnswered = isQuestionAnswered(q, answers?.[globalIndex]);
            return (
            <div key={key} className="question-block">
              <p><strong>{globalIndex + 1}. {displayQuestionText}</strong></p>
              {showUnansweredHints && !isCurrentQuestionAnswered && (
                <div className="question-missing-hint">⚠️ Question {globalIndex + 1} non répondue.</div>
              )}
              <div className="question-meta">Type: {q.type || "QCM"} • Temps recommandé: {q.timeLimit || 60}s</div>
              {Array.isArray(q.options) && q.options.some((opt) => String(opt || "").trim().length > 0) ? (
                q.options.map((opt) => {
                  if (!String(opt || "").trim()) return null;
                  const optionIndex = q.options.findIndex((optionValue) => optionValue === opt);
                  const optionKey = `${key}-${String(opt)}`;
                  return (
                    <div className="option" key={optionKey}>
                      <input
                        type="radio"
                        name={`question-${globalIndex}`}
                        checked={answers[globalIndex] === optionIndex}
                        onChange={() => handleAnswer(globalIndex, optionIndex)}
                      /> {opt}
                    </div>
                  );
                })
              ) : (
                <textarea
                  className="form-control mt-2"
                  rows={4}
                  placeholder="Écrivez votre réponse ici..."
                  value={typeof answers[globalIndex] === "string" ? answers[globalIndex] : ""}
                  onChange={(e) => handleTextAnswer(globalIndex, e.target.value)}
                />
              )}
            </div>
          );
          })}
          {submitError && <p className="submit-error">{submitError}</p>}
          <div className="quiz-navigation">
            <button className="start-btn" onClick={goToPreviousPage} disabled={currentPageSafe === 1 || isSubmitting}>
              Précédent
            </button>

            {!isLastPage ? (
              <button className="start-btn" onClick={goToNextPage} disabled={isSubmitting || isLoadingNextPage}>
                {isLoadingNextPage ? "⏳ Chargement..." : "Suivant"}
              </button>
            ) : (
              <button className="submit-btn" onClick={() => handleSubmit(false)} disabled={isSubmitting}>
                {isSubmitting ? "⏳ Soumission en cours..." : "✅ Soumettre mes réponses"}
              </button>
            )}
          </div>
        </>
      ) : submitted ? (
        <div>
          <p className="success-message">✅ Vous avez obtenu {score} / {questions.length}</p>
          {aiCoach && (
            <div className="quiz-coach-card">
              <h5>AI Coach Feedback</h5>
              <p className="quiz-coach-summary">{aiCoach?.summary?.narrative}</p>
              {typeof aiCoach?.summary?.openAnswerAverage === "number" && (
                <p className="quiz-coach-metric">Open Answers Average: <strong>{aiCoach.summary.openAnswerAverage}/100</strong></p>
              )}

              {Array.isArray(aiCoach?.bySkill) && aiCoach.bySkill.length > 0 && (
                <div className="quiz-coach-section">
                  <h6>By Skill</h6>
                  {aiCoach.bySkill.slice(0, 6).map((item, index) => (
                    <div key={`${item.skill}-${index}`} className="quiz-coach-skill-row">
                      <div><strong>{item.skill}</strong> • {item.level} • {item.successRate}%</div>
                      <div className="quiz-coach-sub">{item.improvementPlan}</div>
                    </div>
                  ))}
                </div>
              )}

              {Array.isArray(aiCoach?.openAnswerRubric) && aiCoach.openAnswerRubric.length > 0 && (
                <div className="quiz-coach-section">
                  <h6>Open Answer Rubric</h6>
                  {aiCoach.openAnswerRubric.map((entry, index) => (
                    <div key={`${entry?.questionIndex}-${index}`} className="quiz-coach-rubric-row">
                      <div><strong>Q{Number(entry?.questionIndex) + 1}</strong> • Score: {entry?.globalScore}/100 • Confidence: {entry?.confidence}%</div>
                      <div className="quiz-coach-sub">
                        Structure {entry?.rubric?.structure}/100 • Exactitude {entry?.rubric?.exactitude}/100 • Pertinence {entry?.rubric?.pertinence}/100
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <p className="redirect-message">🙏 Merci pour vos réponses. Vous devez maintenant attendre un email de l'entreprise.</p>
          <p className="redirect-message">Redirection vers la page d'accueil...</p>
        </div>
      ) : null}
    </div>
  );
  
  
};

export default QuizPage;
