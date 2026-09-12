import { describe, expect, it } from "vitest";
import {
  activateWorkspacePaneTab,
  backWorkspacePaneHistory,
  closeWorkspacePaneTab,
  forwardWorkspacePaneHistory,
  initialWorkspacePaneState,
  openWorkspaceGraphTab,
  openWorkspacePaneTab,
  paneCanGoBack,
  paneCanGoForward,
  reorderWorkspacePaneTabs,
  sanitizeWorkspacePaneSnapshot,
  setWorkspacePaneEditorSelection,
  setWorkspacePaneMode,
  setWorkspacePanePosition,
  setWorkspacePanePdfView,
  setWorkspacePaneReadingMode,
  toWorkspacePaneSnapshot,
  WORKSPACE_GRAPH_TAB_ID,
  WORKSPACE_PANE_STATE_VERSION,
} from "./pane-state";

describe("workspace pane reducer", () => {
  it("reveals existing destinations while ordinary updates preserve hidden state", () => {
    let state = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    state = { ...state, visible: false };
    state = setWorkspacePanePosition(state, "a.md", 120);
    expect(state.visible).toBe(false);
    const revealed = openWorkspacePaneTab(state, "a.md");
    expect(revealed).toMatchObject({ visible: true, tabs: ["a.md"], positions: { "a.md": 120 } });
    const graph = openWorkspaceGraphTab({ ...openWorkspaceGraphTab(revealed), visible: false });
    expect(graph.visible).toBe(true);
    expect(closeWorkspacePaneTab(graph, "a.md").visible).toBe(true);
    expect(closeWorkspacePaneTab(closeWorkspacePaneTab(graph, "a.md"), WORKSPACE_GRAPH_TAB_ID))
      .toMatchObject({ visible: false, readingMode: "normal", tabs: [] });
  });

  it("restores hidden tabs and width, but starts empty Workspaces collapsed", () => {
    const state = { ...setWorkspacePaneReadingMode(openWorkspacePaneTab(initialWorkspacePaneState(), "a.md"), "wide"), visible: false };
    expect(sanitizeWorkspacePaneSnapshot(toWorkspacePaneSnapshot(state))?.state).toEqual(state);
    const empty = { ...initialWorkspacePaneState(), visible: true };
    expect(sanitizeWorkspacePaneSnapshot(toWorkspacePaneSnapshot(empty))?.state.visible).toBe(false);
  });

  it("opens each path once, appends new paths, and activates without reordering", () => {
    let state = initialWorkspacePaneState();
    expect(state).toEqual({
      tabs: [],
      activePath: null,
      mru: [],
      positions: {},
      modes: {},
      editorSelections: {},
      pdfViews: {},
      visible: false,
      readingMode: "normal",
      history: [],
      historyIndex: -1,
    });
    state = openWorkspacePaneTab(state, "a.md");
    state = openWorkspacePaneTab(state, "b.md");
    state = openWorkspacePaneTab(state, "a.md");
    expect(state.tabs).toEqual(["a.md", "b.md"]);
    expect(state.activePath).toBe("a.md");
    expect(state.mru).toEqual(["a.md", "b.md"]);
    expect(state.modes).toEqual({ "a.md": "reading", "b.md": "reading" });
  });

  it("keeps one Graph Tab and returns from Markdown through Pane history", () => {
    let state = openWorkspaceGraphTab(initialWorkspacePaneState());
    state = openWorkspaceGraphTab(state);
    state = openWorkspacePaneTab(state, "notes/a.md");

    expect(state.tabs).toEqual([WORKSPACE_GRAPH_TAB_ID, "notes/a.md"]);
    expect(state.modes).toEqual({ "notes/a.md": "reading" });
    expect(backWorkspacePaneHistory(state).activePath).toBe(WORKSPACE_GRAPH_TAB_ID);
    expect(sanitizeWorkspacePaneSnapshot(toWorkspacePaneSnapshot(state))).toEqual({
      state,
      skipped: 0,
    });
  });

  it("records back/forward history entries on open and activation only", () => {
    let state = initialWorkspacePaneState();
    state = openWorkspacePaneTab(state, "a.md");
    state = openWorkspacePaneTab(state, "b.md");
    expect(state.history).toEqual(["a.md", "b.md"]);
    expect(state.historyIndex).toBe(1);
    // Re-activating the active path does not push a duplicate entry.
    state = activateWorkspacePaneTab(state, "b.md");
    expect(state.history).toEqual(["a.md", "b.md"]);
    expect(state.historyIndex).toBe(1);
    // Switching to another tab branches the history forward.
    state = activateWorkspacePaneTab(state, "a.md");
    expect(state.history).toEqual(["a.md", "b.md", "a.md"]);
    expect(state.historyIndex).toBe(2);
  });

  it("back and forward move through the history branch and restore the tab", () => {
    let state = initialWorkspacePaneState();
    for (const path of ["a.md", "b.md", "c.md"]) {
      state = openWorkspacePaneTab(state, path);
    }
    expect(paneCanGoBack(state)).toBe(true);
    expect(paneCanGoForward(state)).toBe(false);

    state = backWorkspacePaneHistory(state);
    expect(state.activePath).toBe("b.md");
    expect(state.historyIndex).toBe(1);
    expect(paneCanGoForward(state)).toBe(true);

    state = backWorkspacePaneHistory(state);
    expect(state.activePath).toBe("a.md");
    expect(state.historyIndex).toBe(0);
    expect(paneCanGoBack(state)).toBe(false);

    expect(backWorkspacePaneHistory(state)).toBe(state);
    state = forwardWorkspacePaneHistory(state);
    expect(state.activePath).toBe("b.md");
    state = forwardWorkspacePaneHistory(forwardWorkspacePaneHistory(state));
    expect(state.activePath).toBe("c.md");
    expect(paneCanGoForward(state)).toBe(false);
    expect(forwardWorkspacePaneHistory(state)).toBe(state);
  });

  it("branches history instead of reopening a closed forward branch", () => {
    let state = initialWorkspacePaneState();
    for (const path of ["a.md", "b.md", "c.md"]) {
      state = openWorkspacePaneTab(state, path);
    }
    state = backWorkspacePaneHistory(state);
    state = openWorkspacePaneTab(state, "d.md");
    expect(state.history).toEqual(["a.md", "b.md", "d.md"]);
    expect(state.historyIndex).toBe(2);
    expect(paneCanGoForward(state)).toBe(false);
  });

  it("updates reading positions without touching history", () => {
    let state = initialWorkspacePaneState();
    for (const path of ["a.md", "b.md"]) {
      state = openWorkspacePaneTab(state, path);
    }
    state = setWorkspacePanePosition(state, "b.md", 320);
    expect(state.positions).toEqual({ "b.md": 320 });
    expect(state.history).toEqual(["a.md", "b.md"]);
    state = backWorkspacePaneHistory(state);
    expect(activateWorkspacePaneTab(state, "b.md").positions).toEqual({ "b.md": 320 });
    expect(setWorkspacePanePosition(state, "missing.md", 10)).toBe(state);
    expect(setWorkspacePanePosition(state, "a.md", -5)).toBe(state);
  });

  it("keeps reading mode and scroll independent from editing selection", () => {
    let state = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    const history = state.history;
    state = setWorkspacePanePosition(state, "a.md", 120);
    state = setWorkspacePaneMode(state, "a.md", "editing");
    state = setWorkspacePaneEditorSelection(state, "a.md", { anchor: 7, head: 11 });

    expect(state.modes["a.md"]).toBe("editing");
    expect(state.positions["a.md"]).toBe(120);
    expect(state.editorSelections["a.md"]).toEqual({ anchor: 7, head: 11 });
    expect(state.history).toBe(history);
    expect(setWorkspacePaneEditorSelection(state, "missing.md", { anchor: 0, head: 0 })).toBe(state);
  });

  it("persists PDF page, in-page position, zoom, and the Pane reading mode", () => {
    let state = openWorkspacePaneTab(initialWorkspacePaneState(), "paper.pdf");
    state = setWorkspacePanePdfView(state, "paper.pdf", {
      page: 37,
      inPage: 0.42,
      zoom: "fit-width",
    });
    state = setWorkspacePaneReadingMode(state, "wide");
    expect(state.pdfViews["paper.pdf"]).toEqual({
      page: 37,
      inPage: 0.42,
      zoom: "fit-width",
    });
    expect(state.readingMode).toBe("wide");
    expect(closeWorkspacePaneTab(state, "paper.pdf")).toMatchObject({
      pdfViews: {},
      visible: false,
      readingMode: "normal",
    });
  });

  it("keeps wide mode active when switching between Workspace Tabs", () => {
    let state = openWorkspacePaneTab(initialWorkspacePaneState(), "a.md");
    state = openWorkspacePaneTab(state, "b.md");
    state = activateWorkspacePaneTab(state, "a.md");
    state = setWorkspacePaneReadingMode(state, "wide");
    state = activateWorkspacePaneTab(state, "b.md");

    expect(state.readingMode).toBe("wide");
  });

  it("closes the active tab to the most recently used remaining tab", () => {
    let state = initialWorkspacePaneState();
    for (const path of ["a.md", "b.md", "c.md"]) state = openWorkspacePaneTab(state, path);
    state = activateWorkspacePaneTab(state, "a.md");
    state = activateWorkspacePaneTab(state, "b.md");
    const closed = closeWorkspacePaneTab(state, "b.md");
    expect(closed.activePath).toBe("a.md");
    expect(closed.tabs).toEqual(["a.md", "c.md"]);
    expect(closed.mru).not.toContain("b.md");
  });

  it("does not change the active tab when a background tab closes", () => {
    let state = initialWorkspacePaneState();
    for (const path of ["a.md", "b.md"]) state = openWorkspacePaneTab(state, path);
    const closed = closeWorkspacePaneTab(state, "a.md");
    expect(closed.activePath).toBe("b.md");
    expect(closed.tabs).toEqual(["b.md"]);
  });

  it("closing a tab deletes its history entries and never reopens them", () => {
    let state = initialWorkspacePaneState();
    for (const path of ["a.md", "b.md", "c.md"]) state = openWorkspacePaneTab(state, path);
    state = closeWorkspacePaneTab(state, "b.md");
    expect(state.history).toEqual(["a.md", "c.md"]);
    expect(state.historyIndex).toBe(1);
    expect(state.activePath).toBe("c.md");
    expect(state.mru).not.toContain("b.md");
    expect(state.positions).not.toHaveProperty("b.md");
    expect(state.modes).not.toHaveProperty("b.md");
    expect(state.editorSelections).not.toHaveProperty("b.md");

    // History ahead of a deleted entry collapses so back lands correctly.
    state = openWorkspacePaneTab(state, "d.md");
    state = backWorkspacePaneHistory(state);
    expect(state.activePath).toBe("c.md");
    state = backWorkspacePaneHistory(state);
    expect(state.activePath).toBe("a.md");
    expect(backWorkspacePaneHistory(state)).toBe(state);
  });

  it("reorders tabs while preserving activation", () => {
    let state = initialWorkspacePaneState();
    for (const path of ["a.md", "b.md", "c.md"]) state = openWorkspacePaneTab(state, path);
    state = reorderWorkspacePaneTabs(state, "c.md", "a.md", "before");
    expect(state.tabs).toEqual(["c.md", "a.md", "b.md"]);
    expect(state.activePath).toBe("c.md");

    state = reorderWorkspacePaneTabs(state, "c.md", "b.md", "after");
    expect(state.tabs).toEqual(["a.md", "b.md", "c.md"]);
    expect(state.activePath).toBe("c.md");
  });
});

describe("workspace pane snapshot sanitize", () => {
  it("round-trips preferred column widths independently of open tabs", () => {
    const state = { ...initialWorkspacePaneState(), columnWidths: { sidebar: 300, pane: 900 } };
    expect(sanitizeWorkspacePaneSnapshot(toWorkspacePaneSnapshot(state))).toEqual({ state, skipped: 0 });
    for (const columnWidths of [{ sidebar: 0, pane: 900 }, { sidebar: 300, pane: -1 }, { sidebar: 300, pane: Infinity }]) {
      expect(sanitizeWorkspacePaneSnapshot({ ...toWorkspacePaneSnapshot(state), columnWidths }))
        .toEqual({ state: initialWorkspacePaneState(), skipped: 1 });
    }
  });

  it("restores a legitimately empty Pane without counting items as skipped", () => {
    const restored = sanitizeWorkspacePaneSnapshot({
      version: WORKSPACE_PANE_STATE_VERSION,
      tabs: [],
      activePath: null,
      mru: [],
      positions: {},
      modes: {},
      editorSelections: {},
      pdfViews: {},
      visible: true,
      readingMode: "normal",
      history: [],
      historyIndex: -1,
    });
    expect(restored).toEqual({ state: initialWorkspacePaneState(), skipped: 0 });
  });

  it("round-trips a valid snapshot through save and restore", () => {
    let state = initialWorkspacePaneState();
    for (const path of ["a.md", "b.md"]) state = openWorkspacePaneTab(state, path);
    state = setWorkspacePanePosition(state, "a.md", 42);
    state = backWorkspacePaneHistory(state);

    const snapshot = toWorkspacePaneSnapshot(state);
    expect(snapshot.version).toBe(WORKSPACE_PANE_STATE_VERSION);
    const restored = sanitizeWorkspacePaneSnapshot(JSON.parse(JSON.stringify(snapshot)));
    expect(restored).toEqual({ state, skipped: 0 });
  });

  it("drops invalid items independently and counts them", () => {
    const result = sanitizeWorkspacePaneSnapshot({
      version: WORKSPACE_PANE_STATE_VERSION,
      tabs: ["a.md", "/etc/passwd", "b.md", "a.md", "../escape.md", "notes/bad\u0000name.md"],
      activePath: "/etc/passwd",
      mru: ["b.md", "missing.md", "b.md", "a.md"],
      positions: { "a.md": 10, "b.md": "deep", "missing.md": 5 },
      modes: { "a.md": "editing", "b.md": "reading", "missing.md": "editing" },
      editorSelections: { "a.md": { anchor: 2, head: 3 }, "b.md": { anchor: -1, head: 0 } },
      pdfViews: {},
      visible: true,
      readingMode: "normal",
      history: ["b.md", "a.md", "missing.md"],
      historyIndex: 4,
    });
    expect(result?.state.tabs).toEqual(["a.md", "b.md"]);
    expect(result?.state.activePath).toBe("b.md");
    expect(result?.state.mru).toEqual(["b.md", "a.md"]);
    expect(result?.state.positions).toEqual({ "a.md": 10 });
    expect(result?.state.modes).toEqual({ "a.md": "editing", "b.md": "reading" });
    expect(result?.state.editorSelections).toEqual({ "a.md": { anchor: 2, head: 3 } });
    expect(result?.state.history).toEqual(["b.md", "a.md"]);
    expect(result?.state.historyIndex).toBe(1);
    expect(result?.skipped).toBeGreaterThan(0);
  });

  it("falls back the active path to MRU then the first tab", () => {
    const mruRestore = sanitizeWorkspacePaneSnapshot({
      version: WORKSPACE_PANE_STATE_VERSION,
      tabs: ["a.md", "b.md"],
      activePath: null,
      mru: ["b.md"],
      positions: {},
      modes: { "a.md": "reading", "b.md": "editing" },
      editorSelections: {},
      pdfViews: {},
      visible: true,
      readingMode: "normal",
      history: [],
      historyIndex: -1,
    });
    expect(mruRestore?.state.activePath).toBe("b.md");

    const firstRestore = sanitizeWorkspacePaneSnapshot({
      version: WORKSPACE_PANE_STATE_VERSION,
      tabs: ["a.md", "b.md"],
      activePath: "missing.md",
      mru: [],
      positions: {},
      modes: { "a.md": "reading", "b.md": "reading" },
      editorSelections: {},
      pdfViews: {},
      visible: true,
      readingMode: "normal",
      history: [],
      historyIndex: -1,
    });
    expect(firstRestore?.state.activePath).toBe("a.md");
  });

  it.each([
    ["object", { nested: true }],
    ["array", [{ version: WORKSPACE_PANE_STATE_VERSION }]],
    ["missing version", { tabs: ["a.md"] }],
    ["old version", { version: 1, tabs: [] }],
  ])("treats %s persistence as fully corrupt", (_case, value) => {
    expect(sanitizeWorkspacePaneSnapshot(value)).toBeNull();
  });
});
