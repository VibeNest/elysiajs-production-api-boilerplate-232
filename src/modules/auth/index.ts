import { type Cookie, Elysia } from "elysia";
import { env, isProduction } from "@/config/env";
import { recordAudit } from "@/lib/audit";
import { BadRequestError, UnauthorizedError } from "@/lib/errors";
import { randomToken } from "@/lib/hash";
import { clientIp } from "@/lib/ip";
import { signAccessToken } from "@/lib/jwt";
import { assertTrustedOrigin } from "@/lib/origin";
import { durationToMs } from "@/lib/time";
import { toPublicUser } from "@/lib/user-public";
import { authPlugin } from "@/plugins/auth";
import { loggerPlugin } from "@/plugins/logger";
import { ipRateLimit } from "@/plugins/rate-limit";
import { authModel } from "./model";
import { OtpService } from "./otp.service";
import { PasswordResetService } from "./password-reset.service";
import { AuthService } from "./service";
import { TotpService } from "./totp.service";

const REFRESH_MS = durationToMs(env.JWT_REFRESH_EXP) || durationToMs("7d");
const REFRESH_MAX_AGE_S = Math.floor(REFRESH_MS / 1000);

/**
 * Attributes for the refresh-token cookie (AUTH_TRANSPORT=cookie). httpOnly
 * keeps it away from JS (XSS); SameSite=Strict is the primary CSRF defense
 * (assertTrustedOrigin is the backup); path-scoping means browsers only send
 * it to /auth/* (refresh + logout). Re-used verbatim when clearing — browsers
 * only delete a cookie when the clearing Set-Cookie repeats the same path.
 */
const REFRESH_COOKIE_ATTRS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: "strict",
  path: "/auth",
} as const;

/** CSRF check for routes that consume the refresh cookie. */
const requireTrustedOrigin = ({ request }: { request: Request }) => {
  if (env.AUTH_TRANSPORT === "cookie") assertTrustedOrigin(request);
};

/**
 * Sign an access JWT (lib/jwt.ts — secrets read per call, so rotation works)
 * and mint + persist an opaque refresh token. AUTH_TRANSPORT is read per
 * request (never hoisted to a module const) so tests can exercise both modes
 * in one process.
 */
async function issueTokens(
  user: { id: string; role: "user" | "admin" },
  familyId: string,
  refreshCookie: Cookie<string | undefined>,
): Promise<{ accessToken: string; refreshToken?: string }> {
  const accessToken = await signAccessToken({ sub: user.id, role: user.role });
  const refreshToken = randomToken();
  await AuthService.storeRefreshToken(
    user.id,
    refreshToken,
    new Date(Date.now() + REFRESH_MS),
    familyId,
  );

  if (env.AUTH_TRANSPORT === "cookie") {
    refreshCookie.set({
      value: refreshToken,
      maxAge: REFRESH_MAX_AGE_S,
      ...REFRESH_COOKIE_ATTRS,
    });
    return { accessToken }; // the token travels only in the httpOnly cookie
  }
  return { accessToken, refreshToken };
}

/**
 * Credential routes carry a stricter per-IP limit than the rest of /auth —
 * they're the brute-force and abuse targets (password guessing, registration
 * spam + its OTP emails, reset-code guessing). Own keyspace so these counters
 * can't collide with the module-wide limiter's.
 */
const credentialRoutes = new Elysia({ name: "auth-credentials" })
  .use(loggerPlugin)
  .use(ipRateLimit({ max: 10, duration: 60_000, keyspace: "auth-cred" }))
  .model(authModel)
  .post(
    "/register",
    async ({ body, request, server, cookie: { refresh_token }, log }) => {
      const user = await AuthService.createUser(
        body.email,
        body.password,
        body.name,
      );
      await recordAudit({
        action: "user.created",
        actorId: user.id,
        targetType: "user",
        targetId: user.id,
        ip: clientIp(request, server),
      });

      if (env.REQUIRE_VERIFIED_EMAIL) {
        // Best-effort: a Redis/queue hiccup must not fail registration — the
        // user can always hit /auth/email/request-otp again.
        try {
          await OtpService.issue(user.id, user.email);
        } catch (err) {
          log.warn(
            { err, userId: user.id },
            "failed to auto-issue verification OTP",
          );
        }
      }

      // New login → new token family.
      const tokens = await issueTokens(
        user,
        crypto.randomUUID(),
        refresh_token,
      );

      return { ...tokens, user: toPublicUser(user) };
    },
    {
      body: "registerBody",
      cookie: "refreshCookie",
      response: "tokenResponse",
      detail: { summary: "Register a new user", tags: ["Auth"] },
    },
  )
  .post(
    "/login",
    async ({ body, cookie: { refresh_token } }) => {
      const user = await AuthService.verifyCredentials(
        body.email,
        body.password,
      );

      // 2FA-enabled accounts don't get tokens from the password alone —
      // they get a short-lived challenge to echo back with a TOTP code.
      if (user.totpEnabledAt) {
        const mfaToken = await TotpService.createLoginChallenge(user.id);
        return { mfaRequired: true as const, mfaToken };
      }

      // New login → new token family.
      const tokens = await issueTokens(
        user,
        crypto.randomUUID(),
        refresh_token,
      );

      return { ...tokens, user: toPublicUser(user) };
    },
    {
      body: "loginBody",
      cookie: "refreshCookie",
      response: "loginResponse",
      detail: { summary: "Log in with email and password", tags: ["Auth"] },
    },
  )
  .post(
    "/2fa/verify",
    async ({ body, cookie: { refresh_token } }) => {
      const user = await TotpService.consumeLoginChallenge(
        body.mfaToken,
        body.code,
      );

      // Challenge passed — this is the real login: new token family.
      const tokens = await issueTokens(
        user,
        crypto.randomUUID(),
        refresh_token,
      );

      return { ...tokens, user: toPublicUser(user) };
    },
    {
      body: "twoFaVerifyBody",
      cookie: "refreshCookie",
      response: "tokenResponse",
      detail: {
        summary: "Complete an MFA login challenge with a TOTP code",
        tags: ["Auth"],
      },
    },
  )
  .post(
    "/password/request-reset",
    async ({ body }) => {
      // Always returns the same shape — never reveals whether the email exists.
      await PasswordResetService.request(body.email);
      return { sent: true };
    },
    {
      body: "requestPasswordResetBody",
      detail: {
        summary: "Request a password-reset code by email",
        tags: ["Auth"],
      },
    },
  )
  .post(
    "/password/reset",
    async ({ body }) => {
      await PasswordResetService.reset(body.email, body.code, body.password);
      return { reset: true };
    },
    {
      body: "resetPasswordBody",
      detail: {
        summary: "Reset the password using an emailed code",
        tags: ["Auth"],
      },
    },
  );

/**
 * Auth controller. The Elysia instance *is* the controller (Elysia idiom).
 * Public: /register, /login, /password/* (stricter rate limit — see
 * credentialRoutes above) and /refresh. Protected: /me, /logout, /email/*.
 */
export const authModule = new Elysia({ prefix: "/auth", tags: ["Auth"] })
  .use(authPlugin)
  // Named "logger" — dedupes with the app-level use; here for the typed `log`.
  .use(loggerPlugin)
  // Per-IP limit across the whole module (credential routes add a stricter one).
  .use(ipRateLimit({ max: 20, duration: 60_000, keyspace: "auth" }))
  .model(authModel)
  .use(credentialRoutes)
  .post(
    "/refresh",
    // Intentionally not gated by REQUIRE_VERIFIED_EMAIL: it authenticates via
    // the refresh token, and an unverified user must be able to stay logged in
    // long enough to complete verification.
    async ({ body, cookie: { refresh_token } }) => {
      const presented =
        (env.AUTH_TRANSPORT === "cookie" ? refresh_token.value : undefined) ??
        body?.refreshToken;
      if (!presented) throw new UnauthorizedError("Missing refresh token");

      // Rotation with theft detection: marks the token used (or revokes the
      // whole family on reuse) and returns the row to continue the chain.
      const used = await AuthService.useRefreshToken(presented);

      const user = await AuthService.findById(used.userId);
      if (!user) throw new UnauthorizedError();

      // Same family — this token descends from the original login.
      const tokens = await issueTokens(user, used.familyId, refresh_token);

      return { ...tokens, user: toPublicUser(user) };
    },
    {
      beforeHandle: requireTrustedOrigin,
      body: "refreshBody",
      cookie: "refreshCookie",
      response: "tokenResponse",
      detail: {
        summary: "Exchange a refresh token for new tokens",
        tags: ["Auth"],
      },
    },
  )
  .get(
    "/me",
    async ({ user }) => {
      const current = await AuthService.findById(user.sub);
      if (!current) throw new UnauthorizedError();
      return toPublicUser(current);
    },
    {
      // Exempt from REQUIRE_VERIFIED_EMAIL — frontends poll verification
      // status from here (`emailVerified`).
      isAuthed: "allowUnverified",
      response: "publicUser",
      detail: {
        summary: "Get the current user",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .post(
    "/logout",
    async ({ body, cookie: { refresh_token } }) => {
      const presented =
        (env.AUTH_TRANSPORT === "cookie" ? refresh_token.value : undefined) ??
        body?.refreshToken;
      if (!presented) throw new BadRequestError("refreshToken required");

      await AuthService.revokeRefreshToken(presented);

      if (env.AUTH_TRANSPORT === "cookie" && refresh_token.value) {
        // Clearing only works when the Set-Cookie repeats the same path.
        refresh_token.set({ value: "", maxAge: 0, ...REFRESH_COOKIE_ATTRS });
      }
      return { success: true };
    },
    {
      // Exempt from REQUIRE_VERIFIED_EMAIL — logging out is always allowed.
      isAuthed: "allowUnverified",
      beforeHandle: requireTrustedOrigin,
      body: "refreshBody",
      cookie: "refreshCookie",
      detail: {
        summary: "Revoke a refresh token",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .post(
    "/email/request-otp",
    async ({ user }) => {
      const current = await AuthService.findById(user.sub);
      if (!current) throw new UnauthorizedError();
      if (current.emailVerifiedAt)
        throw new BadRequestError("Email already verified");

      await OtpService.issue(current.id, current.email);
      return { sent: true };
    },
    {
      // Exempt from REQUIRE_VERIFIED_EMAIL — this IS the verification flow.
      isAuthed: "allowUnverified",
      detail: {
        summary: "Send an email-verification OTP to the current user",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .post(
    "/email/verify",
    async ({ user, body }) => {
      const ok = await OtpService.verify(user.sub, body.code);
      if (!ok) throw new BadRequestError("Invalid or expired code");

      await AuthService.markEmailVerified(user.sub);
      return { verified: true };
    },
    {
      // Exempt from REQUIRE_VERIFIED_EMAIL — this IS the verification flow.
      isAuthed: "allowUnverified",
      body: "verifyOtpBody",
      detail: {
        summary: "Verify the email-verification OTP",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .post("/2fa/setup", async ({ user }) => await TotpService.setup(user.sub), {
    isAuthed: true,
    response: "twoFaSetupResponse",
    detail: {
      summary: "Begin TOTP 2FA enrollment (returns the otpauth:// URI)",
      tags: ["Auth"],
      security: [{ bearerAuth: [] }],
    },
  })
  .post(
    "/2fa/enable",
    async ({ user, body }) => {
      await TotpService.enable(user.sub, body.code);
      return { enabled: true };
    },
    {
      isAuthed: true,
      body: "twoFaCodeBody",
      detail: {
        summary: "Enable 2FA by confirming a code from the authenticator",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .post(
    "/2fa/disable",
    async ({ user, body }) => {
      await TotpService.disable(user.sub, body.code);
      return { enabled: false };
    },
    {
      isAuthed: true,
      body: "twoFaCodeBody",
      detail: {
        summary: "Disable 2FA with a valid current code",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
      },
    },
  );
