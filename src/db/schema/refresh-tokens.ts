import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./users";

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // SHA-256 hash of the signed refresh JWT (never the raw token).
    token: varchar("token", { length: 512 }).notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // All tokens minted from one login share a family. Reusing an already-
    // rotated token revokes the whole family (theft containment).
    familyId: uuid("family_id").notNull().defaultRandom(),
    // Set when a token is rotated. A second use of a used token = reuse.
    usedAt: timestamp("used_at"),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("refresh_tokens_family_id_idx").on(table.familyId)],
);
