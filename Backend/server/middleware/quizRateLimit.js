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
  keyGenerator: (req, res) => {
    // Use candidateId from request body as the key
    const candidateId = req.body?.candidateId || req.query?.candidateId || 'unknown';
    return `quiz-submit-${candidateId}`;
  },
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: parseInt(process.env.QUIZ_MAX_ATTEMPTS_PER_DAY || '3'),
  message: {
    status: 429,
    message: 'Too many quiz submissions. Maximum 3 attempts per 24 hours.',
    retryAfter: '24 hours',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req, res) => {
    // Skip rate limiting if security disabled
    return process.env.QUIZ_SECURITY_ENABLED === 'false';
  },
  handler: (req, res, options) => {
    res.status(options.statusCode).json({
      success: false,
      message: options.message,
      retryAfter: options.windowMs / 1000 / 60 + ' minutes',
    });
  },
});

module.exports = quizRateLimiter;
