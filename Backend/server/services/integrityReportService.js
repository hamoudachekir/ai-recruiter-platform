const fetch = require('node-fetch');

const getReportProvider = () => String(process.env.INTEGRITY_REPORT_LLM_PROVIDER || 'disabled').trim().toLowerCase();

const SCORE_WEIGHTS = {
  // MediaPipe events
  NO_FACE: 15,
  NO_FACE_DETECTED: 15,
  MULTIPLE_PEOPLE: 25,
  MULTIPLE_FACES_DETECTED: 25,
  LOOKING_AWAY_LONG: 10,
  CAMERA_BLOCKED: 20,
  TAB_SWITCH: 10,
  FULLSCREEN_EXIT: 10,
  BAD_LIGHTING: 5,
  POOR_LIGHTING: 5,
  FACE_TOO_FAR: 5,
  BAD_FACE_DISTANCE: 5,
  
  // YOLO events
  PHONE_VISIBLE: 15,
  REFERENCE_MATERIAL_VISIBLE: 8,
  SCREEN_DEVICE_VISIBLE: 15,
  NO_PERSON_VISIBLE: 12,
};

const normalizeLevel = (score) => {
  if (score >= 66) return 'high';
  if (score >= 31) return 'medium';
  return 'low';
};

const safeJsonParse = (value, fallback = null) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  const text = String(value).trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const seconds = (value) => Math.max(0, Number(value || 0));

function calculateIntegrityMetrics({ room, events }) {
  const summary = room?.visionMonitoring?.summary || {};
  const yoloSummary = room?.visionMonitoring?.yoloSummary || {};
  const totalChecks = Number(summary.totalChecks || 0);
  const faceDetectedChecks = Number(summary.faceDetectedChecks || 0);
  const facePresencePercentage = totalChecks > 0
    ? Math.round((faceDetectedChecks / totalChecks) * 100)
    : 0;

  const eventsByType = events.reduce((acc, event) => {
    const type = String(event.type || '');
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});

  const lookingAwayTotalSeconds = events
    .filter((event) => event.type === 'LOOKING_AWAY_LONG')
    .reduce((sum, event) => sum + seconds(event.durationSeconds), 0);

  const noFaceTotalSeconds = events
    .filter((event) => event.type === 'NO_FACE' || event.type === 'NO_FACE_DETECTED' || event.type === 'NO_PERSON_VISIBLE')
    .reduce((sum, event) => sum + seconds(event.durationSeconds), 0);

  // Calculate risk score with YOLO weights
  const riskScore = Math.min(100, events.reduce((sum, event) => {
    const type = String(event.type || '');
    return sum + Number(SCORE_WEIGHTS[type] || 0);
  }, 0));

  return {
    riskScore,
    overallRiskLevel: normalizeLevel(riskScore),
    facePresencePercentage,
    lookingAwayTotalSeconds,
    noFaceTotalSeconds,
    multiplePersonEvents: (eventsByType.MULTIPLE_PEOPLE || 0) + (eventsByType.MULTIPLE_FACES_DETECTED || 0),
    tabSwitchCount: eventsByType.TAB_SWITCH || 0,
    fullscreenExitCount: eventsByType.FULLSCREEN_EXIT || 0,
    badLightingEvents: (eventsByType.BAD_LIGHTING || 0) + (eventsByType.POOR_LIGHTING || 0),
    cameraBlockedEvents: eventsByType.CAMERA_BLOCKED || 0,
    // YOLO-specific metrics
    phoneDetections: yoloSummary.phoneDetections ?? eventsByType.PHONE_VISIBLE ?? 0,
    bookDetections: yoloSummary.bookDetections ?? eventsByType.REFERENCE_MATERIAL_VISIBLE ?? 0,
    screenDetections: yoloSummary.screenDetections ?? eventsByType.SCREEN_DEVICE_VISIBLE ?? 0,
    personCountIssues: yoloSummary.personCountIssues ?? eventsByType.MULTIPLE_PEOPLE ?? 0,
    yoloFramesProcessed: yoloSummary.totalFramesProcessed ?? 0,
    eventsByType,
    yoloSummary,
  };
}

function buildFallbackReport({ room, events }) {
  const metrics = calculateIntegrityMetrics({ room, events });
  const keyFindings = [];

  if (metrics.noFaceTotalSeconds > 0) keyFindings.push(`No-face signals totaled ${Math.round(metrics.noFaceTotalSeconds)} seconds.`);
  if (metrics.multiplePersonEvents > 0) keyFindings.push(`${metrics.multiplePersonEvents} possible multiple-person signal(s) were recorded.`);
  if (metrics.lookingAwayTotalSeconds > 0) keyFindings.push(`Looking-away signals totaled ${Math.round(metrics.lookingAwayTotalSeconds)} seconds.`);
  if (metrics.tabSwitchCount > 0) keyFindings.push(`Browser focus changed ${metrics.tabSwitchCount} time(s).`);
  if (metrics.fullscreenExitCount > 0) keyFindings.push(`Fullscreen was exited ${metrics.fullscreenExitCount} time(s).`);
  if (metrics.badLightingEvents > 0) keyFindings.push(`${metrics.badLightingEvents} poor-lighting signal(s) may limit confidence.`);
  
  // YOLO-specific findings
  if (metrics.phoneDetections > 0) keyFindings.push(`${metrics.phoneDetections} phone/device detection(s) were recorded.`);
  if (metrics.bookDetections > 0) keyFindings.push(`${metrics.bookDetections} reference material(s) were detected.`);
  if (metrics.screenDetections > 0) keyFindings.push(`${metrics.screenDetections} additional screen(s) were detected.`);
  if (metrics.yoloFramesProcessed > 0) keyFindings.push(`${metrics.yoloFramesProcessed} frame(s) were analyzed for object detection.`);
  
  if (keyFindings.length === 0) keyFindings.push('No notable integrity signals were recorded.');

  const timelineSummary = events.length
    ? `${events.length} integrity signal(s) were recorded for recruiter review.`
    : 'No flagged integrity events were recorded during this interview.';

  // Calculate interview comfort indicators (objective only - no emotion)
  const attentionConsistency = metrics.lookingAwayTotalSeconds > 30 ? 'low' : metrics.lookingAwayTotalSeconds > 10 ? 'medium' : 'high';
  const cameraStability = metrics.cameraBlockedEvents > 2 ? 'unstable' : 'stable';
  
  // Interview pressure indicator (experimental, objective signals only)
  let pressureScore = 0;
  if (metrics.lookingAwayTotalSeconds > 20) pressureScore += 1;
  if (metrics.tabSwitchCount > 2) pressureScore += 1;
  if (metrics.cameraBlockedEvents > 2) pressureScore += 1;
  if (metrics.noFaceTotalSeconds > 15) pressureScore += 1;
  if (metrics.multiplePersonEvents > 0) pressureScore += 1;
  
  const interviewPressureIndicator = pressureScore >= 3 ? 'high' : pressureScore >= 1 ? 'medium' : 'low';
  
  let pressureExplanation = 'The interview had consistent camera presence and stable conditions.';
  if (interviewPressureIndicator === 'high') {
    pressureExplanation = 'The interview had repeated camera absences, multiple tab switches, or extended looking-away periods. This should not be interpreted as stress or performance quality.';
  } else if (interviewPressureIndicator === 'medium') {
    pressureExplanation = 'The interview had some camera stability issues or occasional tab switches. This should not be interpreted as stress or performance quality.';
  }

  return {
    generatedAt: new Date(),
    overallIntegrityRisk: metrics.overallRiskLevel,
    riskScore: metrics.riskScore,
    summary: metrics.riskScore === 0
      ? 'No significant integrity signals were detected. Standard recruiter review still applies.'
      : 'Some integrity signals were detected and should be reviewed in context with the transcript and recording.',
    keyFindings,
    questionAnalysis: buildQuestionAnalysis(events),
    timelineSummary,
    recruiterRecommendation: metrics.overallRiskLevel === 'high'
      ? 'Needs recruiter review before any decision. Do not make an automatic rejection decision from AI signals alone.'
      : 'Review any flagged moments in context. AI signals are assistance only and are not a decision.',
    limitations: 'This report is based on browser vision signals and optional snapshot analysis. It may be affected by camera quality, lighting, network conditions, and model limitations. It does not infer intent, honesty, identity, emotion, personality, age, gender, race, disability, or mental state.',
    llmProvider: 'deterministic-fallback',
    
    // Structured objective visual signals
    objectiveVisualSignals: {
      facePresencePercentage: metrics.facePresencePercentage,
      personCountIssues: metrics.personCountIssues,
      phoneDetections: metrics.phoneDetections,
      referenceMaterialDetections: metrics.bookDetections,
      additionalScreenDetections: metrics.screenDetections,
      lookingAwayTotalSeconds: metrics.lookingAwayTotalSeconds,
      cameraQualityIssues: (metrics.badLightingEvents || 0) + (metrics.cameraBlockedEvents || 0),
    },
    
    // Interview comfort indicators (objective only - not emotion detection)
    interviewComfortIndicators: {
      attentionConsistency,
      cameraStability,
      interviewPressureIndicator,
      pressureExplanation,
      importantLimitation: 'This is not emotion detection and must not be used as an automatic hiring decision.',
    },
    
    // Keep metrics for backward compatibility
    metrics,
  };
}

function buildQuestionAnalysis(events) {
  const grouped = new Map();
  for (const event of events) {
    const key = event.questionId || 'General';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(event);
  }

  return Array.from(grouped.entries()).map(([questionId, items]) => ({
    questionId,
    signalCount: items.length,
    highestSeverity: items.some((item) => item.severity === 'high')
      ? 'high'
      : items.some((item) => item.severity === 'medium')
        ? 'medium'
        : 'low',
    signals: items.map((item) => ({
      type: item.type,
      severity: item.severity,
      evidence: item.evidence,
      timestamp: item.timestamp,
      durationSeconds: item.durationSeconds || 0,
    })),
  }));
}

const buildReportPrompt = ({ room, events, metrics }) => [
  'You are writing an interview integrity review for a recruiter.',
  'Use careful wording: "integrity signal", "possible risk", "needs recruiter review".',
  'Do not infer cheating, emotion, personality, honesty, race, gender, age, disability, mental state, or identity.',
  'Do not recommend automatic rejection. The recruiter is the final decision-maker.',
  'Return JSON only with keys: summary, keyFindings, questionAnalysis, timelineSummary, recruiterRecommendation, limitations.',
  JSON.stringify({
    roomId: room?.roomId,
    status: room?.status,
    metrics,
    events: events.map((event) => ({
      type: event.type,
      severity: event.severity,
      timestamp: event.timestamp,
      questionId: event.questionId,
      durationSeconds: event.durationSeconds,
      confidence: event.confidence,
      evidence: event.evidence,
      llmAnalysis: event.llmAnalysis || null,
    })),
    transcriptSnippets: (room?.transcription?.segments || []).slice(-20).map((segment) => ({
      text: segment.text,
      timestamp: segment.timestamp,
    })),
  }),
].join('\n');

async function generateTextReportWithOpenAI(input) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.INTEGRITY_OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: buildReportPrompt(input) }],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI report request failed (${response.status})`);
  return safeJsonParse(data?.choices?.[0]?.message?.content, {});
}

async function generateTextReportWithGemini(input) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
  const model = process.env.INTEGRITY_GEMINI_MODEL || 'gemini-1.5-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      contents: [{ parts: [{ text: buildReportPrompt(input) }] }],
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Gemini report request failed (${response.status})`);
  return safeJsonParse(data?.candidates?.[0]?.content?.parts?.[0]?.text, {});
}

async function generateIntegrityReport({ room, events = [] }) {
  const normalizedEvents = Array.isArray(events) ? events : [];
  const fallback = buildFallbackReport({ room, events: normalizedEvents });
  const reportProvider = getReportProvider();

  if (reportProvider === 'disabled' || !reportProvider) {
    return fallback;
  }

  try {
    const metrics = fallback.metrics;
    const llm = reportProvider === 'gemini'
      ? await generateTextReportWithGemini({ room, events: normalizedEvents, metrics })
      : await generateTextReportWithOpenAI({ room, events: normalizedEvents, metrics });

    return {
      ...fallback,
      ...llm,
      generatedAt: new Date(),
      overallRiskLevel: fallback.overallRiskLevel,
      riskScore: fallback.riskScore,
      metrics,
      llmProvider: reportProvider,
    };
  } catch (error) {
    return {
      ...fallback,
      llmProvider: reportProvider,
      llmError: error.message,
    };
  }
}

function buildMockIntegrityReport() {
  const now = new Date();
  const mockRoom = {
    roomId: 'mock-room',
    status: 'ended',
    visionMonitoring: { summary: { totalChecks: 120, faceDetectedChecks: 106 } },
    transcription: {
      segments: [
        { text: 'Candidate answered a technical question.', timestamp: now },
      ],
    },
  };
  const mockEvents = [
    {
      type: 'LOOKING_AWAY_LONG',
      severity: 'medium',
      timestamp: now,
      questionId: 'Question 2',
      durationSeconds: 7,
      confidence: 0.82,
      evidence: 'Candidate gaze direction was away from screen for 7 seconds.',
    },
    {
      type: 'TAB_SWITCH',
      severity: 'medium',
      timestamp: now,
      questionId: 'General',
      durationSeconds: 2,
      confidence: 1,
      evidence: 'Browser window lost focus during the interview.',
    },
  ];
  return buildFallbackReport({ room: mockRoom, events: mockEvents });
}

module.exports = {
  SCORE_WEIGHTS,
  calculateIntegrityMetrics,
  generateIntegrityReport,
  buildMockIntegrityReport,
};
