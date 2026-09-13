import { describe, expect, it } from "vitest";
import {
  PROMPT_ENTRY_TYPE,
  normalizeStructuredPrompt,
  createPromptRecord,
  readPromptRecord,
  type StructuredPrompt,
} from "./prompt";

it("validates and preserves Prompt command identity in its Prompt record", () => {
  const prompt = normalizeStructuredPrompt({ workspaceId: "workspace", sessionId: "session", text: "/init", command: "init", clips: [] });
  expect(readPromptRecord(createPromptRecord(prompt))).toEqual({ version: 1, text: "/init", command: "init", clips: [] });
  expect(() => normalizeStructuredPrompt({ ...prompt, command: "unknown" })).toThrow("Invalid Prompt command");
  expect(() => normalizeStructuredPrompt({ ...prompt, text: "unrelated text" })).toThrow("Invalid Prompt command");
});

const clip = {
  source: { kind: "markdown" as const, path: "notes/plan.md" },
  text: "Rendered visible text",
  fingerprint: "sha256:source",
  locator: {
    kind: "markdown" as const,
    mode: "reading" as const,
    start: 4,
    end: 25,
    exact: "Rendered visible text",
    prefix: "The ",
    suffix: " after",
    lineStart: 2,
    lineEnd: 2,
    heading: "Plan",
  },
};

describe("structured Prompt contract", () => {
  it("normalizes a JSON-safe Prompt while preserving ordered immutable Clips", () => {
    const prompt: StructuredPrompt = {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      text: "  Compare these  ",
      clips: [clip, { ...clip, source: { ...clip.source, path: "notes/other.md" } }],
    };

    expect(normalizeStructuredPrompt(JSON.parse(JSON.stringify(prompt)))).toEqual({
      ...prompt,
      text: "Compare these",
    });
    expect(PROMPT_ENTRY_TYPE).toBe("wikilot.prompt");
  });

  it("normalizes a multi-page PDF Clip with page anchors and coordinate boxes", () => {
    const pdfClip = {
      source: { kind: "pdf", path: "references/paper.pdf" },
      text: "First selected line\nSecond selected line",
      fingerprint: "pdf:document-fingerprint",
      locator: {
        kind: "pdf",
        spans: [
          {
            page: 4,
            start: 12,
            end: 31,
            exact: "First selected line",
            prefix: "Before ",
            suffix: " after",
            boxes: [{ left: 0.1, top: 0.2, width: 0.6, height: 0.04 }],
          },
          {
            page: 5,
            start: 0,
            end: 20,
            exact: "Second selected line",
            prefix: "",
            suffix: " follows",
            boxes: [{ left: 0.12, top: 0.08, width: 0.55, height: 0.04 }],
          },
        ],
      },
    };

    expect(normalizeStructuredPrompt({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      text: "",
      clips: [pdfClip],
    }).clips[0]).toEqual(pdfClip);
  });

  it("allows a Clip-only Prompt and rejects unsafe paths and limits", () => {
    expect(normalizeStructuredPrompt({
      workspaceId: "w",
      sessionId: "s",
      text: "",
      clips: [clip],
    }).text).toBe("");

    expect(() => normalizeStructuredPrompt({
      workspaceId: "w",
      sessionId: "s",
      text: "",
      clips: [],
    })).toThrow(/text or at least one Context Clip/i);
    expect(() => normalizeStructuredPrompt({
      workspaceId: "w",
      sessionId: "s",
      text: "go",
      clips: [{ ...clip, source: { ...clip.source, path: "../secret.md" } }],
    })).toThrow(/source path/i);
    expect(() => normalizeStructuredPrompt({
      workspaceId: "w",
      sessionId: "s",
      text: "go",
      clips: [{ ...clip, source: { ...clip.source, path: `${"a".repeat(1_025)}.md` } }],
    })).toThrow(/source path may contain at most/i);
    expect(() => normalizeStructuredPrompt({
      workspaceId: "w",
      sessionId: "s",
      text: "go",
      clips: [{ ...clip, locator: { ...clip.locator, prefix: "x".repeat(257) } }],
    })).toThrow(/locator prefix may contain at most 256/i);
    expect(() => normalizeStructuredPrompt({
      workspaceId: "w",
      sessionId: "s",
      text: "go",
      clips: Array.from({ length: 21 }, () => clip),
    })).toThrow(/at most 20/i);
    expect(() => normalizeStructuredPrompt({
      workspaceId: "w",
      sessionId: "s",
      text: "go",
      clips: [{ ...clip, text: "😀".repeat(50_001), locator: { ...clip.locator, exact: "😀".repeat(50_001) } }],
    })).toThrow(/at most 50000/i);
    expect(() => normalizeStructuredPrompt({
      workspaceId: "w",
      sessionId: "s",
      text: "go",
      clips: Array.from({ length: 3 }, (_, index) => ({
        ...clip,
        source: { ...clip.source, path: `notes/${index}.md` },
        text: "😀".repeat(40_000),
        locator: { ...clip.locator, exact: "😀".repeat(40_000), end: 40_000 },
      })),
    })).toThrow(/at most 100000/i);
  });
});
