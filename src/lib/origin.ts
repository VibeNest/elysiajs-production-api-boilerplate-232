import { env } from "@/config/env";
import { ForbiddenError } from "@/lib/errors";

/**
 * CSRF defense-in-depth for cookie-mode auth mutations: when an Origin header
 * is present it must be in CORS_ORIGIN. An absent Origin (curl, server-to-
 * server, some same-origin requests) is allowed — the httpOnly cookie's
 * SameSite attribute is the primary defense. CORS_ORIGIN="*" disables the
 * check; don't run cookie mode like that in production.
 */
export function assertTrustedOrigin(request: Request): void {
  if (env.CORS_ORIGIN === "*") return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  const allowed = env.CORS_ORIGIN.split(",").map((o) => o.trim());
  if (!allowed.includes(origin)) throw new ForbiddenError("Origin not allowed");
}
