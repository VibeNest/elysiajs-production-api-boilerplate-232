import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Append-only audit trail for sensitive operations (role changes, deletions,
 * password resets, detected token theft, ...).
 *
 * `actorId` is intentionally NOT a foreign key to users: audit rows must
 * outlive the accounts they reference (forensics), so deleting a user never
 * cascades away their history.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Dotted event name, e.g. "user.role_changed".
    action: varchar("action", { length: 100 }).notNull(),
    // Who performed it (null = system / anonymous).
    actorId: uuid("actor_id"),
    targetType: varchar("target_type", { length: 50 }),
    targetId: varchar("target_id", { length: 255 }),
    metadata: jsonb("metadata"),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("audit_logs_actor_id_idx").on(table.actorId),
    index("audit_logs_action_idx").on(table.action),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ],
);
