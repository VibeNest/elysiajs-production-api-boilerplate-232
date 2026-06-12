import { t } from "elysia";
import { sanitizedString } from "@/lib/sanitize";
import { publicUser } from "@/lib/user-public";

const tokenResponse = t.Object({
  accessToken: t.String(),
  // Present in bearer mode; omitted in cookie mode (httpOnly cookie instead).
  refreshToken: t.Optional(t.String()),
  user: publicUser,
});

const mfaChallengeResponse = t.Object({
  mfaRequired: t.Literal(true),
  // Opaque, short-lived; echo it to /auth/2fa/verify with a TOTP code.
  mfaToken: t.String(),
});

export const authModel = {
  registerBody: t.Object({
    email: t.String({ format: "email" }),
    password: t.String({ minLength: 8, maxLength: 128 }),
    name: t.Optional(sanitizedString({ maxLength: 255 })),
  }),
  loginBody: t.Object({
    email: t.String({ format: "email" }),
    password: t.String({ minLength: 8, maxLength: 128 }),
  }),
  // Optional both ways: in cookie mode the token arrives in the cookie and
  // requests may omit the body entirely; the handlers enforce presence.
  refreshBody: t.Optional(
    t.Object({
      refreshToken: t.Optional(t.String({ minLength: 1 })),
    }),
  ),
  refreshCookie: t.Cookie({
    refresh_token: t.Optional(t.String()),
  }),
  verifyOtpBody: t.Object({
    code: t.String({ minLength: 6, maxLength: 6 }),
  }),
  requestPasswordResetBody: t.Object({
    email: t.String({ format: "email" }),
  }),
  resetPasswordBody: t.Object({
    email: t.String({ format: "email" }),
    code: t.String({ minLength: 6, maxLength: 6 }),
    password: t.String({ minLength: 8, maxLength: 128 }),
  }),
  tokenResponse,
  // Login either issues tokens directly or, for 2FA-enabled accounts,
  // returns an MFA challenge to complete via POST /auth/2fa/verify.
  loginResponse: t.Union([tokenResponse, mfaChallengeResponse]),
  mfaChallengeResponse,
  twoFaVerifyBody: t.Object({
    mfaToken: t.String({ minLength: 1 }),
    code: t.String({ minLength: 6, maxLength: 6 }),
  }),
  twoFaCodeBody: t.Object({
    code: t.String({ minLength: 6, maxLength: 6 }),
  }),
  twoFaSetupResponse: t.Object({
    secret: t.String(),
    otpauthUrl: t.String(),
  }),
  publicUser,
} as const;
