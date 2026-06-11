import { and, eq, isNull } from "drizzle-orm";
import * as OTPAuth from "otpauth";
import { env } from "@/config/env";
import { db } from "@/db";
import { users } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { cache } from "@/lib/cache";
import { BadRequestError, UnauthorizedError } from "@/lib/errors";
import { randomToken, sha256Hex } from "@/lib/hash";

const PERIOD_SECONDS = 30;
const CHALLENGE_TTL_SECONDS = 5 * 60; // password-to-code window
const MAX_ATTEMPTS = 5; // code tries per challenge

const challengeKey = (tokenHash: string) => `mfa:login:${tokenHash}`;
const attemptsKey = (tokenHash: string) => `mfa:login:attempts:${tokenHash}`;
const lastCounterKey = (userId: string) => `totp:last:${userId}`;

const notDeleted = isNull(users.deletedAt);

function buildTotp(secretBase32: string, label = "account") {
  return new OTPAuth.TOTP({
    issuer: env.APP_NAME,
    label,
    algorithm: "SHA1", // what authenticator apps expect
    digits: 6,
    period: PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

/** Validate a code (±1 window for clock drift); returns the accepted counter, or null. */
function validateCode(secretBase32: string, code: string): number | null {
  const delta = buildTotp(secretBase32).validate({ token: code, window: 1 });
  if (delta === null) return null;
  return Math.floor(Date.now() / 1000 / PERIOD_SECONDS) + delta;
}

async function findActiveUser(userId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), notDeleted))
    .limit(1);
  return user;
}

/**
 * TOTP two-factor auth (RFC 6238, authenticator-app compatible).
 *
 * Enrollment: `setup` stores a pending secret and returns the otpauth:// URI
 * (QR-code it client-side); `enable` goes live only after the user proves the
 * app works by echoing a valid code. Login then becomes two steps: password →
 * short-lived challenge (`createLoginChallenge`), code → tokens
 * (`consumeLoginChallenge`).
 *
 * The login challenge is single-use TOTP: an accepted code's counter is
 * remembered (Redis, 3 periods) so the same code can't authenticate twice —
 * `enable`/`disable` are session-authenticated mutations and skip that guard.
 *
 * No recovery codes (yet): a locked-out user needs an operator to clear
 * `totp_secret`/`totp_enabled_at` — the documented break-glass.
 */
export abstract class TotpService {
  /** Generate + store a pending secret; returns it with the otpauth:// URI. */
  static async setup(userId: string) {
    const user = await findActiveUser(userId);
    if (!user) throw new UnauthorizedError();
    if (user.totpEnabledAt)
      throw new BadRequestError("Two-factor auth is already enabled");

    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    await db
      .update(users)
      .set({ totpSecret: secret })
      .where(eq(users.id, userId));

    return { secret, otpauthUrl: buildTotp(secret, user.email).toString() };
  }

  /** Flip the pending secret live once the user echoes a valid code. */
  static async enable(userId: string, code: string) {
    const user = await findActiveUser(userId);
    if (!user) throw new UnauthorizedError();
    if (user.totpEnabledAt)
      throw new BadRequestError("Two-factor auth is already enabled");
    if (!user.totpSecret)
      throw new BadRequestError("Run 2FA setup before enabling");

    if (validateCode(user.totpSecret, code) === null)
      throw new BadRequestError("Invalid code");

    await db
      .update(users)
      .set({ totpEnabledAt: new Date() })
      .where(eq(users.id, userId));
    await recordAudit({
      action: "auth.2fa_enabled",
      actorId: userId,
      targetType: "user",
      targetId: userId,
    });
  }

  /** Turn 2FA off (requires a valid current code). */
  static async disable(userId: string, code: string) {
    const user = await findActiveUser(userId);
    if (!user) throw new UnauthorizedError();
    if (!user.totpEnabledAt || !user.totpSecret)
      throw new BadRequestError("Two-factor auth is not enabled");

    if (validateCode(user.totpSecret, code) === null)
      throw new BadRequestError("Invalid code");

    await db
      .update(users)
      .set({ totpSecret: null, totpEnabledAt: null })
      .where(eq(users.id, userId));
    await recordAudit({
      action: "auth.2fa_disabled",
      actorId: userId,
      targetType: "user",
      targetId: userId,
    });
  }

  /**
   * Password verified but 2FA pending: mint an opaque challenge token (only
   * its hash is stored, mirroring refresh tokens) the client must echo
   * together with a TOTP code.
   */
  static async createLoginChallenge(userId: string): Promise<string> {
    const mfaToken = randomToken();
    const hash = sha256Hex(mfaToken);
    await cache.set(challengeKey(hash), userId, CHALLENGE_TTL_SECONDS);
    await cache.set(attemptsKey(hash), "0", CHALLENGE_TTL_SECONDS);
    return mfaToken;
  }

  /**
   * Verify code + challenge and return the user for token issuance. The
   * challenge burns after MAX_ATTEMPTS wrong codes; an accepted code's
   * counter is remembered so it can't be replayed.
   */
  static async consumeLoginChallenge(mfaToken: string, code: string) {
    const invalid = new UnauthorizedError("Invalid or expired MFA challenge");
    const hash = sha256Hex(mfaToken);

    const userId = await cache.get(challengeKey(hash));
    if (!userId) throw invalid;

    const attempts = await cache.incr(attemptsKey(hash));
    if (attempts > MAX_ATTEMPTS) {
      await cache.del(challengeKey(hash));
      throw new UnauthorizedError(
        "Too many attempts — log in again to get a new challenge",
      );
    }

    const user = await findActiveUser(userId);
    if (!user?.totpSecret || !user.totpEnabledAt) throw invalid;

    const counter = validateCode(user.totpSecret, code);
    if (counter === null) throw new UnauthorizedError("Invalid code");

    // Single-use: reject any code at or before the last accepted counter.
    const last = await cache.get(lastCounterKey(userId));
    if (last !== null && Number(last) >= counter)
      throw new UnauthorizedError("Code already used");
    await cache.set(
      lastCounterKey(userId),
      String(counter),
      PERIOD_SECONDS * 3,
    );

    await cache.del(challengeKey(hash));
    await cache.del(attemptsKey(hash));
    return user;
  }
}
