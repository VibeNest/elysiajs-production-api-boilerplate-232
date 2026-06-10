import { type Cookie, Elysia } from "elysia";
import { env, isProduction } from "@/config/env";
import { recordAudit } from "@/lib/audit";
import { BadRequestError, UnauthorizedError } from "@/lib/errors";
import { randomToken } from "@/lib/hash";
import { clientIp } from "@/lib/ip";
import { assertTrustedOrigin } from "@/lib/origin";
import { durationToMs } from "@/lib/time";
import { type AccessPayload, authPlugin } from "@/plugins/auth";
import { ipRateLimit } from "@/plugins/rate-limit";
import { authModel } from "./model";
import { OtpService } from "./otp.service";
import { PasswordResetService } from "./password-reset.service";
import { AuthService } from "./service";

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
 * Sign an access JWT and mint + persist an opaque refresh token. Lives in the
 * controller (not AuthService) because signing needs the request-scoped `jwt`
 * from the auth plugin. AUTH_TRANSPORT is read per request (never hoisted to a
 * module const) so tests can exercise both modes in one process.
 */
async function issueTokens(
  jwt: { sign: (payload: AccessPayload) => Promise<string> },
  user: { id: string; role: "user" | "admin" },
  familyId: string,
  refreshCookie: Cookie<string | undefined>,
): Promise<{ accessToken: string; refreshToken?: string }> {
  const accessToken = await jwt.sign({ sub: user.id, role: user.role });
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

const toPublicUser = (u: {
  id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
  emailVerifiedAt: Date | null;
}) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  emailVerified: u.emailVerifiedAt !== null,
});

/**
 * Auth controller. The Elysia instance *is* the controller (Elysia idiom).
 * Public: /register, /login, /refresh. Protected: /me, /logout.
 */
export const authModule = new Elysia({ prefix: "/auth", tags: ["Auth"] })
  .use(authPlugin)
  // Per-IP limit on auth endpoints (brute-force / abuse protection).
  .use(ipRateLimit({ max: 20, duration: 60_000 }))
  .model(authModel)
  .post(
    "/register",
    async ({ body, jwt, request, server, cookie: { refresh_token } }) => {
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

      // New login → new token family.
      const tokens = await issueTokens(
        jwt,
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
    async ({ body, jwt, cookie: { refresh_token } }) => {
      const user = await AuthService.verifyCredentials(
        body.email,
        body.password,
      );

      // New login → new token family.
      const tokens = await issueTokens(
        jwt,
        user,
        crypto.randomUUID(),
        refresh_token,
      );

      return { ...tokens, user: toPublicUser(user) };
    },
    {
      body: "loginBody",
      cookie: "refreshCookie",
      response: "tokenResponse",
      detail: { summary: "Log in with email and password", tags: ["Auth"] },
    },
  )
  .post(
    "/refresh",
    async ({ body, jwt, cookie: { refresh_token } }) => {
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
      const tokens = await issueTokens(jwt, user, used.familyId, refresh_token);

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
  )
  .get(
    "/me",
    async ({ user }) => {
      const current = await AuthService.findById(user.sub);
      if (!current) throw new UnauthorizedError();
      return toPublicUser(current);
    },
    {
      isAuthed: true,
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
      isAuthed: true,
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
      isAuthed: true,
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
      isAuthed: true,
      body: "verifyOtpBody",
      detail: {
        summary: "Verify the email-verification OTP",
        tags: ["Auth"],
        security: [{ bearerAuth: [] }],
      },
    },
  );
