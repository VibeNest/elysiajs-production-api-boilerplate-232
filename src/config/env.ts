import { Value } from "@sinclair/typebox/value";
import { t } from "elysia";

/**
 * Environment variable schema — the single source of truth for configuration.
 * Validated once at boot; if anything is missing or malformed the process
 * exits before the server ever starts listening.
 */
const EnvSchema = t.Object({
  NODE_ENV: t.Union(
    [t.Literal("development"), t.Literal("production"), t.Literal("test")],
    { default: "development" },
  ),
  PORT: t.Number({ default: 3000 }),
  // Product name shown in transactional email (lib/mail-templates.ts).
  APP_NAME: t.String({ default: "App" }),

  // Postgres connection string, e.g. postgres://user:pass@localhost:5432/app
  DATABASE_URL: t.String({ minLength: 1 }),
  // Connection pool tuning (postgres.js). Size the pool to your DB's
  // max_connections divided across API + worker replicas.
  DB_POOL_MAX: t.Number({ default: 10 }),
  DB_IDLE_TIMEOUT: t.Number({ default: 30 }), // seconds before an idle conn closes
  DB_CONNECT_TIMEOUT: t.Number({ default: 30 }), // seconds to wait for a connection
  // Per-query timeout in ms (0 = disabled). Cancels runaway queries
  // server-side so they can't hold a pool slot (and a request) indefinitely.
  // Raise it if bulk maintenance jobs outgrow it — they share this pool.
  DB_STATEMENT_TIMEOUT: t.Number({ default: 30_000 }),

  // Auth — access-token secret (keep it long and random in production).
  // Refresh tokens are opaque random strings, no signing secret needed.
  JWT_SECRET: t.String({ minLength: 16 }),
  // Zero-downtime secret rotation: put the old secret here while deploying a
  // new JWT_SECRET — in-flight access tokens stay valid for the rotation
  // window. Drop it once JWT_ACCESS_EXP has passed. Empty = disabled.
  JWT_SECRET_PREVIOUS: t.String({ default: "" }),
  JWT_ACCESS_EXP: t.String({ default: "15m" }),
  JWT_REFRESH_EXP: t.String({ default: "7d" }),
  // Refresh-token transport: "bearer" (JSON body) or "cookie" (httpOnly
  // cookie scoped to /auth; pair with a restricted CORS_ORIGIN in production).
  AUTH_TRANSPORT: t.Union([t.Literal("bearer"), t.Literal("cookie")], {
    default: "bearer",
  }),
  // Require a verified email on protected routes (403 EMAIL_NOT_VERIFIED until
  // verified; exempt: /auth/me, /auth/logout, /auth/email/*). When on, register
  // auto-emails the verification OTP.
  REQUIRE_VERIFIED_EMAIL: t.Boolean({ default: false }),

  // Comma-separated list of allowed origins, or "*" for any.
  CORS_ORIGIN: t.String({ default: "*" }),

  // Log level: trace | debug | info | warn | error | fatal | silent.
  LOG_LEVEL: t.String({ default: "info" }),

  // Trust X-Forwarded-For for client IP (enable behind a proxy/load balancer).
  TRUST_PROXY: t.Boolean({ default: false }),

  // Max request body size in bytes (Bun rejects larger with 413). Default 1 MiB.
  MAX_BODY_SIZE: t.Number({ default: 1024 * 1024 }),
  // Connection idle timeout in seconds (Bun.serve idleTimeout, max 255).
  REQUEST_IDLE_TIMEOUT: t.Number({ default: 30 }),

  // Redis connection string (caching, OTP storage).
  REDIS_URL: t.String({ default: "redis://localhost:6379" }),

  // Email transport: "auto" (log in dev, smtp in prod), or force "log"/"smtp".
  MAIL_TRANSPORT: t.Union(
    [t.Literal("auto"), t.Literal("log"), t.Literal("smtp")],
    { default: "auto" },
  ),
  // SMTP (via nodemailer). Defaults target Mailtrap's sandbox; fill USER/PASS to send.
  EMAIL_FROM: t.String({ default: "no-reply@example.com" }),
  SMTP_HOST: t.String({ default: "sandbox.smtp.mailtrap.io" }),
  SMTP_PORT: t.Number({ default: 2525 }),
  SMTP_USER: t.String({ default: "" }),
  SMTP_PASS: t.String({ default: "" }),
  SMTP_SECURE: t.Boolean({ default: false }),

  // Job queue driver: "redis" (BullMQ worker) or "sync" (inline; used in tests).
  QUEUE_DRIVER: t.Union([t.Literal("redis"), t.Literal("sync")], {
    default: "redis",
  }),

  // Ops alert webhook (Slack/Discord/PagerDuty-compatible JSON POST). Fired on
  // critical events, e.g. a queue job exhausting its retries. Empty = disabled.
  ALERT_WEBHOOK_URL: t.String({ default: "" }),

  // Days to keep audit_logs rows; older rows are purged daily by the worker.
  // 0 = keep forever (the table grows unbounded — your compliance call).
  AUDIT_RETENTION_DAYS: t.Number({ default: 90 }),

  // Admin user created by `bun run db:seed` (set a real password before running).
  SEED_ADMIN_EMAIL: t.String({ default: "admin@example.com" }),
  SEED_ADMIN_PASSWORD: t.String({ default: "" }),
});

export type Env = typeof EnvSchema.static;

function loadEnv(): Env {
  // process.env values are strings; Convert coerces them to the schema types
  // (e.g. PORT "3000" -> 3000) and Default fills in any omitted values.
  let value: unknown = Value.Default(EnvSchema, { ...process.env });
  value = Value.Convert(EnvSchema, value);

  if (!Value.Check(EnvSchema, value)) {
    console.error("❌ Invalid environment variables:");
    for (const error of Value.Errors(EnvSchema, value)) {
      console.error(`  - ${error.path || "/"}: ${error.message}`);
    }
    process.exit(1);
  }

  // Strip unrelated process.env keys, returning only our typed config.
  return Value.Clean(EnvSchema, value) as Env;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
