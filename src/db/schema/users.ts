import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["user", "admin"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }),
    role: roleEnum("role").notNull().default("user"),
    emailVerifiedAt: timestamp("email_verified_at"),
    // TOTP 2FA: base32 secret written at setup (pending), live once
    // totpEnabledAt is set. Stored plaintext — verification needs the raw
    // secret; encrypt at rest (KMS/pgcrypto) if your threat model includes
    // DB dumps.
    totpSecret: varchar("totp_secret", { length: 64 }),
    totpEnabledAt: timestamp("totp_enabled_at"),
    // Soft delete: rows are marked, never removed (audit/forensics). Every
    // read-path query must filter on deleted_at IS NULL — see notDeleted in
    // the services.
    deletedAt: timestamp("deleted_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // Partial unique: only ACTIVE accounts hold the address, so a deleted
    // account releases its email for re-registration.
    uniqueIndex("users_email_active_unique")
      .on(table.email)
      .where(sql`deleted_at IS NULL`),
  ],
);
