import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspacePdfAccess,
  WorkspacePdfAccessError,
} from "../workspace/workspace-pdf";
import {
  createPdfReader,
  createPdfReaderWithAdapters,
  PdfReadError,
} from "./pdf-reader";
import { onePageStandardFontPdf, readingPdf } from "./pdf-test-fixture";

function rejected(error: Error): Promise<never> {
  return Promise.reject(error);
}

describe("PDF page renderer", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function workspace() {
    const root = mkdtempSync(join(tmpdir(), "wikilot-pdf-renderer-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "paper.pdf"), "%PDF-1.7\nfixture");
    return { cwd, access: createWorkspacePdfAccess() };
  }

  function successfulAdapters() {
    const { cwd, access } = workspace();
    const cancel = vi.fn();
    const pageCleanup = vi.fn();
    const loadingDestroy = vi.fn(async () => {});
    const canvas = {
      width: 400,
      height: 600,
      encode: vi.fn(async () => Buffer.from([137, 80, 78, 71])),
    };
    const renderer = createPdfReaderWithAdapters({
      pdfAccess: access,
      open: () => ({
        promise: Promise.resolve({
          numPages: 3,
          getMetadata: vi.fn(), getOutline: vi.fn(), getDestination: vi.fn(), getPageIndex: vi.fn(),
          getPage: async () => ({
            getTextContent: vi.fn(),
            getViewport: () => ({ width: 399.2, height: 599.1 }),
            render: () => ({ promise: Promise.resolve(), cancel }),
            cleanup: pageCleanup,
          }),
        }),
        destroy: loadingDestroy,
      }),
      createCanvas: () => canvas,
    });
    return { cwd, renderer, cancel, pageCleanup, loadingDestroy, canvas };
  }

  it("renders a standard-font PDF through real PDF.js and Canvas", async () => {
    const { cwd } = workspace();
    writeFileSync(join(cwd, "paper.pdf"), onePageStandardFontPdf());

    const result = await createPdfReader().render({
      cwd,
      path: "paper.pdf",
      pages: [1],
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      path: "paper.pdf",
      pageCount: 1, pages: [{ page: 1, width: 1224, height: 1584 }],
    });
    expect(Buffer.from(result.pages[0]!.png.subarray(0, 8))).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  }, 30_000);

  it("renders exactly one scale-2 page and releases every render resource", async () => {
    const fixture = successfulAdapters();

    await expect(fixture.renderer.render({
      cwd: fixture.cwd,
      path: "./paper.pdf",
      pages: [2],
      signal: new AbortController().signal,
    })).resolves.toEqual({
      path: "paper.pdf",
      pageCount: 3, pages: [{ page: 2, width: 400, height: 600, png: new Uint8Array([137, 80, 78, 71]) }],
    });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.pageCleanup).toHaveBeenCalledOnce();
    expect(fixture.loadingDestroy).toHaveBeenCalledOnce();
    expect(fixture.canvas).toMatchObject({ width: 0, height: 0 });
  });

  it("reads real metadata, nested named bookmarks, ordered text and an empty page", async () => {
    const { cwd } = workspace();
    writeFileSync(join(cwd, "paper.pdf"), readingPdf());
    const reader = createPdfReader();
    const input = { cwd, path: "paper.pdf", signal: new AbortController().signal };
    const info = await reader.inspect(input);
    expect(info).toMatchObject({ path: "paper.pdf", pageCount: 3,
      metadata: { title: "Reading fixture", author: null, creator: "Wikilot tests", producer: null },
      outline: [
        { title: "Start", page: 1, target: "page", items: [{ title: "Chapter", page: 3, target: "page" }] },
        { title: "Broken", page: null, target: "unresolved" },
        { title: "External", page: null, target: "external", url: "https://example.com/" },
      ],
    });
    const text = await reader.readText({ ...input, pages: [3, 1, 2, 3] });
    expect(text.pages).toEqual([
      { page: 3, text: "Third page", status: "text" },
      { page: 1, text: "First page\nSecond line", status: "text" },
      { page: 2, text: "", status: "no_text" },
      { page: 3, text: "Third page", status: "text" },
    ]);
    const rendered = await reader.render({ ...input, pages: [3, 1] });
    expect(rendered.pages.map((page) => page.page)).toEqual([3, 1]);
    expect(rendered.pages[0]!.png).not.toEqual(rendered.pages[1]!.png);
  }, 30_000);

  it("reads XMP metadata including creator arrays and mixed-case XML field names", async () => {
    const { cwd } = workspace();
    writeFileSync(join(cwd, "paper.pdf"), readingPdf(true));
    const result = await createPdfReader().inspect({ cwd, path: "paper.pdf", signal: new AbortController().signal });
    expect(result.metadata).toMatchObject({ title: "XMP title", author: "Alice, Bob",
      creationDate: "2026-09-11T00:00:00Z", modificationDate: "2026-09-12T00:00:00Z",
      creator: "XMP creator", producer: "XMP producer" });
  });

  it("opens once for multiple pages and releases each page before closing the document", async () => {
    const fixture = successfulAdapters();
    const result = await fixture.renderer.render({ cwd: fixture.cwd, path: "paper.pdf", pages: [3, 1], signal: new AbortController().signal });
    expect(result.pages.map((page) => page.page)).toEqual([3, 1]);
    expect(fixture.pageCleanup).toHaveBeenCalledTimes(2);
    expect(fixture.loadingDestroy).toHaveBeenCalledOnce();
  });

  it("maps every Workspace access failure to the stable Tool taxonomy", async () => {
    const cases = [
      ["not-found", "not_found"],
      ["not-file", "not_pdf"],
      ["not-pdf", "not_pdf"],
      ["unsafe-path", "unsafe_path"],
      ["too-large", "too_large"],
      ["unavailable", "unavailable"],
      ["source-changed", "source_changed"],
    ] as const;
    for (const [workspaceCode, expected] of cases) {
      const access = createWorkspacePdfAccess();
      const inspect = vi.spyOn(access, "inspect").mockImplementation(() => {
        throw new WorkspacePdfAccessError(workspaceCode, "private lower-level text");
      });
      const renderer = createPdfReaderWithAdapters({
        pdfAccess: access,
        open: () => { throw new Error("not reached"); },
        createCanvas: () => { throw new Error("not reached"); },
      });
      await expect(renderer.render({
        cwd: "/workspace",
        path: "paper.pdf",
        pages: [1],
        signal: new AbortController().signal,
      })).rejects.toEqual(expect.objectContaining({ code: expected }));
      inspect.mockRestore();
    }
  });

  it("classifies encrypted, invalid, page-bound, and unclassified render failures", async () => {
    const cases = [
      [Object.assign(new Error("private password detail"), { name: "PasswordException" }), "encrypted"],
      [Object.assign(new Error("private parser detail"), { name: "InvalidPDFException" }), "invalid_pdf"],
      [new Error("private native detail"), "render_failed"],
    ] as const;
    for (const [failure, code] of cases) {
      const { cwd, access } = workspace();
      const destroy = vi.fn(async () => {});
      const renderer = createPdfReaderWithAdapters({
        pdfAccess: access,
        open: () => ({ promise: rejected(failure), destroy }),
        createCanvas: () => { throw new Error("not reached"); },
      });
      await expect(renderer.render({ cwd, path: "paper.pdf", pages: [1], signal: new AbortController().signal }))
        .rejects.toEqual(expect.objectContaining({ code }));
      expect(destroy).toHaveBeenCalledOnce();
    }

    const fixture = successfulAdapters();
    await expect(fixture.renderer.render({
      cwd: fixture.cwd,
      path: "paper.pdf",
      pages: [4],
      signal: new AbortController().signal,
    })).rejects.toEqual(expect.objectContaining({
      code: "page_out_of_range",
      message: "Requested page 4; valid pages are 1-3.",
    }));
    expect(fixture.loadingDestroy).toHaveBeenCalledOnce();
  });

  it("classifies a range failure that occurs after the PDF document loads", async () => {
    const { cwd, access } = workspace();
    let failRange: (error: Error) => void = () => {};
    const failure = new Promise<never>((_resolve, reject) => { failRange = reject; });
    const cancel = vi.fn();
    const cleanup = vi.fn();
    const destroy = vi.fn(async () => {});
    const renderer = createPdfReaderWithAdapters({
      pdfAccess: access,
      open: () => ({
        promise: Promise.resolve({
          numPages: 1,
          getMetadata: vi.fn(), getOutline: vi.fn(), getDestination: vi.fn(), getPageIndex: vi.fn(),
          getPage: async () => ({
            getTextContent: vi.fn(),
            getViewport: () => ({ width: 100, height: 100 }),
            render: () => ({ promise: new Promise<void>(() => {}), cancel }),
            cleanup,
          }),
        }),
        failure,
        destroy,
      }),
      createCanvas: (width, height) => ({
        width,
        height,
        encode: async () => Buffer.alloc(0),
      }),
    });

    const pending = renderer.render({
      cwd,
      path: "paper.pdf",
      pages: [1],
      signal: new AbortController().signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    failRange(new WorkspacePdfAccessError("source-changed", "private path"));

    await expect(pending).rejects.toEqual(expect.objectContaining({ code: "source_changed" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("preserves cancellation and timeout while cancelling render and awaiting cleanup", async () => {
    for (const code of ["cancelled", "timeout"] as const) {
      const { cwd, access } = workspace();
      const controller = new AbortController();
      const cancel = vi.fn();
      const cleanup = vi.fn();
      const destroy = vi.fn(async () => {});
      const renderer = createPdfReaderWithAdapters({
        pdfAccess: access,
        open: () => ({
          promise: Promise.resolve({
            numPages: 1,
          getMetadata: vi.fn(), getOutline: vi.fn(), getDestination: vi.fn(), getPageIndex: vi.fn(),
            getPage: async () => ({
              getTextContent: vi.fn(),
            getViewport: () => ({ width: 100, height: 100 }),
              render: () => ({ promise: new Promise<void>(() => {}), cancel }),
              cleanup,
            }),
          }),
          destroy,
        }),
        createCanvas: (width, height) => ({
          width,
          height,
          encode: async () => Buffer.alloc(0),
        }),
      });
      const pending = renderer.render({ cwd, path: "paper.pdf", pages: [1], signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 0));
      controller.abort(new PdfReadError(code, `${code} action`));
      await expect(pending).rejects.toEqual(expect.objectContaining({ code }));
      expect(cancel).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(destroy).toHaveBeenCalledOnce();
    }
  });
});
