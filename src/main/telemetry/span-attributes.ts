import { createHash } from "node:crypto";

export type TurnSpanInput = {
  sessionId: string;
  workspaceId?: string;
  cwd: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  wikiPromptEnabled: boolean;
  clipCount?: number;
  clipCharacters?: number;
  /**
   * Full Wiki idea-file text. Only set when captureContent=full and the
   * fragment was actually injected; never copy credentials here.
   */
  wikiPromptFragment?: string;
  /**
   * Live assembled AgentSession system prompt (base + appends + project
   * context). Only set when captureContent=full.
   */
  systemPrompt?: string;
  /** Must never be copied into span attributes. */
  apiKey?: string;
};

export type ToolOutcome = "success" | "error" | "cancelled" | "timeout";

export type PdfPageToolErrorCode =
  | "not_found"
  | "not_pdf"
  | "unsafe_path"
  | "too_large"
  | "unavailable"
  | "source_changed"
  | "encrypted"
  | "invalid_pdf"
  | "page_out_of_range"
  | "timeout"
  | "cancelled"
  | "render_failed"
  | "read_failed";

export type SpanAttributes = Record<string, string | number>;

export type ToolSpanInput = {
  sessionId: string;
  toolName: string;
  toolCallId: string;
  /** Accepted only for the App-owned read_pdf_page Tool. */
  timeoutSeconds?: number;
  apiKey?: string;
};

type PdfPageExecutionErrorCode = Exclude<
  PdfPageToolErrorCode,
  "timeout" | "cancelled"
>;

export type ReadPdfPageToolCompletionSpanInput =
  | {
      outcome: "success";
      timeoutSeconds: number;
      imageCount: number;
      imageMimeType: "image/png";
      imageWidth?: number;
      imageHeight?: number;
    }
  | {
      outcome: "error";
      timeoutSeconds: number;
      errorCode: PdfPageExecutionErrorCode;
    }
  | {
      outcome: "timeout";
      timeoutSeconds: number;
      errorCode: "timeout";
    }
  | {
      outcome: "cancelled";
      timeoutSeconds: number;
      errorCode: "cancelled";
    };

export type CredentialSaveSpanInput = {
  providerId: string;
  /** Must never be copied into span attributes. */
  apiKey?: string;
};

export type DefaultsSaveSpanInput = {
  sessionModel?: {
    provider: string;
    model: string;
    thinkingLevel: string;
  };
  wikiPromptEnabled: boolean;
  /** Must never be copied into span attributes. */
  apiKey?: string;
};

const FORBIDDEN_ATTR_KEYS = [
  "apiKey",
  "api_key",
  "authorization",
  "wikilot.llm.apiKey",
  "wikilot.llm.api_key",
] as const;

/** Stable telemetry correlation id that does not expose path-derived Workspace ids. */
export function privacySafeWorkspaceId(workspaceId: string): string {
  return createHash("sha256").update(workspaceId).digest("hex").slice(0, 32);
}

/** Build session.prompt span attributes — never includes credential material. */
export function buildTurnSpanAttributes(
  input: TurnSpanInput,
): Record<string, string> {
  const attributes: Record<string, string> = {
    "wikilot.gesture": "session.prompt",
    "wikilot.session.id": input.sessionId,
    ...(input.workspaceId ? { "wikilot.workspace.id": privacySafeWorkspaceId(input.workspaceId) } : {}),
    "wikilot.llm.provider": input.provider,
    "wikilot.llm.model": input.model,
    "wikilot.llm.thinking": input.thinkingLevel,
    "wikilot.wiki.enabled": input.wikiPromptEnabled ? "true" : "false",
    "wikilot.context_clip.count": String(input.clipCount ?? 0),
    "wikilot.context_clip.characters": String(input.clipCharacters ?? 0),
  };
  if (input.wikiPromptFragment !== undefined) {
    attributes["wikilot.wiki.prompt"] = input.wikiPromptFragment;
  }
  if (input.systemPrompt !== undefined) {
    attributes["wikilot.llm.system_prompt"] = input.systemPrompt;
  }
  return attributes;
}

/** Build credential.save span attributes — never includes credential material. */
export function buildCredentialSaveSpanAttributes(
  input: CredentialSaveSpanInput,
): Record<string, string> {
  return {
    "wikilot.gesture": "credential.save",
    "wikilot.llm.provider": input.providerId,
  };
}

/** Build defaults.save span attributes — never includes credential material. */
export function buildDefaultsSaveSpanAttributes(
  input: DefaultsSaveSpanInput,
): Record<string, string> {
  return {
    "wikilot.gesture": "defaults.save",
    ...(input.sessionModel
      ? {
          "wikilot.llm.provider": input.sessionModel.provider,
          "wikilot.llm.model": input.sessionModel.model,
          "wikilot.llm.thinking": input.sessionModel.thinkingLevel,
        }
      : {}),
    "wikilot.wiki.enabled": input.wikiPromptEnabled ? "true" : "false",
  };
}

/** Build tool span attributes — never includes credential material. */
export function buildToolSpanAttributes(
  input: ToolSpanInput,
): SpanAttributes {
  return {
    "wikilot.gesture": "session.tool",
    "wikilot.session.id": input.sessionId,
    "wikilot.tool.name": input.toolName,
    "wikilot.tool.call_id": input.toolCallId,
    ...(input.toolName === "read_pdf_page" && input.timeoutSeconds !== undefined
      ? { "wikilot.tool.timeout_seconds": input.timeoutSeconds }
      : {}),
  };
}

/** Build the closed set of lifecycle facts accepted from a typed Tool result/error. */
export function buildToolCompletionSpanAttributes(
  input: { outcome: ToolOutcome } | ReadPdfPageToolCompletionSpanInput,
): SpanAttributes {
  if (!("timeoutSeconds" in input)) {
    return { "wikilot.tool.outcome": input.outcome };
  }
  if (input.outcome !== "success") {
    return {
      "wikilot.tool.outcome": input.outcome,
      "wikilot.tool.timeout_seconds": input.timeoutSeconds,
      "wikilot.tool.error_code": input.errorCode,
    };
  }
  return {
    "wikilot.tool.outcome": input.outcome,
    "wikilot.tool.timeout_seconds": input.timeoutSeconds,
    "wikilot.tool.image_count": input.imageCount,
    "wikilot.tool.image_mime_type": input.imageMimeType,
    ...(input.imageWidth !== undefined ? { "wikilot.tool.image_width": input.imageWidth } : {}),
    ...(input.imageHeight !== undefined ? { "wikilot.tool.image_height": input.imageHeight } : {}),
  };
}

/** True when attributes contain no credential-shaped keys or values. */
export function attributesLeakSecret(
  attributes: SpanAttributes,
  apiKey: string,
): boolean {
  const key = apiKey.trim();
  for (const [attrKey, value] of Object.entries(attributes)) {
    if (
      FORBIDDEN_ATTR_KEYS.some(
        (forbidden) => forbidden.toLowerCase() === attrKey.toLowerCase(),
      )
    ) {
      return true;
    }
    if (key && String(value).includes(key)) {
      return true;
    }
  }
  return false;
}
