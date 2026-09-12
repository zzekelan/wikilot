import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import type { WorkspaceFileEntry } from "../../shared/workspace";
import { client } from "../client";
import { onWorkspaceFilesChanged } from "../client/workspace-file-events";
import "./FileTree.css";

type FileTreeProps = {
  /** Opaque identity of the open Workspace. */
  workspaceId: string;
  /** Currently active Workspace Tab path (highlight). */
  activePath: string | null;
  onOpenFile: (path: string) => void;
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
export function FileTree({ workspaceId, activePath, onOpenFile }: FileTreeProps) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({
    "": { entries: null, loading: false, error: null, expanded: true },
  });

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
      return depth === 0 ? (
        <p className="file-tree-empty" data-testid="file-tree-empty">
          No files in this Workspace.
        </p>
      ) : null;
    }

    return (
      <ul className="file-tree-list" role={depth === 0 ? "tree" : "group"}>
        {state.entries.map((entry) => {
          if (entry.kind === "directory") {
            const open = Boolean(dirs[entry.path]?.expanded);
            return (
              <li key={entry.path} role="treeitem" aria-expanded={open}>
                <button
                  type="button"
                  className="file-tree-row"
                  style={{ "--depth": depth } as CSSProperties}
                  data-testid="file-tree-dir"
                  data-path={entry.path}
                  title={entry.name}
                  onClick={() => toggleDir(entry.path)}
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

          const active = entry.path === activePath;
          return (
            <li key={entry.path} role="treeitem">
              <button
                type="button"
                className={
                  active ? "file-tree-row file-tree-row-active" : "file-tree-row"
                }
                style={{ "--depth": depth } as CSSProperties}
                data-testid="file-tree-file"
                data-path={entry.path}
                title={entry.name}
                aria-current={active ? "true" : undefined}
                onClick={() => onOpenFile(entry.path)}
              >
                <span className="file-tree-chevron-spacer" />
                <File size={15} className="file-tree-icon" />
                <span className="file-tree-name">{entry.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="file-tree" aria-label="File Tree" data-testid="file-tree">
      <div className="file-tree-scroll">{renderEntries("", 0)}</div>
    </section>
  );
}
