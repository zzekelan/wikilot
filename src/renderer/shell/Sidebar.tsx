import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import {
  AlertCircle,
  Loader2,
  Network,
  PanelLeft,
  PanelLeftClose,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import type {
  KnownWorkspace,
  SessionListItem,
  WorkspaceSummary,
  WorkspaceGraphSnapshot,
} from "../../shared/workspace";
import { FileTree } from "../file-tree";
import type { SelectedSession } from "./DesktopShell";
import { SettingsPanel, type SettingsSection } from "./SettingsPanel";
import "./Sidebar.css";
import { pushEscapeLayer } from "../escape-stack";
import { formatRelativeTime } from "./timestamps";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

export type LeftRailMode = "sessions" | "files";

/** Workspace display name: the folder's basename, falling back to the path. */
export function workspaceName(cwd: string): string {
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd;
}

type SidebarProps = {
  applicationActions?: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  toggleButtonRef: Ref<HTMLButtonElement>;
  workspace: WorkspaceSummary | null;
  /** Renderer-selected Session, if any (opening a Workspace clears it). */
  selectedSession: SelectedSession | null;
  sessions: SessionListItem[];
  locked: boolean;
  opening: boolean;
  /** True while the native directory chooser is open. */
  picking: boolean;
  /** Launch the Host's native directory chooser when available. */
  onBrowseWorkspace?: () => Promise<boolean>;
  /** Durable Known Workspaces (recent successful use first). */
  knownWorkspaces: KnownWorkspace[];
  /** Known Workspaces whose last selection failed (marked for this run). */
  failedWorkspaceCwds: ReadonlySet<string>;
  /** Switch to a Known Workspace (validates it lazily). */
  onSwitchWorkspace: (cwd: string) => Promise<boolean>;
  /** Opens the removal confirmation; the shell owns the actual removal. */
  onRequestRemoveWorkspace: (workspace: KnownWorkspace) => void;
  onCreateSession: () => void;
  graphActive: boolean;
  graphStatus: WorkspaceGraphSnapshot["status"];
  onOpenGraph: () => void;
  onOpenSession: (sessionId: string) => void;
  /** Opens the delete confirmation; the shell owns the actual deletion. */
  onRequestDelete: (sessionId: string) => void;
  /** Sessions whose latest Turn failed (live from error Deltas). */
  failedSessionIds: ReadonlySet<string>;
  settingsOpen: boolean;
  settingsSection?: SettingsSection;
  onSettingsOpenChange: (open: boolean) => void;
  /** Sessions ↔ Files segmented control (shared Workspace selector above). */
  leftMode: LeftRailMode;
  onLeftModeChange: (mode: LeftRailMode) => void;
  activePath: string | null;
  onOpenFile: (path: string) => void;
};

type SidebarPrimaryRowProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> & {
  icon: ReactNode;
  label: string;
  trailing?: ReactNode;
};

function SidebarPrimaryRow({
  icon,
  label,
  trailing,
  className = "",
  ...props
}: SidebarPrimaryRowProps) {
  return (
    <button
      {...props}
      type="button"
      className={`sidebar-primary-row ${className}`.trim()}
    >
      {icon}
      <span className="sidebar-primary-row-label">{label}</span>
      {trailing}
    </button>
  );
}

export function sessionTitle(item: SessionListItem): string {
  if (item.name?.trim()) return item.name.trim();
  if (item.firstMessage && item.firstMessage !== "(no messages)") {
    return item.firstMessage;
  }
  return "Untitled Session";
}

/** Why a Session cannot be deleted right now, or null when it can. */
function deleteUnavailableReason(
  item: SessionListItem,
  active: boolean,
): string | null {
  if (active) return "The selected Session can't be deleted";
  if (
    item.runtimeStatus === "starting" ||
    item.runtimeStatus === "running" ||
    item.runtimeStatus === "stopping"
  ) {
    return "Stop the Run before deleting this Session";
  }
  return null;
}

/** Keep the fixed-position context menu inside the viewport (neo-coworker). */
function getContextMenuStyle(position: { x: number; y: number }) {
  if (typeof window === "undefined") {
    return { left: position.x, top: position.y };
  }
  return {
    left: Math.min(position.x, window.innerWidth - 244),
    top: Math.min(position.y, window.innerHeight - 132),
  };
}

export function Sidebar({
  applicationActions,
  isOpen,
  onToggle,
  toggleButtonRef,
  workspace,
  selectedSession,
  sessions,
  locked,
  opening,
  picking,
  onBrowseWorkspace,
  knownWorkspaces,
  failedWorkspaceCwds,
  onSwitchWorkspace,
  onRequestRemoveWorkspace,
  onCreateSession,
  graphActive,
  graphStatus,
  onOpenGraph,
  onOpenSession,
  onRequestDelete,
  failedSessionIds,
  settingsOpen,
  settingsSection,
  onSettingsOpenChange,
  leftMode,
  onLeftModeChange,
  activePath,
  onOpenFile,
}: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<{
    sessionId: string;
    x: number;
    y: number;
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    return pushEscapeLayer(() => onSettingsOpenChange(false));
  }, [onSettingsOpenChange, settingsOpen]);

  // Close the Session context menu on outside mousedown. Escape participates
  // in the shared LIFO stack and returns focus to the row that opened it.
  useEffect(() => {
    if (!contextMenu) return;
    const triggerSessionId = contextMenu.sessionId;

    function closeContextMenu() {
      setContextMenu(null);
      document
        .querySelector<HTMLElement>(
          `[data-session-id="${CSS.escape(triggerSessionId)}"]`,
        )
        ?.focus();
    }

    function handlePointerDown(event: MouseEvent) {
      if (!contextMenuRef.current?.contains(event.target as Node)) {
        setContextMenu(null);
      }
    }

    const popEscape = pushEscapeLayer(closeContextMenu);
    window.addEventListener("mousedown", handlePointerDown);
    return () => {
      popEscape();
      window.removeEventListener("mousedown", handlePointerDown);
    };
  }, [contextMenu]);

  // Opening the menu moves focus to its first available item (menu semantics).
  useEffect(() => {
    if (!contextMenu) return;
    contextMenuRef.current
      ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
  }, [contextMenu]);

  // Arrow/Home/End navigation between menu items (roving focus).
  function onContextMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const menu = contextMenuRef.current;
    if (!menu) return;
    const items = Array.from(
      menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      items[(index + 1) % items.length]!.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]!.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]!.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]!.focus();
    }
  }

  const contextSession = sessions.find((item) => item.id === contextMenu?.sessionId);
  /** Why deletion is unavailable right now, if it is. */
  const contextDeleteUnavailable =
    contextSession !== undefined && contextMenu !== null
      ? deleteUnavailableReason(
          contextSession,
          contextMenu.sessionId === selectedSession?.id,
        )
      : null;

  function onSessionContextMenu(
    event: ReactMouseEvent<HTMLButtonElement>,
    sessionId: string,
  ) {
    event.preventDefault();
    setContextMenu({ sessionId, x: event.clientX, y: event.clientY });
  }

  return (
    <div
      className={`sidebar-shell${isOpen ? "" : " sidebar-shell-collapsed"}${settingsOpen ? " sidebar-shell-popover-open" : ""}`}
    >
      <aside className="sidebar" aria-label="Workspace rail">
        <div className="sidebar-header">
          <span className="sidebar-brand">Wikilot</span>
          <button
            ref={toggleButtonRef}
            type="button"
            className="icon-btn"
            onClick={onToggle}
            title={isOpen ? "Close Sidebar" : "Open Sidebar"}
            aria-label={isOpen ? "Close Sidebar" : "Open Sidebar"}
            aria-expanded={isOpen}
          >
            {isOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
          </button>
        </div>

        <div className="sidebar-body">
          <div className="workspace-area">
          <WorkspaceSwitcher
            isOpen={!settingsOpen}
            workspace={workspace}
            knownWorkspaces={knownWorkspaces}
            failedWorkspaceCwds={failedWorkspaceCwds}
            locked={locked}
            opening={opening}
            picking={picking}
            onBrowseWorkspace={onBrowseWorkspace}
            onSwitchWorkspace={onSwitchWorkspace}
            onRequestRemoveWorkspace={onRequestRemoveWorkspace}
          />
          {workspace ? (
            <SidebarPrimaryRow
              className="session-create"
              data-testid="session-new"
              title="New Session (⌘N)"
              aria-label="New Session"
              disabled={locked}
              icon={<Plus size={16} aria-hidden="true" />}
              label="New Session"
              onClick={onCreateSession}
            />
          ) : null}
          {workspace ? (
            <SidebarPrimaryRow
              className={
                graphActive
                  ? "workspace-graph-open workspace-graph-open-active"
                  : "workspace-graph-open"
              }
              data-graph-status={graphStatus}
              aria-current={graphActive ? "page" : undefined}
              aria-label="Open Graph"
              title="Open Graph"
              icon={<Network size={16} aria-hidden="true" />}
              label="Graph"
              onClick={onOpenGraph}
            />
          ) : null}
          </div>

          {workspace ? (
            <>
              <div
                className="sidebar-segmented"
                role="tablist"
                aria-label="Left rail mode"
                data-testid="left-rail-mode"
              >
                <button
                  type="button"
                  role="tab"
                  className={
                    leftMode === "sessions"
                      ? "sidebar-segmented-btn sidebar-segmented-btn-on"
                      : "sidebar-segmented-btn"
                  }
                  aria-selected={leftMode === "sessions"}
                  data-testid="left-mode-sessions"
                  onClick={() => onLeftModeChange("sessions")}
                >
                  Sessions
                </button>
                <button
                  type="button"
                  role="tab"
                  className={
                    leftMode === "files"
                      ? "sidebar-segmented-btn sidebar-segmented-btn-on"
                      : "sidebar-segmented-btn"
                  }
                  aria-selected={leftMode === "files"}
                  data-testid="left-mode-files"
                  onClick={() => onLeftModeChange("files")}
                >
                  Files
                </button>
              </div>

              <section
                className="session-list"
                aria-label="Sessions"
                hidden={leftMode !== "sessions"}
              >
                  <div className="session-list-scroll">
                    {sessions.length === 0 ? (
                      <p
                        className="session-list-empty"
                        data-testid="session-list-empty"
                      >
                        No Sessions yet.
                      </p>
                    ) : (
                      <ul className="session-list-items" data-testid="session-list">
                        {sessions.map((item) => {
                                const active = item.id === selectedSession?.id;
                                // Preparing or disposing a Runtime does not execute an agent.
                                const sessionRunning = item.runtimeStatus === "running";
                                const failedBadge =
                                  !sessionRunning && failedSessionIds.has(item.id);
                                return (
                                  <li key={item.id} className="session-row">
                                    <button
                                      type="button"
                                      className={
                                        active
                                          ? "session-list-item session-list-item-active"
                                          : "session-list-item"
                                      }
                                      data-testid="session-list-item"
                                      data-session-id={item.id}
                                      disabled={locked}
                                      aria-current={active ? "true" : undefined}
                                      onClick={() => onOpenSession(item.id)}
                                      onContextMenu={(event) =>
                                        onSessionContextMenu(event, item.id)
                                      }
                                      onKeyDown={(event) => {
                                        // Keyboard equivalent of right-click.
                                        if (
                                          event.key === "ContextMenu" ||
                                          (event.shiftKey && event.key === "F10")
                                        ) {
                                          event.preventDefault();
                                          const rect =
                                            event.currentTarget.getBoundingClientRect();
                                          setContextMenu({
                                            sessionId: item.id,
                                            x: rect.left + rect.width / 2,
                                            y: rect.top,
                                          });
                                        }
                                      }}
                                    >
                                      <span className="session-list-item-title">
                                        {sessionTitle(item)}
                                      </span>
                                      {failedBadge ? (
                                        <span className="session-badge session-badge-failed" title="Failed">
                                          <AlertCircle size={13} />
                                        </span>
                                      ) : null}
                                      {sessionRunning ? (
                                        <span
                                          className="session-badge session-badge-running"
                                          role="img"
                                          aria-label="Running"
                                          title="Running"
                                        >
                                          <Loader2 size={14} strokeWidth={1.75} aria-hidden="true" />
                                        </span>
                                      ) : (
                                        <span
                                          className="session-list-item-meta"
                                          title={new Date(
                                            item.created,
                                          ).toLocaleString()}
                                        >
                                          {formatRelativeTime(
                                            new Date(item.created).getTime(),
                                          )}
                                        </span>
                                      )}
                                    </button>
                                    {/* Idle rows reveal delete on hover/focus; running
                                        rows keep their status visible. Disabled idle
                                        actions expose their reason on the wrapper. */}
                                    {!sessionRunning && (() => {
                                      const deleteUnavailable =
                                        deleteUnavailableReason(item, active);
                                      return (
                                        <span
                                          className="session-delete"
                                          title={
                                            deleteUnavailable ?? "Delete Session"
                                          }
                                        >
                                          <button
                                            type="button"
                                            className="icon-btn"
                                            data-testid="session-delete"
                                            aria-label={
                                              deleteUnavailable ??
                                              `Delete Session: ${sessionTitle(item)}`
                                            }
                                            disabled={
                                              locked || deleteUnavailable !== null
                                            }
                                            onClick={() =>
                                              onRequestDelete(item.id)
                                            }
                                          >
                                            <Trash2 size={14} aria-hidden="true" />
                                          </button>
                                        </span>
                                      );
                                    })()}
                                  </li>
                                );
                        })}
                      </ul>
                    )}
                  </div>
                </section>
              {/* The File Tree stays mounted across Sessions ↔ Files switches
                  so directory expansion state survives; only visibility toggles. */}
              <div
                className={
                  leftMode === "files"
                    ? "file-tree-mount"
                    : "file-tree-mount-hidden"
                }
              >
                <FileTree
                  key={workspace.id}
                  workspaceId={workspace.id}
                  activePath={activePath}
                  onOpenFile={onOpenFile}
                />
              </div>
            </>
          ) : null}
        </div>

        <div className="sidebar-footer">
          {/* Settings mount: popover anchors above the footer row (neo-coworker). */}
          <div className="sidebar-settings-mount">
            <SettingsPanel
              open={settingsOpen}
              initialSection={settingsSection}
              onClose={() => onSettingsOpenChange(false)}
            />
            <div className="sidebar-gear-row">
              <button
                type="button"
                className={
                  settingsOpen
                    ? "sidebar-settings-btn sidebar-settings-btn-active"
                    : "sidebar-settings-btn"
                }
                onClick={() => onSettingsOpenChange(!settingsOpen)}
                title="Settings"
                aria-label="Settings"
                aria-expanded={settingsOpen}
              >
                <Settings2 size={16} />
                <span>Settings</span>
              </button>
              {applicationActions ? <div className="sidebar-application-actions" role="group" aria-label="Application">{applicationActions}</div> : null}
            </div>
          </div>
        </div>

        {contextMenu ? (
          <div
            ref={contextMenuRef}
            className="sidebar-context-menu"
            style={getContextMenuStyle(contextMenu)}
            role="menu"
            aria-label="Session actions"
            onKeyDown={onContextMenuKeyDown}
          >
            <button
              type="button"
              role="menuitem"
              className="sidebar-context-item"
              disabled={contextDeleteUnavailable !== null}
              title={contextDeleteUnavailable ?? undefined}
              onClick={() => {
                setContextMenu(null);
                if (contextDeleteUnavailable === null) {
                  onRequestDelete(contextMenu.sessionId);
                }
              }}
            >
              Delete Session
            </button>
            {/* The disabled menuitem shows no tooltip in Chromium, so the
                reason also appears as a visible line below it. */}
            {contextDeleteUnavailable !== null ? (
              <p className="sidebar-context-reason">{contextDeleteUnavailable}</p>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}
