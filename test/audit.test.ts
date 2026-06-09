import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { json, registerUser } from "./helpers";

const auditCount = async (action: string, actorId: string) => {
  const rows = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.actorId, actorId)));
  return rows.length;
};

describe("audit log (requires Postgres)", () => {
  it("records user.created on registration", async () => {
    const u = await registerUser();
    expect(await auditCount("user.created", u.id)).toBe(1);
  });

  it("records security.token_reuse_detected when a token is replayed", async () => {
    const u = await registerUser();
    const reg = await json("/auth/login", "POST", {
      email: u.email,
      password: u.password,
    }).then((r) => r.json());
    const original: string = reg.refreshToken;

    await json("/auth/refresh", "POST", { refreshToken: original });
    // Replay the now-rotated token → reuse detected.
    await json("/auth/refresh", "POST", { refreshToken: original });

    expect(
      await auditCount("security.token_reuse_detected", u.id),
    ).toBeGreaterThanOrEqual(1);
  });
});
