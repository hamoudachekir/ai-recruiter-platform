/**
 * Quiz Security Validation Middleware
 * Validates quiz submissions for suspicious patterns and anti-cheating measures
 */

const validateQuizSubmission = (req, res, next) => {
  if (process.env.QUIZ_SECURITY_ENABLED === 'false') {
    return next();
  }

  const { timeSpentSeconds = 0, answers = {}, answersByQuestionKey = {} } = req.body;

  // Get submission metadata from request
  const submissionMetadata = {
    ipAddress: req.ip || req.connection.remoteAddress,
    userAgent: req.get('user-agent'),
    focusLossCount: req.body.focusLossCount || 0,
    copyPasteAttempts: req.body.copyPasteAttempts || 0,
    devToolsAccess: req.body.devToolsAccess || false,
    totalQuestions: req.body.totalQuestions || 0,
    focusLossEvents: req.body.focusLossEvents || [],
    securityEvents: req.body.securityEvents || [],
  };

  // ===== VALIDATION 1: Minimum Time Check =====
  // By default we flag suspicious speed but do not block submission.
  // To enforce a hard block, set QUIZ_ENFORCE_MIN_TIME=true.
  const minTimeSeconds = Number.parseInt(process.env.QUIZ_MIN_TIME_SECONDS || '60', 10);
  const enforceMinTime = String(process.env.QUIZ_ENFORCE_MIN_TIME || 'false').toLowerCase() === 'true';
  const isTooQuick = timeSpentSeconds < minTimeSeconds && timeSpentSeconds > 0;

  if (enforceMinTime && isTooQuick) {
    return res.status(400).json({
      success: false,
      message: `Quiz submission too quick. Minimum ${minTimeSeconds} seconds required. You submitted in ${timeSpentSeconds} seconds.`,
      validationFailed: 'minimum-time',
      timeSpentSeconds,
      minTimeRequired: minTimeSeconds,
    });
  }

  // ===== VALIDATION 2: Average Time Per Question =====
  const avgTimePerQuestion = submissionMetadata.totalQuestions > 0
    ? timeSpentSeconds / submissionMetadata.totalQuestions
    : 0;

  const avgTimeThreshold = Number.parseFloat(process.env.QUIZ_AVG_TIME_PER_QUESTION_THRESHOLD || '3');

  const submissionValidation = {
    totalTimeValid: timeSpentSeconds >= minTimeSeconds,
    averageTimePerQuestion: avgTimePerQuestion,
    duplicateAnswerCount: countDuplicateAnswers(answers, answersByQuestionKey),
    flagged: false,
    flagReason: null,
  };

  // ===== VALIDATION 3: Suspicious Pattern Detection =====
  const submissionFlags = [];

  // Fast completion detection
  if (avgTimePerQuestion < avgTimeThreshold && submissionMetadata.totalQuestions > 0) {
    submissionFlags.push({
      flag: 'fast-completion',
      severity: 'high',
      details: `Average ${avgTimePerQuestion.toFixed(2)}s per question (threshold: ${avgTimeThreshold}s)`,
    });
    submissionValidation.flagged = true;
    submissionValidation.flagReason = 'fast-completion';
  }

  if (isTooQuick) {
    submissionFlags.push({
      flag: 'minimum-time-warning',
      severity: 'medium',
      details: `Submitted in ${timeSpentSeconds}s (minimum configured: ${minTimeSeconds}s)`,
    });
    if (!submissionValidation.flagReason) {
      submissionValidation.flagged = true;
      submissionValidation.flagReason = 'minimum-time-warning';
    }
  }

  // Multiple focus losses
  const maxFocusLosses = Number.parseInt(process.env.QUIZ_MAX_FOCUS_LOSSES_THRESHOLD || '3', 10);
  if (submissionMetadata.focusLossCount > maxFocusLosses) {
    submissionFlags.push({
      flag: 'multiple-focus-losses',
      severity: 'medium',
      details: `${submissionMetadata.focusLossCount} focus losses detected`,
    });
    if (submissionMetadata.focusLossCount > maxFocusLosses + 3) {
      submissionValidation.flagged = true;
      submissionValidation.flagReason = 'multiple-focus-losses';
    }
  }

  // Copy-paste or DevTools access
  if (submissionMetadata.copyPasteAttempts > 0) {
    submissionFlags.push({
      flag: 'copy-paste-attempts',
      severity: 'high',
      details: `${submissionMetadata.copyPasteAttempts} copy/paste attempts`,
    });
    if (submissionMetadata.copyPasteAttempts > 2) {
      submissionValidation.flagged = true;
      submissionValidation.flagReason = 'copy-paste-attempts';
    }
  }

  if (submissionMetadata.devToolsAccess) {
    submissionFlags.push({
      flag: 'devtools-access',
      severity: 'high',
      details: 'DevTools accessed during quiz',
    });
    submissionValidation.flagged = true;
    submissionValidation.flagReason = 'devtools-access';
  }

  // High duplicate answer rate
  const duplicateRate = submissionMetadata.totalQuestions > 0
    ? submissionValidation.duplicateAnswerCount / submissionMetadata.totalQuestions
    : 0;

  if (duplicateRate > 0.5) {
    submissionFlags.push({
      flag: 'suspicious-pattern',
      severity: 'medium',
      details: `${(duplicateRate * 100).toFixed(0)}% duplicate answers`,
    });
    if (duplicateRate > 0.7) {
      submissionValidation.flagged = true;
      submissionValidation.flagReason = 'suspicious-pattern';
    }
  }

  // Store everything in request for later use in submit-quiz endpoint
  req.submissionMetadata = submissionMetadata;
  req.submissionValidation = submissionValidation;
  req.submissionFlags = submissionFlags;

  // Log flags for admin review (don't block, just flag)
  if (submissionFlags.length > 0) {
    console.warn(`⚠️ Quiz submission flagged for ${req.body.candidateId}:`, submissionFlags);
  }

  next();
};

/**
 * Count duplicate answers in submission
 */
function countDuplicateAnswers(answers, answersByQuestionKey) {
  const keyedValues = Object.values(answersByQuestionKey || {});
  const legacyValues = Object.values(answers || {});
  const allAnswers = keyedValues.length > 0 ? keyedValues : legacyValues;

  if (allAnswers.length === 0) return 0;

  const answerCounts = {};
  let duplicateCount = 0;

  allAnswers.forEach((answer) => {
    const normalized = String(answer || '').toLowerCase().trim();
    answerCounts[normalized] = (answerCounts[normalized] || 0) + 1;
  });

  // Count answers that appear more than once
  Object.values(answerCounts).forEach((count) => {
    if (count > 1) {
      duplicateCount += count - 1; // Subtract 1 for the first occurrence
    }
  });

  return duplicateCount;
}

module.exports = validateQuizSubmission;
