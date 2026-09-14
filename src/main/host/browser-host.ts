import { receiveFileUpload } from "./file-upload";
import type { WorkspaceFileChange } from "../../shared/workspace";
import { normalizeStructuredPrompt } from "../../shared/session";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assertKnownFields,
  PROVIDER_INPUT_FIELDS,
  PROVIDER_MODEL_FIELDS,
  THINKING_LEVELS,
  type ApiErrorBody,
  type AppDefaultsUpdate,
  type ProviderInput,
  type ThinkingLevel,
} from "../../shared/settings";
import {
  isWorkspacePdfErrorCode,
  sanitizeWorkspacePaneSnapshot,
  type MarkdownDocumentSaveRequest,
  type SessionCreateRequest,
  type SessionConfigurationRequest,
  type SessionConfigurationUpdateRequest,
  type SessionConfigurationUpdate,
  type SessionDeleteRequest,
  type SessionAbortRequest,
  type SessionOpenRequest,
  type SessionSelectionRequest,
  type WorkspaceDirectoryPickResponse,
  type WorkspaceFileListRequest,
  type WorkspacePathRequest,
  type WorkspaceGraphRequest,
  type WorkspaceLinkIndexRequest,
  type WorkspaceLinkResolveCommand,
  type WorkspaceLinkSubpath,
  type WorkspaceMarkdownCreateRequest,
  type WorkspaceOpenRequest,
  type WorkspacePaneState,
  type WorkspaceRemoveRequest,
  type ProjectTrustResolutionRequest,
  type SessionSelectionToken,
} from "../../shared/workspace";
import type { WikilotApplication } from "../application";
import {
  createMacOsDirectoryPicker,
  createMacOsImportPicker,
  type ImportPicker,
  type DirectoryPicker,
} from "./directory-picker";

export const WORKSPACE_OPEN_PATH = "/api/workspace/open";
export const WORKSPACE_PICK_DIRECTORY_PATH = "/api/workspace/pick-directory";
export const WORKSPACE_KNOWN_PATH = "/api/workspace/known";
export const WORKSPACE_REMOVE_PATH = "/api/workspace/remove";
export const WORKSPACE_FILES_LIST_PATH = "/api/workspace/files/list";
export const WORKSPACE_PDF_OPEN_PATH = "/api/workspace/pdf/open";
export const WORKSPACE_PDF_RELEASE_PATH = "/api/workspace/pdf/release";
export const WORKSPACE_MARKDOWN_OPEN_PATH = "/api/workspace/markdown/open";
export const WORKSPACE_MARKDOWN_SAVE_PATH = "/api/workspace/markdown/save";
export const WORKSPACE_GRAPH_PATH = "/api/workspace/graph";
export const WORKSPACE_GRAPH_RETRY_PATH = "/api/workspace/graph/retry";
export const WORKSPACE_LINK_INDEX_PATH = "/api/workspace/links/index";
export const WORKSPACE_LINK_RESOLVE_PATH = "/api/workspace/links/resolve";
export const WORKSPACE_LINK_CREATE_PATH = "/api/workspace/links/create";
export const WORKSPACE_FILES_PDF_PATH = "/api/workspace/files/pdf";
export const WORKSPACE_PANE_LOAD_PATH = "/api/workspace/pane/load";
export const WORKSPACE_PANE_SAVE_PATH = "/api/workspace/pane/save";
export const SESSION_LIST_PATH = "/api/session/list";
export const SESSION_PREPARE_PATH = "/api/session/prepare";
export const SESSION_RELEASE_PATH = "/api/session/release";
export const SESSION_CREATE_PATH = "/api/session/create";
export const SESSION_OPEN_PATH = "/api/session/open";
export const SESSION_DELETE_PATH = "/api/session/delete";
export const SESSION_CONFIGURATION_PATH = "/api/session/configuration";
export const SESSION_RELOAD_PATH = "/api/session/reload";
export const CREDENTIAL_LIST_PATH = "/api/credentials/list";
export const CREDENTIAL_SET_PATH = "/api/credentials/set";
export const CREDENTIAL_DELETE_PATH = "/api/credentials/delete";
export const AUTHENTICATION_START_PATH = "/api/authentication/start";
export const AUTHENTICATION_RESPOND_PATH = "/api/authentication/respond";
export const AUTHENTICATION_CANCEL_PATH = "/api/authentication/cancel";
export const AUTHENTICATION_EVENTS_PATH = "/api/authentication/events";
export const PROVIDERS_LIST_PATH = "/api/providers/list";
export const PROVIDER_CREATE_PATH = "/api/providers/create";
export const PROVIDER_UPDATE_PATH = "/api/providers/update";
export const PROVIDER_DELETE_PATH = "/api/providers/delete";
export const MODELS_CATALOG_PATH = "/api/models/catalog";
export const DEFAULTS_GET_PATH = "/api/defaults";
export const DEFAULTS_UPDATE_PATH = "/api/defaults/update";
export const SESSION_PROMPT_PATH = "/api/session/prompt";
export const SESSION_ABORT_PATH = "/api/session/abort";
export const SESSION_TRUST_PATH = "/api/session/trust";
export const SESSION_EVENTS_PATH = "/api/session/events";
export const SESSION_TIMELINE_SNAPSHOT_PATH = "/api/session/timeline/snapshot";
export const SESSION_IMAGE_PATH = "/api/session/image";

const QUERYLESS_PROVIDER_PATHS = new Set([
  CREDENTIAL_LIST_PATH,
  CREDENTIAL_SET_PATH,
  CREDENTIAL_DELETE_PATH,
  AUTHENTICATION_START_PATH,
  AUTHENTICATION_RESPOND_PATH,
  AUTHENTICATION_CANCEL_PATH,
  AUTHENTICATION_EVENTS_PATH,
  PROVIDERS_LIST_PATH,
  PROVIDER_CREATE_PATH,
  PROVIDER_UPDATE_PATH,
  PROVIDER_DELETE_PATH,
  MODELS_CATALOG_PATH,
]);

type Next = (error?: unknown) => void;

const SET_CREDENTIAL_FIELDS = ["providerId", "apiKey"] as const;
const PROVIDER_ID_REQUEST_FIELDS = ["providerId"] as const;
const DEFAULTS_UPDATE_FIELDS = ["sessionModel", "wikiPromptEnabled"] as const;
const SESSION_MODEL_DEFAULT_FIELDS = [
  "provider",
  "model",
  "thinkingLevel",
] as const;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  const body: ApiErrorBody = { error: message };
  sendJson(res, status, body);
}

const PDF_ERROR_STATUS: Record<string, number> = {
  "too-large": 413,
  "source-changed": 409,
  deleted: 404,
  unavailable: 404,
};

function pdfErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return isWorkspacePdfErrorCode(code) ? code : undefined;
}

function setPdfHeaders(
  res: ServerResponse,
  source: { version: string; size: number; mediaType: string },
): void {
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", source.mediaType);
  res.setHeader("ETag", `"${source.version}"`);
}

function parsePdfRange(value: string | string[] | undefined, size: number): {
  start: number;
  end: number;
} | null {
  if (typeof value !== "string" || value.includes(",")) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  const end = Math.min(requestedEnd, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
  return { start, end };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new Error("Request body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

/** Preserve Renderer file-path bytes so the Workspace Module can reject them. */
function requireWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("path is required");
  }
  return value;
}

/** Complete document content is byte-significant: preserve whitespace and allow empty files. */
function requireDocumentContent(value: unknown): string {
  if (typeof value !== "string") throw new Error("content is required");
  return value;
}

function readLinkSubpath(value: unknown): WorkspaceLinkSubpath | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("subpath is invalid");
  }
  const subpath = value as { kind?: unknown; value?: unknown };
  if (
    (subpath.kind !== "heading" && subpath.kind !== "pdf-page" && subpath.kind !== "block")
    || typeof subpath.value !== "string"
  ) {
    throw new Error("subpath is invalid");
  }
  return { kind: subpath.kind, value: subpath.value };
}

type WorkspacePaneLoadRequest = {
  workspaceId?: unknown;
};

type WorkspacePaneSaveRequest = WorkspacePaneLoadRequest & {
  state?: WorkspacePaneState;
};

function requireSelectionToken(value: unknown): SessionSelectionToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("selectionToken is required");
  }
  const token = value as Partial<SessionSelectionToken>;
  if (
    typeof token.clientId !== "string" ||
    !token.clientId.trim() ||
    typeof token.sequence !== "number" ||
    !Number.isSafeInteger(token.sequence) ||
    token.sequence < 1
  ) {
    throw new Error("selectionToken is invalid");
  }
  return { clientId: token.clientId.trim(), sequence: token.sequence };
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function readKnownObject(
  value: unknown,
  allowedFields: readonly string[],
  context: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const object = value as Record<string, unknown>;
  assertKnownFields(object, allowedFields, context);
  return object;
}

function readAppDefaultsUpdate(value: unknown): AppDefaultsUpdate {
  const body = readKnownObject(
    value,
    DEFAULTS_UPDATE_FIELDS,
    "App Defaults update",
  );
  const update: AppDefaultsUpdate = {};
  if (body.sessionModel !== undefined) {
    const sessionModel = readKnownObject(
      body.sessionModel,
      SESSION_MODEL_DEFAULT_FIELDS,
      "App Defaults sessionModel",
    );
    if (
      typeof sessionModel.thinkingLevel !== "string" ||
      !THINKING_LEVELS.includes(sessionModel.thinkingLevel as ThinkingLevel)
    ) {
      throw new Error("thinkingLevel must be a supported Thinking level");
    }
    update.sessionModel = {
      provider: requireString(sessionModel.provider, "provider"),
      model: requireString(sessionModel.model, "model"),
      thinkingLevel: sessionModel.thinkingLevel as ThinkingLevel,
    };
  }
  if (body.wikiPromptEnabled !== undefined) {
    if (typeof body.wikiPromptEnabled !== "boolean") {
      throw new Error("wikiPromptEnabled must be boolean");
    }
    update.wikiPromptEnabled = body.wikiPromptEnabled;
  }
  return update;
}

function readProviderInput(value: unknown): ProviderInput {
  const input = readKnownObject(value, PROVIDER_INPUT_FIELDS, "Provider input");
  if (!Array.isArray(input.models)) throw new Error("models is required");
  return {
    providerId: requireString(input.providerId, "providerId"),
    name: requireString(input.name, "name"),
    baseUrl: requireString(input.baseUrl, "baseUrl"),
    protocol: typeof input.protocol === "string" ? input.protocol as ProviderInput["protocol"] : ("" as ProviderInput["protocol"]),
    authMode: typeof input.authMode === "string" ? input.authMode as ProviderInput["authMode"] : ("" as ProviderInput["authMode"]),
    models: input.models.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`models[${index}] must be an object`);
      }
      const model = value as Record<string, unknown>;
      assertKnownFields(model, PROVIDER_MODEL_FIELDS, `models[${index}]`);
      if (!Array.isArray(model.input)) {
        throw new Error(`models[${index}].input is required`);
      }
      if (typeof model.reasoning !== "boolean") {
        throw new Error(`models[${index}].reasoning must be boolean`);
      }
      if (
        model.thinkingLevelMap !== undefined &&
        (typeof model.thinkingLevelMap !== "object" ||
          model.thinkingLevelMap === null ||
          Array.isArray(model.thinkingLevelMap))
      ) {
        throw new Error(`models[${index}].thinkingLevelMap must be an object`);
      }
      if (model.thinkingLevelMap !== undefined) {
        assertKnownFields(
          model.thinkingLevelMap as Record<string, unknown>,
          THINKING_LEVELS,
          `models[${index}].thinkingLevelMap`,
        );
      }
      return {
        id: requireString(model.id, `models[${index}].id`),
        ...(model.name !== undefined ? { name: model.name as string } : {}),
        ...(model.contextWindow !== undefined
          ? { contextWindow: model.contextWindow as number }
          : {}),
        ...(model.maxTokens !== undefined
          ? { maxTokens: model.maxTokens as number }
          : {}),
        reasoning: model.reasoning,
        ...(model.thinkingLevelMap !== undefined
          ? {
              thinkingLevelMap:
                model.thinkingLevelMap as ProviderInput["models"][number]["thinkingLevelMap"],
            }
          : {}),
        input: model.input as ProviderInput["models"][number]["input"],
      };
    }),
  };
}

function readSessionConfiguration(value: unknown): SessionConfigurationUpdate {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null) {
    throw new Error("configuration must be an object");
  }
  const input = value as Record<string, unknown>;
  const provider = input.provider;
  const model = input.model;
  const thinkingLevel = input.thinkingLevel;
  const wikiPromptEnabled = input.wikiPromptEnabled;
  const accessMode = input.accessMode;
  if (accessMode !== undefined && accessMode !== "auto-review" && accessMode !== "full-access") {
    throw new Error("configuration.accessMode must be auto-review or full-access");
  }
  if (provider !== undefined && (typeof provider !== "string" || !provider.trim())) {
    throw new Error("configuration.provider must be a non-empty string");
  }
  if (model !== undefined && (typeof model !== "string" || !model.trim())) {
    throw new Error("configuration.model must be a non-empty string");
  }
  if (
    thinkingLevel !== undefined &&
    (typeof thinkingLevel !== "string" ||
      !THINKING_LEVELS.includes(thinkingLevel as ThinkingLevel))
  ) {
    throw new Error("configuration.thinkingLevel is invalid");
  }
  if (wikiPromptEnabled !== undefined && typeof wikiPromptEnabled !== "boolean") {
    throw new Error("configuration.wikiPromptEnabled must be boolean");
  }
  return {
    ...(typeof provider === "string" ? { provider: provider.trim() } : {}),
    ...(typeof model === "string" ? { model: model.trim() } : {}),
    ...(typeof thinkingLevel === "string"
      ? { thinkingLevel: thinkingLevel as ThinkingLevel }
      : {}),
    ...(typeof wikiPromptEnabled === "boolean" ? { wikiPromptEnabled } : {}),
    ...(accessMode === "auto-review" || accessMode === "full-access" ? { accessMode } : {}),
  };
}

function sendImage(res: ServerResponse, image: { bytes: Uint8Array; mimeType: string }): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", image.mimeType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(Buffer.from(image.bytes));
}

function writeSse(res: ServerResponse, event: unknown): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Only the Browser on the Host's own machine may open privileged Host UI. */
function isLoopbackCaller(req: IncomingMessage): boolean {
  const address = req.socket?.remoteAddress;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

/** Cross-origin pages and non-browser callers must never reach the chooser. */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  // Browsers always send Origin on POST fetch; absence means not a Browser page.
  if (origin === undefined) return false;
  try {
    return new URL(origin).host === (req.headers.host ?? "");
  } catch {
    return false;
  }
}

export type BrowserHostOptions = {
  /** Native directory chooser adapter (tests/acceptance; default: macOS). */
  pickDirectory?: DirectoryPicker;
  pickImport?: ImportPicker;
};

/**
 * Browser Host: translates shared commands, queries, and events between
 * HTTP/SSE and the transport-neutral WikilotApplication facade. Imports no
 * Workspace, Session Runtime, or Pi implementation objects.
 */
export function createBrowserHostMiddleware(
  app: WikilotApplication,
  options: BrowserHostOptions = {},
) {
  const pickDirectory = options.pickDirectory ?? createMacOsDirectoryPicker();
  const pickImport = options.pickImport ?? createMacOsImportPicker();
  return async (req: IncomingMessage, res: ServerResponse, next: Next) => {
    const url = req.url ?? "";
    const path = url.split("?")[0] ?? "";
    const query = new URL(url, "http://localhost").searchParams;

    try {
      if (query.toString() && QUERYLESS_PROVIDER_PATHS.has(path)) {
        throw new Error("This endpoint does not accept query parameters");
      }
      if (req.method === "POST" && path === WORKSPACE_OPEN_PATH) {
        const body = (await readJsonBody(req)) as WorkspaceOpenRequest;
        sendJson(res, 200, app.openWorkspace({ cwd: requireString(body?.cwd, "cwd") }));
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_PICK_DIRECTORY_PATH) {
        // Privileged Host UI: the trust fence runs before any dialog opens.
        if (!isLoopbackCaller(req) || !isSameOrigin(req)) {
          sendError(
            res,
            403,
            "The directory chooser is only available to the local Browser UI",
          );
          return;
        }
        // The chooser is user-paced: no request timeout may terminate it.
        req.setTimeout(0);
        // A client that goes away mid-choice closes the dialog with it.
        const cancellation = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) cancellation.abort();
        });
        const cwd = await pickDirectory({ signal: cancellation.signal });
        // The caller may have disconnected mid-choice; never write then.
        if (!res.writableEnded && !res.destroyed) {
          sendJson(res, 200, { cwd } satisfies WorkspaceDirectoryPickResponse);
        }
        return;
      }

      if (req.method === "POST" && path === "/api/workspace/files/upload") {
        if (!isLoopbackCaller(req) || !isSameOrigin(req)) {
          sendError(res, 403, "Import is only available to the local Browser UI");
          return;
        }
        const cancellation = new AbortController();
        const onClose = () => { if (!res.writableEnded) cancellation.abort(); };
        res.on("close", onClose);
        try {
          const report = await receiveFileUpload(req, cancellation.signal,
            (workspaceId, destination, sources) => app.importWorkspaceFiles(workspaceId, destination, sources, cancellation.signal));
          if (!res.destroyed) sendJson(res, 200, report);
        } finally { res.removeListener("close", onClose); }
        return;
      }

      if (req.method === "POST" && path === "/api/workspace/files/import") {
        if (!isLoopbackCaller(req) || !isSameOrigin(req)) {
          sendError(res, 403, "Import is only available to the local Browser UI");
          return;
        }
        const body = await readJsonBody(req) as Record<string, unknown>;
        if (!body || Object.keys(body).some(key => !["workspaceId", "destination", "kind"].includes(key)) ||
            typeof body.destination !== "string" || (body.kind !== "file" && body.kind !== "directory")) {
          throw new Error("Import requires a destination and system chooser kind; local source paths are not accepted.");
        }
        const workspaceId = requireString(body.workspaceId, "workspaceId");
        req.setTimeout(0);
        const cancellation = new AbortController();
        const onClose = () => { if (!res.writableEnded) cancellation.abort(); };
        res.on("close", onClose);
        try {
          const sources = await pickImport({ kind: body.kind, signal: cancellation.signal });
          if (cancellation.signal.aborted) return;
          const report = sources === null ? null : await app.importWorkspaceFiles(workspaceId, body.destination, sources);
          if (!res.writableEnded && !res.destroyed) sendJson(res, 200, report);
        } finally { res.removeListener("close", onClose); }
        return;
      }

      if (req.method === "GET" && path === WORKSPACE_KNOWN_PATH) {
        sendJson(res, 200, await app.listKnownWorkspaces());
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_REMOVE_PATH) {
        const body = (await readJsonBody(req)) as WorkspaceRemoveRequest;
        await app.removeKnownWorkspace(
          requireString(body?.workspaceId, "workspaceId"),
        );
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_FILES_LIST_PATH) {
        const body = (await readJsonBody(req)) as WorkspaceFileListRequest;
        const workspaceId = requireString(body?.workspaceId, "workspaceId");
        const relativePath = typeof body?.path === "string" ? body.path : "";
        sendJson(res, 200, app.listWorkspaceFiles(workspaceId, relativePath));
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_PDF_OPEN_PATH) {
        const body = (await readJsonBody(req)) as WorkspacePathRequest;
        const workspaceId = requireString(body?.workspaceId, "workspaceId");
        sendJson(
          res,
          200,
          app.openWorkspacePdf(workspaceId, requireWorkspacePath(body?.path)),
        );
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_PDF_RELEASE_PATH) {
        const body = (await readJsonBody(req)) as { sourceId?: unknown };
        app.releaseWorkspacePdfSource(requireString(body.sourceId, "sourceId"));
        res.statusCode = 204;
        res.end();
        return;
      }

      if ((req.method === "HEAD" || req.method === "GET") && path === WORKSPACE_FILES_PDF_PATH) {
        const sourceId = requireString(query.get("source"), "source");
        const source = app.getWorkspacePdfSource(sourceId);
        setPdfHeaders(res, source);
        if (req.method === "HEAD") {
          res.statusCode = 200;
          res.setHeader("Content-Length", String(source.size));
          res.end();
          return;
        }
        const range = parsePdfRange(req.headers.range, source.size);
        if (!range) {
          res.statusCode = 416;
          res.setHeader("Content-Range", `bytes */${source.size}`);
          sendJson(res, 416, { error: "A single valid PDF byte range is required" });
          return;
        }
        const controller = new AbortController();
        const abort = () => controller.abort(new Error("PDF request aborted"));
        const abortResponse = () => {
          if (!res.writableEnded) abort();
        };
        req.once("aborted", abort);
        res.once("close", abortResponse);
        let chunk;
        try {
          chunk = await app.readWorkspacePdfRange(
            sourceId,
            range.start,
            range.end,
            controller.signal,
          );
        } finally {
          req.off("aborted", abort);
          res.off("close", abortResponse);
        }
        if (req.aborted || res.destroyed || controller.signal.aborted) return;
        res.statusCode = 206;
        res.setHeader("Content-Length", String(chunk.bytes.byteLength));
        res.setHeader("Content-Range", `bytes ${chunk.start}-${chunk.end}/${chunk.size}`);
        res.end(Buffer.from(chunk.bytes));
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_MARKDOWN_OPEN_PATH) {
        const body = (await readJsonBody(req)) as WorkspacePathRequest;
        sendJson(
          res,
          200,
          app.openMarkdownDocument(
            requireString(body?.workspaceId, "workspaceId"),
            requireWorkspacePath(body?.path),
          ),
        );
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_MARKDOWN_SAVE_PATH) {
        const body = (await readJsonBody(req)) as MarkdownDocumentSaveRequest &
          WorkspacePathRequest;
        sendJson(
          res,
          200,
          await app.saveMarkdownDocument(
            requireString(body?.workspaceId, "workspaceId"),
            requireWorkspacePath(body?.path),
            {
              version: requireString(body?.version, "version"),
              content: requireDocumentContent(body?.content),
            },
          ),
        );
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_GRAPH_RETRY_PATH) {
        const body = (await readJsonBody(req)) as WorkspaceGraphRequest;
        app.retryWorkspaceGraph(requireString(body?.workspaceId, "workspaceId"));
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_GRAPH_PATH) {
        const body = (await readJsonBody(req)) as WorkspaceGraphRequest;
        sendJson(res, 200, app.getWorkspaceGraph(
          requireString(body?.workspaceId, "workspaceId"),
        ));
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_LINK_INDEX_PATH) {
        const body = (await readJsonBody(req)) as WorkspaceLinkIndexRequest;
        sendJson(res, 200, app.getWorkspaceLinkIndex(
          requireString(body?.workspaceId, "workspaceId"),
        ));
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_LINK_RESOLVE_PATH) {
        const body = (await readJsonBody(req)) as WorkspaceLinkResolveCommand;
        const syntax = body?.syntax;
        if (syntax !== "markdown" && syntax !== "wikilink") {
          throw new Error("syntax is invalid");
        }
        if (typeof body.authoredTarget !== "string") {
          throw new Error("authoredTarget is required");
        }
        const sourcePath = body.sourcePath === undefined
          ? undefined
          : requireWorkspacePath(body.sourcePath);
        const subpath = readLinkSubpath(body.subpath);
        sendJson(res, 200, app.resolveWorkspaceLink(
          requireString(body.workspaceId, "workspaceId"),
          {
            ...(sourcePath !== undefined ? { sourcePath } : {}),
            syntax,
            authoredTarget: body.authoredTarget,
            ...(subpath ? { subpath } : {}),
          },
        ));
        return;
      }

      if (req.method === "POST" && path === "/api/workspace/files/change") {
        if (!isLoopbackCaller(req) || !isSameOrigin(req)) {
          sendError(res, 403, "File changes are only available to the local Browser UI");
          return;
        }
        const body = (await readJsonBody(req)) as { workspaceId: string; change: WorkspaceFileChange };
        sendJson(res, 200, await app.changeWorkspaceFiles(requireString(body?.workspaceId, "workspaceId"), body?.change));
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_LINK_CREATE_PATH) {
        const body = (await readJsonBody(req)) as WorkspaceMarkdownCreateRequest;
        sendJson(res, 201, app.createWorkspaceMarkdown(
          requireString(body?.workspaceId, "workspaceId"),
          requireWorkspacePath(body?.path),
        ));
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_PANE_LOAD_PATH) {
        const body = (await readJsonBody(req)) as WorkspacePaneLoadRequest;
        sendJson(res, 200, app.loadWorkspacePaneState(
          requireString(body?.workspaceId, "workspaceId"),
        ));
        return;
      }

      if (req.method === "POST" && path === WORKSPACE_PANE_SAVE_PATH) {
        const body = (await readJsonBody(req)) as WorkspacePaneSaveRequest;
        const sanitized = sanitizeWorkspacePaneSnapshot(body?.state);
        if (!sanitized) throw new Error("state is invalid");
        app.saveWorkspacePaneState(
          requireString(body?.workspaceId, "workspaceId"),
          sanitized.state,
        );
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "GET" && path === SESSION_LIST_PATH) {
        const workspaceId = requireString(query.get("workspaceId"), "workspaceId");
        const sessions = await app.listSessions(workspaceId);
        sendJson(res, 200, { sessions });
        return;
      }

      if (req.method === "POST" && path === SESSION_PREPARE_PATH) {
        const body = (await readJsonBody(req)) as SessionSelectionRequest;
        const skills = await app.prepareSession(
          requireString(body?.workspaceId, "workspaceId"),
          requireString(body?.sessionId, "sessionId"),
          requireSelectionToken(body?.selectionToken),
        );
        sendJson(res, 200, { skills });
        return;
      }

      if (req.method === "POST" && path === SESSION_RELEASE_PATH) {
        const body = (await readJsonBody(req)) as SessionSelectionRequest;
        await app.releaseSession(
          requireString(body?.workspaceId, "workspaceId"),
          requireString(body?.sessionId, "sessionId"),
          requireSelectionToken(body?.selectionToken),
        );
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "POST" && path === SESSION_CREATE_PATH) {
        const body = (await readJsonBody(req)) as SessionCreateRequest;
        sendJson(
          res,
          200,
          await app.createSession(
            requireString(body?.workspaceId, "workspaceId"),
            readSessionConfiguration(body.configuration),
          ),
        );
        return;
      }

      if (req.method === "POST" && path === SESSION_OPEN_PATH) {
        const body = (await readJsonBody(req)) as SessionOpenRequest;
        sendJson(
          res,
          200,
          await app.openSession(
            requireString(body?.workspaceId, "workspaceId"),
            requireString(body?.sessionId, "sessionId"),
          ),
        );
        return;
      }

      if (req.method === "POST" && path === SESSION_DELETE_PATH) {
        const body = (await readJsonBody(req)) as SessionDeleteRequest;
        await app.deleteSession(
          requireString(body?.workspaceId, "workspaceId"),
          requireString(body?.sessionId, "sessionId"),
        );
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "GET" && path === SESSION_CONFIGURATION_PATH) {
        sendJson(
          res,
          200,
          await app.getSessionConfiguration(
            requireString(query.get("workspaceId"), "workspaceId"),
            requireString(query.get("sessionId"), "sessionId"),
          ),
        );
        return;
      }

      if (req.method === "POST" && path === SESSION_CONFIGURATION_PATH) {
        const body = (await readJsonBody(req)) as SessionConfigurationUpdateRequest;
        sendJson(
          res,
          200,
          await app.updateSessionConfiguration(
            requireString(body?.workspaceId, "workspaceId"),
            requireString(body?.sessionId, "sessionId"),
            readSessionConfiguration(body.configuration),
          ),
        );
        return;
      }

      if (req.method === "POST" && path === SESSION_RELOAD_PATH) {
        const body = (await readJsonBody(req)) as SessionConfigurationRequest;
        const skills = await app.reloadSessionResources(
          requireString(body?.workspaceId, "workspaceId"),
          requireString(body?.sessionId, "sessionId"),
        );
        sendJson(res, 200, { ok: true, skills });
        return;
      }

      if (req.method === "GET" && path === CREDENTIAL_LIST_PATH) {
        const credentials = await app.listCredentials();
        sendJson(res, 200, { credentials });
        return;
      }

      if (req.method === "POST" && path === CREDENTIAL_SET_PATH) {
        const body = readKnownObject(
          await readJsonBody(req),
          SET_CREDENTIAL_FIELDS,
          "Credential request",
        );
        const saved = await app.setCredential({
          providerId: requireString(body.providerId, "providerId"),
          apiKey: requireString(body.apiKey, "apiKey"),
        });
        sendJson(res, 200, saved);
        return;
      }

      if (req.method === "POST" && path === CREDENTIAL_DELETE_PATH) {
        const body = readKnownObject(
          await readJsonBody(req),
          PROVIDER_ID_REQUEST_FIELDS,
          "Credential request",
        );
        await app.deleteCredential(requireString(body.providerId, "providerId"));
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "POST" && path === AUTHENTICATION_START_PATH) {
        if (!app.startAuthentication) throw new Error("Authentication is unavailable");
        const body = await readJsonBody(req) as Record<string, unknown>;
        const type = body?.type;
        if (type !== "oauth" && type !== "api_key") throw new Error("type is invalid");
        sendJson(res, 200, await app.startAuthentication({
          providerId: requireString(body.providerId, "providerId"),
          type,
        }));
        return;
      }

      if (req.method === "POST" && path === AUTHENTICATION_RESPOND_PATH) {
        if (!app.respondAuthentication) throw new Error("Authentication is unavailable");
        const body = await readJsonBody(req) as Record<string, unknown>;
        await app.respondAuthentication({
          sessionId: requireString(body.sessionId, "sessionId"),
          promptId: requireString(body.promptId, "promptId"),
          value: requireString(body.value, "value"),
        });
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "POST" && path === AUTHENTICATION_CANCEL_PATH) {
        if (!app.cancelAuthentication) throw new Error("Authentication is unavailable");
        const body = await readJsonBody(req) as Record<string, unknown>;
        await app.cancelAuthentication({ sessionId: requireString(body.sessionId, "sessionId") });
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "GET" && path === AUTHENTICATION_EVENTS_PATH) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        if (!app.subscribeAuthentication) throw new Error("Authentication is unavailable");
        const unsubscribe = app.subscribeAuthentication((event) => writeSse(res, event));
        res.write(": connected\n\n");
        const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          unsubscribe();
        };
        res.once("close", close);
        req.once("aborted", close);
        return;
      }

      if (req.method === "GET" && path === PROVIDERS_LIST_PATH) {
        sendJson(res, 200, { providers: await app.listProviders() });
        return;
      }

      if (req.method === "POST" && path === PROVIDER_CREATE_PATH) {
        sendJson(res, 200, await app.createProvider(readProviderInput(await readJsonBody(req))));
        return;
      }

      if (req.method === "POST" && path === PROVIDER_UPDATE_PATH) {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        sendJson(
          res,
          200,
          await app.updateProvider(
            requireString(body?.providerId, "providerId"),
            readProviderInput(body),
          ),
        );
        return;
      }

      if (req.method === "POST" && path === PROVIDER_DELETE_PATH) {
        const body = readKnownObject(
          await readJsonBody(req),
          PROVIDER_ID_REQUEST_FIELDS,
          "Provider delete request",
        );
        await app.deleteProvider(requireString(body.providerId, "providerId"));
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === "GET" && path === MODELS_CATALOG_PATH) {
        const providers = await app.getModelCatalog();
        sendJson(res, 200, { providers });
        return;
      }

      if (req.method === "GET" && path === DEFAULTS_GET_PATH) {
        sendJson(res, 200, app.getAppDefaults());
        return;
      }

      if (req.method === "POST" && path === "/api/workspace/versions") {
        const body = readKnownObject(await readJsonBody(req), ["workspaceId", "offset"], "Versions request");
        if (body.offset !== undefined && (typeof body.offset !== "number" || !Number.isSafeInteger(body.offset) || body.offset < 0)) {
          throw new Error("Invalid versions offset");
        }
        sendJson(res, 200, await app.getVersions(requireString(body.workspaceId, "workspaceId"), body.offset as number | undefined));
        return;
      }
      if (req.method === "POST" && path === "/api/workspace/versions/changes") {
        const body = readKnownObject(await readJsonBody(req), ["workspaceId"], "Current changes request");
        sendJson(res, 200, await app.getVersionChanges(requireString(body.workspaceId, "workspaceId")));
        return;
      }
      if (req.method === "POST" && path === "/api/workspace/versions/diff") {
        const body = readKnownObject(await readJsonBody(req), ["workspaceId", "path"], "Current diff request");
        sendJson(res, 200, await app.getVersionFileDiff(requireString(body.workspaceId, "workspaceId"), requireString(body.path, "path")));
        return;
      }
      if (req.method === "POST" && path === "/api/workspace/versions/restore") {
        const body = readKnownObject(await readJsonBody(req), ["workspaceId", "versionId"], "Restore version request");
        sendJson(res, 200, await app.restoreVersion(requireString(body.workspaceId, "workspaceId"), requireString(body.versionId, "versionId")));
        return;
      }
      if (req.method === "POST" && path === "/api/workspace/versions/save") {
        const body = readKnownObject(await readJsonBody(req), ["workspaceId", "message", "sessionId"], "Save version request");
        sendJson(res, 200, await app.saveVersion(requireString(body.workspaceId, "workspaceId"), {
          ...(body.message === undefined ? {} : { message: requireString(body.message, "message") }),
          ...(body.sessionId === undefined ? {} : { sessionId: requireString(body.sessionId, "sessionId") }),
        }));
        return;
      }

      if (req.method === "GET" && path === "/api/utility-model/settings") {
        sendJson(res, 200, app.getUtilitySettings());
        return;
      }

      if (req.method === "POST" && path === "/api/utility-model/settings") {
        sendJson(res, 200, app.updateUtilitySettings(await readJsonBody(req)));
        return;
      }

      if (req.method === "POST" && path === DEFAULTS_UPDATE_PATH) {
        sendJson(
          res,
          200,
          app.updateAppDefaults(readAppDefaultsUpdate(await readJsonBody(req))),
        );
        return;
      }

      if (req.method === "POST" && path === SESSION_PROMPT_PATH) {
        await app.prompt(normalizeStructuredPrompt(await readJsonBody(req)));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && path === SESSION_TRUST_PATH) {
        sendJson(
          res,
          200,
          app.getProjectTrustRequest(
            requireString(query.get("workspaceId"), "workspaceId"),
            requireString(query.get("sessionId"), "sessionId"),
          ),
        );
        return;
      }

      if (req.method === "POST" && path === SESSION_TRUST_PATH) {
        const body = (await readJsonBody(req)) as ProjectTrustResolutionRequest;
        const skills = await app.resolveProjectTrust({
          workspaceId: requireString(body?.workspaceId, "workspaceId"),
          sessionId: requireString(body?.sessionId, "sessionId"),
          cwd: requireString(body?.cwd, "cwd"),
          trusted: requireBoolean(body?.trusted, "trusted"),
        });
        sendJson(res, 200, { skills });
        return;
      }

      if (req.method === "POST" && path === SESSION_ABORT_PATH) {
        const body = (await readJsonBody(req)) as SessionAbortRequest;
        await app.abort(
          requireString(body?.workspaceId, "workspaceId"),
          requireString(body?.sessionId, "sessionId"),
        );
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && path === SESSION_IMAGE_PATH) {
        res.setHeader("Cache-Control", "no-store");
        const result = await app.getSessionImage(
          requireString(query.get("workspaceId"), "workspaceId"),
          requireString(query.get("sessionId"), "sessionId"),
          requireString(query.get("imageRef"), "imageRef"),
        );
        if (result.status === "ready") {
          sendImage(res, result);
        } else if (result.status === "pending") {
          sendError(res, 425, "Image is not available yet");
        } else {
          sendError(res, 404, "Image not found");
        }
        return;
      }

      if (req.method === "GET" && path === SESSION_TIMELINE_SNAPSHOT_PATH) {
        const workspaceId = requireString(query.get("workspaceId"), "workspaceId");
        const sessionId = requireString(query.get("sessionId"), "sessionId");
        sendJson(res, 200, app.getTimelineSnapshot(workspaceId, sessionId));
        return;
      }

      if (req.method === "GET" && path === SESSION_EVENTS_PATH) {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();

        const unsubscribe = app.subscribeEvents((event) => {
          writeSse(res, event);
        });
        res.write(": connected\n\n");

        const keepAlive = setInterval(() => {
          res.write(": keepalive\n\n");
        }, 15_000);

        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(keepAlive);
          unsubscribe();
        };
        res.once("close", close);
        req.once("aborted", close);
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (path === WORKSPACE_FILES_PDF_PATH || path === WORKSPACE_PDF_OPEN_PATH) {
        res.setHeader("Cache-Control", "no-store");
        const code = pdfErrorCode(error);
        if (code) {
          res.setHeader("X-Wikilot-PDF-Error", code);
          if (req.method === "HEAD") {
            res.statusCode = PDF_ERROR_STATUS[code]!;
            res.end();
            return;
          }
          sendJson(res, PDF_ERROR_STATUS[code]!, { error: message, code });
          return;
        }
      }
      if (req.aborted || res.destroyed) return;
      sendError(res, 400, message);
      return;
    }

    next();
  };
}
