import type {
  AppDefaults,
  AppDefaultsUpdate,
  ReviewSettings,
  AuthenticationCancelRequest,
  AuthenticationRespondRequest,
  AuthenticationStartRequest,
  AuthenticationStartResponse,
  AuthenticationSessionEvent,
  CredentialListResponse,
  ModelCatalogProvider,
  ModelCatalogResponse,
  ProviderInput,
  ProviderListResponse,
  ProviderCredential,
  ProviderSummary,
  SetCredentialRequest,
} from "../../shared/settings";
import type { TimelineSnapshot } from "../../shared/timeline";
import type {
  SessionListResponse,
  SessionConfigurationUpdateResult,
  SessionSwitchResult,
  ApplicationEvent,
  KnownWorkspaceListResponse,
  MarkdownDocumentSaveResult,
  MarkdownDocumentSnapshot,
  WorkspaceDirectoryPickResponse,
  WorkspaceFileListResponse,
  WorkspacePdfSource,
  WorkspaceGraphSnapshot,
  WorkspaceLinkIndexSnapshot,
  WorkspaceLinkResolution,
  WorkspaceLinkResolveRequest,
  WorkspacePaneRestoreResult,
  WorkspaceSummary,
  ProjectTrustRequest,
  SessionSkillsResponse,
} from "../../shared/workspace";
import { toWorkspacePaneSnapshot } from "../../shared/workspace";
import type { WikilotClient } from "./wikilot-client";

class BrowserClientError extends Error {
  code?: string;
}

async function readError(response: Response): Promise<BrowserClientError> {
  try {
    const body = (await response.json()) as { error?: unknown; code?: unknown };
    if (typeof body.error === "string" && body.error.trim()) {
      const error = new BrowserClientError(body.error);
      if (typeof body.code === "string") error.code = body.code;
      return error;
    }
  } catch {
    // fall through
  }
  return new BrowserClientError(`Request failed (${response.status})`);
}

async function fetchJson<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Browser adapter: implements the transport-neutral client with HTTP for
 * commands/queries and SSE for Application events.
 */
export function createBrowserClient(): WikilotClient {
  return {
    openWorkspace(cwd) {
      return postJson<WorkspaceSummary>("/api/workspace/open", { cwd });
    },

    async pickWorkspaceDirectory() {
      const body = await postJson<WorkspaceDirectoryPickResponse>(
        "/api/workspace/pick-directory",
        {},
      );
      return body.cwd;
    },

    listKnownWorkspaces() {
      return fetchJson<KnownWorkspaceListResponse>("/api/workspace/known");
    },

    async removeKnownWorkspace(workspaceId) {
      const response = await fetch("/api/workspace/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!response.ok) {
        throw await readError(response);
      }
    },

    async listSessions(workspaceId) {
      const body = await fetchJson<SessionListResponse>(
        `/api/session/list?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      return body.sessions;
    },

    async prepareSession(workspaceId, sessionId, selectionToken) {
      const body = await postJson<SessionSkillsResponse>(
        "/api/session/prepare",
        { workspaceId, sessionId, selectionToken },
      );
      return body.skills;
    },

    async releaseSession(workspaceId, sessionId, selectionToken) {
      const response = await fetch("/api/session/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, sessionId, selectionToken }),
      });
      if (!response.ok) {
        throw await readError(response);
      }
    },

    createSession(workspaceId, configuration) {
      return postJson<SessionSwitchResult>("/api/session/create", {
        workspaceId,
        ...(configuration !== undefined ? { configuration } : {}),
      });
    },

    openSession(workspaceId, sessionId) {
      return postJson<SessionSwitchResult>("/api/session/open", {
        workspaceId,
        sessionId,
      });
    },

    async deleteSession(workspaceId, sessionId) {
      const response = await fetch("/api/session/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, sessionId }),
      });
      if (!response.ok) {
        throw await readError(response);
      }
    },

    getSessionConfiguration(workspaceId, sessionId) {
      return fetchJson<SessionConfigurationUpdateResult>(
        `/api/session/configuration?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
      );
    },

    updateSessionConfiguration(workspaceId, sessionId, configuration) {
      return postJson<SessionConfigurationUpdateResult>(
        "/api/session/configuration",
        { workspaceId, sessionId, configuration },
      );
    },

    async reloadSessionResources(workspaceId, sessionId) {
      const body = await postJson<{ ok: true; skills: SessionSkillsResponse["skills"] }>(
        "/api/session/reload",
        { workspaceId, sessionId },
      );
      return body.skills;
    },

    async listWorkspaceFiles(workspaceId, path = "") {
      const body = await postJson<WorkspaceFileListResponse>(
        "/api/workspace/files/list",
        { workspaceId, path },
      );
      return body.entries;
    },

    openWorkspacePdf(workspaceId, path) {
      return postJson<WorkspacePdfSource>("/api/workspace/pdf/open", {
        workspaceId,
        path,
      });
    },

    openMarkdownDocument(workspaceId, path) {
      return postJson<MarkdownDocumentSnapshot>("/api/workspace/markdown/open", {
        workspaceId,
        path,
      });
    },

    saveMarkdownDocument(workspaceId, path, version, content) {
      return postJson<MarkdownDocumentSaveResult>("/api/workspace/markdown/save", {
        workspaceId,
        path,
        version,
        content,
      });
    },

    workspacePdfSourceUrl(sourceId) {
      return `/api/workspace/files/pdf?source=${encodeURIComponent(sourceId)}`;
    },

    async releaseWorkspacePdfSource(sourceId) {
      const response = await fetch("/api/workspace/pdf/release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId }),
      });
      if (!response.ok) throw await readError(response);
    },

    getWorkspaceGraph(workspaceId) {
      return postJson<WorkspaceGraphSnapshot>("/api/workspace/graph", {
        workspaceId,
      });
    },

    async retryWorkspaceGraph(workspaceId) {
      const response = await fetch("/api/workspace/graph/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
      if (!response.ok) throw await readError(response);
    },

    getWorkspaceLinkIndex(workspaceId) {
      return postJson<WorkspaceLinkIndexSnapshot>("/api/workspace/links/index", {
        workspaceId,
      });
    },

    resolveWorkspaceLink(workspaceId, request: WorkspaceLinkResolveRequest) {
      return postJson<WorkspaceLinkResolution>("/api/workspace/links/resolve", {
        workspaceId,
        ...request,
      });
    },

    createWorkspaceMarkdown(workspaceId, path) {
      return postJson<MarkdownDocumentSnapshot>("/api/workspace/links/create", {
        workspaceId,
        path,
      });
    },

    loadWorkspacePaneState(workspaceId) {
      return postJson<WorkspacePaneRestoreResult>("/api/workspace/pane/load", {
        workspaceId,
      });
    },

    async saveWorkspacePaneState(workspaceId, state) {
      const response = await fetch("/api/workspace/pane/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, state: toWorkspacePaneSnapshot(state) }),
        // A shell close/reload inside the debounce window still persists.
        keepalive: true,
      });
      if (!response.ok) {
        throw await readError(response);
      }
    },

    async getModelCatalog(): Promise<ModelCatalogProvider[]> {
      const body = await fetchJson<ModelCatalogResponse>("/api/models/catalog");
      return body.providers;
    },

    async listProviders(): Promise<ProviderSummary[]> {
      const body = await fetchJson<ProviderListResponse>("/api/providers/list");
      return body.providers;
    },

    createProvider(input: ProviderInput) {
      return postJson<ProviderSummary>("/api/providers/create", input);
    },

    updateProvider(providerId: string, input: ProviderInput) {
      return postJson<ProviderSummary>("/api/providers/update", {
        ...input,
        providerId,
      });
    },

    async deleteProvider(providerId: string) {
      const response = await fetch("/api/providers/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      if (!response.ok) {
        throw await readError(response);
      }
    },

    async listCredentials(): Promise<ProviderCredential[]> {
      const body = await fetchJson<CredentialListResponse>(
        "/api/credentials/list",
      );
      return body.credentials;
    },

    setCredential(command: SetCredentialRequest) {
      return postJson<ProviderCredential>("/api/credentials/set", command);
    },

    async deleteCredential(providerId: string) {
      const response = await fetch("/api/credentials/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId }),
      });
      if (!response.ok) {
        throw await readError(response);
      }
    },

    startAuthentication(request: AuthenticationStartRequest) {
      return postJson<AuthenticationStartResponse>("/api/authentication/start", request);
    },

    async respondAuthentication(request: AuthenticationRespondRequest) {
      const response = await fetch("/api/authentication/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw await readError(response);
    },

    async cancelAuthentication(request: AuthenticationCancelRequest) {
      const response = await fetch("/api/authentication/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw await readError(response);
    },

    subscribeAuthentication(onEvent, onConnected) {
      const source = new EventSource("/api/authentication/events");
      source.addEventListener("open", () => onConnected?.());
      source.addEventListener("message", (message) => {
        try {
          onEvent(JSON.parse(message.data) as AuthenticationSessionEvent);
        } catch {
          // Ignore malformed authentication frames.
        }
      });
      return () => source.close();
    },

    getAppDefaults() {
      return fetchJson<AppDefaults>("/api/defaults");
    },

    getReviewSettings() {
      return fetchJson<ReviewSettings>("/api/review/settings");
    },

    updateReviewSettings(settings: ReviewSettings) {
      return postJson<ReviewSettings>("/api/review/settings", settings);
    },

    updateAppDefaults(patch: AppDefaultsUpdate) {
      return postJson<AppDefaults>("/api/defaults/update", patch);
    },

    async prompt(prompt) {
      await postJson<{ ok: true }>("/api/session/prompt", prompt);
    },

    getProjectTrustRequest(workspaceId, sessionId) {
      return fetchJson<ProjectTrustRequest | null>(
        `/api/session/trust?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
      );
    },

    resolveProjectTrust(request) {
      return postJson<SessionSkillsResponse>("/api/session/trust", request).then(
        ({ skills }) => skills,
      );
    },

    async abort(workspaceId, sessionId) {
      await postJson<{ ok: true }>("/api/session/abort", {
        workspaceId,
        sessionId,
      });
    },

    timelineImageUrl(workspaceId, sessionId, imageRef) {
      const params = new URLSearchParams({ workspaceId, sessionId, imageRef });
      return `/api/session/image?${params.toString()}`;
    },

    getTimelineSnapshot(workspaceId, sessionId) {
      return fetchJson<TimelineSnapshot>(
        `/api/session/timeline/snapshot?workspaceId=${encodeURIComponent(workspaceId)}&sessionId=${encodeURIComponent(sessionId)}`,
      );
    },


    subscribeEvents(onEvent, onConnected) {
      let source: EventSource | null = null;
      let stopped = false;
      let retry = 0;
      let opening = 0;
      const connect = () => {
        if (stopped) return;
        const candidate = new EventSource("/api/session/events");
        source = candidate;
        const reconnect = () => {
          if (source !== candidate) return;
          candidate.close();
          source = null;
          if (!stopped) retry = window.setTimeout(connect, 500);
        };
        opening = window.setTimeout(() => {
          reconnect();
        }, 3_000);
        candidate.addEventListener("open", () => {
          if (source !== candidate) return;
          clearTimeout(opening);
          onConnected?.();
        });
        candidate.addEventListener("message", (message) => {
          if (source !== candidate) return;
          try {
            onEvent(JSON.parse(message.data) as ApplicationEvent);
          } catch {
            // ignore malformed frames
          }
        });
        candidate.addEventListener("error", () => {
          if (source !== candidate) return;
          clearTimeout(opening);
          reconnect();
        });
      };
      connect();
      return () => {
        stopped = true;
        clearTimeout(opening);
        clearTimeout(retry);
        source?.close();
        source = null;
      };
    },
  };
}
