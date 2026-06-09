import { Elysia } from "elysia";
import { logger } from "../lib/logger";

/**
 * Per-request logging. Adds a `requestId` and a bound child `log` to the context
 * (scoped) so handlers and services can log with request correlation. Each
 * completed request is logged with method, path, status and duration.
 */
export const loggerPlugin = new Elysia({ name: "logger" })
  .derive({ as: "scoped" }, () => {
    const requestId = crypto.randomUUID();
    return {
      requestId,
      startedAt: performance.now(),
      log: logger.child({ requestId }),
    };
  })
  .onAfterResponse({ as: "scoped" }, ({ request, set, startedAt, log }) => {
    log.info(
      {
        method: request.method,
        path: new URL(request.url).pathname,
        status: set.status,
        durationMs: Number((performance.now() - startedAt).toFixed(1)),
      },
      "request",
    );
  });
