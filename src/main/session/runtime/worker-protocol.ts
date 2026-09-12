import {
  normalizeStructuredPrompt,
  type StructuredPrompt,
} from "../../../shared/session/prompt.ts";
import type { ThinkingLevel } from "../../../shared/settings";
import {
  decodeTimelineToolResult,
  type TimelineDelta,
} from "../../../shared/timeline/index.ts";
import type { SessionSkill } from "../../../shared/workspace";

/**
 * Main ↔ Session Worker protocol. Messages cross Node IPC as JSON; every
 * command carries a requestId answered by exactly one ack/nack, while
 * Timeline events and prompt context stream asynchronously.
 * Types and strict JSON decoders only; this module stays free of Node and Pi
 * so the Worker entry can load it under plain type stripping.
 */

/** Runtime configuration for the Worker's one Session.
 *
 * Provider and Model are optional while resources are being prepared. A
 * missing, deleted, or unauthenticated Model must not prevent the Worker from
 * loading trusted resources and Skills; Prompt execution validates the pair
 * before it reaches this boundary.
 */
export type WorkerSessionConfig = {
  provider?: string;
  model?: string;
  thinkingLevel: ThinkingLevel;
  wikiPromptEnabled: boolean;
};

/** Serializable readiness returned after Worker resource preparation. */
export type WorkerResourceState = {
  skills: SessionSkill[];
  modelReady: boolean;
};

export type WorkerStartParams = {
  sessionId: string;
  cwd: string;
  sessionDir: string;
  sessionFile: string;
  /** Wikilot-owned Agent data root (auth.json / models.json). */
  agentDir: string;
  config: WorkerSessionConfig;
  /** App-owned Wiki fragment text (Main reads the packaged asset). */
  wikiPromptFragment: string;
  /** Main-resolved Project Trust decision; Worker never asks the UI. */
  projectTrusted: boolean;
};

export type WorkerStartCommand = WorkerStartParams & {
  type: "start";
  requestId: number;
};

export type WorkerPromptCommand = {
  type: "prompt";
  requestId: number;
  prompt: StructuredPrompt;
  /** W3C traceparent of the Main-side session.prompt span, when traced. */
  traceparent?: string;
};

export type WorkerConfigureCommand = {
  type: "configure";
  requestId: number;
  config: WorkerSessionConfig;
};

export type WorkerCommand =
  | WorkerStartCommand
  | WorkerPromptCommand
  | WorkerConfigureCommand
  | { type: "abort"; requestId: number }
  | { type: "reload"; requestId: number; projectTrusted: boolean }
  | { type: "shutdown"; requestId: number };

/** Serializable prompt context reported by the Worker for span attributes. */
export type WorkerPromptContext = {
  /** Live assembled AgentSession system prompt. */
  systemPrompt: string;
  /** Whether the App Wiki fragment is present in that assembly. */
  wikiFragmentPresent: boolean;
};

export type WorkerMessage =
  | {
      type: "ack";
      requestId: number;
      /** Present for start/reload acknowledgements. */
      skills?: SessionSkill[];
      /** Present for start/reload acknowledgements. */
      modelReady?: boolean;
    }
  | { type: "nack"; requestId: number; message: string }
  | { type: "event"; event: TimelineDelta }
  | { type: "prompt_context"; context: WorkerPromptContext };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function readTimelineDelta(value: unknown): TimelineDelta | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "context_usage") {
    const context = value.context;
    if (!hasOnlyKeys(value, ["type", "context"]) || !isRecord(context)) return undefined;
    if (context.status === "unavailable") {
      return hasOnlyKeys(context, ["status"])
        ? { type: "context_usage", context: { status: "unavailable" } }
        : undefined;
    }
    if (!hasOnlyKeys(context, ["status", "provider", "model", "contextWindow", "usedTokens"]) ||
        (context.status !== "ready" && context.status !== "compacting") ||
        typeof context.provider !== "string" || !context.provider ||
        typeof context.model !== "string" || !context.model ||
        typeof context.contextWindow !== "number" || !Number.isFinite(context.contextWindow) || context.contextWindow <= 0 ||
        (context.usedTokens !== null && (typeof context.usedTokens !== "number" || !Number.isFinite(context.usedTokens) || context.usedTokens < 0))) return undefined;
    return { type: "context_usage", context: {
      status: context.status, provider: context.provider, model: context.model,
      contextWindow: context.contextWindow, usedTokens: context.usedTokens,
    } };
  }
  if (value.type !== "tool_end") return value as TimelineDelta;
  if (
    !hasOnlyKeys(value, ["type", "toolCallId", "toolName", "isError", "result"]) ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.isError !== "boolean"
  ) {
    return undefined;
  }
  const result = value.result === undefined
    ? undefined
    : decodeTimelineToolResult(value.result, {
        allowPdfPageMetadata: value.toolName === "read_pdf_page",
      });
  if (value.result !== undefined && result === undefined) return undefined;
  return {
    type: "tool_end",
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    isError: value.isError,
    ...(result !== undefined ? { result } : {}),
  };
}

function readSkills(value: unknown): SessionSkill[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const skills: SessionSkill[] = [];
  for (const skill of value) {
    if (
      !isRecord(skill) ||
      typeof skill.name !== "string" ||
      typeof skill.description !== "string"
    ) {
      return undefined;
    }
    skills.push({ name: skill.name, description: skill.description });
  }
  return skills;
}

/** Validate a message received from the Worker over IPC. */
export function decodeWorkerMessage(value: unknown): WorkerMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "ack": {
      if (typeof value.requestId !== "number") return undefined;
      const hasSkills = value.skills !== undefined;
      const skills = hasSkills ? readSkills(value.skills) : undefined;
      if (hasSkills && !skills) return undefined;
      if (
        value.modelReady !== undefined &&
        typeof value.modelReady !== "boolean"
      ) {
        return undefined;
      }
      return {
        type: "ack",
        requestId: value.requestId,
        ...(skills !== undefined ? { skills } : {}),
        ...(value.modelReady !== undefined
          ? { modelReady: value.modelReady }
          : {}),
      };
    }
    case "nack":
      return typeof value.requestId === "number" &&
        typeof value.message === "string"
        ? { type: "nack", requestId: value.requestId, message: value.message }
        : undefined;
    case "event": {
      const event = readTimelineDelta(value.event);
      return event ? { type: "event", event } : undefined;
    }
    case "prompt_context": {
      const context = value.context;
      return isRecord(context) &&
        typeof context.systemPrompt === "string" &&
        typeof context.wikiFragmentPresent === "boolean"
        ? {
            type: "prompt_context",
            context: {
              systemPrompt: context.systemPrompt,
              wikiFragmentPresent: context.wikiFragmentPresent,
            },
          }
        : undefined;
    }
    default:
      return undefined;
  }
}

/** Validate a command received by the Worker over IPC. */
export function decodeWorkerCommand(value: unknown): WorkerCommand | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (typeof value.requestId !== "number") return undefined;
  const requestId = value.requestId;
  switch (value.type) {
    case "start": {
      const config = value.config;
      if (
        typeof value.sessionId !== "string" ||
        typeof value.cwd !== "string" ||
        typeof value.sessionDir !== "string" ||
        typeof value.sessionFile !== "string" ||
        typeof value.agentDir !== "string" ||
        typeof value.wikiPromptFragment !== "string" ||
        typeof value.projectTrusted !== "boolean" ||
        !isRecord(config) ||
        (config.provider !== undefined && typeof config.provider !== "string") ||
        (config.model !== undefined && typeof config.model !== "string") ||
        (config.provider === undefined) !== (config.model === undefined) ||
        typeof config.thinkingLevel !== "string" ||
        typeof config.wikiPromptEnabled !== "boolean"
      ) {
        return undefined;
      }
      return {
        type: "start",
        requestId,
        sessionId: value.sessionId,
        cwd: value.cwd,
        sessionDir: value.sessionDir,
        sessionFile: value.sessionFile,
        agentDir: value.agentDir,
        wikiPromptFragment: value.wikiPromptFragment,
        projectTrusted: value.projectTrusted,
        config: {
          ...(typeof config.provider === "string"
            ? { provider: config.provider }
            : {}),
          ...(typeof config.model === "string" ? { model: config.model } : {}),
          thinkingLevel: config.thinkingLevel as ThinkingLevel,
          wikiPromptEnabled: config.wikiPromptEnabled,
        },
      };
    }
    case "prompt":
      try {
        return {
          type: "prompt",
          requestId,
          prompt: normalizeStructuredPrompt(value.prompt),
          ...(typeof value.traceparent === "string"
            ? { traceparent: value.traceparent }
            : {}),
        };
      } catch {
        return undefined;
      }
    case "configure": {
      const config = value.config;
      return isRecord(config) &&
        typeof config.provider === "string" &&
        typeof config.model === "string" &&
        typeof config.thinkingLevel === "string" &&
        typeof config.wikiPromptEnabled === "boolean"
        ? {
            type: "configure",
            requestId,
            config: {
              provider: config.provider,
              model: config.model,
              thinkingLevel: config.thinkingLevel as ThinkingLevel,
              wikiPromptEnabled: config.wikiPromptEnabled,
            },
          }
        : undefined;
    }
    case "reload":
      return typeof value.projectTrusted === "boolean"
        ? { type: "reload", requestId, projectTrusted: value.projectTrusted }
        : undefined;
    case "abort":
      return { type: "abort", requestId };
    case "shutdown":
      return { type: "shutdown", requestId };
    default:
      return undefined;
  }
}
