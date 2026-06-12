/**
 * Postgres error-code helpers for mapping driver errors to domain errors.
 *
 * Drizzle ORM wraps postgres.js errors in a `DrizzleQueryError` whose
 * `.cause` carries the original `PostgresError` with a string `.code`
 * (the SQLSTATE). We check both layers so the helper works whether the
 * caller catches the raw driver error or the Drizzle wrapper.
 */

function hasSqlstateCode(val: unknown, code: string): boolean {
  return (
    typeof val === "object" &&
    val !== null &&
    "code" in val &&
    (val as { code: unknown }).code === code
  );
}

/** SQLSTATE 23505 — unique_violation. */
export function isUniqueViolation(err: unknown): boolean {
  if (hasSqlstateCode(err, "23505")) return true;
  // Drizzle wraps the driver error: check the cause too.
  if (typeof err === "object" && err !== null && "cause" in err) {
    return hasSqlstateCode((err as { cause: unknown }).cause, "23505");
  }
  return false;
}
