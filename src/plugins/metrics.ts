import { Elysia } from "elysia";
import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Registry,
} from "prom-client";
import { emailQueue } from "@/queue/email.queue";

/**
 * Prometheus metrics, exposed at `GET /metrics` in the text exposition format.
 *
 * Scrape this from your monitoring stack (Prometheus/Grafana/etc.). The endpoint
 * is unauthenticated — keep it on an internal network or behind your ingress, or
 * add a guard if it must be public.
 *
 * Request labels use the matched route pattern (`/users/:id`), not the raw path,
 * to keep label cardinality bounded.
 */
const register = new Registry();
collectDefaultMetrics({ register });

const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status"],
  registers: [register],
});

// Background-queue depth by state. Best-effort: a no-op under the sync driver
// (no BullMQ queue) and never lets a scrape failure break /metrics.
new Gauge({
  name: "queue_jobs",
  help: "Background queue jobs by state",
  labelNames: ["queue", "state"],
  registers: [register],
  async collect() {
    const bull = emailQueue.bull;
    if (!bull) return;
    try {
      const counts = await bull.getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
      );
      for (const [state, value] of Object.entries(counts))
        this.set({ queue: emailQueue.name, state }, value);
    } catch {
      // ignore — a Redis hiccup shouldn't fail the whole scrape
    }
  },
});

export const metricsPlugin = new Elysia({ name: "metrics" })
  .derive({ as: "scoped" }, () => ({ metricStart: performance.now() }))
  .onAfterResponse({ as: "scoped" }, ({ request, route, set, metricStart }) => {
    const labels = {
      method: request.method,
      route: route || "unmatched",
      status: String(set.status ?? 200),
    };
    httpRequestsTotal.inc(labels);
    // `derive` doesn't run for unmatched routes (404s), so metricStart can be
    // undefined — count the request but only record duration when we timed it
    // (observing NaN would permanently poison the histogram's sum).
    if (metricStart !== undefined)
      httpRequestDuration.observe(
        labels,
        (performance.now() - metricStart) / 1000,
      );
  })
  .get(
    "/metrics",
    async ({ set }) => {
      set.headers["content-type"] = register.contentType;
      return register.metrics();
    },
    { detail: { summary: "Prometheus metrics", tags: ["App"] } },
  );
