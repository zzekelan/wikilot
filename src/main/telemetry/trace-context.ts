import type { SpanContext } from "@opentelemetry/api";

/**
 * W3C traceparent serialization for cross-process trace context: the Host's
 * session.prompt span context travels to the Session Worker as a string so
 * Worker model/tool spans join the same trace.
 */

const VERSION = "00";
const SAMPLED = "01";

function isHex(value: string, length: number): boolean {
  return (
    value.length === length &&
    /^[0-9a-f]+$/.test(value) &&
    !/^0+$/.test(value)
  );
}

/** Serialize a span context as a W3C traceparent string (always sampled). */
export function formatTraceparent(spanContext: SpanContext): string {
  return `${VERSION}-${spanContext.traceId}-${spanContext.spanId}-${SAMPLED}`;
}

/** Parse a W3C traceparent string back into a remote span context. */
export function parseTraceparent(raw: string): SpanContext | undefined {
  const parts = raw.trim().split("-");
  if (parts.length !== 4) return undefined;
  const [, traceId, spanId, flags] = parts;
  if (!traceId || !spanId || flags === undefined) return undefined;
  if (!isHex(traceId, 32) || !isHex(spanId, 16)) return undefined;
  if (!/^[0-9a-f]{2}$/.test(flags)) return undefined;
  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16),
    isRemote: true,
  };
}
