import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, FolderOpen, FolderPlus, Loader2, MoreHorizontal, X } from "lucide-react";
import type { KnownWorkspace, WorkspaceSummary } from "../../shared/workspace";
import { pushEscapeLayer } from "../escape-stack";
import { workspaceLabels } from "./workspace-labels";
import "./WorkspaceSwitcher.css";

type WorkspaceSwitcherProps = {
  isOpen: boolean;
  workspace: WorkspaceSummary | null;
  knownWorkspaces: KnownWorkspace[];
  failedWorkspaceCwds: ReadonlySet<string>;
  locked: boolean;
  opening: boolean;
  picking: boolean;
  onBrowseWorkspace?: () => Promise<boolean>;
  onSwitchWorkspace: (cwd: string) => Promise<boolean>;
  onRequestRemoveWorkspace: (workspace: KnownWorkspace) => void;
};

export function WorkspaceSwitcher({
  isOpen, workspace, knownWorkspaces, failedWorkspaceCwds, locked, opening,
  picking,
  onBrowseWorkspace, onSwitchWorkspace, onRequestRemoveWorkspace,
}: WorkspaceSwitcherProps) {
  const [expanded, setExpanded] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [moreCwd, setMoreCwd] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 80, width: 300, maxHeight: 500 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const busy = locked || opening || picking;
  const hasChoices = knownWorkspaces.length > 0 || workspace !== null;
  const labels = workspaceLabels(knownWorkspaces.map((entry) => entry.cwd));
  const name = (cwd: string) => labels.get(cwd) ?? cwd.split("/").filter(Boolean).at(-1) ?? cwd;

  function close(restoreFocus = false) {
    setExpanded(false);
    setPickerError(null);
    setMoreCwd(null);
    if (restoreFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    close();
  }, [workspace?.cwd, isOpen]);

  async function complete(action: () => Promise<boolean>) {
    setPickerError(null);
    try {
      if (await action()) {
        close();
        requestAnimationFrame(() => triggerRef.current?.focus());
      }
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : String(error));
      setExpanded(true);
    }
  }

  useLayoutEffect(() => {
    if (!expanded) return;
    function positionPanel() {
      const rect = triggerRef.current!.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 300), window.innerWidth - 24);
      const sidebarRight = triggerRef.current!.closest("aside")!.getBoundingClientRect().right;
      const sideLeft = sidebarRight + 8;
      const fitsBeside = sideLeft + width <= window.innerWidth - 12;
      const left = fitsBeside
        ? sideLeft
        : Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const top = Math.max(12, Math.min(
        fitsBeside ? rect.top : rect.bottom + 6,
        window.innerHeight - 160,
      ));
      setPosition({ left, top, width, maxHeight: window.innerHeight - top - 12 });
    }
    positionPanel();
    const observer = new ResizeObserver(positionPanel);
    observer.observe(triggerRef.current!);
    window.addEventListener("resize", positionPanel);
    window.addEventListener("scroll", positionPanel, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("scroll", positionPanel, true);
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    panelRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const popEscape = pushEscapeLayer(() => close(true));
    function dismiss(event: Event) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) close();
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      popEscape();
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [expanded]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const items = Array.from(panelRef.current!.querySelectorAll<HTMLElement>("button:not(:disabled)"));
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  function browse() {
    if (onBrowseWorkspace) void complete(onBrowseWorkspace);
  }

  const folderAction = (
    <button type="button" className="workspace-action" data-testid="workspace-browse"
      disabled={busy} onClick={browse}>
      {picking || opening ? <Loader2 size={16} className="workspace-spinner" /> : <FolderPlus size={16} />}
      <span>{picking ? "Choosing…" : opening ? "Opening…" : "Open Folder…"}</span>
    </button>
  );

  return (
    <section aria-label="Workspace">
      <button ref={triggerRef} id="workspace-trigger" type="button"
        className={`sidebar-primary-row workspace-bar${expanded ? " workspace-bar-active" : ""}`}
        data-testid={workspace ? "workspace-status" : !hasChoices && onBrowseWorkspace ? "workspace-browse" : undefined}
        title={workspace?.cwd} aria-label={workspace ? "Change Workspace" : hasChoices ? "Choose Workspace" : "Open Folder…"}
        aria-haspopup={hasChoices ? "dialog" : undefined}
        aria-expanded={hasChoices ? expanded : undefined}
        aria-controls={expanded ? "workspace-switcher" : undefined}
        disabled={busy || (!hasChoices && !onBrowseWorkspace)}
        onClick={() => {
          if (expanded) close();
          else if (hasChoices) setExpanded(true);
          else browse();
        }}>
        {busy ? <Loader2 size={16} className="workspace-spinner" /> : <FolderOpen size={16} />}
        <span className="sidebar-primary-row-label">{workspace ? name(workspace.cwd) : picking ? "Choosing…" : opening ? "Opening…" : hasChoices ? "Choose Workspace" : "Open Folder…"}</span>
        {hasChoices ? <ChevronRight size={15} className={expanded ? "workspace-bar-chevron workspace-bar-chevron-open" : "workspace-bar-chevron"} /> : null}
      </button>
      {expanded && isOpen ? createPortal(
        <div ref={panelRef} id="workspace-switcher" className="workspace-popover" role="dialog"
          aria-label={hasChoices ? "Workspaces" : "Open a folder"} style={position} onKeyDown={navigate}>
          <div className="workspace-popover-heading">{hasChoices ? "Workspaces" : "Open a folder"}</div>
          {knownWorkspaces.length > 0 ? <ul className="workspace-known-list" data-testid="workspace-known-list">
            {knownWorkspaces.map((entry) => {
              const current = entry.cwd === workspace?.cwd;
              const failed = failedWorkspaceCwds.has(entry.cwd);
              const removeUnavailable = entry.hasActiveTurn ? "Wait for the running Turn to finish before removing this Workspace" : null;
              return <li key={entry.id}>
                <div className="workspace-known-row">
                  <button type="button" className="workspace-known-item" data-testid="workspace-known-item"
                    data-workspace-cwd={entry.cwd} title={entry.cwd} aria-current={current ? "true" : undefined}
                    disabled={busy} onClick={() => current ? close(true) : void complete(() => onSwitchWorkspace(entry.cwd))}>
                    <FolderOpen size={16} aria-hidden="true" />
                    <span className="workspace-known-copy">
                      <span className="workspace-known-title">
                        <span className="workspace-known-name">{name(entry.cwd)}</span>
                        {current ? <Check size={13} aria-label="Current workspace" /> : null}
                        {entry.hasActiveTurn ? <Loader2 size={13} className="workspace-spinner" aria-label="Running in background" /> : null}
                      </span>
                      <span className={failed ? "workspace-known-error" : "workspace-known-path"}>
                        {failed ? "Unavailable · select to retry" : entry.cwd.slice(0, entry.cwd.lastIndexOf("/")) || "/"}
                      </span>
                    </span>
                  </button>
                  <button type="button" className="icon-btn workspace-more" aria-label={`Workspace options: ${name(entry.cwd)}`}
                    aria-expanded={moreCwd === entry.cwd} disabled={busy}
                    onClick={() => setMoreCwd(moreCwd === entry.cwd ? null : entry.cwd)}><MoreHorizontal size={16} /></button>
                </div>
                {moreCwd === entry.cwd ? <div className="workspace-remove-action">
                  <button type="button" className="workspace-action" data-testid="workspace-remove"
                    aria-label={`Remove Workspace: ${name(entry.cwd)}`} title={removeUnavailable ?? "The folder and its files stay on disk"}
                    disabled={busy || !!removeUnavailable}
                    onClick={() => { close(true); onRequestRemoveWorkspace(entry); }}>Remove from recent list</button>
                  {removeUnavailable ? <p className="workspace-remove-hint">{removeUnavailable}</p> : null}
                </div> : null}
              </li>;
            })}
          </ul> : null}
          {pickerError ? <div className="workspace-picker-error" role="alert" data-testid="workspace-picker-error">
            <span>{pickerError}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss folder error"
              onClick={() => close(true)}><X size={14} aria-hidden="true" /></button>
          </div> : null}
          {onBrowseWorkspace ? <div className="workspace-popover-actions">{folderAction}</div> : null}
        </div>, document.body,
      ) : null}
    </section>
  );
}
