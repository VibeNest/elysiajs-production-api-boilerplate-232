import { jwtVerify, SignJWT } from "jose";
import { env } from "@/config/env";
import type { Role } from "./permissions";

/** Claims carried by an access token — only what authorization needs. */
export type AccessPayload = {
  sub: string;
  role: Role;
};

const key = (secret: string) => new TextEncoder().encode(secret);

/**
 * Access-token signing/verification (HS256 via jose). Secrets are read from
 * env **per call** — never captured at module load — which is what makes
 * zero-downtime rotation work: deploy with the new JWT_SECRET and the old one
 * in JWT_SECRET_PREVIOUS, and both in-flight and new tokens verify. Drop
 * JWT_SECRET_PREVIOUS once JWT_ACCESS_EXP has passed.
 */
export async function signAccessToken(payload: AccessPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(env.JWT_ACCESS_EXP)
    .sign(key(env.JWT_SECRET));
}

/** Verify against the current secret, then the previous one (rotation window). */
export async function verifyAccessToken(
  token: string,
): Promise<AccessPayload | null> {
  const secrets = [env.JWT_SECRET, env.JWT_SECRET_PREVIOUS].filter(Boolean);

  for (const secret of secrets) {
    try {
      const { payload } = await jwtVerify(token, key(secret));
      if (
        typeof payload.sub === "string" &&
        (payload.role === "user" || payload.role === "admin")
      )
        return { sub: payload.sub, role: payload.role };
      return null; // valid signature but not an access-token shape
    } catch {
      // try the next secret (or fall through to null)
    }
  }
  return null;
}
