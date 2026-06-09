import { recordAudit } from "@/lib/audit";
import { cache } from "@/lib/cache";
import { BadRequestError } from "@/lib/errors";
import { sha256Hex } from "@/lib/hash";
import type { Mail } from "@/lib/mailer";
import { emailQueue } from "@/queue/email.queue";
import { AuthService } from "./service";

const TTL_SECONDS = 15 * 60; // reset code lifetime
const COOLDOWN_SECONDS = 60; // min gap between requests
const MAX_ATTEMPTS = 5; // verify attempts per issued code

const codeKey = (userId: string) => `pwreset:${userId}`;
const attemptsKey = (userId: string) => `pwreset:attempts:${userId}`;
const cooldownKey = (userId: string) => `pwreset:cooldown:${userId}`;

/** Cryptographically-random 6-digit code. */
function generateCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
  return n.toString().padStart(6, "0");
}

function resetEmail(to: string, code: string): Mail {
  return {
    to,
    subject: "Your password reset code",
    text: `Your password reset code is ${code}. It expires in 15 minutes. If you didn't request this, ignore this email.`,
  };
}

/**
 * Forgotten-password reset, backed by Redis (mirrors otp.service.ts).
 *
 * Enumeration-safe by design: `request` always resolves the same way whether or
 * not the email exists (no code is sent for unknown emails, but the caller can't
 * tell), and `reset` returns an identical error for a missing user, a wrong
 * code, or an expired code. A successful reset revokes all refresh tokens so
 * existing sessions are invalidated.
 */
export abstract class PasswordResetService {
  /** Issue and email a reset code. Silent no-op for unknown emails / cooldown. */
  static async request(email: string): Promise<void> {
    const user = await AuthService.findByEmail(email);
    if (!user) return; // unknown email — don't reveal it
    if (await cache.exists(cooldownKey(user.id))) return; // within cooldown

    const code = generateCode();
    await cache.set(codeKey(user.id), sha256Hex(code), TTL_SECONDS);
    await cache.set(attemptsKey(user.id), "0", TTL_SECONDS);
    await cache.set(cooldownKey(user.id), "1", COOLDOWN_SECONDS);

    await emailQueue.add(resetEmail(email, code));
  }

  /** Verify the code and set the new password. Throws on any failure. */
  static async reset(
    email: string,
    code: string,
    newPassword: string,
  ): Promise<void> {
    const invalid = new BadRequestError("Invalid or expired reset code");

    const user = await AuthService.findByEmail(email);
    if (!user) throw invalid;

    const stored = await cache.get(codeKey(user.id));
    if (!stored) throw invalid;

    const attempts = await cache.incr(attemptsKey(user.id));
    if (attempts > MAX_ATTEMPTS) {
      await cache.del(codeKey(user.id));
      throw new BadRequestError(
        "Too many attempts — please request a new code",
      );
    }

    if (sha256Hex(code) !== stored) throw invalid;

    await cache.del(codeKey(user.id));
    await cache.del(attemptsKey(user.id));

    await AuthService.updatePassword(user.id, newPassword);
    // Password changed — invalidate every existing session.
    await AuthService.revokeAllRefreshTokens(user.id);

    await recordAudit({
      action: "auth.password_reset",
      actorId: user.id,
      targetType: "user",
      targetId: user.id,
    });
  }
}
