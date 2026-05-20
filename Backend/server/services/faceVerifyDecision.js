function normalizeFaceResultStatus(result = {}) {
  const rawStatus = result.status;
  const reason = result.reason;
  if (rawStatus === 'matched') return 'matched';
  if (rawStatus === 'not_matched') return 'not_matched';
  if (rawStatus === 'not_enrolled') return 'not_enrolled';
  if (rawStatus === 'liveness_failed') return 'liveness_failed';
  if (rawStatus === 'multiple_faces' || reason === 'multiple_faces') return 'multiple_faces';
  if (rawStatus === 'no_face' || reason === 'no_face' || reason === 'no_valid_face') return 'no_face';
  if (rawStatus === 'low_quality' || reason === 'low_quality') return 'low_quality';
  if (rawStatus === 'failed') return 'failed';
  return 'uncertain';
}

function hasStrictFaceMatch(result = {}, config = {}) {
  const threshold = Number(result.threshold ?? config.threshold ?? 0.60);
  const requiredFrames = Number(config.requiredFrames ?? 3);
  const minMatchingFrames = Number(config.minMatchingFrames ?? 2);
  const similarity = Number(result.medianSimilarity ?? result.similarity ?? result.bestSimilarity ?? 0);
  const matchingFrames = Number(result.matchingFrames ?? 0);
  const totalFrames = Number(result.totalFrames ?? result.framesChecked ?? 0);

  return (
    result.status === 'matched' &&
    result.verified === true &&
    result.allowInterview === true &&
    Number.isFinite(similarity) &&
    similarity >= threshold &&
    matchingFrames >= minMatchingFrames &&
    totalFrames >= requiredFrames
  );
}

function decideStartStatus({
  faceProfile,
  livenessPassed,
  serviceResult,
} = {}, config = {}) {
  const embedding = faceProfile?.embedding;
  if (faceProfile?.enrolled !== true || !Array.isArray(embedding) || embedding.length === 0) {
    return { status: 'not_enrolled', allowInterview: false };
  }

  if (livenessPassed !== true) {
    return { status: 'liveness_failed', allowInterview: false };
  }

  if (hasStrictFaceMatch(serviceResult, config)) {
    return { status: 'matched', allowInterview: true };
  }

  return {
    status: normalizeFaceResultStatus(serviceResult),
    allowInterview: false,
  };
}

module.exports = {
  normalizeFaceResultStatus,
  hasStrictFaceMatch,
  decideStartStatus,
};
