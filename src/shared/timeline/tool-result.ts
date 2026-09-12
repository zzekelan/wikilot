import type { TimelineToolResult } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function isTimelineImageMimeType(value: unknown): value is string {
  return typeof value === "string" && /^image\/[A-Za-z0-9.+-]+$/.test(value);
}

/** Decode the closed Timeline Tool Result contract at a process boundary. */
export function decodeTimelineToolResult(
  value: unknown,
  options: { allowPdfPageMetadata: boolean },
): TimelineToolResult | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["text", "images", "metadata"])) {
    return undefined;
  }
  if (value.text !== undefined && typeof value.text !== "string") return undefined;

  let images: TimelineToolResult["images"];
  if (value.images !== undefined) {
    if (!Array.isArray(value.images)) return undefined;
    images = [];
    for (const image of value.images) {
      if (
        !isRecord(image) ||
        !hasOnlyKeys(image, ["imageRef", "mimeType"]) ||
        typeof image.imageRef !== "string" ||
        !/^timeline-image:v1:[A-Za-z0-9_-]{43}$/.test(image.imageRef) ||
        !isTimelineImageMimeType(image.mimeType)
      ) {
        return undefined;
      }
      images.push({ imageRef: image.imageRef, mimeType: image.mimeType });
    }
  }

  let metadata: TimelineToolResult["metadata"];
  if (value.metadata !== undefined) {
    const candidate = value.metadata;
    if (
      !options.allowPdfPageMetadata || !isRecord(candidate) ||
      !hasOnlyKeys(candidate, ["kind", "path", "pageCount", "pages"]) ||
      candidate.kind !== "pdf_pages" || typeof candidate.path !== "string" ||
      candidate.path.length === 0 || !positiveInteger(candidate.pageCount) ||
      !Array.isArray(candidate.pages) || candidate.pages.length === 0
    ) return undefined;
    const pages: NonNullable<TimelineToolResult["metadata"]>["pages"] = [];
    for (const page of candidate.pages) {
      if (!isRecord(page) || !hasOnlyKeys(page, ["page", "width", "height"]) ||
        !positiveInteger(page.page) || page.page > candidate.pageCount ||
        !positiveInteger(page.width) || !positiveInteger(page.height)) return undefined;
      pages.push({ page: page.page, width: page.width, height: page.height });
    }
    if (images && images.length !== pages.length) return undefined;
    metadata = { kind: "pdf_pages", path: candidate.path, pageCount: candidate.pageCount, pages };
  }

  return {
    ...(value.text !== undefined ? { text: value.text } : {}),
    ...(images !== undefined ? { images } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}
