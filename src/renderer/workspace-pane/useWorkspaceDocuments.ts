import { useCallback, useEffect, useRef, useState } from "react";
import type { MarkdownDocumentSnapshot, WorkspacePdfSource } from "../../shared/workspace";
import { client } from "../client";
import { onWorkspaceFilesChanged } from "../client/workspace-file-events";
import { recordUiGesture } from "../telemetry";

export type WorkspacePaneSaveController = {
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
  connectionRevision?: number;
  onSaveControllerChange?: (controller: WorkspacePaneSaveController | null) => void;
};

export function useWorkspaceDocuments({
  workspaceId,
  activePath,
  connectionRevision = 0,
  onSaveControllerChange,
}: UseWorkspaceDocumentsOptions) {
  const [documents, setDocuments] = useState<Record<string, MarkdownDocument>>({});
  const documentsRef = useRef(documents);
  const [pdfSource, setPdfSource] = useState<WorkspacePdfSource | null>(null);
  const [loadError, setLoadError] = useState<DocumentLoadError | null>(null);
  const [loading, setLoading] = useState(false);
  const loadSeq = useRef(0);
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const inFlightSaves = useRef(new Map<string, Promise<boolean>>());
  const deferredExternalLoads = useRef(new Set<string>());
  const savePathRef = useRef<(path: string, immediate?: boolean) => Promise<boolean>>(async () => true);
  const loadPathRef = useRef<(path: string, external?: boolean) => Promise<void>>(async () => {});

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
    const current = saveTimers.current.get(path);
    if (current) clearTimeout(current);
    saveTimers.current.set(path, setTimeout(() => {
      saveTimers.current.delete(path);
      void savePathRef.current(path);
    }, delay));
  }, []);

  const savePath = useCallback(async (path: string, immediate = false): Promise<boolean> => {
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
      return documentsRef.current[path]?.saveState === "dirty"
        ? savePathRef.current(path, immediate)
        : saved;
    }
    const document = documentsRef.current[path];
    if (!document) return true;
    if (document.snapshot.status !== "ready") return document.saveState === "saved";
    if (document.content === document.savedContent && document.saveState !== "failed") return true;
    const version = document.snapshot.version;
    const content = document.content;
    updateDocument(path, (current) => ({ ...current!, saveState: "saving", error: null }));
    const operation = (async () => {
      try {
        const result = await client.saveMarkdownDocument(workspaceId, path, version, content);
        if (result.outcome === "conflict") {
          recordUiGesture("markdown.save", { "wikilot.markdown.outcome": "conflict" });
          if (result.snapshot.status === "ready") {
            updateDocument(path, (current) => documentFromSnapshot(result.snapshot, current, true));
            return true;
          }
          updateDocument(path, (current) => ({
            ...documentFromSnapshot(result.snapshot, current, true),
            saveState: "failed",
            error: "The disk file is not ready for saving.",
          }));
          return false;
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
        return !editedDuringSave;
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
        return false;
      } finally {
        inFlightSaves.current.delete(path);
        if (deferredExternalLoads.current.delete(path)) {
          void loadPathRef.current(path, true);
        }
      }
    })();
    inFlightSaves.current.set(path, operation);
    return operation;
  }, [scheduleSave, updateDocument, workspaceId]);
  savePathRef.current = savePath;

  const loadPath = useCallback(async (path: string, external = false) => {
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
        if (seq === loadSeq.current) setPdfSource(next);
        else releasePdfSource(next.sourceId);
        return;
      }
      const snapshot = await client.openMarkdownDocument(workspaceId, path);
      if (!external && seq !== loadSeq.current) return;
      const previous = documentsRef.current[path];
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
  }, [releasePdfSource, updateDocument, workspaceId]);
  loadPathRef.current = loadPath;

  useEffect(() => {
    if (!activePath) {
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
  }, [activePath, loadPath, connectionRevision]);

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
      async flushAll() {
        const paths = Object.entries(documentsRef.current)
          .filter(([, document]) => document.saveState !== "saved")
          .map(([path]) => path);
        const results = await Promise.all(paths.map((path) => savePathRef.current(path, true)));
        return results.every(Boolean) && Object.values(documentsRef.current)
          .every((document) => document.saveState === "saved");
      },
      hasDirtyDocuments: () => Object.values(documentsRef.current)
        .some((document) => document.saveState !== "saved"),
    };
    onSaveControllerChange?.(controller);
    return () => onSaveControllerChange?.(null);
  }, [onSaveControllerChange]);

  useEffect(() => () => {
    loadSeq.current += 1;
    for (const timer of saveTimers.current.values()) clearTimeout(timer);
  }, []);

  function changeContent(path: string, content: string) {
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
    savePath,
    changeContent,
  };
}
