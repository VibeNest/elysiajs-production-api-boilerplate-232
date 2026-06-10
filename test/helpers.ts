import { eq } from "drizzle-orm";
import { app } from "@/app";
import { env } from "@/config/env";
import { db } from "@/db";
import { users } from "@/db/schema";
import { mailer } from "@/lib/mailer";

/** Fire a request at the app in-process (no network) and get the Response. */
export const api = (path: string, init?: RequestInit) =>
  app.handle(new Request(`http://localhost${path}`, init));

/** Convenience for JSON requests, optionally authenticated with a bearer token. */
export const json = (
  path: string,
  method: string,
  body: unknown,
  token?: string,
  headers?: Record<string, string>,
) =>
  api(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

/**
 * Temporarily override a validated env value (e.g. AUTH_TRANSPORT) for a test
 * block; call the returned restore function in `afterAll`. This mutates shared
 * process state — it would break under `test.concurrent`.
 */
export function setEnv<K extends keyof typeof env>(
  key: K,
  value: (typeof env)[K],
) {
  const prev = env[key];
  env[key] = value;
  return () => {
    env[key] = prev;
  };
}

/** The raw Set-Cookie header for `name` from a response, or undefined. */
export const setCookie = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

/** The value of the Set-Cookie header for `name`, or undefined. */
export const setCookieValue = (res: Response, name: string) =>
  setCookie(res, name)
    ?.split(";")[0]
    ?.slice(name.length + 1);

/** Read a Response body as JSON, typed loosely for assertions. */
// biome-ignore lint/suspicious/noExplicitAny: test assertions read arbitrary JSON
export const body = (res: Response): Promise<any> => res.json();

export const uniqueEmail = () => `user_${crypto.randomUUID()}@example.com`;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Read the most recent OTP code emailed to `email` (from the dev mailer outbox). */
export const lastOtp = (email: string): string | undefined =>
  mailer.lastTo(email)?.text.match(/\b(\d{6})\b/)?.[1];

/** Run the full email-verification flow for a user with a valid access token. */
export async function verifyEmail(token: string, email: string) {
  await api("/auth/email/request-otp", {
    method: "POST",
    headers: auth(token),
  });
  const code = lastOtp(email);
  if (!code) throw new Error("no OTP code was emailed");
  return json("/auth/email/verify", "POST", { code }, token);
}

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
