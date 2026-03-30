import React, { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import "./QuizPage.css";
import { useQuizFocusTracking } from "../../hooks/useQuizFocusTracking";
import { useQuizSecurityLocks } from "../../hooks/useQuizSecurityLocks";

const TARGET_QUIZ_QUESTION_COUNT = 20;
const QUIZ_DURATION_SECONDS = 5 * 60;
const QUESTIONS_PER_PAGE = 5;
const QUIZ_LOCKED_MESSAGE = "Vous avez deja complete ce quiz. L'acces a cette evaluation est desormais ferme.";
const QUIZ_SESSION_STORAGE_PREFIX = "quiz-session-v1";

const getQuizSessionStorageKey = (jobId, candidateId) =>
  `${QUIZ_SESSION_STORAGE_PREFIX}:${String(jobId || "unknown-job")}:${String(candidateId || "unknown-user")}`;

const safeParseSession = (rawValue) => {
  if (!rawValue || typeof rawValue !== "string") return null;
  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
};

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
  const [passingScore, setPassingScore] = useState(0);
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
  const [capturedSecurityEvents, setCapturedSecurityEvents] = useState([]);
  const [sessionStorageKey, setSessionStorageKey] = useState("");
  const navigate = useNavigate();

  const isSecurityTrackingEnabled = quizStarted && !submitted;

  const onSecurityEvent = useCallback((event) => {
    if (!event) return;
    setCapturedSecurityEvents((previous) => ([
      ...previous,
      {
        ...event,
        timestamp: event?.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
      },
    ].slice(-150)));
  }, []);

  const {
    focusLossCount,
    focusLossEvents,
    securityEvents: focusTrackingSecurityEvents,
    devToolsAccessDetected,
  } = useQuizFocusTracking(onSecurityEvent, isSecurityTrackingEnabled);

  const { copyPasteAttempts } = useQuizSecurityLocks(
    "quiz-container-secure",
    onSecurityEvent,
    isSecurityTrackingEnabled
  );

  useEffect(() => {
    const fetchQuiz = async () => {
      setIsLoadingQuiz(true);
      setQuizLoadError("");

      let savedSession = null;

      try {
        const userId = localStorage.getItem("userId");
        if (!userId) {
          throw new Error("Utilisateur non connecté");
        }

        const storageKey = getQuizSessionStorageKey(jobId, userId);
        setSessionStorageKey(storageKey);
        savedSession = safeParseSession(localStorage.getItem(storageKey));

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
        const fallbackQuestions = Array.isArray(savedSession?.questions) ? savedSession.questions : [];
        const effectiveQuestions = loadedQuestions.length > 0 ? loadedQuestions : fallbackQuestions;
        const restoredQuestionOrder = Array.isArray(savedSession?.questionOrder) ? savedSession.questionOrder : [];

        setQuestions(effectiveQuestions);
        setQuestionOrder(
          loadedQuestions.length > 0
            ? loadedQuestions.map((question) => question?.questionKey)
            : restoredQuestionOrder
        );
        setResponseHistory(Array.isArray(savedSession?.responseHistory) ? savedSession.responseHistory : []);
        setHasMoreAdaptivePages(!adaptiveRes?.data?.completed);
        const backendTarget = Math.max(
          TARGET_QUIZ_QUESTION_COUNT,
          Number(adaptiveRes?.data?.totalQuestions) || TARGET_QUIZ_QUESTION_COUNT
        );
        setTotalQuestionTarget(Math.max(backendTarget, Number(savedSession?.totalQuestionTarget) || 0));

        const normalizedQuizTime = effectiveQuestions.length > 0 ? QUIZ_DURATION_SECONDS : 0;
        setTotalQuizTimeSeconds(normalizedQuizTime);
        const restoredQuizStarted = Boolean(savedSession?.quizStarted) && !savedSession?.submitted;
        const restoredStartTime = Number(savedSession?.quizStartTime) || null;
        const restoredAnswers = savedSession?.answers && typeof savedSession.answers === "object"
          ? savedSession.answers
          : {};

        setQuizStarted(restoredQuizStarted);
        setQuizStartTime(restoredQuizStarted ? restoredStartTime : null);
        setCurrentPageStartedAt(Number(savedSession?.currentPageStartedAt) || null);
        setCurrentPage(Math.max(1, Number(savedSession?.currentPage) || 1));
        setAnswers(restoredAnswers);
        setSubmitted(false);

        if (restoredQuizStarted && restoredStartTime) {
          const elapsedSeconds = Math.max(0, Math.floor((Date.now() - restoredStartTime) / 1000));
          const recoveredRemaining = Math.max(0, normalizedQuizTime - elapsedSeconds);
          setTimeLeftSeconds(recoveredRemaining);
        } else {
          setTimeLeftSeconds(normalizedQuizTime);
        }

        if (!effectiveQuestions.length) {
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
        const hasSavedQuestions = Array.isArray(savedSession?.questions) && savedSession.questions.length > 0;
        if (hasSavedQuestions) {
          const restoredStartTime = Number(savedSession?.quizStartTime) || null;
          const recoveredTotalQuizTime = Number(savedSession?.totalQuizTimeSeconds) || QUIZ_DURATION_SECONDS;
          const elapsedSeconds = restoredStartTime ? Math.max(0, Math.floor((Date.now() - restoredStartTime) / 1000)) : 0;
          const recoveredRemaining = Math.max(0, recoveredTotalQuizTime - elapsedSeconds);

          setQuestions(savedSession.questions);
          setQuestionOrder(Array.isArray(savedSession?.questionOrder) ? savedSession.questionOrder : []);
          setAnswers(savedSession?.answers && typeof savedSession.answers === "object" ? savedSession.answers : {});
          setResponseHistory(Array.isArray(savedSession?.responseHistory) ? savedSession.responseHistory : []);
          setQuizStarted(Boolean(savedSession?.quizStarted));
          setQuizStartTime(restoredStartTime);
          setCurrentPageStartedAt(Number(savedSession?.currentPageStartedAt) || Date.now());
          setCurrentPage(Math.max(1, Number(savedSession?.currentPage) || 1));
          setTotalQuizTimeSeconds(recoveredTotalQuizTime);
          setTimeLeftSeconds(recoveredRemaining);
          setTotalQuestionTarget(Number(savedSession?.totalQuestionTarget) || TARGET_QUIZ_QUESTION_COUNT);
          setHasMoreAdaptivePages(Boolean(savedSession?.hasMoreAdaptivePages));
          setQuizLoadError("Connexion indisponible. Session quiz restauree localement.");
        } else {
          setTimeLeftSeconds(0);
          setQuizStartTime(null);
          setCurrentPageStartedAt(null);
        }

        const reason = err?.response?.data?.reason;
        const status = err?.response?.status;
        if (reason === "quiz-already-completed" || status === 403) {
          setQuizLoadError(QUIZ_LOCKED_MESSAGE);
        } else if (!hasSavedQuestions) {
          setQuizLoadError("Impossible de charger votre quiz pour le moment.");
        } else {
          setSubmitError("Mode hors ligne active: vos reponses restent sauvegardees.");
        }
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
    const now = Date.now();
    setQuizStartTime(now);
    setCurrentPageStartedAt(now);
    setTimeLeftSeconds(totalQuizTimeSeconds || QUIZ_DURATION_SECONDS);
    setSubmitError("");
    setCurrentPage(1);
    setCapturedSecurityEvents([]);
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
        completionType: triggeredByTimer ? "timeout" : "normal",
        totalQuestions: Math.max(totalQuestionTarget, questionOrder.length, questions.length),
        focusLossCount,
        focusLossEvents,
        copyPasteAttempts,
        devToolsAccess: devToolsAccessDetected,
        securityEvents: [
          ...(Array.isArray(focusTrackingSecurityEvents) ? focusTrackingSecurityEvents : []),
          ...(Array.isArray(capturedSecurityEvents) ? capturedSecurityEvents : []),
        ],
      });

      const computedScore = submitRes?.data?.score ?? 0;
      const computedPassingScore = submitRes?.data?.passingScore ?? Math.ceil((questions?.length || 0) / 2);
      setScore(computedScore);
      setPassingScore(computedPassingScore);
      setAiCoach(submitRes?.data?.aiCoach || null);
      setSubmitted(true);
      setShowUnansweredHints(false);

      if (sessionStorageKey) {
        localStorage.removeItem(sessionStorageKey);
      }

      if (triggeredByTimer) {
        console.log("⏱️ Quiz auto-submitted because timer reached zero.");
      }
    } catch (err) {
      console.error("Erreur lors de l'envoi du score :", err);
      const backendMessage = err?.response?.data?.message;
      setSubmitError(backendMessage || "Impossible de soumettre le quiz. Veuillez réessayer.");
    } finally {
      setIsSubmitting(false);
    }
  };

  useEffect(() => {
    if (submitted || isSubmitting || !quizStarted || !quizStartTime || questions.length === 0) {
      return;
    }

    const interval = setInterval(() => {
      const elapsedSeconds = Math.max(0, Math.floor((Date.now() - quizStartTime) / 1000));
      const remaining = Math.max(0, (totalQuizTimeSeconds || QUIZ_DURATION_SECONDS) - elapsedSeconds);

      setTimeLeftSeconds(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
        handleSubmit(true);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [submitted, isSubmitting, quizStarted, quizStartTime, totalQuizTimeSeconds, questions.length]);

  useEffect(() => {
    if (!sessionStorageKey) return;
    if (submitted) {
      localStorage.removeItem(sessionStorageKey);
      return;
    }

    const sessionSnapshot = {
      jobId,
      questions,
      questionOrder,
      answers,
      responseHistory,
      quizStarted,
      quizStartTime,
      currentPageStartedAt,
      totalQuizTimeSeconds,
      timeLeftSeconds,
      currentPage,
      hasMoreAdaptivePages,
      totalQuestionTarget,
      submitted,
      savedAt: Date.now(),
    };

    localStorage.setItem(sessionStorageKey, JSON.stringify(sessionSnapshot));
  }, [
    sessionStorageKey,
    submitted,
    jobId,
    questions,
    questionOrder,
    answers,
    responseHistory,
    quizStarted,
    quizStartTime,
    currentPageStartedAt,
    totalQuizTimeSeconds,
    timeLeftSeconds,
    currentPage,
    hasMoreAdaptivePages,
    totalQuestionTarget,
  ]);

  const answeredCount = questions.reduce(
    (count, question, idx) => (isQuestionAnswered(question, answers[idx]) ? count + 1 : count),
    0
  );

  const progressPercentage = questions.length ? Math.floor((answeredCount / questions.length) * 100) : 0;
  const minutes = Math.floor(timeLeftSeconds / 60);
  const seconds = timeLeftSeconds % 60;
  const formattedTime = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  const isTimeWarning = timeLeftSeconds <= 180;
  const isTimeCritical = timeLeftSeconds <= 60;
  let timerUrgencyClass = "";
  if (isTimeCritical) {
    timerUrgencyClass = "critical";
  } else if (isTimeWarning) {
    timerUrgencyClass = "warning";
  }
  const totalMinutes = Math.floor(totalQuizTimeSeconds / 60);
  const totalSeconds = totalQuizTimeSeconds % 60;
  const formattedTotalTime = `${String(totalMinutes).padStart(2, "0")}:${String(totalSeconds).padStart(2, "0")}`;
  const totalPages = Math.max(1, Math.ceil(questions.length / QUESTIONS_PER_PAGE));
  const currentPageSafe = Math.min(currentPage, totalPages);
  const pageStartIndex = (currentPageSafe - 1) * QUESTIONS_PER_PAGE;
  const pageEndIndex = pageStartIndex + QUESTIONS_PER_PAGE;
  const visibleQuestions = questions.slice(pageStartIndex, pageEndIndex);
  const isLastPage = currentPageSafe === totalPages && !hasMoreAdaptivePages;
  const isMistralCoach = aiCoach?.summary?.coachEngine === "mistral-llm";
  const hasGoodScore = submitted && score >= Math.max(1, passingScore || Math.ceil((questions?.length || 0) / 2));
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
      const reason = error?.response?.data?.reason;
      if (reason === "quiz-already-completed") {
        setSubmitError(QUIZ_LOCKED_MESSAGE);
      } else {
        setSubmitError("Impossible de charger la page suivante du quiz.");
      }
    } finally {
      setIsLoadingNextPage(false);
    }
  };

  const goToPreviousPage = () => {
    setCurrentPage((prev) => Math.max(prev - 1, 1));
    setCurrentPageStartedAt(Date.now());
  };

  return (
    <div id="quiz-container-secure" className="quiz-container">
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
          <div className={`quiz-timer ${timerUrgencyClass}`}>
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
                q.options.map((opt, optionIndex) => {
                  const optionKey = `${key}-${optionIndex}`;
                  const isSelected = answers[globalIndex] === optionIndex;
                  const displayOptionText = String(opt || "").trim() || `Option ${optionIndex + 1}`;
                  return (
                    <label className={`option ${isSelected ? "selected" : ""}`} key={optionKey}>
                      <span className="option-text">{displayOptionText}</span>
                      <input
                        type="radio"
                        name={`question-${globalIndex}`}
                        checked={isSelected}
                        onChange={() => handleAnswer(globalIndex, optionIndex)}
                      />
                    </label>
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
          {hasGoodScore && (
            <p className="application-success-message">
              Votre candidature a ete effectuee avec succes. Nous vous contacterons prochainement.
            </p>
          )}
          {aiCoach && isMistralCoach && (
            <div className="quiz-coach-card">
              <h5>{aiCoach?.summary?.coachTitle || "AI Coach (Mistral)"}</h5>
              {aiCoach?.summary?.hiringPerspective && (
                <p className="quiz-coach-metric">{aiCoach.summary.hiringPerspective}</p>
              )}
              <p className="quiz-coach-summary">{aiCoach?.summary?.narrative}</p>
              {typeof aiCoach?.summary?.openAnswerAverage === "number" && (
                <p className="quiz-coach-metric">Open Answers Average: <strong>{aiCoach.summary.openAnswerAverage}/100</strong></p>
              )}

              {Array.isArray(aiCoach?.summary?.actionPlan) && aiCoach.summary.actionPlan.length > 0 && (
                <div className="quiz-coach-section">
                  <h6>Plan d'action pour ce poste</h6>
                  {aiCoach.summary.actionPlan.map((tip, index) => (
                    <div key={`action-plan-${index}`} className="quiz-coach-sub">• {tip}</div>
                  ))}
                </div>
              )}

              {Array.isArray(aiCoach?.summary?.futureApplicationTips) && aiCoach.summary.futureApplicationTips.length > 0 && (
                <div className="quiz-coach-section">
                  <h6>Coaching pour votre prochaine candidature</h6>
                  {aiCoach.summary.futureApplicationTips.map((tip, index) => (
                    <div key={`future-tip-${index}`} className="quiz-coach-sub">• {tip}</div>
                  ))}
                </div>
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
          {aiCoach && !isMistralCoach && (
            <div className="quiz-start-card">
              <p className="quiz-empty-state">Le feedback AI Mistral est indisponible pour cette tentative.</p>
            </div>
          )}
          <p className="redirect-message">🙏 Merci pour vos réponses. Utilisez ce coaching pour mieux vous préparer à ce poste et à vos prochaines candidatures.</p>
          <div className="quiz-navigation">
            <button className="start-btn" onClick={() => navigate("/")}>Retour à l'accueil</button>
          </div>
        </div>
      ) : null}
    </div>
  );
  
  
};

export default QuizPage;
