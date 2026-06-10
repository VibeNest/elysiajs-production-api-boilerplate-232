import { bearer } from "@elysiajs/bearer";
import { jwt } from "@elysiajs/jwt";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";
import { env } from "@/config/env";
import { db } from "@/db";
import { users } from "@/db/schema";
import { type Operation, type Role, resolveScope } from "@/lib/permissions";

/** Claims carried by an access token — only what authorization needs. */
export type AccessPayload = {
  sub: string;
  role: Role;
};

const UNAUTHORIZED = {
  error: "UNAUTHORIZED",
  message: "Authentication required",
};
const FORBIDDEN = { error: "FORBIDDEN", message: "Insufficient permissions" };

/** Verify a bearer token and return the access payload, or null if invalid. */
async function resolveUser(
  bearer: string | undefined,
  verify: (token: string) => Promise<unknown>,
): Promise<AccessPayload | null> {
  if (!bearer) return null;
  const payload = await verify(bearer);
  return payload ? (payload as unknown as AccessPayload) : null;
}

/**
 * Auth plugin: the access-token JWT signer, the bearer extractor, and
 * reusable guard macros. (Refresh tokens are opaque random strings minted in
 * the auth module — no signer needed.) On success each macro adds a typed
 * `user: AccessPayload` to the context.
 *
 *   { isAuthed: true }                                  // any authenticated user
 *   { hasRole: 'admin' }                                // role gate
 *   { can: { action: 'user:update', ownParam: 'id' } }  // permission + scope
 *
 * The `can` macro also adds `scope: 'all' | 'own'` — use it for field/row-level
 * rules (e.g. only "all" scope may change another record's role).
 */
export const authPlugin = new Elysia({ name: "auth" })
  .use(jwt({ name: "jwt", secret: env.JWT_SECRET, exp: env.JWT_ACCESS_EXP }))
  .use(bearer())
  .macro({
    isAuthed: {
      async resolve({ bearer, jwt, status }) {
        const user = await resolveUser(bearer, (t) => jwt.verify(t));
        if (!user) return status(401, UNAUTHORIZED);
        return { user };
      },
    },
    hasRole(role: Role) {
      return {
        async resolve({ bearer, jwt, status }) {
          const user = await resolveUser(bearer, (t) => jwt.verify(t));
          if (!user) return status(401, UNAUTHORIZED);
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
        async resolve({ bearer, jwt, params, status }) {
          const user = await resolveUser(bearer, (t) => jwt.verify(t));
          if (!user) return status(401, UNAUTHORIZED);

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
     * Require a verified email. Authenticates, then checks `emailVerifiedAt` in
     * the DB (always fresh). Not applied to any route yet — opt in per route
     * with `{ verifiedEmail: true }`.
     */
    verifiedEmail: {
      async resolve({ bearer, jwt, status }) {
        const user = await resolveUser(bearer, (t) => jwt.verify(t));
        if (!user) return status(401, UNAUTHORIZED);

        const [row] = await db
          .select({ emailVerifiedAt: users.emailVerifiedAt })
          .from(users)
          .where(eq(users.id, user.sub))
          .limit(1);

        if (!row?.emailVerifiedAt)
          return status(403, {
            error: "EMAIL_NOT_VERIFIED",
            message: "Email verification required",
          });

        return { user };
      },
    },
  });
