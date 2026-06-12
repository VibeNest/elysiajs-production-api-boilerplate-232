import { describe, expect, it } from "bun:test";
import { isUniqueViolation } from "@/lib/db-errors";

describe("isUniqueViolation", () => {
  it("is true for a Postgres unique-violation error (23505)", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });

  it("is true for a Drizzle-wrapped unique-violation error (cause.code === 23505)", () => {
    // Drizzle ORM wraps postgres.js errors in DrizzleQueryError; the SQLSTATE
    // lives on .cause, not on the wrapper itself.
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
  });

  it("is false for other Postgres error codes", () => {
    expect(isUniqueViolation({ code: "23503" })).toBe(false); // FK violation
    expect(isUniqueViolation({ cause: { code: "23503" } })).toBe(false);
  });

  it("is false for non-error / non-object values", () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});
