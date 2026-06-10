import { describe, expect, it } from "bun:test";
import { api, body, json, uniqueEmail } from "./helpers";

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
});
