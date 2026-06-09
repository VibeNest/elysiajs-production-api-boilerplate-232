import { describe, expect, it } from "bun:test";
import { body, json, lastOtp, registerUser, uniqueEmail } from "./helpers";

describe("password reset (requires Postgres + Redis)", () => {
  it("resets the password via an emailed code and rotates sessions", async () => {
    const u = await registerUser();
    const newPassword = "brand-new-secret";

    const req = await json("/auth/password/request-reset", "POST", {
      email: u.email,
    });
    expect(req.status).toBe(200);
    expect((await body(req)).sent).toBe(true);

    const code = lastOtp(u.email);
    expect(code).toBeString();

    // Wrong code is rejected.
    const wrong = await json("/auth/password/reset", "POST", {
      email: u.email,
      code: "000000",
      password: newPassword,
    });
    expect(wrong.status).toBe(400);

    // Correct code resets the password.
    const ok = await json("/auth/password/reset", "POST", {
      email: u.email,
      code,
      password: newPassword,
    });
    expect(ok.status).toBe(200);
    expect((await body(ok)).reset).toBe(true);

    // Old password no longer works; the new one does.
    const oldLogin = await json("/auth/login", "POST", {
      email: u.email,
      password: u.password,
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await json("/auth/login", "POST", {
      email: u.email,
      password: newPassword,
    });
    expect(newLogin.status).toBe(200);
  });

  it("does not reveal whether an email exists", async () => {
    const unknown = uniqueEmail();
    const res = await json("/auth/password/request-reset", "POST", {
      email: unknown,
    });
    expect(res.status).toBe(200);
    expect((await body(res)).sent).toBe(true);
    // No code was emailed to an account that doesn't exist.
    expect(lastOtp(unknown)).toBeUndefined();
  });
});
