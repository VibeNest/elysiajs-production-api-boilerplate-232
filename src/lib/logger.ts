import pino from "pino";
import pretty from "pino-pretty";
import { env, isProduction, isTest } from "../config/env";

/**
 * Central structured logger (Pino).
 * - development → human-readable, colorized (pino-pretty as a stream — no worker
 *   thread, so it's safe under Bun and `bun build --compile`).
 * - production  → single-line JSON to stdout (ready for Loki/Datadog/CloudWatch).
 * - test        → silent (keeps test output clean).
 *
 * Use `logger` for app-wide events and `createLogger({...})` /
 * `logger.child({...})` to bind context (e.g. a requestId). Never use `console.*`
 * (the one exception is config/env.ts, which runs before the logger exists).
 */
const options = {
  level: isTest ? "silent" : env.LOG_LEVEL,
  // Safeguard against accidentally logging secrets.
  redact: [
    "req.headers.authorization",
    "headers.authorization",
    "password",
    "*.password",
    "accessToken",
    "*.accessToken",
    "refreshToken",
    "*.refreshToken",
  ],
};

export const logger =
  !isProduction && !isTest
    ? pino(options, pretty({ colorize: true, translateTime: "SYS:HH:MM:ss" }))
    : // Synchronous stdout so logs aren't buffered/lost on exit (important for
      // the compiled binary + SIGTERM). Swap to async + flush-on-shutdown if you
      // need maximum throughput at scale.
      pino(options, pino.destination({ sync: true }));

export const createLogger = (bindings: Record<string, unknown>) =>
  logger.child(bindings);
