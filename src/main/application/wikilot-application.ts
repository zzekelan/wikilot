import {
  normalizeStructuredPrompt,
  type StructuredPrompt,
} from "../../shared/session";
import {
  type AppDefaults,
  type AppDefaultsUpdate,
  type ReviewSettings,
  type AuthenticationCancelRequest,
  type AuthenticationRespondRequest,
  type AuthenticationStartRequest,
  type AuthenticationStartResponse,
  type AuthenticationSessionEvent,
  type ModelCatalogProvider,
  type ProviderCredential,
  type ProviderInput,
  type ProviderSummary,
  type SetCredentialRequest,
} from "../../shared/settings";
import type { TimelineSnapshot } from "../../shared/timeline";
import { isWorkspaceFilesChangedEvent } from "../../shared/workspace";
import type {
  SessionConfigurationUpdate,
  SessionConfigurationUpdateResult,
  SessionListItem,
  SessionSelectionToken,
  SessionSkill,
  SessionSwitchResult,
  ApplicationEvent,
  KnownWorkspaceListResponse,
  MarkdownDocumentSaveRequest,
  MarkdownDocumentSaveResult,
  MarkdownDocumentSnapshot,
  WorkspaceFileListResponse,
  WorkspaceGraphSnapshot,
  WorkspaceLinkIndexSnapshot,
  WorkspaceLinkResolution,
  WorkspaceLinkResolveRequest,
  WorkspacePdfRange,
  WorkspacePdfSource,
  WorkspaceOpenRequest,
  WorkspacePaneRestoreResult,
  WorkspacePaneState,
  WorkspaceSummary,
  ProjectTrustRequest,
} from "../../shared/workspace";
import {
  createAppDefaultsStore,
  createModelServices,
  defaultAgentDir,
  readTrustedProjectModelDefaults,
} from "../models";
import { createSessionModule, type SessionImageResult, type SessionModule } from "../session";
import { createReviewSettingsStore } from "../automatic-review";
import {
  recordAppDefaultsSave,
  recordCredentialSave,
  recordProjectTrust,
  recordWorkspaceGraphSnapshot,
  recordWorkspaceFilesChanged,
  recordWorkspaceOpen,
} from "../telemetry";
import {
  createProjectTrustService,
  createWorkspaceModule,
  type ProjectTrustService,
} from "../workspace";

/**
 * Transport-neutral application boundary. Hosts (Browser HTTP/SSE today,
 * Electron IPC later) depend only on this facade plus the shared contracts —
 * never on Workspace, Session Runtime, or Pi implementation objects.
 */
export type WikilotApplication = {
  /**
   * Validate and register a Workspace, returning its opaque identity.
   * Opening always starts with no Session selected: it never creates,
   * continues, or selects a Session. Existing Session execution remains
   * independent because selection belongs to the Renderer.
   */
  openWorkspace(command: WorkspaceOpenRequest): WorkspaceSummary;
  /**
   * Durable Known Workspaces (recent successful use first) plus the
   * launch-restoration hint. Listing never validates availability; entries
   * are revalidated lazily when selected.
   */
  listKnownWorkspaces(): Promise<KnownWorkspaceListResponse>;
  /**
   * Forget a Known Workspace without deleting its directory, Sessions,
   * Credentials, or trust decision. Rejected while any of its Sessions has
   * an active Turn. Opening the path again makes it known again.
   */
  removeKnownWorkspace(workspaceId: string): Promise<void>;
  listSessions(workspaceId: string): Promise<SessionListItem[]>;
  /** Prepare the selected Session Runtime and return secret-free Skills. */
  prepareSession(
    workspaceId: string,
    sessionId: string,
    selectionToken: SessionSelectionToken,
  ): Promise<SessionSkill[]>;
  /** Release an idle unselected Runtime without interrupting a running Turn. */
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
  listWorkspaceFiles(
    workspaceId: string,
    path: string,
  ): WorkspaceFileListResponse;
  openWorkspacePdf(
    workspaceId: string,
    path: string,
  ): WorkspacePdfSource;
  openMarkdownDocument(workspaceId: string, path: string): MarkdownDocumentSnapshot;
  saveMarkdownDocument(
    workspaceId: string,
    path: string,
    request: MarkdownDocumentSaveRequest,
  ): Promise<MarkdownDocumentSaveResult>;
  getWorkspaceLinkIndex(workspaceId: string): WorkspaceLinkIndexSnapshot;
  getWorkspaceGraph(workspaceId: string): WorkspaceGraphSnapshot;
  retryWorkspaceGraph(workspaceId: string): void;
  resolveWorkspaceLink(
    workspaceId: string,
    request: WorkspaceLinkResolveRequest,
  ): WorkspaceLinkResolution;
  createWorkspaceMarkdown(workspaceId: string, path: string): MarkdownDocumentSnapshot;
  getWorkspacePdfSource(sourceId: string): WorkspacePdfSource;
  /** Revoke a Browser PDF capability. Unknown ids are already released. */
  releaseWorkspacePdfSource(sourceId: string): void;
  readWorkspacePdfRange(
    sourceId: string,
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<WorkspacePdfRange>;
  /** Restore the Workspace's Pane navigation snapshot (validated item by item). */
  loadWorkspacePaneState(workspaceId: string): WorkspacePaneRestoreResult;
  /** Persist the Workspace's Pane navigation snapshot (atomic replace). */
  saveWorkspacePaneState(workspaceId: string, state: WorkspacePaneState): void;
  listProviders(): Promise<ProviderSummary[]>;
  createProvider(input: ProviderInput): Promise<ProviderSummary>;
  updateProvider(
    providerId: string,
    input: ProviderInput,
  ): Promise<ProviderSummary>;
  deleteProvider(providerId: string): Promise<void>;
  /** Base Model Catalog (serializable; ModelRuntime never crosses over). */
  getModelCatalog(): Promise<ModelCatalogProvider[]>;
  /** Credential metadata only — plaintext never leaves Pi's CredentialStore. */
  listCredentials(): Promise<ProviderCredential[]>;
  setCredential(command: SetCredentialRequest): Promise<ProviderCredential>;
  deleteCredential(providerId: string): Promise<void>;
  startAuthentication?(request: AuthenticationStartRequest): Promise<AuthenticationStartResponse>;
  respondAuthentication?(request: AuthenticationRespondRequest): Promise<void>;
  cancelAuthentication?(request: AuthenticationCancelRequest): Promise<void>;
  /** App Defaults for new Sessions, independent of existing Sessions. */
  getAppDefaults(): AppDefaults;
  updateAppDefaults(patch: AppDefaultsUpdate): AppDefaults;
  getReviewSettings(): ReviewSettings;
  updateReviewSettings(settings: ReviewSettings): ReviewSettings;
  prompt(prompt: StructuredPrompt): Promise<void>;
  abort(workspaceId: string, sessionId: string): Promise<void>;
  getSessionConfiguration(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionConfigurationUpdateResult>;
  updateSessionConfiguration(
    workspaceId: string,
    sessionId: string,
    patch: SessionConfigurationUpdate,
  ): Promise<SessionConfigurationUpdateResult>;
  reloadSessionResources(workspaceId: string, sessionId: string): Promise<SessionSkill[]>;
  getTimelineSnapshot(workspaceId: string, sessionId: string): TimelineSnapshot;
  getSessionImage(
    workspaceId: string,
    sessionId: string,
    imageRef: string,
  ): Promise<SessionImageResult>;
  /** Subscribe to Application events: sequenced Session Deltas plus Workspace
      filesystem change notifications. */
  subscribeEvents(listener: (event: ApplicationEvent) => void): () => void;
  subscribeAuthentication?(listener: (event: AuthenticationSessionEvent) => void): () => void;
  getProjectTrustRequest(
    workspaceId: string,
    sessionId: string,
  ): ProjectTrustRequest | null;
  resolveProjectTrust(
    request: ProjectTrustRequest & { trusted: boolean },
  ): Promise<SessionSkill[]>;
  /** Host termination boundary. Renderer transport disconnects do not call this. */
  shutdown(): Promise<void>;
};

export type WikilotApplicationOptions = {
  /** Override App sessions root (tests; default `~/.wikilot/sessions`). */
  sessionsRoot?: string;
  /** Override App Agent data root (tests; default `~/.wikilot/agent`). */
  agentDir?: string;
  /** Project trust adapter (tests; default persists under agentDir). */
  projectTrust?: ProjectTrustService;
};

/** Compose Workspace, Session, and Model modules behind the facade. */
export function createWikilotApplication(
  options: WikilotApplicationOptions = {},
): WikilotApplication {
  const agentDir = options.agentDir ?? defaultAgentDir();
  const projectTrust = options.projectTrust ?? createProjectTrustService(agentDir);
  const modelServices = createModelServices({ agentDir: options.agentDir });
  const defaultsStore = createAppDefaultsStore({ agentDir: options.agentDir });
  const reviewSettings = createReviewSettingsStore(agentDir);
  const pendingProjectTrust = new Map<string, ProjectTrustRequest>();
  let sessions: SessionModule;
  const workspace = createWorkspaceModule({
    agentDir,
    hasActiveTurn: (workspaceId) => sessions.hasActiveTurn(workspaceId),
  });

  function sessionKey(workspaceId: string, sessionId: string): string {
    return `${workspaceId}/${sessionId}`;
  }

  sessions = createSessionModule({
    resolveWorkspace: (workspaceId) => workspace.resolve(workspaceId),
    sessionsRoot: options.sessionsRoot,
    agentDir,
    modelServices,
    getAppDefaults: () => defaultsStore.read(),
    setSessionModelDefault: (sessionModel) =>
      defaultsStore.update({ sessionModel }),
    getProjectDefaults: (cwd) =>
      projectTrust.evaluate(cwd).projectTrusted
        ? readTrustedProjectModelDefaults(cwd, agentDir)
        : {},
    getProjectTrust: (cwd) => projectTrust.evaluate(cwd).projectTrusted,
    beforePrompt(session) {
      const trust = projectTrust.evaluate(session.cwd);
      if (!trust.requiresDecision || trust.decision !== "undecided") return;
      const request = { ...session };
      pendingProjectTrust.set(
        sessionKey(session.workspaceId, session.sessionId),
        request,
      );
      recordProjectTrust({ phase: "request", ...request });
      throw new Error(`Project trust decision required for ${session.cwd}`);
    },
  });

  // Application event fan-out combines the deep Session and Workspace modules.
  const eventListeners = new Set<(event: ApplicationEvent) => void>();
  const authenticationListeners = new Set<(event: AuthenticationSessionEvent) => void>();
  function emitEvent(event: ApplicationEvent): void {
    if (isWorkspaceFilesChangedEvent(event)) {
      recordWorkspaceFilesChanged({
        workspaceId: event.workspaceId,
        pathCount: event.paths.length,
      });
    }
    for (const listener of eventListeners) listener(event);
  }
  function emitAuthentication(event: AuthenticationSessionEvent): void {
    for (const listener of authenticationListeners) listener(event);
  }
  sessions.subscribe(emitEvent);
  workspace.subscribe(emitEvent);

  return {
    openWorkspace(command) {
      const summary = workspace.open(command.cwd);
      recordWorkspaceOpen(summary);
      return summary;
    },

    listKnownWorkspaces() {
      return workspace.listKnown();
    },

    removeKnownWorkspace(workspaceId) {
      return workspace.removeKnown(workspaceId);
    },

    async listSessions(workspaceId) {
      return sessions.list(workspaceId);
    },

    prepareSession(workspaceId, sessionId, selectionToken) {
      return sessions.prepare(workspaceId, sessionId, selectionToken);
    },

    releaseSession(workspaceId, sessionId, selectionToken) {
      return sessions.release(workspaceId, sessionId, selectionToken);
    },

    async createSession(workspaceId, configuration) {
      const result = await sessions.create(workspaceId, configuration);
      workspace.rememberSession(workspaceId, result.sessionId);
      return result;
    },

    async openSession(workspaceId, sessionId) {
      const result = await sessions.open(workspaceId, sessionId);
      workspace.rememberSession(workspaceId, result.sessionId);
      return result;
    },

    async deleteSession(workspaceId, sessionId) {
      await sessions.delete(workspaceId, sessionId);
      pendingProjectTrust.delete(sessionKey(workspaceId, sessionId));
      workspace.forgetSession(workspaceId, sessionId);
    },

    listWorkspaceFiles(workspaceId, path) {
      return workspace.listFiles(workspaceId, path);
    },

    openWorkspacePdf(workspaceId, path) {
      return workspace.openPdf(workspaceId, path);
    },

    readWorkspacePdfRange(sourceId, start, end, signal) {
      return workspace.readPdfRange(sourceId, start, end, signal);
    },

    getWorkspacePdfSource(sourceId) {
      return workspace.getPdfSource(sourceId);
    },

    releaseWorkspacePdfSource(sourceId) {
      workspace.releasePdfSource(sourceId);
    },

    openMarkdownDocument(workspaceId, path) {
      return workspace.openMarkdownDocument(workspaceId, path);
    },

    saveMarkdownDocument(workspaceId, path, request) {
      return workspace.saveMarkdownDocument(workspaceId, path, request);
    },

    getWorkspaceLinkIndex(workspaceId) {
      return workspace.getLinkIndex(workspaceId);
    },

    getWorkspaceGraph(workspaceId) {
      const startedAt = performance.now();
      const snapshot = workspace.getGraph(workspaceId);
      recordWorkspaceGraphSnapshot({
        workspaceId,
        status: snapshot.status,
        ...(snapshot.status === "ready" ? {
          revision: snapshot.revision,
          nodeCount: snapshot.nodes.length,
          edgeCount: snapshot.edges.length,
        } : {}),
        durationMs: performance.now() - startedAt,
      });
      return snapshot;
    },

    retryWorkspaceGraph(workspaceId) {
      workspace.retryGraph(workspaceId);
    },

    resolveWorkspaceLink(workspaceId, request) {
      return workspace.resolveLink(workspaceId, request);
    },

    createWorkspaceMarkdown(workspaceId, path) {
      return workspace.createMarkdown(workspaceId, path);
    },

    loadWorkspacePaneState(workspaceId) {
      return workspace.loadPaneState(workspaceId);
    },

    saveWorkspacePaneState(workspaceId, state) {
      workspace.savePaneState(workspaceId, state);
    },

    listProviders() {
      return modelServices.listProviders();
    },

    createProvider(input) {
      return modelServices.createProvider(input);
    },

    updateProvider(providerId, input) {
      return modelServices.updateProvider(providerId, input);
    },

    deleteProvider(providerId) {
      return modelServices.deleteProvider(providerId);
    },

    getModelCatalog() {
      return modelServices.listBaseCatalog();
    },

    listCredentials() {
      return modelServices.listCredentials();
    },

    async setCredential(command) {
      const saved = await modelServices.setApiKeyCredential(
        command.providerId,
        command.apiKey,
      );
      recordCredentialSave({ providerId: saved.providerId });
      return saved;
    },

    deleteCredential(providerId) {
      return modelServices.deleteCredential(providerId);
    },

    async startAuthentication(request) {
      const authentication = await modelServices.getAuthentication();
      const result = await authentication.start(request);
      const unsubscribe = authentication.subscribe(result.sessionId, (event) => {
        switch (event.type) {
          case "prompt":
            emitAuthentication({ type: "authentication_prompt", sessionId: result.sessionId, promptId: event.promptId, prompt: event.prompt });
            break;
          case "event":
            emitAuthentication({ type: "authentication_event", sessionId: result.sessionId, event: event.event });
            break;
          case "completed":
            emitAuthentication({ type: "authentication_completed", sessionId: result.sessionId, credential: event.credential });
            unsubscribe();
            break;
          case "failed":
            emitAuthentication({ type: "authentication_failed", sessionId: result.sessionId, message: event.message });
            unsubscribe();
            break;
          case "cancelled":
            emitAuthentication({ type: "authentication_cancelled", sessionId: result.sessionId });
            unsubscribe();
            break;
        }
      });
      return result;
    },

    async respondAuthentication(request) {
      const authentication = await modelServices.getAuthentication();
      return authentication.respond(request.sessionId, request.promptId, request.value);
    },

    async cancelAuthentication(request) {
      const authentication = await modelServices.getAuthentication();
      return authentication.cancel(request.sessionId);
    },

    getReviewSettings: reviewSettings.read,
    updateReviewSettings: reviewSettings.update,

    getAppDefaults() {
      return defaultsStore.read();
    },

    updateAppDefaults(patch) {
      const next = defaultsStore.update(patch);
      recordAppDefaultsSave(next);
      return next;
    },

    async prompt(prompt) {
      return sessions.prompt(normalizeStructuredPrompt(prompt));
    },

    abort(workspaceId, sessionId) {
      return sessions.abort(workspaceId, sessionId);
    },

    async getSessionConfiguration(workspaceId, sessionId) {
      return sessions.getConfiguration(workspaceId, sessionId);
    },

    updateSessionConfiguration(workspaceId, sessionId, patch) {
      return sessions.updateConfiguration(workspaceId, sessionId, patch);
    },

    reloadSessionResources(workspaceId, sessionId) {
      return sessions.reloadResources(workspaceId, sessionId);
    },

    getTimelineSnapshot(workspaceId, sessionId) {
      return sessions.getTimelineSnapshot(workspaceId, sessionId);
    },

    getSessionImage(workspaceId, sessionId, imageRef) {
      return sessions.getImage(workspaceId, sessionId, imageRef);
    },

    subscribeEvents(listener) {
      eventListeners.add(listener);
      return () => {
        eventListeners.delete(listener);
      };
    },

    subscribeAuthentication(listener) {
      authenticationListeners.add(listener);
      return () => authenticationListeners.delete(listener);
    },

    getProjectTrustRequest(workspaceId, sessionId) {
      return pendingProjectTrust.get(sessionKey(workspaceId, sessionId)) ?? null;
    },

    async resolveProjectTrust(request) {
      const key = sessionKey(request.workspaceId, request.sessionId);
      const pending = pendingProjectTrust.get(key);
      if (
        !pending ||
        pending.workspaceId !== request.workspaceId ||
        pending.sessionId !== request.sessionId ||
        pending.cwd !== request.cwd
      ) {
        throw new Error("Project trust request is no longer active");
      }
      projectTrust.set(request.cwd, request.trusted);
      recordProjectTrust({ phase: "decision", ...request });
      pendingProjectTrust.delete(key);
      // A selected Session may already have been prepared safely with project
      // resources excluded. Reload it after the decision so Extension-bound
      // Skills and lifecycle hooks are present for the retried first Turn.
      return sessions.reloadResources(request.workspaceId, request.sessionId);
    },

    async shutdown() {
      await workspace.shutdown();
      await sessions.shutdown();
    },
  };
}
