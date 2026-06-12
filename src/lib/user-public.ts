import { type Static, t } from "elysia";
import { dbSchema } from "@/db/model";

// Schema-derived columns are the single source of truth (see db/model.ts).
const cols = dbSchema.select.users;

/**
 * Public-safe representation of a user — the single source of truth shared by
 * the auth and user modules. Never includes the password hash or any secret.
 */
export const publicUser = t.Object({
  id: cols.id,
  email: cols.email,
  name: cols.name,
  role: cols.role,
  emailVerified: t.Boolean(),
  totpEnabled: t.Boolean(),
  createdAt: cols.createdAt,
});

/** The fields the mapper reads. Extra fields on the input are ignored. */
type PublicUserInput = {
  id: string;
  email: string;
  name: string | null;
  role: "user" | "admin";
  emailVerifiedAt: Date | null;
  totpEnabledAt: Date | null;
  createdAt: Date;
};

/**
 * Map a user row to the public shape. Picks fields EXPLICITLY (never spreads)
 * so it is safe to pass a full DB row — secrets like the password hash are not
 * carried through.
 */
export const toPublicUser = (
  u: PublicUserInput,
): Static<typeof publicUser> => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  emailVerified: u.emailVerifiedAt !== null,
  totpEnabled: u.totpEnabledAt !== null,
  createdAt: u.createdAt,
});
