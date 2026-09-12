/**
 * Shared pure Workspace Pane reducer: unique Tabs, order, MRU, Back/Forward
 * history branch, reading positions, close cleanup, and the restore
 * transition. Deterministic across the Main ↔ Renderer seam so Main can
 * validate persisted Pane snapshots with the same rules the Renderer applies.
 */

/** Reserved singleton identity for the Graph Workspace Tab. */
export const WORKSPACE_GRAPH_TAB_ID = "\u0000wikilot:graph";

/** Schema version stored on every persisted Pane snapshot. */
export const WORKSPACE_PANE_STATE_VERSION = 4;

export type WorkspaceTabMode = "reading" | "editing";
export type WorkspaceEditorSelection = { anchor: number; head: number };
export type WorkspacePanePdfZoom = number | "fit-width";
export type WorkspacePanePdfView = {
  page: number;
  inPage: number;
  zoom: WorkspacePanePdfZoom;
};
export type WorkspacePaneReadingMode = "normal" | "wide";
export type WorkspaceColumnWidths = { sidebar: number; pane: number };

/**
 * Live Workspace Pane navigation state. Tabs are Workspace-relative `/`
 * paths; order is display order and follows the single-tab-per-path rule.
 */
export type WorkspacePaneState = {
  /** Preferred column widths; unset until the user resizes this Workspace. */
  columnWidths?: WorkspaceColumnWidths;
  /** Open Workspace Tab paths in display order (at most one per path). */
  tabs: string[];
  /** The active Tab path, or null when no Tab is open. */
  activePath: string | null;
  /** Most recently activated paths first (kept even when inactive). */
  mru: string[];
  /** Reading position (scrollTop px) per open Tab path. */
  positions: Record<string, number>;
  /** Reading/editing mode per open Markdown Tab. New Tabs default to reading. */
  modes: Record<string, WorkspaceTabMode>;
  /** CodeMirror selection per Tab; reading scroll remains in positions. */
  editorSelections: Record<string, WorkspaceEditorSelection>;
  /** PDF-specific reading position and zoom per open Tab. */
  pdfViews: Record<string, WorkspacePanePdfView>;
  /** Reading width shared by every Tab in this Workspace Pane. */
  readingMode: WorkspacePaneReadingMode;
  /** Whether the work surface is shown; independent of its open Tabs. */
  visible: boolean;
  /**
   * Back/Forward navigation record of Tab identities. History only ever
   * references open Tabs: closing a Tab deletes its entries, and history
   * never reopens a closed Tab.
   */
  history: string[];
  /** Index into `history`; -1 when history is empty. */
  historyIndex: number;
};

/** Versioned serialized form persisted by Main and restored by the Renderer. */
export type WorkspacePaneSnapshot = {
  columnWidths?: WorkspaceColumnWidths;
  version: typeof WORKSPACE_PANE_STATE_VERSION;
  tabs: string[];
  activePath: string | null;
  mru: string[];
  positions: Record<string, number>;
  modes: Record<string, WorkspaceTabMode>;
  editorSelections: Record<string, WorkspaceEditorSelection>;
  pdfViews: Record<string, WorkspacePanePdfView>;
  readingMode: WorkspacePaneReadingMode;
  /** Whether the work surface is shown; independent of its open Tabs. */
  visible: boolean;
  history: string[];
  historyIndex: number;
};

/** Pane restore outcome delivered to the Renderer after validation. */
export type WorkspacePaneRestoreResult = {
  state: WorkspacePaneState;
  /** Number of invalid stored items dropped during restore. */
  skipped: number;
  /** One-time warning after malformed persistence was backed up and reset. */
  warning?: string;
};

export function initialWorkspacePaneState(): WorkspacePaneState {
  return {
    tabs: [],
    activePath: null,
    mru: [],
    positions: {},
    modes: {},
    editorSelections: {},
    pdfViews: {},
    readingMode: "normal",
    visible: false,
    history: [],
    historyIndex: -1,
  };
}

export function toWorkspacePaneSnapshot(
  state: WorkspacePaneState,
): WorkspacePaneSnapshot {
  return {
    version: WORKSPACE_PANE_STATE_VERSION,
    ...(state.columnWidths ? { columnWidths: { ...state.columnWidths } } : {}),
    tabs: [...state.tabs],
    activePath: state.activePath,
    mru: [...state.mru],
    positions: { ...state.positions },
    modes: { ...state.modes },
    editorSelections: Object.fromEntries(
      Object.entries(state.editorSelections).map(([path, selection]) => [
        path,
        { ...selection },
      ]),
    ),
    pdfViews: { ...state.pdfViews },
    readingMode: state.readingMode,
    visible: state.visible,
    history: [...state.history],
    historyIndex: state.historyIndex,
  };
}

function touchMru(mru: string[], path: string): string[] {
  return [path, ...mru.filter((item) => item !== path)];
}

/**
 * Navigation onto `path` truncates the forward history branch and appends an
 * entry. Re-navigating onto the current entry never duplicates the push.
 */
function navigatePane(
  state: WorkspacePaneState,
  path: string,
): WorkspacePaneState {
  const branch = state.history.slice(0, state.historyIndex + 1);
  if (branch.at(-1) === path) {
    return { ...state, visible: true, activePath: path, mru: touchMru(state.mru, path) };
  }
  const history = [...branch, path];
  return {
    ...state,
    activePath: path,
    visible: true,
    mru: touchMru(state.mru, path),
    history,
    historyIndex: history.length - 1,
  };
}

/** Open or activate the Workspace's singleton Graph Tab. */
export function openWorkspaceGraphTab(
  state: WorkspacePaneState,
): WorkspacePaneState {
  if (!state.tabs.includes(WORKSPACE_GRAPH_TAB_ID)) {
    return navigatePane(
      { ...state, tabs: [...state.tabs, WORKSPACE_GRAPH_TAB_ID] },
      WORKSPACE_GRAPH_TAB_ID,
    );
  }
  return navigatePane(state, WORKSPACE_GRAPH_TAB_ID);
}

/** Open a Tab (or activate it when its path is already open, without reordering). */
export function openWorkspacePaneTab(
  state: WorkspacePaneState,
  path: string,
): WorkspacePaneState {
  if (!state.tabs.includes(path)) {
    return navigatePane(
      {
        ...state,
        tabs: [...state.tabs, path],
        modes: { ...state.modes, [path]: "reading" },
      },
      path,
    );
  }
  return navigatePane(state, path);
}

/** Activate an already-open Tab. */
export function activateWorkspacePaneTab(
  state: WorkspacePaneState,
  path: string,
): WorkspacePaneState {
  if (!state.tabs.includes(path)) return state;
  return navigatePane(state, path);
}

/**
 * Close a Tab: drops its position, deletes every history entry referencing
 * it, and activates the MRU remaining Tab only when the active Tab closed.
 */
export function closeWorkspacePaneTab(
  state: WorkspacePaneState,
  path: string,
): WorkspacePaneState {
  if (!state.tabs.includes(path)) return state;
  const tabs = state.tabs.filter((tab) => tab !== path);
  const mru = state.mru.filter((item) => item !== path);
  const positions = { ...state.positions };
  delete positions[path];
  const modes = { ...state.modes };
  delete modes[path];
  const editorSelections = { ...state.editorSelections };
  delete editorSelections[path];
  const pdfViews = { ...state.pdfViews };
  delete pdfViews[path];
  const history = state.history.filter((entry) => entry !== path);
  const removedBefore = state.history
    .slice(0, state.historyIndex)
    .filter((entry) => entry === path).length;
  let historyIndex = state.historyIndex - removedBefore;
  if (history.length === 0) historyIndex = -1;
  else if (historyIndex > history.length - 1) historyIndex = history.length - 1;

  if (state.activePath !== path) {
    return {
      ...state, tabs, mru, positions, modes, editorSelections,
      pdfViews, history, historyIndex,
    };
  }
  const nextActive = mru.find((item) => tabs.includes(item)) ?? null;
  return {
    tabs,
    activePath: nextActive,
    mru: nextActive ? touchMru(mru, nextActive) : mru,
    positions,
    modes,
    editorSelections,
    pdfViews,
    readingMode: tabs.length ? state.readingMode : "normal",
    visible: tabs.length > 0 && state.visible,
    history,
    historyIndex,
  };
}

export function reorderWorkspacePaneTabs(
  state: WorkspacePaneState,
  fromPath: string,
  toPath: string,
  insertion: "before" | "after",
): WorkspacePaneState {
  const from = state.tabs.indexOf(fromPath);
  const to = state.tabs.indexOf(toPath);
  if (from < 0 || to < 0 || from === to) return state;
  const tabs = [...state.tabs];
  const [tab] = tabs.splice(from, 1);
  const target = tabs.indexOf(toPath);
  tabs.splice(target + (insertion === "before" ? 0 : 1), 0, tab!);
  return { ...state, tabs };
}

/**
 * Update the reading position of one open Tab. Scroll and cursor movement
 * never create history entries; they only move the current position.
 */
export function setWorkspacePanePosition(
  state: WorkspacePaneState,
  path: string,
  position: number,
): WorkspacePaneState {
  if (!state.tabs.includes(path)) return state;
  if (
    typeof position !== "number" ||
    !Number.isFinite(position) ||
    position < 0
  ) {
    return state;
  }
  if (state.positions[path] === position) return state;
  return { ...state, positions: { ...state.positions, [path]: position } };
}

export function setWorkspacePaneMode(
  state: WorkspacePaneState,
  path: string,
  mode: WorkspaceTabMode,
): WorkspacePaneState {
  if (!state.tabs.includes(path) || state.modes[path] === mode) return state;
  return { ...state, modes: { ...state.modes, [path]: mode } };
}

export function setWorkspacePaneEditorSelection(
  state: WorkspacePaneState,
  path: string,
  selection: WorkspaceEditorSelection,
): WorkspacePaneState {
  if (
    !state.tabs.includes(path) ||
    !isIntInRange(selection.anchor, 0, Number.MAX_SAFE_INTEGER) ||
    !isIntInRange(selection.head, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return state;
  }
  const current = state.editorSelections[path];
  if (current?.anchor === selection.anchor && current.head === selection.head) return state;
  return {
    ...state,
    editorSelections: {
      ...state.editorSelections,
      [path]: { ...selection },
    },
  };
}

export function setWorkspacePanePdfView(
  state: WorkspacePaneState,
  path: string,
  view: WorkspacePanePdfView,
): WorkspacePaneState {
  if (!state.tabs.includes(path)) return state;
  if (
    !Number.isSafeInteger(view.page) ||
    view.page < 1 ||
    !Number.isFinite(view.inPage) ||
    view.inPage < 0 ||
    view.inPage > 1 ||
    !(view.zoom === "fit-width" ||
      (Number.isFinite(view.zoom) && view.zoom >= 0.5 && view.zoom <= 3))
  ) return state;
  return { ...state, pdfViews: { ...state.pdfViews, [path]: view } };
}

export function setWorkspacePaneReadingMode(
  state: WorkspacePaneState,
  mode: WorkspacePaneReadingMode,
): WorkspacePaneState {
  if (!state.activePath || state.readingMode === mode) return state;
  return { ...state, readingMode: mode };
}

export function paneCanGoBack(state: WorkspacePaneState): boolean {
  return state.historyIndex > 0;
}

export function paneCanGoForward(state: WorkspacePaneState): boolean {
  return state.historyIndex >= 0 && state.historyIndex < state.history.length - 1;
}

export function backWorkspacePaneHistory(
  state: WorkspacePaneState,
): WorkspacePaneState {
  if (!paneCanGoBack(state)) return state;
  const index = state.historyIndex - 1;
  const path = state.history[index]!;
  return {
    ...state,
    activePath: path,
    visible: true,
    historyIndex: index,
    mru: touchMru(state.mru, path),
  };
}

export function forwardWorkspacePaneHistory(
  state: WorkspacePaneState,
): WorkspacePaneState {
  if (!paneCanGoForward(state)) return state;
  const index = state.historyIndex + 1;
  const path = state.history[index]!;
  return {
    ...state,
    activePath: path,
    visible: true,
    historyIndex: index,
    mru: touchMru(state.mru, path),
  };
}

/** Workspace-relative `/` path a Tab may reference. */
export function isSafeWorkspacePanePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** A Pane Tab identity is either a safe file path or the reserved Graph identity. */
export function isWorkspacePaneTabIdentity(value: unknown): value is string {
  return value === WORKSPACE_GRAPH_TAB_ID || isSafeWorkspacePanePath(value);
}

function isIntInRange(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

/**
 * Restore transition: validate a persisted snapshot item by item, dropping
 * every invalid item independently and counting it. Returns null only when
 * the snapshot is fully corrupt (wrong shape or schema version) — callers
 * back it up and reset.
 */
export function sanitizeWorkspacePaneSnapshot(
  value: unknown,
): { state: WorkspacePaneState; skipped: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (input.version !== WORKSPACE_PANE_STATE_VERSION || typeof input.visible !== "boolean") return null;

  let skipped = 0;
  let columnWidths: WorkspaceColumnWidths | undefined;
  if (input.columnWidths !== undefined) {
    const widths = input.columnWidths as Partial<WorkspaceColumnWidths> | null;
    if (widths && typeof widths === "object"
      && typeof widths.sidebar === "number" && Number.isFinite(widths.sidebar) && widths.sidebar >= 200 && widths.sidebar <= 480
      && typeof widths.pane === "number" && Number.isFinite(widths.pane) && widths.pane >= 320) {
      columnWidths = { sidebar: widths.sidebar, pane: widths.pane };
    } else skipped += 1;
  }

  const tabs: string[] = [];
  const tabsValue = input.tabs;
  if (Array.isArray(tabsValue)) {
    for (const item of tabsValue) {
      if (isWorkspacePaneTabIdentity(item) && !tabs.includes(item)) tabs.push(item);
      else skipped += 1;
    }
  } else {
    tabsValue !== undefined && (skipped += 1);
  }

  let activePath: string | null = null;
  const activeValue = input.activePath;
  if (activeValue === null) {
    // A legitimately empty Pane persists a null active Tab; the fallback
    // below only repairs a pane that has Tabs but no valid active one.
  } else if (activeValue !== undefined) {
    if (isWorkspacePaneTabIdentity(activeValue) && tabs.includes(activeValue)) {
      activePath = activeValue;
    } else {
      skipped += 1;
    }
  }

  const mru: string[] = [];
  const mruValue = input.mru;
  if (Array.isArray(mruValue)) {
    for (const item of mruValue) {
      if (
        isWorkspacePaneTabIdentity(item) &&
        tabs.includes(item) &&
        !mru.includes(item)
      ) {
        mru.push(item);
      } else {
        skipped += 1;
      }
    }
  } else {
    mruValue !== undefined && (skipped += 1);
  }

  const positions: Record<string, number> = {};
  const positionsValue = input.positions;
  if (
    typeof positionsValue === "object" &&
    positionsValue !== null &&
    !Array.isArray(positionsValue)
  ) {
    for (const [path, position] of Object.entries(
      positionsValue as Record<string, unknown>,
    )) {
      if (
        isSafeWorkspacePanePath(path) &&
        tabs.includes(path) &&
        typeof position === "number" &&
        Number.isFinite(position) &&
        position >= 0
      ) {
        positions[path] = position;
      } else {
        skipped += 1;
      }
    }
  } else {
    positionsValue !== undefined && (skipped += 1);
  }

  const modes: Record<string, WorkspaceTabMode> = {};
  const modesValue = input.modes;
  if (typeof modesValue === "object" && modesValue !== null && !Array.isArray(modesValue)) {
    for (const [path, mode] of Object.entries(modesValue as Record<string, unknown>)) {
      if (isSafeWorkspacePanePath(path) && tabs.includes(path) && (mode === "reading" || mode === "editing")) {
        modes[path] = mode;
      } else {
        skipped += 1;
      }
    }
  } else if (modesValue !== undefined) {
    skipped += 1;
  }
  for (const path of tabs) {
    if (path !== WORKSPACE_GRAPH_TAB_ID) modes[path] ??= "reading";
  }

  const editorSelections: Record<string, WorkspaceEditorSelection> = {};
  const selectionsValue = input.editorSelections;
  if (typeof selectionsValue === "object" && selectionsValue !== null && !Array.isArray(selectionsValue)) {
    for (const [path, raw] of Object.entries(selectionsValue as Record<string, unknown>)) {
      const selection = raw as Record<string, unknown> | null;
      if (
        isSafeWorkspacePanePath(path) &&
        tabs.includes(path) &&
        selection !== null &&
        typeof selection === "object" &&
        isIntInRange(selection.anchor, 0, Number.MAX_SAFE_INTEGER) &&
        isIntInRange(selection.head, 0, Number.MAX_SAFE_INTEGER)
      ) {
        editorSelections[path] = { anchor: selection.anchor, head: selection.head };
      } else {
        skipped += 1;
      }
    }
  } else if (selectionsValue !== undefined) {
    skipped += 1;
  }

  const pdfViews: Record<string, WorkspacePanePdfView> = {};
  const pdfViewsValue = input.pdfViews;
  if (typeof pdfViewsValue === "object" && pdfViewsValue !== null && !Array.isArray(pdfViewsValue)) {
    for (const [path, rawView] of Object.entries(pdfViewsValue as Record<string, unknown>)) {
      const view = rawView as Partial<WorkspacePanePdfView> | null;
      if (
        tabs.includes(path) && view && Number.isSafeInteger(view.page) && view.page! >= 1 &&
        typeof view.inPage === "number" && Number.isFinite(view.inPage) && view.inPage >= 0 && view.inPage <= 1 &&
        (view.zoom === "fit-width" || (typeof view.zoom === "number" && Number.isFinite(view.zoom) && view.zoom >= 0.5 && view.zoom <= 3))
      ) pdfViews[path] = { page: view.page!, inPage: view.inPage, zoom: view.zoom };
      else skipped += 1;
    }
  } else if (pdfViewsValue !== undefined) skipped += 1;

  const readingMode = input.readingMode === "wide" ? "wide" : "normal";
  if (input.readingMode !== undefined && input.readingMode !== "normal" && input.readingMode !== "wide") skipped += 1;

  const history: string[] = [];
  const historyValue = input.history;
  if (Array.isArray(historyValue)) {
    for (const item of historyValue) {
      if (isWorkspacePaneTabIdentity(item) && tabs.includes(item)) {
        history.push(item);
      } else {
        skipped += 1;
      }
    }
  } else {
    historyValue !== undefined && (skipped += 1);
  }

  let historyIndex = -1;
  if (history.length > 0) {
    const rawIndex = input.historyIndex;
    if (isIntInRange(rawIndex, 0, history.length - 1)) {
      historyIndex = rawIndex;
    } else {
      if (rawIndex !== undefined) skipped += 1;
      historyIndex = Math.min(
        Math.max(typeof rawIndex === "number" && Number.isFinite(rawIndex) ? Math.trunc(rawIndex) : 0, 0),
        history.length - 1,
      );
    }
  }

  // Restore keeps the pane consistent: with Tabs open the active Tab is
  // always set — the MRU Tab first, otherwise the first Tab.
  if (tabs.length > 0 && activePath === null) {
    activePath = mru.find((path) => tabs.includes(path)) ?? tabs[0]!;
  }

  return {
    state: {
      ...(columnWidths ? { columnWidths } : {}),
      tabs, activePath, mru, positions, modes, editorSelections,
      pdfViews, readingMode: tabs.length ? readingMode : "normal",
      visible: tabs.length > 0 && input.visible, history, historyIndex,
    },
    skipped,
  };
}
