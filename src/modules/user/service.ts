import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { toPublicUser } from "@/lib/user-public";
import { AuthService } from "@/modules/auth/service";

/** Soft delete: every read/write path must exclude deleted rows. */
const notDeleted = isNull(users.deletedAt);

/** Columns safe to expose publicly — note the password hash is never selected. */
const publicColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  emailVerifiedAt: users.emailVerifiedAt,
  createdAt: users.createdAt,
};

/**
 * Example CRUD service. Copy this module (service + model + index) as the
 * starting point for new resources.
 */
export abstract class UserService {
  // All service methods are async — callers should `await` the result rather
  // than return the Drizzle query builder (a thenable) straight to a route, so
  // Elysia validates resolved data (notably for array responses).
  static async list(limit = 20, offset = 0, ownerId?: string) {
    const rows = await db
      .select(publicColumns)
      .from(users)
      .where(ownerId ? and(eq(users.id, ownerId), notDeleted) : notDeleted)
      .orderBy(desc(users.createdAt), users.id)
      .limit(limit)
      .offset(offset);
    return rows.map(toPublicUser);
  }

  static async getById(id: string) {
    const [user] = await db
      .select(publicColumns)
      .from(users)
      .where(and(eq(users.id, id), notDeleted))
      .limit(1);
    if (!user) throw new NotFoundError("User not found");
    return toPublicUser(user);
  }

  static async update(
    id: string,
    data: { name?: string; role?: "user" | "admin" },
  ) {
    if (Object.keys(data).length === 0)
      throw new BadRequestError("No fields to update");

    const [user] = await db
      .update(users)
      .set(data)
      .where(and(eq(users.id, id), notDeleted))
      .returning(publicColumns);
    if (!user) throw new NotFoundError("User not found");
    return toPublicUser(user);
  }

  /**
   * Soft delete: mark the row (the partial unique index releases the email
   * for re-registration) and revoke every session. The row itself is kept —
   * audit history and FKs stay intact.
   */
  static async remove(id: string) {
    const [deleted] = await db
      .update(users)
      .set({ deletedAt: new Date() })
      .where(and(eq(users.id, id), notDeleted))
      .returning({ id: users.id });
    if (!deleted) throw new NotFoundError("User not found");

    // A deleted account must not keep live sessions.
    await AuthService.revokeAllRefreshTokens(id);
    return { success: true };
  }
}
