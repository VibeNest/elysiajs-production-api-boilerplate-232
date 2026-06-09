import { eq } from "drizzle-orm";
import { db } from "../../db";
import { users } from "../../db/schema";
import { BadRequestError, NotFoundError } from "../../lib/errors";

/** Columns safe to expose publicly — note the password hash is never selected. */
const publicColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
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
    return db
      .select(publicColumns)
      .from(users)
      .where(ownerId ? eq(users.id, ownerId) : undefined)
      .limit(limit)
      .offset(offset);
  }

  static async getById(id: string) {
    const [user] = await db
      .select(publicColumns)
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (!user) throw new NotFoundError("User not found");
    return user;
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
      .where(eq(users.id, id))
      .returning(publicColumns);
    if (!user) throw new NotFoundError("User not found");
    return user;
  }

  static async remove(id: string) {
    const [deleted] = await db
      .delete(users)
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (!deleted) throw new NotFoundError("User not found");
    return { success: true };
  }
}
