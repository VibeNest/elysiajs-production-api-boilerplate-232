import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/config/env";
import * as schema from "./schema";

/**
 * Postgres connection + Drizzle client. Import `db` anywhere a query is needed.
 * The underlying postgres.js client (`queryClient`) is exported for graceful
 * shutdown. Pool size and timeouts are env-tunable (see config/env.ts).
 */
export const queryClient = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  idle_timeout: env.DB_IDLE_TIMEOUT,
  connect_timeout: env.DB_CONNECT_TIMEOUT,
});

export const db = drizzle(queryClient, { schema });

export { schema };
