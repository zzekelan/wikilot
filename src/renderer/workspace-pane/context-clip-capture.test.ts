// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { MarkdownContextClip } from "../../shared/session";
import {
  buildMarkdownEditingClip,
  buildMarkdownReadingClip,
  locateMarkdownClip,
} from "./context-clip-capture";

describe("Markdown reading Context Clip capture", () => {
  it("captures rendered visible text with a source fingerprint and final locator", () => {
    const surface = document.createElement("article");
    surface.innerHTML = "<h2>Plan</h2><p>Read <strong>this visible passage</strong> today.</p>";
    const textNode = surface.querySelector("strong")!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, "this visible passage".length);

    expect(buildMarkdownReadingClip(
      "notes/plan.md",
      "## Plan\n\nRead **this visible passage** today.\n",
      surface,
      range,
    )).toEqual(expect.objectContaining({
      source: { kind: "markdown", path: "notes/plan.md" },
      text: "this visible passage",
      fingerprint: expect.stringMatching(/^fnv1a:/),
      locator: expect.objectContaining({
        kind: "markdown",
        mode: "reading",
        exact: "this visible passage",
        prefix: expect.stringContaining("Read "),
        suffix: expect.stringContaining(" today."),
        lineStart: 3,
        lineEnd: 3,
        heading: "Plan",
      }),
    }));
  });

  it("preserves a visible separator across rendered block boundaries", () => {
    const surface = document.createElement("article");
    surface.innerHTML = "<h2>Plan</h2><p>First paragraph</p>";
    const heading = surface.querySelector("h2")!.firstChild!;
    const paragraph = surface.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(heading, 0);
    range.setEnd(paragraph, "First paragraph".length);

    const clip = buildMarkdownReadingClip(
      "plan.md",
      "## Plan\n\nFirst paragraph\n",
      surface,
      range,
    );
    expect(clip?.text).toBe("Plan First paragraph");
    expect(clip?.locator.exact).toBe("Plan First paragraph");
  });

  it("adjusts normalized offsets when boundary whitespace is trimmed", () => {
    const surface = document.createElement("article");
    surface.innerHTML = "<p>Read <strong>this passage</strong> today.</p>";
    const before = surface.querySelector("p")!.firstChild!;
    const after = surface.querySelector("p")!.lastChild!;
    const range = document.createRange();
    range.setStart(before, "Read".length);
    range.setEnd(after, 1);

    const clip = buildMarkdownReadingClip(
      "plan.md",
      "Read **this passage** today.\n",
      surface,
      range,
    );
    expect(clip?.text).toBe("this passage");
    expect(clip?.locator).toMatchObject({ start: "Read ".length, end: "Read this passage".length });
  });

  it("captures the raw CodeMirror Markdown selection in editing mode", () => {
    const source = "## Plan\n\nRead **this passage** today.\n";
    const start = source.indexOf("**this passage**");
    expect(buildMarkdownEditingClip(
      "notes/plan.md",
      source,
      start,
      start + "**this passage**".length,
    )).toEqual(expect.objectContaining({
      text: "**this passage**",
      locator: expect.objectContaining({
        kind: "markdown",
        mode: "editing",
        start,
        end: start + "**this passage**".length,
        exact: "**this passage**",
        lineStart: 3,
        lineEnd: 3,
        heading: "Plan",
      }),
    }));
  });

  it("relocates duplicated exact text when one surviving anchor is unique", () => {
    const clip: MarkdownContextClip = {
      source: { kind: "markdown", path: "plan.md" },
      text: "target",
      fingerprint: "old",
      locator: {
        kind: "markdown",
        mode: "editing",
        start: 6,
        end: 12,
        exact: "target",
        prefix: "first ",
        suffix: " old suffix",
      },
    };
    expect(locateMarkdownClip(
      clip,
      "new",
      "first target changed suffix; second target changed too",
    )).toEqual({ status: "relocated", start: 6, end: 12 });
  });

  it("rejects empty and out-of-surface selections", () => {
    const surface = document.createElement("article");
    surface.textContent = "Visible";
    const outside = document.createTextNode("Outside");
    const range = document.createRange();
    range.selectNodeContents(outside);
    expect(buildMarkdownReadingClip("a.md", "Visible", surface, range)).toBeNull();
  });
});
