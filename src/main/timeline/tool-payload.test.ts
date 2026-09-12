import { describe, expect, it } from "vitest";
import { projectTimelineToolResult } from "./tool-payload";

describe("projectTimelineToolResult", () => {
  it("projects multiple text and image blocks without carrying image bytes", () => {
    const projected = projectTimelineToolResult({
      toolCallId: "call-1",
      toolName: "other_tool",
      result: {
        content: [
          { type: "text", text: "first" },
          { type: "image", data: "secret-base64-one", mimeType: "image/png" },
          { type: "text", text: "second" },
          { type: "image", data: "secret-base64-two", mimeType: "image/jpeg" },
        ],
        details: { copied: "must not cross" },
      },
    });

    expect(projected).toEqual({
      text: "first\nsecond",
      images: [
        {
          imageRef: "timeline-image:v1:rabBA-7V04eeYNcAg_q9df8KEVtsxfdVK0RVh74qFUg",
          mimeType: "image/png",
        },
        {
          imageRef: "timeline-image:v1:1LT3ySJ8-EWTbfeYVmxUAi3Bwu9_oKroO2xqWfKkfk8",
          mimeType: "image/jpeg",
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toMatch(/secret-base64|copied|data/);
  });

  it("projects valid PDF page metadata only for read_pdf_page", () => {
    const result = {
      content: [{ type: "text", text: "Rendered paper.pdf page 2." }],
      details: {
        path: "papers/paper.pdf",
        pageCount: 8, pages: [{ page: 2, width: 1224, height: 1584 }],
        privateValue: "drop me",
      },
    };

    expect(
      projectTimelineToolResult({
        toolCallId: "pdf-1",
        toolName: "read_pdf_page",
        result,
      }),
    ).toEqual({
      text: "Rendered paper.pdf page 2.",
      metadata: {
        kind: "pdf_pages",
        path: "papers/paper.pdf",
        pageCount: 8, pages: [{ page: 2, width: 1224, height: 1584 }],
      },
    });
    expect(
      projectTimelineToolResult({
        toolCallId: "pdf-1",
        toolName: "another_tool",
        result,
      }),
    ).toEqual({ text: "Rendered paper.pdf page 2." });
  });

  it("omits malformed images and PDF metadata", () => {
    expect(
      projectTimelineToolResult({
        toolCallId: "bad",
        toolName: "read_pdf_page",
        result: {
          content: [
            { type: "image", data: { type: "Buffer", data: [1, 2] }, mimeType: "image/png" },
            { type: "image", data: "bytes", mimeType: 42 },
            { type: "image", data: "bytes", mimeType: "not-an-image" },
            { type: "text", text: 42 },
          ],
          details: {
            path: "paper.pdf",
            pageCount: 8, pages: [{ page: 9, width: 100, height: 100 }],
          },
        },
      }),
    ).toEqual({});
  });

  it("degrades unknown shapes to safe text or omission", () => {
    expect(
      projectTimelineToolResult({
        toolCallId: "c1",
        toolName: "bash",
        result: { output: "command output", bytes: "must not cross" },
      }),
    ).toEqual({ text: "command output" });
    expect(
      projectTimelineToolResult({
        toolCallId: "c1",
        toolName: "unknown",
        result: { data: "unclassified-base64", nested: { secret: true } },
      }),
    ).toEqual({});
    expect(
      projectTimelineToolResult({ toolCallId: "c1", toolName: "unknown", result: 42 }),
    ).toEqual({ text: "42" });
    expect(
      projectTimelineToolResult({ toolCallId: "c1", toolName: "unknown", result: undefined }),
    ).toBeUndefined();
  });

  it("creates stable references from the Tool call id and image ordinal", () => {
    const input = {
      toolCallId: "stable-call",
      toolName: "vision",
      result: {
        content: [{ type: "image", data: "different persisted bytes", mimeType: "image/webp" }],
      },
    };
    expect(projectTimelineToolResult(input)).toEqual(projectTimelineToolResult(input));
    expect(projectTimelineToolResult(input)?.images?.[0]?.imageRef).toBe(
      projectTimelineToolResult({
        ...input,
        result: {
          content: [{ type: "image", data: "changed bytes", mimeType: "image/webp" }],
        },
      })?.images?.[0]?.imageRef,
    );
    expect(
      projectTimelineToolResult({
        ...input,
        result: {
          content: [
            { type: "image", data: { malformed: true }, mimeType: "image/png" },
            { type: "image", data: "valid", mimeType: "image/png" },
          ],
        },
      })?.images?.[0]?.imageRef,
    ).toBe("timeline-image:v1:FdUYnY1YApYuE24WGRxOSN2_WoAp6SkhSrZqV4nqNoE");
  });
});
