import { Elysia } from "elysia";
import { env } from "@/config/env";
import { recordAudit } from "@/lib/audit";
import { BadRequestError, UnauthorizedError } from "@/lib/errors";
import { randomToken } from "@/lib/hash";
import { clientIp } from "@/lib/ip";
import { durationToMs } from "@/lib/time";
import { type AccessPayload, authPlugin } from "@/plugins/auth";
import { ipRateLimit } from "@/plugins/rate-limit";
import { authModel } from "./model";
import { OtpService } from "./otp.service";
import { PasswordResetService } from "./password-reset.service";
import { AuthService } from "./service";

const REFRESH_MS = durationToMs(env.JWT_REFRESH_EXP) || durationToMs("7d");

/**
 * Sign an access JWT and mint + persist an opaque refresh token. Lives in the
 * controller (not AuthService) because signing needs the request-scoped `jwt`
 * from the auth plugin.
 */
async function issueTokens(
  jwt: { sign: (payload: AccessPayload) => Promise<string> },
  user: { id: string; role: "user" | "admin" },
  familyId: string,
) {
  const accessToken = await jwt.sign({ sub: user.id, role: user.role });
  const refreshToken = randomToken();
  await AuthService.storeRefreshToken(
    user.id,
    refreshToken,
    new Date(Date.now() + REFRESH_MS),
    familyId,
  );
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
    async ({ body, jwt, request, server }) => {
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
      const tokens = await issueTokens(jwt, user, crypto.randomUUID());

      return { ...tokens, user: toPublicUser(user) };
    },
    {
      body: "registerBody",
      response: "tokenResponse",
      detail: { summary: "Register a new user", tags: ["Auth"] },
    },
  )
  .post(
    "/login",
    async ({ body, jwt }) => {
      const user = await AuthService.verifyCredentials(
        body.email,
        body.password,
      );

      // New login → new token family.
      const tokens = await issueTokens(jwt, user, crypto.randomUUID());

      return { ...tokens, user: toPublicUser(user) };
    },
    {
      body: "loginBody",
      response: "tokenResponse",
      detail: { summary: "Log in with email and password", tags: ["Auth"] },
    },
  )
  .post(
    "/refresh",
    async ({ body, jwt }) => {
      // Rotation with theft detection: marks the token used (or revokes the
      // whole family on reuse) and returns the row to continue the chain.
      const used = await AuthService.useRefreshToken(body.refreshToken);

      const user = await AuthService.findById(used.userId);
      if (!user) throw new UnauthorizedError();

      // Same family — this token descends from the original login.
      const tokens = await issueTokens(jwt, user, used.familyId);

      return { ...tokens, user: toPublicUser(user) };
    },
    {
      body: "refreshBody",
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
    async ({ body }) => {
      await AuthService.revokeRefreshToken(body.refreshToken);
      return { success: true };
    },
    {
      isAuthed: true,
      body: "refreshBody",
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
