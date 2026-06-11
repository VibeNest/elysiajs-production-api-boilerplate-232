import { RedisClient } from "bun";
import { env } from "@/config/env";
import { logger } from "@/lib/logger";

/**
 * Shared Redis client (Bun's built-in RedisClient — no extra dependency).
 * Connects lazily on first command and auto-reconnects; startup additionally
 * fail-fasts via lib/readiness.ts. Closed on graceful shutdown (see index.ts).
 */
export const redis = new RedisClient(env.REDIS_URL);

// Surface connection drops in the logs — without this a dead Redis is only
// visible as failed commands. Fires on graceful shutdown too (one warn line).
redis.onclose = (err) => logger.warn({ err }, "redis connection closed");

/**
 * Thin, reusable cache helpers. Not OTP-specific — use for any caching need.
 * Key convention: "<domain>:<name>:<id>" (e.g. "otp:verify:<userId>").
 */
export const cache = {
  get: (key: string) => redis.get(key),

  /** Set a value, optionally with a TTL in seconds. */
  set: (key: string, value: string, ttlSeconds?: number) =>
    ttlSeconds
      ? redis.set(key, value, "EX", ttlSeconds)
      : redis.set(key, value),

  del: (key: string) => redis.del(key),

  /** Atomic increment; returns the new value. Pair with `expire` for windows. */
  incr: (key: string) => redis.incr(key),

  expire: (key: string, ttlSeconds: number) => redis.expire(key, ttlSeconds),

  exists: (key: string) => redis.exists(key),
};
