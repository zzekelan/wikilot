// @vitest-environment jsdom
import { act, cleanup, fireEvent, render as testingRender, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { useState } from "react";
import type { ContextClip } from "../../shared/session";
import {
  initialWorkspacePaneState,
  openWorkspaceGraphTab,
  openWorkspacePaneTab,
  setWorkspacePaneMode,
  setWorkspacePanePosition,
  type MarkdownDocumentSnapshot,
  type WorkspacePaneState,
} from "../../shared/workspace";
import { fingerprintMarkdown } from "./context-clip-capture";
import { ShortcutProvider } from "../shortcuts";
import { ToastProvider } from "../feedback";
import { WorkspacePane } from "./WorkspacePane";

const fake = vi.hoisted(() => ({
  getWorkspaceGraph: vi.fn(),
  retryWorkspaceGraph: vi.fn(),
  openWorkspacePdf: vi.fn(),
  openMarkdownDocument: vi.fn(),
  saveMarkdownDocument: vi.fn(),
  filesChanged: null as ((paths: string[]) => void) | null,
  workspacePdfSourceUrl: vi.fn((sourceId: string) => `/pdf/${sourceId}`),
  releaseWorkspacePdfSource: vi.fn(async (_sourceId: string) => {}),
}));
vi.mock("../client", () => ({ client: fake }));
vi.mock("./WorkspaceGraph", () => ({
  WorkspaceGraph: ({ originPath, onOpenNode }: {
    originPath: string | null;
    onOpenNode(path: string): void;
  }) => <div data-testid="workspace-graph" data-origin-path={originPath ?? ""}>
    <button type="button" onClick={() => onOpenNode("b.md")}>Open mock Graph node</button>
  </div>,
}));
vi.mock("../client/workspace-file-events", () => ({
  onWorkspaceFilesChanged: vi.fn((listener: (paths: string[]) => void) => {
    fake.filesChanged = listener;
    return () => { fake.filesChanged = null; };
  }),
}));
vi.mock("react-pdf", async () => {
  const React = await import("react");
  return {
    pdfjs: {
      GlobalWorkerOptions: { workerSrc: "" },
      PDFDataRangeTransport: class {
        length: number;
        constructor(length: number) { this.length = length; }
        transportReady() {}
        onDataRange() {}
      },
    },
    Document: ({ children, file, options, onLoadSuccess }: {
      children?: ReactNode;
      file: { range: { sourceUrl: string } };
      options: Record<string, unknown>;
      onLoadSuccess(info: { numPages: number; fingerprints: Array<string | null>; getOutline(): Promise<[]>; getPage(page: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }>; getViewport(): { width: number; height: number } }> }): void;
    }) => {
      React.useEffect(() => onLoadSuccess({
        numPages: 1000,
        fingerprints: ["pdf:fingerprint"],
        getOutline: async () => [],
        getPage: async (page) => ({
          getTextContent: async () => ({ items: page === 2 ? [] : [{ str: "text" }] }),
          getViewport: () => ({ width: 612, height: 792 }),
        }),
      }), []);
      return <div data-testid="pdf-document" data-url={file.range.sourceUrl} data-range={String(options.rangeChunkSize)}>{children}</div>;
    },
    Page: ({ pageNumber, onGetTextSuccess }: { pageNumber: number; onGetTextSuccess?(text: { items: unknown[] }): void }) => {
      React.useEffect(() => onGetTextSuccess?.({ items: pageNumber === 2 ? [] : [{}] }), [onGetTextSuccess, pageNumber]);
      return <div data-testid="pdf-page" data-page={pageNumber} />;
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
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    headers: { get: (name: string) => name === "accept-ranges" ? "bytes" : name === "content-length" ? String(250 * 1024 * 1024) : null },
  })));
  fake.retryWorkspaceGraph.mockReset();
  fake.getWorkspaceGraph.mockReset();
  fake.openWorkspacePdf.mockReset();
  fake.releaseWorkspacePdfSource.mockClear();
  fake.openMarkdownDocument.mockReset();
  fake.saveMarkdownDocument.mockReset();
  fake.filesChanged = null;
  fake.getWorkspaceGraph.mockResolvedValue({ status: "building" });
  fake.openWorkspacePdf.mockResolvedValue({
    sourceId: "opaque", version: "v1", size: 250 * 1024 * 1024, mediaType: "application/pdf",
  });
  fake.openMarkdownDocument.mockResolvedValue({
    path: "a.md",
    status: "ready",
    version: "v1",
    size: 7,
    content: "# Notes",
  });
  fake.saveMarkdownDocument.mockImplementation(
    async (_workspaceId: string, path: string, _version: string, content: string) => ({
      outcome: "saved",
      snapshot: { path, status: "ready", version: "v2", size: content.length, content },
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function render(ui: ReactNode) {
  return testingRender(ui, {
    wrapper: ({ children }) => (
      <ToastProvider>
        <ShortcutProvider>{children}</ShortcutProvider>
      </ToastProvider>
    ),
  });
}

function renderControlled(
  initialTabs: WorkspacePaneState,
  onChange = vi.fn(),
  props: Partial<ComponentProps<typeof WorkspacePane>> = {},
) {
  function Harness() {
    const [tabs, setTabs] = useState(initialTabs);
    return <WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={(next) => {
      onChange(next);
      setTabs(next);
    }} {...props} />;
  }
  return { ...render(<Harness />), onChange };
}

describe("WorkspacePane", () => {
  it("toggles the active Markdown tab between Read and Edit with Command+Shift+E", async () => {
    renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"));
    await screen.findByText("Notes");

    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" }).title).toContain("⌘⇧E"));
    fireEvent.keyDown(window, { key: "e", metaKey: true, shiftKey: true });
    expect(await screen.findByRole("textbox")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" }).title).toBe(
      "Edit mode (⌘⇧E toggles)",
    );

    fireEvent.keyDown(window, { key: "e", metaKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(screen.getByText("Notes")).toBeTruthy();
  });

  it("owns save and Pane history shortcuts while the reading surface is active", async () => {
    let tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    tabs = openWorkspacePaneTab(tabs, "b.md");
    renderControlled(tabs);
    await screen.findByRole("tab", { name: "b.md", selected: true });

    expect(fireEvent.keyDown(window, { key: "s", metaKey: true })).toBe(false);
    expect(screen.getByTestId("pane-back").title).toBe("Back · a.md (⌘[)");
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    expect(await screen.findByRole("tab", { name: "a.md", selected: true })).toBeTruthy();

    expect(screen.getByTestId("pane-forward").title).toBe("Forward · b.md (⌘])");
    fireEvent.keyDown(window, { key: "]", metaKey: true });
    expect(await screen.findByRole("tab", { name: "b.md", selected: true })).toBeTruthy();
  });

  it("keeps the prototype wide-mode action in the top tab bar", async () => {
    const onWideModeChange = vi.fn();
    renderControlled(
      openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"),
      vi.fn(),
      { onWideModeChange },
    );
    const button = await screen.findByRole("button", { name: "Wide Mode" });
    expect(button.closest(".workspace-tabs-row")).toBeTruthy();
    expect(button.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(button);
    expect(onWideModeChange).toHaveBeenCalledWith("wide");
  });

  it("shows the prototype insertion marker while dragging a tab and drops on that side", async () => {
    let tabs = initialWorkspacePaneState();
    for (const path of ["a.md", "b.md", "c.md"]) tabs = openWorkspacePaneTab(tabs, path);
    renderControlled(tabs);

    const dragged = await screen.findByRole("tab", { name: "a.md" });
    const target = screen.getByRole("tab", { name: "c.md" });
    const draggedTab = dragged.closest(".workspace-tab")!;
    const targetTab = target.closest(".workspace-tab")!;
    expect(screen.getByRole("button", { name: "Close c.md" }).getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("button", { name: "Close a.md" }).getAttribute("tabindex")).toBe("-1");
    vi.spyOn(targetTab, "getBoundingClientRect").mockReturnValue({
      x: 200,
      y: 0,
      top: 0,
      right: 300,
      bottom: 32,
      left: 200,
      width: 100,
      height: 32,
      toJSON: () => ({}),
    });
    const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };

    fireEvent.dragStart(dragged, { dataTransfer });
    expect(draggedTab.classList.contains("workspace-tab-dragging")).toBe(true);
    fireEvent.dragOver(target, { clientX: 290, dataTransfer });
    expect(targetTab.classList.contains("workspace-tab-drop-after")).toBe(true);
    fireEvent.dragOver(dragged, { dataTransfer });
    expect(targetTab.classList.contains("workspace-tab-drop-after")).toBe(false);
    fireEvent.dragOver(target, { clientX: 290, dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label")))
      .toEqual(["b.md", "c.md", "a.md"]);
    expect(screen.queryByRole("tab", { name: "a.md" })?.closest(".workspace-tab")?.classList.contains("workspace-tab-dragging"))
      .toBe(false);
  });

  it("keeps an empty pane mounted and renders Markdown without executing HTML or loading images", async () => {
    const onTabsChange = vi.fn();
    const { rerender } = render(
      <WorkspacePane workspaceId="w" tabs={initialWorkspacePaneState()} onTabsChange={onTabsChange} />,
    );
    expect(screen.getByTestId("workspace-pane")).toBeTruthy();
    expect(screen.getByText("Open a file to begin reading.")).toBeTruthy();

    let tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    const content = "# Safe\n\n<script>window.bad = true</script>\n\n![diagram](https://example.com/image.png)";
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md",
      status: "ready",
      version: "safe-v1",
      size: content.length,
      content,
    });
    rerender(<WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />);
    await waitFor(() => expect(screen.getByText("Safe")).toBeTruthy());
    expect(screen.queryByText("window.bad = true")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByLabelText("Image not loaded: diagram")).toBeTruthy();
  });

  it("renders one Graph Tab and Pane Back returns to the source document", async () => {
    fake.getWorkspaceGraph.mockResolvedValue({
      status: "ready",
      revision: 1,
      nodes: [{ path: "a.md", label: "a", degree: 0, referenceCount: 0 }],
      edges: [],
    });
    renderControlled(
      openWorkspaceGraphTab(
        openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("workspace-graph")).toBeTruthy());
    expect(screen.getAllByRole("tab", { name: "Graph" })).toHaveLength(1);

    fireEvent.click(screen.getByTestId("pane-back"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "a.md" }).getAttribute("aria-selected")).toBe("true"));
  });

  it("uses the most recently viewed Markdown file as the Graph Origin", async () => {
    fake.getWorkspaceGraph.mockResolvedValue({
      status: "ready",
      revision: 1,
      nodes: [{ path: "a.md", label: "a", degree: 0, referenceCount: 0 }],
      edges: [],
    });
    renderControlled(
      openWorkspaceGraphTab(
        openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"),
      ),
    );

    const graph = await screen.findByTestId("workspace-graph");
    expect(graph.getAttribute("data-origin-path")).toBe("a.md");
    fireEvent.click(screen.getByRole("button", { name: "Open mock Graph node" }));
    await screen.findByRole("tab", { name: "b.md", selected: true });
    fireEvent.click(screen.getByTestId("pane-back"));
    await waitFor(() => expect(screen.getByTestId("workspace-graph").getAttribute("data-origin-path")).toBe("b.md"));
  });

  it("shows Graph error and retrying states with an explicit Retry action", async () => {
    fake.getWorkspaceGraph.mockResolvedValueOnce({ status: "error", code: "index-build-failed" });
    renderControlled(openWorkspaceGraphTab(initialWorkspacePaneState()));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Graph index build failed"));
    fake.getWorkspaceGraph.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fake.retryWorkspaceGraph).toHaveBeenCalledWith("w");
    expect(screen.getByText("Retrying Graph…")).toBeTruthy();
  });

  it("activates tabs with Enter and closes them with the close button", async () => {
    let tabs = { ...initialWorkspacePaneState() };
    tabs = openWorkspacePaneTab(tabs, "a.md");
    tabs = openWorkspacePaneTab(tabs, "b.md");
    const onTabsChange = vi.fn((next) => { tabs = next; });
    render(<WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />);
    const tab = screen.getByRole("tab", { name: "a.md" });
    fireEvent.keyDown(tab, { key: "Enter" });
    expect(onTabsChange).toHaveBeenCalledWith(expect.objectContaining({ activePath: "a.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    await waitFor(() => expect(onTabsChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ tabs: ["b.md"] }),
    ));
  });

  it("navigates Back/Forward through pane history and disables at the ends", async () => {
    let tabs = initialWorkspacePaneState();
    tabs = openWorkspacePaneTab(tabs, "a.md");
    tabs = openWorkspacePaneTab(tabs, "b.md");
    const onTabsChange = vi.fn((next) => { tabs = next; });
    const { rerender } = render(
      <WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />,
    );
    const back = () => screen.getByTestId("pane-back") as HTMLButtonElement;
    const forward = () => screen.getByTestId("pane-forward") as HTMLButtonElement;
    expect(back().disabled).toBe(false);
    expect(forward().disabled).toBe(true);

    fireEvent.click(back());
    expect(tabs.activePath).toBe("a.md");
    rerender(<WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />);
    expect(forward().disabled).toBe(false);
    expect(back().disabled).toBe(true);

    fireEvent.click(forward());
    expect(tabs.activePath).toBe("b.md");
    rerender(<WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />);
    expect(forward().disabled).toBe(true);
  });

  it("shows the Pane skeleton while restoring and the one-time restore banner after", async () => {
    const onTabsChange = vi.fn();
    const { rerender } = render(
      <WorkspacePane
        workspaceId="w"
        tabs={initialWorkspacePaneState()}
        onTabsChange={onTabsChange}
        restoring
      />,
    );
    expect(screen.getByTestId("workspace-pane-skeleton")).toBeTruthy();

    const tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    rerender(
      <WorkspacePane
        workspaceId="w"
        tabs={tabs}
        onTabsChange={onTabsChange}
        restoreReport={{ skipped: 2 }}
        onDismissRestoreReport={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("workspace-pane-skeleton")).toBeNull();
    const banner = screen.getByTestId("pane-restore-banner");
    expect(banner.textContent).toMatch(/skipped 2 invalid items/i);
  });

  it("reports scroll position updates and restores the reading position after reload", async () => {
    let tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    tabs = setWorkspacePanePosition(tabs, "a.md", 240);
    const onTabsChange = vi.fn((next) => { tabs = next; });
    const { getByTestId } = render(
      <WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />,
    );
    const body = getByTestId("workspace-pane-content") as HTMLDivElement;
    await waitFor(() => expect(screen.getByText("Notes")).toBeTruthy());
    expect(body.scrollTop).toBe(240);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    onTabsChange.mockClear();

    body.scrollTop = 500;
    fireEvent.scroll(body);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(onTabsChange).not.toHaveBeenCalled();
    body.scrollTop = 520;
    fireEvent.scroll(body);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(onTabsChange).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(onTabsChange).toHaveBeenCalledWith(
      expect.objectContaining({ positions: { "a.md": 520 } }),
    );
    expect(onTabsChange).toHaveBeenCalledTimes(1);
  });

  it("reapplies the reading position after a restored document finishes loading", async () => {
    let resolveOpen!: (snapshot: MarkdownDocumentSnapshot) => void;
    fake.openMarkdownDocument.mockImplementationOnce(
      () => new Promise((resolve) => { resolveOpen = resolve; }),
    );
    let tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    tabs = setWorkspacePanePosition(tabs, "a.md", 240);
    render(<WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={vi.fn()} />);
    const body = screen.getByTestId("workspace-pane-content") as HTMLDivElement;
    body.scrollTop = 0;

    resolveOpen({ path: "a.md", status: "ready", version: "late", size: 7, content: "# Notes" });
    await waitFor(() => expect(screen.getByText("Notes")).toBeTruthy());
    await waitFor(() => expect(body.scrollTop).toBe(240));
  });

  it("keeps an unavailable tab open with a retry affordance", async () => {
    fake.openMarkdownDocument.mockResolvedValue({
      path: "notes/missing.md",
      status: "deleted",
      version: null,
      size: null,
    });
    const next = openWorkspacePaneTab(initialWorkspacePaneState(), "notes/missing.md");
    let tabs = next;
    const onTabsChange = vi.fn((value: WorkspacePaneState) => { tabs = value; });
    render(<WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />);
    await waitFor(() => expect(screen.getByText("File is not available")).toBeTruthy());
    // The tab itself stays and activation never silently switches.
    expect(screen.getByRole("tab", { name: "notes/missing.md" })).toBeTruthy();
    expect(tabs.activePath).toBe("notes/missing.md");

    fake.openMarkdownDocument.mockResolvedValue({
      path: "notes/missing.md",
      status: "ready",
      version: "v2",
      size: 7,
      content: "# Back\n",
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByText("Back")).toBeTruthy());
  });

  it.each([
    [{ path: "a.md", status: "too-large", version: "large", size: 3_000_000 }, "File is too large to edit"],
    [{ path: "a.md", status: "non-utf8", version: "binary", size: 3 }, "File is not UTF-8"],
    [{ path: "a.md", status: "waiting", version: null, size: 7 }, "Waiting for a stable disk read"],
    [{ path: "a.md", status: "deleted", version: null, size: null }, "File is not available"],
    [{ path: "a.md", status: "unavailable", version: null, size: null }, "File is unavailable"],
  ] as Array<[MarkdownDocumentSnapshot, string]>) (
    "locks editing for a %s Markdown snapshot",
    async (snapshot, title) => {
      fake.openMarkdownDocument.mockResolvedValue(snapshot);
      renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"));
      await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    },
  );

  it("preserves and blocks closing a dirty draft when the disk file disappears", async () => {
    vi.useFakeTimers();
    const onTabsChange = vi.fn();
    renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"), onTabsChange);
    await vi.runAllTimersAsync();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const view = EditorView.findFromDOM(screen.getByRole("textbox"));
    if (!view) throw new Error("CodeMirror view not mounted");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " draft" } }));
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "deleted", version: null, size: null,
    });
    await act(async () => { fake.filesChanged?.(["a.md"]); });

    expect(screen.getByText("File is not available")).toBeTruthy();
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(screen.queryByText(/Notes draft/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    await act(async () => {});
    expect(screen.getByRole("tab", { name: "a.md" })).toBeTruthy();
    expect(onTabsChange).not.toHaveBeenCalledWith(expect.objectContaining({ tabs: [] }));
  });

  it("blocks closing when the save conflict snapshot is not readable", async () => {
    vi.useFakeTimers();
    fake.saveMarkdownDocument.mockResolvedValue({
      outcome: "conflict",
      snapshot: { path: "a.md", status: "waiting", version: null, size: 7 },
    });
    const onTabsChange = vi.fn();
    renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"), onTabsChange);
    await vi.runAllTimersAsync();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const view = EditorView.findFromDOM(screen.getByRole("textbox"));
    if (!view) throw new Error("CodeMirror view not mounted");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " draft" } }));
    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    await act(async () => {});

    expect(screen.getByText("Waiting for a stable disk read")).toBeTruthy();
    expect(screen.getByText(/not ready for saving/i)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "a.md" })).toBeTruthy();
    expect(onTabsChange).not.toHaveBeenCalledWith(expect.objectContaining({ tabs: [] }));
  });

  it("uses real CodeMirror completion and applies the MRU-ranked candidate", async () => {
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: 0, content: "",
    });
    let tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "Archive.md");
    tabs = openWorkspacePaneTab(tabs, "a.md");
    tabs = setWorkspacePaneMode(tabs, "a.md", "editing");
    renderControlled(tabs, vi.fn(), {
      linkIndex: {
        status: "ready",
        revision: 4,
        propertyRegistry: [],
        targets: [
          { path: "Alpha.md", kind: "markdown" },
          { path: "Archive.md", kind: "markdown" },
          { path: "notes/Beta.md", kind: "markdown" },
          { path: "manual.pdf", kind: "pdf" },
        ],
        records: [
          { path: "Alpha.md", headings: [], aliases: [], tags: [], references: [], parseStatus: "parsed", diagnostics: [] },
          { path: "Archive.md", headings: [{
            depth: 1,
            text: "Overview",
            slug: "overview",
            range: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 11, offset: 10 } },
          }], aliases: [], tags: [], references: [], parseStatus: "parsed", diagnostics: [] },
          { path: "notes/Beta.md", headings: [], aliases: ["Atlas"], tags: [], references: [], parseStatus: "parsed", diagnostics: [] },
        ],
      },
    });
    const editor = await screen.findByTestId("markdown-editor");
    const view = EditorView.findFromDOM(editor);
    if (!view) throw new Error("CodeMirror view not mounted");
    act(() => view.dispatch({
      changes: { from: 0, insert: "[[A" },
      selection: { anchor: 3 },
      userEvent: "input.type",
    }));
    await waitFor(() => expect(document.querySelectorAll(".cm-tooltip-autocomplete li").length).toBeGreaterThanOrEqual(3));
    expect(document.querySelector(".cm-tooltip-autocomplete li")?.textContent).toMatch(/Archive/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fireEvent.keyDown(view.contentDOM, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("[[Archive]]");
    expect(view.state.selection.main.head).toBe("[[Archive".length);

    const headingStart = view.state.selection.main.head;
    act(() => view.dispatch({
      changes: { from: headingStart, insert: "#O" },
      selection: { anchor: headingStart + 2 },
      userEvent: "input.type",
    }));
    expect(view.state.doc.toString()).toBe("[[Archive#O]]");
    await waitFor(() => expect(
      [...document.querySelectorAll(".cm-tooltip-autocomplete li")]
        .some((item) => /Overview/.test(item.textContent ?? "")),
    ).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    fireEvent.keyDown(view.contentDOM, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("[[Archive#Overview]]");

    act(() => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "[[Atl" },
      selection: { anchor: 5 },
      userEvent: "input.type",
    }));
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete li")?.textContent).toMatch(/Atlas/));
    await new Promise((resolve) => setTimeout(resolve, 100));
    fireEvent.keyDown(view.contentDOM, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("[[notes/Beta|Atlas]]");

    act(() => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "[[man" },
      selection: { anchor: 5 },
      userEvent: "input.type",
    }));
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete li")?.textContent).toMatch(/manual\.pdf/));
    await new Promise((resolve) => setTimeout(resolve, 100));
    fireEvent.keyDown(view.contentDOM, { key: "Enter" });
    expect(view.state.doc.toString()).toBe("[[manual.pdf]]");
  });

  it("keeps ordinary editor clicks for cursor placement and Ctrl-clicks both link syntaxes", async () => {
    const content = "[[Wiki]] and [Standard](Target.md#Details) and `[[Code]]`";
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: content.length, content,
    });
    let tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    tabs = setWorkspacePaneMode(tabs, "a.md", "editing");
    const resolveLink = vi.fn(async () => ({
      status: "ready" as const,
      revision: 3,
      target: { status: "resolved" as const, path: "Target.md", kind: "markdown" as const },
    }));
    const onNavigate = vi.fn();
    renderControlled(tabs, vi.fn(), { resolveLink, onNavigate });
    const editor = await screen.findByTestId("markdown-editor");
    const view = EditorView.findFromDOM(editor);
    if (!view) throw new Error("CodeMirror view not mounted");
    vi.spyOn(view, "posAtCoords")
      .mockReturnValueOnce(content.indexOf("Wiki") + 1)
      .mockReturnValueOnce(content.indexOf("Standard") + 1)
      .mockReturnValueOnce(content.indexOf("Code") + 1);

    fireEvent.click(view.contentDOM);
    expect(resolveLink).not.toHaveBeenCalled();
    fireEvent.click(view.contentDOM, { ctrlKey: true, clientX: 1, clientY: 1 });
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith({
      status: "resolved", path: "Target.md", kind: "markdown",
    }));
    expect(resolveLink).toHaveBeenNthCalledWith(1, {
      sourcePath: "a.md", syntax: "wikilink", authoredTarget: "Wiki",
    });

    fireEvent.click(view.contentDOM, { ctrlKey: true, clientX: 2, clientY: 1 });
    await waitFor(() => expect(resolveLink).toHaveBeenNthCalledWith(2, {
      sourcePath: "a.md",
      syntax: "markdown",
      authoredTarget: "Target.md",
      subpath: { kind: "heading", value: "Details" },
    }));
    fireEvent.click(view.contentDOM, { ctrlKey: true, clientX: 3, clientY: 1 });
    expect(resolveLink).toHaveBeenCalledTimes(2);
  });

  it("edits frontmatter Properties through the shared Markdown buffer", async () => {
    vi.useFakeTimers();
    const content = "---\ntitle: Old # untouched until edited\ntags: [one, two]\nnested:\n  owner: Ada\n---\n# Notes\n";
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: content.length, content,
    });
    renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"));
    await vi.runAllTimersAsync();

    expect(screen.getByRole("heading", { name: "Notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Collapse Properties" })).toBeTruthy();
    expect((screen.getByLabelText("title value") as HTMLInputElement).value).toBe("Old");
    expect(screen.getByText("Nested value")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("title value"), { target: { value: "New" } });
    fireEvent.blur(screen.getByLabelText("title value"));
    expect(screen.getByText("Unsaved")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();
    expect(fake.saveMarkdownDocument).toHaveBeenLastCalledWith(
      "w",
      "a.md",
      "v1",
      "---\ntitle: New\ntags: [one, two]\nnested:\n  owner: Ada\n---\n# Notes\n",
    );
  });

  it("keeps malformed Properties disabled while reading and source editing remain available", async () => {
    const content = "---\ntitle: [broken\n---\n# Still readable\n";
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: content.length, content,
    });
    renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Still readable" })).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/frontmatter yaml is malformed/i);
    expect(screen.queryByRole("button", { name: "Add property" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByTestId("markdown-editor")).toBeTruthy();
  });

  it("adds a property from Workspace suggestions using its registered type", async () => {
    vi.useFakeTimers();
    const content = "---\ntitle: Note\n---\n# Notes\n";
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: content.length, content,
    });
    function Harness() {
      const [tabs, setTabs] = useState(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"));
      return <WorkspacePane
        workspaceId="w"
        tabs={tabs}
        onTabsChange={setTabs}
        propertyRegistry={[
          { name: "title", type: "text" },
          { name: "published", type: "date" },
        ]}
      />;
    }
    render(<Harness />);
    await vi.runAllTimersAsync();
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Text" }));
    expect(screen.queryByRole("listbox", { name: "Known properties" })).toBeNull();
    const name = screen.getByLabelText("New property name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "title" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect((screen.getByLabelText("New property name") as HTMLInputElement).value).toBe("title");
    expect(screen.getByRole("alert").textContent).toMatch(/already exists/i);
    fireEvent.keyDown(name, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    fireEvent.click(screen.getByRole("option", { name: "published" }));
    expect(screen.getByLabelText("published value")).toBeTruthy();
  });

  it("renames, converts, deletes, and edits typed scalar arrays through property rows", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("confirm", vi.fn(() => true));
    const content = '---\ntitle: words\n# before priority\npriority: 2\nfeatured: true\nmixed: ["false",1,null,"a,b"]\n---\n# Notes\n';
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: content.length, content,
    });
    renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"));
    await vi.runAllTimersAsync();

    expect(screen.getByTitle("Type: text")).toBeTruthy();
    expect((screen.getByLabelText("priority value") as HTMLInputElement).inputMode).toBe("decimal");
    expect(screen.getByRole("switch", { name: "featured value" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("null")).toBeTruthy();
    expect(screen.getByText("a,b")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rename property title" }));
    fireEvent.change(screen.getByLabelText("title name"), { target: { value: "" } });
    fireEvent.blur(screen.getByLabelText("title name"));
    expect((screen.getByLabelText("title name") as HTMLInputElement).value).toBe("title");
    fireEvent.change(screen.getByLabelText("title name"), { target: { value: "score" } });
    fireEvent.blur(screen.getByLabelText("title name"));
    fireEvent.click(screen.getByLabelText("score type"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Number" }));
    fireEvent.click(screen.getByLabelText("featured value"));
    fireEvent.click(screen.getByLabelText("Remove mixed value item 1"));
    fireEvent.change(screen.getByLabelText("Add to mixed"), { target: { value: "still,false" } });
    fireEvent.keyDown(screen.getByLabelText("Add to mixed"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Delete priority" }));

    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();
    expect(fake.saveMarkdownDocument).toHaveBeenLastCalledWith(
      "w",
      "a.md",
      "v1",
      '---\nscore: 0\n# before priority\nfeatured: false\nmixed: [1,null,"a,b","still,false"]\n---\n# Notes\n',
    );
  });

  it("edits one shared buffer and autosaves complete content after 500ms", async () => {
    vi.useFakeTimers();
    const tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    renderControlled(tabs);
    await vi.runAllTimersAsync();
    expect(screen.getByText("Notes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByTestId("markdown-editor");
    const view = EditorView.findFromDOM(editor);
    if (!view) throw new Error("CodeMirror view not mounted");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "\nmore" } }));
    expect(screen.getByText("Unsaved")).toBeTruthy();

    await vi.advanceTimersByTimeAsync(499);
    expect(fake.saveMarkdownDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();
    expect(fake.saveMarkdownDocument).toHaveBeenCalledWith(
      "w",
      "a.md",
      "v1",
      "# Notes\nmore",
    );
    fireEvent.click(screen.getByRole("button", { name: "Read" }));
    expect(screen.getByText("more")).toBeTruthy();
  });

  it("adopts the latest disk content and reports an external replacement on conflict", async () => {
    vi.useFakeTimers();
    fake.saveMarkdownDocument.mockResolvedValue({
      outcome: "conflict",
      snapshot: {
        path: "a.md",
        status: "ready",
        version: "external-v2",
        size: 10,
        content: "# External",
      },
    });
    const tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    renderControlled(tabs);
    await vi.runAllTimersAsync();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const view = EditorView.findFromDOM(screen.getByTestId("markdown-editor"));
    if (!view) throw new Error("CodeMirror view not mounted");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " local" } }));
    await vi.advanceTimersByTimeAsync(500);
    await vi.runAllTimersAsync();

    expect(screen.getByText(/replaced by a newer disk version/i)).toBeTruthy();
    await act(async () => {});
    const replacedView = EditorView.findFromDOM(screen.getByRole("textbox"));
    expect(replacedView?.state.doc.toString()).toBe("# External");
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("blocks closing a dirty tab when its required save fails", async () => {
    vi.useFakeTimers();
    fake.saveMarkdownDocument.mockRejectedValue(new Error("disk full"));
    const tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    const onTabsChange = vi.fn();
    renderControlled(tabs, onTabsChange);
    await vi.runAllTimersAsync();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const view = EditorView.findFromDOM(screen.getByTestId("markdown-editor"));
    if (!view) throw new Error("CodeMirror view not mounted");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " dirty" } }));
    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    await vi.runAllTimersAsync();

    expect(screen.getByText(/disk full/i)).toBeTruthy();
    expect(onTabsChange).not.toHaveBeenCalledWith(expect.objectContaining({ tabs: [] }));
    expect(screen.getByRole("tab", { name: "a.md" })).toBeTruthy();
  });

  it("queues edits made during a save into the next versioned save", async () => {
    vi.useFakeTimers();
    let resolveFirst!: (value: unknown) => void;
    fake.saveMarkdownDocument
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async (_workspaceId, path, _version, content) => ({
        outcome: "saved",
        snapshot: { path, status: "ready", version: "v3", size: content.length, content },
      }));
    const tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    renderControlled(tabs);
    await vi.runAllTimersAsync();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const view = EditorView.findFromDOM(screen.getByRole("textbox"));
    if (!view) throw new Error("CodeMirror view not mounted");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " one" } }));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(fake.saveMarkdownDocument).toHaveBeenCalledTimes(1);

    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " two" } }));
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v2", size: 11, content: "# Notes one",
    });
    act(() => fake.filesChanged?.(["a.md"]));
    resolveFirst({
      outcome: "saved",
      snapshot: { path: "a.md", status: "ready", version: "v2", size: 11, content: "# Notes one" },
    });
    await vi.runAllTimersAsync();

    expect(fake.saveMarkdownDocument).toHaveBeenNthCalledWith(
      2,
      "w",
      "a.md",
      "v2",
      "# Notes one two",
    );
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.queryByText(/replaced by a newer disk version/i)).toBeNull();
  });

  it("retries failures with a bound and Mod-S retries immediately", async () => {
    vi.useFakeTimers();
    fake.saveMarkdownDocument.mockRejectedValue(new Error("offline"));
    const tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    renderControlled(tabs);
    await vi.runAllTimersAsync();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const view = EditorView.findFromDOM(screen.getByRole("textbox"));
    if (!view) throw new Error("CodeMirror view not mounted");
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: " retry" } }));
    await vi.runAllTimersAsync();
    expect(fake.saveMarkdownDocument).toHaveBeenCalledTimes(4);

    fake.saveMarkdownDocument.mockResolvedValue({
      outcome: "saved",
      snapshot: {
        path: "a.md", status: "ready", version: "v2", size: 13, content: "# Notes retry",
      },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "s", ctrlKey: true });
    await vi.runAllTimersAsync();
    expect(fake.saveMarkdownDocument).toHaveBeenCalledTimes(5);
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("captures a real CodeMirror raw Markdown selection", async () => {
    const content = "# Plan\n\nUse **raw syntax** here.\n";
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: content.length, content,
    });
    let tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    tabs = setWorkspacePaneMode(tabs, "a.md", "editing");
    const onAddContextClip = vi.fn();
    renderControlled(tabs, vi.fn(), { contextClipSessionId: "session-1", onAddContextClip });
    const view = EditorView.findFromDOM(await screen.findByTestId("markdown-editor"));
    if (!view) throw new Error("CodeMirror view not mounted");
    const start = content.indexOf("**raw syntax**");

    act(() => view.dispatch({ selection: { anchor: start, head: start + "**raw syntax**".length } }));
    fireEvent.click(await screen.findByRole("button", { name: "Ask Wikilot" }));

    expect(onAddContextClip).toHaveBeenCalledWith(expect.objectContaining({
      text: "**raw syntax**",
      fingerprint: fingerprintMarkdown(content),
      locator: expect.objectContaining({
        kind: "markdown",
        mode: "editing",
        start,
        end: start + "**raw syntax**".length,
      }),
    }));
  });

  it.each([
    ["exact", "# Plan\n\nUse **raw syntax** here.\n", fingerprintMarkdown("# Plan\n\nUse **raw syntax** here.\n")],
    ["relocated", "# Plan\n\nNew intro. Use **raw syntax** here.\n", "stale-fingerprint"],
  ] as const)("restores an editing Clip with a %s source result", async (expected, content, fingerprint) => {
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: content.length, content,
    });
    const exact = "**raw syntax**";
    const original = "# Plan\n\nUse **raw syntax** here.\n";
    const originalStart = original.indexOf(exact);
    const clip: ContextClip = {
      source: { kind: "markdown", path: "a.md" },
      text: exact,
      fingerprint,
      locator: {
        kind: "markdown",
        mode: "editing",
        start: originalStart,
        end: originalStart + exact.length,
        exact,
        prefix: "# Plan\n\nUse ",
        suffix: " here.\n",
        lineStart: 3,
        lineEnd: 3,
        heading: "Plan",
      },
    };
    const onContextClipNavigationResult = vi.fn();
    renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"), vi.fn(), {
      contextClipNavigation: { id: 1, clip },
      onContextClipNavigationResult,
    });

    const editor = await screen.findByTestId("markdown-editor");
    const view = EditorView.findFromDOM(editor);
    if (!view) throw new Error("CodeMirror view not mounted");
    await waitFor(() => expect(onContextClipNavigationResult).toHaveBeenCalledWith(expected));
    const relocatedStart = content.indexOf(exact);
    await waitFor(() => expect(view.state.selection.main).toMatchObject({
      from: relocatedStart,
      to: relocatedStart + exact.length,
    }));
    expect(screen.getByTestId("workspace-pane").className).toContain("workspace-pane-context-highlight");
    act(() => view.dispatch({ selection: { anchor: 0 } }));
    await waitFor(() => expect(screen.getByTestId("workspace-pane").className).not.toContain("workspace-pane-context-highlight"));
  });

  it.each([true, false])("restores a reading Clip ahead of the saved position when previously visible=%s", async (visible) => {
    const content = "# Plan\n\nUse visible text here.\n";
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: content.length, content,
    });
    const clip: ContextClip = {
      source: { kind: "markdown", path: "a.md" },
      text: "visible text",
      fingerprint: fingerprintMarkdown(content),
      locator: {
        kind: "markdown",
        mode: "reading",
        start: "Plan Use ".length,
        end: "Plan Use visible text".length,
        exact: "visible text",
        prefix: "Plan Use ",
        suffix: " here.",
        lineStart: 3,
        lineEnd: 3,
        heading: "Plan",
      },
    };
    const onContextClipNavigationResult = vi.fn();
    const tabs = { ...openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"), visible };
    const onTabsChange = vi.fn();
    const { rerender } = render(<WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />);
    await screen.findByText("Use visible text here.");
    const body = screen.getByTestId("workspace-pane-content");
    // jsdom has no layout: supply the selected text's browser geometry.
    const createRange = document.createRange.bind(document);
    vi.spyOn(document, "createRange").mockImplementation(() => {
      const range = createRange();
      range.getBoundingClientRect = () => ({ top: 1190, height: 20 } as DOMRect);
      return range;
    });
    rerender(<WorkspacePane workspaceId="w" tabs={{ ...tabs, visible: true }} onTabsChange={onTabsChange}
      contextClipNavigation={{ id: 1, clip }} onContextClipNavigationResult={onContextClipNavigationResult} />);
    await waitFor(() => expect(onContextClipNavigationResult).toHaveBeenCalledWith("exact"));
    expect(window.getSelection()?.toString()).toContain("visible text");
    expect(body.scrollTop).toBe(800);
    expect(screen.queryByRole("toolbar", { name: "Context Clip selection" })).toBeNull();
  });

  it("opens a changed source without highlighting an ambiguous anchor", async () => {
    const content = "# Plan\n\n**same** then **same**\n";
    fake.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v2", size: content.length, content,
    });
    const clip: ContextClip = {
      source: { kind: "markdown", path: "a.md" },
      text: "**same**",
      fingerprint: "stale-fingerprint",
      locator: {
        kind: "markdown",
        mode: "editing",
        start: 0,
        end: 8,
        exact: "**same**",
        prefix: "",
        suffix: "",
      },
    };
    const onContextClipNavigationResult = vi.fn();
    renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"), vi.fn(), {
      contextClipNavigation: { id: 1, clip },
      onContextClipNavigationResult,
    });

    await screen.findByTestId("markdown-editor");
    await waitFor(() => expect(onContextClipNavigationResult).toHaveBeenCalledWith("changed"));
    const view = EditorView.findFromDOM(screen.getByTestId("markdown-editor"));
    expect(view?.state.selection.main.empty).toBe(true);
  });

  it("cancels Reader requests before releasing a source when its PDF Tab closes", async () => {
    const events: string[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      events.push("request");
      init?.signal?.addEventListener("abort", () => {
        events.push("abort");
        reject(init.signal?.reason);
      }, { once: true });
    })));
    fake.releaseWorkspacePdfSource.mockImplementation(async (sourceId: string) => {
      events.push(`release:${sourceId}`);
    });
    renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "paper.pdf"));
    await waitFor(() => expect(events).toContain("request"));

    fireEvent.click(screen.getByRole("button", { name: "Close paper.pdf" }));

    await waitFor(() => expect(events).toContain("release:opaque"));
    expect(events.indexOf("abort")).toBeLessThan(events.indexOf("release:opaque"));
  });

  it("releases a PDF capability whose async open becomes stale", async () => {
    let resolveSource!: (source: {
      sourceId: string;
      version: string;
      size: number;
      mediaType: "application/pdf";
    }) => void;
    fake.openWorkspacePdf.mockReturnValue(new Promise((resolve) => { resolveSource = resolve; }));
    let tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "paper.pdf");
    const onTabsChange = vi.fn();
    const { rerender } = render(
      <WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />,
    );
    await waitFor(() => expect(fake.openWorkspacePdf).toHaveBeenCalledWith("w", "paper.pdf"));
    tabs = openWorkspacePaneTab(tabs, "a.md");
    rerender(<WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />);

    resolveSource({
      sourceId: "stale-source",
      version: "v1",
      size: 9,
      mediaType: "application/pdf",
    });

    await waitFor(() => expect(fake.releaseWorkspacePdfSource).toHaveBeenCalledWith("stale-source"));
    expect(screen.queryByTestId("pdf-reader")).toBeNull();
  });

  it("keeps a PDF capability through Strict Mode's simulated effect cleanup", async () => {
    render(
      <StrictMode>
        <WorkspacePane
          workspaceId="w"
          tabs={openWorkspacePaneTab(initialWorkspacePaneState(), "paper.pdf")}
          onTabsChange={vi.fn()}
        />
      </StrictMode>,
    );
    await screen.findByTestId("pdf-reader");
    await act(async () => { await Promise.resolve(); });

    expect(fake.releaseWorkspacePdfSource).not.toHaveBeenCalled();
  });

  it("releases the current PDF source when the Workspace Pane is disposed", async () => {
    const view = renderControlled(openWorkspacePaneTab(initialWorkspacePaneState(), "paper.pdf"));
    await screen.findByTestId("pdf-reader");

    view.unmount();

    await waitFor(() => expect(fake.releaseWorkspacePdfSource).toHaveBeenCalledWith("opaque"));
  });

  it("fits a PDF on entry while preserving its position and allowing manual zoom during reading", async () => {
    let current: WorkspacePaneState;
    function Harness() {
      const [tabs, setTabs] = useState<WorkspacePaneState>(() => ({
        ...openWorkspacePaneTab(initialWorkspacePaneState(), "paper.pdf"),
        pdfViews: { "paper.pdf": { page: 7, inPage: 0.35, zoom: 1.45 } },
      }));
      current = tabs;
      return <>
        <button onClick={() => setTabs({ ...tabs, visible: !tabs.visible })}>Toggle pane</button>
        <button onClick={() => setTabs(openWorkspacePaneTab(tabs, "a.md"))}>Read notes</button>
        <button onClick={() => setTabs(openWorkspacePaneTab(tabs, "paper.pdf"))}>Read PDF</button>
        <WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={setTabs} />
      </>;
    }
    render(<Harness />);
    await screen.findAllByTestId("pdf-page");
    expect(current!.pdfViews["paper.pdf"]).toEqual({ page: 7, inPage: 0.35, zoom: "fit-width" });
    fireEvent.change(screen.getByRole("slider", { name: "PDF zoom level" }), { target: { value: "175" } });
    expect(current!.pdfViews["paper.pdf"]).toEqual({ page: 7, inPage: 0.35, zoom: 1.75 });
    fireEvent.click(screen.getByText("Toggle pane"));
    fireEvent.click(screen.getByText("Toggle pane"));
    expect(current!.pdfViews["paper.pdf"]).toEqual({ page: 7, inPage: 0.35, zoom: "fit-width" });
    fireEvent.change(screen.getByRole("slider", { name: "PDF zoom level" }), { target: { value: "200" } });
    fireEvent.click(screen.getByText("Read notes"));
    fireEvent.click(screen.getByText("Read PDF"));
    expect(current!.pdfViews["paper.pdf"]).toEqual({ page: 7, inPage: 0.35, zoom: "fit-width" });
  });

  it("reads a 1,000-page PDF on demand with one Reader Bar and at most adjacent pages", async () => {
    fake.openWorkspacePdf.mockResolvedValue({
      sourceId: "opaque",
      version: "v1",
      size: 250 * 1024 * 1024,
      mediaType: "application/pdf",
    });
    let tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "paper.pdf");
    const onTabsChange = vi.fn((next: WorkspacePaneState) => { tabs = next; });
    const { rerender } = render(
      <WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />,
    );

    await waitFor(() => expect(screen.getByText("/ 1000")).toBeTruthy());
    expect(screen.getByTestId("pdf-document").getAttribute("data-url")).toBe("/pdf/opaque");
    expect(screen.getByTestId("pdf-document").getAttribute("data-range")).toBe(String(64 * 1024));
    expect(Number.parseFloat((document.querySelector(".pdf-reader-pages") as HTMLElement).style.height)).toBeGreaterThan(700_000);
    expect(screen.getAllByTestId("pdf-page").map((page) => page.getAttribute("data-page"))).toEqual(["1", "2"]);

    fireEvent.change(screen.getByLabelText("Page"), { target: { value: "500" } });
    rerender(<WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={onTabsChange} />);
    await waitFor(() => expect(screen.getAllByTestId("pdf-page").map((page) => page.getAttribute("data-page"))).toEqual(["499", "500", "501"]));
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(tabs.pdfViews["paper.pdf"]).toMatchObject({ page: 500, zoom: "fit-width" });
    expect(screen.queryByLabelText("Use wide reading width")).toBeNull();
    expect(screen.queryByLabelText("Use normal reading width")).toBeNull();
  });

  it("uses a Clip navigation PDF source only until the pane refreshes it", async () => {
    const source = (id: string, version: string) => ({
      sourceId: id,
      version,
      size: 250 * 1024 * 1024,
      mediaType: "application/pdf" as const,
    });
    fake.openWorkspacePdf.mockResolvedValue(source("source-v1", "v1"));
    const tabs = openWorkspacePaneTab(initialWorkspacePaneState(), "paper.pdf");
    const { rerender } = render(
      <WorkspacePane workspaceId="w" tabs={tabs} onTabsChange={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId("pdf-document").getAttribute("data-url")).toBe("/pdf/source-v1"));

    const clip: ContextClip = {
      source: { kind: "pdf", path: "paper.pdf" },
      text: "evidence",
      fingerprint: "pdf:v1",
      locator: {
        kind: "pdf",
        spans: [{
          page: 1,
          start: 0,
          end: 8,
          exact: "evidence",
          prefix: "",
          suffix: "",
          boxes: [{ left: 0.1, top: 0.1, width: 0.2, height: 0.05 }],
        }],
      },
    };
    fake.openWorkspacePdf.mockResolvedValue(source("source-v2", "v2"));
    rerender(
      <WorkspacePane
        workspaceId="w"
        tabs={tabs}
        onTabsChange={vi.fn()}
        contextClipNavigation={{ id: 1, clip, pdfSource: source("source-v2", "v2") }}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("pdf-document").getAttribute("data-url")).toBe("/pdf/source-v2"));
    await waitFor(() => expect(fake.releaseWorkspacePdfSource).toHaveBeenCalledWith("source-v1"));

    fake.openWorkspacePdf.mockResolvedValue(source("source-v3", "v3"));
    act(() => fake.filesChanged?.(["paper.pdf"]));
    await waitFor(() => expect(screen.getByTestId("pdf-document").getAttribute("data-url")).toBe("/pdf/source-v3"));
    await waitFor(() => expect(fake.releaseWorkspacePdfSource).toHaveBeenCalledWith("source-v2"));
  });
});
