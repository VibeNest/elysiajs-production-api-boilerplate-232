/**
 * TypeBox model barrel — the single source of truth for request/response shapes.
 * Add a file per table next to this one (mirroring db/schema/), re-export it
 * here, and register its columns in `dbSchema`. Compose these into Elysia models
 * inside each feature module (see modules/user/model.ts).
 */
export * from "./audit-logs";
export * from "./refresh-tokens";
export * from "./users";

import { auditLogColumns } from "./audit-logs";
import { refreshTokenColumns } from "./refresh-tokens";
import { userColumns } from "./users";

export const dbSchema = {
  insert: {
    users: userColumns.insert,
    refreshTokens: refreshTokenColumns.insert,
    auditLogs: auditLogColumns.insert,
  },
  select: {
    users: userColumns.select,
    refreshTokens: refreshTokenColumns.select,
    auditLogs: auditLogColumns.select,
  },
} as const;
