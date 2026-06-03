const rateLimit = require('express-rate-limit');

// Mirrors the pattern in middleware/quizRateLimit.js: in-memory store by
// default, Redis-backed when AI_RATE_LIMIT_USE_REDIS=true (or the existing
// QUIZ_RATE_LIMIT_USE_REDIS flag, to keep one knob in prod).
let store;

const useRedis = String(
  process.env.AI_RATE_LIMIT_USE_REDIS || process.env.QUIZ_RATE_LIMIT_USE_REDIS || 'false'
).toLowerCase() === 'true';

if (useRedis) {
  try {
    const RedisStore = require('rate-limit-redis');
    const { createClient } = require('redis');
    const redisUrl =
      process.env.REDIS_URL ||
      `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || 6379}`;
    const redisClient = createClient({ url: redisUrl });

    redisClient.connect().catch((error) => {
      console.warn('⚠️ Redis connection failed for AI rate limiter, using in-memory store:', error.message);
    });

    store = new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix: 'ai-gen-rate-limit:',
    });
  } catch (error) {
    console.warn('⚠️ Redis rate-limit dependencies unavailable, using in-memory store:', error.message);
    store = undefined;
  }
}

const MAX_PER_MINUTE = Number.parseInt(process.env.AI_GENERATION_MAX_PER_MINUTE || '10', 10);

/**
 * Per-user rate limiter for the Gemini-backed wizard endpoints.
 * Default: 10 requests per minute per authenticated user.
 *
 * Must run AFTER verifyToken so req.user._id is populated.
 */
const aiGenerationRateLimiter = rateLimit({
  store,
  keyGenerator: (req) => {
    const userId = req.user?._id ? String(req.user._id) : null;
    if (userId) return `ai-gen-${userId}`;
    // Fallback (should not happen if verifyToken runs first).
    return `ai-gen-ip-${rateLimit.ipKeyGenerator(req.ip)}`;
  },
  windowMs: 60 * 1000,
  max: MAX_PER_MINUTE,
  message: `Too many AI generation requests. Please wait and try again. Limit: ${MAX_PER_MINUTE}/minute.`,
  standardHeaders: true,
  legacyHeaders: false,
  // Don't burn budget on validation failures.
  skipFailedRequests: true,
  handler: (req, res, next, options) => {
    const statusCode = Number(options?.statusCode) || 429;
    const configuredMessage = options?.message;
    const message = typeof configuredMessage === 'string'
      ? configuredMessage
      : (configuredMessage?.message || 'Too many AI generation requests. Please wait and try again.');
    const retryAfterSeconds = res.getHeader('Retry-After');

    res.status(statusCode).json({
      message,
      retryAfter: retryAfterSeconds ? `${retryAfterSeconds} seconds` : '1 minute',
    });
  },
});

module.exports = aiGenerationRateLimiter;
