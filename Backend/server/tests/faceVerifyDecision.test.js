const assert = require('assert');
const {
  decideStartStatus,
  hasStrictFaceMatch,
} = require('../services/faceVerifyDecision');
const { FACE_CANDIDATE_SELECT } = require('../services/faceVerifyCandidateLoader');

const config = {
  threshold: 0.60,
  requiredFrames: 3,
  minMatchingFrames: 2,
};

const enrolledProfile = {
  enrolled: true,
  embedding: [0.1, 0.2, 0.3],
};

const selectTokens = FACE_CANDIDATE_SELECT.split(/\s+/).filter(Boolean);
assert.strictEqual(
  selectTokens.includes('faceProfile'),
  false,
  'candidate face projection must not select faceProfile parent with faceProfile.embedding child',
);
assert.strictEqual(
  selectTokens.includes('+faceProfile.embedding'),
  true,
  'candidate face projection must explicitly include hidden embedding child',
);

function matchedResult(overrides = {}) {
  return {
    status: 'matched',
    verified: true,
    allowInterview: true,
    metric: 'cosine_similarity',
    similarity: 0.72,
    medianSimilarity: 0.72,
    threshold: 0.60,
    matchingFrames: 3,
    totalFrames: 3,
    ...overrides,
  };
}

assert.strictEqual(hasStrictFaceMatch(matchedResult(), config), true, 'same person should pass strict match');

assert.deepStrictEqual(
  decideStartStatus({
    faceProfile: enrolledProfile,
    livenessPassed: true,
    serviceResult: matchedResult(),
  }, config),
  { status: 'matched', allowInterview: true },
  'matched profile and live face should allow interview',
);

const decision = decideStartStatus({
  faceProfile: enrolledProfile,
  livenessPassed: true,
  serviceResult: matchedResult(),
}, config);
assert.strictEqual(JSON.stringify(decision).includes('embedding'), false, 'public decisions must not expose embedding');

assert.deepStrictEqual(
  decideStartStatus({
    faceProfile: enrolledProfile,
    livenessPassed: true,
    serviceResult: matchedResult({
      status: 'not_matched',
      verified: false,
      allowInterview: false,
      similarity: 0.31,
      medianSimilarity: 0.31,
      matchingFrames: 0,
    }),
  }, config),
  { status: 'not_matched', allowInterview: false },
  'different person should not allow interview',
);

assert.deepStrictEqual(
  decideStartStatus({
    faceProfile: { enrolled: false, embedding: [] },
    livenessPassed: true,
    serviceResult: matchedResult(),
  }, config),
  { status: 'not_enrolled', allowInterview: false },
  'missing profile embedding should fail closed',
);

assert.deepStrictEqual(
  decideStartStatus({
    faceProfile: enrolledProfile,
    livenessPassed: true,
    serviceResult: { status: 'no_face', verified: false, allowInterview: false, reason: 'no_face' },
  }, config),
  { status: 'no_face', allowInterview: false },
  'no live face should fail closed',
);

assert.deepStrictEqual(
  decideStartStatus({
    faceProfile: enrolledProfile,
    livenessPassed: true,
    serviceResult: { status: 'multiple_faces', verified: false, allowInterview: false, reason: 'multiple_faces' },
  }, config),
  { status: 'multiple_faces', allowInterview: false },
  'multiple live faces should fail closed',
);

assert.deepStrictEqual(
  decideStartStatus({
    faceProfile: enrolledProfile,
    livenessPassed: true,
    serviceResult: { status: 'failed', verified: false, allowInterview: false, reason: 'service_unavailable' },
  }, config),
  { status: 'failed', allowInterview: false },
  'face service error should fail closed',
);

assert.deepStrictEqual(
  decideStartStatus({
    faceProfile: enrolledProfile,
    livenessPassed: true,
    serviceResult: { status: 'uncertain', verified: false, allowInterview: false, reason: 'low_quality' },
  }, config),
  { status: 'low_quality', allowInterview: false },
  'uncertain low quality result should fail closed',
);

assert.deepStrictEqual(
  decideStartStatus({
    faceProfile: enrolledProfile,
    livenessPassed: false,
    serviceResult: matchedResult(),
  }, config),
  { status: 'liveness_failed', allowInterview: false },
  'failed liveness should block even if the service result says matched',
);

assert.strictEqual(
  hasStrictFaceMatch(matchedResult({ matchingFrames: 1 }), config),
  false,
  'one lucky matching frame should not pass',
);

console.log('faceVerifyDecision fail-closed tests passed');
