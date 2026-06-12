import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  api,
  body,
  json,
  setCookie,
  setCookieValue,
  setEnv,
  uniqueEmail,
} from "./helpers";

describe("health", () => {
  it("returns ok", async () => {
    const res = await api("/health");
    expect(res.status).toBe(200);
    expect((await body(res)).status).toBe("ok");
  });

  it("handles an unmatched route (404) without the logger crashing", async () => {
    // Regression: onAfterResponse fires for 404s where `derive` never ran, so
    // the request-scoped `log` is undefined — it must not throw.
    const res = await api("/favicon.ico");
    expect(res.status).toBe(404);
  });
});

describe("auth (requires a running database)", () => {
  it("rejects /auth/me without a token", async () => {
    const res = await api("/auth/me");
    expect(res.status).toBe(401);
  });

  it("registers, logs in, fetches profile, and refreshes", async () => {
    const email = uniqueEmail();
    const password = "supersecret";

    const register = await json("/auth/register", "POST", {
      email,
      password,
      name: "Test User",
    });
    expect(register.status).toBe(200);
    const registered = await body(register);
    expect(registered.accessToken).toBeString();
    expect(registered.refreshToken).toBeString();
    expect(registered.user.email).toBe(email);

    const login = await json("/auth/login", "POST", { email, password });
    expect(login.status).toBe(200);
    const { accessToken, refreshToken } = await body(login);

    const me = await api("/auth/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    expect(me.status).toBe(200);
    expect((await body(me)).email).toBe(email);

    const refreshed = await json("/auth/refresh", "POST", { refreshToken });
    expect(refreshed.status).toBe(200);
    expect((await body(refreshed)).accessToken).toBeString();

    // The rotated (old) refresh token must no longer work.
    const reused = await json("/auth/refresh", "POST", { refreshToken });
    expect(reused.status).toBe(401);
  });

  it("rejects duplicate registration", async () => {
    const email = uniqueEmail();
    const password = "supersecret";
    const first = await json("/auth/register", "POST", { email, password });
    expect(first.status).toBe(200);
    const second = await json("/auth/register", "POST", { email, password });
    expect(second.status).toBe(409);
  });

  it("revokes the whole token family when a rotated token is replayed", async () => {
    const email = uniqueEmail();
    const password = "supersecret";
    const reg = await body(
      await json("/auth/register", "POST", { email, password }),
    );
    const original: string = reg.refreshToken;

    // Rotate once: a fresh token is issued, the original is marked used.
    const rotated = await body(
      await json("/auth/refresh", "POST", { refreshToken: original }),
    );
    const fresh: string = rotated.refreshToken;
    expect(fresh).toBeString();

    // Replaying the already-rotated original is detected as theft → 401.
    const replay = await json("/auth/refresh", "POST", {
      refreshToken: original,
    });
    expect(replay.status).toBe(401);

    // The family is burned: even the freshly-issued token is now revoked.
    const afterBurn = await json("/auth/refresh", "POST", {
      refreshToken: fresh,
    });
    expect(afterBurn.status).toBe(401);
  });

  it("rotates atomically: two concurrent refreshes yield exactly one success", async () => {
    const email = uniqueEmail();
    const password = "supersecret";
    const reg = await body(
      await json("/auth/register", "POST", { email, password }),
    );
    const token: string = reg.refreshToken;

    // Fire the same refresh token twice at once. The conditional UPDATE makes
    // the claim atomic, so exactly one wins (200) and the other is rejected.
    const [a, b] = await Promise.all([
      json("/auth/refresh", "POST", { refreshToken: token }),
      json("/auth/refresh", "POST", { refreshToken: token }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
  });

  it("sets no cookies in bearer mode", async () => {
    const res = await json("/auth/register", "POST", {
      email: uniqueEmail(),
      password: "supersecret",
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("concurrent registration of the same email", () => {
  it("returns exactly one 200 and one 409 — never a 500", async () => {
    const email = uniqueEmail();
    const reg = () =>
      json("/auth/register", "POST", { email, password: "supersecret" });

    const [a, b] = await Promise.all([reg(), reg()]);
    const statuses = [a.status, b.status].sort();

    expect(statuses).toEqual([200, 409]);
    expect(statuses).not.toContain(500);
  });
});

describe("auth cookie transport (requires a running database)", () => {
  const COOKIE = "refresh_token";
  let restore: () => void;

  beforeAll(() => {
    restore = setEnv("AUTH_TRANSPORT", "cookie");
  });
  afterAll(() => restore());

  /** Register a fresh user; returns the refresh cookie value + access token. */
  const registerWithCookie = async () => {
    const res = await json("/auth/register", "POST", {
      email: uniqueEmail(),
      password: "supersecret",
    });
    expect(res.status).toBe(200);
    const cookie = setCookieValue(res, COOKIE);
    expect(cookie).toBeString();
    const accessToken: string = (await body(res)).accessToken;
    return { cookie: cookie as string, accessToken };
  };

  /** POST /auth/refresh with the cookie attached and no request body. */
  const refreshWithCookie = (
    cookie: string,
    headers?: Record<string, string>,
  ) =>
    api("/auth/refresh", {
      method: "POST",
      headers: { Cookie: `${COOKIE}=${cookie}`, ...headers },
    });

  it("sets an httpOnly refresh cookie and omits the token from the body", async () => {
    const email = uniqueEmail();
    const password = "supersecret";
    await json("/auth/register", "POST", { email, password });
    const login = await json("/auth/login", "POST", { email, password });
    expect(login.status).toBe(200);

    const cookie = setCookie(login, COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/auth");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Max-Age=");

    const payload = await body(login);
    expect(payload.accessToken).toBeString();
    expect(payload.refreshToken).toBeUndefined();
  });

  it("refreshes via the cookie with no request body", async () => {
    const { cookie } = await registerWithCookie();

    const refreshed = await refreshWithCookie(cookie);
    expect(refreshed.status).toBe(200);

    const next = setCookieValue(refreshed, COOKIE);
    expect(next).toBeString();
    expect(next).not.toBe(cookie);
    expect((await body(refreshed)).refreshToken).toBeUndefined();
  });

  it("still accepts the token in the JSON body as a fallback", async () => {
    const { cookie } = await registerWithCookie();
    const refreshed = await json("/auth/refresh", "POST", {
      refreshToken: cookie,
    });
    expect(refreshed.status).toBe(200);
  });

  it("rejects refresh with neither cookie nor body", async () => {
    const res = await api("/auth/refresh", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("logout revokes the session and clears the cookie", async () => {
    const { cookie, accessToken } = await registerWithCookie();

    const out = await api("/auth/logout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Cookie: `${COOKIE}=${cookie}`,
      },
    });
    expect(out.status).toBe(200);

    // Clearing Set-Cookie must repeat the path, or browsers keep the cookie.
    const cleared = setCookie(out, COOKIE);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/auth");

    const after = await refreshWithCookie(cookie);
    expect(after.status).toBe(401);
  });

  it("burns the family when a rotated cookie token is replayed", async () => {
    const { cookie: original } = await registerWithCookie();

    const rotated = await refreshWithCookie(original);
    expect(rotated.status).toBe(200);
    const fresh = setCookieValue(rotated, COOKIE) as string;

    const replay = await refreshWithCookie(original);
    expect(replay.status).toBe(401);

    const afterBurn = await refreshWithCookie(fresh);
    expect(afterBurn.status).toBe(401);
  });

  it("enforces the Origin allowlist when CORS_ORIGIN is restricted", async () => {
    const restoreCors = setEnv("CORS_ORIGIN", "https://app.example.com");
    try {
      const { cookie } = await registerWithCookie();

      const evil = await refreshWithCookie(cookie, {
        Origin: "https://evil.example",
      });
      expect(evil.status).toBe(403);
      expect((await body(evil)).error).toBe("FORBIDDEN");

      // The rejected attempt never touched the token — an allowed Origin works.
      const ok = await refreshWithCookie(cookie, {
        Origin: "https://app.example.com",
      });
      expect(ok.status).toBe(200);

      // No Origin header (curl, server-to-server) is allowed through.
      const next = setCookieValue(ok, COOKIE) as string;
      const noOrigin = await refreshWithCookie(next);
      expect(noOrigin.status).toBe(200);
    } finally {
      restoreCors();
    }
  });
});
