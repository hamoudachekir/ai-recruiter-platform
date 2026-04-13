const rateLimit = require('express-rate-limit');

// For production, Redis can be enabled with QUIZ_RATE_LIMIT_USE_REDIS=true.
// In development, in-memory store is used by default.
let store;

if (String(process.env.QUIZ_RATE_LIMIT_USE_REDIS || 'false').toLowerCase() === 'true') {
  try {
    const RedisStore = require('rate-limit-redis');
    const { createClient } = require('redis');
    const redisUrl = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || 6379}`;
    const redisClient = createClient({ url: redisUrl });

    redisClient.connect().catch((error) => {
      console.warn('⚠️ Redis connection failed, using in-memory rate limiter:', error.message);
    });

    store = new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix: 'quiz-rate-limit:',
    });
  } catch (error) {
    console.warn('⚠️ Redis rate-limit dependencies unavailable, using in-memory store:', error.message);
    store = undefined;
  }
}

/**
 * Rate limiter for quiz submissions
 * Default: 3 attempts per 24 hours per candidate
 */
const quizRateLimiter = rateLimit({
  store: store,
  keyGenerator: (req) => {
    // Scope rate limit by candidate + job to avoid cross-job lockouts.
    const candidateId = String(req.body?.candidateId || req.query?.candidateId || '').trim();
    const jobId = String(req.body?.jobId || req.query?.jobId || '').trim();

    if (candidateId && jobId) {
      return `quiz-submit-${candidateId}-${jobId}`;
    }

    if (candidateId) {
      return `quiz-submit-${candidateId}`;
    }

    // Fallback keeps IPv6 handling safe when candidate id is unavailable.
    return `quiz-submit-ip-${rateLimit.ipKeyGenerator(req.ip)}`;
  },
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: Number.parseInt(process.env.QUIZ_MAX_ATTEMPTS_PER_DAY || '3', 10),
  message: 'Too many quiz submissions. Maximum 3 attempts per 24 hours.',
  standardHeaders: true,
  legacyHeaders: false,
  // Validation errors should not consume attempts.
  skipFailedRequests: true,
  skip: (req, res) => {
    // Skip rate limiting if security disabled
    return process.env.QUIZ_SECURITY_ENABLED === 'false';
  },
  handler: (req, res, next, options) => {
    const statusCode = Number(options?.statusCode) || 429;
    const configuredMessage = options?.message;
    const message = typeof configuredMessage === 'string'
      ? configuredMessage
      : (configuredMessage?.message || 'Too many quiz submissions. Please try again later.');
    const retryAfterSeconds = res.getHeader('Retry-After');

    res.status(statusCode).json({
      success: false,
      status: statusCode,
      message,
      retryAfter: retryAfterSeconds ? `${retryAfterSeconds} seconds` : '24 hours',
    });
  },
});

module.exports = quizRateLimiter;
