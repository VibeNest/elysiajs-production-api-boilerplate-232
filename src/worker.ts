import { logger } from "./lib/logger";
import { waitForDependencies } from "./lib/readiness";
import { emailQueue } from "./queue/email.queue";
import {
  TOKEN_CLEANUP_INTERVAL_MS,
  tokenCleanupQueue,
} from "./queue/maintenance.queue";
import { scheduleRepeatable, startWorker } from "./queue/runtime";

// Background worker entrypoint. Run alongside the API: `bun run worker`
// (dev) or as a separate container in production (see docker-compose.prod.yml).

// Fail fast like the API does: BullMQ needs Redis and the job processors hit
// Postgres — starting without either just burns retries on every job.
try {
  await waitForDependencies();
} catch (err) {
  logger.fatal({ err }, "dependencies unavailable — exiting");
  process.exit(1);
}

const workers = [startWorker(emailQueue), startWorker(tokenCleanupQueue)];

// Register recurring maintenance (idempotent — BullMQ dedupes the schedule).
await scheduleRepeatable(tokenCleanupQueue, undefined, {
  every: TOKEN_CLEANUP_INTERVAL_MS,
});

logger.info(
  { queues: [emailQueue.name, tokenCleanupQueue.name] },
  "🛠️  worker ready",
);

const shutdown = async (signal: string) => {
  logger.info({ signal }, "shutting down worker");
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
