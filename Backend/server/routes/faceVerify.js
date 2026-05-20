/**
 * Face Verification Routes
 *
 * POST /api/call-rooms/:roomId/face-verify/start
 * POST /api/call-rooms/:roomId/face-verify/check
 *
 * Privacy contract:
 * - Candidate profile photo and embedding are never sent to the frontend.
 * - Live frames are processed in memory by the Python service and not stored.
 * - No race / gender / age / emotion inference.
 */

const express = require('express');
const router = express.Router({ mergeParams: true });
const CallRoom = require('../models/CallRoom');
const { verifyToken } = require('../middleware/auth');
const { FACE_VERIFY_URL, verifyFaceEmbedding } = require('../services/faceVerifyService');
const { loadCandidateForFaceVerification } = require('../services/faceVerifyCandidateLoader');
const {
  normalizeFaceResultStatus,
  hasStrictFaceMatch,
} = require('../services/faceVerifyDecision');

const FACE_VERIFY_ENABLED = process.env.FACE_VERIFY_ENABLED !== 'false';
const FACE_VERIFY_MODEL = process.env.FACE_VERIFY_MODEL_PACK || 'buffalo_l';
const FACE_VERIFY_THRESHOLD = Number(process.env.FACE_VERIFY_THRESHOLD || 0.60);
const FACE_VERIFY_REQUIRED_FRAMES = Number(process.env.FACE_VERIFY_REQUIRED_FRAMES || 3);
const FACE_VERIFY_MIN_MATCHING_FRAMES = Number(process.env.FACE_VERIFY_MIN_MATCHING_FRAMES || 2);
const FACE_VERIFY_FAIL_OPEN = process.env.FACE_VERIFY_FAIL_OPEN === 'true';
const MAX_CONSECUTIVE_MISMATCHES = Number(process.env.FACE_VERIFY_MAX_CONSECUTIVE_MISMATCHES || 2);

function buildEvent(type, status, similarity, extra = {}) {
  return {
    type,
    status,
    score: similarity ?? null,
    similarity: similarity ?? null,
    distance: extra.distance ?? null,
    timestamp: new Date(),
    ...extra,
  };
}

function eventTypeForStatus(status, reason = '') {
  if (status === 'matched') return 'IDENTITY_MATCH';
  if (status === 'not_matched') return 'IDENTITY_MISMATCH';
  if (status === 'not_enrolled') return 'NOT_ENROLLED';
  if (status === 'liveness_failed') return 'LIVENESS_FAILED';
  if (status === 'multiple_faces' || reason === 'multiple_faces') return 'MULTIPLE_FACES';
  if (status === 'no_face' || reason === 'no_face' || reason === 'no_valid_face') return 'NO_FACE';
  if (reason === 'low_quality' || status === 'low_quality') return 'LOW_QUALITY';
  if (status === 'failed') return 'IDENTITY_SERVICE_ERROR';
  return 'UNCERTAIN';
}

function publicMessage(status) {
  switch (status) {
    case 'matched':
      return 'Face verified. Starting interview...';
    case 'not_enrolled':
      return 'Please upload a clear profile photo before starting the interview.';
    case 'not_matched':
      return 'Your face does not match the profile photo. Access to the interview is blocked.';
    case 'multiple_faces':
      return 'Only the candidate should be visible. Please remove other faces from the camera.';
    case 'no_face':
      return 'No face detected. Please center your face and try again.';
    case 'liveness_failed':
      return 'Liveness check failed. Please use your real camera.';
    case 'failed':
      return 'Face verification failed. Please retry or contact the recruiter.';
    default:
      return 'We could not verify your face clearly. Please center your face and try again.';
  }
}

function normalizeResultStatus(result) {
  return normalizeFaceResultStatus(result);
}

function hasStrictMatch(result) {
  return hasStrictFaceMatch(result, {
    threshold: FACE_VERIFY_THRESHOLD,
    requiredFrames: FACE_VERIFY_REQUIRED_FRAMES,
    minMatchingFrames: FACE_VERIFY_MIN_MATCHING_FRAMES,
  });
}

function publicStartResponse(result, statusOverride = null) {
  const status = statusOverride || normalizeResultStatus(result);
  const matched = status === 'matched';
  return {
    success: true,
    verified: matched,
    status,
    allowInterview: matched,
    retryable: ['uncertain', 'no_face', 'multiple_faces', 'low_quality', 'liveness_failed', 'failed'].includes(status),
    flagged: status === 'not_matched' || status === 'multiple_faces',
    metric: result?.metric || 'cosine_similarity',
    similarity: result?.similarity ?? null,
    medianSimilarity: result?.medianSimilarity ?? null,
    bestSimilarity: result?.bestSimilarity ?? null,
    distance: result?.distance ?? null,
    threshold: result?.threshold ?? FACE_VERIFY_THRESHOLD,
    matchingFrames: result?.matchingFrames ?? 0,
    totalFrames: result?.totalFrames ?? result?.framesChecked ?? 0,
    validFrames: result?.validFrames ?? 0,
    reason: result?.reason,
    message: publicMessage(status),
  };
}

async function findRoom(roomId) {
  return CallRoom.findOne({
    $or: [{ roomId }, { _id: roomId?.length === 24 ? roomId : undefined }].filter(Boolean),
  });
}

async function saveVerificationResult(roomId, update, event, inc = {}) {
  const dbUpdate = { $set: update };
  if (event) dbUpdate.$push = { 'faceVerification.events': event };
  if (Object.keys(inc).length) dbUpdate.$inc = inc;
  await CallRoom.findByIdAndUpdate(roomId, dbUpdate, { runValidators: false });
}

function isCandidateRequester(req, room) {
  const requesterId = req.user?._id?.toString();
  const candidateId = room?.candidate?.toString();
  return requesterId && candidateId && requesterId === candidateId;
}

function auditFields(result, status, enrollmentModel, framesLength, liveness = {}) {
  return {
    'faceVerification.required': FACE_VERIFY_ENABLED,
    'faceVerification.status': status,
    'faceVerification.allowInterview': status === 'matched',
    'faceVerification.provider': 'insightface',
    'faceVerification.model': enrollmentModel || FACE_VERIFY_MODEL,
    'faceVerification.metric': result?.metric || 'cosine_similarity',
    'faceVerification.similarity': result?.similarity ?? null,
    'faceVerification.medianSimilarity': result?.medianSimilarity ?? null,
    'faceVerification.bestSimilarity': result?.bestSimilarity ?? null,
    'faceVerification.distance': result?.distance ?? null,
    'faceVerification.threshold': result?.threshold ?? FACE_VERIFY_THRESHOLD,
    'faceVerification.matchingFrames': result?.matchingFrames ?? 0,
    'faceVerification.totalFrames': result?.totalFrames ?? result?.framesChecked ?? framesLength ?? 0,
    'faceVerification.validFrames': result?.validFrames ?? 0,
    'faceVerification.verifiedFrames': result?.matchingFrames ?? result?.validFrames ?? 0,
    'faceVerification.framesChecked': result?.framesChecked ?? framesLength ?? 0,
    'faceVerification.requiredFrames': FACE_VERIFY_REQUIRED_FRAMES,
    'faceVerification.minMatchingFrames': FACE_VERIFY_MIN_MATCHING_FRAMES,
    'faceVerification.livenessPassed': liveness.passed === true,
    'faceVerification.livenessChallenge': liveness.challenge || null,
    'faceVerification.checkedAt': new Date(),
  };
}

router.post('/start', verifyToken, async (req, res) => {
  let interviewId = null;
  try {
    const { roomId } = req.params;
    const { frames, livenessPassed, livenessChallenge, livenessScore } = req.body || {};

    const room = await findRoom(roomId);
    if (!room) {
      return res.status(404).json({ error: 'Call room not found' });
    }
    interviewId = room._id.toString();

    await CallRoom.findByIdAndUpdate(interviewId, {
      $set: {
        'faceVerification.required': FACE_VERIFY_ENABLED,
        'faceVerification.status': 'pending',
        'faceVerification.allowInterview': false,
        'faceVerification.checkedAt': new Date(),
      },
      $inc: { 'faceVerification.attempts': 1 },
      $push: { 'faceVerification.events': buildEvent('START_CHECK', 'pending', null) },
    }, { runValidators: false });

    if (!FACE_VERIFY_ENABLED) {
      const result = { status: 'failed', reason: 'face_verification_disabled' };
      const ev = buildEvent('IDENTITY_SERVICE_ERROR', 'failed', null, {
        note: 'FACE_VERIFY_ENABLED=false; fail-open is disabled',
      });
      await saveVerificationResult(interviewId, {
        ...auditFields(result, 'failed', FACE_VERIFY_MODEL, Array.isArray(frames) ? frames.length : 0, {
          passed: false,
        }),
        'faceVerification.allowInterview': false,
        'faceVerification.failOpen': FACE_VERIFY_FAIL_OPEN,
      }, ev);
      return res.status(503).json(publicStartResponse(result, 'failed'));
    }

    if (!isCandidateRequester(req, room)) {
      return res.status(403).json({
        verified: false,
        status: 'failed',
        allowInterview: false,
        message: 'Only the expected candidate can run face verification for this room.',
      });
    }

    if (!Array.isArray(frames) || frames.length < FACE_VERIFY_REQUIRED_FRAMES) {
      const result = { status: 'uncertain', reason: 'insufficient_live_frames' };
      const ev = buildEvent('UNCERTAIN', 'uncertain', null, {
        note: result.reason,
        totalFrames: Array.isArray(frames) ? frames.length : 0,
        threshold: FACE_VERIFY_THRESHOLD,
      });
      await saveVerificationResult(interviewId, {
        ...auditFields(result, 'uncertain', FACE_VERIFY_MODEL, Array.isArray(frames) ? frames.length : 0, {
          passed: livenessPassed === true,
          challenge: livenessChallenge,
        }),
        'faceVerification.allowInterview': false,
      }, ev);
      return res.status(400).json(publicStartResponse(result, 'uncertain'));
    }

    if (livenessPassed !== true) {
      const result = { status: 'liveness_failed', reason: 'liveness_required' };
      const ev = buildEvent('LIVENESS_FAILED', 'liveness_failed', null, {
        note: result.reason,
        livenessScore: Number(livenessScore || 0),
      });
      await saveVerificationResult(interviewId, {
        ...auditFields(result, 'liveness_failed', FACE_VERIFY_MODEL, frames.length, {
          passed: false,
          challenge: livenessChallenge,
        }),
        'faceVerification.allowInterview': false,
      }, ev);
      return res.status(403).json(publicStartResponse(result, 'liveness_failed'));
    }

    const candidateLoad = await loadCandidateForFaceVerification(room.candidate);
    const candidate = candidateLoad.user;
    const embedding = candidateLoad.embedding;

    console.log('[FaceVerify/start] candidate loaded', {
      roomId: room.roomId,
      userId: candidate?._id?.toString() || room.candidate?.toString(),
      candidateEmail: candidate?.email || null,
      enrolled: candidate?.faceProfile?.enrolled === true,
      embeddingLength: Array.isArray(embedding) ? embedding.length : 0,
      profileModel: candidate?.faceProfile?.model || null,
    });

    if (!candidateLoad.ok) {
      const status = candidateLoad.status === 'candidate_not_found' ? 'failed' : 'not_enrolled';
      const result = {
        status,
        reason: candidateLoad.status || 'profile_face_not_enrolled',
      };
      const ev = buildEvent('NOT_ENROLLED', 'not_enrolled', null, { note: result.reason });
      await saveVerificationResult(interviewId, {
        ...auditFields(result, status, candidate?.faceProfile?.model || FACE_VERIFY_MODEL, frames.length, {
          passed: true,
          challenge: livenessChallenge,
        }),
        'faceVerification.allowInterview': false,
      }, ev);
      return res.status(candidateLoad.status === 'candidate_not_found' ? 404 : 409)
        .json(publicStartResponse(result, status));
    }

    console.log('[FaceVerify/start] calling face service', {
      url: FACE_VERIFY_URL,
      frames: frames.length,
      threshold: FACE_VERIFY_THRESHOLD,
    });

    const serviceResult = await verifyFaceEmbedding(embedding, frames, {
      threshold: FACE_VERIFY_THRESHOLD,
      requiredFrames: FACE_VERIFY_REQUIRED_FRAMES,
      minMatchingFrames: FACE_VERIFY_MIN_MATCHING_FRAMES,
    });

    const status = hasStrictMatch(serviceResult)
      ? 'matched'
      : normalizeResultStatus(serviceResult);
    const eventType = eventTypeForStatus(status, serviceResult.reason);
    const ev = buildEvent(eventType, status, serviceResult.similarity, {
      note: serviceResult.reason,
      metric: serviceResult.metric || 'cosine_similarity',
      threshold: serviceResult.threshold ?? FACE_VERIFY_THRESHOLD,
      matchingFrames: serviceResult.matchingFrames ?? 0,
      totalFrames: serviceResult.totalFrames ?? serviceResult.framesChecked ?? frames.length,
      livenessScore: Number(livenessScore || 0),
    });

    await saveVerificationResult(interviewId, {
      ...auditFields(serviceResult, status, candidate.faceProfile?.model || FACE_VERIFY_MODEL, frames.length, {
        passed: true,
        challenge: livenessChallenge,
      }),
      'faceVerification.allowInterview': status === 'matched',
      'faceVerification.consecutiveMismatches': status === 'not_matched' ? 1 : 0,
    }, ev);

    console.log('[face-verify] final decision', {
      roomId: room.roomId,
      userId: candidate._id.toString(),
      status,
      allowInterview: status === 'matched',
      metric: serviceResult.metric || 'cosine_similarity',
      similarity: serviceResult.similarity ?? null,
      medianSimilarity: serviceResult.medianSimilarity ?? null,
      threshold: serviceResult.threshold ?? FACE_VERIFY_THRESHOLD,
      matchingFrames: serviceResult.matchingFrames ?? 0,
      totalFrames: serviceResult.totalFrames ?? serviceResult.framesChecked ?? frames.length,
    });

    return res.status(status === 'matched' ? 200 : 403).json(publicStartResponse(serviceResult, status));
  } catch (err) {
    console.error('[FaceVerify/start] error', {
      message: err?.message,
      code: err?.code,
      name: err?.name,
    });
    if (interviewId) {
      const result = { status: 'failed', reason: 'verification_error' };
      await saveVerificationResult(interviewId, {
        ...auditFields(result, 'failed', FACE_VERIFY_MODEL, 0, { passed: false }),
        'faceVerification.allowInterview': false,
      }, buildEvent('IDENTITY_SERVICE_ERROR', 'failed', null, { note: err?.message || 'verification_error' }));
    }
    return res.status(500).json({
      success: false,
      verified: false,
      status: 'failed',
      allowInterview: false,
      reason: 'verification_error',
      message: publicMessage('failed'),
      error: {
        code: 'face_verify_failed',
        message: err?.message || 'Face verification failed',
      },
    });
  }
});

router.post('/check', verifyToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const { frame } = req.body || {};

    if (!frame) {
      return res.status(400).json({ error: 'frame is required' });
    }

    const room = await findRoom(roomId);
    if (!room) {
      return res.status(404).json({ error: 'Call room not found' });
    }

    if (!FACE_VERIFY_ENABLED) {
      return res.status(503).json({
        status: 'failed',
        verified: false,
        flagged: true,
        pauseInterview: false,
        reason: 'face_verification_disabled',
      });
    }

    const interviewId = room._id.toString();
    const candidateLoad = await loadCandidateForFaceVerification(room.candidate);
    const candidate = candidateLoad.user;
    const embedding = candidateLoad.embedding;

    if (!candidateLoad.ok) {
      const ev = buildEvent('NOT_ENROLLED', 'not_enrolled', null, { note: 'profile_face_not_enrolled' });
      await saveVerificationResult(interviewId, {
        'faceVerification.status': 'not_enrolled',
        'faceVerification.allowInterview': false,
        'faceVerification.checkedAt': new Date(),
      }, ev);
      return res.status(409).json({
        status: 'not_enrolled',
        verified: false,
        flagged: true,
        pauseInterview: true,
        reason: 'profile_face_not_enrolled',
        message: publicMessage('not_enrolled'),
      });
    }

    const result = await verifyFaceEmbedding(embedding, [frame], {
      threshold: FACE_VERIFY_THRESHOLD,
      requiredFrames: 1,
      minMatchingFrames: 1,
    });
    const status = result.status === 'matched' && result.verified === true
      ? 'matched'
      : normalizeResultStatus(result);
    const eventType = eventTypeForStatus(status, result.reason);
    const ev = buildEvent('PERIODIC_CHECK', status, result.similarity, {
      subType: eventType,
      note: result.reason,
      threshold: result.threshold ?? FACE_VERIFY_THRESHOLD,
      matchingFrames: result.matchingFrames ?? 0,
      totalFrames: result.totalFrames ?? result.framesChecked ?? 1,
    });

    const currentMismatchCount = Number(room.faceVerification?.consecutiveMismatches || 0);
    const isMismatch = ['not_matched', 'multiple_faces'].includes(status);
    const nextMismatchCount = isMismatch
      ? currentMismatchCount + 1
      : status === 'matched'
        ? 0
        : currentMismatchCount;
    const pauseInterview = nextMismatchCount >= MAX_CONSECUTIVE_MISMATCHES;
    const persistedStatus = status === 'matched'
      ? 'matched'
      : pauseInterview
        ? 'not_matched'
        : (room.faceVerification?.status || status);

    await saveVerificationResult(interviewId, {
      ...auditFields(result, persistedStatus, candidate.faceProfile?.model || FACE_VERIFY_MODEL, 1, {
        passed: true,
      }),
      'faceVerification.allowInterview': !pauseInterview && room.faceVerification?.allowInterview === true,
      'faceVerification.consecutiveMismatches': nextMismatchCount,
    }, ev);

    return res.json({
      status,
      verified: status === 'matched',
      flagged: isMismatch,
      pauseInterview,
      consecutiveMismatches: nextMismatchCount,
      similarity: result.similarity ?? null,
      medianSimilarity: result.medianSimilarity ?? null,
      bestSimilarity: result.bestSimilarity ?? null,
      threshold: result.threshold ?? FACE_VERIFY_THRESHOLD,
      matchingFrames: result.matchingFrames ?? 0,
      totalFrames: result.totalFrames ?? result.framesChecked ?? 1,
      reason: result.reason,
      message: publicMessage(status),
    });
  } catch (err) {
    console.error('[FaceVerify/check] Error:', err?.message);
    return res.status(500).json({
      status: 'failed',
      verified: false,
      flagged: true,
      pauseInterview: false,
      reason: 'verification_error',
      message: publicMessage('failed'),
    });
  }
});

module.exports = router;
