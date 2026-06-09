import { app } from "./app";
import { env } from "./config/env";
import { queryClient } from "./db";
import { redis } from "./lib/cache";
import { logger } from "./lib/logger";
import { emailQueue } from "./queue/email.queue";

app.listen(
  {
    port: env.PORT,
    // Bun.serve hardening: cap request body size and idle connection time.
    maxRequestBodySize: env.MAX_BODY_SIZE,
    idleTimeout: env.REQUEST_IDLE_TIMEOUT,
  },
  () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, docs: `/openapi` },
      `🦊 Elysia running at http://localhost:${env.PORT}`,
    );
  },
);

// Graceful shutdown: stop accepting requests, then close the DB pool.
const shutdown = async (signal: string) => {
  logger.info({ signal }, "shutting down");
  await app.stop();
  await queryClient.end({ timeout: 5 });
  redis.close();
  // Close queue producers (no-op in sync mode).
  await emailQueue.bull?.close();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
