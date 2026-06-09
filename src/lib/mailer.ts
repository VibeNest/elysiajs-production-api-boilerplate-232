import nodemailer from "nodemailer";
import { env, isProduction, isTest } from "../config/env";
import { logger } from "./logger";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

type Transport = (mail: Mail) => Promise<void>;

/**
 * Resolve the active transport:
 * - tests        → capture only (no network); read `outbox` to assert.
 * - "log"        → console (development default; swap for a logger if desired).
 * - "smtp"       → real SMTP via nodemailer (production default; Mailtrap-ready).
 * - "auto"       → log in development, smtp in production.
 * Falls back to "log" if smtp is selected without credentials.
 */
function resolveMode(): "capture" | "log" | "smtp" {
  if (isTest) return "capture";
  const mode =
    env.MAIL_TRANSPORT === "auto"
      ? isProduction
        ? "smtp"
        : "log"
      : env.MAIL_TRANSPORT;
  if (mode === "smtp" && (!env.SMTP_HOST || !env.SMTP_USER)) {
    logger.warn(
      "MAIL_TRANSPORT=smtp but SMTP_HOST/SMTP_USER missing — logging emails instead",
    );
    return "log";
  }
  return mode;
}

const mode = resolveMode();

const transporter =
  mode === "smtp"
    ? nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      })
    : null;

const transports: Record<"capture" | "log" | "smtp", Transport> = {
  capture: async () => {},
  log: async (mail) => {
    logger.info(
      {
        to: mail.to,
        subject: mail.subject,
        from: env.EMAIL_FROM,
        body: mail.text,
      },
      "email (log transport)",
    );
  },
  smtp: async (mail) => {
    await transporter?.sendMail({ from: env.EMAIL_FROM, ...mail });
  },
};

const transport = transports[mode];

/**
 * Recently sent mail, kept in memory for dev/test inspection (e.g. reading an
 * OTP code in tests via `lastTo`). Capped; not a delivery guarantee.
 */
export const outbox: Mail[] = [];
const OUTBOX_LIMIT = 50;

export const mailer = {
  async send(mail: Mail): Promise<void> {
    await transport(mail);
    outbox.push(mail);
    if (outbox.length > OUTBOX_LIMIT) outbox.shift();
  },

  /** Most recent mail sent to `to` (test/dev helper). */
  lastTo(to: string): Mail | undefined {
    for (let i = outbox.length - 1; i >= 0; i--) {
      if (outbox[i].to === to) return outbox[i];
    }
    return undefined;
  },
};
