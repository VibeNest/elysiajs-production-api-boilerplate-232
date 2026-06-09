import { Elysia } from "elysia";
import { isProduction } from "@/config/env";

/**
 * Baseline security response headers (a lightweight helmet equivalent).
 * Named so it's applied once across the app. Set on every response — including
 * errors — via `onRequest`, since `set.headers` is the response header bag.
 *
 * These are sensible defaults for a JSON API. HSTS is only emitted in
 * production (it's meaningless and counter-productive over plain HTTP in dev).
 * If you serve a browser UI from this origin, revisit CSP / frame rules.
 */
export const securityHeadersPlugin = new Elysia({
  name: "security-headers",
}).onRequest(({ set }) => {
  set.headers["x-content-type-options"] = "nosniff";
  set.headers["x-frame-options"] = "DENY";
  set.headers["referrer-policy"] = "no-referrer";
  set.headers["x-dns-prefetch-control"] = "off";
  set.headers["cross-origin-resource-policy"] = "same-origin";

  if (isProduction)
    set.headers["strict-transport-security"] =
      "max-age=31536000; includeSubDomains";
});
