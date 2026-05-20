/**
 * Face Verification Service Client
 *
 * Talks to the Python InsightFace service. Profile embeddings stay in MongoDB
 * and are never exposed to the frontend.
 */

const axios = require('axios');

const FACE_VERIFY_URL = process.env.FACE_VERIFY_SERVICE_URL || 'http://localhost:8011';
const FACE_VERIFY_TIMEOUT_MS = Number(process.env.FACE_VERIFY_TIMEOUT_MS || 5000);
const FACE_VERIFY_PHOTO_TIMEOUT_MS = Number(process.env.FACE_VERIFY_PHOTO_TIMEOUT_MS || 6000);
const FACE_VERIFY_THRESHOLD = Number(process.env.FACE_VERIFY_THRESHOLD || 0.60);
const FACE_VERIFY_REQUIRED_FRAMES = Number(process.env.FACE_VERIFY_REQUIRED_FRAMES || 3);
const FACE_VERIFY_MIN_MATCHING_FRAMES = Number(process.env.FACE_VERIFY_MIN_MATCHING_FRAMES || 2);

let _serviceAvailable = null;

function normalizeServiceUrl(path) {
  return `${FACE_VERIFY_URL.replace(/\/+$/, '')}${path}`;
}

async function checkHealth() {
  try {
    const res = await axios.get(normalizeServiceUrl('/face/health'), { timeout: 2500 });
    _serviceAvailable = !!res.data?.modelReady;
    return _serviceAvailable;
  } catch {
    _serviceAvailable = false;
    return false;
  }
}

async function enrollFace(imageBase64) {
  if (!imageBase64) {
    return { enrolled: false, status: 'failed', reason: 'image_required' };
  }

  try {
    const response = await axios.post(
      normalizeServiceUrl('/face/enroll'),
      { imageBase64 },
      {
        timeout: FACE_VERIFY_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      },
    );
    _serviceAvailable = true;
    return response.data;
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      _serviceAvailable = false;
      return { enrolled: false, status: 'failed', reason: 'service_unavailable' };
    }
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      return { enrolled: false, status: 'failed', reason: 'timeout' };
    }
    return {
      enrolled: false,
      status: 'failed',
      reason: err.response?.data?.reason || err.response?.data?.error || err.message || 'unknown',
    };
  }
}

async function verifyFaceEmbedding(profileEmbedding, liveFrames, options = {}) {
  if (!Array.isArray(profileEmbedding) || profileEmbedding.length === 0) {
    return { status: 'failed', verified: false, allowInterview: false, reason: 'profile_embedding_required' };
  }
  if (!Array.isArray(liveFrames) || liveFrames.length === 0) {
    return { status: 'uncertain', verified: false, allowInterview: false, reason: 'no_frames' };
  }

  try {
    const threshold = Number(options.threshold || FACE_VERIFY_THRESHOLD);
    const requiredFrames = Number(options.requiredFrames || FACE_VERIFY_REQUIRED_FRAMES);
    const minMatchingFrames = Number(options.minMatchingFrames || FACE_VERIFY_MIN_MATCHING_FRAMES);
    const response = await axios.post(
      normalizeServiceUrl('/face/verify'),
      {
        profileEmbedding,
        liveFrames,
        threshold,
        requiredFrames,
        minMatchingFrames,
      },
      {
        timeout: FACE_VERIFY_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      },
    );
    _serviceAvailable = true;
    return response.data;
  } catch (err) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      _serviceAvailable = false;
      return { status: 'failed', verified: false, allowInterview: false, reason: 'service_unavailable' };
    }
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      return { status: 'failed', verified: false, allowInterview: false, reason: 'timeout' };
    }
    return {
      status: 'failed',
      verified: false,
      allowInterview: false,
      reason: err.response?.data?.reason || err.response?.data?.error || err.message || 'unknown',
    };
  }
}

function getFaceEnrollmentMessage(reason) {
  if (reason === 'no_face' || reason === 'no_valid_face') {
    return 'Please upload a clear photo of your face';
  }
  if (reason === 'multiple_faces') {
    return 'Please upload a photo with only your face';
  }
  if (reason === 'low_quality') {
    return 'Please upload a clearer photo';
  }
  if (reason === 'timeout') {
    return 'Face check timed out. Please try again';
  }
  if (reason === 'service_unavailable') {
    return 'Face verification service is unavailable. Please try again later';
  }
  return 'Face could not be detected, please try another image';
}

/**
 * Download an image from a URL and return it as a base64 data URI.
 * Returns null if the download fails.
 */
async function fetchImageAsBase64(url) {
  if (!url) return null;

  const fs = require('fs');
  const pathLib = require('path');

  if (url.startsWith('/uploads') || url.startsWith('/uploadsPics')) {
    try {
      const absPath = pathLib.join(__dirname, '..', url);
      const data = fs.readFileSync(absPath);
      const ext = pathLib.extname(absPath).replace('.', '') || 'jpeg';
      return `data:image/${ext};base64,${data.toString('base64')}`;
    } catch {
      return null;
    }
  }

  if (url.startsWith('http')) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: FACE_VERIFY_PHOTO_TIMEOUT_MS,
        headers: { 'User-Agent': 'AI-Recruiter-FaceVerify/1.0' },
      });
      const contentType = response.headers['content-type'] || 'image/jpeg';
      const b64 = Buffer.from(response.data).toString('base64');
      return `data:${contentType};base64,${b64}`;
    } catch {
      return null;
    }
  }

  try {
    const data = fs.readFileSync(url);
    const ext = pathLib.extname(url).replace('.', '') || 'jpeg';
    return `data:image/${ext};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

async function enrollUserFaceProfile(user, photoUrl = null) {
  if (!user) {
    return { enrolled: false, status: 'failed', reason: 'user_required', patch: {} };
  }

  const resolvedPhotoUrl = photoUrl || user.picture || user.linkedin?.profilePhoto || null;
  const failedPatch = () => ({
    'faceProfile.enrolled': false,
    'faceProfile.embedding': [],
    'faceProfile.model': null,
    'faceProfile.status': 'failed',
    'faceProfile.reason': 'not_enrolled',
    'faceProfile.photoUrl': resolvedPhotoUrl,
    'faceProfile.sourcePhotoUrl': resolvedPhotoUrl,
    'faceProfile.quality': {},
    'faceProfile.updatedAt': new Date(),
  });

  if (!resolvedPhotoUrl) {
    return {
      enrolled: false,
      status: 'failed',
      reason: 'no_profile_photo',
      patch: failedPatch(),
    };
  }

  const imageBase64 = await fetchImageAsBase64(resolvedPhotoUrl);
  if (!imageBase64) {
    return {
      enrolled: false,
      status: 'failed',
      reason: 'profile_photo_unreadable',
      patch: failedPatch(),
      photoUrl: resolvedPhotoUrl,
    };
  }

  const enrollment = await enrollFace(imageBase64);
  const patch = {
    'faceProfile.enrolled': !!enrollment.enrolled,
    'faceProfile.model': enrollment.model || null,
    'faceProfile.status': enrollment.status || (enrollment.enrolled ? 'enrolled' : 'failed'),
    'faceProfile.reason': enrollment.enrolled ? null : (enrollment.reason || 'profile_face_not_enrolled'),
    'faceProfile.photoUrl': resolvedPhotoUrl,
    'faceProfile.sourcePhotoUrl': resolvedPhotoUrl,
    'faceProfile.quality': enrollment.quality || {},
    'faceProfile.updatedAt': new Date(),
  };

  if (enrollment.enrolled && Array.isArray(enrollment.embedding)) {
    patch['faceProfile.embedding'] = enrollment.embedding;
  } else {
    patch['faceProfile.embedding'] = [];
  }

  return { ...enrollment, patch, photoUrl: resolvedPhotoUrl };
}

module.exports = {
  FACE_VERIFY_URL,
  checkHealth,
  enrollFace,
  verifyFaceEmbedding,
  fetchImageAsBase64,
  enrollUserFaceProfile,
  getFaceEnrollmentMessage,
};
