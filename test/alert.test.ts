import { afterEach, describe, expect, mock, test } from "bun:test";
import { sendAlert } from "@/lib/alert";
import { handleJobFailure } from "@/queue/runtime";
import { setEnv } from "./helpers";

const originalFetch = globalThis.fetch;
let restoreEnv: (() => void) | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv?.();
  restoreEnv = undefined;
});

/** Replace global fetch with a mock; returns it for call assertions. */
function stubFetch(
  impl?: (url: string, init: RequestInit) => Promise<Response>,
) {
  const fetchMock = mock(
    impl ??
      (async (_url: string, _init: RequestInit) =>
        new Response("ok", { status: 200 })),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe("sendAlert", () => {
  test("is a no-op when ALERT_WEBHOOK_URL is unset", async () => {
    const fetchMock = stubFetch();

    const sent = await sendAlert({ title: "t", message: "m" });

    expect(sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("POSTs the alert as JSON to the webhook", async () => {
    restoreEnv = setEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/ops");
    const fetchMock = stubFetch();

    const sent = await sendAlert({
      title: "queue job failed",
      message: "email job 42 permanently failed",
      context: { queue: "email", jobId: "42" },
    });

    expect(sent).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.example.test/ops");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    const payload = JSON.parse(init.body as string);
    expect(payload.title).toBe("queue job failed");
    expect(payload.text).toContain("queue job failed");
    expect(payload.context.jobId).toBe("42");
  });

  test("resolves false instead of throwing when the webhook is unreachable", async () => {
    restoreEnv = setEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/ops");
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(sendAlert({ title: "t", message: "m" })).resolves.toBe(false);
  });

  test("resolves false on a non-2xx webhook response", async () => {
    restoreEnv = setEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/ops");
    stubFetch(async () => new Response("nope", { status: 500 }));

    await expect(sendAlert({ title: "t", message: "m" })).resolves.toBe(false);
  });
});

describe("handleJobFailure", () => {
  test("does not alert while the job still has retries left", async () => {
    restoreEnv = setEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/ops");
    const fetchMock = stubFetch();

    await handleJobFailure(
      "email",
      { id: "42", attemptsMade: 1, opts: { attempts: 3 } },
      new Error("smtp down"),
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("alerts once the job has exhausted its attempts", async () => {
    restoreEnv = setEnv("ALERT_WEBHOOK_URL", "https://hooks.example.test/ops");
    const fetchMock = stubFetch();

    await handleJobFailure(
      "email",
      { id: "42", attemptsMade: 3, opts: { attempts: 3 } },
      new Error("smtp down"),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const payload = JSON.parse(init.body as string);
    expect(payload.text).toContain("email");
    expect(payload.context.jobId).toBe("42");
  });
});
