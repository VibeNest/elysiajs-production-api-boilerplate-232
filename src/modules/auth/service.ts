import { eq } from "drizzle-orm";
import { db } from "@/db";
import { refreshTokens, users } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { ConflictError, UnauthorizedError } from "@/lib/errors";
import { sha256Hex } from "@/lib/hash";
import { logger } from "@/lib/logger";

/**
 * A real argon2id hash to verify against when the email doesn't exist, so a
 * failed login costs the same whether the account is missing or the password is
 * wrong — closing the timing side-channel that leaks which emails are
 * registered. Computed once, lazily.
 */
let dummyHash: string | null = null;
async function getDummyHash(): Promise<string> {
  if (!dummyHash)
    dummyHash = await Bun.password.hash("invalid-credentials-placeholder");
  return dummyHash;
}

/**
 * Request-independent auth logic: password hashing and all database access.
 * Token signing lives in the route handlers (it needs the request-scoped JWT
 * signers from the auth plugin).
 */
export abstract class AuthService {
  static async createUser(email: string, password: string, name?: string) {
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (existing.length > 0)
      throw new ConflictError("Email already registered");

    const passwordHash = await Bun.password.hash(password);
    const [user] = await db
      .insert(users)
      .values({ email, passwordHash, name })
      .returning();
    return user;
  }

  static async findById(id: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return user;
  }

  static async findByEmail(email: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return user;
  }

  /** Set a new password (hashed). Used by the password-reset flow. */
  static async updatePassword(userId: string, password: string) {
    const passwordHash = await Bun.password.hash(password);
    await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  }

  /** Revoke every refresh token for a user (e.g. after a password reset). */
  static async revokeAllRefreshTokens(userId: string) {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  }

  static async verifyCredentials(email: string, password: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) {
      // Spend the same argon2 work as a real verify, then fail identically.
      await Bun.password.verify(password, await getDummyHash());
      throw new UnauthorizedError("Invalid credentials");
    }

    const valid = await Bun.password.verify(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError("Invalid credentials");

    return user;
  }

  static async storeRefreshToken(
    userId: string,
    token: string,
    expiresAt: Date,
    familyId: string,
  ) {
    // Store only the hash — a DB leak then can't hand out usable tokens.
    await db
      .insert(refreshTokens)
      .values({ userId, token: sha256Hex(token), expiresAt, familyId });
  }

  /**
   * Consume a refresh token for rotation, with theft detection.
   *
   * The token row is kept and marked `usedAt` instead of deleted. A second
   * presentation of an already-used token means it was stolen and replayed
   * after the legitimate client rotated it — so the entire token family is
   * revoked, logging out both parties. Returns the row (with its `familyId`)
   * for the caller to mint the next token in the same family.
   */
  static async useRefreshToken(token: string) {
    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.token, sha256Hex(token)))
      .limit(1);

    if (!row) throw new UnauthorizedError("Invalid refresh token");

    if (row.usedAt) {
      // Reuse of a rotated token → theft. Burn the whole family.
      await db
        .delete(refreshTokens)
        .where(eq(refreshTokens.familyId, row.familyId));
      logger.warn(
        { userId: row.userId, familyId: row.familyId },
        "refresh token reuse detected — token family revoked",
      );
      await recordAudit({
        action: "security.token_reuse_detected",
        actorId: row.userId,
        targetType: "refresh_token_family",
        targetId: row.familyId,
      });
      throw new UnauthorizedError("Refresh token reuse detected");
    }

    if (row.expiresAt <= new Date()) {
      await db.delete(refreshTokens).where(eq(refreshTokens.id, row.id));
      throw new UnauthorizedError("Invalid or expired refresh token");
    }

    await db
      .update(refreshTokens)
      .set({ usedAt: new Date() })
      .where(eq(refreshTokens.id, row.id));
    return row;
  }

  /** Revoke a session by deleting the presented token's entire family. */
  static async revokeRefreshToken(token: string) {
    const [row] = await db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(eq(refreshTokens.token, sha256Hex(token)))
      .limit(1);
    if (!row) return;
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.familyId, row.familyId));
  }

  static async markEmailVerified(userId: string) {
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, userId));
  }
}
