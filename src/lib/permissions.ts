/**
 * Permission model: `<model>:<operation>:<scope>` (e.g. "user:update:own").
 *
 * - scope "all"  → may act on any record of that model
 * - scope "own"  → may act only on records the requester owns
 *
 * Roles map to a set of permissions here. The JWT only carries the `role`;
 * permissions are resolved from this map on each request, so changing a role's
 * permissions takes effect immediately without reissuing tokens.
 */
export type Role = "user" | "admin";
export type Operation = "create" | "read" | "update" | "delete";
export type Scope = "all" | "own";

export type Permission = `${string}:${Operation}:${Scope}`;

/** "*" is a superuser grant: every operation at "all" scope. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[] | "*"> = {
  admin: "*",
  user: ["user:read:own", "user:update:own", "user:delete:own"],
};

/**
 * Resolve which scope `role` is granted for a `<model>:<operation>` pair.
 * Returns "all", "own", or null (denied). "all" takes precedence over "own".
 */
export function resolveScope(
  role: Role,
  model: string,
  operation: Operation,
): Scope | null {
  const grants = ROLE_PERMISSIONS[role];
  if (grants === "*") return "all";

  const prefix = `${model}:${operation}:`;
  if (grants.includes(`${prefix}all` as Permission)) return "all";
  if (grants.includes(`${prefix}own` as Permission)) return "own";
  return null;
}
