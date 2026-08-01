const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const recommendationBaseUrl = trimTrailingSlash(
  process.env.RECOMMENDATION_SERVICE_URL || 'http://127.0.0.1:5001',
);
const cvParserBaseUrl = trimTrailingSlash(
  process.env.CV_PARSER_URL || 'http://127.0.0.1:5002',
);
const quizBaseUrl = trimTrailingSlash(
  process.env.QUIZ_SERVICE_URL || 'http://localhost:5003',
);
const hiringModelBaseUrl = trimTrailingSlash(
  process.env.HIRING_MODEL_URL || 'http://localhost:5000',
);
const interviewScoreBaseUrl = trimTrailingSlash(
  process.env.INTERVIEW_SCORE_URL || 'http://localhost:7000',
);
const schedulingBaseUrl = trimTrailingSlash(
  process.env.SCHEDULING_SERVICE_URL || 'http://localhost:5004',
);

module.exports = {
  RECOMMENDATION_BASE_URL: recommendationBaseUrl,
  RECOMMENDATION_SERVICE_URL: `${recommendationBaseUrl}/recommend`,
  CV_PARSER_URL: cvParserBaseUrl,
  CV_PARSER_UPLOAD_URL: `${cvParserBaseUrl}/upload`,
  QUIZ_SERVICE_URL: quizBaseUrl,
  QUIZ_GENERATE_URL: `${quizBaseUrl}/generate-quiz`,
  QUIZ_ADAPTIVE_NEXT_PAGE_URL: `${quizBaseUrl}/adaptive-next-page`,
  HIRING_MODEL_URL: hiringModelBaseUrl,
  HIRING_MODEL_PREDICT_URL: `${hiringModelBaseUrl}/predict-from-skills`,
  INTERVIEW_SCORE_URL: interviewScoreBaseUrl,
  INTERVIEW_SCORE_PREDICT_URL: `${interviewScoreBaseUrl}/predict`,
  SCHEDULING_SERVICE_URL: schedulingBaseUrl,
  REFRESH_RECOMMENDATION_INDEX_URL: `${recommendationBaseUrl}/refresh-index`,
};
