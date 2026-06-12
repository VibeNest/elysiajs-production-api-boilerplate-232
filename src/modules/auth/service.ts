import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { refreshTokens, users } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
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

/** Soft delete: auth must never see deleted accounts. */
const notDeleted = isNull(users.deletedAt);

/**
 * Request-independent auth logic: password hashing and all database access.
 * Access-token signing and refresh-token minting live in `issueTokens` in the
 * module file (signing needs the request-scoped JWT signer from the auth
 * plugin).
 */
export abstract class AuthService {
  static async createUser(email: string, password: string, name?: string) {
    // Only ACTIVE accounts block the address — a soft-deleted user's email
    // can be re-registered (enforced by the partial unique index too).
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), notDeleted))
      .limit(1);
    if (existing.length > 0)
      throw new ConflictError("Email already registered");

    const passwordHash = await Bun.password.hash(password);
    try {
      const [user] = await db
        .insert(users)
        .values({ email, passwordHash, name })
        .returning();
      return user;
    } catch (err) {
      // Closes the race: two concurrent registrations can both pass the
      // pre-check above, then the partial unique index rejects the loser.
      if (isUniqueViolation(err))
        throw new ConflictError("Email already registered");
      throw err;
    }
  }

  static async findById(id: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), notDeleted))
      .limit(1);
    return user;
  }

  static async findByEmail(email: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), notDeleted))
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

  /** Delete expired refresh tokens. Returns how many rows were removed. */
  static async deleteExpiredRefreshTokens(): Promise<number> {
    const deleted = await db
      .delete(refreshTokens)
      .where(lt(refreshTokens.expiresAt, new Date()))
      .returning({ id: refreshTokens.id });
    return deleted.length;
  }

  static async verifyCredentials(email: string, password: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), notDeleted))
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
   *
   * The claim is a single conditional UPDATE (`used_at IS NULL AND not expired`)
   * so it's atomic: two concurrent requests with the same token can't both
   * succeed — Postgres' row lock lets exactly one win, and the loser falls
   * through to the reuse branch (used_at is now set) and burns the family.
   */
  static async useRefreshToken(token: string) {
    const hash = sha256Hex(token);
    const now = new Date();

    // Atomically claim the token: succeeds only if it exists, is unused, and
    // isn't expired. Whoever flips used_at from NULL wins the rotation.
    const [claimed] = await db
      .update(refreshTokens)
      .set({ usedAt: now })
      .where(
        and(
          eq(refreshTokens.token, hash),
          isNull(refreshTokens.usedAt),
          gt(refreshTokens.expiresAt, now),
        ),
      )
      .returning();

    if (claimed) return claimed;

    // The claim failed — find out why: unknown token, reuse/lost race, expired.
    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.token, hash))
      .limit(1);

    if (!row) throw new UnauthorizedError("Invalid refresh token");

    if (row.usedAt) {
      // Already used (replayed token, or the loser of a concurrent rotation) →
      // theft containment: burn the whole family.
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

    // Exists, unused, but the claim's expiry guard rejected it → expired.
    await db.delete(refreshTokens).where(eq(refreshTokens.id, row.id));
    throw new UnauthorizedError("Invalid or expired refresh token");
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
