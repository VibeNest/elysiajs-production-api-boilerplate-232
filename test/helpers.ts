import { eq } from "drizzle-orm";
import { app } from "../src/app";
import { db } from "../src/db";
import { users } from "../src/db/schema";

/** Fire a request at the app in-process (no network) and get the Response. */
export const api = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init));

/** Convenience for JSON requests, optionally authenticated with a bearer token. */
export const json = (
  path: string,
  method: string,
  body: unknown,
  token?: string,
) =>
  api(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

/** Read a Response body as JSON, typed loosely for assertions. */
// biome-ignore lint/suspicious/noExplicitAny: test assertions read arbitrary JSON
export const body = (res: Response): Promise<any> => res.json();

export const uniqueEmail = () => `user_${crypto.randomUUID()}@example.com`;

/** Promote a user to the admin role directly in the database. */
export const promoteToAdmin = (id: string) =>
  db.update(users).set({ role: "admin" }).where(eq(users.id, id));

/**
 * Register a fresh user and return its id + a valid access token. With
 * `{ admin: true }` the user is promoted and re-logged-in so the token carries
 * the admin role.
 */
export async function registerUser(opts?: { admin?: boolean }) {
  const email = uniqueEmail();
  const password = "supersecret";

  const reg = await body(
    await json("/auth/register", "POST", { email, password }),
  );
  let accessToken: string = reg.accessToken;
  const id: string = reg.user.id;

  if (opts?.admin) {
    await promoteToAdmin(id);
    const login = await body(
      await json("/auth/login", "POST", { email, password }),
    );
    accessToken = login.accessToken;
  }

  return { id, email, password, accessToken };
}
