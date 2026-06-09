import { eq } from "drizzle-orm";
import { env } from "@/config/env";
import { db, queryClient } from "@/db";
import { users } from "@/db/schema";
import { logger } from "@/lib/logger";

/**
 * Idempotent seed: ensures an admin user exists. Run with `bun run db:seed`.
 * Configure SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD first (the password has no
 * default — seeding refuses to create an account with a blank one).
 */
async function seed() {
  const email = env.SEED_ADMIN_EMAIL;
  const password = env.SEED_ADMIN_PASSWORD;

  if (!password) {
    logger.error(
      "SEED_ADMIN_PASSWORD is empty — set it before running db:seed",
    );
    await queryClient.end();
    process.exit(1);
  }

  const [existing] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing) {
    if (existing.role === "admin") {
      logger.info({ email }, "admin already exists — nothing to do");
    } else {
      await db
        .update(users)
        .set({ role: "admin" })
        .where(eq(users.id, existing.id));
      logger.info({ email }, "promoted existing user to admin");
    }
  } else {
    const passwordHash = await Bun.password.hash(password);
    await db.insert(users).values({
      email,
      passwordHash,
      name: "Admin",
      role: "admin",
      emailVerifiedAt: new Date(),
    });
    logger.info({ email }, "created admin user");
  }

  await queryClient.end();
  process.exit(0);
}

seed();
