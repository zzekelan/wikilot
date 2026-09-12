import { describe, expect, it, vi } from "vitest";
import { PdfReadError, type RenderedPdfPages } from "./pdf-reader";
import { createReadPdfPageTool } from "./read-pdf-page-tool";

function contextWithInput(input: Array<"text" | "image">) {
  return { model: { input } } as unknown as Parameters<ReturnType<typeof createReadPdfPageTool>["execute"]>[4];
}

function rendered(): RenderedPdfPages {
  return {
    path: "references/paper.pdf",
    pageCount: 7, pages: [{ page: 2, width: 1224, height: 1584, png: new Uint8Array([137, 80, 78, 71]) }],
  };
}

describe("read_pdf_page Pi Tool adapter", () => {
  it("declares the strict fixed-fidelity input schema", () => {
    const schema = createReadPdfPageTool("/workspace", { render: vi.fn() }).parameters;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["path", "pages"],
      properties: {
        path: { type: "string", minLength: 1 },
        pages: { type: "array", minItems: 1, items: { type: "integer", minimum: 1 } },
        timeout_seconds: { type: "integer", minimum: 1, maximum: 600 },
      },
    });
  });

  it("returns exact text, compact details, and the PNG image block", async () => {
    const renderer = { render: vi.fn(async () => rendered()) };
    const tool = createReadPdfPageTool("/workspace", renderer);

    await expect(tool.execute(
      "call-1",
      { path: "references/./paper.pdf", pages: [2] },
      undefined,
      undefined,
      contextWithInput(["text", "image"]),
    )).resolves.toEqual({
      content: [
        {
          type: "text",
          text: "Image 1: Rendered references/paper.pdf page 2 of 7 at 1224×1584.",
        },
        { type: "image", data: "iVBORw==", mimeType: "image/png" },
      ],
      details: {
        path: "references/paper.pdf",
        pageCount: 7, pages: [{ page: 2, width: 1224, height: 1584 }],
      },
    });
    expect(renderer.render).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/workspace",
      path: "references/./paper.pdf",
      pages: [2],
      signal: expect.any(AbortSignal),
    }));
  });

  it("retains the image and appends Pi read's note for a text-only Model", async () => {
    const tool = createReadPdfPageTool("/workspace", { render: async () => rendered() });
    const result = await tool.execute(
      "call-2",
      { path: "references/paper.pdf", pages: [2] },
      undefined,
      undefined,
      contextWithInput(["text"]),
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Image 1: Rendered references/paper.pdf page 2 of 7 at 1224×1584.\n[Current model does not support images. The image will be omitted from this request.]",
      },
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    ]);
  });

  it("formats every stable failure without leaking lower-level exceptions", async () => {
    const codes = [
      "not_found",
      "not_pdf",
      "unsafe_path",
      "too_large",
      "unavailable",
      "source_changed",
      "encrypted",
      "invalid_pdf",
      "page_out_of_range",
      "timeout",
      "cancelled",
      "render_failed",
    ] as const;
    for (const code of codes) {
      const tool = createReadPdfPageTool("/workspace", {
        render: async () => {
          throw new PdfReadError(code, `${code} actionable message`);
        },
      });
      await expect(tool.execute(
        `call-${code}`,
        { path: "paper.pdf", pages: [1] },
        undefined,
        undefined,
        contextWithInput(["image"]),
      )).rejects.toThrow(`read_pdf_page error [${code}]: ${code} actionable message`);
    }

    const fallback = createReadPdfPageTool("/workspace", {
      render: async () => { throw new Error("private native exception"); },
    });
    await expect(fallback.execute(
      "call-fallback",
      { path: "paper.pdf", pages: [1] },
      undefined,
      undefined,
      contextWithInput(["image"]),
    )).rejects.toThrow(
      "read_pdf_page error [render_failed]: The PDF page could not be rendered; retry or choose another PDF.",
    );
  });

  it("combines Tool timeout and Turn cancellation while preserving their codes", async () => {
    vi.useFakeTimers();
    try {
      const waitForAbort = {
        render: ({ signal }: { signal: AbortSignal }) => new Promise<RenderedPdfPages>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      };
      const timeoutTool = createReadPdfPageTool("/workspace", waitForAbort);
      const timed = expect(timeoutTool.execute(
        "call-timeout",
        { path: "paper.pdf", pages: [1], timeout_seconds: 1 },
        undefined,
        undefined,
        contextWithInput(["image"]),
      )).rejects.toThrow("read_pdf_page error [timeout]");
      await vi.advanceTimersByTimeAsync(1_000);
      await timed;

      const turn = new AbortController();
      const cancelledTool = createReadPdfPageTool("/workspace", waitForAbort);
      const cancelled = cancelledTool.execute(
        "call-cancelled",
        { path: "paper.pdf", pages: [1] },
        turn.signal,
        undefined,
        contextWithInput(["image"]),
      );
      turn.abort();
      await expect(cancelled).rejects.toThrow("read_pdf_page error [cancelled]");
    } finally {
      vi.useRealTimers();
    }
  });
});
