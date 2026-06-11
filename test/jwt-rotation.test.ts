import { describe, expect, test } from "bun:test";
import { env } from "@/config/env";
import { api, body, json, registerUser, setEnv } from "./helpers";

const ROTATED_SECRET = "rotated-secret-0123456789abcdef";

const me = (token: string) =>
  api("/auth/me", { headers: { Authorization: `Bearer ${token}` } });

/**
 * Zero-downtime secret rotation: deploy with the new secret in JWT_SECRET and
 * the old one in JWT_SECRET_PREVIOUS; in-flight access tokens stay valid for
 * the rotation window, new tokens are signed with the new secret. Once the
 * access-token TTL has passed, drop JWT_SECRET_PREVIOUS.
 */
describe("JWT secret rotation", () => {
  test("rejects tokens signed with a rotated-out secret when no previous secret is set", async () => {
    const { accessToken } = await registerUser();
    const restoreSecret = setEnv("JWT_SECRET", ROTATED_SECRET);
    const restorePrevious = setEnv("JWT_SECRET_PREVIOUS", "");

    try {
      const res = await me(accessToken);
      expect(res.status).toBe(401);
    } finally {
      restorePrevious();
      restoreSecret();
    }
  });

  test("accepts tokens signed with the previous secret during the rotation window", async () => {
    const { accessToken } = await registerUser();
    const oldSecret = env.JWT_SECRET;
    const restoreSecret = setEnv("JWT_SECRET", ROTATED_SECRET);
    const restorePrevious = setEnv("JWT_SECRET_PREVIOUS", oldSecret);

    try {
      const res = await me(accessToken);
      expect(res.status).toBe(200);
    } finally {
      restorePrevious();
      restoreSecret();
    }
  });

  test("signs new tokens with the rotated secret, not the previous one", async () => {
    const { email, password } = await registerUser();
    const oldSecret = env.JWT_SECRET;
    const restoreSecret = setEnv("JWT_SECRET", ROTATED_SECRET);
    const restorePrevious = setEnv("JWT_SECRET_PREVIOUS", oldSecret);

    try {
      const login = await body(
        await json("/auth/login", "POST", { email, password }),
      );
      // Drop the previous secret: a token signed with the rotated secret must
      // still verify — proving login didn't sign with the old one.
      restorePrevious();
      const res = await me(login.accessToken);
      expect(res.status).toBe(200);
    } finally {
      restorePrevious();
      restoreSecret();
    }
  });
});
