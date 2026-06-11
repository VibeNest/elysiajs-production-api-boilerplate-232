import { check, sleep } from "k6";
import http from "k6/http";

/**
 * Smoke-profile API journey. The defaults deliberately stay UNDER the app's
 * per-IP rate limits, because every VU shares one source IP:
 *
 *   - credential routes (/auth/register, /auth/login, /auth/password/*): 10/min/IP
 *   - the /auth module as a whole (incl. /auth/me, /auth/refresh):        20/min/IP
 *
 * Budget at the defaults (5 VUs, ~1 iteration/s/VU): 5 registers once,
 * ~7.5 /auth/me per minute, ~5 /auth/refresh per minute → ≈17.5/min on the
 * auth module. /health is unlimited and carries the throughput load.
 *
 * For a real stress run: point BASE_URL at a load environment with the
 * limiter maxes raised (src/plugins/rate-limit.ts), then scale VUS/DURATION.
 * See load/README.md.
 */
const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || "1m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<300"],
    checks: ["rate>0.99"],
  },
};

const jsonHeaders = { headers: { "Content-Type": "application/json" } };

// Per-VU session (k6 keeps module state per VU).
let session = null;

/**
 * Works in both AUTH_TRANSPORT modes: bearer carries the refresh token in
 * the JSON body; cookie mode omits it from the body and sets an httpOnly
 * `refresh_token` cookie instead — capture it explicitly so the refresh
 * step doesn't depend on jar behavior.
 */
function captureSession(res) {
  const body = res.json();
  const jarCookie = res.cookies.refresh_token;
  session = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken || null, // bearer mode
    refreshCookie: jarCookie && jarCookie[0] ? jarCookie[0].value : null,
  };
}

function refreshRequest() {
  const payload = session.refreshToken
    ? JSON.stringify({ refreshToken: session.refreshToken })
    : "{}";
  const params = session.refreshCookie
    ? Object.assign({}, jsonHeaders, {
        cookies: { refresh_token: session.refreshCookie },
      })
    : jsonHeaders;
  return http.post(`${BASE_URL}/auth/refresh`, payload, params);
}

export default function () {
  if (!session) {
    const email = `k6_${__VU}_${Date.now()}@example.com`;
    const res = http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ email, password: "k6-supersecret" }),
      jsonHeaders,
    );
    check(res, { "register 200": (r) => r.status === 200 });
    if (res.status !== 200) {
      sleep(5); // likely rate-limited — back off and retry next iteration
      return;
    }
    captureSession(res);
  }

  check(http.get(`${BASE_URL}/health`), {
    "health 200": (r) => r.status === 200,
  });

  // Sampled authed traffic — all of /auth shares the 20/min/IP budget.
  if (__ITER % 40 === 10) {
    const res = http.get(`${BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    check(res, { "me 200": (r) => r.status === 200 });
  }

  if (__ITER % 60 === 30) {
    const res = refreshRequest();
    check(res, { "refresh 200": (r) => r.status === 200 });
    if (res.status === 200) captureSession(res);
  }

  sleep(1);
}
