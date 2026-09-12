import { describe, expect, it } from "vitest";
import { resolveCaptureContent } from "./capture-content";

describe("resolveCaptureContent", () => {
  it("defaults to metadata", () => {
    expect(resolveCaptureContent({})).toBe("metadata");
  });

  it("enables full capture when WIKILOT_CAPTURE_CONTENT=full", () => {
    expect(resolveCaptureContent({ WIKILOT_CAPTURE_CONTENT: "full" })).toBe(
      "full",
    );
    expect(resolveCaptureContent({ WIKILOT_CAPTURE_CONTENT: " FULL " })).toBe(
      "full",
    );
  });
});
