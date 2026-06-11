import { cache } from "@/lib/cache";
import { BadRequestError } from "@/lib/errors";
import { verificationCodeEmail } from "@/lib/mail-templates";
import { emailQueue } from "@/queue/email.queue";

const OTP_TTL_SECONDS = 10 * 60; // code lifetime
const COOLDOWN_SECONDS = 60; // min gap between requests
const MAX_ATTEMPTS = 5; // verify attempts per issued code

const codeKey = (userId: string) => `otp:verify:${userId}`;
const attemptsKey = (userId: string) => `otp:verify:attempts:${userId}`;
const cooldownKey = (userId: string) => `otp:verify:cooldown:${userId}`;

/** Cryptographically-random 6-digit code. */
function generateCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

/** SHA-256 hex — codes are never stored in plaintext. */
function hashCode(code: string): string {
  return new Bun.CryptoHasher("sha256").update(code).digest("hex");
}

/**
 * Email-verification OTP, backed by Redis (see lib/cache.ts).
 * Request-independent — all state lives in Redis with TTLs.
 */
export abstract class OtpService {
  /** Generate, store (hashed, TTL), and email a code. Enforces a resend cooldown. */
  static async issue(userId: string, email: string): Promise<void> {
    if (await cache.exists(cooldownKey(userId)))
      throw new BadRequestError(
        "A code was just sent — please wait before requesting another",
      );

    const code = generateCode();
    await cache.set(codeKey(userId), hashCode(code), OTP_TTL_SECONDS);
    await cache.set(attemptsKey(userId), "0", OTP_TTL_SECONDS);
    await cache.set(cooldownKey(userId), "1", COOLDOWN_SECONDS);

    await emailQueue.add(verificationCodeEmail(email, code));
  }

  /**
   * Check a submitted code. Returns true on success (consuming the code), false
   * if wrong/expired. Throws after too many attempts.
   */
  static async verify(userId: string, code: string): Promise<boolean> {
    const stored = await cache.get(codeKey(userId));
    if (!stored) return false; // expired or never issued

    const attempts = await cache.incr(attemptsKey(userId));
    if (attempts > MAX_ATTEMPTS) {
      await cache.del(codeKey(userId));
      throw new BadRequestError(
        "Too many attempts — please request a new code",
      );
    }

    if (hashCode(code) !== stored) return false;

    await cache.del(codeKey(userId));
    await cache.del(attemptsKey(userId));
    return true;
  }
}
