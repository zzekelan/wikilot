import { describe, expect, it } from "vitest";
import {
  compactPath,
  formatToolDisplayName,
  normalizeToolName,
  toolPrimaryDetail,
} from "./tool-labels";

describe("normalizeToolName", () => {
  it("lowercases and strips separators", () => {
    expect(normalizeToolName("Read")).toBe("read");
    expect(normalizeToolName("web_search")).toBe("websearch");
    expect(normalizeToolName("WebFetch")).toBe("webfetch");
  });
});

describe("formatToolDisplayName", () => {
  it.each([
    ["read", "Read"],
    ["web_search", "WebSearch"],
    ["fetch_content", "FetchContent"],
    ["read_pdf_page", "ReadPdfPage"],
    ["custom-tool name", "CustomToolName"],
  ])("formats %s as one compact name", (name, expected) => {
    expect(formatToolDisplayName(name)).toBe(expected);
  });
});

describe("compactPath", () => {
  it("anchors on interesting roots like src/ or docs/", () => {
    expect(compactPath("/Users/a/project/src/main/foo.ts")).toBe("src/main/foo.ts");
    expect(compactPath("/x/y/docs/a/b.md")).toBe("docs/a/b.md");
  });

  it("keeps the last two segments when no anchor is near", () => {
    expect(compactPath("/Users/a/deep/nested/path/main/foo.ts")).toBe("main/foo.ts");
  });

  it("keeps short paths whole", () => {
    expect(compactPath("README.md")).toBe("README.md");
  });
});

describe("toolPrimaryDetail", () => {
  it("keeps file and command details separate from the name", () => {
    expect(toolPrimaryDetail("read", { path: "/a/b/src/foo.ts" })).toBe("src/foo.ts");
    expect(toolPrimaryDetail("shell", { command: "npm   test" })).toBe("npm test");
    expect(toolPrimaryDetail("read", {})).toBeUndefined();
  });
});
