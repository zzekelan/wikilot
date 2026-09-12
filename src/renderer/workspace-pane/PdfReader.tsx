import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  ChevronUp,
  ChevronDown,
  MoveHorizontal,
  Paperclip,
} from "lucide-react";
import type { ContextClip, PdfContextClip } from "../../shared/session";
import { Document, Page, pdfjs } from "react-pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useVirtualizer, type Range } from "@tanstack/react-virtual";
import type {
  WorkspacePanePdfView,
  WorkspacePaneReadingMode,
} from "../../shared/workspace";
import { pdfDocumentOptions } from "../pdf/pdf-document-options";
import { recordUiGesture } from "../telemetry";
import { pushEscapeLayer } from "../escape-stack";
import { pdfFailurePresentation } from "../pdf/pdf-errors";
import { useHttpPdfRangeTransport } from "../pdf/use-http-pdf-range-transport";
import { capturePdfSelection, relocatePdfClip } from "./pdf-context-clip";
import { PdfNavigation } from "./PdfNavigation";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const PDF_OPTIONS = {
  ...pdfDocumentOptions(),
  disableAutoFetch: true,
  disableStream: true,
  rangeChunkSize: 64 * 1024,
};
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const PAGE_FRAME_BORDER = 2;
const PAGE_GAP = 16;
const PAGE_PADDING = 24;

type PdfPageSize = { width: number; height: number };
const DEFAULT_PAGE_SIZE: PdfPageSize = { width: 612, height: 792 };

function pageFrameDimensions(
  size: PdfPageSize,
  zoom: number | "fit-width",
  fitWidth: number,
): PdfPageSize {
  const scale = zoom === "fit-width" ? fitWidth / size.width : zoom;
  return {
    width: Math.floor(size.width * scale) + PAGE_FRAME_BORDER,
    height: Math.floor(size.height * scale) + PAGE_FRAME_BORDER,
  };
}

function documentFingerprint(pdfFingerprint: string | null | undefined, sourceVersion: string | undefined): string {
  return `pdfjs:${pdfFingerprint ?? "unknown"}:source:${sourceVersion ?? "unknown"}`;
}

function normalizedPdfText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function pageWindow(page: number, numPages: number, radius: number): number[] {
  const start = Math.max(1, page - radius);
  const end = Math.min(numPages, page + radius);
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

type PdfReaderProps = {
  sourceUrl: string;
  sourceSize: number;
  sourcePath?: string;
  sourceVersion?: string;
  view: WorkspacePanePdfView;
  mode: WorkspacePaneReadingMode;
  contextClipSessionId?: string | null;
  onAddContextClip?(clip: ContextClip): void;
  contextClipNavigation?: { id: number; clip: ContextClip } | null;
  onContextClipNavigationResult?(result: "exact" | "relocated" | "changed"): void;
  onViewChange(view: WorkspacePanePdfView): void;
  onReload?(): void;
  onClose?(): void;
};

type PasswordCallback = (password: string | null) => void;

export function PdfReader({
  sourceUrl,
  sourceSize,
  sourcePath,
  sourceVersion,
  view,
  mode,
  contextClipSessionId,
  onAddContextClip,
  contextClipNavigation = null,
  onContextClipNavigationResult,
  onViewChange,
  onReload,
  onClose,
}: PdfReaderProps) {
  const sourceIdentity = sourceVersion ?? sourceUrl;
  const [numPages, setNumPages] = useState(0);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [passwordCallback, setPasswordCallback] = useState<PasswordCallback | null>(null);
  const [password, setPassword] = useState("");
  const [incorrectPassword, setIncorrectPassword] = useState(false);
  const [searchHighlight, setSearchHighlight] = useState("");
  const [noTextLayer, setNoTextLayer] = useState(false);
  const [fitWidth, setFitWidth] = useState(DEFAULT_PAGE_SIZE.width);
  const [currentDocumentFingerprint, setCurrentDocumentFingerprint] = useState("");
  const [pendingClip, setPendingClip] = useState<{
    clip: PdfContextClip;
    position: { left: number; top: number };
  } | null>(null);
  const [highlightSpans, setHighlightSpans] = useState<PdfContextClip["locator"]["spans"]>([]);
  const processedClipNavigation = useRef<number | null>(null);
  const pdfDocument = useRef<PDFDocumentProxy | null>(null);
  const [documentRevision, setDocumentRevision] = useState(0);
  const [pageSizeRevision, setPageSizeRevision] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const pageRefCallbacks = useRef(new Map<number, (element: HTMLDivElement | null) => void>());
  const pageSizes = useRef(new Map<number, PdfPageSize>());
  const pageSizeRequests = useRef(new Map<number, Promise<PdfPageSize | null>>());
  const sourceIdentityRef = useRef(sourceIdentity);
  const pageTextSources = useRef(new Map<number, { source: string; text: string }>());
  const textLayerSources = useRef(new Map<number, string>());
  const noTextLayerSources = useRef(new Map<number, string>());
  const textLayerObservers = useRef(new Map<number, { layer: HTMLElement; observer: MutationObserver }>());
  const positionPending = useRef(true);
  const popupRef = useRef<HTMLElement | null>(null);
  const rangeTransport = useHttpPdfRangeTransport(sourceUrl, sourceSize, (failure) => {
    setError(pdfFailurePresentation(failure));
  });
  sourceIdentityRef.current = sourceIdentity;

  const file = useMemo(
    () => rangeTransport ? { range: rangeTransport } : null,
    [rangeTransport],
  );
  const estimatePageHeight = useCallback((index: number) => {
    const size = pageSizes.current.get(index + 1)
      ?? pageSizes.current.values().next().value
      ?? DEFAULT_PAGE_SIZE;
    return pageFrameDimensions(size, view.zoom, fitWidth).height;
  }, [fitWidth, view.zoom]);
  const pageKey = useCallback(
    (index: number) => `${sourceIdentity}:${index + 1}`,
    [sourceIdentity],
  );
  const navigationPageIndexes = useMemo(() => {
    if (contextClipNavigation?.clip.locator.kind !== "pdf") return [];
    return contextClipNavigation.clip.locator.spans
      .map((span) => span.page - 1)
      .filter((index) => index >= 0 && index < numPages);
  }, [contextClipNavigation, numPages]);
  const extractPageRange = useCallback((range: Range) => (
    [...new Set([
      range.startIndex - 1,
      range.startIndex,
      range.startIndex + 1,
      ...navigationPageIndexes,
    ])]
      .filter((index) => index >= 0 && index < range.count)
      .sort((left, right) => left - right)
  ), [navigationPageIndexes]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: numPages,
    getScrollElement: () => stageRef.current,
    estimateSize: estimatePageHeight,
    getItemKey: pageKey,
    gap: PAGE_GAP,
    paddingStart: PAGE_PADDING,
    paddingEnd: PAGE_PADDING,
    overscan: 1,
    rangeExtractor: extractPageRange,
    initialRect: { width: DEFAULT_PAGE_SIZE.width, height: DEFAULT_PAGE_SIZE.height },
    useFlushSync: false,
  });
  const virtualPages = virtualizer.getVirtualItems();
  const virtualPageNumbers = virtualPages.map((item) => item.index + 1);
  const virtualPageKey = virtualPageNumbers.join(",");

  function resetTextLayerReadiness(): void {
    pageTextSources.current.clear();
    textLayerSources.current.clear();
    noTextLayerSources.current.clear();
    for (const { observer } of textLayerObservers.current.values()) observer.disconnect();
    textLayerObservers.current.clear();
  }

  function pageRef(page: number): (element: HTMLDivElement | null) => void {
    let callback = pageRefCallbacks.current.get(page);
    if (callback) return callback;
    callback = (element) => {
      if (element) {
        pageRefs.current.set(page, element);
        return;
      }
      pageRefs.current.delete(page);
      pageTextSources.current.delete(page);
      textLayerSources.current.delete(page);
      noTextLayerSources.current.delete(page);
      textLayerObservers.current.get(page)?.observer.disconnect();
      textLayerObservers.current.delete(page);
    };
    pageRefCallbacks.current.set(page, callback);
    return callback;
  }

  async function ensurePageSizes(
    document: PDFDocumentProxy,
    requestedPages: number[],
    requestedSource = sourceIdentity,
  ): Promise<void> {
    const loaded = await Promise.all(requestedPages.map(async (pageNumber) => {
      const cached = pageSizes.current.get(pageNumber);
      if (cached) return [pageNumber, cached] as const;
      let request = pageSizeRequests.current.get(pageNumber);
      if (!request) {
        request = document.getPage(pageNumber)
          .then((page) => {
            const viewport = page.getViewport({ scale: 1 });
            return { width: viewport.width, height: viewport.height };
          })
          .catch(() => null);
        pageSizeRequests.current.set(pageNumber, request);
      }
      return [pageNumber, await request] as const;
    }));
    if (pdfDocument.current !== document || sourceIdentityRef.current !== requestedSource) return;
    let changed = false;
    for (const [pageNumber, size] of loaded) {
      if (!size || pageSizes.current.has(pageNumber)) continue;
      pageSizes.current.set(pageNumber, size);
      changed = true;
    }
    if (changed) setPageSizeRevision((revision) => revision + 1);
  }

  function pageFrameStyle(page: number): CSSProperties {
    const size = pageSizes.current.get(page)
      ?? pageSizes.current.values().next().value
      ?? DEFAULT_PAGE_SIZE;
    return pageFrameDimensions(size, view.zoom, fitWidth);
  }

  useLayoutEffect(() => {
    positionPending.current = true;
    pageSizes.current.clear();
    pageSizeRequests.current.clear();
    resetTextLayerReadiness();
    setError(null);
    setNumPages(0);
    setPasswordCallback(null);
    setIncorrectPassword(false);
    setSearchHighlight("");
    setCurrentDocumentFingerprint("");
    pdfDocument.current = null;
    setDocumentRevision((revision) => revision + 1);
    setHighlightSpans([]);
    processedClipNavigation.current = null;
    return () => {
      for (const { observer } of textLayerObservers.current.values()) observer.disconnect();
      textLayerObservers.current.clear();
    };
  }, [sourceSize, sourceUrl, sourceVersion]);

  useLayoutEffect(() => {
    virtualizer.measure();
    for (const [pageNumber, size] of pageSizes.current) {
      virtualizer.resizeItem(
        pageNumber - 1,
        pageFrameDimensions(size, view.zoom, fitWidth).height,
      );
    }
  }, [fitWidth, numPages, sourceIdentity, view.zoom, virtualizer]);

  useLayoutEffect(() => {
    for (const [pageNumber, size] of pageSizes.current) {
      virtualizer.resizeItem(
        pageNumber - 1,
        pageFrameDimensions(size, view.zoom, fitWidth).height,
      );
    }
  }, [fitWidth, pageSizeRevision, view.zoom, virtualizer]);

  useEffect(() => {
    const document = pdfDocument.current;
    if (!document || numPages === 0) return;
    const preloadPages = [...new Set(virtualPageNumbers.flatMap((page) => pageWindow(page, numPages, 1)))];
    void ensurePageSizes(document, preloadPages);
    // Page dimensions are cached outside render state; the revision update only exposes completed batches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentRevision, numPages, sourceIdentity, virtualPageKey]);

  useEffect(() => {
    const document = pdfDocument.current;
    if (!document) return;
    let active = true;
    const unavailableTimer = window.setTimeout(() => {
      if (active) setNoTextLayer(true);
    }, 3_000);
    setNoTextLayer(false);
    void document.getPage(view.page)
      .then((page) => page.getTextContent())
      .then((content) => {
        if (!active) return;
        window.clearTimeout(unavailableTimer);
        const hasText = content.items.some((item) =>
          typeof item === "object" && item !== null && "str" in item
          && typeof item.str === "string" && Boolean(item.str.trim())
        );
        setNoTextLayer(!hasText);
      })
      .catch(() => {});
    return () => {
      active = false;
      window.clearTimeout(unavailableTimer);
    };
  }, [documentRevision, view.page]);

  function positionContextClip(spans: PdfContextClip["locator"]["spans"]): boolean {
    const firstSpan = spans[0];
    if (!firstSpan) return false;
    const inPage = Math.max(0, Math.min(1, firstSpan.boxes[0]?.top ?? 0));
    if (view.page === firstSpan.page && Math.abs(view.inPage - inPage) < 0.001) return false;
    preparePageChange();
    onViewChange({ ...view, page: firstSpan.page, inPage });
    return true;
  }

  function processContextClipNavigation(): void {
    const request = contextClipNavigation;
    if (
      !request
      || processedClipNavigation.current === request.id
      || request.clip.source.kind !== "pdf"
      || request.clip.locator.kind !== "pdf"
      || request.clip.source.path !== sourcePath
      || numPages === 0
      || !currentDocumentFingerprint
    ) return;
    const firstPage = request.clip.locator.spans[0]?.page;
    if (!firstPage) return;
    if (request.clip.locator.spans.some((span) => span.page > numPages)) {
      const preferredPage = Math.max(1, Math.min(firstPage, numPages));
      if (view.page !== preferredPage) {
        preparePageChange();
        onViewChange({ ...view, page: preferredPage, inPage: 0 });
      }
      setHighlightSpans([]);
      processedClipNavigation.current = request.id;
      onContextClipNavigationResult?.("changed");
      return;
    }
    if (request.clip.fingerprint === currentDocumentFingerprint) {
      if (positionContextClip(request.clip.locator.spans)) return;
      setHighlightSpans(request.clip.locator.spans);
      processedClipNavigation.current = request.id;
      onContextClipNavigationResult?.("exact");
      return;
    }
    if (view.page !== firstPage) {
      positionContextClip(request.clip.locator.spans);
      return;
    }
    const scroller = stageRef.current;
    if (!scroller) return;
    const waitingPages = request.clip.locator.spans.filter((span) => {
      return textLayerSources.current.get(span.page) !== sourceIdentity
        && noTextLayerSources.current.get(span.page) !== sourceIdentity;
    });
    if (waitingPages.length > 0) return;
    const relocated = relocatePdfClip(scroller, request.clip as PdfContextClip);
    setHighlightSpans(relocated ?? []);
    processedClipNavigation.current = request.id;
    onContextClipNavigationResult?.(relocated ? "relocated" : "changed");
    if (relocated) positionContextClip(relocated);
  }

  useEffect(() => {
    processContextClipNavigation();
    // Text-layer readiness calls the same processor directly without a render-state bridge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextClipNavigation, currentDocumentFingerprint, numPages, onContextClipNavigationResult, onViewChange, sourcePath, view]);

  function constrainSelectionAction(): void {
    const popup = popupRef.current;
    const scroller = stageRef.current;
    if (!pendingClip || !popup || !scroller) return;
    const rect = popup.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return;
    const margin = 4;
    const horizontal = rect.left < viewport.left + margin
      ? viewport.left + margin - rect.left
      : rect.right > viewport.right - margin
        ? viewport.right - margin - rect.right
        : 0;
    const vertical = rect.top < viewport.top + margin
      ? viewport.top + margin - rect.top
      : rect.bottom > viewport.bottom - margin
        ? viewport.bottom - margin - rect.bottom
        : 0;
    if (horizontal === 0 && vertical === 0) return;
    setPendingClip((current) => current ? {
      ...current,
      position: {
        left: current.position.left + horizontal,
        top: current.position.top + vertical,
      },
    } : null);
  }

  useLayoutEffect(() => {
    constrainSelectionAction();
    // The animation-end handler repeats this check against the settled transform.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingClip]);

  useEffect(() => {
    if (!pendingClip) return;
    return pushEscapeLayer(() => {
      setPendingClip(null);
      requestAnimationFrame(() => stageRef.current?.focus());
    });
  }, [pendingClip]);

  useLayoutEffect(() => {
    positionPending.current = true;
  }, [mode]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const update = () => {
      const style = getComputedStyle(stage);
      const horizontalPadding =
        (Number.parseFloat(style.paddingLeft) || 0) +
        (Number.parseFloat(style.paddingRight) || 0);
      if (stage.clientWidth <= 0) return;
      const next = Math.max(1, stage.clientWidth - horizontalPadding);
      setFitWidth((current) => {
        if (current !== next) {
          positionPending.current = true;
        }
        return next;
      });
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [mode, view.page]);

  useEffect(() => {
    applySavedPosition();
  }, [fitWidth, mode, pageSizeRevision, view.inPage, view.page, virtualPageKey]); // re-anchor after async geometry or virtual mount

  function applySavedPosition(): void {
    const scroller = stageRef.current;
    const page = virtualizer.measurementsCache[view.page - 1];
    if (!positionPending.current || !page || !scroller) return;
    const target = page.start + page.size * view.inPage;
    positionPending.current = true;
    if (typeof scroller.scrollTo === "function") {
      virtualizer.scrollToOffset(target);
    } else {
      scroller.scrollTop = target;
      scroller.dispatchEvent(new Event("scroll"));
    }
  }

  function setPage(page: number): void {
    const next = Math.max(1, Math.min(numPages || 1, Math.trunc(page)));
    if (next !== view.page) {
      recordUiGesture("reader.page", {
        "wikilot.gesture": "reader.page",
        "wikilot.reader.page": String(next),
      });
    }
    preparePageChange();
    const document = pdfDocument.current;
    if (document) {
      void ensurePageSizes(document, pageWindow(next, numPages, 2));
    }
    onViewChange({ ...view, page: next, inPage: 0 });
  }

  function preparePageChange(): void {
    positionPending.current = true;
  }

  function setZoom(zoom: number | "fit-width"): void {
    recordUiGesture("reader.zoom", {
      "wikilot.gesture": "reader.zoom",
      "wikilot.reader.zoom": String(zoom),
    });
    preparePageChange();
    onViewChange({ ...view, zoom });
  }

  function onScroll(): void {
    setPendingClip(null);
    const scroller = stageRef.current;
    if (!scroller) return;
    // Geometry and virtualizer scroll corrections must not rewrite the saved reading position.
    if (positionPending.current) return;
    let currentItem = virtualizer.getVirtualItemForOffset(scroller.scrollTop);
    const nextItem = currentItem
      ? virtualizer.measurementsCache[currentItem.index + 1]
      : undefined;
    if (
      currentItem
      && nextItem
      && Math.abs(nextItem.start - scroller.scrollTop) < Math.abs(currentItem.start - scroller.scrollTop)
    ) {
      currentItem = nextItem;
    }
    const current = currentItem ? currentItem.index + 1 : view.page;
    const inPage = currentItem
      ? Math.max(0, Math.min(1, (scroller.scrollTop - currentItem.start) / Math.max(1, currentItem.size)))
      : 0;
    if (current !== view.page || Math.abs(inPage - view.inPage) >= 0.01) {
      onViewChange({ ...view, page: current, inPage });
    }
  }

  function beginUserInteraction(): void {
    positionPending.current = false;
  }

  const currentPageSize = pageSizes.current.get(view.page) ?? DEFAULT_PAGE_SIZE;
  const numericZoom = view.zoom === "fit-width" ? fitWidth / currentPageSize.width : view.zoom;

  function captureSelection(): void {
    setHighlightSpans([]);
    const scroller = stageRef.current;
    const selection = window.getSelection();
    if (!scroller || !selection || !sourcePath || !currentDocumentFingerprint) {
      setPendingClip(null);
      return;
    }
    setPendingClip(capturePdfSelection(sourcePath, currentDocumentFingerprint, scroller, selection));
  }

  function addPendingClip(): void {
    if (!pendingClip || !contextClipSessionId || !onAddContextClip) return;
    onAddContextClip(pendingClip.clip);
    setPendingClip(null);
    window.getSelection()?.removeAllRanges();
  }

  function watchTextLayer(page: number): void {
    const layer = pageRefs.current.get(page)?.querySelector<HTMLElement>(".textLayer");
    const expected = pageTextSources.current.get(page);
    if (!layer || expected?.source !== sourceIdentity) return;
    const matchesCurrentPage = () => normalizedPdfText(layer.textContent ?? "") === expected.text;
    if (matchesCurrentPage()) {
      textLayerSources.current.set(page, sourceIdentity);
      queueMicrotask(processContextClipNavigation);
      return;
    }
    const existing = textLayerObservers.current.get(page);
    if (existing?.layer === layer) return;
    existing?.observer.disconnect();
    const observer = new MutationObserver(() => {
      if (!matchesCurrentPage()) return;
      observer.disconnect();
      textLayerObservers.current.delete(page);
      textLayerSources.current.set(page, sourceIdentity);
      processContextClipNavigation();
    });
    observer.observe(layer, { childList: true, characterData: true, subtree: true });
    textLayerObservers.current.set(page, { layer, observer });
  }

  const ready = numPages > 0 && !error && !passwordCallback;
  const renderSearchText = ({ str }: { str: string }) => {
    const escape = (text: string) => text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
    const needle = searchHighlight.toLowerCase();
    if (!needle) return escape(str);
    let start = 0;
    let result = "";
    for (let index = str.toLowerCase().indexOf(needle); index >= 0; index = str.toLowerCase().indexOf(needle, start)) {
      result += `${escape(str.slice(start, index))}<mark>${escape(str.slice(index, index + needle.length))}</mark>`;
      start = index + needle.length;
    }
    return result + escape(str.slice(start));
  };

  return (
    <section className="pdf-reader" data-testid="pdf-reader">
      <PdfNavigation document={ready ? pdfDocument.current : null} onNavigate={(page, inPage, query) => {
        preparePageChange();
        setSearchHighlight(query ?? "");
        setHighlightSpans([]);
        const document = pdfDocument.current;
        if (document) void ensurePageSizes(document, pageWindow(page, numPages, 2));
        onViewChange({ ...view, page, inPage });
      }} controls={<>
        <div className="pdf-reader-control-group">
          <button type="button" className="icon-btn" aria-label="Previous page" title="Previous page" disabled={!ready || view.page <= 1} onClick={() => setPage(view.page - 1)}>
            <ChevronUp size={16} />
          </button>
          <label className="pdf-reader-page">
            <input aria-label="Page" type="number" min={1} max={numPages || 1} value={view.page} disabled={!ready} onChange={(event) => setPage(Number(event.target.value))} />
            <span>/ {numPages || "…"}</span>
          </label>
          <button type="button" className="icon-btn" aria-label="Next page" title="Next page" disabled={!ready || view.page >= numPages} onClick={() => setPage(view.page + 1)}>
            <ChevronDown size={16} />
          </button>
        </div>
        <div className="pdf-reader-control-group pdf-reader-zoom">
          <input className="pdf-zoom-slider" type="range" aria-label="PDF zoom level" aria-valuetext={`${Math.round(numericZoom * 100)}%${view.zoom === "fit-width" ? " · Fit width" : ""}`} min={MIN_ZOOM * 100} max={MAX_ZOOM * 100} step={1} value={Math.max(MIN_ZOOM * 100, Math.min(MAX_ZOOM * 100, Math.round(numericZoom * 100)))} disabled={!ready} onChange={(event) => setZoom(Number(event.target.value) / 100)} />
          <output className="pdf-zoom-value" aria-label="PDF zoom">{ready ? view.zoom === "fit-width" ? "Fit width" : `${Math.round(numericZoom * 100)}%` : "—"}</output>
          <button type="button" disabled={!ready} className={view.zoom === "fit-width" ? "icon-btn pdf-reader-fit-active" : "icon-btn"} aria-label="Fit width" title="Fit width" aria-pressed={view.zoom === "fit-width"} onClick={() => setZoom("fit-width")}><MoveHorizontal size={16} /></button>
        </div>
      </>}>
      {noTextLayer ? <p className="pdf-reader-note" role="status">No selectable text on this page</p> : null}
      {error ? (
        <div className="workspace-pane-error" role="alert"><p>{error.title}</p><span>{error.detail}</span><div className="pdf-error-actions">{onReload ? <button type="button" className="btn-secondary" onClick={onReload}>Reload file</button> : null}{onClose ? <button type="button" className="btn-secondary" onClick={onClose}>Close PDF</button> : null}</div></div>
      ) : (
        <div className="pdf-reader-scroll" data-testid="pdf-reader-scroll" ref={stageRef} tabIndex={-1} onScroll={onScroll} onWheel={beginUserInteraction} onPointerDown={beginUserInteraction} onTouchStart={beginUserInteraction} onKeyDown={beginUserInteraction} onMouseUp={captureSelection} onKeyUp={captureSelection}>
          {file ? <Document
            key={sourceIdentity}
            file={file}
            options={PDF_OPTIONS}
            loading={<p className="workspace-pane-status">Loading PDF…</p>}
            onLoadSuccess={(document) => {
              resetTextLayerReadiness();
              pdfDocument.current = document;
              setDocumentRevision((revision) => revision + 1);
              setCurrentDocumentFingerprint(documentFingerprint(document.fingerprints[0], sourceVersion));
              setError(null);
              setPasswordCallback(null);
              setIncorrectPassword(false);
              const initialPage = Math.max(1, Math.min(view.page, document.numPages));
              void ensurePageSizes(document, pageWindow(initialPage, document.numPages, 2)).then(() => {
                if (pdfDocument.current !== document) return;
                setNumPages(document.numPages);
                if (view.page > document.numPages) {
                  onViewChange({ ...view, page: document.numPages, inPage: 0 });
                }
              });
            }}
            onLoadError={(loadError) => setError(pdfFailurePresentation(loadError))}
            onPassword={(callback, reason) => {
              setPasswordCallback(() => callback);
              setPassword("");
              setIncorrectPassword(reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD);
            }}
          >
            <div className="pdf-reader-pages" style={{ height: virtualizer.getTotalSize() }}>
              {virtualPages.map((virtualPage) => {
                const page = virtualPage.index + 1;
                return (
                  <div
                    key={virtualPage.key}
                    className="pdf-reader-virtual-page"
                    style={{
                      height: virtualPage.size,
                      transform: `translateY(${virtualPage.start}px)`,
                    }}
                  >
                    <div ref={pageRef(page)} className="pdf-reader-page-frame" data-testid="pdf-page-frame" data-pdf-page={page} style={pageFrameStyle(page)}>
                      <Page
                        key={`${currentDocumentFingerprint}:${page}`}
                        className="pdf-reader-rendered-page"
                        pageNumber={page}
                        {...(view.zoom === "fit-width" ? { width: fitWidth } : { scale: view.zoom })}
                        renderTextLayer
                        customTextRenderer={searchHighlight ? renderSearchText : undefined}
                        renderAnnotationLayer={false}
                        loading={<span className="pdf-reader-page-loading">Rendering page…</span>}
                        onGetTextSuccess={(text) => {
                          const pageText = normalizedPdfText(text.items.map((item) =>
                            typeof item === "object" && item !== null && "str" in item && typeof item.str === "string"
                              ? item.str
                              : ""
                          ).join(""));
                          pageTextSources.current.set(page, { source: sourceIdentity, text: pageText });
                          if (!pageText) {
                            noTextLayerSources.current.set(page, sourceIdentity);
                          } else {
                            noTextLayerSources.current.delete(page);
                          }
                          if (page === view.page) setNoTextLayer(!pageText);
                          processContextClipNavigation();
                        }}
                        onRenderTextLayerSuccess={() => {
                          requestAnimationFrame(() => {
                            watchTextLayer(page);
                            if (page === view.page) {
                              setNoTextLayer(!pageTextSources.current.get(page)?.text);
                            }
                          });
                        }}
                        onRenderSuccess={() => {
                          if (page === view.page) {
                            requestAnimationFrame(applySavedPosition);
                          }
                        }}
                      />
                      {highlightSpans.filter((span) => span.page === page).flatMap((span) =>
                        span.boxes.map((box, index) => (
                          <span
                            key={`${span.start}:${span.end}:${index}`}
                            className="pdf-context-highlight"
                            data-testid="pdf-context-highlight"
                            style={{
                              left: `${box.left * 100}%`,
                              top: `${box.top * 100}%`,
                              width: `${box.width * 100}%`,
                              height: `${box.height * 100}%`,
                            }}
                          />
                        )),
                      )}
                      {pendingClip?.clip.locator.spans.filter((span) => span.page === page).flatMap((span) =>
                        span.boxes.map((box, index) => (
                          <span
                            key={`pending:${span.start}:${span.end}:${index}`}
                            className="pdf-pending-selection-highlight"
                            data-testid="pdf-pending-selection-highlight"
                            aria-hidden="true"
                            style={{
                              left: `${box.left * 100}%`,
                              top: `${box.top * 100}%`,
                              width: `${box.width * 100}%`,
                              height: `${box.height * 100}%`,
                            }}
                          />
                        )),
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Document> : <p className="workspace-pane-status">Loading PDF…</p>}
          {passwordCallback ? (
            <form className="pdf-reader-password" aria-label="PDF password" onSubmit={(event) => {
              event.preventDefault();
              const callback = passwordCallback;
              setPasswordCallback(null);
              callback(password);
            }}>
              <label htmlFor="pdf-password">{incorrectPassword ? "Incorrect password. Try again." : "Password required"}</label>
              <input id="pdf-password" type="password" value={password} aria-invalid={incorrectPassword || undefined} onChange={(event) => setPassword(event.target.value)} autoFocus />
              <button type="submit" className="btn-secondary" disabled={!password}>Unlock</button>
            </form>
          ) : null}
        </div>
      )}
      </PdfNavigation>
      {pendingClip ? contextClipSessionId && onAddContextClip ? (
        <button ref={(element) => { popupRef.current = element; }} type="button" className="context-clip-selection" style={pendingClip.position} aria-label="Ask Wikilot" onAnimationEnd={constrainSelectionAction} onMouseDown={(event) => event.preventDefault()} onClick={addPendingClip}>
          <Paperclip size={13} aria-hidden="true" />Ask Wikilot
        </button>
      ) : (
        <div ref={(element) => { popupRef.current = element; }} className="context-clip-selection context-clip-selection-disabled" style={pendingClip.position} role="note" aria-label="Select a Session to add this selection" onAnimationEnd={constrainSelectionAction}>
          <Paperclip size={13} aria-hidden="true" /><span><strong>Select a Session</strong><small>Ask Wikilot needs an active Session</small></span>
        </div>
      ) : null}
    </section>
  );
}
