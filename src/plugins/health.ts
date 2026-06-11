import { Elysia } from "elysia";
import { pingPostgres, pingRedis } from "@/lib/readiness";

/**
 * Liveness vs readiness.
 *
 * - `GET /health` — **shallow** liveness. Returns 200 as long as the process is
 *   up. Cheap; safe to poll aggressively. Use for a k8s liveness probe.
 * - `GET /ready` — **deep** readiness. Verifies the process can actually serve
 *   traffic by pinging Postgres (`SELECT 1`) and Redis (`PING`). Returns 503 if
 *   any dependency is down so a load balancer / k8s readiness probe stops
 *   routing to this instance. The same pings gate startup (lib/readiness.ts).
 */
export const healthPlugin = new Elysia({ name: "health" })
  .get("/health", () => ({ status: "ok", uptime: process.uptime() }), {
    detail: { summary: "Liveness check", tags: ["App"] },
  })
  .get(
    "/ready",
    async ({ set }) => {
      const [db, redisOk] = await Promise.all([pingPostgres(), pingRedis()]);

      const ready = db && redisOk;
      if (!ready) set.status = 503;
      return {
        status: ready ? "ready" : "unavailable",
        checks: {
          db: db ? "ok" : "down",
          redis: redisOk ? "ok" : "down",
        },
      };
    },
    {
      detail: { summary: "Readiness check (Postgres + Redis)", tags: ["App"] },
    },
  );
