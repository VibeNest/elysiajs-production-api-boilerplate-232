import { describe, expect, test } from "bun:test";
import * as OTPAuth from "otpauth";
import { api, body, json, registerUser } from "./helpers";

const authHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
});

/** A code guaranteed to differ from `code` (flip the last digit). */
const wrongCode = (code: string) =>
  code.slice(0, 5) + String((Number(code[5]) + 1) % 10);

/** Run setup + enable for a logged-in user; returns the client-side TOTP. */
async function enroll(accessToken: string) {
  const setupRes = await api("/auth/2fa/setup", {
    method: "POST",
    headers: authHeaders(accessToken),
  });
  expect(setupRes.status).toBe(200);
  const setup = await body(setupRes);
  expect(setup.secret).toBeTruthy();
  expect(setup.otpauthUrl).toContain("otpauth://totp/");

  const totp = OTPAuth.URI.parse(setup.otpauthUrl) as OTPAuth.TOTP;
  const enableRes = await json(
    "/auth/2fa/enable",
    "POST",
    { code: totp.generate() },
    accessToken,
  );
  expect(enableRes.status).toBe(200);
  return totp;
}

describe("TOTP 2FA", () => {
  test("enabling 2FA turns login into an MFA challenge", async () => {
    const u = await registerUser();
    const totp = await enroll(u.accessToken);

    const login = await body(
      await json("/auth/login", "POST", {
        email: u.email,
        password: u.password,
      }),
    );
    expect(login.mfaRequired).toBe(true);
    expect(login.mfaToken).toBeTruthy();
    expect(login.accessToken).toBeUndefined();
    expect(login.refreshToken).toBeUndefined();

    const verify = await json("/auth/2fa/verify", "POST", {
      mfaToken: login.mfaToken,
      code: totp.generate(),
    });
    expect(verify.status).toBe(200);
    const tokens = await body(verify);
    expect(tokens.accessToken).toBeTruthy();

    const me = await api("/auth/me", {
      headers: authHeaders(tokens.accessToken),
    });
    expect(me.status).toBe(200);
  });

  test("a wrong code is rejected, then a correct one still works", async () => {
    const u = await registerUser();
    const totp = await enroll(u.accessToken);
    const login = await body(
      await json("/auth/login", "POST", {
        email: u.email,
        password: u.password,
      }),
    );

    const code = totp.generate();
    const bad = await json("/auth/2fa/verify", "POST", {
      mfaToken: login.mfaToken,
      code: wrongCode(code),
    });
    expect(bad.status).toBe(401);

    const good = await json("/auth/2fa/verify", "POST", {
      mfaToken: login.mfaToken,
      code,
    });
    expect(good.status).toBe(200);
  });

  test("the challenge burns after too many wrong attempts", async () => {
    const u = await registerUser();
    const totp = await enroll(u.accessToken);
    const login = await body(
      await json("/auth/login", "POST", {
        email: u.email,
        password: u.password,
      }),
    );

    const code = totp.generate();
    for (let i = 0; i < 5; i++) {
      await json("/auth/2fa/verify", "POST", {
        mfaToken: login.mfaToken,
        code: wrongCode(code),
      });
    }

    // Even the correct code is rejected now — the challenge is gone.
    const after = await json("/auth/2fa/verify", "POST", {
      mfaToken: login.mfaToken,
      code,
    });
    expect(after.status).toBe(401);
  });

  test("a code cannot be replayed across logins", async () => {
    const u = await registerUser();
    const totp = await enroll(u.accessToken);
    const code = totp.generate();

    const first = await body(
      await json("/auth/login", "POST", {
        email: u.email,
        password: u.password,
      }),
    );
    const ok = await json("/auth/2fa/verify", "POST", {
      mfaToken: first.mfaToken,
      code,
    });
    expect(ok.status).toBe(200);

    const second = await body(
      await json("/auth/login", "POST", {
        email: u.email,
        password: u.password,
      }),
    );
    const replay = await json("/auth/2fa/verify", "POST", {
      mfaToken: second.mfaToken,
      code,
    });
    expect(replay.status).toBe(401);
  });

  test("enable requires a valid code — login stays plain until then", async () => {
    const u = await registerUser();
    const setup = await body(
      await api("/auth/2fa/setup", {
        method: "POST",
        headers: authHeaders(u.accessToken),
      }),
    );
    const totp = OTPAuth.URI.parse(setup.otpauthUrl) as OTPAuth.TOTP;

    const bad = await json(
      "/auth/2fa/enable",
      "POST",
      { code: wrongCode(totp.generate()) },
      u.accessToken,
    );
    expect(bad.status).toBe(400);

    // 2FA never went live — login issues tokens directly.
    const login = await body(
      await json("/auth/login", "POST", {
        email: u.email,
        password: u.password,
      }),
    );
    expect(login.accessToken).toBeTruthy();
  });

  test("disable restores the plain login flow", async () => {
    const u = await registerUser();
    const totp = await enroll(u.accessToken);

    // enable/disable are session-authenticated mutations — they validate the
    // code but only the login challenge enforces single-use (replay guard),
    // so disabling right after enabling works within the same 30s window.
    const res = await json(
      "/auth/2fa/disable",
      "POST",
      { code: totp.generate() },
      u.accessToken,
    );
    expect(res.status).toBe(200);

    const login = await body(
      await json("/auth/login", "POST", {
        email: u.email,
        password: u.password,
      }),
    );
    expect(login.accessToken).toBeTruthy();
    expect(login.mfaRequired).toBeUndefined();
  });
});
