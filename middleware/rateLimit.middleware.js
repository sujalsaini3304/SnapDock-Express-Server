import redis from "../config/redis.js";

/**
 * Redis-backed rate limiter.
 *
 * Why not express-rate-limit?
 *   - express-rate-limit stores counters in-memory (per process).
 *   - With Node.js clustering, each worker has its own counter.
 *   - A user could send 5 × N requests (where N = workers) before being blocked.
 *   - Redis counters are shared across ALL workers → accurate limiting.
 *
 * Uses atomic INCR + EXPIRE for race-condition safety.
 */
function createRedisRateLimiter({ windowMs = 60000, max = 5, message = "Too many requests. Slow down." } = {}) {
  const windowSeconds = Math.ceil(windowMs / 1000);

  return async (req, res, next) => {
    try {
      // Build key from IP + route path
      const ip = req.ip || req.connection.remoteAddress || "unknown";
      const key = `rl:${ip}:${req.baseUrl}${req.path}`;

      // Atomic increment
      const current = await redis.incr(key);

      // Set TTL on first request in window
      if (current === 1) {
        await redis.expire(key, windowSeconds);
      }

      // Check limit
      if (current > max) {
        return res.status(429).json({ message });
      }

      // Add rate limit headers
      res.set("X-RateLimit-Limit", String(max));
      res.set("X-RateLimit-Remaining", String(Math.max(0, max - current)));

      return next();

    } catch {
      // Redis down → allow request through (fail-open)
      // Better to let a few extra requests through than to block everyone
      return next();
    }
  };
}


// Upload signature rate limiter: 5 requests per minute
export const uploadLimiter = createRedisRateLimiter({
  windowMs: 60 * 1000,
  max: 5,
  message: "Too many requests. Slow down.",
});
