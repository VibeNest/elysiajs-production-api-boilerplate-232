import { Elysia } from "elysia";
import { authModule } from "./modules/auth";
import { userModule } from "./modules/user";
import { corsPlugin } from "./plugins/cors";
import { errorPlugin } from "./plugins/error";
import { healthPlugin } from "./plugins/health";
import { loggerPlugin } from "./plugins/logger";
import { metricsPlugin } from "./plugins/metrics";
import { openapiPlugin } from "./plugins/openapi";
import { otelPlugin } from "./plugins/otel";
import { securityHeadersPlugin } from "./plugins/security-headers";

/**
 * The composed application — no `.listen()` so it can be imported directly in
 * tests via `app.handle(new Request(...))`. The entry point ([index.ts](index.ts))
 * starts the server.
 */
export const app = new Elysia()
  // First so request spans wrap every other plugin (no-op unless OTEL_ENABLED).
  .use(otelPlugin)
  .use(securityHeadersPlugin)
  .use(corsPlugin)
  .use(openapiPlugin)
  .use(loggerPlugin)
  .use(metricsPlugin)
  .use(errorPlugin)
  .use(healthPlugin)
  .use(authModule)
  .use(userModule);

export type App = typeof app;
