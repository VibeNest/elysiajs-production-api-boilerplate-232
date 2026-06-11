import { queryClient } from "@/db";
import { redis } from "@/lib/cache";
import { logger } from "@/lib/logger";

/** How long a single dependency ping may take before it counts as down. */
const PING_TIMEOUT_MS = 2000;

/**
 * Resolve `work`, or reject once the deadline passes. Needed because a ping
 * against a dead dependency doesn't necessarily reject: Bun's RedisClient
 * auto-reconnects and queues commands while disconnected, so `send()` simply
 * never settles — without a deadline both startup and /ready would hang.
 */
export function withDeadline<T>(work: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms`)),
      ms,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Dependency pings shared by the /ready endpoint (plugins/health.ts) and the
 * boot-time fail-fast check in the entrypoints (index.ts, worker.ts). Both
 * clients connect lazily, so without a boot check a dead Postgres/Redis only
 * surfaces on the first real request.
 */
export async function pingPostgres(): Promise<boolean> {
  try {
    await withDeadline(queryClient`SELECT 1`, PING_TIMEOUT_MS);
    return true;
  } catch (err) {
    logger.error({ err, dependency: "postgres" }, "dependency check failed");
    return false;
  }
}

export async function pingRedis(): Promise<boolean> {
  try {
    await withDeadline(redis.send("PING", []), PING_TIMEOUT_MS);
    return true;
  } catch (err) {
    logger.error({ err, dependency: "redis" }, "dependency check failed");
    return false;
  }
}

export interface DependencyCheck {
  name: string;
  ping: () => Promise<boolean>;
}

export const dependencyChecks: DependencyCheck[] = [
  { name: "postgres", ping: pingPostgres },
  { name: "redis", ping: pingRedis },
];

/**
 * Block until every dependency answers, retrying with a fixed delay (covers
 * container orchestration where the API starts before its dependencies are
 * accepting connections). Throws after `attempts` rounds so the caller can
 * log fatal and exit non-zero instead of serving guaranteed failures.
 */
export async function waitForDependencies(
  checks: DependencyCheck[] = dependencyChecks,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 10;
  const delayMs = opts.delayMs ?? 1000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const results = await Promise.all(
      checks.map(async (check) => ({
        name: check.name,
        ok: await check.ping(),
      })),
    );
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    if (failed.length === 0) return;

    if (attempt === attempts)
      throw new Error(
        `dependencies unavailable after ${attempts} attempts: ${failed.join(", ")}`,
      );

    logger.warn(
      { failed, attempt, attempts },
      "dependencies not ready — retrying",
    );
    await Bun.sleep(delayMs);
  }
}
