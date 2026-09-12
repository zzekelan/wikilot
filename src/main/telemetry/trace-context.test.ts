import { describe, expect, it } from "vitest";
import { formatTraceparent, parseTraceparent } from "./trace-context";

const spanContext = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  traceFlags: 1,
};

describe("traceparent round trip", () => {
  it("formats a span context as a sampled W3C traceparent", () => {
    expect(formatTraceparent(spanContext)).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
  });

  it("parses a traceparent back into a remote span context", () => {
    expect(
      parseTraceparent(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      ),
    ).toEqual({ ...spanContext, isRemote: true });
  });

  it("preserves the sampled flag from the input", () => {
    const parsed = parseTraceparent(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00",
    );
    expect(parsed?.traceFlags).toBe(0);
  });

  it("rejects malformed traceparents", () => {
    expect(parseTraceparent("")).toBeUndefined();
    expect(parseTraceparent("garbage")).toBeUndefined();
    expect(
      parseTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7"),
    ).toBeUndefined();
    // All-zero ids are invalid per the W3C spec.
    expect(
      parseTraceparent(
        "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      ),
    ).toBeUndefined();
    expect(
      parseTraceparent(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      ),
    ).toBeUndefined();
    // Non-hex ids are invalid.
    expect(
      parseTraceparent(
        "00-zzf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      ),
    ).toBeUndefined();
  });
});
