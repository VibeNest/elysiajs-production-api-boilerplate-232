import { trace } from "@opentelemetry/api";
import { Elysia } from "elysia";
import { logger } from "@/lib/logger";

/**
 * Per-request logging. Adds a `requestId` and a bound child `log` to the context
 * (scoped) so handlers and services can log with request correlation. Each
 * completed request is logged with method, path, status and duration. With
 * tracing on (OTEL_ENABLED) the active `traceId` is bound too, linking every
 * log line to its trace.
 */
export const loggerPlugin = new Elysia({ name: "logger" })
  .derive({ as: "scoped" }, () => {
    const requestId = crypto.randomUUID();
    // Set by the otel plugin's request span; undefined when tracing is off.
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    return {
      requestId,
      startedAt: performance.now(),
      log: logger.child(traceId ? { requestId, traceId } : { requestId }),
    };
  })
  .onAfterResponse({ as: "scoped" }, ({ request, set, startedAt, log }) => {
    // `derive` doesn't run for unmatched routes (404s), so `log`/`startedAt`
    // can be undefined here — fall back to the root logger and omit duration.
    (log ?? logger).info(
      {
        method: request.method,
        path: new URL(request.url).pathname,
        status: set.status,
        durationMs:
          startedAt !== undefined
            ? Number((performance.now() - startedAt).toFixed(1))
            : undefined,
      },
      "request",
    );
  });
