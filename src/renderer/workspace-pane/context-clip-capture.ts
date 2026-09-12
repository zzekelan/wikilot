import type { MarkdownContextClip } from "../../shared/session";

const ANCHOR_CONTEXT = 32;

export function fingerprintMarkdown(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, Math.max(0, offset)).split("\n").length;
}

function headingBefore(source: string, line: number): string | undefined {
  const lines = source.split("\n").slice(0, line);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^(?:#{1,6})\s+(.+?)\s*$/u.exec(lines[index] ?? "");
    if (match?.[1]) return match[1].replace(/[*_`~]/gu, "").trim();
  }
  return undefined;
}

type NormalizedText = { text: string; rawOffsets: number[] };
type VisibleDomIndex = NormalizedText & {
  pointOffset(node: Node, offset: number): number | undefined;
  range(start: number, end: number): Range | undefined;
};

const BLOCK_ELEMENTS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET",
  "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
  "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TR", "UL",
]);

function indexVisibleDom(surface: HTMLElement): VisibleDomIndex {
  let raw = "";
  const textStarts = new WeakMap<Node, number>();
  const textNodes: Array<{ node: Text; start: number; end: number }> = [];
  const elementBoundaries = new WeakMap<Node, number[]>();
  const boundary = () => {
    if (raw && !/\s$/u.test(raw)) raw += "\n";
  };
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      textStarts.set(node, raw.length);
      const start = raw.length;
      raw += node.textContent ?? "";
      textNodes.push({ node: node as Text, start, end: raw.length });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const block = BLOCK_ELEMENTS.has(node.tagName);
    if (block || node.tagName === "BR") boundary();
    const boundaries = [raw.length];
    for (const child of node.childNodes) {
      visit(child);
      boundaries.push(raw.length);
    }
    elementBoundaries.set(node, boundaries);
    if (block || node.tagName === "BR") boundary();
  };
  visit(surface);
  const normalized = normalizeVisibleText(raw);
  const domPoint = (rawOffset: number, preferPrevious = false): { node: Text; offset: number } | undefined => {
    const direct = textNodes.find(({ start, end }) => rawOffset >= start && rawOffset <= end);
    if (direct) return { node: direct.node, offset: Math.min(rawOffset - direct.start, direct.node.data.length) };
    const candidates = preferPrevious
      ? textNodes.filter(({ end }) => end <= rawOffset)
      : textNodes.filter(({ start }) => start >= rawOffset);
    const target = preferPrevious ? candidates.at(-1) : candidates[0];
    return target
      ? { node: target.node, offset: preferPrevious ? target.node.data.length : 0 }
      : undefined;
  };
  return {
    ...normalized,
    pointOffset(node, offset) {
      const textStart = textStarts.get(node);
      if (textStart !== undefined) {
        return textStart + Math.min(Math.max(0, offset), node.textContent?.length ?? 0);
      }
      const boundaries = elementBoundaries.get(node);
      if (!boundaries) return undefined;
      return boundaries[Math.min(Math.max(0, offset), boundaries.length - 1)];
    },
    range(start, end) {
      if (end <= start || start < 0 || end > normalized.text.length) return undefined;
      const rawStart = normalized.rawOffsets[start];
      const rawEnd = end < normalized.rawOffsets.length
        ? normalized.rawOffsets[end]
        : raw.length;
      if (rawStart === undefined) return undefined;
      const from = domPoint(rawStart);
      const to = domPoint(rawEnd, true);
      if (!from || !to) return undefined;
      const range = document.createRange();
      range.setStart(from.node, from.offset);
      range.setEnd(to.node, to.offset);
      return range;
    },
  };
}

function normalizeVisibleText(raw: string): NormalizedText {
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

function normalizedBoundary(offsets: number[], rawOffset: number): number {
  const index = offsets.findIndex((offset) => offset >= rawOffset);
  return index < 0 ? offsets.length : index;
}

function uniqueSourceOffset(source: string, text: string): number | undefined {
  const first = source.indexOf(text);
  if (first < 0 || source.indexOf(text, first + 1) >= 0) return undefined;
  return first;
}

export type MarkdownClipLocation =
  | { status: "exact" | "relocated"; start: number; end: number }
  | { status: "changed" };

/** Resolve a Clip against the source stream used by its capture mode. */
export function locateMarkdownClip(
  clip: MarkdownContextClip,
  currentFingerprint: string,
  currentText: string,
): MarkdownClipLocation {
  const { locator } = clip;
  if (
    currentFingerprint === clip.fingerprint &&
    currentText.slice(locator.start, locator.end) === locator.exact
  ) {
    return { status: "exact", start: locator.start, end: locator.end };
  }

  const candidates: number[] = [];
  let offset = currentText.indexOf(locator.exact);
  while (offset >= 0) {
    candidates.push(offset);
    offset = currentText.indexOf(locator.exact, offset + 1);
  }
  if (candidates.length === 1) {
    return {
      status: "relocated",
      start: candidates[0]!,
      end: candidates[0]! + locator.exact.length,
    };
  }
  const prefixAnchored = locator.prefix
    ? candidates.filter((start) => currentText.slice(0, start).endsWith(locator.prefix))
    : [];
  const suffixAnchored = locator.suffix
    ? candidates.filter((start) => currentText.slice(start + locator.exact.length).startsWith(locator.suffix))
    : [];
  const prefixMatch = prefixAnchored.length === 1 ? prefixAnchored[0] : undefined;
  const suffixMatch = suffixAnchored.length === 1 ? suffixAnchored[0] : undefined;
  const anchored = prefixMatch !== undefined && suffixMatch !== undefined && prefixMatch !== suffixMatch
    ? undefined
    : prefixMatch ?? suffixMatch;
  return anchored !== undefined
    ? { status: "relocated", start: anchored, end: anchored + locator.exact.length }
    : { status: "changed" };
}

export function locateMarkdownReadingClip(
  surface: HTMLElement,
  clip: MarkdownContextClip,
  currentFingerprint: string,
): { status: "exact" | "relocated" | "changed"; range?: Range } {
  const dom = indexVisibleDom(surface);
  const location = locateMarkdownClip(clip, currentFingerprint, dom.text);
  if (location.status === "changed") return location;
  const range = dom.range(location.start, location.end);
  return range ? { status: location.status, range } : { status: "changed" };
}

/** Convert one DOM Range from the safe reading surface into an immutable Clip. */
export function buildMarkdownReadingClip(
  path: string,
  source: string,
  surface: HTMLElement,
  range: Range,
): MarkdownContextClip | null {
  if (!surface.contains(range.startContainer) || !surface.contains(range.endContainer)) {
    return null;
  }
  const dom = indexVisibleDom(surface);
  const rawStart = dom.pointOffset(range.startContainer, range.startOffset);
  const rawEnd = dom.pointOffset(range.endContainer, range.endOffset);
  if (rawStart === undefined || rawEnd === undefined || rawEnd <= rawStart) return null;
  const start = normalizedBoundary(dom.rawOffsets, rawStart);
  const end = normalizedBoundary(dom.rawOffsets, rawEnd);
  const selectedText = dom.text.slice(start, end);
  const leadingWhitespace = selectedText.length - selectedText.trimStart().length;
  const text = selectedText.trim();
  if (!text) return null;
  const adjustedStart = start + leadingWhitespace;
  const adjustedEnd = adjustedStart + text.length;

  const sourceOffset = uniqueSourceOffset(source, text);
  const lineStart = sourceOffset !== undefined ? lineAt(source, sourceOffset) : undefined;
  const lineEnd = sourceOffset !== undefined
    ? lineAt(source, sourceOffset + text.length)
    : undefined;
  const heading = lineStart === undefined ? undefined : headingBefore(source, lineStart - 1);

  return {
    source: { kind: "markdown", path },
    text,
    fingerprint: fingerprintMarkdown(source),
    locator: {
      kind: "markdown",
      mode: "reading",
      start: adjustedStart,
      end: adjustedEnd,
      exact: text,
      prefix: dom.text.slice(Math.max(0, adjustedStart - ANCHOR_CONTEXT), adjustedStart),
      suffix: dom.text.slice(adjustedEnd, adjustedEnd + ANCHOR_CONTEXT),
      ...(lineStart !== undefined ? { lineStart } : {}),
      ...(lineEnd !== undefined ? { lineEnd } : {}),
      ...(heading ? { heading } : {}),
    },
  };
}

/** Capture a CodeMirror source selection without rendering or normalization. */
export function buildMarkdownEditingClip(
  path: string,
  source: string,
  anchor: number,
  head: number,
): MarkdownContextClip | null {
  const start = Math.max(0, Math.min(anchor, head, source.length));
  const end = Math.max(0, Math.min(Math.max(anchor, head), source.length));
  if (end <= start) return null;
  const text = source.slice(start, end);
  if (!text.trim()) return null;
  const lineStart = lineAt(source, start);
  const lineEnd = lineAt(source, end);
  const heading = headingBefore(source, lineStart - 1);
  return {
    source: { kind: "markdown", path },
    text,
    fingerprint: fingerprintMarkdown(source),
    locator: {
      kind: "markdown",
      mode: "editing",
      start,
      end,
      exact: text,
      prefix: source.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
      suffix: source.slice(end, end + ANCHOR_CONTEXT),
      lineStart,
      lineEnd,
      ...(heading ? { heading } : {}),
    },
  };
}
