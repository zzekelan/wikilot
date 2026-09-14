import { matchPromptCommand, type PromptCommandId } from "./prompt-commands.ts";

export const PROMPT_ENTRY_TYPE = "wikilot.prompt";
export const PROMPT_ENTRY_VERSION = 1;
export const MAX_CONTEXT_CLIPS = 20;
export const MAX_CONTEXT_CLIP_CHARACTERS = 50_000;
export const MAX_CONTEXT_CLIP_TOTAL_CHARACTERS = 100_000;
export const MAX_CONTEXT_CLIP_SOURCE_PATH_CHARACTERS = 1_024;
export const MAX_CONTEXT_CLIP_ANCHOR_CHARACTERS = 256;
export const MAX_CONTEXT_CLIP_FINGERPRINT_CHARACTERS = 256;
export const MAX_CONTEXT_CLIP_HEADING_CHARACTERS = 1_024;

export type MarkdownLocator = {
  kind: "markdown";
  mode: "reading" | "editing";
  /** UTF-16 offsets in rendered-visible text (reading) or Markdown source (editing). */
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
  lineStart?: number;
  lineEnd?: number;
  heading?: string;
};

export type PdfTextBox = {
  /** Page-relative coordinates normalized to the rendered page bounds. */
  left: number;
  top: number;
  width: number;
  height: number;
};

export type PdfSpanLocator = {
  page: number;
  /** UTF-16 offsets in this page's normalized text-layer text. */
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
  boxes: PdfTextBox[];
};

export type PdfLocator = {
  kind: "pdf";
  spans: PdfSpanLocator[];
};

export type MarkdownContextClip = {
  source: {
    kind: "markdown";
    /** Canonical Workspace-relative path using `/` separators. */
    path: string;
  };
  /** Immutable rendered visible text captured from reading mode. */
  text: string;
  /** Capture-time source fingerprint. */
  fingerprint: string;
  locator: MarkdownLocator;
};

export type PdfContextClip = {
  source: {
    kind: "pdf";
    /** Canonical Workspace-relative path using `/` separators. */
    path: string;
  };
  /** Immutable normalized text-layer text, joined with newlines between pages. */
  text: string;
  /** Capture-time PDF document fingerprint. */
  fingerprint: string;
  locator: PdfLocator;
};

export type ContextClip = MarkdownContextClip | PdfContextClip;

export function contextClipIdentity(clip: ContextClip): string {
  return clip.locator.kind === "markdown"
    ? JSON.stringify([
        clip.source.path,
        clip.fingerprint,
        clip.locator.mode,
        clip.locator.start,
        clip.locator.end,
      ])
    : JSON.stringify([
        clip.source.path,
        clip.fingerprint,
        clip.locator.spans.map(({ page, start, end }) => [page, start, end]),
      ]);
}

export function sameContextClip(left: ContextClip, right: ContextClip): boolean {
  return contextClipIdentity(left) === contextClipIdentity(right);
}

export type StructuredPrompt = {
  workspaceId: string;
  sessionId: string;
  text: string;
  command?: PromptCommandId;
  clips: ContextClip[];
};

/**
 * The submitted Prompt preserved in Session history before model serialization
 * or command expansion. Text is the normalized user input; Clips remain quoted
 * source snapshots. Workspace and Session identity belong to the containing history.
 */
export type PromptRecord = {
  version: typeof PROMPT_ENTRY_VERSION;
  text: string;
  command?: PromptCommandId;
  clips: ContextClip[];
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  const text = requiredString(value, name);
  if ([...text].length > maximum) {
    throw new Error(`${name} may contain at most ${maximum} characters`);
  }
  return text;
}

function optionalBoundedString(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  if ([...value].length > maximum) {
    throw new Error(`${name} may contain at most ${maximum} characters`);
  }
  return value;
}

function safeWorkspacePath(value: unknown): string {
  const path = requiredString(value, "Context Clip source path");
  if ([...path].length > MAX_CONTEXT_CLIP_SOURCE_PATH_CHARACTERS) {
    throw new Error(`Context Clip source path may contain at most ${MAX_CONTEXT_CLIP_SOURCE_PATH_CHARACTERS} characters`);
  }
  if (
    path.startsWith("/") ||
    path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new Error("Context Clip source path must be Workspace-relative");
  }
  return path;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value as number;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, name: string): number {
  const number = optionalPositiveInteger(value, name);
  if (number === undefined) throw new Error(`${name} is required`);
  return number;
}

function normalizedCoordinate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return value;
}

function normalizePdfLocator(locator: Record<string, unknown>, text: string): PdfLocator {
  if (!Array.isArray(locator.spans) || locator.spans.length === 0) {
    throw new Error("PDF Context Clip spans are required");
  }
  let previousPage = 0;
  const spans = locator.spans.map((value): PdfSpanLocator => {
    const input = record(value);
    if (!input) throw new Error("PDF Context Clip span is invalid");
    const page = positiveInteger(input.page, "PDF Context Clip span page");
    if (page <= previousPage) throw new Error("PDF Context Clip span pages must be ordered");
    previousPage = page;
    const start = nonNegativeInteger(input.start, "PDF Context Clip span start");
    const end = nonNegativeInteger(input.end, "PDF Context Clip span end");
    const exact = requiredString(input.exact, "PDF Context Clip span text");
    if (end <= start || end - start !== exact.length) {
      throw new Error("PDF Context Clip span range is invalid");
    }
    const prefix = optionalBoundedString(
      input.prefix,
      "PDF Context Clip span prefix",
      MAX_CONTEXT_CLIP_ANCHOR_CHARACTERS,
    ) ?? "";
    const suffix = optionalBoundedString(
      input.suffix,
      "PDF Context Clip span suffix",
      MAX_CONTEXT_CLIP_ANCHOR_CHARACTERS,
    ) ?? "";
    if (!Array.isArray(input.boxes) || input.boxes.length === 0) {
      throw new Error("PDF Context Clip span boxes are required");
    }
    const boxes = input.boxes.map((value): PdfTextBox => {
      const box = record(value);
      if (!box) throw new Error("PDF Context Clip box is invalid");
      const left = normalizedCoordinate(box.left, "PDF Context Clip box left");
      const top = normalizedCoordinate(box.top, "PDF Context Clip box top");
      const width = normalizedCoordinate(box.width, "PDF Context Clip box width");
      const height = normalizedCoordinate(box.height, "PDF Context Clip box height");
      if (width === 0 || height === 0 || left + width > 1.000_001 || top + height > 1.000_001) {
        throw new Error("PDF Context Clip box must fit within its page");
      }
      return { left, top, width, height };
    });
    return { page, start, end, exact, prefix, suffix, boxes };
  });
  if (spans.map((span) => span.exact).join("\n") !== text) {
    throw new Error("PDF Context Clip spans must match captured text");
  }
  return { kind: "pdf", spans };
}

function normalizeClip(value: unknown): ContextClip {
  const input = record(value);
  const source = record(input?.source);
  const locator = record(input?.locator);
  if (!input || !source || !locator) throw new Error("Context Clip is invalid");
  if (source.kind !== locator.kind || (source.kind !== "markdown" && source.kind !== "pdf")) {
    throw new Error("Context Clip kind is invalid");
  }
  const text = requiredString(input.text, "Context Clip text");
  const characterCount = [...text].length;
  if (characterCount > MAX_CONTEXT_CLIP_CHARACTERS) {
    throw new Error(`A Context Clip may contain at most ${MAX_CONTEXT_CLIP_CHARACTERS} characters`);
  }
  const path = safeWorkspacePath(source.path);
  const fingerprint = boundedString(
    input.fingerprint,
    "Context Clip fingerprint",
    MAX_CONTEXT_CLIP_FINGERPRINT_CHARACTERS,
  );
  if (locator.kind === "pdf") {
    return {
      source: { kind: "pdf", path },
      text,
      fingerprint,
      locator: normalizePdfLocator(locator, text),
    };
  }
  if (locator.mode !== "reading" && locator.mode !== "editing") {
    throw new Error("Context Clip kind is invalid");
  }
  const start = nonNegativeInteger(locator.start, "Context Clip locator start");
  const end = nonNegativeInteger(locator.end, "Context Clip locator end");
  if (end <= start) throw new Error("Context Clip locator range is invalid");
  const exact = requiredString(locator.exact, "Context Clip locator exact text");
  if (exact !== text) throw new Error("Context Clip locator must match captured text");
  const prefix = optionalBoundedString(locator.prefix, "Context Clip locator prefix", MAX_CONTEXT_CLIP_ANCHOR_CHARACTERS) ?? "";
  const suffix = optionalBoundedString(locator.suffix, "Context Clip locator suffix", MAX_CONTEXT_CLIP_ANCHOR_CHARACTERS) ?? "";
  const heading = optionalBoundedString(locator.heading, "Context Clip heading", MAX_CONTEXT_CLIP_HEADING_CHARACTERS);
  const lineStart = optionalPositiveInteger(locator.lineStart, "Context Clip lineStart");
  const lineEnd = optionalPositiveInteger(locator.lineEnd, "Context Clip lineEnd");
  if (lineStart !== undefined && lineEnd !== undefined && lineEnd < lineStart) {
    throw new Error("Context Clip line range is invalid");
  }
  return {
    source: { kind: "markdown", path },
    text,
    fingerprint,
    locator: {
      kind: "markdown",
      mode: locator.mode,
      start,
      end,
      exact,
      prefix,
      suffix,
      ...(lineStart !== undefined ? { lineStart } : {}),
      ...(lineEnd !== undefined ? { lineEnd } : {}),
      ...(heading?.trim() ? { heading } : {}),
    },
  };
}

/** Validate and copy the complete cross-process Prompt contract. */
export function normalizeStructuredPrompt(value: unknown): StructuredPrompt {
  const input = record(value);
  if (!input) throw new Error("Structured Prompt is required");
  const workspaceId = requiredString(input.workspaceId, "workspaceId").trim();
  const sessionId = requiredString(input.sessionId, "sessionId").trim();
  if (typeof input.text !== "string") throw new Error("Prompt text must be a string");
  if (!Array.isArray(input.clips)) throw new Error("Prompt clips must be an array");
  if (input.clips.length > MAX_CONTEXT_CLIPS) {
    throw new Error(`A Prompt may contain at most ${MAX_CONTEXT_CLIPS} Context Clips`);
  }
  const clips = input.clips.map(normalizeClip);
  const totalCharacters = clips.reduce((total, clip) => total + [...clip.text].length, 0);
  if (totalCharacters > MAX_CONTEXT_CLIP_TOTAL_CHARACTERS) {
    throw new Error(`Context Clips may contain at most ${MAX_CONTEXT_CLIP_TOTAL_CHARACTERS} characters in total`);
  }
  const text = input.text.trim();
  if (!text && clips.length === 0) {
    throw new Error("Prompt text or at least one Context Clip is required");
  }
  const command = input.command === undefined ? undefined : matchPromptCommand(text);
  if (input.command !== undefined && (command === undefined || input.command !== command)) {
    throw new Error("Invalid Prompt command");
  }
  return { workspaceId, sessionId, text, clips, ...(command !== undefined ? { command } : {}) };
}

/** Preserve the whole submission, including Prompts without Context Clips. */
export function createPromptRecord(prompt: StructuredPrompt): PromptRecord {
  return { version: PROMPT_ENTRY_VERSION, text: prompt.text, clips: prompt.clips, ...(prompt.command ? { command: prompt.command } : {}) };
}

export function readPromptRecord(value: unknown): PromptRecord | undefined {
  const input = record(value);
  if (input?.version !== PROMPT_ENTRY_VERSION || typeof input.text !== "string") return undefined;
  try {
    const normalized = normalizeStructuredPrompt({
      workspaceId: "prompt-record",
      sessionId: "prompt-record",
      text: input.text,
      command: input.command,
      clips: input.clips,
    });
    return createPromptRecord(normalized);
  } catch {
    return undefined;
  }
}
