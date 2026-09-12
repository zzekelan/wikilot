import { trace, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { WebTracerProvider } from "@opentelemetry/sdk-trace-web";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export const DEFAULT_SERVICE_NAME = "wikilot";
export const DEFAULT_OTLP_PATH = "/otlp/v1/traces";

export type TelemetryEnv = {
  VITE_OTEL_ENABLED?: string;
};

export type InitTelemetryOptions = {
  enabled?: boolean;
  serviceName?: string;
  otlpUrl?: string;
  /** Injected processor (tests / custom exporters). When set, skips default OTLP. */
  spanProcessor?: SpanProcessor;
};

let provider: WebTracerProvider | undefined;
let tracer: Tracer | undefined;
let enabled = false;

/**
 * Dev/acceptance default on; production/release default off.
 * Explicit VITE_OTEL_ENABLED=true|false always wins.
 */
export function resolveTelemetryEnabled(
  env: TelemetryEnv,
  mode: string,
): boolean {
  const raw = env.VITE_OTEL_ENABLED?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off") return false;
  if (raw === "true" || raw === "1" || raw === "on") return true;
  return mode !== "production";
}

/** OTLP HTTP exporters require an absolute URL in the browser. */
export function resolveOtlpUrl(
  configured: string | undefined,
  origin: string,
): string {
  const raw = (configured ?? DEFAULT_OTLP_PATH).trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  return new URL(raw, origin).href;
}

export function initTelemetry(options: InitTelemetryOptions = {}): {
  enabled: boolean;
} {
  if (provider) {
    return { enabled };
  }

  enabled = options.enabled ?? true;
  if (!enabled) {
    return { enabled: false };
  }

  try {
    const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
    const resource = new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
    });

    const origin =
      typeof globalThis.location?.origin === "string"
        ? globalThis.location.origin
        : "http://localhost:5173";

    const processor =
      options.spanProcessor ??
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: resolveOtlpUrl(options.otlpUrl, origin),
        }),
      );

    provider = new WebTracerProvider({
      resource,
      spanProcessors: [processor],
    });
    provider.register();
    tracer = trace.getTracer("wikilot-desktop-shell");
    return { enabled: true };
  } catch (err) {
    enabled = false;
    provider = undefined;
    tracer = undefined;
    console.error("telemetry init failed; continuing without export", err);
    return { enabled: false };
  }
}

/** Record a short App UI gesture span (acceptance probe / shell actions). */
export function recordUiGesture(
  name: string,
  attributes: Record<string, string> = {},
): void {
  if (!enabled || !tracer) return;
  const span = tracer.startSpan(name);
  const acceptanceRunId = import.meta.env.VITE_WIKILOT_ACCEPTANCE_RUN_ID?.trim();
  if (acceptanceRunId) {
    span.setAttribute("wikilot.acceptance.run_id", acceptanceRunId);
  }
  for (const [key, value] of Object.entries(attributes)) {
    span.setAttribute(key, value);
  }
  span.end();
  // Flush promptly so coding-agent Jaeger checks see the span after a UI click.
  void provider?.forceFlush();
}

export async function shutdownTelemetry(): Promise<void> {
  const current = provider;
  provider = undefined;
  tracer = undefined;
  enabled = false;
  if (current) {
    await current.shutdown();
  }
}
