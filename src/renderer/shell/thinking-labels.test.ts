import { describe, expect, it } from "vitest";
import { THINKING_LEVELS } from "../../shared/settings";
import { thinkingLevelLabel } from "./thinking-labels";

describe("thinkingLevelLabel", () => {
  it("labels every Thinking level with a display word", () => {
    for (const level of THINKING_LEVELS) {
      expect(thinkingLevelLabel(level)).toMatch(/^[A-Z]/u);
    }
  });

  it("spells out the compressed xhigh token", () => {
    expect(thinkingLevelLabel("xhigh")).toBe("Extra high");
  });
});
