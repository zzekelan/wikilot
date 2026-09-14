import { useCallback, useEffect, useRef, useState } from "react";
import type { MarkdownDocumentSnapshot, WorkspacePdfSource, WorkspaceFileReport } from "../../shared/workspace";
import { client } from "../client";
import { onWorkspaceFilesChanged } from "../client/workspace-file-events";
import { recordUiGesture } from "../telemetry";

export type ProtectedFileChangeResult =
  | { status: "completed"; report: WorkspaceFileReport }
  | { status: "blocked"; reason: "save-failed" | "conflict" | "unconfirmed"; paths: string[] };
type PathState = "protecting" | "relocated" | "trashed" | "unconfirmed";
type SaveResult = "saved" | "dirty" | "conflict" | "failed";
const isInvalidated = (state: PathState | undefined) => state === "relocated" || state === "trashed";
const containsPath = (parent: string, path: string) => path === parent || path.startsWith(`${parent}/`);

export type WorkspacePaneSaveController = {
  reopenPath(path: string): boolean;
  runFileChange(paths: string[], change: () => Promise<WorkspaceFileReport>): Promise<ProtectedFileChangeResult>;
  flushAll(): Promise<boolean>;
  hasDirtyDocuments(): boolean;
};

type SaveState = "saved" | "dirty" | "saving" | "failed";
type DocumentLoadError = { message: string; code?: string };
export type MarkdownDocument = {
  snapshot: MarkdownDocumentSnapshot;
  content: string;
  savedContent: string;
  saveState: SaveState;
  error: string | null;
  notice: string | null;
  editorEpoch: number;
  retryCount: number;
  conflict?: boolean;
};

const AUTOSAVE_DELAY_MS = 500;
const RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;

export function isMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path);
}

function documentFromSnapshot(
  snapshot: MarkdownDocumentSnapshot,
  previous?: MarkdownDocument,
  external = false,
): MarkdownDocument {
  if (snapshot.status === "ready") {
    const unchanged = previous?.content === snapshot.content;
    return {
      snapshot,
      content: snapshot.content,
      savedContent: snapshot.content,
      saveState: "saved",
      error: null,
      notice: external && previous && !unchanged
        ? "Your draft was replaced by a newer disk version."
        : previous?.notice ?? null,
      editorEpoch: (previous?.editorEpoch ?? 0) + (external && !unchanged ? 1 : 0),
      retryCount: 0,
    };
  }
  return {
    snapshot,
    content: previous?.content ?? "",
    savedContent: previous?.savedContent ?? "",
    saveState: previous?.saveState ?? "saved",
    error: previous?.error ?? null,
    notice: previous?.notice ?? null,
    editorEpoch: previous?.editorEpoch ?? 0,
    retryCount: previous?.retryCount ?? 0,
  };
}

type UseWorkspaceDocumentsOptions = {
  workspaceId: string;
  activePath: string | null;
  openPaths: string[];
  connectionRevision?: number;
  onSaveControllerChange?: (controller: WorkspacePaneSaveController | null) => void;
};

export function useWorkspaceDocuments({
  workspaceId,
  activePath,
  openPaths,
  connectionRevision = 0,
  onSaveControllerChange,
}: UseWorkspaceDocumentsOptions) {
  const [documents, setDocuments] = useState<Record<string, MarkdownDocument>>({});
  const documentsRef = useRef(documents);
  const openPathsRef = useRef(openPaths);
  openPathsRef.current = openPaths;
  const [pdfSource, setPdfSource] = useState<WorkspacePdfSource | null>(null);
  const [loadError, setLoadError] = useState<DocumentLoadError | null>(null);
  const [loading, setLoading] = useState(false);
  const loadSeq = useRef(0);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlightSaves = useRef(new Map<string, Promise<SaveResult>>());
  const deferredExternalLoads = useRef(new Set<string>());
  const savePathRef = useRef<(path: string, immediate?: boolean, protectedSave?: boolean) => Promise<SaveResult>>(async () => "saved");
  const loadPathRef = useRef<(path: string, external?: boolean) => Promise<void>>(async () => {});

  const pathStates = useRef(new Map<string, PathState>());
  const pathEpochs = useRef(new Map<string, number>());
  const [protectionRevision, setProtectionRevision] = useState(0);
  const pathState = useCallback((path: string) => {
    const matches = [...pathStates.current].filter(([parent]) => containsPath(parent, path));
    return matches.find(([, state]) => state !== "protecting")?.[1] ?? matches[0]?.[1];
  }, []);
  const pathEpoch = (path: string) => [...pathEpochs.current].reduce((sum, [parent, epoch]) => sum + (containsPath(parent, path) ? epoch : 0), 0);

  const releasePdfSource = useCallback((sourceId: string) => {
    void client.releaseWorkspacePdfSource(sourceId).catch(() => {
      // Revocation is idempotent and best-effort during view teardown.
    });
  }, []);

  const updateDocument = useCallback((
    path: string,
    update: (current: MarkdownDocument | undefined) => MarkdownDocument,
  ) => {
    const next = { ...documentsRef.current, [path]: update(documentsRef.current[path]) };
    documentsRef.current = next;
    setDocuments(next);
  }, []);

  const scheduleSave = useCallback((path: string, delay = AUTOSAVE_DELAY_MS) => {
    if (pathState(path)) return;
    const current = saveTimers.current.get(path);
    if (current) clearTimeout(current);
    saveTimers.current.set(path, setTimeout(() => {
      saveTimers.current.delete(path);
      void savePathRef.current(path);
    }, delay));
  }, [pathState]);

  const savePath = useCallback(async (path: string, immediate = false, protectedSave = false): Promise<SaveResult> => {
    const state = pathState(path);
    if (state && !(state === "protecting" && protectedSave)) return "failed";
    const timer = saveTimers.current.get(path);
    if (timer) {
      clearTimeout(timer);
      saveTimers.current.delete(path);
    }
    if (immediate && documentsRef.current[path]) {
      updateDocument(path, (current) => ({ ...current!, retryCount: 0, error: null }));
    }
    const existing = inFlightSaves.current.get(path);
    if (existing) {
      const saved = await existing;
      return saved !== "conflict" && saved !== "failed" && documentsRef.current[path]?.saveState === "dirty"
        ? savePathRef.current(path, immediate, protectedSave)
        : saved;
    }
    const document = documentsRef.current[path];
    if (!document) return "saved";
    if (protectedSave && document.conflict) return "conflict";
    if (document.snapshot.status !== "ready") return document.saveState === "saved" ? "saved" : "failed";
    if (document.content === document.savedContent && document.saveState !== "failed") return "saved";
    const version = document.snapshot.version;
    const content = document.content;
    updateDocument(path, (current) => ({ ...current!, saveState: "saving", error: null }));
    const operation = (async () => {
      try {
        const result = await client.saveMarkdownDocument(workspaceId, path, version, content);
        if (result.outcome === "conflict") {
          recordUiGesture("markdown.save", { "wikilot.markdown.outcome": "conflict" });
          updateDocument(path, (current) => ({
            ...current!, saveState: "failed", conflict: true,
            error: result.snapshot.status === "ready"
              ? "Save conflict. Your draft is preserved; reconcile the disk changes before saving."
              : "The disk file is not ready for saving. Your draft is preserved.",
          }));
          return "conflict" as const;
        }
        let editedDuringSave = false;
        updateDocument(path, (current) => {
          editedDuringSave = current!.content !== content;
          if (!editedDuringSave) return documentFromSnapshot(result.snapshot, current);
          return {
            ...current!,
            snapshot: result.snapshot,
            savedContent: content,
            saveState: "dirty",
            retryCount: 0,
            error: null,
          };
        });
        recordUiGesture("markdown.save", { "wikilot.markdown.outcome": "saved" });
        if (editedDuringSave) scheduleSave(path, 0);
        return editedDuringSave ? "dirty" as const : "saved" as const;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        let retryCount = 0;
        updateDocument(path, (current) => {
          retryCount = current!.retryCount + 1;
          return { ...current!, saveState: "failed", error: message, retryCount };
        });
        recordUiGesture("markdown.save", { "wikilot.markdown.outcome": "failed" });
        const retryDelay = RETRY_DELAYS_MS[retryCount - 1];
        if (retryDelay !== undefined) scheduleSave(path, retryDelay);
        return "failed" as const;
      } finally {
        inFlightSaves.current.delete(path);
        if (deferredExternalLoads.current.delete(path)) {
          void loadPathRef.current(path, true);
        }
      }
    })();
    inFlightSaves.current.set(path, operation);
    return operation;
  }, [pathState, scheduleSave, updateDocument, workspaceId]);
  savePathRef.current = savePath;

  const loadPath = useCallback(async (path: string, external = false) => {
    if (pathState(path)) { deferredExternalLoads.current.add(path); return; }
    const epoch = pathEpoch(path);
    if (external && inFlightSaves.current.has(path)) {
      deferredExternalLoads.current.add(path);
      return;
    }
    const seq = ++loadSeq.current;
    if (!external) {
      setLoading(true);
      setLoadError(null);
      setPdfSource(null);
    }
    try {
      if (!isMarkdownPath(path)) {
        const next = await client.openWorkspacePdf(workspaceId, path);
        if (seq === loadSeq.current && !pathState(path) && epoch === pathEpoch(path)) setPdfSource(next);
        else releasePdfSource(next.sourceId);
        return;
      }
      const snapshot = await client.openMarkdownDocument(workspaceId, path);
      if (pathState(path) || epoch !== pathEpoch(path) || (!external && seq !== loadSeq.current)) return;
      const previous = documentsRef.current[path];
      if (previous && previous.saveState !== "saved") {
        if (snapshot.status !== "ready" || snapshot.version !== previous.snapshot.version) {
          updateDocument(path, current => ({ ...current!, conflict: true, saveState: "failed", error: "Save conflict. Your draft is preserved; reconcile the disk changes before saving." }));
        }
        return;
      }
      if (
        external &&
        previous?.snapshot.status === "ready" &&
        snapshot.status === "ready" &&
        previous.snapshot.version === snapshot.version &&
        (previous.content === snapshot.content || previous.savedContent === snapshot.content)
      ) return;
      if (external && previous?.content !== (snapshot.status === "ready" ? snapshot.content : undefined)) {
        recordUiGesture("markdown.external_replace", { "wikilot.markdown.reason": "watcher" });
      }
      updateDocument(path, (current) => documentFromSnapshot(snapshot, current, external));
    } catch (error) {
      if (!external && seq === loadSeq.current) {
        setLoadError({
          message: error instanceof Error ? error.message : String(error),
          ...(
            typeof error === "object" && error !== null && "code" in error
            && typeof (error as { code?: unknown }).code === "string"
              ? { code: (error as { code: string }).code }
              : {}
          ),
        });
      }
    } finally {
      if (!external && seq === loadSeq.current) setLoading(false);
    }
  }, [pathState, releasePdfSource, updateDocument, workspaceId]);
  loadPathRef.current = loadPath;

  useEffect(() => {
    if (!activePath || pathState(activePath)) {
      setLoading(false);
      setLoadError(null);
      setPdfSource(null);
      return;
    }
    if (isMarkdownPath(activePath) && documentsRef.current[activePath]) {
      setLoading(false);
      setLoadError(null);
      setPdfSource(null);
      return;
    }
    void loadPath(activePath);
  }, [activePath, loadPath, connectionRevision, pathState, protectionRevision]);

  useEffect(() => onWorkspaceFilesChanged((paths) => {
    for (const path of paths) {
      if (documentsRef.current[path]) void loadPath(path, true);
    }
    if (activePath && paths.includes(activePath) && !documentsRef.current[activePath]) {
      void loadPath(activePath);
    }
  }), [activePath, loadPath]);

  useEffect(() => {
    const controller: WorkspacePaneSaveController = {
      reopenPath(path) {
        if (!isInvalidated(pathStates.current.get(path))) return false;
        pathStates.current.delete(path);
        const next = { ...documentsRef.current };
        delete next[path];
        documentsRef.current = next;
        setDocuments(next);
        setProtectionRevision(value => value + 1);
        return true;
      },
      async runFileChange(paths, change) {
        if (paths.some(path => [...pathStates.current].some(([parent, state]) => !isInvalidated(state) && (containsPath(parent, path) || containsPath(path, parent))))) {
          return { status: "blocked", reason: "unconfirmed", paths };
        }
        const previousStates = new Map(pathStates.current);
        const affected = (path: string) => paths.some(parent => containsPath(parent, path));
        for (const path of paths) {
          pathStates.current.set(path, "protecting");
          pathEpochs.current.set(path, (pathEpochs.current.get(path) ?? 0) + 1);
        }
        for (const [path, timer] of saveTimers.current) {
          if (affected(path)) { clearTimeout(timer); saveTimers.current.delete(path); }
        }
        setProtectionRevision(value => value + 1);
        try {
          for (const path of Object.keys(documentsRef.current).filter(path => affected(path) && !isInvalidated(previousStates.get(path)))) {
            const result = await savePathRef.current(path, true, true);
            if (result !== "saved") {
              const reason = result === "conflict" ? "conflict" : "save-failed";
              recordUiGesture("workspace.files.blocked", { "wikilot.operation.reason": reason });
              return { status: "blocked", reason, paths: [path] };
            }
          }
          const report = await change();
          for (const path of new Set([...openPathsRef.current, ...Object.keys(documentsRef.current)])) {
            if (report.trashed?.some(parent => containsPath(parent, path))) pathStates.current.set(path, "trashed");
            else if (report.relocated.some(({ from }) => containsPath(from, path))) pathStates.current.set(path, "relocated");
          }
          return { status: "completed", report };
        } catch {
          for (const path of paths) pathStates.current.set(path, "unconfirmed");
          return { status: "blocked", reason: "unconfirmed", paths };
        } finally {
          for (const path of paths) {
            if (pathStates.current.get(path) !== "protecting") continue;
            const previous = previousStates.get(path);
            if (previous) pathStates.current.set(path, previous);
            else pathStates.current.delete(path);
          }
          for (const path of [...deferredExternalLoads.current]) {
            if (affected(path)) {
              deferredExternalLoads.current.delete(path);
              if (!pathState(path)) void loadPathRef.current(path, true);
            }
          }
          setProtectionRevision(value => value + 1);
        }
      },
      async flushAll() {
        const paths = Object.entries(documentsRef.current)
          .filter(([path, document]) => !pathState(path) && document.saveState !== "saved")
          .map(([path]) => path);
        const results = await Promise.all(paths.map((path) => savePathRef.current(path, true)));
        return results.every(result => result === "saved") && Object.entries(documentsRef.current)
          .every(([path, document]) => isInvalidated(pathState(path)) || document.saveState === "saved");
      },
      hasDirtyDocuments: () => Object.values(documentsRef.current)
        .some((document) => document.saveState !== "saved"),
    };
    onSaveControllerChange?.(controller);
    return () => onSaveControllerChange?.(null);
  }, [onSaveControllerChange, pathState]);

  useEffect(() => () => {
    loadSeq.current += 1;
    for (const timer of saveTimers.current.values()) clearTimeout(timer);
  }, []);

  function changeContent(path: string, content: string) {
    if (pathState(path)) return;
    const savedContent = documentsRef.current[path]?.savedContent;
    updateDocument(path, (current) => ({
      ...current!,
      content,
      saveState: content === current!.savedContent ? "saved" : "dirty",
      error: null,
      retryCount: 0,
    }));
    if (content !== savedContent) scheduleSave(path);
  }

  return {
    documents,
    pdfSource,
    loadError,
    loading,
    loadPath,
    releasePdfSource,
    savePath: async (path: string, immediate = false) => (await savePath(path, immediate)) === "saved",
    pathState,
    changeContent,
  };
}
