import { describe, expect, test } from "bun:test";
import {
  passwordResetCodeEmail,
  renderEmailHtml,
  verificationCodeEmail,
} from "@/lib/mail-templates";
import { mailer } from "@/lib/mailer";
import { api, json, lastOtp, registerUser } from "./helpers";

describe("mail templates", () => {
  test("verification email carries the code in both text and HTML", () => {
    const mail = verificationCodeEmail("user@example.com", "123456");

    expect(mail.to).toBe("user@example.com");
    expect(mail.subject).toBe("Your verification code");
    expect(mail.text).toContain("123456");
    expect(mail.html).toContain("123456");
    expect(mail.html?.toLowerCase()).toContain("<!doctype html>");
  });

  test("password-reset email carries the code in both text and HTML", () => {
    const mail = passwordResetCodeEmail("user@example.com", "654321");

    expect(mail.subject).toBe("Your password reset code");
    expect(mail.text).toContain("654321");
    expect(mail.html).toContain("654321");
  });

  test("interpolated content is HTML-escaped", () => {
    const html = renderEmailHtml({
      heading: "Hi",
      lines: ["<script>alert(1)</script>"],
      code: "1<2",
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("1&lt;2");
  });
});

describe("emails sent by the auth flows include HTML", () => {
  test("request-otp sends an HTML body containing the code", async () => {
    const { email, accessToken } = await registerUser();
    await api("/auth/email/request-otp", {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const code = lastOtp(email);
    expect(code).toBeTruthy();
    expect(mailer.lastTo(email)?.html).toContain(code as string);
  });

  test("password-reset request sends an HTML body containing the code", async () => {
    const { email } = await registerUser();
    await json("/auth/password/request-reset", "POST", { email });

    const mail = mailer.lastTo(email);
    const code = mail?.text.match(/\b(\d{6})\b/)?.[1];
    expect(code).toBeTruthy();
    expect(mail?.html).toContain(code as string);
  });
});
