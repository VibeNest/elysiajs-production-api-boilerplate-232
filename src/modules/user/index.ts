import { Elysia } from "elysia";
import { ForbiddenError } from "../../lib/errors";
import { authPlugin } from "../../plugins/auth";
import { userModel } from "./model";
import { UserService } from "./service";

/**
 * Example CRUD controller using the permission model (see lib/permissions.ts).
 * Access is gated by `can: { action: '<model>:<operation>', ownParam }`; the
 * resolved `scope` ('all' | 'own') drives field/row-level rules.
 */
export const userModule = new Elysia({ prefix: "/users", tags: ["Users"] })
  .use(authPlugin)
  .model(userModel)
  .get(
    "/",
    async ({ query, user, scope }) =>
      scope === "all"
        ? await UserService.list(query.limit, query.offset)
        : // "own" scope: a non-privileged user only sees themselves
          await UserService.list(query.limit, query.offset, user.sub),
    {
      can: { action: "user:read" },
      query: "listQuery",
      response: "userList",
      detail: {
        summary: "List users (own scope returns only yourself)",
        tags: ["Users"],
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .get("/:id", ({ params }) => UserService.getById(params.id), {
    can: { action: "user:read", ownParam: "id" },
    params: "idParam",
    response: "publicUser",
    detail: {
      summary: "Get a user by id (self or admin)",
      tags: ["Users"],
      security: [{ bearerAuth: [] }],
    },
  })
  .patch(
    "/:id",
    ({ params, body, scope }) => {
      // Only "all" scope (e.g. admin) may change a role.
      if (scope !== "all" && body.role !== undefined)
        throw new ForbiddenError("Only admins can change roles");
      return UserService.update(params.id, body);
    },
    {
      can: { action: "user:update", ownParam: "id" },
      params: "idParam",
      body: "updateUserBody",
      response: "publicUser",
      detail: {
        summary: "Update a user (self or admin; role requires admin)",
        tags: ["Users"],
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .delete("/:id", ({ params }) => UserService.remove(params.id), {
    can: { action: "user:delete", ownParam: "id" },
    params: "idParam",
    detail: {
      summary: "Delete a user (self or admin)",
      tags: ["Users"],
      security: [{ bearerAuth: [] }],
    },
  });
