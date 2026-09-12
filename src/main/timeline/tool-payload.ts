import { createHash } from "node:crypto";
import {
  decodeTimelineToolResult,
  isTimelineImageMimeType,
  type TimelineToolResult,
} from "../../shared/timeline/index.ts";

type ProjectToolResultInput = {
  toolCallId: string;
  toolName: string;
  result: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function timelineImageReference(toolCallId: string, ordinal: number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([toolCallId, ordinal]))
    .digest("base64url");
  return `timeline-image:v1:${digest}`;
}

function projectPdfMetadata(
  toolName: string,
  details: unknown,
): TimelineToolResult["metadata"] | undefined {
  if (toolName !== "read_pdf_page" || !isRecord(details)) return undefined;
  return decodeTimelineToolResult(
    {
      metadata: {
        kind: "pdf_pages",
        path: details.path,
        pageCount: details.pageCount,
        pages: details.pages,
      },
    },
    { allowPdfPageMetadata: true },
  )?.metadata;
}

/**
 * Project a Pi Tool Result into the closed, byte-free Timeline contract.
 * Image references identify call/ordinal only; persisted bytes never affect them.
 */
export function projectTimelineToolResult({
  toolCallId,
  toolName,
  result,
}: ProjectToolResultInput): TimelineToolResult | undefined {
  if (result === undefined) return undefined;
  if (typeof result === "string") return { text: result };
  if (typeof result === "number" || typeof result === "boolean" || typeof result === "bigint") {
    return { text: String(result) };
  }
  if (!isRecord(result)) return {};

  const textBlocks: string[] = [];
  const images: NonNullable<TimelineToolResult["images"]> = [];
  let imageOrdinal = 0;
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (!isRecord(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        textBlocks.push(block.text);
        continue;
      }
      if (block.type !== "image") continue;
      const ordinal = imageOrdinal;
      imageOrdinal += 1;
      if (
        typeof block.data === "string" &&
        isTimelineImageMimeType(block.mimeType)
      ) {
        images.push({
          imageRef: timelineImageReference(toolCallId, ordinal),
          mimeType: block.mimeType,
        });
      }
    }
  }

  const text = textBlocks.length > 0
    ? textBlocks.join("\n")
    : typeof result.output === "string"
      ? result.output
      : undefined;
  const metadata = projectPdfMetadata(toolName, result.details);
  return {
    ...(text !== undefined ? { text } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

/** Extract display text for streaming tool progress without carrying its payload. */
export function timelinePayloadText(payload: unknown): string | undefined {
  return projectTimelineToolResult({
    toolCallId: "progress",
    toolName: "",
    result: payload,
  })?.text;
}
