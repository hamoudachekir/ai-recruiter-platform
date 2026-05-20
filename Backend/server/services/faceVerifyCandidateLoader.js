const { UserModel } = require('../models/user');

const FACE_CANDIDATE_SELECT = [
  'name',
  'email',
  'picture',
  'linkedin.profilePhoto',
  'faceProfile.enrolled',
  '+faceProfile.embedding',
  'faceProfile.model',
  'faceProfile.status',
  'faceProfile.reason',
  'faceProfile.photoUrl',
  'faceProfile.sourcePhotoUrl',
  'faceProfile.updatedAt',
].join(' ');

function normalizeUserQuery(userIdOrQuery) {
  if (
    userIdOrQuery &&
    typeof userIdOrQuery === 'object' &&
    !Array.isArray(userIdOrQuery) &&
    !userIdOrQuery._bsontype &&
    typeof userIdOrQuery.toHexString !== 'function'
  ) {
    return userIdOrQuery;
  }
  return { _id: userIdOrQuery };
}

async function loadCandidateForFaceVerification(userIdOrQuery) {
  const query = normalizeUserQuery(userIdOrQuery);
  const user = await UserModel.findOne(query)
    .select(FACE_CANDIDATE_SELECT)
    .lean();

  if (!user) {
    return {
      ok: false,
      status: 'candidate_not_found',
      allowInterview: false,
      message: 'Candidate not found.',
    };
  }

  const embedding = user.faceProfile?.embedding;
  if (user.faceProfile?.enrolled !== true || !Array.isArray(embedding) || embedding.length === 0) {
    return {
      ok: false,
      status: 'not_enrolled',
      allowInterview: false,
      user,
      message: 'Please upload a clear profile photo before starting the interview.',
    };
  }

  return {
    ok: true,
    user,
    embedding,
  };
}

module.exports = {
  FACE_CANDIDATE_SELECT,
  loadCandidateForFaceVerification,
};
