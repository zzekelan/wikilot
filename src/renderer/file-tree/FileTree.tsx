import { useToast } from "../feedback";
import { captureExternalFiles } from "./external-files";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import type { WorkspaceFileEntry } from "../../shared/workspace";
import type { ProtectedFileChangeResult } from "../workspace-pane";
import { client } from "../client";
import { onWorkspaceFilesChanged } from "../client/workspace-file-events";
import { FileTreeMenu, type FileTreeMenuTarget } from "./FileTreeMenu";
import { pushEscapeLayer } from "../escape-stack";
import { recordUiGesture } from "../telemetry";
import "./FileTree.css";
import { useFileTreeMove } from "./useFileTreeMove";

type FileTreeProps = {
  /** Opaque identity of the open Workspace. */
  workspaceId: string;
  /** Currently active Workspace Tab path (highlight). */
  activePath: string | null;
  onOpenFile: (path: string) => void;
  onTrash?: (paths: string[]) => Promise<ProtectedFileChangeResult>;
  onMove?: (paths: string[], destination: string) => Promise<ProtectedFileChangeResult>;
  onRename?: (path: string, name: string) => Promise<ProtectedFileChangeResult>;
};

type DirState = {
  entries: WorkspaceFileEntry[] | null;
  loading: boolean;
  error: string | null;
  expanded: boolean;
};

/**
 * Workspace File Tree: lazy-expand directories and open readable files in the Workspace Pane.
 * Lives in the left rail Files mode; host owns all filesystem access.
 */
export function FileTree({ workspaceId, activePath, onOpenFile, onRename, onMove, onTrash }: FileTreeProps) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({
    "": { entries: null, loading: false, error: null, expanded: true },
  });

  const [menu, setMenu] = useState<FileTreeMenuTarget | null>(null);
  const [draft, setDraft] = useState<{ parent: string; path?: string; kind: "file" | "directory"; trigger: HTMLElement } | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { showToast } = useToast();
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [trashing, setTrashing] = useState(false);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const upload = useRef<AbortController | null>(null);
  useEffect(() => () => { upload.current?.abort(); }, [workspaceId]);
  useEffect(() => {
    const preventNavigation = (event: globalThis.DragEvent) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", preventNavigation);
    window.addEventListener("drop", preventNavigation);
    return () => { window.removeEventListener("dragover", preventNavigation); window.removeEventListener("drop", preventNavigation); };
  }, []);
  const draftDismissed = useRef(false);
  const focusAfterSubmit = useRef(true);
  const tree = useRef<HTMLElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const cancelDraft = useCallback(() => {
    if (submitting.current) return;
    draftDismissed.current = true;
    setDraft(null);
    draft?.trigger.focus();
  }, [draft]);
  useEffect(() => {
    if (!draft) return;
    if (!busy && focusAfterSubmit.current) input.current?.focus();
    return pushEscapeLayer(cancelDraft);
  }, [draft, cancelDraft, busy]);

  const loadDir = useCallback(
    async (path: string) => {
      setDirs((previous) => ({
        ...previous,
        [path]: {
          entries: previous[path]?.entries ?? null,
          loading: true,
          error: null,
          expanded: true,
        },
      }));
      try {
        const entries = await client.listWorkspaceFiles(workspaceId, path);
        setDirs((previous) => ({
          ...previous,
          [path]: {
            entries,
            loading: false,
            error: null,
            expanded: true,
          },
        }));
      } catch (err) {
        setDirs((previous) => ({
          ...previous,
          [path]: {
            entries: null,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
            expanded: true,
          },
        }));
      }
    },
    [workspaceId],
  );

  useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  // Reload the root and every expanded directory; collapsed subtrees stay
  // collapsed and reload lazily on their next expand.
  const refresh = useCallback(() => {
    for (const path of Object.keys(dirs)) {
      if (path === "" || dirs[path]?.expanded) void loadDir(path);
    }
  }, [dirs, loadDir]);

  function visiblePaths(parent = ""): string[] {
    return (dirs[parent]?.entries ?? []).flatMap(entry => [entry.path, ...(entry.kind === "directory" && dirs[entry.path]?.expanded ? visiblePaths(entry.path) : [])]);
  }
  const move = useFileTreeMove({ activePath, visiblePaths: visiblePaths(), disabled: busy || Boolean(draft),
    import: importDrop, move: onMove, refresh, expand: path => { if (!dirs[path]?.expanded) void loadDir(path); } });

  // Auto-refresh expanded directories when the Workspace changes on disk.
  useEffect(() => onWorkspaceFilesChanged(() => refresh()), [refresh]);

  function toggleDir(path: string) {
    const current = dirs[path];
    if (current?.expanded) {
      setDirs((previous) => ({
        ...previous,
        [path]: { ...previous[path]!, expanded: false },
      }));
      return;
    }
    if (current?.entries) {
      setDirs((previous) => ({
        ...previous,
        [path]: { ...previous[path]!, expanded: true },
      }));
      return;
    }
    void loadDir(path);
  }

  function focusEntry(path: string) {
    requestAnimationFrame(() => {
      const row = Array.from(tree.current?.querySelectorAll<HTMLButtonElement>("[data-path]") ?? [])
        .find(element => element.dataset.path === path);
      row?.focus();
      row?.scrollIntoView({ block: "nearest" });
    });
  }

  async function submitName(restoreFocus = true) {
    if (!draft || submitting.current || draftDismissed.current) return;
    focusAfterSubmit.current = restoreFocus;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      if (draft.path && name === draft.path.split("/").at(-1)) { setDraft(null); return; }
      const result = draft.path
        ? await onRename?.(draft.path, name)
        : { status: "completed" as const, report: await client.changeWorkspaceFiles(workspaceId, {
            kind: "create", parent: draft.parent, name, entryKind: draft.kind,
          }) };
      if (!result || result.status === "blocked") {
        setError(result?.reason === "conflict" ? "Rename stopped: save conflict. Your draft is preserved."
          : result?.reason === "save-failed" ? "Rename stopped: could not save your edits. Your draft is preserved."
          : "Could not confirm the file location. Check the File Tree and disk before reopening; writes remain paused.");
        return;
      }
      const { report } = result;
      recordUiGesture(draft.path ? "workspace.files.rename" : "workspace.files.create", {
        "wikilot.entry.kind": draft.kind,
        "wikilot.operation.success_count": String(report.created.length + report.relocated.length),
        "wikilot.operation.failure_count": String(report.failures.length),
      });
      if (report.failures.length) { setError(report.failures[0]!.message); return; }
      const path = report.created[0] ?? report.relocated[0]?.to;
      setDraft(null);
      if (path) {
        move.selectOnly(path);
        await loadDir(draft.parent);
        if (restoreFocus) focusEntry(path);
      }
    } catch {
      setError("Could not confirm creation. Check the File Tree before trying again.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  async function trashEntries() {
    if (!menu?.entry || submitting.current || !onTrash) return;
    const paths = move.selected.includes(menu.entry.path) ? move.selected : [menu.entry.path];
    closeMenu(); setDraft(null); setImportMessage(null);
    submitting.current = true; setBusy(true); setTrashing(true);
    try {
      const result = await onTrash(paths);
      if (result.status === "blocked") {
        setImportMessage(result.reason === "unconfirmed"
          ? "Could not confirm which items reached Trash. Check the File Tree and Trash before trying again."
          : "Move to Trash stopped: could not save all edits. Your drafts are preserved.");
        recordUiGesture("workspace.files.trash", { "wikilot.operation.blocked_reason": result.reason });
        return;
      }
      const { report } = result;
      const trashed = report.trashed ?? [];
      move.selectMany(move.selected.filter(path => !trashed.some(parent => path === parent || path.startsWith(`${parent}/`))));
      if (report.failures.length) setImportMessage(report.failures.map(failure => `${failure.source || "Selection"}: ${failure.message}`).join("\n"));
      if (trashed.length) showToast(`Moved ${trashed.length} ${trashed.length === 1 ? "item" : "items"} to Trash`);
      recordUiGesture("workspace.files.trash", { "wikilot.operation.success_count": String(trashed.length), "wikilot.operation.failure_count": String(report.failures.length) });
      refresh(); tree.current?.focus();
    } catch {
      setImportMessage("Could not confirm which items reached Trash. Check the File Tree and Trash before trying again.");
    } finally { submitting.current = false; setBusy(false); setTrashing(false); }
  }

  async function importDrop(parent: string, transfer: DataTransfer) {
    if (submitting.current) return;
    const read = captureExternalFiles(transfer);
    const cancellation = new AbortController();
    upload.current = cancellation;
    submitting.current = true; setBusy(true); setImportMessage(null); closeMenu();
    try {
      const { entries, failures } = await read(cancellation.signal);
      cancellation.signal.throwIfAborted();
      const report = entries.length ? await client.uploadWorkspaceFiles(workspaceId, parent, entries, cancellation.signal)
        : { created: [], relocated: [], failures: [] };
      report.failures.push(...failures);
      if (report.failures.length) {
        setImportMessage(`Imported ${report.created.length}; ${report.failures.length} failed.` +
          report.failures.map(failure => `\n${failure.source || "Destination"}: ${failure.message}`).join(""));
      } else {
        showToast(`Imported ${report.created.length} ${report.created.length === 1 ? "item" : "items"}`);
      }
      if (report.created.length) {
        move.selectMany(report.created); await loadDir(parent); focusEntry(report.created[0]!);
      }
      recordUiGesture("workspace.files.import", { "wikilot.entry.kind": "drop",
        "wikilot.operation.outcome": "completed", "wikilot.operation.success_count": String(report.created.length),
        "wikilot.operation.failure_count": String(report.failures.length) });
    } catch (error) {
      setImportMessage(cancellation.signal.aborted ? "Import cancelled. Check the File Tree for any items already completed before trying again."
        : `${error instanceof Error ? error.message : "Could not read the dropped files."} Check the File Tree before trying again.`);
      recordUiGesture("workspace.files.import", { "wikilot.entry.kind": "drop", "wikilot.operation.outcome": cancellation.signal.aborted ? "cancelled" : "error" });
      refresh();
    } finally { upload.current = null; submitting.current = false; setBusy(false); }
  }

  async function importEntries(kind: "file" | "directory") {
    if (!menu || submitting.current) return;
    const { parent, trigger } = menu;
    closeMenu(); setDraft(null); setImportMessage(null);
    submitting.current = true; setBusy(true);
    try {
      const report = await client.importWorkspaceFiles(workspaceId, parent, kind);
      recordUiGesture("workspace.files.import", {
        "wikilot.entry.kind": kind,
        "wikilot.operation.outcome": report === null ? "cancelled" : "completed",
        "wikilot.operation.success_count": String(report?.created.length ?? 0),
        "wikilot.operation.failure_count": String(report?.failures.length ?? 0),
      });
      if (report === null) { trigger.focus(); return; }
      setImportMessage(report.failures.length ? report.failures.map(failure => `${failure.source || "Destination"}: ${failure.message}`).join("\n") : null);
      if (report.created.length) {
        move.selectMany(report.created);
        await loadDir(parent);
        focusEntry(report.created[0]!);
      }
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "Could not import the selection. Check the File Tree before trying again.");
      recordUiGesture("workspace.files.import", { "wikilot.operation.outcome": "error", "wikilot.entry.kind": kind });
    } finally { submitting.current = false; setBusy(false); }
  }

  function renderDraft(parent: string, depth: number, path?: string) {
    if (draft?.parent !== parent || draft?.path !== path) return null;
    return <form className="file-tree-create" style={{ "--depth": depth } as CSSProperties}
      onSubmit={event => { event.preventDefault(); void submitName(); }}>
      <div className="file-tree-row">
        <span className="file-tree-chevron-spacer" />
        {draft.kind === "file" ? <File size={15} /> : <Folder size={15} />}
        <input ref={input} autoFocus aria-label={draft.path ? "Rename entry" : draft.kind === "file" ? "New file name" : "New folder name"}
          value={name} disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? "file-tree-create-error" : undefined}
          onChange={event => setName(event.target.value)}
          onBlur={() => {
            if (submitting.current || draftDismissed.current) return;
            if (!name) { draftDismissed.current = true; setDraft(null); }
            else void submitName(false);
          }}
          onKeyDown={event => {
            if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelDraft(); }
          }} />
      </div>
      {error ? <p id="file-tree-create-error" className="file-tree-status file-tree-status-error" role="alert">{error}</p> : null}
    </form>;
  }

  function renderEntries(parentPath: string, depth: number): ReactNode {
    const state = dirs[parentPath];
    if (!state) return null;
    if (state.loading && !state.entries) {
      return (
        <p className="file-tree-status" style={{ "--depth": depth } as CSSProperties}>
          Loading…
        </p>
      );
    }
    if (state.error) {
      return (
        <p
          className="file-tree-status file-tree-status-error"
          style={{ "--depth": depth } as CSSProperties}
          role="alert"
        >
          {state.error}
        </p>
      );
    }
    if (!state.entries || state.entries.length === 0) {
      return draft?.parent === parentPath ? renderDraft(parentPath, depth) : depth === 0 ? (
        <p className="file-tree-empty" data-testid="file-tree-empty">
          No files in this Workspace.
        </p>
      ) : null;
    }

    return (
      <>
      {renderDraft(parentPath, depth)}
      <ul className="file-tree-list" role={depth === 0 ? "tree" : "group"} aria-multiselectable={depth === 0 ? true : undefined}>
        {state.entries.map((entry) => {
          if (draft?.path === entry.path) return <li key={entry.path} role="treeitem">{renderDraft(parentPath, depth, entry.path)}</li>;
          if (entry.kind === "directory") {
            const open = Boolean(dirs[entry.path]?.expanded);
            return (
              <li key={entry.path} role="treeitem" aria-expanded={open} aria-selected={move.selected.includes(entry.path)}>
                <button
                  type="button"
                  className={move.selected.includes(entry.path) ? "file-tree-row file-tree-row-active" : "file-tree-row"}
                  style={{ "--depth": depth } as CSSProperties}
                  data-testid="file-tree-dir"
                  data-path={entry.path}
                  draggable={!busy && !draft && !move.moving}
                  data-drop-target={move.target === entry.path || undefined}
                  onDragStart={event => move.start(entry.path, event)}
                  onDragEnd={move.end}
                  onDragOver={event => move.over(entry.kind === "directory" ? entry.path : null, event)}
                  onDrop={event => void move.drop(entry.kind === "directory" ? entry.path : null, event)}
                  title={entry.name}
                  onContextMenu={event => {
                    event.preventDefault(); event.stopPropagation();
                    if (event.ctrlKey) { move.select(entry.path, event); closeMenu(); return; }
                    if (!submitting.current && !move.moving) setMenu({ parent: entry.path, entry, x: event.clientX, y: event.clientY, trigger: event.currentTarget });
                  }}
                  onClick={event => { if (move.select(entry.path, event)) toggleDir(entry.path); }}
                >
                  <ChevronRight
                    size={14}
                    className={
                      open
                        ? "file-tree-chevron file-tree-chevron-open"
                        : "file-tree-chevron"
                    }
                  />
                  {open ? (
                    <FolderOpen size={15} className="file-tree-icon" />
                  ) : (
                    <Folder size={15} className="file-tree-icon" />
                  )}
                  <span className="file-tree-name">{entry.name}</span>
                </button>
                {open ? renderEntries(entry.path, depth + 1) : null}
              </li>
            );
          }

          const active = move.selected.includes(entry.path);
          return (
            <li key={entry.path} role="treeitem" aria-selected={active}>
              <button
                type="button"
                className={
                  active ? "file-tree-row file-tree-row-active" : "file-tree-row"
                }
                style={{ "--depth": depth } as CSSProperties}
                data-testid="file-tree-file"
                data-path={entry.path}
                  draggable={!busy && !draft && !move.moving}
                  data-drop-target={move.target === entry.path || undefined}
                  onDragStart={event => move.start(entry.path, event)}
                  onDragEnd={move.end}
                  onDragOver={event => move.over(entry.kind === "directory" ? entry.path : null, event)}
                  onDrop={event => void move.drop(entry.kind === "directory" ? entry.path : null, event)}
                title={entry.name}
                aria-current={active ? "true" : undefined}
                onContextMenu={event => { event.preventDefault(); event.stopPropagation(); if (event.ctrlKey) { move.select(entry.path, event); closeMenu(); return; } if (!submitting.current && !move.moving) setMenu({ parent: parentPath, entry, x: event.clientX, y: event.clientY, trigger: event.currentTarget }); }}
                onClick={event => { if (move.select(entry.path, event)) onOpenFile(entry.path); }}
              >
                <span className="file-tree-chevron-spacer" />
                <File size={15} className="file-tree-icon" />
                <span className="file-tree-name">{entry.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      </>
    );
  }

  return (
    <section ref={tree} tabIndex={-1} className="file-tree" aria-label="File Tree" data-testid="file-tree"
      onContextMenu={event => {
        event.preventDefault();
        if (!submitting.current && !move.moving) setMenu({ parent: "", x: event.clientX, y: event.clientY, trigger: event.currentTarget });
      }}>
      {menu ? <FileTreeMenu target={menu} onClose={closeMenu} onTrash={() => void trashEntries()} onImport={kind => void importEntries(kind)} onRename={() => {
        if (!menu.entry) return;
        const { path, name: currentName, kind } = menu.entry;
        draftDismissed.current = false; focusAfterSubmit.current = true;
        setDraft({ parent: path.split("/").slice(0, -1).join("/"), path, kind, trigger: menu.trigger });
        setName(currentName); setError(null); closeMenu();
      }} onCreate={kind => {
        draftDismissed.current = false; focusAfterSubmit.current = true;
        setDraft({ parent: menu.parent, kind, trigger: menu.trigger });
        setName(""); setError(null); closeMenu();
        void loadDir(menu.parent);
      }} /> : null}
      {busy && !draft ? <p className="file-tree-status" role="status">{trashing ? "Moving to Trash…" : "Importing…"} {upload.current ? <button type="button" onClick={() => upload.current?.abort()}>Cancel</button> : null}</p> : null}
      {importMessage ? <p className="file-tree-status file-tree-move-report file-tree-status-error" role="alert">{importMessage}</p> : null}
      {move.message ? <p className="file-tree-status file-tree-status-error file-tree-move-report" role="alert">{move.message}</p> : null}
      <div className="file-tree-scroll" data-drop-target={move.target === "" || undefined}
        onDragOver={event => move.over("", event)} onDrop={event => void move.drop("", event)}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) move.clearHover(); }}>
        {renderEntries("", 0)}
      </div>
    </section>
  );
}
