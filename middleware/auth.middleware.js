import crypto from "crypto";
import admin from "../firebaseAdmin.config.js";
import { setCache, getCache } from "../config/redis.js";

const AUTH_CACHE_TTL = 300; // 5 minutes

/**
 * Auth middleware — verifies Firebase Bearer token.
 *
 * Flow:
 *   1. Extract token from Authorization header
 *   2. Hash the token → check Redis cache
 *   3. Cache HIT  → attach req.user, skip Firebase call
 *   4. Cache MISS → call Firebase verifyIdToken()
 *                  → cache the result in Redis (5 min TTL)
 *                  → attach req.user
 *
 * Saves ~150-300ms per request when cached (no network call to Google).
 */
export async function authMiddleware(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader?.startsWith("Bearer ")) {
            return res.status(401).json({ success: false, message: "Unauthorized" });
        }

        const token = authHeader.split("Bearer ")[1];

        // Hash token to use as Redis key (never store raw tokens)
        const tokenHash = crypto
            .createHash("sha256")
            .update(token)
            .digest("hex")
            .slice(0, 32); // first 32 chars is enough for uniqueness

        const cacheKey = `auth:${tokenHash}`;

        // 1. Check Redis cache
        const cached = await getCache(cacheKey);
        if (cached) {
            req.user = cached;
            return next();
        }

        // 2. Cache miss — verify with Firebase
        const decodedToken = await admin.auth().verifyIdToken(token);

        const userData = {
            sub: decodedToken.uid,
            email: decodedToken.email || null,
        };

        // 3. Cache the result (5 min TTL)
        await setCache(cacheKey, userData, AUTH_CACHE_TTL);

        req.user = userData;
        return next();

    } catch (err) {
        console.error("Auth middleware error:", err.message);
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
}
