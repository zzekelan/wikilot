import trash from "trash";
import { importWorkspaceFiles } from "./workspace-import";
import { randomUUID } from "node:crypto";
import type {
  WorkspaceFileChange,
  WorkspaceFileReport,
  KnownWorkspace,
  KnownWorkspaceListResponse,
  MarkdownDocumentSaveRequest,
  MarkdownDocumentSaveResult,
  MarkdownDocumentSnapshot,
  WorkspaceFileListResponse,
  WorkspacePdfRange,
  WorkspacePdfErrorCode,
  WorkspacePdfSource,
  WorkspaceFilesChangedEvent,
  WorkspaceEvent,
  WorkspaceGraphSnapshot,
  WorkspaceLinkIndexSnapshot,
  WorkspaceLinkResolution,
  WorkspaceLinkResolveRequest,
  WorkspacePaneRestoreResult,
  WorkspacePaneState,
  WorkspaceSummary,
} from "../../shared/workspace";
import { createKnownWorkspaceStore } from "./known-workspaces";
import { createWorkspacePaneStore } from "./pane-state";
import {
  createWorkspaceEntry,
  renameWorkspaceEntry,
  moveWorkspaceEntries,
  trashWorkspaceEntries,
  listWorkspaceFiles,
  openMarkdownDocument,
  saveMarkdownDocument,
} from "./workspace-files";
import {
  createWorkspacePdfAccess,
  WorkspacePdfAccessError,
  type WorkspacePdfFile,
} from "./workspace-pdf-access";
import { encodeAbsoluteCwd } from "./workspace-identity";
import {
  cachedSymlinkStillExcluded,
  collectWorkspaceSymlinkPaths,
  findWorkspaceSymlinkPrefix,
  normalizeWorkspaceEventPath,
  normalizeWorkspacePath,
} from "./workspace-path";
import { createWorkspaceRegistry } from "./workspace-registry";
import { initializeWorkspace } from "./workspace-initialization";
import { watchWorkspaceFiles, type WorkspaceFilesListener } from "./workspace-watcher";
import { projectWorkspaceGraph } from "./workspace-graph";
import { buildWorkspaceLinkIndex } from "./workspace-link-index";
import { resolveWorkspaceLink } from "./workspace-link-index";
import { dirname, extname } from "node:path";


export type WorkspaceModule = {
  open(cwd: string): WorkspaceSummary;
  resolve(workspaceId: string): WorkspaceSummary;
  listKnown(): Promise<KnownWorkspaceListResponse>;
  removeKnown(workspaceId: string): Promise<void>;
  rememberSession(workspaceId: string, sessionId: string): void;
  forgetSession(workspaceId: string, sessionId: string): void;
  listFiles(workspaceId: string, path: string): WorkspaceFileListResponse;
  openPdf(workspaceId: string, path: string): WorkspacePdfSource;
  openMarkdownDocument(workspaceId: string, path: string): MarkdownDocumentSnapshot;
  saveMarkdownDocument(
    workspaceId: string,
    path: string,
    request: MarkdownDocumentSaveRequest,
  ): Promise<MarkdownDocumentSaveResult>;
  getLinkIndex(workspaceId: string): WorkspaceLinkIndexSnapshot;
  getGraph(workspaceId: string): WorkspaceGraphSnapshot;
  retryGraph(workspaceId: string): void;
  resolveLink(workspaceId: string, request: WorkspaceLinkResolveRequest): WorkspaceLinkResolution;
  changeFiles(workspaceId: string, change: WorkspaceFileChange): Promise<WorkspaceFileReport>;
  importFiles(workspaceId: string, destination: string, sourcePaths: string[], signal?: AbortSignal): Promise<WorkspaceFileReport>;
  createMarkdown(workspaceId: string, path: string): MarkdownDocumentSnapshot;
  getPdfSource(sourceId: string): WorkspacePdfSource;
  /** Revoke an opaque Browser capability. Repeated release is harmless. */
  releasePdfSource(sourceId: string): void;
  readPdfRange(
    sourceId: string,
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<WorkspacePdfRange>;
  /** Restore the Workspace's Pane navigation snapshot (validated item by item). */
  loadPaneState(workspaceId: string): WorkspacePaneRestoreResult;
  /** Persist the Workspace's Pane navigation snapshot (atomic replace). */
  savePaneState(workspaceId: string, state: WorkspacePaneState): void;
  subscribe(listener: (event: WorkspaceEvent) => void): () => void;
  shutdown(): Promise<void>;
};

export type WorkspaceModuleOptions = {
  agentDir: string;
  hasActiveTurn(workspaceId: string): Promise<boolean>;
  now?: () => Date;
};

/** Internal adapters vary in module tests; callers use the default real disk watcher. */
type WorkspaceModuleAdapters = {
  trashEntry?: (absolutePath: string) => Promise<void>;
  watchFiles(
    cwd: string,
    listener: WorkspaceFilesListener,
    onRecovery: () => void,
  ): () => void;
};

const DEFAULT_ADAPTERS: WorkspaceModuleAdapters = {
  watchFiles: watchWorkspaceFiles,
  trashEntry: path => trash([path], { glob: false }),
};

/**
 * Owns Workspace identity, containment, Known Workspace persistence, file
 * access, and filesystem observation behind one identity-based interface.
 */
export function createWorkspaceModule(
  options: WorkspaceModuleOptions,
): WorkspaceModule {
  return createWorkspaceModuleWithAdapters(options, DEFAULT_ADAPTERS);
}

/** Internal construction seam used only by colocated Workspace module tests. */
export function createWorkspaceModuleWithAdapters(
  options: WorkspaceModuleOptions,
  adapters: WorkspaceModuleAdapters,
): WorkspaceModule {
  const registry = createWorkspaceRegistry();
  const known = createKnownWorkspaceStore({ agentDir: options.agentDir, now: options.now });
  const panes = createWorkspacePaneStore({ agentDir: options.agentDir, now: options.now });
  const listeners = new Set<(event: WorkspaceEvent) => void>();
  const watchers = new Map<string, () => void>();
  const saveQueues = new Map<string, Promise<void>>();

  function serializeSave<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = saveQueues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(operation);
    const settled = result.then(() => {}, () => {});
    saveQueues.set(key, settled);
    void settled.finally(() => {
      if (saveQueues.get(key) === settled) saveQueues.delete(key);
    });
    return result;
  }

  const linkIndexes = new Map<string, WorkspaceLinkIndexSnapshot>();
  const graphSnapshots = new Map<string, WorkspaceGraphSnapshot>();
  const linkIndexBuilds = new Map<string, Promise<void>>();
  const linkIndexRetries = new Map<string, ReturnType<typeof setTimeout>>();
  let shuttingDown = false;

  function queueLinkIndexBuild(summary: WorkspaceSummary): void {
    const previousBuild = linkIndexBuilds.get(summary.id) ?? Promise.resolve();
    let hadCoherentRevision = false;
    const build = previousBuild.then(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const previous = linkIndexes.get(summary.id);
      hadCoherentRevision = previous?.status === "ready";
      const { records, targets, propertyRegistry } = buildWorkspaceLinkIndex(summary.cwd);
      const revision = previous?.status === "ready" ? previous.revision + 1 : 1;
      const linkSnapshot: WorkspaceLinkIndexSnapshot = {
        status: "ready", revision, targets, records, propertyRegistry,
      };
      linkIndexes.set(summary.id, linkSnapshot);
      graphSnapshots.set(summary.id, projectWorkspaceGraph(linkSnapshot));
      for (const listener of listeners) {
        listener({ type: "workspace_link_index_changed", workspaceId: summary.id, revision });
      }
    }).catch(() => {
      if (!hadCoherentRevision) {
        graphSnapshots.set(summary.id, { status: "error", code: "index-build-failed" });
      }
      // Preserve the previous coherent Link Index revision and retry transient failures.
      if (shuttingDown || linkIndexRetries.has(summary.id)) return;
      const retry = setTimeout(() => {
        linkIndexRetries.delete(summary.id);
        if (!hadCoherentRevision) graphSnapshots.set(summary.id, { status: "retrying" });
        queueLinkIndexBuild(summary);
      }, hadCoherentRevision ? 100 : 3_000);
      retry.unref();
      linkIndexRetries.set(summary.id, retry);
    });
    linkIndexBuilds.set(summary.id, build);
  }

  function startLinkIndex(summary: WorkspaceSummary): void {
    if (linkIndexes.has(summary.id)) return;
    linkIndexes.set(summary.id, { status: "building" });
    graphSnapshots.set(summary.id, { status: "building" });
    queueLinkIndexBuild(summary);
  }
  const pdfAccess = createWorkspacePdfAccess();
  const pdfSources = new Map<string, { source: WorkspacePdfSource; file: WorkspacePdfFile }>();

  class WorkspacePdfError extends Error {
    readonly code: WorkspacePdfErrorCode;

    constructor(code: WorkspacePdfErrorCode, message: string) {
      super(message);
      this.name = "WorkspacePdfError";
      this.code = code;
    }
  }

  function mapPdfError(error: unknown): never {
    if (!(error instanceof WorkspacePdfAccessError)) throw error;
    const code: WorkspacePdfErrorCode = error.code === "too-large"
      ? "too-large"
      : error.code === "source-changed"
        ? "source-changed"
        : error.code === "not-found"
          ? "deleted"
          : "unavailable";
    throw new WorkspacePdfError(code, error.message);
  }

  function registerPdfSource(file: WorkspacePdfFile): WorkspacePdfSource {
    const source: WorkspacePdfSource = {
      sourceId: randomUUID(),
      version: file.version,
      size: file.size,
      mediaType: "application/pdf",
    };
    pdfSources.set(source.sourceId, { source, file });
    return source;
  }

  function startWatcher(summary: WorkspaceSummary): void {
    if (watchers.has(summary.id)) return;
    const symlinks = new Set(collectWorkspaceSymlinkPaths(summary.cwd));
    const onPaths: WorkspaceFilesListener = (rawPaths) => {
      const paths = [
        ...new Set(
          rawPaths
            .map((rawPath) => {
              let path: string;
              try {
                path = normalizeWorkspacePath(rawPath);
              } catch {
                return null;
              }
              for (const prefix of symlinks) {
                if (path !== prefix && !path.startsWith(`${prefix}/`)) continue;
                if (cachedSymlinkStillExcluded(summary.cwd, prefix)) return null;
                symlinks.delete(prefix);
              }
              const symlink = findWorkspaceSymlinkPrefix(summary.cwd, path);
              if (symlink) {
                symlinks.add(symlink);
                return null;
              }
              return normalizeWorkspaceEventPath(summary.cwd, path);
            })
            .filter((path): path is string => path !== null),
        ),
      ];
      if (paths.length === 0) return;
      const event: WorkspaceFilesChangedEvent = {
        type: "workspace_files_changed",
        workspaceId: summary.id,
        paths,
      };
      queueLinkIndexBuild(summary);
      for (const listener of listeners) listener(event);
    };
    let stop: () => void;
    try {
      stop = adapters.watchFiles(summary.cwd, onPaths, () => queueLinkIndexBuild(summary));
    } catch {
      // Observation is best-effort; File Tree manual refresh remains usable.
      stop = () => {};
    }
    watchers.set(summary.id, stop);
  }

  function requireKnown(workspaceId: string) {
    const snapshot = known.read();
    const entry = snapshot.workspaces.find(
      (candidate) => encodeAbsoluteCwd(candidate.cwd) === workspaceId,
    );
    if (!entry) throw new Error("Known Workspace not found");
    return entry;
  }

  function requireCwd(workspaceId: string): string {
    try {
      return registry.require(workspaceId).cwd;
    } catch {
      return requireKnown(workspaceId).cwd;
    }
  }

  return {
    open(cwd) {
      const summary = registry.open(cwd);
      initializeWorkspace(summary.cwd);
      startWatcher(summary);
      startLinkIndex(summary);
      known.recordOpen(summary.cwd);
      return summary;
    },

    resolve(workspaceId) {
      return registry.require(workspaceId);
    },

    async listKnown() {
      const snapshot = known.read();
      const workspaces: KnownWorkspace[] = [];
      for (const entry of snapshot.workspaces) {
        const id = encodeAbsoluteCwd(entry.cwd);
        workspaces.push({
          id,
          cwd: entry.cwd,
          lastOpenedAt: entry.lastOpenedAt,
          ...(entry.selectedSessionId ? { selectedSessionId: entry.selectedSessionId } : {}),
          hasActiveTurn: watchers.has(id) ? await options.hasActiveTurn(id) : false,
        });
      }
      return {
        workspaces,
        launchCwd: snapshot.launchCwd,
        ...(snapshot.warning ? { warning: snapshot.warning } : {}),
      };
    },

    async removeKnown(workspaceId) {
      const entry = requireKnown(workspaceId);
      if (watchers.has(workspaceId) && (await options.hasActiveTurn(workspaceId))) {
        throw new Error("Cannot remove a Workspace with an active Turn");
      }
      known.remove(entry.cwd);
      panes.remove(entry.cwd);
    },

    rememberSession(workspaceId, sessionId) {
      known.recordSessionSelection(registry.require(workspaceId).cwd, sessionId);
    },

    forgetSession(workspaceId, sessionId) {
      known.clearSessionSelection(registry.require(workspaceId).cwd, sessionId);
    },

    listFiles(workspaceId, path) {
      return listWorkspaceFiles(registry.require(workspaceId).cwd, path);
    },

    openPdf(workspaceId, path) {
      const cwd = registry.require(workspaceId).cwd;
      try {
        return registerPdfSource(pdfAccess.inspect(cwd, path));
      } catch (error) {
        return mapPdfError(error);
      }
    },

    async readPdfRange(sourceId, start, end, signal) {
      const entry = pdfSources.get(sourceId);
      if (!entry) {
        throw new WorkspacePdfError("unavailable", "PDF source is unavailable");
      }
      try {
        const range = await pdfAccess.readRange(entry.file, start, end, signal);
        return { ...entry.source, ...range };
      } catch (error) {
        return mapPdfError(error);
      }
    },

    getPdfSource(sourceId) {
      const entry = pdfSources.get(sourceId);
      if (!entry) {
        throw new WorkspacePdfError("unavailable", "PDF source is unavailable");
      }
      try {
        pdfAccess.validate(entry.file);
        return entry.source;
      } catch (error) {
        return mapPdfError(error);
      }
    },

    releasePdfSource(sourceId) {
      pdfSources.delete(sourceId);
    },

    openMarkdownDocument(workspaceId, path) {
      return openMarkdownDocument(requireCwd(workspaceId), path);
    },

    saveMarkdownDocument(workspaceId, path, request) {
      const cwd = requireCwd(workspaceId);
      const normalizedPath = normalizeWorkspacePath(path);
      return serializeSave(cwd, () =>
        saveMarkdownDocument(cwd, normalizedPath, request),
      );
    },

    getLinkIndex(workspaceId) {
      registry.require(workspaceId);
      return linkIndexes.get(workspaceId) ?? { status: "building" };
    },

    getGraph(workspaceId) {
      registry.require(workspaceId);
      return graphSnapshots.get(workspaceId) ?? { status: "building" };
    },

    retryGraph(workspaceId) {
      const summary = registry.require(workspaceId);
      const retry = linkIndexRetries.get(workspaceId);
      if (retry) clearTimeout(retry);
      linkIndexRetries.delete(workspaceId);
      graphSnapshots.set(workspaceId, { status: "retrying" });
      queueLinkIndexBuild(summary);
    },

    resolveLink(workspaceId, request) {
      registry.require(workspaceId);
      const snapshot = linkIndexes.get(workspaceId);
      if (!snapshot || snapshot.status === "building") return { status: "building" };
      return {
        status: "ready",
        revision: snapshot.revision,
        target: resolveWorkspaceLink(request, snapshot.targets, snapshot.records),
      };
    },

    async changeFiles(workspaceId, change) {
      const summary = registry.require(workspaceId);
      const report = await serializeSave(summary.cwd, async () => change?.kind === "rename"
        ? renameWorkspaceEntry(summary.cwd, change)
        : change?.kind === "move" ? moveWorkspaceEntries(summary.cwd, change)
        : change?.kind === "trash" ? trashWorkspaceEntries(summary.cwd, change, adapters.trashEntry ?? DEFAULT_ADAPTERS.trashEntry!)
        : createWorkspaceEntry(summary.cwd, change));
      if (report.created.length || report.relocated.length || report.trashed?.length) queueLinkIndexBuild(summary);
      return report;
    },

    async importFiles(workspaceId, destination, sourcePaths, signal) {
      const summary = registry.require(workspaceId);
      const report = await serializeSave(summary.cwd, () => importWorkspaceFiles(summary.cwd, destination, sourcePaths, signal));
      if (report.created.length) queueLinkIndexBuild(summary);
      return report;
    },

    createMarkdown(workspaceId, inputPath) {
      const summary = registry.require(workspaceId);
      const path = normalizeWorkspacePath(inputPath);
      if (extname(path).toLowerCase() !== ".md") {
        throw new Error("Only missing Markdown files can be created");
      }
      const parentPath = dirname(path).replace(/^\.$/, "");
      const report = createWorkspaceEntry(summary.cwd, { kind: "create", parent: parentPath, name: path.split("/").at(-1)!, entryKind: "file" });
      if (report.failures.length) throw new Error(report.failures[0]!.message);
      queueLinkIndexBuild(summary);
      return openMarkdownDocument(summary.cwd, path);
    },

    loadPaneState(workspaceId) {
      return panes.load(requireCwd(workspaceId));
    },

    savePaneState(workspaceId, state) {
      panes.save(requireCwd(workspaceId), state);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async shutdown() {
      shuttingDown = true;
      for (const stop of watchers.values()) stop();
      for (const retry of linkIndexRetries.values()) clearTimeout(retry);
      linkIndexRetries.clear();
      await Promise.allSettled(linkIndexBuilds.values());
      watchers.clear();
      linkIndexes.clear();
      graphSnapshots.clear();
      linkIndexBuilds.clear();
      listeners.clear();
      pdfSources.clear();
    },
  };
}
