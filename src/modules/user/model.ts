import { t } from "elysia";
import { sanitizedString } from "@/lib/sanitize";
import { publicUser } from "@/lib/user-public";

export const userModel = {
  publicUser,
  // Array responses are registered as their own named model — referencing a
  // model that carries a `$id` inline inside t.Array() breaks Elysia's response
  // validator, so we register the list shape and reference it by name.
  userList: t.Array(publicUser),
  listQuery: t.Object({
    limit: t.Optional(t.Number({ minimum: 1, maximum: 100, default: 20 })),
    offset: t.Optional(t.Number({ minimum: 0, default: 0 })),
  }),
  updateUserBody: t.Object({
    name: t.Optional(sanitizedString({ maxLength: 255 })),
    role: t.Optional(t.Union([t.Literal("user"), t.Literal("admin")])),
  }),
  idParam: t.Object({
    id: t.String({ format: "uuid" }),
  }),
} as const;
