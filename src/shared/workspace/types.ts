import type { ThinkingLevel } from "../settings";
import type {
  SessionRuntimeStatus,
  TimelineDeltaEvent,
  TimelineItem,
} from "../timeline";

/**
 * Opaque Workspace identity (crosses browser ↔ Node host).
 * Clients must not parse or construct the id; only the host resolves it.
 */
export type WorkspaceSummary = {
  id: string;
  /** Canonical absolute path of the Workspace working root. */
  cwd: string;
};

export type WorkspaceOpenRequest = {
  cwd: string;
};

export type WorkspaceOpenErrorBody = {
  error: string;
};

/**
 * Result of the Host's native directory chooser (crosses browser ↔ Node
 * host). `cwd` is the selected absolute path, or null when the user (or the
 * caller) cancelled. The path still goes through Workspace-open validation.
 */
export type WorkspaceDirectoryPickResponse = {
  cwd: string | null;
};

/**
 * One durable Known Workspace (crosses browser ↔ Node host). Ordered by
 * recent successful use; validated lazily when selected, never on list.
 */
export type KnownWorkspace = {
  /** Opaque Workspace identity derived from the canonical cwd. */
  id: string;
  /** Canonical absolute path of the Workspace working root. */
  cwd: string;
  /** ISO time of the most recent successful open. */
  lastOpenedAt: string;
  /** The Workspace's remembered Selected Session, if any. */
  selectedSessionId?: string;
  /** True while any of its Sessions has an active Turn (removal guard). */
  hasActiveTurn: boolean;
};

export type KnownWorkspaceListResponse = {
  workspaces: KnownWorkspace[];
  /** Launch-restoration hint: last successfully selected Workspace path. */
  launchCwd: string | null;
  /** One-time warning after malformed persistence was backed up and reset. */
  warning?: string;
};

export type WorkspaceRemoveRequest = {
  workspaceId: string;
};

/** One Session in a Workspace Session list (crosses browser ↔ Node host). */
export type SessionListItem = {
  id: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  /** Ephemeral Worker state merged into the durable Session summary. */
  runtimeStatus: SessionRuntimeStatus;
};

/** Result of creating or opening a Session inside a Workspace. */
export type SessionSwitchResult = {
  workspaceId: string;
  sessionId: string;
  action: "create" | "open";
  timelineItems: TimelineItem[];
};

/** Secret-free Pi Skill metadata available to a selected Session. */
export type SessionSkill = {
  name: string;
  description: string;
};

export type SessionSkillsResponse = {
  skills: SessionSkill[];
};

/**
 * Renderer-owned monotonic lease for pairing selection Prepare and Release.
 * One client owns a Session's selection lease at a time.
 */
export type SessionSelectionToken = {
  clientId: string;
  sequence: number;
};

/** Renderer-owned selection lease used to pair Prepare with Release. */
export type SessionSelectionRequest = {
  workspaceId: string;
  sessionId: string;
  selectionToken: SessionSelectionToken;
};

/** Effective configuration persisted by one Session. */
export type SessionConfiguration = {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  wikiPromptEnabled?: boolean;
};

export type SessionConfigurationUpdate = Partial<SessionConfiguration>;

export type SessionConfigurationUpdateResult = {
  status: "applied" | "pending";
  configuration: SessionConfiguration;
};

export type SessionConfigurationRequest = {
  workspaceId: string;
  sessionId: string;
};

export type SessionConfigurationUpdateRequest = SessionConfigurationRequest & {
  configuration: SessionConfigurationUpdate;
};

export type SessionCreateRequest = {
  workspaceId: string;
  configuration?: SessionConfigurationUpdate;
};

export type SessionOpenRequest = {
  workspaceId: string;
  sessionId: string;
};

export type SessionDeleteRequest = {
  workspaceId: string;
  sessionId: string;
};

export type SessionAbortRequest = {
  workspaceId: string;
  sessionId: string;
};

/** Pending project trust request surfaced before a first Turn starts. */
export type ProjectTrustRequest = {
  workspaceId: string;
  sessionId: string;
  cwd: string;
};

export type ProjectTrustResolutionRequest = ProjectTrustRequest & {
  trusted: boolean;
};

export type SessionListResponse = {
  sessions: SessionListItem[];
};

/** One entry in a Workspace File Tree listing (crosses browser ↔ Node host). */
export type WorkspaceFileEntry = {
  name: string;
  /** Workspace-relative path using `/` separators. */
  path: string;
  kind: "file" | "directory";
};

export type WorkspaceFileListRequest = {
  workspaceId: string;
  /** Workspace-relative directory path ("" = root). */
  path: string;
};

export type WorkspaceFileListResponse = {
  entries: WorkspaceFileEntry[];
};

export type WorkspacePathRequest = {
  workspaceId: string;
  path: string;
};

export type MarkdownDocumentSnapshot =
  | {
      path: string;
      status: "ready";
      version: string;
      size: number;
      content: string;
    }
  | {
      path: string;
      status: "too-large" | "non-utf8";
      version: string;
      size: number;
    }
  | {
      path: string;
      status: "waiting" | "deleted" | "unavailable";
      version: null;
      size: number | null;
    };

export type MarkdownDocumentSaveRequest = {
  version: string;
  /** Complete document content. Saves never accept patches or truncation. */
  content: string;
};

export type MarkdownDocumentSaveResult =
  | {
      outcome: "saved";
      snapshot: Extract<MarkdownDocumentSnapshot, { status: "ready" }>;
    }
  | {
      outcome: "conflict";
      snapshot: MarkdownDocumentSnapshot;
    };

export type WorkspacePdfSource = {
  /** Opaque capability; it contains neither an absolute nor relative path. */
  sourceId: string;
  version: string;
  size: number;
  mediaType: "application/pdf";
};

export const WORKSPACE_PDF_ERROR_CODES = [
  "too-large",
  "source-changed",
  "deleted",
  "unavailable",
] as const;
export type WorkspacePdfErrorCode = (typeof WORKSPACE_PDF_ERROR_CODES)[number];

export function isWorkspacePdfErrorCode(value: unknown): value is WorkspacePdfErrorCode {
  return typeof value === "string" &&
    (WORKSPACE_PDF_ERROR_CODES as readonly string[]).includes(value);
}

export type WorkspacePdfRange = WorkspacePdfSource & {
  start: number;
  end: number;
  bytes: Uint8Array;
};

/**
 * Workspace filesystem change notification (Host → Renderer over the event
 * stream). Paths are Workspace-relative with `/` separators, debounced.
 */
export type WorkspaceFilesChangedEvent = {
  type: "workspace_files_changed";
  workspaceId: string;
  paths: string[];
};

export type WorkspaceLinkIndexChangedEvent = {
  type: "workspace_link_index_changed";
  workspaceId: string;
  revision: number;
};

export type WorkspaceEvent = WorkspaceFilesChangedEvent | WorkspaceLinkIndexChangedEvent;

/** Everything the Host event stream can deliver. */
export type ApplicationEvent = TimelineDeltaEvent | WorkspaceEvent;

export function isWorkspaceFilesChangedEvent(
  event: ApplicationEvent,
): event is WorkspaceFilesChangedEvent {
  return (
    (event as WorkspaceFilesChangedEvent).type === "workspace_files_changed"
  );
}

export function isWorkspaceLinkIndexChangedEvent(
  event: ApplicationEvent,
): event is WorkspaceLinkIndexChangedEvent {
  return (event as WorkspaceLinkIndexChangedEvent).type === "workspace_link_index_changed";
}
