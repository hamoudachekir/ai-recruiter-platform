/**
 * YOLO Vision Service Client
 * 
 * This service client communicates with the Python YOLOv8 microservice
 * for object/person detection in interview monitoring.
 * 
 * Safety: Does NOT detect emotion, stress, or identity. Only objective visual facts.
 */

const fetch = require('node-fetch');

const YOLO_SERVICE_URL = process.env.YOLO_SERVICE_URL || 'http://localhost:8001/detect-frame';
const YOLO_ENABLED = String(process.env.YOLO_ENABLED || 'true').toLowerCase() === 'true';
const YOLO_TIMEOUT_MS = Number(process.env.YOLO_TIMEOUT_MS || 3000);

/**
 * Fallback response when YOLO service is unavailable
 */
const FALLBACK_RESPONSE = {
  success: false,
  detections: [],
  summary: {
    personCount: null,
    phoneDetected: false,
    bookDetected: false,
    laptopDetected: false,
    keyboardDetected: false,
    mouseDetected: false,
    tvDetected: false,
    remoteDetected: false,
    suspiciousObjectDetected: false,
    needsReview: false,
  },
  processingTimeMs: 0,
  error: 'YOLO service unavailable',
  fallback: true,
};

/**
 * Detect objects in a video frame using YOLOv8
 * @param {Object} params - Detection parameters
 * @param {string} params.interviewId - Interview/call room ID
 * @param {string} params.candidateId - Candidate ID
 * @param {string} params.questionId - Current question ID
 * @param {string} params.frameBase64 - Base64-encoded JPEG image
 * @returns {Promise<Object>} Detection results or fallback
 */
async function detectFrame({ interviewId, candidateId, questionId, frameBase64 }) {
  // Return fallback if YOLO is disabled
  if (!YOLO_ENABLED) {
    return {
      ...FALLBACK_RESPONSE,
      error: 'YOLO detection is disabled',
    };
  }

  // Validate inputs
  if (!interviewId || !frameBase64) {
    return {
      ...FALLBACK_RESPONSE,
      error: 'Missing required parameters: interviewId and frameBase64',
    };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), YOLO_TIMEOUT_MS);

    const response = await fetch(YOLO_SERVICE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        interviewId,
        candidateId,
        questionId,
        frameBase64,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      console.warn(`YOLO service returned ${response.status}: ${errorText}`);
      return {
        ...FALLBACK_RESPONSE,
        error: `YOLO service error: ${response.status}`,
      };
    }

    const result = await response.json();
    
    return {
      success: result.success ?? false,
      detections: result.detections || [],
      summary: {
        personCount: result.summary?.personCount ?? null,
        phoneDetected: result.summary?.phoneDetected ?? false,
        bookDetected: result.summary?.bookDetected ?? false,
        laptopDetected: result.summary?.laptopDetected ?? false,
        keyboardDetected: result.summary?.keyboardDetected ?? false,
        mouseDetected: result.summary?.mouseDetected ?? false,
        tvDetected: result.summary?.tvDetected ?? false,
        remoteDetected: result.summary?.remoteDetected ?? false,
        suspiciousObjectDetected: result.summary?.suspiciousObjectDetected ?? false,
        needsReview: result.summary?.needsReview ?? false,
      },
      processingTimeMs: result.processingTimeMs ?? 0,
      error: result.error || null,
    };
  } catch (error) {
    // Handle abort/timeout
    if (error.name === 'AbortError') {
      console.warn('YOLO service request timed out');
      return {
        ...FALLBACK_RESPONSE,
        error: 'YOLO service timeout',
      };
    }

    // Log but don't crash - always return fallback
    console.warn('YOLO service error:', error.message);
    
    return {
      ...FALLBACK_RESPONSE,
      error: error.message,
    };
  }
}

/**
 * Check if YOLO service is healthy
 * @returns {Promise<Object>} Health status
 */
async function checkHealth() {
  if (!YOLO_ENABLED) {
    return {
      available: false,
      enabled: false,
      message: 'YOLO detection is disabled via configuration',
    };
  }

  try {
    const healthUrl = YOLO_SERVICE_URL.replace('/detect-frame', '/health');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        available: false,
        enabled: true,
        message: `Health check failed: ${response.status}`,
      };
    }

    const data = await response.json();
    
    return {
      available: data.modelLoaded === true,
      enabled: true,
      modelLoaded: data.modelLoaded,
      modelName: data.modelName,
      modelLoadTime: data.modelLoadTime,
      message: data.modelLoaded ? 'YOLO service ready' : 'Model not loaded',
    };
  } catch (error) {
    return {
      available: false,
      enabled: true,
      message: error.name === 'AbortError' ? 'Health check timeout' : error.message,
    };
  }
}

/**
 * Create integrity events from YOLO detection results
 * @param {Object} yoloResult - Result from detectFrame()
 * @param {Object} context - Event context
 * @returns {Array<Object>} Array of integrity events
 */
function createIntegrityEvents(yoloResult, context = {}) {
  const events = [];
  const { interviewId, questionId, timestamp = new Date().toISOString() } = context;
  
  if (!yoloResult?.success || !yoloResult.summary) {
    return events;
  }

  const summary = yoloResult.summary;
  const detections = yoloResult.detections || [];

  // A. MULTIPLE_PEOPLE - personCount > 1
  if (summary.personCount > 1) {
    events.push({
      type: 'MULTIPLE_PEOPLE',
      source: 'yolov8',
      severity: 'high',
      timestamp,
      questionId,
      confidence: 0.9,
      evidence: 'More than one person was detected in the camera frame.',
      detections: detections.filter(d => d.label === 'person'),
      needsRecruiterReview: true,
    });
  }

  // B. NO_PERSON_VISIBLE - personCount === 0
  if (summary.personCount === 0) {
    events.push({
      type: 'NO_PERSON_VISIBLE',
      source: 'yolov8',
      severity: 'medium',
      timestamp,
      questionId,
      confidence: 0.85,
      evidence: 'No person was detected in the camera frame.',
      detections: [],
      needsRecruiterReview: true,
    });
  }

  // C. PHONE_VISIBLE - cell phone detected
  if (summary.phoneDetected) {
    const phoneDetections = detections.filter(d => d.label === 'cell phone');
    const maxConfidence = phoneDetections.length > 0 
      ? Math.max(...phoneDetections.map(d => d.confidence))
      : 0.6;
    
    events.push({
      type: 'PHONE_VISIBLE',
      source: 'yolov8',
      severity: 'medium',
      timestamp,
      questionId,
      confidence: maxConfidence,
      evidence: 'A phone-like object was detected in the camera frame.',
      detections: phoneDetections,
      needsRecruiterReview: true,
    });
  }

  // D. REFERENCE_MATERIAL_VISIBLE - book detected
  if (summary.bookDetected) {
    const bookDetections = detections.filter(d => d.label === 'book');
    const maxConfidence = bookDetections.length > 0
      ? Math.max(...bookDetections.map(d => d.confidence))
      : 0.6;
    
    events.push({
      type: 'REFERENCE_MATERIAL_VISIBLE',
      source: 'yolov8',
      severity: 'low',
      timestamp,
      questionId,
      confidence: maxConfidence,
      evidence: 'A book or document-like object was detected in the camera frame.',
      detections: bookDetections,
      needsRecruiterReview: true,
    });
  }

  // E. SCREEN_DEVICE_VISIBLE - laptop or TV detected
  if (summary.laptopDetected || summary.tvDetected) {
    const screenDetections = detections.filter(d => 
      d.label === 'laptop' || d.label === 'tv'
    );
    const maxConfidence = screenDetections.length > 0
      ? Math.max(...screenDetections.map(d => d.confidence))
      : 0.6;
    
    events.push({
      type: 'SCREEN_DEVICE_VISIBLE',
      source: 'yolov8',
      severity: 'medium',
      timestamp,
      questionId,
      confidence: maxConfidence,
      evidence: 'An additional screen-like device was detected.',
      detections: screenDetections,
      needsRecruiterReview: true,
    });
  }

  return events;
}

/**
 * Get YOLO configuration status
 * @returns {Object} Configuration info
 */
function getConfig() {
  return {
    enabled: YOLO_ENABLED,
    serviceUrl: YOLO_SERVICE_URL,
    timeoutMs: YOLO_TIMEOUT_MS,
  };
}

module.exports = {
  detectFrame,
  checkHealth,
  createIntegrityEvents,
  getConfig,
  FALLBACK_RESPONSE,
};
