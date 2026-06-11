import { env } from "@/config/env";
import { logger } from "@/lib/logger";

export interface Alert {
  title: string;
  message: string;
  context?: Record<string, unknown>;
}

/**
 * Best-effort ops alert via webhook — a JSON POST that Slack/Discord/PagerDuty
 * style receivers understand (`text` carries the human-readable line; the raw
 * fields ride along for machine consumers). No-op when ALERT_WEBHOOK_URL is
 * unset. Never throws: alerting must not take down the caller — failures are
 * logged and reported via the boolean.
 */
export async function sendAlert(alert: Alert): Promise<boolean> {
  if (!env.ALERT_WEBHOOK_URL) return false;

  try {
    const res = await fetch(env.ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `[${env.NODE_ENV}] ${alert.title}: ${alert.message}`,
        ...alert,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      logger.error(
        { status: res.status, title: alert.title },
        "alert webhook returned non-2xx",
      );
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err, title: alert.title }, "failed to deliver alert");
    return false;
  }
}
