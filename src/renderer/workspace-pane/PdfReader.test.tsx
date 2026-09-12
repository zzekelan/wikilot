/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContextClip } from "../../shared/session";
import type { WorkspacePanePdfView } from "../../shared/workspace";
import { PdfReader } from "./PdfReader";

const controls = vi.hoisted(() => ({
  onLoadError: undefined as ((error: Error) => void) | undefined,
  onPassword: undefined as ((callback: (password: string | null) => void, reason?: number) => void) | undefined,
  onRangeFailure: undefined as ((error: Error) => void) | undefined,
  hasText: false,
  pageText: ((page: number): string => page === 1 ? "Before First selected line" : "Second selected line after"),
  pageRenderCount: 0,
  onRenderSuccess: new Map<number, () => void>(),
}));

vi.mock("../pdf/http-pdf-range-transport", () => ({
  openHttpPdfRangeTransport: vi.fn(async (
    _sourceUrl: string,
    _sourceSize: number,
    _signal: AbortSignal,
    onFailure: (error: Error) => void,
  ) => {
    controls.onRangeFailure = onFailure;
    return { sourceUrl: "/pdf/opaque", abort: vi.fn() };
  }),
}));
vi.mock("../telemetry", () => ({ recordUiGesture: vi.fn() }));
vi.mock("react-pdf", async () => {
  const React = await import("react");
  return {
    pdfjs: { GlobalWorkerOptions: { workerSrc: "" }, PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 } },
    Document: ({ children, onLoadSuccess, onLoadError, onPassword }: {
      children?: ReactNode;
      onLoadSuccess(info: { numPages: number; fingerprints: Array<string | null>; getOutline(): Promise<[]>; getPage(page: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; getViewport(): { width: number; height: number } }> }): void;
      onLoadError(error: Error): void;
      onPassword(callback: (password: string | null) => void, reason?: number): void;
    }) => {
      controls.onLoadError = onLoadError;
      controls.onPassword = onPassword;
      React.useEffect(() => onLoadSuccess({
        numPages: 3,
        fingerprints: ["pdf:fingerprint"],
        getOutline: async () => [],
        getPage: async (page: number) => ({
          getTextContent: async () => ({ items: controls.hasText ? [{ str: controls.pageText(page) }] : [] }),
          getViewport: () => ({ width: 612, height: 792 }),
        }),
      }), []);
      return <div data-testid="pdf-document">{children}</div>;
    },
    Page: ({ pageNumber, onGetTextSuccess, onRenderTextLayerSuccess, onRenderSuccess }: {
      pageNumber: number;
      onGetTextSuccess(text: { items: unknown[] }): void;
      onRenderTextLayerSuccess?(): void;
      onRenderSuccess?(): void;
    }) => {
      controls.pageRenderCount += 1;
      if (onRenderSuccess) controls.onRenderSuccess.set(pageNumber, onRenderSuccess);
      React.useEffect(() => onGetTextSuccess({ items: controls.hasText ? [{ str: controls.pageText(pageNumber) }] : [] }), []);
      React.useEffect(() => onRenderTextLayerSuccess?.(), []);
      return <div data-testid="pdf-page" data-page={pageNumber} className="react-pdf__Page">
        <div className="react-pdf__Page__textContent textLayer">
          {controls.hasText ? <span>{controls.pageText(pageNumber)}</span> : null}
        </div>
      </div>;
    },
  };
});
vi.mock("react-pdf/dist/Page/AnnotationLayer.css", () => ({}));
vi.mock("react-pdf/dist/Page/TextLayer.css", () => ({}));

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(612);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(612);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
});

afterEach(() => {
  controls.onLoadError = undefined;
  controls.onPassword = undefined;
  controls.onRangeFailure = undefined;
  controls.hasText = false;
  controls.pageText = (page: number) => page === 1 ? "Before First selected line" : "Second selected line after";
  controls.pageRenderCount = 0;
  controls.onRenderSuccess.clear();
  cleanup();
  vi.restoreAllMocks();
});

function reader() {
  return render(
    <PdfReader
      sourceUrl="/pdf/opaque"
      sourceSize={1000}
      view={{ page: 1, inPage: 0, zoom: "fit-width" }}
      mode="normal"
      onViewChange={vi.fn()}
    />,
  );
}

describe("PdfReader", () => {
  it("keeps the reading location when the zoom slider changes or returns to fit width", async () => {
    const onViewChange = vi.fn();
    const view = { page: 2, inPage: 0.35, zoom: "fit-width" } as const;
    render(<PdfReader sourceUrl="/pdf/opaque" sourceSize={1000} view={view} mode="normal" onViewChange={onViewChange} />);
    await screen.findAllByTestId("pdf-page");
    fireEvent.change(screen.getByRole("slider", { name: "PDF zoom level" }), { target: { value: "175" } });
    expect(onViewChange).toHaveBeenLastCalledWith({ ...view, zoom: 1.75 });
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(onViewChange).toHaveBeenLastCalledWith(view);
  });

  it("reserves each PDF page's final dimensions before its canvas renders", async () => {
    render(
      <PdfReader
        sourceUrl="/pdf/opaque"
        sourceSize={1000}
        view={{ page: 1, inPage: 0, zoom: 1 }}
        mode="normal"
        onViewChange={vi.fn()}
      />,
    );

    const frames = await screen.findAllByTestId("pdf-page-frame");
    await waitFor(() => expect(frames[0]?.style.width).toBe("614px"));
    expect(frames.map((frame) => frame.style.height)).toEqual(["794px", "794px"]);
  });

  it("does not restore a stale saved position after the user keeps scrolling", async () => {
    function ControlledReader() {
      const [view, setView] = useState<WorkspacePanePdfView>({ page: 1, inPage: 0, zoom: "fit-width" });
      return <PdfReader
        sourceUrl="/pdf/opaque"
        sourceSize={1000}
        view={view}
        mode="normal"
        onViewChange={setView}
      />;
    }

    render(<ControlledReader />);
    const scroller = screen.getByTestId("pdf-reader-scroll");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      value: 0,
      writable: true,
    });
    await screen.findAllByTestId("pdf-page");
    scroller.scrollTop = 600;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);

    await waitFor(() => expect((screen.getByRole("spinbutton", { name: "Page" }) as HTMLInputElement).value).toBe("2"));
    const latePageRender = controls.onRenderSuccess.get(2)!;

    scroller.scrollTop = 1076;
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);
    await act(async () => latePageRender());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(scroller.scrollTop).toBe(1076);
  });

  it("records user scrolling while ignoring automatic geometry scroll corrections", async () => {
    const onViewChange = vi.fn();
    render(
      <PdfReader
        sourceUrl="/pdf/opaque"
        sourceSize={1000}
        view={{ page: 1, inPage: 0, zoom: "fit-width" }}
        mode="normal"
        onViewChange={onViewChange}
      />,
    );
    await screen.findAllByTestId("pdf-page");
    const scroller = screen.getByTestId("pdf-reader-scroll");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      value: 24 + 794 * 0.35,
      writable: true,
    });

    fireEvent.scroll(scroller);
    expect(onViewChange).not.toHaveBeenCalled();
    fireEvent.wheel(scroller);
    fireEvent.scroll(scroller);

    expect(onViewChange).toHaveBeenCalledWith({ page: 1, inPage: 0.35, zoom: "fit-width" });
  });

  it("applies a Clip's in-page position when it is already on the current page", async () => {
    controls.hasText = true;
    const clip: ContextClip = {
      source: { kind: "pdf", path: "references/paper.pdf" },
      text: "First selected line",
      fingerprint: "pdfjs:pdf:fingerprint:source:source-v1",
      locator: {
        kind: "pdf",
        spans: [{
          page: 1,
          start: 7,
          end: 26,
          exact: "First selected line",
          prefix: "Before ",
          suffix: "",
          boxes: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.04 }],
        }],
      },
    };
    function Harness() {
      const [view, setView] = useState<WorkspacePanePdfView>({ page: 1, inPage: 0, zoom: "fit-width" });
      const [navigation, setNavigation] = useState<{ id: number; clip: ContextClip } | null>(null);
      return <>
        <button type="button" onClick={() => setNavigation({ id: 1, clip })}>Navigate Clip</button>
        <PdfReader
          sourceUrl="/pdf/opaque"
          sourceSize={1000}
          sourcePath="references/paper.pdf"
          sourceVersion="source-v1"
          view={view}
          mode="normal"
          contextClipNavigation={navigation}
          onViewChange={setView}
        />
      </>;
    }
    render(<Harness />);
    const scroller = await screen.findByTestId("pdf-reader-scroll");
    await screen.findAllByTestId("pdf-page");
    Object.defineProperty(scroller, "scrollTop", {
      configurable: true,
      value: 400,
      writable: true,
    });
    fireEvent.wheel(scroller);

    fireEvent.click(screen.getByRole("button", { name: "Navigate Clip" }));
    await waitFor(() => expect(screen.getByTestId("pdf-context-highlight")).toBeTruthy());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

    expect(scroller.scrollTop).toBeCloseTo(24 + 794 * 0.2, 0);
  });

  it("captures a cross-page text-layer selection as one PDF Context Clip", async () => {
    const onAddContextClip = vi.fn<(clip: ContextClip) => void>();
    controls.hasText = true;
    render(
      <PdfReader
        sourceUrl="/pdf/opaque"
        sourceSize={1000}
        sourcePath="references/paper.pdf"
        sourceVersion="source-v1"
        view={{ page: 1, inPage: 0, zoom: "fit-width" }}
        mode="normal"
        contextClipSessionId="session-1"
        onAddContextClip={onAddContextClip}
        onViewChange={vi.fn()}
      />,
    );
    const pages = await screen.findAllByTestId("pdf-page");
    const first = pages[0]!.querySelector("span")!.firstChild!;
    const second = pages[1]!.querySelector("span")!.firstChild!;
    const range = document.createRange();
    range.setStart(first, "Before ".length);
    range.setEnd(second, "Second selected line".length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.mouseUp(screen.getByTestId("pdf-reader-scroll"));
    expect(await screen.findAllByTestId("pdf-pending-selection-highlight")).toHaveLength(2);
    fireEvent.click(await screen.findByRole("button", { name: "Ask Wikilot" }));

    expect(onAddContextClip).toHaveBeenCalledWith(expect.objectContaining({
      source: { kind: "pdf", path: "references/paper.pdf" },
      text: "First selected line\nSecond selected line",
      fingerprint: "pdfjs:pdf:fingerprint:source:source-v1",
      locator: {
        kind: "pdf",
        spans: [
          expect.objectContaining({ page: 1, exact: "First selected line", prefix: "Before " }),
          expect.objectContaining({ page: 2, exact: "Second selected line", suffix: " after" }),
        ],
      },
    }));
  });

  it("positions and highlights every captured PDF span until another selection completes", async () => {
    controls.hasText = true;
    const onContextClipNavigationResult = vi.fn();
    const onViewChange = vi.fn();
    const clip: ContextClip = {
      source: { kind: "pdf", path: "references/paper.pdf" },
      text: "First selected line\nSecond selected line",
      fingerprint: "pdfjs:pdf:fingerprint:source:source-v1",
      locator: {
        kind: "pdf",
        spans: [
          { page: 1, start: 7, end: 26, exact: "First selected line", prefix: "Before ", suffix: "", boxes: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.04 }] },
          { page: 2, start: 0, end: 20, exact: "Second selected line", prefix: "", suffix: " after", boxes: [{ left: 0.12, top: 0.08, width: 0.55, height: 0.04 }] },
        ],
      },
    };
    function ControlledReader() {
      const [view, setView] = useState<WorkspacePanePdfView>({ page: 1, inPage: 0, zoom: "fit-width" });
      return <PdfReader
        sourceUrl="/pdf/opaque"
        sourceSize={1000}
        sourcePath="references/paper.pdf"
        sourceVersion="source-v1"
        view={view}
        mode="normal"
        contextClipNavigation={{ id: 7, clip }}
        onContextClipNavigationResult={onContextClipNavigationResult}
        onViewChange={(next) => {
          onViewChange(next);
          setView(next);
        }}
      />;
    }
    render(<ControlledReader />);

    await waitFor(() => expect(screen.getAllByTestId("pdf-context-highlight")).toHaveLength(2));
    expect(onViewChange).toHaveBeenCalledWith({ page: 1, inPage: 0.2, zoom: "fit-width" });
    expect(onContextClipNavigationResult).toHaveBeenCalledWith("exact");

    const scroller = screen.getByTestId("pdf-reader-scroll");
    fireEvent.wheel(scroller);
    expect(screen.getAllByTestId("pdf-context-highlight")).toHaveLength(2);

    const rendersBeforeSelection = controls.pageRenderCount;
    fireEvent.pointerDown(scroller);
    expect(controls.pageRenderCount).toBe(rendersBeforeSelection);

    const firstText = screen.getAllByTestId("pdf-page")[0]!.querySelector("span")!.firstChild!;
    const range = document.createRange();
    range.setStart(firstText, "Before ".length);
    range.setEnd(firstText, "Before First selected".length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(scroller);

    expect(screen.queryByTestId("pdf-context-highlight")).toBeNull();
    expect(screen.getByTestId("pdf-pending-selection-highlight")).toBeTruthy();
  });

  it("does not partially highlight a changed PDF when any span cannot relocate", async () => {
    controls.hasText = true;
    const onContextClipNavigationResult = vi.fn();
    render(
      <PdfReader
        sourceUrl="/pdf/opaque"
        sourceSize={1000}
        sourcePath="references/paper.pdf"
        sourceVersion="source-v2"
        view={{ page: 1, inPage: 0, zoom: "fit-width" }}
        mode="normal"
        contextClipNavigation={{
          id: 8,
          clip: {
            source: { kind: "pdf", path: "references/paper.pdf" },
            text: "First selected line\nMissing second line",
            fingerprint: "old:fingerprint",
            locator: {
              kind: "pdf",
              spans: [
                { page: 1, start: 7, end: 26, exact: "First selected line", prefix: "Before ", suffix: "", boxes: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.04 }] },
                { page: 2, start: 0, end: 19, exact: "Missing second line", prefix: "", suffix: " after", boxes: [{ left: 0.12, top: 0.08, width: 0.55, height: 0.04 }] },
              ],
            },
          },
        }}
        onContextClipNavigationResult={onContextClipNavigationResult}
        onViewChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(onContextClipNavigationResult).toHaveBeenCalledWith("changed"));
    expect(screen.queryByTestId("pdf-context-highlight")).toBeNull();
  });

  it("waits for the new text layer when a PDF source version changes in place", async () => {
    controls.hasText = true;
    const onContextClipNavigationResult = vi.fn();
    const clip: ContextClip = {
      source: { kind: "pdf", path: "references/paper.pdf" },
      text: "First selected line",
      fingerprint: "old:fingerprint",
      locator: {
        kind: "pdf",
        spans: [{
          page: 1,
          start: 7,
          end: 26,
          exact: "First selected line",
          prefix: "Before ",
          suffix: "",
          boxes: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.04 }],
        }],
      },
    };
    const view = { page: 1, inPage: 0, zoom: "fit-width" as const };
    const { rerender } = render(
      <PdfReader
        sourceUrl="/pdf/opaque"
        sourceSize={1000}
        sourcePath="references/paper.pdf"
        sourceVersion="source-v1"
        view={view}
        mode="normal"
        onContextClipNavigationResult={onContextClipNavigationResult}
        onViewChange={vi.fn()}
      />,
    );
    await screen.findByText("Before First selected line");

    controls.pageText = (page) => page === 1
      ? "First selected line First selected line"
      : "Second selected line after";
    rerender(
      <PdfReader
        sourceUrl="/pdf/opaque"
        sourceSize={1000}
        sourcePath="references/paper.pdf"
        sourceVersion="source-v2"
        view={view}
        mode="normal"
        contextClipNavigation={{ id: 11, clip }}
        onContextClipNavigationResult={onContextClipNavigationResult}
        onViewChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(onContextClipNavigationResult).toHaveBeenCalledWith("changed"));
    expect(screen.queryByTestId("pdf-context-highlight")).toBeNull();
  });

  it("reports a changed PDF when a captured page no longer exists", async () => {
    controls.hasText = true;
    const onContextClipNavigationResult = vi.fn();
    const onViewChange = vi.fn();
    render(
      <PdfReader
        sourceUrl="/pdf/opaque"
        sourceSize={1000}
        sourcePath="references/paper.pdf"
        sourceVersion="source-v2"
        view={{ page: 1, inPage: 0, zoom: "fit-width" }}
        mode="normal"
        contextClipNavigation={{
          id: 10,
          clip: {
            source: { kind: "pdf", path: "references/paper.pdf" },
            text: "Removed page text",
            fingerprint: "old:fingerprint",
            locator: {
              kind: "pdf",
              spans: [{
                page: 4,
                start: 0,
                end: 17,
                exact: "Removed page text",
                prefix: "",
                suffix: "",
                boxes: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.04 }],
              }],
            },
          },
        }}
        onContextClipNavigationResult={onContextClipNavigationResult}
        onViewChange={onViewChange}
      />,
    );

    await waitFor(() => expect(onContextClipNavigationResult).toHaveBeenCalledWith("changed"));
    expect(onViewChange).toHaveBeenCalledWith({ page: 3, inPage: 0, zoom: "fit-width" });
    expect(screen.queryByTestId("pdf-context-highlight")).toBeNull();
  });

  it("highlights a changed PDF only after every span uniquely relocates", async () => {
    controls.hasText = true;
    const onContextClipNavigationResult = vi.fn();
    const clip: ContextClip = {
      source: { kind: "pdf", path: "references/paper.pdf" },
      text: "First selected line\nSecond selected line",
      fingerprint: "old:fingerprint",
      locator: {
        kind: "pdf",
        spans: [
          { page: 1, start: 0, end: 19, exact: "First selected line", prefix: "", suffix: "", boxes: [{ left: 0.1, top: 0.2, width: 0.5, height: 0.04 }] },
          { page: 2, start: 4, end: 24, exact: "Second selected line", prefix: "old ", suffix: "", boxes: [{ left: 0.12, top: 0.08, width: 0.55, height: 0.04 }] },
        ],
      },
    };
    render(
      <PdfReader
        sourceUrl="/pdf/opaque"
        sourceSize={1000}
        sourcePath="references/paper.pdf"
        sourceVersion="source-v2"
        view={{ page: 1, inPage: 0, zoom: "fit-width" }}
        mode="normal"
        contextClipNavigation={{ id: 9, clip }}
        onContextClipNavigationResult={onContextClipNavigationResult}
        onViewChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(onContextClipNavigationResult).toHaveBeenCalledWith("relocated"));
    expect(screen.getAllByTestId("pdf-context-highlight")).toHaveLength(2);
  });

  it("keeps image pages readable while reporting the missing text layer", async () => {
    reader();
    await waitFor(() => expect(screen.getByText("No selectable text on this page")).toBeTruthy());
    expect(screen.getAllByTestId("pdf-page")).toHaveLength(2);
    expect(screen.getByTestId("pdf-document")).toBeTruthy();
  });

  it("maps invalid PDF failures to the damaged state", async () => {
    reader();
    await waitFor(() => expect(controls.onLoadError).toBeTypeOf("function"));
    await screen.findByText("No selectable text on this page");
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    controls.onLoadError!(new Error("Invalid PDF structure"));
    await waitFor(() => expect(screen.getByText("PDF is damaged")).toBeTruthy());
  });

  it("collects a password through the locked Reader surface", async () => {
    const unlock = vi.fn();
    reader();
    await waitFor(() => expect(controls.onPassword).toBeTypeOf("function"));
    controls.onPassword!(unlock);
    const input = await screen.findByLabelText("Password required");
    fireEvent.change(input, { target: { value: "secret" } });
    fireEvent.submit(screen.getByRole("form", { name: "PDF password" }));
    expect(unlock).toHaveBeenCalledWith("secret");
    act(() => controls.onPassword!(unlock, 2));
    expect(await screen.findByLabelText("Incorrect password. Try again.")).toBeTruthy();
    expect((screen.getByRole("slider", { name: "PDF zoom level" }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Incorrect password. Try again."), { target: { value: "correct" } });
    fireEvent.submit(screen.getByRole("form", { name: "PDF password" }));
    expect(unlock).toHaveBeenLastCalledWith("correct");
  });

  it("keeps unavailable distinct from deleted when a range fails", async () => {
    reader();
    await waitFor(() => expect(controls.onRangeFailure).toBeTypeOf("function"));
    await screen.findByTestId("pdf-document");
    controls.onRangeFailure!(Object.assign(new Error("PDF source is unavailable"), {
      code: "unavailable",
    }));
    await waitFor(() => expect(screen.getByText("PDF is unavailable")).toBeTruthy());
    expect(screen.queryByText("PDF was deleted")).toBeNull();
  });
});
