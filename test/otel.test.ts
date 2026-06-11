import { describe, expect, test } from "bun:test";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Elysia } from "elysia";
import { buildOtelPlugin } from "@/plugins/otel";

describe("opentelemetry plugin", () => {
  test("records a span for a handled request", async () => {
    const exporter = new InMemorySpanExporter();
    const app = new Elysia()
      .use(
        buildOtelPlugin({
          spanProcessors: [new SimpleSpanProcessor(exporter)],
        }),
      )
      .get("/ping", () => "ok");

    const res = await app.handle(new Request("http://localhost/ping"));
    expect(res.status).toBe(200);

    // Span end is async relative to the response — poll instead of trusting
    // a fixed delay (a cold first run can exceed any single guess).
    const deadline = Date.now() + 2000;
    while (exporter.getFinishedSpans().length === 0 && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    const dump = JSON.stringify(
      spans.map((s) => ({ name: s.name, attributes: s.attributes })),
    );
    expect(dump).toContain("ping");
  });
});
