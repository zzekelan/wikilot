import type { PdfContextClip, PdfSpanLocator, PdfTextBox } from "../../shared/session";

const ANCHOR_CONTEXT = 32;

type NormalizedDom = {
  text: string;
  rawOffsets: number[];
  pointOffset(node: Node, offset: number): number | undefined;
  range(start: number, end: number): Range | undefined;
};

type PdfSelectionCapture = {
  clip: PdfContextClip;
  position: { left: number; top: number };
};

function normalizeText(raw: string): { text: string; rawOffsets: number[] } {
  let text = "";
  const rawOffsets: number[] = [];
  let whitespaceOffset: number | undefined;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (/\s/u.test(character)) {
      if (text && whitespaceOffset === undefined) whitespaceOffset = index;
      continue;
    }
    if (whitespaceOffset !== undefined) {
      text += " ";
      rawOffsets.push(whitespaceOffset);
      whitespaceOffset = undefined;
    }
    text += character;
    rawOffsets.push(index);
  }
  return { text, rawOffsets };
}

function indexTextLayer(layer: HTMLElement): NormalizedDom {
  let raw = "";
  const starts = new WeakMap<Node, number>();
  const textNodes: Array<{ node: Text; start: number; end: number }> = [];
  const boundaries = new WeakMap<Node, number[]>();
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      starts.set(node, raw.length);
      const start = raw.length;
      raw += node.textContent ?? "";
      textNodes.push({ node: node as Text, start, end: raw.length });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const offsets = [raw.length];
    for (const child of node.childNodes) {
      visit(child);
      offsets.push(raw.length);
    }
    boundaries.set(node, offsets);
    if (node.tagName === "BR") raw += "\n";
  };
  visit(layer);
  const normalized = normalizeText(raw);
  const point = (rawOffset: number, previous = false): { node: Text; offset: number } | undefined => {
    const direct = textNodes.find(({ start, end }) => rawOffset >= start && rawOffset <= end);
    if (direct) return { node: direct.node, offset: Math.min(rawOffset - direct.start, direct.node.length) };
    const candidates = previous
      ? textNodes.filter(({ end }) => end <= rawOffset)
      : textNodes.filter(({ start }) => start >= rawOffset);
    const target = previous ? candidates.at(-1) : candidates[0];
    return target ? { node: target.node, offset: previous ? target.node.length : 0 } : undefined;
  };
  return {
    ...normalized,
    pointOffset(node, offset) {
      const start = starts.get(node);
      if (start !== undefined) {
        return start + Math.min(Math.max(0, offset), node.textContent?.length ?? 0);
      }
      const offsets = boundaries.get(node);
      return offsets?.[Math.min(Math.max(0, offset), offsets.length - 1)];
    },
    range(start, end) {
      if (start < 0 || end <= start || end > normalized.text.length) return undefined;
      const rawStart = normalized.rawOffsets[start];
      const rawEnd = end < normalized.rawOffsets.length ? normalized.rawOffsets[end] : raw.length;
      if (rawStart === undefined) return undefined;
      const from = point(rawStart);
      const to = point(rawEnd, true);
      if (!from || !to) return undefined;
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      return range;
    },
  };
}

function normalizedBoundary(offsets: number[], rawOffset: number): number {
  const index = offsets.findIndex((offset) => offset >= rawOffset);
  return index < 0 ? offsets.length : index;
}

function intersectRange(selection: Range, layer: HTMLElement): Range | undefined {
  if (!selection.intersectsNode(layer)) return undefined;
  const page = document.createRange();
  page.selectNodeContents(layer);
  const intersection = selection.cloneRange();
  if (selection.comparePoint(page.startContainer, page.startOffset) === 0) {
    intersection.setStart(page.startContainer, page.startOffset);
  }
  if (selection.comparePoint(page.endContainer, page.endOffset) === 0) {
    intersection.setEnd(page.endContainer, page.endOffset);
  }
  return intersection.collapsed ? undefined : intersection;
}

function rangeRects(range: Range): DOMRect[] {
  const rects = typeof range.getClientRects === "function"
    ? Array.from(range.getClientRects())
    : [];
  if (rects.length > 0) return rects;
  return typeof range.getBoundingClientRect === "function"
    ? [range.getBoundingClientRect()]
    : [];
}

function normalizedBoxes(range: Range, page: HTMLElement): PdfTextBox[] {
  const pageRect = page.getBoundingClientRect();
  if (pageRect.width <= 0 || pageRect.height <= 0) {
    return [{ left: 0, top: 0, width: 1, height: 1 }];
  }
  return rangeRects(range).flatMap((rect) => {
    const left = Math.max(pageRect.left, rect.left);
    const top = Math.max(pageRect.top, rect.top);
    const right = Math.min(pageRect.right, rect.right);
    const bottom = Math.min(pageRect.bottom, rect.bottom);
    if (right <= left || bottom <= top) return [];
    return [{
      left: (left - pageRect.left) / pageRect.width,
      top: (top - pageRect.top) / pageRect.height,
      width: (right - left) / pageRect.width,
      height: (bottom - top) / pageRect.height,
    }];
  });
}

function visiblePosition(ranges: Range[], scroller: HTMLElement): { left: number; top: number } {
  const viewport = scroller.getBoundingClientRect();
  const visible = ranges.flatMap(rangeRects).filter((rect) =>
    rect.bottom > viewport.top && rect.top < viewport.bottom
    && rect.right > viewport.left && rect.left < viewport.right
  );
  const rect = visible.at(-1);
  if (!rect || viewport.width <= 0 || viewport.height <= 0) {
    return { left: viewport.left, top: viewport.top };
  }
  return {
    left: Math.min(viewport.right - 16, Math.max(viewport.left + 16, rect.left + rect.width / 2)),
    top: Math.min(viewport.bottom - 8, Math.max(viewport.top + 8, rect.top)),
  };
}

export function capturePdfSelection(
  path: string,
  fingerprint: string,
  scroller: HTMLElement,
  selection: Selection,
): PdfSelectionCapture | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const selected = selection.getRangeAt(0);
  const spans: PdfSpanLocator[] = [];
  const ranges: Range[] = [];
  for (const page of scroller.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
    const pageNumber = Number(page.dataset.pdfPage);
    const layer = page.querySelector<HTMLElement>(".react-pdf__Page__textContent");
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || !layer) continue;
    const range = intersectRange(selected, layer);
    if (!range) continue;
    const dom = indexTextLayer(layer);
    const rawStart = dom.pointOffset(range.startContainer, range.startOffset);
    const rawEnd = dom.pointOffset(range.endContainer, range.endOffset);
    if (rawStart === undefined || rawEnd === undefined || rawEnd <= rawStart) continue;
    const start = normalizedBoundary(dom.rawOffsets, rawStart);
    const end = normalizedBoundary(dom.rawOffsets, rawEnd);
    const selectedText = dom.text.slice(start, end);
    const leading = selectedText.length - selectedText.trimStart().length;
    const exact = selectedText.trim();
    if (!exact) continue;
    const adjustedStart = start + leading;
    const adjustedEnd = adjustedStart + exact.length;
    const boxes = normalizedBoxes(range, page.querySelector<HTMLElement>(".react-pdf__Page") ?? page);
    if (boxes.length === 0) continue;
    spans.push({
      page: pageNumber,
      start: adjustedStart,
      end: adjustedEnd,
      exact,
      prefix: dom.text.slice(Math.max(0, adjustedStart - ANCHOR_CONTEXT), adjustedStart),
      suffix: dom.text.slice(adjustedEnd, adjustedEnd + ANCHOR_CONTEXT),
      boxes,
    });
    ranges.push(range);
  }
  if (spans.length === 0) return null;
  return {
    clip: {
      source: { kind: "pdf", path },
      text: spans.map((span) => span.exact).join("\n"),
      fingerprint,
      locator: { kind: "pdf", spans },
    },
    position: visiblePosition(ranges, scroller),
  };
}

function uniqueAnchoredOffset(text: string, span: PdfSpanLocator): number | undefined {
  const candidates: number[] = [];
  let offset = text.indexOf(span.exact);
  while (offset >= 0) {
    candidates.push(offset);
    offset = text.indexOf(span.exact, offset + 1);
  }
  if (candidates.length === 1) return candidates[0];
  const anchored = candidates.filter((start) =>
    (!span.prefix || text.slice(0, start).endsWith(span.prefix))
    && (!span.suffix || text.slice(start + span.exact.length).startsWith(span.suffix))
  );
  return anchored.length === 1 ? anchored[0] : undefined;
}

/** Relocate all spans atomically; no partial result is ever returned. */
export function relocatePdfClip(
  scroller: HTMLElement,
  clip: PdfContextClip,
): PdfSpanLocator[] | null {
  const relocated: PdfSpanLocator[] = [];
  for (const span of clip.locator.spans) {
    const page = scroller.querySelector<HTMLElement>(`[data-pdf-page="${span.page}"]`);
    const layer = page?.querySelector<HTMLElement>(".react-pdf__Page__textContent");
    if (!page || !layer) return null;
    const dom = indexTextLayer(layer);
    const start = uniqueAnchoredOffset(dom.text, span);
    if (start === undefined) return null;
    const end = start + span.exact.length;
    const range = dom.range(start, end);
    if (!range) return null;
    const boxes = normalizedBoxes(range, page.querySelector<HTMLElement>(".react-pdf__Page") ?? page);
    if (boxes.length === 0) return null;
    relocated.push({
      ...span,
      start,
      end,
      prefix: dom.text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
      suffix: dom.text.slice(end, end + ANCHOR_CONTEXT),
      boxes,
    });
  }
  return relocated;
}
