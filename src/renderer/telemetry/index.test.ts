import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import {
  initTelemetry,
  recordUiGesture,
  resolveOtlpUrl,
  resolveTelemetryEnabled,
  shutdownTelemetry,
} from "./index";

describe("resolveTelemetryEnabled", () => {
  it("defaults to on in development when env unset", () => {
    expect(resolveTelemetryEnabled({}, "development")).toBe(true);
  });

  it("defaults to off in production when env unset", () => {
    expect(resolveTelemetryEnabled({}, "production")).toBe(false);
  });

  it("honors VITE_OTEL_ENABLED=false", () => {
    expect(
      resolveTelemetryEnabled({ VITE_OTEL_ENABLED: "false" }, "development"),
    ).toBe(false);
  });

  it("honors VITE_OTEL_ENABLED=true in production", () => {
    expect(
      resolveTelemetryEnabled({ VITE_OTEL_ENABLED: "true" }, "production"),
    ).toBe(true);
  });
});

describe("resolveOtlpUrl", () => {
  it("resolves a relative path against the page origin", () => {
    expect(resolveOtlpUrl("/otlp/v1/traces", "http://localhost:5173")).toBe(
      "http://localhost:5173/otlp/v1/traces",
    );
  });

  it("keeps an absolute URL unchanged", () => {
    expect(
      resolveOtlpUrl("http://127.0.0.1:14318/v1/traces", "http://localhost:5173"),
    ).toBe("http://127.0.0.1:14318/v1/traces");
  });
});

describe("recordUiGesture", () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  it("emits a span named after the gesture when telemetry is on", async () => {
    const exporter = new InMemorySpanExporter();
    initTelemetry({
      enabled: true,
      serviceName: "wikilot",
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    recordUiGesture("ui.probe", { "wikilot.gesture": "probe" });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("ui.probe");
    expect(spans[0]?.attributes["wikilot.gesture"]).toBe("probe");
    expect(spans[0]?.resource.attributes["service.name"]).toBe("wikilot");
  });

  it("is a no-op when telemetry is off", async () => {
    const exporter = new InMemorySpanExporter();
    initTelemetry({
      enabled: false,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    recordUiGesture("ui.probe");

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
