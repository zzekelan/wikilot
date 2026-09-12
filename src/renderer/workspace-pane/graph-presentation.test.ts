import { describe, expect, it } from "vitest";
import { graphEdgeFocus, graphNodeFocus, mixGraphColor } from "./graph-presentation";

describe("Graph presentation", () => {
  it("forms a one-hop Graph Focus around the hovered node", () => {
    expect(graphNodeFocus("hovered.md", "hovered.md", false)).toBe("hovered");
    expect(graphNodeFocus("neighbor.md", "hovered.md", true)).toBe("neighbor");
    expect(graphNodeFocus("background.md", "hovered.md", false)).toBe("background");
    expect(graphNodeFocus("idle.md", null, false)).toBe("idle");
  });

  it("focuses only edges incident to the hovered node", () => {
    expect(graphEdgeFocus("hovered.md", "hovered.md", "neighbor.md")).toBe("focused");
    expect(graphEdgeFocus("hovered.md", "other.md", "neighbor.md")).toBe("background");
    expect(graphEdgeFocus(null, "other.md", "neighbor.md")).toBe("idle");
  });

  it("interpolates opaque and translucent Graph colors", () => {
    expect(mixGraphColor("#000000", "#ffffff80", 0)).toBe("rgba(0, 0, 0, 1.000)");
    expect(mixGraphColor("#000000", "#ffffff80", 0.5)).toBe("rgba(128, 128, 128, 0.751)");
    expect(mixGraphColor("#000000", "#ffffff80", 1)).toBe("rgba(255, 255, 255, 0.502)");
    expect(mixGraphColor("#000000", "rgba(200, 200, 200, 1.000)", 0.5)).toBe("rgba(100, 100, 100, 1.000)");
  });
});
