import { Worker } from "bullmq";
import { sendAlert } from "@/lib/alert";
import { logger } from "@/lib/logger";
import { connection } from "./connection";
import type { QueueDef } from "./define";

/** The slice of a BullMQ job that failure handling needs (kept narrow for tests). */
export interface FailedJobInfo {
  id?: string;
  attemptsMade: number;
  opts?: { attempts?: number };
}

/**
 * Handle a job failure: warn while retries remain, escalate to an error log +
 * ops alert once the job has exhausted its attempts (it won't run again, so
 * someone has to look). Exported separately from the worker wiring so the
 * final-attempt logic is testable without a live BullMQ worker.
 */
export async function handleJobFailure(
  queueName: string,
  job: FailedJobInfo | undefined,
  err: Error,
): Promise<void> {
  const maxAttempts = job?.opts?.attempts ?? 1;
  const isFinal = (job?.attemptsMade ?? maxAttempts) >= maxAttempts;
  const fields = {
    queue: queueName,
    jobId: job?.id,
    attemptsMade: job?.attemptsMade,
    maxAttempts,
    err,
  };

  if (!isFinal) {
    logger.warn(fields, "queue job failed — will retry");
    return;
  }

  logger.error(fields, "queue job permanently failed");
  await sendAlert({
    title: "queue job permanently failed",
    message: `${queueName} job ${job?.id ?? "?"} exhausted ${maxAttempts} attempts: ${err.message}`,
    context: { queue: queueName, jobId: job?.id, error: err.message },
  });
}

/**
 * Start a BullMQ worker for a queue. Only valid in "redis" driver mode — run
 * from the worker entrypoint (src/worker.ts).
 */
export function startWorker<T>(q: QueueDef<T>): Worker<T> {
  if (!connection)
    throw new Error(
      "Cannot start a worker without a Redis connection (set QUEUE_DRIVER=redis)",
    );

  const worker = new Worker<T>(q.name, (job) => q.processor(job.data), {
    connection,
    concurrency: 5,
  });

  worker.on("failed", (job, err) => void handleJobFailure(q.name, job, err));

  return worker;
}

/**
 * Register a repeatable (cron-like) job that fires every `every` ms. No-op under
 * the "sync" driver (no BullMQ queue). BullMQ dedupes by repeat key, so calling
 * this on every worker start is safe and won't pile up schedulers.
 */
export async function scheduleRepeatable<T>(
  q: QueueDef<T>,
  data: T,
  opts: { every: number },
): Promise<void> {
  if (!q.bull) return;
  await q.bull.add(q.name, data, {
    repeat: { every: opts.every },
    removeOnComplete: true,
    removeOnFail: 100,
  });
}
