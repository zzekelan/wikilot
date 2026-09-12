import { writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import {
  SessionManager,
  buildSessionContext,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_CLIP_ENTRY_TYPE,
  readContextClipSidecar,
  type ContextClipSidecar,
} from "../../shared/session";
import {
  reduceTimelineDelta,
  type TimelineDelta,
  type TimelineItem,
} from "../../shared/timeline";
import { projectTimelineToolResult, timelineImageReference } from "../timeline/index.ts";
import type {
  SessionListItem,
  SessionSwitchResult,
  WorkspaceSummary,
} from "../../shared/workspace";
import {
  appendSessionConfig,
  type SessionConfig,
} from "./session-config";
import { sessionIdentityKey } from "./session-identity";

/** Main-internal persistence handle resolved from opaque Session identity. */
export type SessionHandle = {
  workspaceId: string;
  cwd: string;
  sessionDir: string;
  sessionId: string;
  sessionFile: string | undefined;
  sessionManager: SessionManager;
};

/** Session switch outcome: shared DTO plus host-internal persistence details. */
export type SessionSwitchDetails = {
  result: SessionSwitchResult;
  session: SessionHandle;
};

export type SessionRepository = {
  list(workspaceId: string): Promise<PersistentSessionListItem[]>;
  create(
    workspaceId: string,
    configuration?: SessionConfig,
  ): Promise<SessionSwitchDetails>;
  open(workspaceId: string, sessionId: string): Promise<SessionSwitchDetails>;
  require(workspaceId: string, sessionId: string): Promise<SessionHandle>;
  readImage(
    workspaceId: string,
    sessionId: string,
    imageRef: string,
  ): Promise<import("./session-module").SessionImageResult>;
  delete(workspaceId: string, sessionId: string): Promise<void>;
};

/** Durable summary before Application merges per-Session runtime state. */
export type PersistentSessionListItem = Omit<SessionListItem, "runtimeStatus">;

export type SessionRepositoryDeps = {
  resolveWorkspace(workspaceId: string): WorkspaceSummary;
  resolveSessionDir(cwd: string): string;
};

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * Pi only writes a new Session file at the first assistant message. Persist
 * the header plus the initial namespaced configuration entry immediately so an
 * empty Session can be listed and deleted, then re-open through Pi's real load
 * path (which marks the file flushed, so later turns keep appending to it).
 */
function persistNewSession(
  sessionManager: SessionManager,
  config: SessionConfig,
): SessionManager {
  appendSessionConfig(sessionManager, config);
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header) {
    throw new Error("Session creation did not resolve a persistence target");
  }
  const lines = [header, ...sessionManager.getEntries()]
    .map((entry) => JSON.stringify(entry))
    .join("\n");
  writeFileSync(sessionFile, `${lines}\n`, { flag: "wx" });
  return SessionManager.open(
    sessionFile,
    sessionManager.getSessionDir(),
    sessionManager.getCwd(),
  );
}

function messageTimestamp(message: { timestamp?: unknown }): number {
  return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
    ? message.timestamp
    : 0;
}

function promptSidecars(branch: ReturnType<SessionManager["getBranch"]>) {
  const clipSidecars = new Map<string, ContextClipSidecar>();
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== CONTEXT_CLIP_ENTRY_TYPE) continue;
    const sidecar = readContextClipSidecar(entry.data);
    if (sidecar) clipSidecars.set(entry.id, sidecar);
  }
  const sidecarsByUserMessage = new WeakMap<object, ContextClipSidecar>();
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message.role !== "user" || !entry.parentId) continue;
    const sidecar = clipSidecars.get(entry.parentId);
    if (sidecar) sidecarsByUserMessage.set(entry.message, sidecar);
  }
  return sidecarsByUserMessage;
}

/** Rebuild persisted history through the same Delta projector used live. */
export function readSessionTimelineItems(
  sessionManager: SessionManager,
): TimelineItem[] {
  const branch = sessionManager.getBranch();
  const context = buildSessionContext(branch);
  const sidecarsByUserMessage = promptSidecars(branch);
  let items: TimelineItem[] = [];

  function apply(delta: TimelineDelta, at: number): void {
    items = reduceTimelineDelta(items, delta, at);
  }

  for (let messageIndex = 0; messageIndex < context.messages.length; messageIndex += 1) {
    const message = context.messages[messageIndex]!;
    const at = messageTimestamp(message);
    if (message.role === "user") {
      const sidecar = sidecarsByUserMessage.get(message);
      const text = sidecar?.text ?? messageText(message.content).trim();
      if (text || sidecar?.clips.length) {
        apply({
          type: "user_message",
          text,
          ...(sidecar?.command ? { command: sidecar.command } : {}),
          ...(sidecar?.clips.length ? { clips: sidecar.clips } : {}),
        }, at);
      }
      continue;
    }

    if (message.role === "assistant") {
      if (message.stopReason === "error") {
        let superseded = false;
        for (
          let nextIndex = messageIndex + 1;
          nextIndex < context.messages.length;
          nextIndex += 1
        ) {
          const next = context.messages[nextIndex]!;
          if (next.role === "user") break;
          if (next.role === "assistant") {
            superseded = true;
            break;
          }
        }
        if (superseded) continue;
      }
      for (const content of message.content) {
        if (content.type === "text" && content.text) {
          apply({ type: "assistant_text_delta", delta: content.text }, at);
        } else if (
          content.type === "thinking" &&
          !content.redacted &&
          content.thinking
        ) {
          apply(
            { type: "assistant_thinking_delta", delta: content.thinking },
            at,
          );
        } else if (content.type === "toolCall") {
          apply(
            {
              type: "tool_start",
              toolCallId: content.id,
              toolName: content.name,
              args: content.arguments,
            },
            at,
          );
        }
      }
      if (message.stopReason === "error") {
        apply(
          {
            type: "error",
            message: message.errorMessage?.trim()
              ? message.errorMessage
              : "Provider request failed",
          },
          at,
        );
      }
      continue;
    }

    if (message.role === "toolResult") {
      const result = projectTimelineToolResult({
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        result: {
          content: message.content,
          ...(message.details !== undefined ? { details: message.details } : {}),
        },
      });
      apply(
        {
          type: "tool_end",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: message.isError,
          ...(result !== undefined ? { result } : {}),
        },
        at,
      );
    }
  }

  return items;
}

function toListItem(info: SessionInfo, manager: SessionManager): PersistentSessionListItem {
  const branch = manager.getBranch();
  const firstUser = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
  const sidecar = firstUser?.type === "message" ? promptSidecars(branch).get(firstUser.message) : undefined;
  const promptText = sidecar?.text ?? (firstUser?.type === "message" && firstUser.message.role === "user" ? messageText(firstUser.message.content) : "");
  const clipNames = [...new Set(sidecar?.clips.map((clip) => clip.source.path.split("/").at(-1)) ?? [])];
  const title = promptText.trim() || (clipNames.length ? `About ${clipNames.slice(0, 2).join(", ")}${clipNames.length > 2 ? "…" : ""}` : "");
  const characters = Array.from(title.replace(/\s+/gu, " "));
  return {
    id: info.id,
    name: info.name,
    created: info.created.toISOString(),
    modified: info.modified.toISOString(),
    messageCount: info.messageCount,
    firstMessage: characters.length > 100 ? `${characters.slice(0, 99).join("")}…` : characters.join(""),
  };
}

/**
 * Pi JSONL repository for Sessions keyed by opaque identity.
 * Session operations are always explicit; nothing here runs on Workspace open.
 */
export function createSessionRepository(
  deps: SessionRepositoryDeps,
): SessionRepository {
  const handles = new Map<string, SessionHandle>();

  function resolve(workspaceId: string): WorkspaceSummary & { sessionDir: string } {
    const workspace = deps.resolveWorkspace(workspaceId);
    return { ...workspace, sessionDir: deps.resolveSessionDir(workspace.cwd) };
  }

  function opened(
    workspaceId: string,
    cwd: string,
    sessionDir: string,
    sessionManager: SessionManager,
    action: "create" | "open",
    timelineItems: TimelineItem[],
  ): SessionSwitchDetails {
    const session: SessionHandle = {
      workspaceId,
      cwd,
      sessionDir,
      sessionId: sessionManager.getSessionId(),
      sessionFile: sessionManager.getSessionFile(),
      sessionManager,
    };
    handles.set(sessionIdentityKey(workspaceId, session.sessionId), session);
    return {
      result: {
        workspaceId,
        sessionId: session.sessionId,
        action,
        timelineItems,
      },
      session,
    };
  }

  async function load(
    workspaceId: string,
    sessionId: string,
    action: "open",
  ): Promise<SessionSwitchDetails> {
    const workspace = resolve(workspaceId);
    const trimmed = sessionId.trim();
    if (!trimmed) {
      throw new Error("sessionId is required");
    }

    const listed = await SessionManager.list(workspace.cwd, workspace.sessionDir);
    const match = listed.find((item) => item.id === trimmed);
    if (!match) {
      throw new Error(`Session not found: ${trimmed}`);
    }

    const sessionManager = SessionManager.open(
      match.path,
      workspace.sessionDir,
      workspace.cwd,
    );
    return opened(
      workspaceId,
      workspace.cwd,
      workspace.sessionDir,
      sessionManager,
      action,
      readSessionTimelineItems(sessionManager),
    );
  }

  return {
    async list(workspaceId) {
      const workspace = resolve(workspaceId);
      const listed = await SessionManager.list(workspace.cwd, workspace.sessionDir);
      return listed.map((info) => toListItem(info, SessionManager.open(info.path, workspace.sessionDir, workspace.cwd)));
    },

    async create(workspaceId, configuration) {
      const workspace = resolve(workspaceId);
      const sessionManager = persistNewSession(
        SessionManager.create(workspace.cwd, workspace.sessionDir),
        configuration ?? {},
      );
      return opened(
        workspaceId,
        workspace.cwd,
        workspace.sessionDir,
        sessionManager,
        "create",
        [],
      );
    },

    async open(workspaceId, sessionId) {
      return load(workspaceId, sessionId, "open");
    },

    async readImage(workspaceId, sessionId, imageRef) {
      const workspace = resolve(workspaceId);
      const trimmed = sessionId.trim();
      if (!trimmed || !/^timeline-image:v1:[A-Za-z0-9_-]{43}$/.test(imageRef)) {
        return { status: "not-found" };
      }
      const listed = await SessionManager.list(workspace.cwd, workspace.sessionDir);
      const match = listed.find((item) => item.id === trimmed);
      if (!match) return { status: "not-found" };
      const manager = SessionManager.open(match.path, workspace.sessionDir, workspace.cwd);
      for (const entry of manager.getBranch()) {
        if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
        const result = projectTimelineToolResult({
          toolCallId: entry.message.toolCallId,
          toolName: entry.message.toolName,
          result: {
            content: entry.message.content,
            ...(entry.message.details !== undefined ? { details: entry.message.details } : {}),
          },
        });
        const images = result?.images;
        if (!images?.some((image) => image.imageRef === imageRef)) continue;
        let ordinal = 0;
        for (const block of entry.message.content) {
          if (typeof block !== "object" || block === null || (block as { type?: unknown }).type !== "image") continue;
          const image = block as { data?: unknown; mimeType?: unknown };
          const ref = timelineImageReference(entry.message.toolCallId, ordinal);
          ordinal += 1;
          if (ref !== imageRef || typeof image.data !== "string" || typeof image.mimeType !== "string") continue;
          return {
            status: "ready",
            bytes: Uint8Array.from(Buffer.from(image.data, "base64")),
            mimeType: image.mimeType,
          };
        }
      }
      return { status: "not-found" };
    },

    async require(workspaceId, sessionId) {
      const trimmed = sessionId.trim();
      if (!trimmed) throw new Error("sessionId is required");
      const existing = handles.get(sessionIdentityKey(workspaceId, trimmed));
      if (existing) return existing;
      return (await load(workspaceId, trimmed, "open")).session;
    },

    async delete(workspaceId, sessionId) {
      const workspace = resolve(workspaceId);
      const trimmed = sessionId.trim();
      if (!trimmed) {
        throw new Error("sessionId is required");
      }

      // Path resolution goes through SessionManager.list so deletion stays
      // scoped to the named Workspace.
      const listed = await SessionManager.list(workspace.cwd, workspace.sessionDir);
      const match = listed.find((item) => item.id === trimmed);
      if (!match) {
        throw new Error(`Session not found: ${trimmed}`);
      }

      await unlink(match.path);
      handles.delete(sessionIdentityKey(workspaceId, trimmed));
    },
  };
}
