/**
 * recruiterReportService.js
 *
 * Builds the complete recruiter report for a finished AI interview session.
 *
 * Rules enforced throughout:
 *  - The AI must not automatically reject a candidate.
 *  - The recruiter is the final decision-maker.
 *  - No emotion, stress, honesty, personality, race, gender, age,
 *    disability, or mental-state inference.
 *  - Only objective language: "integrity risk", "needs review",
 *    "visual signals".
 */

'use strict';

const fetch = (() => {
  try { return require('node-fetch'); } catch { return null; }
})();

// ─── Scoring weights (out of 100 total) ───────────────────────────────────────
const MAX_SCORES = {
  technical: 40,
  communication: 20,
  experience: 20,
  behavior: 10,
  integrity: 10,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(n)));

/** Parse a date or return null. */
const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatDate = (v) => {
  const d = parseDate(v);
  return d ? d.toISOString() : '';
};

/** Duration in seconds between two timestamps. Returns 0 on bad input. */
const durationSeconds = (start, end) => {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) return 0;
  return Math.max(0, Math.round((e - s) / 1000));
};

/** Safe string cast. */
const str = (v, fallback = '') => (v != null ? String(v) : fallback);

/** Very small LLM JSON extractor — strips markdown fences. */
const safeParseJson = (text, fallback = {}) => {
  if (!text) return fallback;
  if (typeof text === 'object') return text;
  const clean = String(text).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(clean); } catch { return fallback; }
};

// ─── Vision helpers ───────────────────────────────────────────────────────────

function extractVisionMetrics(room) {
  const vision = room.visionMonitoring || {};
  const summary = vision.summary || {};
  const events = Array.isArray(vision.events) ? vision.events : [];
  const integrityEvents = Array.isArray(room.integrityEvents) ? room.integrityEvents : [];

  const totalChecks = Number(summary.totalChecks || 0);
  const faceDetectedChecks = Number(summary.faceDetectedChecks || 0);
  const facePresencePercentage = totalChecks > 0
    ? clamp(Math.round((faceDetectedChecks / totalChecks) * 100), 0, 100)
    : 100;

  const byType = (arr, type) => arr.filter(e => e.type === type);

  const lookingAwayEvents = byType(events, 'LOOKING_AWAY_LONG');
  const lookingAwayTotalSeconds = lookingAwayEvents.reduce(
    (sum, e) => sum + Math.max(0, Number(e.durationMs || 0) / 1000), 0
  );

  const multiplePeopleEvents =
    byType(events, 'MULTIPLE_FACES_DETECTED').length +
    byType(integrityEvents, 'MULTIPLE_PEOPLE').length;

  const phoneDetections = byType(integrityEvents, 'PHONE_VISIBLE').length;
  const referenceMaterialDetections = byType(integrityEvents, 'REFERENCE_MATERIAL_VISIBLE').length;
  const additionalScreenDetections = byType(integrityEvents, 'SCREEN_DEVICE_VISIBLE').length;
  const cameraBlockedEvents = byType(events, 'CAMERA_BLOCKED').length;
  const tabSwitchCount = byType(events, 'TAB_SWITCH').length;
  const fullscreenExitCount = byType(events, 'FULLSCREEN_EXIT').length;
  const poorLightingEvents = byType(events, 'POOR_LIGHTING').length;

  const lightingQuality = poorLightingEvents === 0
    ? 'Good'
    : poorLightingEvents <= 2 ? 'Acceptable' : 'Poor';

  // Risk score (max 100)
  let riskScore = 0;
  riskScore += byType(events, 'NO_FACE_DETECTED').length * 15;
  riskScore += multiplePeopleEvents * 25;
  riskScore += lookingAwayEvents.length * 10;
  riskScore += cameraBlockedEvents * 20;
  riskScore += tabSwitchCount * 10;
  riskScore += fullscreenExitCount * 10;
  riskScore += poorLightingEvents * 5;
  riskScore += phoneDetections * 15;
  riskScore += referenceMaterialDetections * 8;
  riskScore += additionalScreenDetections * 15;
  riskScore = clamp(riskScore, 0, 100);

  const riskLevel = riskScore >= 66 ? 'high' : riskScore >= 31 ? 'medium' : 'low';

  // Flagged moments for timeline
  const flaggedMoments = [...events, ...integrityEvents]
    .filter(e => ['NO_FACE_DETECTED', 'MULTIPLE_FACES_DETECTED', 'MULTIPLE_PEOPLE',
      'LOOKING_AWAY_LONG', 'CAMERA_BLOCKED', 'TAB_SWITCH', 'FULLSCREEN_EXIT',
      'PHONE_VISIBLE', 'REFERENCE_MATERIAL_VISIBLE', 'SCREEN_DEVICE_VISIBLE'].includes(e.type))
    .map(e => ({
      timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : '',
      type: str(e.type),
      severity: str(e.severity, 'info'),
      durationSeconds: Math.round(Math.max(0, Number(e.durationMs || 0) / 1000 || Number(e.durationSeconds || 0))),
      questionId: str(e.questionId),
    }))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const summaryParts = [];
  if (lookingAwayEvents.length > 0) summaryParts.push(`${lookingAwayEvents.length} looking-away signal(s).`);
  if (multiplePeopleEvents > 0) summaryParts.push(`${multiplePeopleEvents} multiple-person signal(s).`);
  if (tabSwitchCount > 0) summaryParts.push(`Browser focus changed ${tabSwitchCount} time(s).`);
  if (phoneDetections > 0) summaryParts.push(`${phoneDetections} phone/device detection(s).`);
  if (referenceMaterialDetections > 0) summaryParts.push(`${referenceMaterialDetections} reference material detection(s).`);
  if (additionalScreenDetections > 0) summaryParts.push(`${additionalScreenDetections} additional screen detection(s).`);

  return {
    riskLevel,
    riskScore,
    facePresencePercentage,
    lookingAwayTotalSeconds: Math.round(lookingAwayTotalSeconds),
    multiplePeopleEvents,
    phoneDetections,
    referenceMaterialDetections,
    additionalScreenDetections,
    cameraBlockedEvents,
    lightingQuality,
    tabSwitchCount,
    fullscreenExitCount,
    flaggedMoments,
    summary: summaryParts.length > 0
      ? `Visual signals for recruiter review: ${summaryParts.join(' ')}`
      : 'No significant visual signals were detected during this interview.',
  };
}

// ─── Score calculation ────────────────────────────────────────────────────────

function calculateScores(room, visionMetrics) {
  const messages = Array.isArray(room.messages) ? room.messages : [];
  const agentSnap = room.agentSnapshot || {};

  // Technical: from agentSnapshot evaluation if available
  let technicalScore = MAX_SCORES.technical;
  if (agentSnap.evaluationScore != null) {
    technicalScore = clamp(Number(agentSnap.evaluationScore) * (MAX_SCORES.technical / 100));
  } else if (agentSnap.technicalScore != null) {
    technicalScore = clamp(Number(agentSnap.technicalScore));
  } else {
    // Heuristic: count non-empty candidate messages
    const candidateMessages = messages.filter(m => m.role === 'candidate' && String(m.text || '').trim().length > 30);
    const ratio = Math.min(1, candidateMessages.length / Math.max(1, messages.filter(m => m.role === 'agent').length));
    technicalScore = clamp(ratio * MAX_SCORES.technical * 0.8 + MAX_SCORES.technical * 0.2);
  }

  // Communication: based on word count and response quality
  const candidateTexts = messages.filter(m => m.role === 'candidate').map(m => str(m.text));
  const totalWords = candidateTexts.reduce((sum, t) => sum + t.split(/\s+/).filter(Boolean).length, 0);
  const avgWordsPerAnswer = candidateTexts.length > 0 ? totalWords / candidateTexts.length : 0;
  const communicationScore = clamp(
    Math.min(MAX_SCORES.communication, (avgWordsPerAnswer / 80) * MAX_SCORES.communication)
  );

  // Experience match: from agentSnapshot or transcript keywords
  let experienceScore = Math.round(MAX_SCORES.experience * 0.6); // default neutral
  if (agentSnap.experienceScore != null) {
    experienceScore = clamp(Number(agentSnap.experienceScore));
  }

  // Behavior & attention: inverse of vision risk
  const behaviorScore = clamp(
    MAX_SCORES.behavior - Math.round((visionMetrics.riskScore / 100) * MAX_SCORES.behavior)
  );

  // Integrity: inverse of vision risk score (not emotion — purely objective signals)
  const integrityScore = clamp(
    MAX_SCORES.integrity - Math.round((visionMetrics.riskScore / 100) * MAX_SCORES.integrity)
  );

  const totalScore = technicalScore + communicationScore + experienceScore + behaviorScore + integrityScore;

  return {
    technicalScore: clamp(technicalScore, 0, MAX_SCORES.technical),
    communicationScore: clamp(communicationScore, 0, MAX_SCORES.communication),
    experienceMatchScore: clamp(experienceScore, 0, MAX_SCORES.experience),
    behaviorScore: clamp(behaviorScore, 0, MAX_SCORES.behavior),
    integrityScore: clamp(integrityScore, 0, MAX_SCORES.integrity),
    totalScore: clamp(totalScore, 0, 100),
  };
}

// ─── Question evaluations ─────────────────────────────────────────────────────

function buildQuestionEvaluations(room) {
  const messages = Array.isArray(room.messages) ? room.messages : [];
  if (messages.length === 0) return [];

  const pairs = [];
  let lastAgentMsg = null;
  let questionIndex = 0;

  for (const msg of messages) {
    if (msg.role === 'agent') {
      lastAgentMsg = msg;
    } else if (msg.role === 'candidate' && lastAgentMsg) {
      questionIndex++;
      const questionText = str(lastAgentMsg.text).trim();
      const answerText = str(msg.text).trim();
      const wordCount = answerText.split(/\s+/).filter(Boolean).length;

      // Simple heuristic scoring
      const rawScore = Math.min(10, Math.max(1, Math.round(
        2 + (wordCount / 25) + (answerText.length > 100 ? 2 : 0) + (answerText.length > 200 ? 1 : 0)
      )));

      const answerQuality = rawScore >= 8 ? 'good' : rawScore >= 5 ? 'average' : 'weak';

      // Detect category from question text
      const lq = questionText.toLowerCase();
      let category = 'General';
      if (/experience|background|worked|previous|years/i.test(lq)) category = 'Experience';
      else if (/technical|code|implement|algorithm|architect|design/i.test(lq)) category = 'Technical';
      else if (/team|colleague|conflict|communication|collaborate/i.test(lq)) category = 'Communication';
      else if (/challenge|difficult|problem|solve|issue/i.test(lq)) category = 'Problem Solving';
      else if (/motivat|goal|career|aspir|why/i.test(lq)) category = 'Motivation';

      // Simple skill detection
      const skillPatterns = [
        /\b(react|vue|angular|javascript|typescript|node|python|java|sql|mongodb|aws|docker|kubernetes|git|agile|scrum|rest|api|machine learning|ai|ml|devops|ci\/cd)\b/gi,
      ];
      const detectedSkills = [];
      for (const pattern of skillPatterns) {
        const matches = answerText.match(pattern) || [];
        detectedSkills.push(...matches.map(s => s.toLowerCase()));
      }

      pairs.push({
        questionId: `Q${questionIndex}`,
        question: questionText,
        answer: answerText,
        category,
        score: rawScore,
        feedback: rawScore >= 8
          ? 'Response was detailed and well-structured.'
          : rawScore >= 5
            ? 'Response addressed the question but could have included more detail.'
            : 'Response was brief and may benefit from further elaboration.',
        detectedSkills: [...new Set(detectedSkills)],
        answerQuality,
      });
      lastAgentMsg = null;
    }
  }

  return pairs;
}

// ─── Technical skills analysis ────────────────────────────────────────────────

function buildTechnicalAnalysis(room, questionEvaluations) {
  const job = room.job || {};
  const jobSkills = Array.isArray(job.skills) ? job.skills.map(s => String(s).toLowerCase()) : [];

  const allDetected = [...new Set(
    questionEvaluations.flatMap(q => q.detectedSkills)
  )];

  const matchedSkills = allDetected.filter(s => jobSkills.includes(s));
  const missingSkills = jobSkills.filter(s => !allDetected.includes(s));
  const strongSkills = questionEvaluations
    .filter(q => q.answerQuality === 'good' && q.detectedSkills.length > 0)
    .flatMap(q => q.detectedSkills);
  const weakSkills = questionEvaluations
    .filter(q => q.answerQuality === 'weak' && q.detectedSkills.length > 0)
    .flatMap(q => q.detectedSkills);

  return {
    detectedSkills: allDetected,
    matchedSkills: [...new Set(matchedSkills)],
    missingSkills: [...new Set(missingSkills)],
    strengths: [...new Set(strongSkills)],
    weaknesses: [...new Set(weakSkills)],
  };
}

// ─── Communication analysis ───────────────────────────────────────────────────

function buildCommunicationAnalysis(room, questionEvaluations) {
  const messages = Array.isArray(room.messages) ? room.messages : [];
  const candidateMsgs = messages.filter(m => m.role === 'candidate');

  const totalWords = candidateMsgs.reduce(
    (sum, m) => sum + str(m.text).split(/\s+/).filter(Boolean).length, 0
  );
  const avgWords = candidateMsgs.length > 0 ? Math.round(totalWords / candidateMsgs.length) : 0;

  const goodAnswers = questionEvaluations.filter(q => q.answerQuality === 'good').length;
  const totalAnswers = questionEvaluations.length || 1;

  const clarityScore = Math.round(60 + (goodAnswers / totalAnswers) * 40);
  const relevanceScore = Math.round(55 + (avgWords > 40 ? 30 : (avgWords / 40) * 30) + (goodAnswers / totalAnswers) * 15);

  const score = clamp(
    Math.round((clarityScore + relevanceScore) / 2 * (MAX_SCORES.communication / 100))
  );

  return {
    clarity: clarityScore >= 80 ? 'Clear and articulate' : clarityScore >= 60 ? 'Generally clear' : 'Clarity needs improvement',
    relevance: relevanceScore >= 80 ? 'Highly relevant answers' : relevanceScore >= 60 ? 'Mostly relevant' : 'Some answers need more focus',
    structure: goodAnswers >= totalAnswers * 0.7 ? 'Well-structured responses' : 'Responses could benefit from better structure',
    completeness: avgWords >= 60 ? 'Comprehensive answers provided' : avgWords >= 30 ? 'Adequate detail in most answers' : 'Answers were brief',
    examplesQuality: goodAnswers >= 2 ? 'Supported answers with relevant examples' : 'Limited use of concrete examples',
    summary: `Candidate provided ${candidateMsgs.length} response(s) with an average of ${avgWords} words per answer.`,
    score: clamp(score, 0, MAX_SCORES.communication),
  };
}

// ─── AI notes ─────────────────────────────────────────────────────────────────

function buildAIInterviewerNotes(room, questionEvaluations, visionMetrics) {
  const goodQs = questionEvaluations.filter(q => q.answerQuality === 'good');
  const weakQs = questionEvaluations.filter(q => q.answerQuality === 'weak');
  const totalQs = questionEvaluations.length;

  const agentSnap = room.agentSnapshot || {};

  const summary = str(agentSnap.summary) ||
    (totalQs === 0
      ? 'No conversation history was available for analysis.'
      : `The candidate responded to ${totalQs} question(s). ${goodQs.length} answer(s) were rated as high quality.`);

  const strengths = Array.isArray(agentSnap.strengths) && agentSnap.strengths.length > 0
    ? agentSnap.strengths
    : goodQs.map(q => `Strong response on "${q.category}" topic`).slice(0, 3);

  const weaknesses = Array.isArray(agentSnap.weaknesses) && agentSnap.weaknesses.length > 0
    ? agentSnap.weaknesses
    : weakQs.map(q => `Limited detail in "${q.category}" response`).slice(0, 3);

  if (strengths.length === 0) strengths.push('Candidate engaged with all questions presented.');
  if (weaknesses.length === 0) weaknesses.push('No specific performance gaps identified from transcript.');

  const followUpCategories = [...new Set(weakQs.map(q => q.category))];
  const recommendedFollowUpQuestions = followUpCategories.map(
    cat => `Consider asking a follow-up question on "${cat}" to assess depth of knowledge.`
  );
  if (recommendedFollowUpQuestions.length === 0) {
    recommendedFollowUpQuestions.push('Consider reviewing technical skills in a follow-up conversation.');
  }

  return { summary, strengths, weaknesses, recommendedFollowUpQuestions };
}

// ─── Final recommendation ─────────────────────────────────────────────────────

function buildFinalRecommendation(scores, visionMetrics, room) {
  const { totalScore } = scores;

  let status;
  if (totalScore >= 75 && visionMetrics.riskLevel === 'low') {
    status = 'recommended';
  } else if (totalScore < 50 || visionMetrics.riskLevel === 'high') {
    status = 'not_recommended';
  } else {
    status = 'needs_review';
  }

  const explanations = {
    recommended: `The candidate achieved an overall score of ${totalScore}/100 with low integrity risk signals. The recruiter may consider proceeding to the next stage.`,
    needs_review: `The candidate achieved an overall score of ${totalScore}/100. Some areas or visual signals require recruiter review before a decision.`,
    not_recommended: `The candidate achieved an overall score of ${totalScore}/100. Multiple areas may benefit from further assessment. The recruiter should review before making any decision.`,
  };

  const nextSteps = {
    recommended: 'Review the transcript and schedule a human interviewer follow-up session.',
    needs_review: 'Review flagged moments, transcript, and technical scores before deciding.',
    not_recommended: 'Consult the full report and transcript before making any decision. Do not rely solely on AI signals.',
  };

  return {
    status,
    overallScore: totalScore,
    summary: explanations[status],
    nextStep: nextSteps[status],
  };
}

// ─── Main builder ─────────────────────────────────────────────────────────────

function buildRecruiterReport(room) {
  if (!room) throw new Error('room is required');

  const candidate = room.candidate || {};
  const job = room.job || {};

  const durationSec = durationSeconds(room.recordingStartedAt, room.recordingEndedAt);
  const durationLabel = durationSec > 0
    ? `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`
    : 'Unknown';

  const visionMetrics = extractVisionMetrics(room);
  const questionEvaluations = buildQuestionEvaluations(room);
  const scores = calculateScores(room, visionMetrics);
  const technicalAnalysis = buildTechnicalAnalysis(room, questionEvaluations);
  const communicationAnalysis = buildCommunicationAnalysis(room, questionEvaluations);
  const aiNotes = buildAIInterviewerNotes(room, questionEvaluations, visionMetrics);
  const finalRecommendation = buildFinalRecommendation(scores, visionMetrics, room);

  return {
    generatedAt: new Date().toISOString(),
    candidateInfo: {
      candidateId: str(candidate._id || candidate),
      candidateName: [candidate.firstName, candidate.lastName].filter(Boolean).join(' ') || candidate.email || 'Unknown',
      jobTitle: str(job.title, 'Not specified'),
      interviewDate: formatDate(room.recordingStartedAt || room.createdAt),
      duration: durationLabel,
      interviewStatus: str(room.status, 'unknown'),
    },
    finalRecommendation,
    scoreBreakdown: scores,
    questionEvaluations,
    technicalAnalysis,
    communicationAnalysis,
    visionIntegrityReport: {
      riskLevel: visionMetrics.riskLevel,
      facePresencePercentage: visionMetrics.facePresencePercentage,
      lookingAwayTotalSeconds: visionMetrics.lookingAwayTotalSeconds,
      multiplePeopleEvents: visionMetrics.multiplePeopleEvents,
      phoneDetections: visionMetrics.phoneDetections,
      referenceMaterialDetections: visionMetrics.referenceMaterialDetections,
      additionalScreenDetections: visionMetrics.additionalScreenDetections,
      cameraBlockedEvents: visionMetrics.cameraBlockedEvents,
      lightingQuality: visionMetrics.lightingQuality,
      tabSwitchCount: visionMetrics.tabSwitchCount,
      fullscreenExitCount: visionMetrics.fullscreenExitCount,
      summary: visionMetrics.summary,
      flaggedMoments: visionMetrics.flaggedMoments,
    },
    aiInterviewerNotes: aiNotes,
    recruiterDecision: room.recruiterDecision || {
      status: 'pending',
      notes: '',
      decidedAt: '',
    },
  };
}

// ─── Mock report for testing / fallback ──────────────────────────────────────

function buildMockRecruiterReport() {
  const now = new Date().toISOString();
  return {
    generatedAt: now,
    candidateInfo: {
      candidateId: 'mock-001',
      candidateName: 'Demo Candidate',
      jobTitle: 'Full Stack Engineer',
      interviewDate: now,
      duration: '18m 34s',
      interviewStatus: 'ended',
    },
    finalRecommendation: {
      status: 'needs_review',
      overallScore: 67,
      summary: 'The candidate achieved a score of 67/100. Some areas require recruiter review.',
      nextStep: 'Review flagged moments, transcript, and technical scores before deciding.',
    },
    scoreBreakdown: {
      technicalScore: 28,
      communicationScore: 14,
      experienceMatchScore: 13,
      behaviorScore: 7,
      integrityScore: 8,
      totalScore: 67,
    },
    questionEvaluations: [
      {
        questionId: 'Q1',
        question: 'Can you describe your experience with React?',
        answer: 'I have been working with React for 3 years, building complex SPAs with hooks and context.',
        category: 'Technical',
        score: 8,
        feedback: 'Response was detailed and well-structured.',
        detectedSkills: ['react', 'hooks'],
        answerQuality: 'good',
      },
      {
        questionId: 'Q2',
        question: 'Tell me about a challenging project.',
        answer: 'I worked on a migration project.',
        category: 'Problem Solving',
        score: 4,
        feedback: 'Response was brief and may benefit from further elaboration.',
        detectedSkills: [],
        answerQuality: 'weak',
      },
    ],
    technicalAnalysis: {
      detectedSkills: ['react', 'hooks', 'javascript'],
      matchedSkills: ['react', 'javascript'],
      missingSkills: ['typescript', 'node'],
      strengths: ['react', 'hooks'],
      weaknesses: [],
    },
    communicationAnalysis: {
      clarity: 'Generally clear',
      relevance: 'Mostly relevant',
      structure: 'Responses could benefit from better structure',
      completeness: 'Adequate detail in most answers',
      examplesQuality: 'Limited use of concrete examples',
      summary: 'Candidate provided 2 response(s) with an average of 32 words per answer.',
      score: 14,
    },
    visionIntegrityReport: {
      riskLevel: 'medium',
      facePresencePercentage: 87,
      lookingAwayTotalSeconds: 12,
      multiplePeopleEvents: 0,
      phoneDetections: 1,
      referenceMaterialDetections: 0,
      additionalScreenDetections: 0,
      cameraBlockedEvents: 0,
      lightingQuality: 'Good',
      tabSwitchCount: 2,
      fullscreenExitCount: 1,
      summary: 'Visual signals for recruiter review: 1 phone/device detection(s). Browser focus changed 2 time(s).',
      flaggedMoments: [
        { timestamp: now, type: 'PHONE_VISIBLE', severity: 'medium', durationSeconds: 3, questionId: 'Q1' },
        { timestamp: now, type: 'TAB_SWITCH', severity: 'medium', durationSeconds: 0, questionId: 'Q2' },
      ],
    },
    aiInterviewerNotes: {
      summary: 'The candidate responded to 2 question(s). 1 answer was rated as high quality.',
      strengths: ['Strong response on "Technical" topic'],
      weaknesses: ['Limited detail in "Problem Solving" response'],
      recommendedFollowUpQuestions: [
        'Consider asking a follow-up question on "Problem Solving" to assess depth of knowledge.',
      ],
    },
    recruiterDecision: {
      status: 'pending',
      notes: '',
      decidedAt: '',
    },
  };
}

module.exports = {
  buildRecruiterReport,
  buildMockRecruiterReport,
};
