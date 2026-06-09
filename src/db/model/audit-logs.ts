import { createInsertSchema, createSelectSchema } from "drizzle-typebox";
import { auditLogs } from "@/db/schema/audit-logs";
import { spread } from "@/db/utils";

/** TypeBox column schemas for the `audit_logs` table. */
export const auditLogColumns = {
  insert: spread(createInsertSchema(auditLogs), "insert"),
  select: spread(createSelectSchema(auditLogs), "select"),
};
