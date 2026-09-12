import type { ContextClip, PromptCommandId } from "../session";

export type TimelineToolResult = {
  text?: string;
  images?: Array<{ imageRef: string; mimeType: string }>;
  metadata?: {
    kind: "pdf_pages";
    path: string;
    pageCount: number;
    pages: Array<{ page: number; width: number; height: number }>;
  };
};

export type ToolPart = {
  kind: "tool";
  toolCallId: string;
  toolName: string;
  status: "running" | "done" | "error";
  args?: unknown;
  progress?: string;
  result?: TimelineToolResult;
  at: number;
  endedAt?: number;
};

export type AssistantPart =
  | { kind: "text"; text: string; at: number }
  | { kind: "reasoning"; text: string; at: number; endedAt?: number }
  | ToolPart;

/** Serializable display model shared by live events and restored snapshots. */
export type TimelineItem =
  | { kind: "user"; text: string; command?: PromptCommandId; clips?: ContextClip[]; at: number }
  | { kind: "assistant"; parts: AssistantPart[]; at: number }
  | { kind: "error"; message: string; at: number };

/** Incremental Timeline changes emitted by the Session Runtime. */
export type TimelineDelta =
  | { type: "context_usage"; context: SessionContextState }
  | { type: "user_message"; text: string; command?: PromptCommandId; clips?: ContextClip[] }
  | { type: "assistant_text_delta"; delta: string }
  | { type: "assistant_thinking_delta"; delta: string }
  | { type: "tool_start"; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: "tool_update";
      toolCallId: string;
      toolName: string;
      progress?: string;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      result?: TimelineToolResult;
    }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "agent_settled" }
  | { type: "error"; message: string }
  | { type: "session_status"; status: SessionRuntimeStatus };

/** Sequenced Application event delivered over the live transport. */
export type TimelineDeltaEvent = {
  workspaceId: string;
  sessionId: string;
  sequence: number;
  at: number;
  delta: TimelineDelta;
};

/** Authoritative recovery state for one active Session. */
export type TimelineSnapshot = {
  context: SessionContextState;
  workspaceId: string;
  sessionId: string;
  sequence: number;
  status: SessionRuntimeStatus;
  items: TimelineItem[];
};

export type SessionContextState =
  | { status: "unavailable" }
  | {
      status: "ready" | "compacting";
      provider: string;
      model: string;
      contextWindow: number;
      usedTokens: number | null;
    };

/**
 * Ephemeral per-Session Worker state. Persistent Session summaries are
 * separate; this replaces the old global busy flag.
 */
export type SessionRuntimeStatus =
  | "unloaded"
  | "starting"
  | "idle"
  | "running"
  | "stopping";
