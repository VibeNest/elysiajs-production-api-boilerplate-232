import { and, eq, gt } from "drizzle-orm";
import { db } from "@/db";
import { refreshTokens, users } from "@/db/schema";
import { ConflictError, UnauthorizedError } from "@/lib/errors";
import { sha256Hex } from "@/lib/hash";

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

  static async verifyCredentials(email: string, password: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    if (!user) throw new UnauthorizedError("Invalid credentials");

    const valid = await Bun.password.verify(password, user.passwordHash);
    if (!valid) throw new UnauthorizedError("Invalid credentials");

    return user;
  }

  static async storeRefreshToken(
    userId: string,
    token: string,
    expiresAt: Date,
  ) {
    // Store only the hash — a DB leak then can't hand out usable tokens.
    await db
      .insert(refreshTokens)
      .values({ userId, token: sha256Hex(token), expiresAt });
  }

  /** Validate a refresh token exists & isn't expired, then delete it (rotation). */
  static async consumeRefreshToken(token: string) {
    const [row] = await db
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.token, sha256Hex(token)),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (!row) throw new UnauthorizedError("Invalid or expired refresh token");

    await db.delete(refreshTokens).where(eq(refreshTokens.id, row.id));
    return row;
  }

  static async revokeRefreshToken(token: string) {
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.token, sha256Hex(token)));
  }

  static async markEmailVerified(userId: string) {
    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, userId));
  }
}
