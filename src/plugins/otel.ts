import { opentelemetry } from "@elysiajs/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Elysia } from "elysia";
import { env } from "@/config/env";

/**
 * Build the tracing plugin. Exported separately from the env-gated singleton
 * so tests can inject an in-memory span processor instead of a real OTLP
 * exporter.
 */
export function buildOtelPlugin(
  opts: { spanProcessors?: SpanProcessor[] } = {},
) {
  return opentelemetry({
    serviceName: env.OTEL_SERVICE_NAME,
    spanProcessors: opts.spanProcessors ?? [
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: `${env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
        }),
      ),
    ],
  });
}

/**
 * Distributed tracing (OpenTelemetry), opt-in via OTEL_ENABLED. Instruments
 * the request lifecycle and exports spans over OTLP/HTTP to
 * OTEL_EXPORTER_OTLP_ENDPOINT (a collector, Jaeger, Tempo, ...). When
 * disabled it's an inert named plugin, so app.ts can `.use()` it
 * unconditionally. The request logger picks up the active traceId either way.
 */
export const otelPlugin = env.OTEL_ENABLED
  ? buildOtelPlugin()
  : new Elysia({ name: "otel-disabled" });
