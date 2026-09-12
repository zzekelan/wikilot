import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import type { Canvas } from "@napi-rs/canvas";
import {
  createWorkspacePdfAccess,
  WorkspacePdfAccessError,
  type WorkspacePdfAccess,
  type WorkspacePdfFile,
} from "../workspace/workspace-pdf.ts";

export type PdfReadErrorCode =
  | "not_found"
  | "not_pdf"
  | "unsafe_path"
  | "too_large"
  | "unavailable"
  | "source_changed"
  | "encrypted"
  | "invalid_pdf"
  | "page_out_of_range"
  | "timeout"
  | "cancelled"
  | "render_failed"
  | "read_failed";

export class PdfReadError extends Error {
  readonly code: PdfReadErrorCode;

  constructor(code: PdfReadErrorCode, message: string) {
    super(message);
    this.name = "PdfReadError";
    this.code = code;
  }
}

export type RenderedPdfPage = {
  page: number;
  width: number;
  height: number;
  png: Uint8Array;
};

type PdfViewport = { width: number; height: number };
type PdfRenderTask = { promise: Promise<void>; cancel(): void };
type PdfPage = {
  getViewport(options: { scale: number }): PdfViewport;
  render(canvas: PdfCanvas, viewport: PdfViewport): PdfRenderTask;
  getTextContent(): Promise<{ items: Array<{ str: string; hasEOL: boolean } | { type: string }> }>;
  cleanup(): void;
};
type OutlineItem = { title: string; dest: string | unknown[] | null; url?: string | null; items: OutlineItem[] };
type PdfDocument = {
  numPages: number;
  getPage(page: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info: unknown; metadata: { get(name: string): unknown } | null }>;
  getOutline(): Promise<OutlineItem[] | null>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: { num: number; gen: number }): Promise<number>;
};
export type PdfOutlineEntry = {
  title: string;
  page: number | null;
  target: "page" | "external" | "unresolved";
  url: string | null;
  items: PdfOutlineEntry[];
};
export type PdfInfo = {
  path: string;
  pageCount: number;
  metadata: Record<"title" | "author" | "subject" | "keywords" | "creationDate" | "modificationDate" | "creator" | "producer", string | null>;
  outline: PdfOutlineEntry[];
};
export type PdfText = {
  path: string;
  pageCount: number;
  pages: Array<{ page: number; text: string; status: "text" | "no_text" }>;
};
export type RenderedPdfPages = { path: string; pageCount: number; pages: RenderedPdfPage[] };
type PdfInput = { cwd: string; path: string; signal: AbortSignal };
type PdfPagesInput = PdfInput & { pages: number[] };
type Wait = <T>(operation: Promise<T>) => Promise<T>;
type PdfLoadingTask = {
  promise: Promise<PdfDocument>;
  failure?: Promise<never>;
  destroy(): Promise<void>;
};
type PdfCanvas = {
  width: number;
  height: number;
  encode(format: "png"): Promise<Buffer>;
};

type PdfReaderAdapters = {
  pdfAccess: WorkspacePdfAccess;
  open(file: WorkspacePdfFile, signal: AbortSignal): PdfLoadingTask;
  createCanvas(width: number, height: number): PdfCanvas;
};

function abortError(signal: AbortSignal): PdfReadError {
  if (signal.reason instanceof PdfReadError) return signal.reason;
  return new PdfReadError("cancelled", "Turn cancellation stopped the invocation.");
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function mapWorkspaceError(error: WorkspacePdfAccessError): PdfReadError {
  switch (error.code) {
    case "not-found":
      return new PdfReadError("not_found", "The PDF was not found; check the path.");
    case "not-file":
    case "not-pdf":
      return new PdfReadError("not_pdf", "The target is not an ordinary PDF file; choose a PDF.");
    case "unsafe-path":
      return new PdfReadError("unsafe_path", "Use a safe Workspace-relative path that does not traverse symlinks.");
    case "too-large":
      return new PdfReadError("too_large", "The PDF exceeds the Workspace PDF size limit.");
    case "source-changed":
      return new PdfReadError("source_changed", "The PDF changed during processing; invoke the Tool again.");
    case "unavailable":
      return new PdfReadError("unavailable", "The PDF cannot be read; check permissions and try again.");
  }
}

function classifyError(error: unknown, signal: AbortSignal, rendering: boolean): PdfReadError {
  if (signal.aborted) return abortError(signal);
  if (error instanceof PdfReadError) return error;
  if (error instanceof WorkspacePdfAccessError) return mapWorkspaceError(error);
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") {
    return new PdfReadError("encrypted", "The PDF requires a password; this Tool does not accept one.");
  }
  if (name === "InvalidPDFException" || name === "MissingPDFException" || name === "UnexpectedResponseException") {
    return new PdfReadError("invalid_pdf", "The PDF is damaged, truncated, or cannot be parsed; choose another PDF.");
  }
  return rendering
    ? new PdfReadError("render_failed", "The PDF page could not be rendered; retry or choose another PDF.")
    : new PdfReadError("read_failed", "The PDF could not be read; retry or choose another PDF.");
}

const require = createRequire(import.meta.url);
const STANDARD_FONT_DATA_URL = `${join(
  dirname(require.resolve("pdfjs-dist/package.json")),
  "standard_fonts",
)}${sep}`;
const RANGE_CHUNK_SIZE = 64 * 1024;

async function openWithPdfJs(
  pdfAccess: WorkspacePdfAccess,
  file: WorkspacePdfFile,
  signal: AbortSignal,
): Promise<PdfLoadingTask> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  let rejectRangeFailure: (error: unknown) => void = () => {};
  const rangeFailure = new Promise<never>((_resolve, reject) => {
    rejectRangeFailure = reject;
  });

  class WorkspaceRangeTransport extends pdfjs.PDFDataRangeTransport {
    readonly controller = new AbortController();
    readonly pending = new Set<Promise<void>>();

    requestDataRange(begin: number, end: number): void {
      const read = pdfAccess.readRange(
        file,
        begin,
        end - 1,
        this.controller.signal,
      ).then(
        ({ bytes }) => { this.onDataRange(begin, bytes); },
        (error: unknown) => {
          if (!this.controller.signal.aborted) rejectRangeFailure(error);
        },
      ).finally(() => { this.pending.delete(read); });
      this.pending.add(read);
    }

    abort(): void {
      if (!this.controller.signal.aborted) this.controller.abort();
    }

    async settle(): Promise<void> {
      while (this.pending.size > 0) {
        await Promise.allSettled([...this.pending]);
      }
    }
  }

  const range = new WorkspaceRangeTransport(file.size, null);
  const onInvocationAbort = () => range.controller.abort(signal.reason);
  if (signal.aborted) onInvocationAbort();
  else signal.addEventListener("abort", onInvocationAbort, { once: true });
  range.transportReady();
  const loadingTask = pdfjs.getDocument({
    range,
    length: file.size,
    rangeChunkSize: RANGE_CHUNK_SIZE,
    disableStream: true,
    disableAutoFetch: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    cMapUrl: `${join(dirname(require.resolve("pdfjs-dist/package.json")), "cmaps")}${sep}`,
    cMapPacked: true,
  });
  return {
    promise: loadingTask.promise.then((document) => ({
      numPages: document.numPages,
      getMetadata: () => document.getMetadata(),
      getOutline: () => document.getOutline(),
      getDestination: (name) => document.getDestination(name),
      getPageIndex: (ref) => document.getPageIndex(ref),
      async getPage(pageNumber: number): Promise<PdfPage> {
        const page = await document.getPage(pageNumber);
        return {
          getViewport: (options) => page.getViewport(options),
          render(canvas, viewport) {
            const napiCanvas = canvas as Canvas;
            const task = page.render({
              canvas: napiCanvas,
              canvasContext: napiCanvas.getContext("2d"),
              viewport: viewport as ReturnType<typeof page.getViewport>,
            });
            return { promise: task.promise, cancel: () => task.cancel() };
          },
          getTextContent: () => page.getTextContent(),
          cleanup: () => { page.cleanup(); },
        };
      },
    })),
    failure: rangeFailure,
    destroy: async () => {
      signal.removeEventListener("abort", onInvocationAbort);
      range.abort();
      await Promise.allSettled([
        loadingTask.destroy(),
        range.settle(),
      ]);
    },
  };
}

const DEFAULT_ADAPTERS: PdfReaderAdapters = {
  pdfAccess: createWorkspacePdfAccess(),
  open(file, signal) {
    const opened = openWithPdfJs(DEFAULT_ADAPTERS.pdfAccess, file, signal);
    return {
      promise: opened.then((task) => task.promise),
      failure: opened.then((task) => task.failure ?? new Promise<never>(() => {})),
      destroy: async () => {
        const task = await opened.catch(() => undefined);
        await task?.destroy();
      },
    };
  },
  createCanvas(width, height) {
    const canvas = require("@napi-rs/canvas") as typeof import("@napi-rs/canvas");
    return canvas.createCanvas(width, height);
  },
};

export function createPdfReader() {
  return createPdfReaderWithAdapters(DEFAULT_ADAPTERS);
}

/** Internal adapter seam for PDF.js lifecycle verification. */
export function createPdfReaderWithAdapters(adapters: PdfReaderAdapters) {
  async function withDocument<T>(
    input: PdfInput,
    operation: (document: PdfDocument, wait: Wait, path: string) => Promise<T>,
    rendering = false,
  ): Promise<T> {
    let loadingTask: PdfLoadingTask | undefined;
    try {
      input.signal.throwIfAborted();
      const file = adapters.pdfAccess.inspect(input.cwd, input.path);
      loadingTask = adapters.open(file, input.signal);
      const wait: Wait = (promise) => raceAbort(
        loadingTask?.failure ? Promise.race([promise, loadingTask.failure]) : promise,
        input.signal,
      );
      const document = await wait(loadingTask.promise);
      const result = await operation(document, wait, file.path);
      input.signal.throwIfAborted();
      adapters.pdfAccess.validate(file);
      return result;
    } catch (error) {
      throw classifyError(error, input.signal, rendering);
    } finally {
      await loadingTask?.destroy().catch(() => {});
    }
  }

  function checkPages(pages: number[], pageCount: number) {
    for (const page of pages) {
      if (!Number.isInteger(page) || page < 1 || page > pageCount) {
        throw new PdfReadError("page_out_of_range", `Requested page ${page}; valid pages are 1-${pageCount}.`);
      }
    }
  }

  return {
    inspect(input: PdfInput): Promise<PdfInfo> {
      return withDocument(input, async (document, wait, path) => {
        const raw = await wait(document.getMetadata());
        const info = typeof raw.info === "object" && raw.info !== null
          ? raw.info as Record<string, unknown> : {};
        function metadataValue(key: string, xmpKey: string): string | null {
          const value = raw.metadata?.get(xmpKey);
          if (typeof value === "string" && value.trim()) return value;
          if (Array.isArray(value) && value.every((part) => typeof part === "string") && value.length) {
            const text = value.filter((part) => part.trim()).join(", ");
            if (text) return text;
          }
          return typeof info[key] === "string" && info[key].trim() ? info[key] : null;
        }
        async function resolveOutline(items: OutlineItem[]): Promise<PdfOutlineEntry[]> {
          const result: PdfOutlineEntry[] = [];
          for (const item of items) {
            let page: number | null = null;
            if (!item.url && item.dest !== null) {
              try {
                const dest = typeof item.dest === "string"
                  ? await wait(document.getDestination(item.dest)) : item.dest;
                const ref = dest?.[0];
                let index: number | undefined;
                if (typeof ref === "number") index = ref;
                else if (typeof ref === "object" && ref !== null && "num" in ref && "gen" in ref
                  && typeof ref.num === "number" && typeof ref.gen === "number") {
                  index = await wait(document.getPageIndex({ num: ref.num, gen: ref.gen }));
                }
                if (index !== undefined && Number.isInteger(index) && index >= 0 && index < document.numPages) page = index + 1;
              } catch (error) {
                input.signal.throwIfAborted();
                if (error instanceof WorkspacePdfAccessError) throw error;
                // A broken bookmark does not hide the remaining document outline.
              }
            }
            result.push({ title: item.title, page, target: item.url ? "external" : page === null ? "unresolved" : "page",
              url: item.url ?? null, items: await resolveOutline(item.items) });
          }
          return result;
        }
        return {
          path, pageCount: document.numPages,
          metadata: {
            title: metadataValue("Title", "dc:title"), author: metadataValue("Author", "dc:creator"),
            subject: metadataValue("Subject", "dc:description"), keywords: metadataValue("Keywords", "pdf:keywords"),
            creationDate: metadataValue("CreationDate", "xmp:createdate"), modificationDate: metadataValue("ModDate", "xmp:modifydate"),
            creator: metadataValue("Creator", "xmp:creatortool"), producer: metadataValue("Producer", "pdf:producer"),
          },
          outline: await resolveOutline(await wait(document.getOutline()) ?? []),
        };
      });
    },
    readText(input: PdfPagesInput): Promise<PdfText> {
      return withDocument(input, async (document, wait, path) => {
        checkPages(input.pages, document.numPages);
        const pages: PdfText["pages"] = [];
        for (const pageNumber of input.pages) {
          const page = await wait(document.getPage(pageNumber));
          try {
            const content = await wait(page.getTextContent());
            const text = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join("");
            pages.push({ page: pageNumber, text, status: text.trim() ? "text" : "no_text" });
          } finally { page.cleanup(); }
        }
        return { path, pageCount: document.numPages, pages };
      });
    },
    render(input: PdfPagesInput): Promise<RenderedPdfPages> {
      return withDocument(input, async (document, wait, path) => {
        checkPages(input.pages, document.numPages);
        const pages: RenderedPdfPage[] = [];
        for (const pageNumber of input.pages) {
          const page = await wait(document.getPage(pageNumber));
          let renderTask: PdfRenderTask | undefined;
          let canvas: PdfCanvas | undefined;
          try {
            const viewport = page.getViewport({ scale: 2 });
            const width = Math.ceil(viewport.width);
            const height = Math.ceil(viewport.height);
            canvas = adapters.createCanvas(width, height);
            renderTask = page.render(canvas, viewport);
            await wait(renderTask.promise);
            const png = new Uint8Array(await wait(canvas.encode("png")));
            pages.push({ page: pageNumber, width, height, png });
          } finally {
            try { renderTask?.cancel(); } catch {}
            try { page.cleanup(); } catch {}
            if (canvas) { canvas.width = 0; canvas.height = 0; }
          }
        }
        return { path, pageCount: document.numPages, pages };
      }, true);
    },
  };
}
