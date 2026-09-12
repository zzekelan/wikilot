import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { ArrowLeft, ArrowRight, File, FileText, FileWarning, Info, Maximize2, Minimize2, Network, Paperclip, X } from "lucide-react";
import type { ContextClip, MarkdownContextClip } from "../../shared/session";
import type {
  MarkdownDocumentSnapshot,
  WorkspaceLinkIndexSnapshot,
  WorkspaceLinkResolution,
  WorkspaceLinkResolveRequest,
  WorkspaceLinkTarget,
  WorkspacePdfSource,
  WorkspacePropertyRegistration,
} from "../../shared/workspace";
import {
  activateWorkspacePaneTab,
  backWorkspacePaneHistory,
  closeWorkspacePaneTab,
  forwardWorkspacePaneHistory,
  paneCanGoBack,
  paneCanGoForward,
  openWorkspacePaneTab,
  reorderWorkspacePaneTabs,
  setWorkspacePaneEditorSelection,
  setWorkspacePaneMode,
  setWorkspacePanePdfView,
  setWorkspacePanePosition,
  type WorkspaceGraphSnapshot,
  type WorkspacePaneState,
  WORKSPACE_GRAPH_TAB_ID,
  workspaceHeadingSlug,
} from "../../shared/workspace";
import { client } from "../client";
import { MarkdownText } from "../markdown";
import { pdfFailurePresentation } from "../pdf/pdf-errors";
import { pushEscapeLayer } from "../escape-stack";
import { useShortcuts } from "../shortcuts";
import { buildMarkdownEditingClip, buildMarkdownReadingClip, fingerprintMarkdown, locateMarkdownClip, locateMarkdownReadingClip } from "./context-clip-capture";
import { MarkdownEditor } from "./MarkdownEditor";
import { PropertiesPanel } from "./PropertiesPanel";
import { markdownBodyWithoutFrontmatter } from "./frontmatter-properties";
import { WorkspaceGraph, type WorkspaceGraphViewState } from "./WorkspaceGraph";
import { PdfReader } from "./PdfReader";
import {
  useWorkspaceDocuments,
  type WorkspacePaneSaveController,
} from "./useWorkspaceDocuments";
import "./WorkspacePane.css";

type WorkspacePaneRestoreReport = { skipped: number; warning?: string };
export type { WorkspacePaneSaveController } from "./useWorkspaceDocuments";

type WorkspacePaneProps = {
  workspaceId: string;
  tabs: WorkspacePaneState;
  headerActions?: ReactNode;
  compact?: boolean;
  onTabsChange: (tabs: WorkspacePaneState) => void;
  restoring?: boolean;
  connectionRevision?: number;
  restoreReport?: WorkspacePaneRestoreReport | null;
  onDismissRestoreReport?: () => void;
  onSaveControllerChange?: (controller: WorkspacePaneSaveController | null) => void;
  linkIndex?: WorkspaceLinkIndexSnapshot;
  resolveLink?: (request: WorkspaceLinkResolveRequest) => Promise<WorkspaceLinkResolution>;
  onNavigate?: (target: Extract<WorkspaceLinkTarget, { status: "resolved" }>) => void;
  onCreateMissing?: (path: string) => Promise<void>;
  onGraphStatusChange?: (status: WorkspaceGraphSnapshot["status"]) => void;
  linkRevision?: number;
  propertyRegistry?: WorkspacePropertyRegistration[];
  navigationTarget?: Extract<WorkspaceLinkTarget, { status: "resolved" }> | null;
  onNavigationConsumed?: () => void;
  contextClipSessionId?: string;
  onAddContextClip?: (clip: ContextClip) => void;
  contextClipNavigation?: { id: number; clip: ContextClip; pdfSource?: WorkspacePdfSource } | null;
  onContextClipNavigationResult?: (result: "exact" | "relocated" | "changed") => void;
  onWideModeChange?: (mode: "normal" | "wide") => void;
};

function isMarkdownContextClip(clip: ContextClip): clip is MarkdownContextClip {
  return clip.source.kind === "markdown" && clip.locator.kind === "markdown";
}

function fileName(path: string): string {
  if (path === WORKSPACE_GRAPH_TAB_ID) return "Graph";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function WorkspaceFileInfo({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const removeEscape = pushEscapeLayer(() => {
      setOpen(false);
      trigger.current?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      removeEscape();
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);
  return <div className="workspace-file-info" ref={ref}>
    <button ref={trigger} type="button" className="icon-btn" aria-label="File information" title="File information" aria-expanded={open} onClick={() => setOpen(!open)}><Info size={16} /></button>
    {open ? <div className="workspace-file-info-popover" role="region" aria-label="File information"><span>Workspace path</span><code>{path}</code></div> : null}
  </div>;
}

function lockedStateCopy(snapshot: MarkdownDocumentSnapshot) {
  switch (snapshot.status) {
    case "ready": return null;
    case "too-large": return { title: "File is too large to edit", detail: `${snapshot.size} bytes` };
    case "non-utf8": return { title: "File is not UTF-8", detail: "Convert its encoding in another editor." };
    case "waiting": return { title: "Waiting for a stable disk read", detail: "The file is still changing." };
    case "deleted": return { title: "File is not available", detail: "It may have been deleted or moved." };
    case "unavailable": return { title: "File is unavailable", detail: "Wikilot could not safely read it." };
  }
}

function isUnavailableError(message: string): boolean {
  return /not found|does not exist|enoent|no such file|not a file/i.test(message);
}

type CapabilityPdfReaderProps = ComponentProps<typeof PdfReader> & {
  sourceId: string;
  releaseSource(sourceId: string): void;
};

/** Revoke only after the nested Reader has run its request-abort cleanup. */
function CapabilityPdfReader({ sourceId, releaseSource, ...props }: CapabilityPdfReaderProps) {
  const identity = `${sourceId}:${props.sourceVersion ?? ""}:${props.sourcePath}`;
  const pendingRelease = useRef<{
    identity: string;
    cancelled: boolean;
  } | null>(null);
  useEffect(() => {
    if (pendingRelease.current?.identity === identity) {
      pendingRelease.current.cancelled = true;
    }
    return () => {
      const pending = { identity, cancelled: false };
      pendingRelease.current = pending;
      queueMicrotask(() => {
        if (!pending.cancelled) releaseSource(sourceId);
      });
    };
  }, [identity, releaseSource, sourceId]);
  return <PdfReader key={identity} {...props} />;
}

export function WorkspacePane({
  workspaceId,
  tabs,
  onTabsChange,
  headerActions,
  compact = false,
  restoring = false,
  connectionRevision = 0,
  restoreReport = null,
  onDismissRestoreReport,
  onSaveControllerChange,
  linkIndex = { status: "building" },
  resolveLink,
  onNavigate,
  onCreateMissing,
  onGraphStatusChange,
  linkRevision,
  propertyRegistry = [],
  navigationTarget = null,
  onNavigationConsumed,
  contextClipSessionId,
  onAddContextClip,
  contextClipNavigation = null,
  onContextClipNavigationResult,
  onWideModeChange,
}: WorkspacePaneProps) {
  const { registerShortcut } = useShortcuts();
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [draggedPath, setDraggedPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    path: string;
    insertion: "before" | "after";
  } | null>(null);
  const [pendingClip, setPendingClip] = useState<{
    clip: ContextClip;
    position: { left: number; top: number };
  } | null>(null);
  const [editingClipHighlight, setEditingClipHighlight] = useState<{
    id: number;
    start?: number;
    end?: number;
    clear?: boolean;
  } | null>(null);
  const [contextClipHighlightActive, setContextClipHighlightActive] = useState(false);
  const [refreshedPdfNavigationId, setRefreshedPdfNavigationId] = useState<number | null>(null);
  const processedClipNavigation = useRef<number | null>(null);
  const readingClipHighlight = useRef<Range | null>(null);
  const graphViewState = useRef<WorkspaceGraphViewState>({
    positions: new Map(),
    pins: new Map(),
    camera: null,
  });
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const focusPathRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const markdownSurfaceRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollPosition = useRef<{ path: string; position: number } | null>(null);
  const lastObservedScrollPosition = useRef<number | null>(null);
  const scrollSettleFrame = useRef<number | null>(null);
  const [graphSnapshot, setGraphSnapshot] = useState<WorkspaceGraphSnapshot>({ status: "building" });
  const [graphError, setGraphError] = useState<string | null>(null);
  const [graphRetrying, setGraphRetrying] = useState(false);
  const [graphRetry, setGraphRetry] = useState(0);
  const graphOriginPath = useRef<string | null>(
    tabs.mru.find((path) => /\.md$/i.test(path)) ?? null,
  );
  const activePath = tabs.activePath;
  const graphActive = activePath === WORKSPACE_GRAPH_TAB_ID;
  const pdfActive = Boolean(activePath && /\.pdf$/i.test(activePath));
  const enteredPdf = useRef<{ workspaceId: string; path: string } | null>(null);
  useLayoutEffect(() => {
    if (!tabs.visible || !pdfActive || !activePath) {
      enteredPdf.current = null;
      return;
    }
    if (enteredPdf.current?.workspaceId === workspaceId && enteredPdf.current.path === activePath) return;
    enteredPdf.current = { workspaceId, path: activePath };
    // Re-enter at the saved location, fitting the current pane before paint.
    // Manual zoom remains available until the reader is left or hidden.
    const view = tabs.pdfViews[activePath];
    if (view && view.zoom !== "fit-width") {
      onTabsChange(setWorkspacePanePdfView(tabs, activePath, { ...view, zoom: "fit-width" }));
    }
  }, [activePath, onTabsChange, pdfActive, tabs, workspaceId]);
  const documentPath = graphActive ? null : activePath;
  if (documentPath && /\.md$/i.test(documentPath)) graphOriginPath.current = documentPath;
  const {
    documents,
    pdfSource,
    loadError,
    loading,
    loadPath,
    releasePdfSource,
    savePath,
    changeContent,
  } = useWorkspaceDocuments({ workspaceId, activePath: documentPath, onSaveControllerChange, connectionRevision });
  const activeDocument = documentPath ? documents[documentPath] : undefined;
  const activeMode = activePath ? tabs.modes[activePath] ?? "reading" : "reading";
  const readingMode = compact ? "wide" : tabs.readingMode;
  const pdfError = loadError?.code
    ? pdfFailurePresentation(Object.assign(new Error(loadError.message), { code: loadError.code }))
    : null;
  const navigationPdfSource =
    contextClipNavigation?.clip.source.kind === "pdf"
    && contextClipNavigation.clip.source.path === activePath
      ? contextClipNavigation.pdfSource
      : undefined;
  const loadedPdfSource = pdfSource ?? undefined;
  const activePdfSource = navigationPdfSource
    && refreshedPdfNavigationId !== contextClipNavigation?.id
      ? navigationPdfSource
      : loadedPdfSource;

  const shortcutStateRef = useRef({
    activeDocumentStatus: activeDocument?.snapshot.status,
    activeMode,
    activePath,
    onTabsChange,
    savePath,
    tabs,
  });
  shortcutStateRef.current = {
    activeDocumentStatus: activeDocument?.snapshot.status,
    activeMode,
    activePath,
    onTabsChange,
    savePath,
    tabs,
  };

  useEffect(() => {
    if (!tabs.visible) return;
    const unregisters = [
      registerShortcut("meta+shift+e", {
        label: "Toggle Read / Edit",
        when: () => shortcutStateRef.current.activeDocumentStatus === "ready" ? null : "Open an editable Markdown file first",
        handler: () => {
          const current = shortcutStateRef.current;
          if (!current.activePath || current.activeDocumentStatus !== "ready") return;
          current.onTabsChange(setWorkspacePaneMode(
            current.tabs,
            current.activePath,
            current.activeMode === "reading" ? "editing" : "reading",
          ));
        },
      }),
      registerShortcut("meta+s", {
        label: "Save now",
        when: () => shortcutStateRef.current.activeDocumentStatus === "ready" ? null : "Open an editable Markdown file first",
        handler: () => {
          const current = shortcutStateRef.current;
          if (current.activePath) void current.savePath(current.activePath, true);
        },
      }),
      registerShortcut("meta+[", {
        label: "Pane Back",
        when: () => paneCanGoBack(shortcutStateRef.current.tabs) ? null : "No earlier Pane destination",
        handler: () => {
          const current = shortcutStateRef.current;
          current.onTabsChange(backWorkspacePaneHistory(current.tabs));
        },
      }),
      registerShortcut("meta+]", {
        label: "Pane Forward",
        when: () => paneCanGoForward(shortcutStateRef.current.tabs) ? null : "No later Pane destination",
        handler: () => {
          const current = shortcutStateRef.current;
          current.onTabsChange(forwardWorkspacePaneHistory(current.tabs));
        },
      }),
    ];
    return () => unregisters.forEach((unregister) => unregister());
  }, [registerShortcut, tabs.visible]);

  useEffect(() => {
    const request = contextClipNavigation;
    if (
      !request?.pdfSource
      || request.clip.source.kind !== "pdf"
      || request.clip.source.path !== activePath
      || refreshedPdfNavigationId === request.id
    ) return;
    let current = true;
    void loadPath(activePath).then(() => {
      if (current) setRefreshedPdfNavigationId(request.id);
    });
    return () => { current = false; };
  }, [activePath, contextClipNavigation, loadPath, refreshedPdfNavigationId]);

  useEffect(() => {
    let current = true;
    let poll = 0;
    setGraphError(null);
    void client.getWorkspaceGraph(workspaceId).then((snapshot) => {
      if (current) {
        setGraphSnapshot(snapshot);
        setGraphRetrying(false);
        if (snapshot.status !== "ready") {
          poll = window.setTimeout(() => setGraphRetry((value) => value + 1), 600);
        }
      }
    }).catch((error: unknown) => {
      if (current) {
        setGraphError(error instanceof Error ? error.message : String(error));
        setGraphRetrying(false);
      }
    });
    return () => {
      current = false;
      clearTimeout(poll);
    };
  }, [graphRetry, linkRevision, workspaceId]);

  useEffect(() => () => {
    if (scrollSettleFrame.current !== null) cancelAnimationFrame(scrollSettleFrame.current);
  }, []);

  useEffect(() => {
    setEditingClipHighlight(null);
    setContextClipHighlightActive(false);
    const highlighted = readingClipHighlight.current;
    const selection = window.getSelection();
    if (highlighted && selection?.rangeCount) {
      const selected = selection.getRangeAt(0);
      if (
        highlighted.compareBoundaryPoints(Range.START_TO_START, selected) === 0 &&
        highlighted.compareBoundaryPoints(Range.END_TO_END, selected) === 0
      ) selection.removeAllRanges();
    }
    readingClipHighlight.current = null;
  }, [activeMode, activePath]);

  // Restore first so explicit source navigation below has final scroll priority.
  useEffect(() => {
    if (!tabs.visible || !activePath || !bodyRef.current || activeMode !== "reading" || pdfSource) return;
    bodyRef.current.scrollTop = tabs.positions[activePath] ?? 0;
  }, [activePath, activeMode, activeDocument?.snapshot.version, pdfSource, tabs.visible]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const request = contextClipNavigation;
    if (
      !request ||
      processedClipNavigation.current === request.id ||
      request.clip.source.path !== activePath ||
      !isMarkdownContextClip(request.clip) ||
      activeDocument?.snapshot.status !== "ready"
    ) return;
    const mode = request.clip.locator.mode;
    if (activeMode !== mode) {
      onTabsChange(setWorkspacePaneMode(tabs, activePath, mode));
      return;
    }
    if (mode === "reading") {
      const surface = markdownSurfaceRef.current;
      if (!surface) return;
      const previousHighlight = readingClipHighlight.current;
      const currentSelection = window.getSelection();
      if (previousHighlight && currentSelection?.rangeCount) {
        const selected = currentSelection.getRangeAt(0);
        if (
          previousHighlight.compareBoundaryPoints(Range.START_TO_START, selected) === 0 &&
          previousHighlight.compareBoundaryPoints(Range.END_TO_END, selected) === 0
        ) currentSelection.removeAllRanges();
      }
      readingClipHighlight.current = null;
      setContextClipHighlightActive(false);
      const location = locateMarkdownReadingClip(
        surface,
        request.clip,
        fingerprintMarkdown(activeDocument.content),
      );
      processedClipNavigation.current = request.id;
      setPendingClip(null);
      if (location.status !== "changed" && location.range) {
        readingClipHighlight.current = location.range;
        setContextClipHighlightActive(true);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(location.range);
        const rect = location.range.getBoundingClientRect?.();
        const body = bodyRef.current;
        if (rect && body) {
          const viewport = body.getBoundingClientRect();
          body.scrollTop += rect.top - viewport.top - Math.max(0, (body.clientHeight - rect.height) / 2);
        }
      }
      onContextClipNavigationResult?.(location.status);
      return;
    }
    const location = locateMarkdownClip(
      request.clip,
      fingerprintMarkdown(activeDocument.content),
      activeDocument.content,
    );
    processedClipNavigation.current = request.id;
    setPendingClip(null);
    if (location.status === "changed") {
      setEditingClipHighlight({ id: request.id, clear: true });
      setContextClipHighlightActive(false);
      onContextClipNavigationResult?.("changed");
      return;
    }
    setEditingClipHighlight({ id: request.id, start: location.start, end: location.end });
    setContextClipHighlightActive(true);
    onContextClipNavigationResult?.(location.status);
  }, [activeDocument?.content, activeDocument?.snapshot.status, activeMode, activePath, contextClipNavigation, onContextClipNavigationResult, onTabsChange, tabs]);

  useEffect(() => {
    if (
      !navigationTarget
      || navigationTarget.kind !== "markdown"
      || navigationTarget.path !== activePath
      || activeMode !== "reading"
      || activeDocument?.snapshot.status !== "ready"
      || !bodyRef.current
    ) return;
    const frame = requestAnimationFrame(() => {
      if (navigationTarget.heading) {
        bodyRef.current?.querySelector<HTMLElement>(
          `[data-md-heading-slug="${workspaceHeadingSlug(navigationTarget.heading)}"]`,
        )?.scrollIntoView({ block: "start" });
      } else {
        bodyRef.current!.scrollTop = 0;
      }
      onNavigationConsumed?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeDocument?.snapshot.version, activeMode, activePath, navigationTarget, onNavigationConsumed]);

  useEffect(() => {
    if (
      !activePath
      || navigationTarget?.kind !== "pdf"
      || navigationTarget.path !== activePath
      || !pdfSource
    ) return;
    const current = tabs.pdfViews[activePath] ?? { page: 1, inPage: 0, zoom: "fit-width" };
    onTabsChange(setWorkspacePanePdfView(tabs, activePath, {
      ...current,
      page: navigationTarget.page ?? current.page,
      inPage: navigationTarget.page ? 0 : current.inPage,
    }));
    onNavigationConsumed?.();
  }, [activePath, navigationTarget, onNavigationConsumed, onTabsChange, pdfSource, tabs]);

  useEffect(() => {
    const strip = tabStripRef.current;
    if (!strip) return;
    const scrollTabs = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaX !== 0 || event.deltaY === 0) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1;
      const next = Math.max(0, Math.min(strip.scrollWidth - strip.clientWidth, strip.scrollLeft + event.deltaY * unit));
      if (next === strip.scrollLeft) return;
      event.preventDefault();
      strip.scrollLeft = next;
    };
    strip.addEventListener("wheel", scrollTabs, { passive: false });
    return () => strip.removeEventListener("wheel", scrollTabs);
  }, []);

  useEffect(() => {
    const index = tabs.tabs.indexOf(activePath ?? "");
    setFocusedIndex(Math.max(0, index));
    if (index >= 0) requestAnimationFrame(() => {
      const tab = tabRefs.current[index];
      tab?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
      if (focusPathRef.current === activePath) {
        tab?.focus();
        focusPathRef.current = null;
      }
    });
  }, [activePath, tabs.tabs]);

  useEffect(() => {
    setPendingClip(null);
  }, [activePath, activeMode, activeDocument?.snapshot.version]);

  useEffect(() => {
    if (!pendingClip) return;
    return pushEscapeLayer(() => {
      setPendingClip(null);
      requestAnimationFrame(() => bodyRef.current?.focus());
    });
  }, [pendingClip]);

  useEffect(() => {
    if (activeMode !== "reading" || activeDocument?.snapshot.status !== "ready") return;
    const onSelectionChange = () => {
      const surface = markdownSurfaceRef.current;
      if (surface) captureReadingSelection(surface);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [activeDocument?.content, activeDocument?.snapshot.status, activeDocument?.snapshot.version, activeMode, activePath]);

  function captureReadingSelection(surface: HTMLElement) {
    const selection = window.getSelection();
    const highlighted = readingClipHighlight.current;
    if (highlighted && selection?.rangeCount) {
      const selected = selection.getRangeAt(0);
      if (
        highlighted.compareBoundaryPoints(Range.START_TO_START, selected) === 0 &&
        highlighted.compareBoundaryPoints(Range.END_TO_END, selected) === 0
      ) {
        setPendingClip(null);
        return;
      }
      readingClipHighlight.current = null;
      setContextClipHighlightActive(false);
    }
    if (!activePath || activeDocument?.snapshot.status !== "ready") return;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setPendingClip(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const clip = buildMarkdownReadingClip(
      activePath,
      activeDocument.content,
      surface,
      range,
    );
    if (!clip) {
      setPendingClip(null);
      return;
    }
    const rect = typeof range.getBoundingClientRect === "function"
      ? range.getBoundingClientRect()
      : surface.getBoundingClientRect();
    setPendingClip({
      clip,
      position: { left: rect.left + rect.width / 2, top: rect.top },
    });
  }

  function addPendingClip() {
    if (!pendingClip || !contextClipSessionId || !onAddContextClip) return;
    onAddContextClip(pendingClip.clip);
    setPendingClip(null);
    window.getSelection()?.removeAllRanges();
  }

  const openGraphNode = useCallback((path: string) => {
    if (onNavigate) onNavigate({ status: "resolved", path, kind: "markdown" });
    else onTabsChange(openWorkspacePaneTab(tabs, path));
  }, [onNavigate, onTabsChange, tabs]);

  function reportScroll() {
    const pending = pendingScrollPosition.current;
    pendingScrollPosition.current = null;
    if (!pending) return;
    const current = shortcutStateRef.current;
    if (
      !current.tabs.tabs.includes(pending.path)
      || current.tabs.positions[pending.path] === pending.position
    ) return;
    current.onTabsChange(setWorkspacePanePosition(
      current.tabs,
      pending.path,
      pending.position,
    ));
  }

  // Keep inertial scrolling off the React state path until the viewport settles.
  function settleScroll() {
    const pending = pendingScrollPosition.current;
    if (!pending) {
      lastObservedScrollPosition.current = null;
      scrollSettleFrame.current = null;
      return;
    }
    if (lastObservedScrollPosition.current === pending.position) {
      lastObservedScrollPosition.current = null;
      scrollSettleFrame.current = null;
      reportScroll();
      return;
    }
    lastObservedScrollPosition.current = pending.position;
    scrollSettleFrame.current = requestAnimationFrame(settleScroll);
  }

  function onScroll() {
    if (!tabs.visible || !activePath || !bodyRef.current || activeMode !== "reading" || pdfSource) return;
    pendingScrollPosition.current = {
      path: activePath,
      position: Math.round(bodyRef.current.scrollTop),
    };
    if (scrollSettleFrame.current === null) {
      lastObservedScrollPosition.current = null;
      scrollSettleFrame.current = requestAnimationFrame(settleScroll);
    }
  }

  function focusTab(index: number) {
    if (!tabs.tabs.length) return;
    const next = (index + tabs.tabs.length) % tabs.tabs.length;
    setFocusedIndex(next);
    tabRefs.current[next]?.focus();
  }

  async function close(path: string) {
    const document = documents[path];
    if (document?.saveState !== "saved" && !(await savePath(path, true))) return;
    const next = closeWorkspacePaneTab(tabs, path);
    if (path === WORKSPACE_GRAPH_TAB_ID) {
      graphViewState.current = { positions: new Map(), pins: new Map(), camera: null };
    }
    if (next.activePath) focusPathRef.current = next.activePath;
    onTabsChange(next);
  }

  const locked = activeDocument ? lockedStateCopy(activeDocument.snapshot) : null;
  const saveLabel = locked ? (activeDocument?.saveState === "saved" ? "Locked" : "Unsaved")
    : activeDocument?.saveState === "saved" ? "Saved"
    : activeDocument?.saveState === "dirty" ? "Unsaved"
    : activeDocument?.saveState === "saving" ? "Saving" : "Save failed";
  const saveClass = locked ? "locked" : activeDocument?.saveState;

  const graphFailure = graphError ?? (graphSnapshot.status === "error" ? "Graph index build failed." : null);
  const graphIsRetrying = graphRetrying || graphSnapshot.status === "retrying";
  const activeCrumb = graphActive ? "Workspace-wide link projection" : activePath;
  const backPath = tabs.history[tabs.historyIndex - 1];
  const forwardPath = tabs.history[tabs.historyIndex + 1];

  useEffect(() => {
    onGraphStatusChange?.(graphFailure ? "error" : graphSnapshot.status);
  }, [graphFailure, graphSnapshot.status, onGraphStatusChange]);

  async function retryGraph(): Promise<void> {
    setGraphError(null);
    setGraphRetrying(true);
    setGraphSnapshot({ status: "retrying" });
    try {
      await client.retryWorkspaceGraph(workspaceId);
      setGraphRetry((value) => value + 1);
    } catch (error) {
      setGraphError(error instanceof Error ? error.message : String(error));
      setGraphRetrying(false);
    }
  }

  function endTabDrag(): void {
    setDraggedPath(null);
    setDropTarget(null);
  }

  return <aside id="workspace-pane" hidden={!tabs.visible} className={`${readingMode === "wide" ? "workspace-pane workspace-pane-wide" : "workspace-pane"}${contextClipHighlightActive ? " workspace-pane-context-highlight" : ""}`} aria-label="Workspace" data-testid="workspace-pane">
    <header className="workspace-tabs-row">
      {activePath ? <span className="workspace-pane-nav" role="group" aria-label="Pane History">
        <button type="button" className="icon-btn" data-testid="pane-back" aria-label="Back" title={backPath ? `Back · ${fileName(backPath)} (⌘[)` : "Back (⌘[)"} disabled={!paneCanGoBack(tabs)} onClick={() => onTabsChange(backWorkspacePaneHistory(tabs))}><ArrowLeft size={16} /></button>
        <button type="button" className="icon-btn" data-testid="pane-forward" aria-label="Forward" title={forwardPath ? `Forward · ${fileName(forwardPath)} (⌘])` : "Forward (⌘])"} disabled={!paneCanGoForward(tabs)} onClick={() => onTabsChange(forwardWorkspacePaneHistory(tabs))}><ArrowRight size={16} /></button>
      </span> : null}
      <div className="workspace-tabs-fade"><div className="workspace-tabs" ref={tabStripRef} role="tablist" aria-label="Workspace files" onDragOver={(event) => { if (draggedPath && !(event.target as Element).closest(".workspace-tab")) setDropTarget(null); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}>
        {tabs.tabs.map((path, index) => {
          const name = fileName(path);
          const extension = path === WORKSPACE_GRAPH_TAB_ID ? "" : name.match(/\.[^.]+$/)?.[0] ?? "";
          const active = path === activePath;
          const TabIcon = path === WORKSPACE_GRAPH_TAB_ID ? Network : /\.pdf$/i.test(path) ? File : FileText;
          const dropClass = dropTarget?.path === path
            ? dropTarget.insertion === "before" ? " workspace-tab-drop-before" : " workspace-tab-drop-after"
            : "";
          const className = `${active ? "workspace-tab workspace-tab-active" : "workspace-tab"}${draggedPath === path ? " workspace-tab-dragging" : ""}${dropClass}`;
          return <div className={className} key={path} onDragOver={(event) => { if (!draggedPath) return; if (draggedPath === path) { setDropTarget(null); return; } event.preventDefault(); event.dataTransfer.dropEffect = "move"; const rect = event.currentTarget.getBoundingClientRect(); const insertion = event.clientX < rect.left + rect.width / 2 ? "before" : "after"; setDropTarget((current) => current?.path === path && current.insertion === insertion ? current : { path, insertion }); }} onDrop={(event) => { event.preventDefault(); if (draggedPath && dropTarget && draggedPath !== dropTarget.path) onTabsChange(reorderWorkspacePaneTabs(tabs, draggedPath, dropTarget.path, dropTarget.insertion)); endTabDrag(); }}>
            <button ref={(element) => { tabRefs.current[index] = element; }} type="button" role="tab" aria-label={path === WORKSPACE_GRAPH_TAB_ID ? "Graph" : path} aria-selected={active} tabIndex={index === focusedIndex ? 0 : -1} title={path === WORKSPACE_GRAPH_TAB_ID ? "Graph" : path} className="workspace-tab-label" draggable onClick={() => onTabsChange(activateWorkspacePaneTab(tabs, path))} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); void close(path); } }} onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); focusTab(index + 1); } else if (event.key === "ArrowLeft") { event.preventDefault(); focusTab(index - 1); } else if (event.key === "Home") { event.preventDefault(); focusTab(0); } else if (event.key === "End") { event.preventDefault(); focusTab(tabs.tabs.length - 1); } else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onTabsChange(activateWorkspacePaneTab(tabs, path)); } }} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", path); setDraggedPath(path); }} onDragEnd={endTabDrag}>
              <TabIcon className="workspace-tab-icon" size={13} aria-hidden="true" />
              <span className="workspace-tab-name">{extension ? name.slice(0, -extension.length) : name}</span>{extension ? <span className="workspace-tab-extension">{extension}</span> : null}
            </button>
            {documents[path]?.saveState === "dirty" ? <span className="workspace-tab-dirty" aria-label="Unsaved" /> : null}
            <button type="button" className="workspace-tab-close" tabIndex={index === focusedIndex ? 0 : -1} aria-label={`Close ${fileName(path)}`} title="Close Tab" onClick={(event) => { event.stopPropagation(); void close(path); }}><X size={12} /></button>
          </div>;
        })}
      </div></div>
      <div className="workspace-pane-actions">
        {activePath && !graphActive ? <WorkspaceFileInfo key={activePath} path={activePath} /> : null}
        {!compact ? <button type="button" className={readingMode === "wide" ? "icon-btn workspace-pane-action-active" : "icon-btn"} disabled={!activePath} aria-label={readingMode === "wide" ? "Exit Wide Mode" : "Wide Mode"} aria-pressed={readingMode === "wide"} title={readingMode === "wide" ? "Exit Wide Mode (⌘E)" : "Wide Mode (⌘E)"} onClick={() => onWideModeChange?.(readingMode === "wide" ? "normal" : "wide")}>{readingMode === "wide" ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button> : null}
        {headerActions}
      </div>
    </header>
    {activePath && !pdfActive ? <div className="workspace-pane-toolbar">
      <span className="workspace-pane-crumb" title={activeCrumb ?? undefined}>{activeCrumb}</span>
      <span className="workspace-pane-toolbar-right">
        {graphActive ? <span className="workspace-pane-hint">click a node to open its tab</span> : null}
        {activeDocument ? <span className={`workspace-save-pill workspace-save-${saveClass}`}>{saveLabel}</span> : null}
        {activePath !== WORKSPACE_GRAPH_TAB_ID && activeDocument?.snapshot.status === "ready" ? <span className="workspace-mode-switch" aria-label="Markdown mode">
          <button type="button" className={activeMode === "reading" ? "workspace-mode-active" : ""} aria-label="Read" title="Read mode (⌘⇧E toggles)" onClick={() => onTabsChange(setWorkspacePaneMode(tabs, activePath, "reading"))}><span>Read</span></button>
          <button type="button" className={activeMode === "editing" ? "workspace-mode-active" : ""} aria-label="Edit" title="Edit mode (⌘⇧E toggles)" onClick={() => onTabsChange(setWorkspacePaneMode(tabs, activePath, "editing"))}><span>Edit</span></button>
        </span> : null}
      </span>
    </div> : null}
    {graphActive && graphFailure ? <div className="workspace-document-error" role="alert"><span>{graphFailure}</span><button type="button" className="btn-secondary" onClick={() => void retryGraph()}>Retry</button></div> : null}
    {graphActive && graphIsRetrying ? <div className="workspace-document-notice workspace-graph-retrying" role="status">Retrying Graph…</div> : null}
    {restoreReport ? <div className="workspace-pane-restore-note" role="status" data-testid="pane-restore-banner"><span>{restoreReport.warning ?? `Restored workspace pane — skipped ${restoreReport.skipped} invalid item${restoreReport.skipped === 1 ? "" : "s"}.`}</span><button type="button" className="workspace-pane-restore-dismiss" onClick={onDismissRestoreReport}>Dismiss</button></div> : null}
    {activeDocument?.notice ? <div className="workspace-document-notice" role="status">{activeDocument.notice}</div> : null}
    {activeDocument?.error ? <div className="workspace-document-error" role="alert"><span>{activeDocument.error}</span><button type="button" className="btn-secondary" onClick={() => activePath && void savePath(activePath, true)}>Retry</button></div> : null}
    <div className="workspace-pane-body" data-testid="workspace-pane-content" ref={bodyRef} tabIndex={-1} onScroll={onScroll}>
      {graphSnapshot.status === "ready" && graphSnapshot.nodes.length > 0 && tabs.tabs.includes(WORKSPACE_GRAPH_TAB_ID)
        ? <div className={graphActive ? "workspace-graph-host" : "workspace-graph-host workspace-graph-host-hidden"}>
            <WorkspaceGraph active={graphActive && tabs.visible} viewState={graphViewState} snapshot={graphSnapshot} originPath={graphOriginPath.current} onOpenNode={openGraphNode} />
          </div>
        : null}
      {restoring ? <div className="workspace-pane-skeleton" data-testid="workspace-pane-skeleton" aria-hidden="true"><div className="workspace-pane-skeleton-line workspace-pane-skeleton-title" /><div className="workspace-pane-skeleton-line" /><div className="workspace-pane-skeleton-line" /><div className="workspace-pane-skeleton-line workspace-pane-skeleton-short" /></div>
      : !activePath ? <div className="workspace-pane-empty"><p className="workspace-pane-empty-title">Nothing open.</p><p className="workspace-pane-empty-hint">Choose a file or open the Graph.</p><span className="sr-only">Open a file to begin reading.</span></div>
      : graphActive ? (graphFailure
            ? <div className="workspace-graph-state"><Network size={24} /><p>Graph is unavailable.</p></div>
        : graphSnapshot.status === "building" || graphSnapshot.status === "retrying"
          ? <div className="workspace-graph-state" role="status"><span className="workspace-graph-spinner" />{graphSnapshot.status === "retrying" ? "Preparing Graph…" : "Building Graph…"}</div>
          : graphSnapshot.status === "error"
          ? <div className="workspace-graph-state"><Network size={24} /><p>Graph is unavailable.</p></div>
          : graphSnapshot.nodes.length === 0
            ? <div className="workspace-graph-state"><Network size={24} /><p>No Markdown notes yet.</p></div>
            : null)
      : loading ? <div className="workspace-pane-status" role="status"><span className="workspace-graph-spinner" /><p>Loading document…</p></div>
      : loadError ? <div className="workspace-pane-error" role="alert"><FileWarning size={26} /><p>{pdfError?.title ?? (isUnavailableError(loadError.message) ? "File is not available" : "Could not open file")}</p><span>{pdfError?.detail ?? loadError.message}</span><code>{activePath}</code><button type="button" className="workspace-pane-state-action" onClick={() => void loadPath(activePath)}>Retry</button></div>
      : activeDocument ? <>
        {locked ? <div className="workspace-pane-error workspace-document-locked" role="alert"><FileWarning size={26} /><p>{locked.title}</p><span>{locked.detail}</span><code>{activePath}</code><button type="button" className="workspace-pane-state-action" onClick={() => void loadPath(activePath)}>Retry</button></div> : null}
        {activeDocument.snapshot.status === "ready" && activeMode === "reading" ? <article className="workspace-pane-markdown" onMouseUp={() => markdownSurfaceRef.current && captureReadingSelection(markdownSurfaceRef.current)} onKeyUp={() => markdownSurfaceRef.current && captureReadingSelection(markdownSurfaceRef.current)}>
          <PropertiesPanel source={activeDocument.content} registry={propertyRegistry} onChange={(content) => changeContent(activePath, content)} />
          {markdownBodyWithoutFrontmatter(activeDocument.content) ? <div ref={markdownSurfaceRef}><MarkdownText text={markdownBodyWithoutFrontmatter(activeDocument.content)} sourcePath={activeDocument.snapshot.path} resolveLink={resolveLink} onNavigate={onNavigate} onCreateMissing={onCreateMissing} linkRevision={linkRevision} /></div> : null}
        </article> : null}
        {pendingClip ? contextClipSessionId && onAddContextClip ? <button type="button" className="context-clip-selection" style={pendingClip.position} aria-label="Ask Wikilot" onMouseDown={(event) => event.preventDefault()} onClick={addPendingClip}><Paperclip size={13} aria-hidden="true" />Ask Wikilot</button> : <div className="context-clip-selection context-clip-selection-disabled" style={pendingClip.position} role="note" aria-label="Select a Session to add this selection"><Paperclip size={13} aria-hidden="true" /><span><strong>Select a Session</strong><small>Ask Wikilot needs an active Session</small></span></div> : null}
        {activeDocument.snapshot.status === "ready" && activeMode === "editing" ? <MarkdownEditor key={`${activePath}:${activeDocument.editorEpoch}`} content={activeDocument.content} sourcePath={activeDocument.snapshot.path} selection={tabs.editorSelections[activePath]} linkIndex={linkIndex} mruPaths={tabs.mru} resolveLink={resolveLink} onNavigate={onNavigate} onCreateMissing={onCreateMissing} onChange={(content) => changeContent(activePath, content)} onSelectionChange={(selection) => onTabsChange(setWorkspacePaneEditorSelection(tabs, activePath, selection))} onContextClipSelection={(anchor, head, position) => { const clip = buildMarkdownEditingClip(activePath, activeDocument.content, anchor, head); setPendingClip(clip ? { clip, position } : null); }} onContextClipInteraction={() => { setPendingClip(null); setContextClipHighlightActive(false); }} contextClipHighlight={editingClipHighlight} onSave={() => void savePath(activePath, true)} /> : null}
      </>
      : activePdfSource ? <CapabilityPdfReader sourceId={activePdfSource.sourceId} releaseSource={releasePdfSource} sourceUrl={client.workspacePdfSourceUrl(activePdfSource.sourceId)} sourceSize={activePdfSource.size} sourcePath={activePath} sourceVersion={activePdfSource.version} view={tabs.pdfViews[activePath] ?? { page: 1, inPage: 0, zoom: "fit-width" }} mode={readingMode} onReload={() => void loadPath(activePath)} onClose={() => void close(activePath)} contextClipSessionId={contextClipSessionId} onAddContextClip={onAddContextClip} contextClipNavigation={contextClipNavigation} onContextClipNavigationResult={onContextClipNavigationResult} onViewChange={(view) => onTabsChange(setWorkspacePanePdfView(tabs, activePath, view))} />
      : null}
    </div>
  </aside>;
}
