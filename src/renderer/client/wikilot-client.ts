import type { StructuredPrompt } from "../../shared/session";
import type {
  AppDefaults,
  AppDefaultsUpdate,
  AuthenticationCancelRequest,
  AuthenticationRespondRequest,
  AuthenticationStartRequest,
  AuthenticationStartResponse,
  AuthenticationSessionEvent,
  ModelCatalogProvider,
  ProviderInput,
  ProviderSummary,
  ProviderCredential,
  SetCredentialRequest,
} from "../../shared/settings";
import type { TimelineSnapshot } from "../../shared/timeline";
import type {
  SessionListItem,
  SessionSelectionToken,
  SessionSkill,
  SessionConfigurationUpdate,
  SessionConfigurationUpdateResult,
  SessionSwitchResult,
  ApplicationEvent,
  KnownWorkspaceListResponse,
  MarkdownDocumentSaveResult,
  MarkdownDocumentSnapshot,
  WorkspaceFileEntry,
  WorkspacePdfSource,
  WorkspaceGraphSnapshot,
  WorkspaceLinkIndexSnapshot,
  WorkspaceLinkResolution,
  WorkspaceLinkResolveRequest,
  WorkspacePaneRestoreResult,
  WorkspacePaneState,
  WorkspaceSummary,
  ProjectTrustRequest,
} from "../../shared/workspace";

/**
 * Transport-neutral client port for the Desktop Shell. The Browser adapter
 * implements it with HTTP/SSE; a future Electron host implements it with IPC.
 * Only serializable shared contracts cross this boundary.
 */
export interface WikilotClient {
  openWorkspace(cwd: string): Promise<WorkspaceSummary>;
  /**
   * Optional native directory chooser capability, present only when the Host
   * can show the platform chooser (local Browser Host; a future Electron host
   * implements it with its own native dialog). Resolves the selected absolute
   * path, or null when cancelled — the path still goes through openWorkspace
   * validation. Absent capability = typed absolute path only.
   */
  pickWorkspaceDirectory?(): Promise<string | null>;
  /** Durable Known Workspaces plus the launch-restoration hint. */
  listKnownWorkspaces(): Promise<KnownWorkspaceListResponse>;
  /** Forget a Known Workspace (rejected while a Turn is active). */
  removeKnownWorkspace(workspaceId: string): Promise<void>;
  listSessions(workspaceId: string): Promise<SessionListItem[]>;
  /** Start/retain the selected Session Runtime and return Skill metadata. */
  prepareSession(
    workspaceId: string,
    sessionId: string,
    selectionToken: SessionSelectionToken,
  ): Promise<SessionSkill[]>;
  /** Release an idle Runtime after the Renderer changes selection. */
  releaseSession(
    workspaceId: string,
    sessionId: string,
    selectionToken: SessionSelectionToken,
  ): Promise<void>;
  createSession(
    workspaceId: string,
    configuration?: SessionConfigurationUpdate,
  ): Promise<SessionSwitchResult>;
  openSession(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionSwitchResult>;
  deleteSession(workspaceId: string, sessionId: string): Promise<void>;
  getSessionConfiguration(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionConfigurationUpdateResult>;
  updateSessionConfiguration(
    workspaceId: string,
    sessionId: string,
    configuration: SessionConfigurationUpdate,
  ): Promise<SessionConfigurationUpdateResult>;
  reloadSessionResources(workspaceId: string, sessionId: string): Promise<SessionSkill[]>;
  listWorkspaceFiles(
    workspaceId: string,
    path?: string,
  ): Promise<WorkspaceFileEntry[]>;
  openWorkspacePdf(
    workspaceId: string,
    path: string,
  ): Promise<WorkspacePdfSource>;
  openMarkdownDocument(
    workspaceId: string,
    path: string,
  ): Promise<MarkdownDocumentSnapshot>;
  saveMarkdownDocument(
    workspaceId: string,
    path: string,
    version: string,
    content: string,
  ): Promise<MarkdownDocumentSaveResult>;
  getWorkspaceGraph(workspaceId: string): Promise<WorkspaceGraphSnapshot>;
  retryWorkspaceGraph(workspaceId: string): Promise<void>;
  getWorkspaceLinkIndex(workspaceId: string): Promise<WorkspaceLinkIndexSnapshot>;
  resolveWorkspaceLink(
    workspaceId: string,
    request: WorkspaceLinkResolveRequest,
  ): Promise<WorkspaceLinkResolution>;
  createWorkspaceMarkdown(
    workspaceId: string,
    path: string,
  ): Promise<MarkdownDocumentSnapshot>;
  /** Resolve an opaque Host PDF capability to this transport's source URL. */
  workspacePdfSourceUrl(sourceId: string): string;
  /** Revoke a PDF capability after its Reader requests have been cancelled. */
  releaseWorkspacePdfSource(sourceId: string): Promise<void>;
  /** Restore the Workspace's Pane navigation snapshot for the Desktop Shell. */
  loadWorkspacePaneState(
    workspaceId: string,
  ): Promise<WorkspacePaneRestoreResult>;
  /** Persist the Workspace's Pane navigation snapshot from the Desktop Shell. */
  saveWorkspacePaneState(
    workspaceId: string,
    state: WorkspacePaneState,
  ): Promise<void>;
  listProviders(): Promise<ProviderSummary[]>;
  createProvider(input: ProviderInput): Promise<ProviderSummary>;
  updateProvider(
    providerId: string,
    input: ProviderInput,
  ): Promise<ProviderSummary>;
  deleteProvider(providerId: string): Promise<void>;
  getModelCatalog(): Promise<ModelCatalogProvider[]>;
  /** Credential metadata only — plaintext never reaches the renderer. */
  listCredentials(): Promise<ProviderCredential[]>;
  setCredential(command: SetCredentialRequest): Promise<ProviderCredential>;
  deleteCredential(providerId: string): Promise<void>;
  startAuthentication(request: AuthenticationStartRequest): Promise<AuthenticationStartResponse>;
  respondAuthentication(request: AuthenticationRespondRequest): Promise<void>;
  cancelAuthentication(request: AuthenticationCancelRequest): Promise<void>;
  subscribeAuthentication(
    onEvent: (event: AuthenticationSessionEvent) => void,
    onConnected?: () => void,
  ): () => void;
  /** App Defaults for new Sessions. */
  getAppDefaults(): Promise<AppDefaults>;
  updateAppDefaults(patch: AppDefaultsUpdate): Promise<AppDefaults>;
  prompt(prompt: StructuredPrompt): Promise<void>;
  getProjectTrustRequest(
    workspaceId: string,
    sessionId: string,
  ): Promise<ProjectTrustRequest | null>;
  resolveProjectTrust(
    request: ProjectTrustRequest & { trusted: boolean },
  ): Promise<SessionSkill[]>;
  abort(workspaceId: string, sessionId: string): Promise<void>;
  /** Resolve a guarded Timeline image reference to this transport's resource URL. */
  timelineImageUrl(workspaceId: string, sessionId: string, imageRef: string): string;
  getTimelineSnapshot(
    workspaceId: string,
    sessionId: string,
  ): Promise<TimelineSnapshot>;
  /** Subscribe to Application events (Session Deltas, Workspace file changes)
      and report each initial/reconnected stream. */
  subscribeEvents(
    onEvent: (event: ApplicationEvent) => void,
    onConnected?: () => void,
  ): () => void;
}
