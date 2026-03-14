import Redis from "ioredis";
import { promisify } from "util";
import zlib from "zlib";
import dotenv from "dotenv";

dotenv.config();

// ──────────────────────────────────────────
// Redis Client
// ──────────────────────────────────────────

const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    retryStrategy(times) {
        if (times > 5) return null;  // stop retrying after 5 attempts
        return Math.min(times * 200, 2000);
    },
});

redis.on("connect", () => console.log("Redis connected"));
redis.on("error", (err) => console.error("Redis error:", err.message));


// ──────────────────────────────────────────
// Gzip Helpers — compress before storing,
// decompress after reading.
// Saves ~70-80% memory in Redis (30MB cap).
// ──────────────────────────────────────────

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/**
 * Store compressed JSON in Redis.
 * @param {string} key
 * @param {any}    data   – will be JSON.stringified
 * @param {number} ttlSeconds
 */
export async function setCompressed(key, data, ttlSeconds) {
    try {
        const json = JSON.stringify(data);
        const compressed = await gzip(Buffer.from(json));
        await redis.set(key, compressed, "EX", ttlSeconds);
    } catch {
        // Redis down or compression failed — silently skip.
        // App continues working without cache.
    }
}

/**
 * Read and decompress JSON from Redis.
 * @param  {string} key
 * @return {any|null}  parsed object or null on miss / error
 */
export async function getCompressed(key) {
    try {
        const raw = await redis.getBuffer(key);
        if (!raw) return null;
        const decompressed = await gunzip(raw);
        return JSON.parse(decompressed.toString());
    } catch {
        return null; // Cache miss or Redis down — fall through to DB
    }
}


// ──────────────────────────────────────────
// Plain get/set for small values
// (auth tokens, counters — no compression needed)
// ──────────────────────────────────────────

/**
 * Store a small JSON value in Redis (no compression).
 */
export async function setCache(key, data, ttlSeconds) {
    try {
        await redis.set(key, JSON.stringify(data), "EX", ttlSeconds);
    } catch {
        // Silently skip
    }
}

/**
 * Read a small JSON value from Redis.
 */
export async function getCache(key) {
    try {
        const raw = await redis.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/**
 * Delete one or more keys.
 */
export async function deleteCache(...keys) {
    try {
        if (keys.length > 0) await redis.del(...keys);
    } catch {
        // Silently skip
    }
}

/**
 * Delete all keys matching a pattern (e.g. "batch:userId123").
 * Uses SCAN to avoid blocking Redis.
 */
export async function deleteCacheByPattern(pattern) {
    try {
        const stream = redis.scanStream({ match: pattern, count: 100 });
        const pipeline = redis.pipeline();
        let count = 0;

        for await (const keys of stream) {
            if (keys.length) {
                keys.forEach((key) => pipeline.del(key));
                count += keys.length;
            }
        }

        if (count > 0) await pipeline.exec();
    } catch {
        // Silently skip
    }
}


export default redis;
