import type { TimelineDelta } from "../../../shared/timeline";
import {
  projectTimelineToolResult,
  timelinePayloadText,
} from "../../timeline/index.ts";

/**
 * Best-effort JSON-serializable copy of a Runtime payload. Pi tool args/results
 * are `any`; Timeline events cross the SSE seam as JSON, so unserializable
 * values degrade to their String() form instead of breaking the stream.
 */
function toSerializable(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

type SessionEvent = {
  type: string;
  [key: string]: unknown;
};

/** Map a Runtime session event to a Timeline event, or null if ignored. */
export function mapSessionEvent(event: SessionEvent): TimelineDelta | null {
  switch (event.type) {
    case "turn_start":
      return { type: "turn_start" };
    case "turn_end":
      return { type: "turn_end" };
    case "agent_settled":
      return { type: "agent_settled" };
    case "message_update": {
      const nested = event.assistantMessageEvent as
        | { type: string; delta?: string }
        | undefined;
      if (!nested) return null;
      if (nested.type === "text_delta" && typeof nested.delta === "string") {
        return { type: "assistant_text_delta", delta: nested.delta };
      }
      if (
        nested.type === "thinking_delta" &&
        typeof nested.delta === "string"
      ) {
        return { type: "assistant_thinking_delta", delta: nested.delta };
      }
      return null;
    }
    case "agent_end": {
      if (event.willRetry === true || !Array.isArray(event.messages)) {
        return null;
      }
      const assistant = event.messages.findLast((candidate) =>
        typeof candidate === "object" &&
        candidate !== null &&
        (candidate as { role?: unknown }).role === "assistant"
      ) as
        | {
            stopReason?: unknown;
            errorMessage?: unknown;
          }
        | undefined;
      if (assistant?.stopReason === "error") {
        return {
          type: "error",
          message:
            typeof assistant.errorMessage === "string" &&
            assistant.errorMessage.trim()
              ? assistant.errorMessage
              : "Provider request failed",
        };
      }
      return null;
    }
    case "tool_execution_start": {
      const args = toSerializable(event.args);
      return {
        type: "tool_start",
        toolCallId: String(event.toolCallId ?? ""),
        toolName: String(event.toolName ?? ""),
        ...(args !== undefined ? { args } : {}),
      };
    }
    case "tool_execution_update": {
      const progress = timelinePayloadText(event.partialResult);
      return {
        type: "tool_update",
        toolCallId: String(event.toolCallId ?? ""),
        toolName: String(event.toolName ?? ""),
        ...(progress !== undefined ? { progress } : {}),
      };
    }
    case "tool_execution_end": {
      const toolCallId = String(event.toolCallId ?? "");
      const toolName = String(event.toolName ?? "");
      const result = projectTimelineToolResult({
        toolCallId,
        toolName,
        result: event.result,
      });
      return {
        type: "tool_end",
        toolCallId,
        toolName,
        isError: Boolean(event.isError),
        ...(result !== undefined ? { result } : {}),
      };
    }
    default:
      return null;
  }
}

/** Delay candidate agent errors until Pi confirms the full Turn has settled. */
export function createSessionEventMapper(): (
  event: SessionEvent,
) => TimelineDelta[] {
  let pendingError: TimelineDelta | undefined;
  return (event) => {
    if (event.type === "agent_end") {
      const candidate = mapSessionEvent(event);
      pendingError = candidate?.type === "error" ? candidate : undefined;
      return [];
    }

    const mapped = mapSessionEvent(event);
    if (event.type === "agent_settled") {
      const result = [
        ...(pendingError ? [pendingError] : []),
        ...(mapped ? [mapped] : []),
      ];
      pendingError = undefined;
      return result;
    }
    return mapped ? [mapped] : [];
  };
}
