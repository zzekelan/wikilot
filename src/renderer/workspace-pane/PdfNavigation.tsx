import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, List, Search, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { recordUiGesture } from "../telemetry";
import { pushEscapeLayer } from "../escape-stack";

type OutlineItem = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];
type SearchHit = { page: number; position: number; excerpt: string };
type PdfNavigationProps = {
  document: PDFDocumentProxy | null;
  controls?: ReactNode;
  children?: ReactNode;
  onNavigate(page: number, position: number, query?: string): void;
};

/** Navigation reads PDF.js metadata and text only when the reader requests it. */
export function PdfNavigation({ document: pdf, controls, children, onNavigate }: PdfNavigationProps) {
  const [panel, setPanel] = useState<"search" | "contents" | null>(null);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [scanned, setScanned] = useState(0);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const contentsButtonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const navigationVersion = useRef(0);

  useEffect(() => {
    let active = true;
    navigationVersion.current += 1;
    setOutline([]);
    if (pdf) void pdf.getOutline().then((items) => {
      if (active) setOutline(items ?? []);
    }).catch(() => {});
    return () => { active = false; navigationVersion.current += 1; };
  }, [pdf]);

  useEffect(() => {
    if (panel === "search") inputRef.current?.focus();
    if (!panel) return;
    return pushEscapeLayer(() => {
      setPanel(null);
      (panel === "search" ? searchButtonRef : contentsButtonRef).current?.focus();
    });
  }, [panel]);

  useEffect(() => {
    let active = true;
    setHits([]);
    setScanned(0);
    setSelected(-1);
    setError(null);
    const needle = query.trim().toLowerCase();
    if (!pdf || panel !== "search" || !needle) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const found: SearchHit[] = [];
        for (let pageNumber = 1; pageNumber <= pdf.numPages && active; pageNumber += 1) {
          const page = await pdf.getPage(pageNumber);
          if (!active) return;
          const content = await page.getTextContent();
          if (!active) return;
          const items = content.items.filter((item) => "str" in item);
          const text = items.map((item) => item.str).join(" ");
          const lower = text.toLowerCase();
          const viewport = page.getViewport({ scale: 1 });
          let offset = lower.indexOf(needle);
          while (offset >= 0 && found.length < 200) {
            let start = 0;
            const item = items.find((candidate) => {
              const end = start + candidate.str.length;
              const contains = offset <= end;
              start = end + 1;
              return contains;
            });
            const top = item ? viewport.convertToViewportPoint(item.transform[4]!, item.transform[5]!)[1]! : 0;
            found.push({ page: pageNumber, position: Math.max(0, Math.min(1, (top - 30) / viewport.height)), excerpt: `${offset > 45 ? "…" : ""}${text.slice(Math.max(0, offset - 45), offset + needle.length + 75)}${offset + needle.length + 75 < text.length ? "…" : ""}` });
            offset = lower.indexOf(needle, offset + Math.max(1, needle.length));
          }
          if (!active) return;
          setHits([...found]);
          setScanned(pageNumber);
          if (found.length >= 200) break;
        }
        if (active) setSearching(false);
      })().catch((cause: unknown) => {
        if (!active) return;
        setSearching(false);
        setError(cause instanceof Error ? cause.message : "Could not search this PDF.");
      });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [panel, pdf, query]);

  function selectHit(index: number) {
    if (!hits.length) return;
    const next = (index + hits.length) % hits.length;
    const hit = hits[next]!;
    setSelected(next);
    onNavigate(hit.page, hit.position, query.trim());
    recordUiGesture("reader.search.navigate", { "wikilot.gesture": "reader.search.navigate", "wikilot.reader.page": String(hit.page) });
  }

  async function navigateOutline(item: OutlineItem) {
    if (!pdf || !item.dest) return;
    const version = navigationVersion.current;
    try {
      const destination = typeof item.dest === "string" ? await pdf.getDestination(item.dest) : item.dest;
      if (!destination?.length) throw new Error("This section has no page location.");
      const reference = destination[0];
      const index = typeof reference === "number" ? reference : await pdf.getPageIndex(reference);
      if (version !== navigationVersion.current) return;
      if (index < 0 || index >= pdf.numPages) throw new Error("This section's page is unavailable.");
      onNavigate(index + 1, 0);
      recordUiGesture("reader.contents.navigate", { "wikilot.gesture": "reader.contents.navigate", "wikilot.reader.page": String(index + 1) });
    } catch (cause) {
      if (version !== navigationVersion.current) return;
      setError(cause instanceof Error ? cause.message : "Could not open this section.");
    }
  }

  function renderOutline(items: OutlineItem[]) {
    return <ul className="pdf-outline-list">{items.map((item, index) => <li key={index}>
      <button type="button" disabled={!item.dest} onClick={() => void navigateOutline(item)}>{item.title || "Untitled section"}</button>
      {item.items.length ? renderOutline(item.items) : null}
    </li>)}</ul>;
  }

  return <div className="pdf-reader-layout" onKeyDown={(event) => {
    if (pdf && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setPanel("search");
      inputRef.current?.focus();
    }
  }}>
    <div className="pdf-reader-bar" role="toolbar" aria-label="PDF Reader">
      <div className="pdf-navigation-actions">
        <button ref={contentsButtonRef} type="button" className="pdf-reader-fit" disabled={!outline.length} aria-label="Contents" title={outline.length ? "Contents" : "No contents available"} aria-controls={panelId} aria-expanded={panel === "contents"} onClick={() => setPanel(panel === "contents" ? null : "contents")}><List size={16} /><span>Contents</span></button>
        <button ref={searchButtonRef} type="button" className="pdf-reader-fit" disabled={!pdf} aria-label="Search PDF" title="Search PDF (⌘F)" aria-controls={panelId} aria-expanded={panel === "search"} onClick={() => setPanel(panel === "search" ? null : "search")}><Search size={16} /><span>Search</span></button>
      </div>
      {controls}
    </div>
    <div className="pdf-reader-content">
    <aside id={panelId} className="pdf-navigation" aria-label="PDF navigation" hidden={!panel}>
      <div className="pdf-navigation-heading"><span>{panel === "search" ? "Search PDF" : "Contents"}</span><button type="button" className="icon-btn" aria-label="Close PDF navigation" onClick={() => {
        setPanel(null);
        (panel === "search" ? searchButtonRef : contentsButtonRef).current?.focus();
      }}><X size={14} /></button></div>
    {panel === "search" ? <div className="pdf-search-panel">
      <div className="pdf-search-controls">
        <input ref={inputRef} type="search" aria-label="Search PDF text" placeholder="Find in this document…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); selectHit(selected + (event.shiftKey ? -1 : 1)); }
        }} />
        <button type="button" className="icon-btn" aria-label="Previous PDF match" disabled={!hits.length} onClick={() => selectHit(selected - 1)}><ChevronUp size={14} /></button>
        <button type="button" className="icon-btn" aria-label="Next PDF match" disabled={!hits.length} onClick={() => selectHit(selected + 1)}><ChevronDown size={14} /></button>
      </div>
      {query.trim() ? <p role="status" className="pdf-navigation-status">{searching ? `Searching page ${scanned} of ${pdf?.numPages ?? 0}… · ${hits.length} matches` : hits.length === 200 ? "Showing the first 200 matches. Refine your search for more." : `${hits.length} ${hits.length === 1 ? "match" : "matches"}`}</p> : null}
      {hits.length ? <ol className="pdf-search-results">{hits.map((hit, index) => <li key={index}><button type="button" aria-current={selected === index ? "true" : undefined} onClick={() => selectHit(index)}><strong>Page {hit.page}</strong><span>{hit.excerpt}</span></button></li>)}</ol> : null}
    </div> : null}
    {panel === "contents" ? <nav aria-label="PDF contents" className="pdf-outline">{renderOutline(outline)}</nav> : null}
    {error && panel ? <p className="pdf-navigation-status" role="alert">{error}</p> : null}
    </aside>
    <div className="pdf-reader-stage">{children}</div>
    </div>
  </div>;
}
