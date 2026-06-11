import { bearer } from "@elysiajs/bearer";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { env } from "@/config/env";
import { db } from "@/db";
import { users } from "@/db/schema";
import { type AccessPayload, verifyAccessToken } from "@/lib/jwt";
import { type Operation, type Role, resolveScope } from "@/lib/permissions";

export type { AccessPayload };

const UNAUTHORIZED = {
  error: "UNAUTHORIZED",
  message: "Authentication required",
};
const FORBIDDEN = { error: "FORBIDDEN", message: "Insufficient permissions" };
const EMAIL_NOT_VERIFIED = {
  error: "EMAIL_NOT_VERIFIED",
  message: "Email verification required",
};

/** Verify a bearer token and return the access payload, or null if invalid. */
async function resolveUser(
  bearer: string | undefined,
): Promise<AccessPayload | null> {
  if (!bearer) return null;
  return verifyAccessToken(bearer);
}

/** Fresh DB check — emailVerifiedAt is never carried in the JWT. */
async function isEmailVerified(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ emailVerifiedAt: users.emailVerifiedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return !!row?.emailVerifiedAt;
}

/**
 * REQUIRE_VERIFIED_EMAIL gate used by the guard macros. The env flag is read
 * per call (per request) — never hoist it to a module const, so tests can flip
 * it via setEnv.
 */
async function passesVerificationGate(userId: string): Promise<boolean> {
  return !env.REQUIRE_VERIFIED_EMAIL || (await isEmailVerified(userId));
}

/**
 * Auth plugin: the bearer extractor and reusable guard macros. (Access tokens
 * are signed/verified in lib/jwt.ts; refresh tokens are opaque random strings
 * minted in the auth module — no signer needed here.) On success each macro
 * adds a typed `user: AccessPayload` to the context.
 *
 *   { isAuthed: true }                                  // any authenticated user
 *   { isAuthed: "allowUnverified" }                     // exempt from REQUIRE_VERIFIED_EMAIL
 *   { hasRole: 'admin' }                                // role gate
 *   { can: { action: 'user:update', ownParam: 'id' } }  // permission + scope
 *
 * The `can` macro also adds `scope: 'all' | 'own'` — use it for field/row-level
 * rules (e.g. only "all" scope may change another record's role).
 *
 * With REQUIRE_VERIFIED_EMAIL=true, every guard also requires a verified email
 * (403 EMAIL_NOT_VERIFIED) — checked after authn (401), before authz (403
 * FORBIDDEN), so frontends get a deterministic signal to show a "verify your
 * email" screen. Behavior matrix:
 *
 *   guard                          | flag OFF          | flag ON
 *   -------------------------------|-------------------|---------------------------
 *   isAuthed: true                 | authn             | authn + verified
 *   isAuthed: "allowUnverified"    | authn             | authn
 *   hasRole / can                  | authn + authz     | authn + verified + authz
 *   verifiedEmail: true            | authn + verified  | authn + verified
 *
 * "allowUnverified" exists for the verification bootstrap routes (/auth/me,
 * /auth/logout, /auth/email/*) — without it an unverified user could never
 * verify. Cost when the flag is on: one indexed PK select per authed request.
 *
 * Token signing/verification lives in lib/jwt.ts (jose) — secrets are read per
 * request, which is what makes JWT_SECRET_PREVIOUS rotation work.
 */
export const authPlugin = new Elysia({ name: "auth" }).use(bearer()).macro({
  /**
   * `true` requires a verified email when REQUIRE_VERIFIED_EMAIL is on;
   * `"allowUnverified"` skips that gate (verification bootstrap routes).
   */
  isAuthed(mode: true | "allowUnverified") {
    return {
      async resolve({ bearer, status }) {
        const user = await resolveUser(bearer);
        if (!user) return status(401, UNAUTHORIZED);
        if (
          mode !== "allowUnverified" &&
          !(await passesVerificationGate(user.sub))
        )
          return status(403, EMAIL_NOT_VERIFIED);
        return { user };
      },
    };
  },
  hasRole(role: Role) {
    return {
      async resolve({ bearer, status }) {
        const user = await resolveUser(bearer);
        if (!user) return status(401, UNAUTHORIZED);
        if (!(await passesVerificationGate(user.sub)))
          return status(403, EMAIL_NOT_VERIFIED);
        if (user.role !== role) return status(403, FORBIDDEN);
        return { user };
      },
    };
  },
  /**
   * Permission gate. `action` is "<model>:<operation>"; the granted scope is
   * resolved from the user's role. With `ownParam`, an "own"-scope user must
   * own the resource (route param === user id) — admins ("all") bypass this.
   */
  can(opts: { action: string; ownParam?: string }) {
    const [model, operation] = opts.action.split(":") as [string, Operation];
    return {
      async resolve({ bearer, params, status }) {
        const user = await resolveUser(bearer);
        if (!user) return status(401, UNAUTHORIZED);
        if (!(await passesVerificationGate(user.sub)))
          return status(403, EMAIL_NOT_VERIFIED);

        const scope = resolveScope(user.role, model, operation);
        if (!scope) return status(403, FORBIDDEN);

        if (scope === "own" && opts.ownParam) {
          const targetId = (params as Record<string, string | undefined>)[
            opts.ownParam
          ];
          if (user.sub !== targetId) return status(403, FORBIDDEN);
        }

        return { user, scope };
      },
    };
  },
  /**
   * Always require a verified email, independent of REQUIRE_VERIFIED_EMAIL —
   * per-route opt-in for flag-off deployments. Authenticates, then checks
   * `emailVerifiedAt` in the DB (always fresh).
   */
  verifiedEmail: {
    async resolve({ bearer, status }) {
      const user = await resolveUser(bearer);
      if (!user) return status(401, UNAUTHORIZED);
      if (!(await isEmailVerified(user.sub)))
        return status(403, EMAIL_NOT_VERIFIED);
      return { user };
    },
  },
});
