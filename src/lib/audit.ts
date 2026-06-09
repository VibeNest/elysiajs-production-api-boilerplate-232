import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { logger } from "@/lib/logger";

export interface AuditEntry {
  /** Dotted event name, e.g. "user.role_changed". */
  action: string;
  /** Who performed it (null/undefined = system or anonymous). */
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
}

/**
 * Append an audit-trail entry. Best-effort: a failed audit write is logged but
 * never throws, so it can't break the operation it's recording. Call it after
 * the operation it describes has succeeded.
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      action: entry.action,
      actorId: entry.actorId ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.metadata ?? null,
      ip: entry.ip ?? null,
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, "failed to write audit log");
  }
}
