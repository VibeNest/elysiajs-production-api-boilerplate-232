import { env } from "@/config/env";
import type { Mail } from "./mailer";

/** Minimal HTML escaping for anything interpolated into a template. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailContent {
  heading: string;
  /** Paragraphs, in order. Plain text — they are escaped here. */
  lines: string[];
  /** Optional one-time code, rendered large and copyable. */
  code?: string;
  /** Small print under the card. */
  footer?: string;
}

/**
 * Branded HTML wrapper shared by all transactional mail. Table layout +
 * inline styles for email-client compatibility; everything interpolated is
 * escaped. Keep `text` as the source of truth for content — HTML is
 * presentation (and tests read codes from `text`).
 */
export function renderEmailHtml(content: EmailContent): string {
  const paragraphs = content.lines
    .map(
      (line) =>
        `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#333333;">${escapeHtml(line)}</p>`,
    )
    .join("\n");

  const codeBlock = content.code
    ? `<div style="margin:20px 0;padding:14px 0;background:#f4f5f7;border-radius:8px;text-align:center;font-family:SFMono-Regular,Menlo,Consolas,monospace;font-size:28px;letter-spacing:8px;color:#111111;">${escapeHtml(content.code)}</div>`
    : "";

  const footer = content.footer
    ? `<p style="margin:16px 0 0;font-size:12px;line-height:1.5;color:#8a8f98;">${escapeHtml(content.footer)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background:#eef0f3;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef0f3;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <tr>
            <td>
              <p style="margin:0 0 20px;font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#8a8f98;">${escapeHtml(env.APP_NAME)}</p>
              <h1 style="margin:0 0 16px;font-size:20px;color:#111111;">${escapeHtml(content.heading)}</h1>
              ${paragraphs}
              ${codeBlock}
              ${footer}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Email-verification OTP mail (used by the auth OTP flow). */
export function verificationCodeEmail(to: string, code: string): Mail {
  return {
    to,
    subject: "Your verification code",
    text: `Your email verification code is ${code}. It expires in 10 minutes.`,
    html: renderEmailHtml({
      heading: "Verify your email",
      lines: ["Use this code to verify your email address:"],
      code,
      footer:
        "The code expires in 10 minutes. If you didn't request it, you can ignore this email.",
    }),
  };
}

/** Forgotten-password reset mail (used by the password-reset flow). */
export function passwordResetCodeEmail(to: string, code: string): Mail {
  return {
    to,
    subject: "Your password reset code",
    text: `Your password reset code is ${code}. It expires in 15 minutes. If you didn't request this, ignore this email.`,
    html: renderEmailHtml({
      heading: "Reset your password",
      lines: ["Use this code to reset your password:"],
      code,
      footer:
        "The code expires in 15 minutes. If you didn't request this, ignore this email — your password is unchanged.",
    }),
  };
}
