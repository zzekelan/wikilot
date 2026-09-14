import { PROMPT_COMMANDS } from "../../shared/session";
import type { PendingPrompt } from "./PromptCommandBadge";
import { sameContextClip, type ContextClip } from "../../shared/session";
import {
  MAX_CONTEXT_CLIPS,
  MAX_CONTEXT_CLIP_CHARACTERS,
  MAX_CONTEXT_CLIP_TOTAL_CHARACTERS,
} from "../../shared/session";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Command, Moon, PanelRight, Sun, X } from "lucide-react";
import type { TimelineItem } from "../../shared/timeline";
import type {
  KnownWorkspace,
  MarkdownDocumentSnapshot,
  KnownWorkspaceListResponse,
  SessionConfiguration,
  SessionConfigurationUpdate,
  SessionListItem,
  SessionSelectionToken,
  SessionSkill,
  WorkspaceSummary,
  WorkspaceLinkIndexSnapshot,
  WorkspaceLinkResolveRequest,
  WorkspaceLinkTarget,
  WorkspacePdfSource,
  WorkspaceGraphSnapshot,
} from "../../shared/workspace";
import type { ProjectTrustRequest } from "../../shared/workspace";
import {
  isWorkspaceFilesChangedEvent,
  isWorkspaceLinkIndexChangedEvent,
  openWorkspaceGraphTab,
  setWorkspacePaneReadingMode,
  WORKSPACE_GRAPH_TAB_ID,
} from "../../shared/workspace";
import { client } from "../client";
import { emitWorkspaceFilesChanged } from "../client/workspace-file-events";
import {
  initialWorkspacePaneState,
  closeWorkspacePaneTab,
  openWorkspacePaneTab,
  WorkspacePane,
  type WorkspacePaneRestoreResult,
  type WorkspacePaneSaveController,
  type WorkspacePaneState,
} from "../workspace-pane";
import { recordUiGesture } from "../telemetry";
import { Composer } from "./Composer";
import { GettingStartedSteps } from "./GettingStartedSteps";
import type { SettingsSection } from "./SettingsPanel";
import { ColumnResizer } from "./ColumnResizer";
import "./DesktopShell.css";
import { Modal } from "./overlay";
import {
  Sidebar,
  sessionTitle,
  workspaceName,
  type LeftRailMode,
} from "./Sidebar";
import { Timeline } from "./Timeline";
import { WideSession } from "./WideSession";
import { useShortcuts } from "../shortcuts";
import { useTheme } from "./theme";
import { useToast } from "../feedback";
import {
  applyTimelineDelta,
  applyTimelineSnapshot,
  initialTimelineStream,
  type TimelineStreamState,
} from "./timeline-stream";

/** The renderer-selected Session (Selected Session is renderer state). */
export type SelectedSession = {
  id: string;
  action: "create" | "open";
};

type PersistedSelection = {
  workspace: WorkspaceSummary;
  selectedSession: SelectedSession;
};

const SELECTION_STORAGE_KEY = "wikilot.selected-session";
const SELECTION_CLIENT_STORAGE_KEY = "wikilot.selection-client";
const SELECTION_SEQUENCE_STORAGE_KEY = "wikilot.selection-sequence";
const DEFAULT_SIDEBAR_WIDTH = 256;
const DEFAULT_PANE_WIDTH = 640;
const PANE_MIN_WIDTH = 320;
const MAIN_MIN_WIDTH = 320;
const COLLAPSED_SIDEBAR_WIDTH = 56;
/** Snapshot writes settle after a short quiet period of Pane navigation. */
const PANE_PERSIST_DEBOUNCE_MS = 400;
let fallbackSelectionSequence = 0;
/** Module-scoped in-flight Pane restore request, shared across StrictMode
   remounts so the one-time corruption notice reaches the live Shell. */
let paneRestoreInFlight: {
  workspaceId: string;
  promise: Promise<WorkspacePaneRestoreResult>;
} | null = null;

function timelinePreview(items: readonly TimelineItem[], pendingPrompt: PendingPrompt | null): string {
  if (pendingPrompt) return typeof pendingPrompt === "string" ? pendingPrompt : PROMPT_COMMANDS[pendingPrompt.command].title;
  const item = items.at(-1);
  if (!item) return "No Timeline entries";
  if (item.kind === "user") {
    return (item.command ? PROMPT_COMMANDS[item.command].title : item.text.trim()) || `${item.clips?.length ?? 0} Context Clips`;
  }
  if (item.kind === "error") return item.message;
  for (let index = item.parts.length - 1; index >= 0; index -= 1) {
    const part = item.parts[index];
    if (part.kind === "tool") {
      return part.progress?.trim() || part.toolName;
    }
    if (part.text.trim()) return part.text.trim();
  }
  return "Timeline activity";
}

function readSelectionClientId(): string {
  try {
    const existing = sessionStorage.getItem(SELECTION_CLIENT_STORAGE_KEY);
    if (existing) return existing;
    const created = `renderer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(SELECTION_CLIENT_STORAGE_KEY, created);
    return created;
  } catch {
    return "renderer";
  }
}

function nextSelectionToken(clientId: string): SessionSelectionToken {
  try {
    const stored = Number.parseInt(
      sessionStorage.getItem(SELECTION_SEQUENCE_STORAGE_KEY) ?? "0",
      10,
    );
    const sequence = Number.isSafeInteger(stored) && stored >= 0 ? stored + 1 : 1;
    sessionStorage.setItem(SELECTION_SEQUENCE_STORAGE_KEY, String(sequence));
    return { clientId, sequence };
  } catch {
    fallbackSelectionSequence = Math.max(
      Date.now(),
      fallbackSelectionSequence + 1,
    );
    return { clientId, sequence: fallbackSelectionSequence };
  }
}

function clampPaneWidth(
  width: number,
  viewportWidth: number,
  sidebarWidth: number,
  sidebarOpen: boolean,
): number {
  const availableWidth =
    viewportWidth - (sidebarOpen ? sidebarWidth : COLLAPSED_SIDEBAR_WIDTH) - MAIN_MIN_WIDTH;
  return Math.min(
    Math.max(PANE_MIN_WIDTH, availableWidth),
    Math.max(PANE_MIN_WIDTH, width),
  );
}

function readPersistedSelection(): PersistedSelection | null {
  try {
    const raw = sessionStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedSelection>;
    if (
      typeof value.workspace?.id !== "string" ||
      typeof value.workspace.cwd !== "string" ||
      typeof value.selectedSession?.id !== "string" ||
      (value.selectedSession.action !== "create" &&
        value.selectedSession.action !== "open")
    ) {
      return null;
    }
    return value as PersistedSelection;
  } catch {
    return null;
  }
}

/**
 * Desktop Shell: collapsible Sidebar (Workspace, Sessions ↔ File Tree,
 * Settings), main Timeline/Composer, and a persistent Workspace Pane.
 */
export function DesktopShell() {
  const { theme, toggleTheme } = useTheme();
  const { registerShortcut, paletteOpen, togglePalette } = useShortcuts();
  const { showToast } = useToast();
  const restoredSelection = useRef(readPersistedSelection()).current;
  // Persisted ids are navigation hints; the Host must open them before use.
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [selectedSession, setSelectedSession] = useState<SelectedSession | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [sessionConfiguration, setSessionConfiguration] =
    useState<SessionConfiguration>({});
  const [sessionConfigurationStatus, setSessionConfigurationStatus] = useState<
    "applied" | "pending"
  >("applied");
  /** Sessions whose latest Turn failed, tracked live from error Deltas so the
     list badge does not depend on which Session is selected. */
  const [failedSessionIds, setFailedSessionIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [picking, setPicking] = useState(false);
  const [sessionSwitching, setSessionSwitching] = useState(false);
  const [timelineStream, setTimelineStream] = useState<TimelineStreamState>(initialTimelineStream);
  const [sessionRecoveryError, setSessionRecoveryError] = useState<string | null>(null);
  const [connectionRecovering, setConnectionRecovering] = useState(false);
  const [sessionConnectionRevision, setSessionConnectionRevision] = useState(0);
  const [configurationSessionKey, setConfigurationSessionKey] = useState<string | null>(null);
  const [sidebarPreference, setSidebarPreference] = useState(true);
  const [compactSidebarOpen, setCompactSidebarOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  const compactLayout = viewportWidth < 1000;
  const sidebarOpen = compactLayout ? compactSidebarOpen : sidebarPreference;
  const [wideContentInset, setWideContentInset] = useState(0);
  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const sidebarOpenRef = useRef<HTMLButtonElement>(null);
  const sidebarFocusPending = useRef(false);

  function toggleSidebar(open: boolean) {
    sidebarFocusPending.current = true;
    if (compactLayout) setCompactSidebarOpen(open);
    else setSidebarPreference(open);
  }

  useEffect(() => {
    if (!sidebarFocusPending.current) return;
    sidebarFocusPending.current = false;
    const button = sidebarOpen ? sidebarCloseRef.current : sidebarOpenRef.current;
    button?.focus({ preventScroll: true });
  }, [sidebarOpen]);

  const [resizing, setResizing] = useState(false);
  // Settings popover state lives here so the shell owns overlay lifetime.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [hasAvailableModels, setHasAvailableModels] = useState<boolean | null>(null);
  const [unsupportedFile, setUnsupportedFile] = useState<string | null>(null);

  const onSettingsOpenChange = useCallback((open: boolean) => {
    setSettingsOpen(open);
    if (open) setSettingsSection("general");
    else {
      setCatalogRevision((revision) => revision + 1);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".composer-input:not([disabled])")?.focus());
    }
  }, []);

  function connectModel() {
    recordUiGesture("onboarding.connect-model", { "wikilot.gesture": "onboarding.connect-model" });
    setSettingsSection("providers");
    setSettingsOpen(true);
  }
  const [leftMode, setLeftMode] = useState<LeftRailMode>("sessions");
  const [wideTimelineOpen, setWideTimelineOpen] = useState(false);
  const [wideDrawerHeight, setWideDrawerHeight] = useState(52);
  const [workspaceTabs, setWorkspaceTabs] = useState<WorkspacePaneState>(
    initialWorkspacePaneState,
  );
  const [workspaceGraphStatus, setWorkspaceGraphStatus] = useState<
    WorkspaceGraphSnapshot["status"]
  >("building");
  const [linkRevisionState, setLinkRevisionState] = useState<{
    workspaceId: string | null;
    revision: number;
  }>({ workspaceId: null, revision: 0 });
  const linkRevisionRef = useRef(linkRevisionState);
  const [eventStreamRevision, setEventStreamRevision] = useState(0);
  const [linkIndex, setLinkIndex] = useState<WorkspaceLinkIndexSnapshot>({ status: "building" });
  const [linkIndexWorkspaceId, setLinkIndexWorkspaceId] = useState<string | null>(null);
  const [linkNavigation, setLinkNavigation] = useState<Extract<
    WorkspaceLinkTarget,
    { status: "resolved" }
  > | null>(null);
  const [contextClipNavigation, setContextClipNavigation] = useState<{
    id: number;
    clip: ContextClip;
    pdfSource?: WorkspacePdfSource;
  } | null>(null);
  const contextClipNavigationId = useRef(0);
  /** True while the Workspace's Pane snapshot is restoring (skeleton shown). */
  const [paneRestoring, setPaneRestoring] = useState(false);
  /** One-time banner after invalid stored Pane items were dropped. */
  const [paneRestoreReport, setPaneRestoreReport] = useState<{
    skipped: number;
    warning?: string;
  } | null>(null);
  /** Pending debounced Pane snapshot write for the current Workspace. */
  const panePersistRef = useRef<{
    workspaceId: string;
    state: WorkspacePaneState;
    timer: ReturnType<typeof setTimeout> | null;
  } | null>(null);
  const paneSaveControllerRef = useRef<WorkspacePaneSaveController | null>(null);
  const handlePaneSaveControllerChange = useCallback(
    (controller: WorkspacePaneSaveController | null) => {
      paneSaveControllerRef.current = controller;
    },
    [],
  );
  /** Workspace whose restored Pane state may be persisted again. */
  const paneRestoredWorkspaceRef = useRef<string | null>(null);
  /** A Workspace switch invalidates in-flight Pane restore results. */
  const paneLoadSeqRef = useRef(0);
  // "Run cancelled" notice: the event stream has no cancelled signal, so the
  // renderer marks a user-requested abort and shows the notice when busy ends.
  const [cancelRequested, setCancelRequested] = useState(false);
  const [runCancelled, setRunCancelled] = useState(false);
  /** Locally echoed Prompt awaiting its first streamed Delta. */
  const [pendingPrompt, setPendingPrompt] = useState<PendingPrompt | null>(null);
  const [trustRequest, setTrustRequest] = useState<ProjectTrustRequest | null>(
    null,
  );
  /** Session awaiting delete confirmation (the modal's target). */
  const [pendingDelete, setPendingDelete] = useState<SessionListItem | null>(
    null,
  );
  /** Durable Known Workspaces (recent successful use first). */
  const [knownWorkspaces, setKnownWorkspaces] = useState<KnownWorkspace[]>([]);
  /** Known Workspaces whose last selection failed, marked for this run. */
  const [failedWorkspaceCwds, setFailedWorkspaceCwds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  /** Known Workspace awaiting removal confirmation (the modal's target). */
  const [pendingRemoveWorkspace, setPendingRemoveWorkspace] =
    useState<KnownWorkspace | null>(null);
  /** Launch restoration runs once (StrictMode mounts effects twice). */
  const startupRanRef = useRef(false);
  /** Stable identity lets Main reject stale selection requests after reload. */
  const [selectionClientId] = useState(readSelectionClientId);
  /** Unsent Composer text and Clips per Workspace/Session (current run only). */
  const draftsRef = useRef(new Map<string, {
    text: string;
    clips: ContextClip[];
  }>());
  const [, setDraftRevision] = useState(0);
  /** Serializable Skills prepared by the selected Session Runtime. */
  const [sessionSkills, setSessionSkills] = useState<SessionSkill[]>([]);
  const [sessionPreparing, setSessionPreparing] = useState(false);
  const [preparedSessionKey, setPreparedSessionKey] = useState<string | null>(
    null,
  );
  const trustResolver = useRef<{
    resolve(): void;
    reject(error: Error): void;
  } | null>(null);
  const selectedIdsRef = useRef<{
    workspaceId: string;
    sessionId: string;
  } | null>(null);
  const workspaceIdRef = useRef<string | null>(null);
  const workspaceRef = useRef(workspace);
  const connectionRecoveryRef = useRef<Promise<void> | null>(null);
  const timelineStreamRef = useRef(timelineStream);
  const sessionsRef = useRef(sessions);
  const sessionSwitchingRef = useRef(sessionSwitching);
  const recoveryInFlightRef = useRef<string | null>(null);
  const timelineRecoveryGenerationRef = useRef(0);

  const selectedSessionId = selectedSession?.id ?? null;
  const workspaceId = workspace?.id ?? null;
  const linkRevision = linkRevisionState.workspaceId === workspaceId
    ? linkRevisionState.revision
    : 0;
  const propertyRegistry = linkIndexWorkspaceId === workspaceId && linkIndex.status === "ready"
    ? linkIndex.propertyRegistry
    : [];
  const selectedSessionKey =
    workspaceId && selectedSessionId
      ? `${workspaceId}/${selectedSessionId}`
      : null;
  const timelineItems = timelineStream.items;
  const userMessageCount = timelineItems.filter((item) => item.kind === "user").length;
  const sessionBusy =
    timelineStream.status === "running" ||
    (timelineStream.status === "starting" && !sessionPreparing);
  selectedIdsRef.current =
    workspaceId && selectedSessionId
      ? { workspaceId, sessionId: selectedSessionId }
      : null;
  workspaceIdRef.current = workspaceId;
  workspaceRef.current = workspace;
  timelineStreamRef.current = timelineStream;
  sessionsRef.current = sessions;
  sessionSwitchingRef.current = sessionSwitching;

  // Session switches reset transient Turn status.
  useEffect(() => {
    setRunCancelled(false);
    setCancelRequested(false);
    setPendingPrompt(null);
  }, [selectedSessionId]);

  // A Workspace owns its Pane tabs; Session switches leave them untouched.
  // Switching Workspaces flushes the previous snapshot, restores the new
  // one from Main, and shows the Pane skeleton until it arrives.
  // The in-flight promise lives at module scope: React StrictMode remounts
  // the Shell in dev, and a remounted instance must reuse the same request
  // so the one-time restore warning is delivered to the live instance.
  useEffect(() => {
    flushPanePersist();
    paneRestoredWorkspaceRef.current = null;
    setWorkspaceTabs(initialWorkspacePaneState());
    setContextClipNavigation(null);
    setPaneRestoreReport(null);
    setLeftMode("sessions");
    setFailedSessionIds(new Set());
    if (!workspaceId) {
      setPaneRestoring(false);
      paneLoadSeqRef.current += 1;
      return;
    }
    const request =
      paneRestoreInFlight?.workspaceId === workspaceId
        ? paneRestoreInFlight.promise
        : client.loadWorkspacePaneState(workspaceId);
    if (paneRestoreInFlight?.workspaceId !== workspaceId) {
      paneRestoreInFlight = { workspaceId, promise: request };
    }
    const seq = ++paneLoadSeqRef.current;
    setPaneRestoring(true);
    void request
      .then((result) => {
        if (seq !== paneLoadSeqRef.current) return;
        setWorkspaceTabs(result.state);
        paneRestoredWorkspaceRef.current = workspaceId;
        setPaneRestoreReport(
          result.skipped > 0 || result.warning
            ? { skipped: result.skipped, warning: result.warning }
            : null,
        );
      })
      .catch(() => {
        // Persistence is best-effort: a failed restore degrades to an empty Pane.
      })
      .finally(() => {
        if (paneRestoreInFlight?.promise === request) paneRestoreInFlight = null;
        if (seq === paneLoadSeqRef.current) setPaneRestoring(false);
      });
  }, [workspaceId]);

  async function recoverTimeline(): Promise<void> {
    const selected = selectedIdsRef.current;
    if (!selected) return;
    const generation = timelineRecoveryGenerationRef.current;
    const key = `${selected.workspaceId}/${selected.sessionId}/${generation}`;
    if (recoveryInFlightRef.current === key) return;
    recoveryInFlightRef.current = key;
    let retry = false;
    try {
      const snapshot = await client.getTimelineSnapshot(
        selected.workspaceId,
        selected.sessionId,
      );
      const current = selectedIdsRef.current;
      if (
        generation !== timelineRecoveryGenerationRef.current ||
        current?.workspaceId !== snapshot.workspaceId ||
        current.sessionId !== snapshot.sessionId
      ) {
        return;
      }
      const next = applyTimelineSnapshot(timelineStreamRef.current, snapshot);
      timelineStreamRef.current = next;
      setTimelineStream(next);
      retry = next.needsSnapshot;
    } catch (err) {
      const current = selectedIdsRef.current;
      if (generation === timelineRecoveryGenerationRef.current &&
          current?.workspaceId === selected.workspaceId && current.sessionId === selected.sessionId) {
        setSessionRecoveryError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (recoveryInFlightRef.current === key)
        recoveryInFlightRef.current = null;
      if (retry) queueMicrotask(() => void recoverTimeline());
    }
  }

  function recoverConnection(): Promise<void> {
    if (connectionRecoveryRef.current) return connectionRecoveryRef.current;
    const selectedWorkspace = workspaceRef.current;
    const selected = selectedIdsRef.current;
    if (!selectedWorkspace) return refreshKnownWorkspaces().then(() => {});
    const isCurrent = () => workspaceRef.current?.id === selectedWorkspace.id &&
      selectedIdsRef.current?.sessionId === selected?.sessionId;
    setConnectionRecovering(true);
    setSessionRecoveryError(null);
    const recovery = (async () => {
      try {
        await client.openWorkspace(selectedWorkspace.cwd);
        if (!isCurrent()) return;
        if (selected) await client.openSession(selected.workspaceId, selected.sessionId);
        if (!isCurrent()) return;
        await Promise.all([refreshSessions(selectedWorkspace.id), refreshKnownWorkspaces()]);
        if (!isCurrent()) return;
        // A new Host rebuilds the Link Index from revision zero.
        advanceLinkRevision(null, 0);
        setLinkIndexWorkspaceId(null);
        setSessionConnectionRevision((revision) => revision + 1);
        setEventStreamRevision((revision) => revision + 1);
      } catch (err) {
        if (isCurrent()) setSessionRecoveryError(err instanceof Error ? err.message : String(err));
      } finally {
        connectionRecoveryRef.current = null;
        setConnectionRecovering(false);
      }
    })();
    connectionRecoveryRef.current = recovery;
    return recovery;
  }

  function advanceLinkRevision(nextWorkspaceId: string | null, revision: number): void {
    const current = linkRevisionRef.current;
    if (current.workspaceId === nextWorkspaceId && current.revision >= revision) return;
    const next = { workspaceId: nextWorkspaceId, revision };
    linkRevisionRef.current = next;
    setLinkRevisionState(next);
  }

  useEffect(() => {
    const unsubscribe = client.subscribeEvents(
      (event) => {
        // Workspace filesystem changes route to the Workspace Pane / File Tree.
        if (isWorkspaceFilesChangedEvent(event)) {
          if (event.workspaceId === workspaceIdRef.current) {
            emitWorkspaceFilesChanged(event.paths);
          }
          return;
        }
        if (isWorkspaceLinkIndexChangedEvent(event)) {
          if (event.workspaceId === workspaceIdRef.current) {
            advanceLinkRevision(event.workspaceId, event.revision);
          }
          return;
        }
        if ("type" in event && event.type === "workspace_versions_changed") return;
        // Keep the Known Workspace switcher's running-work badge live:
        // status transitions from any Workspace refresh the list.
        if (event.delta.type === "session_status") {
          void refreshKnownWorkspaces().catch(() => {});
          if (
            event.delta.status === "idle" &&
            event.workspaceId === workspaceIdRef.current &&
            event.sessionId === selectedIdsRef.current?.sessionId
          ) {
            void refreshSessionConfiguration(
              event.workspaceId,
              event.sessionId,
            ).catch(() => {});
          }
        }
        if (event.workspaceId === workspaceIdRef.current) {
          setSessions((previous) =>
            previous.map((session) =>
              session.id === event.sessionId &&
              event.delta.type === "session_status"
                ? { ...session, runtimeStatus: event.delta.status }
                : session,
            ),
          );
        }
        const previous = timelineStreamRef.current;
        const next = applyTimelineDelta(previous, event);
        // Failure badges are per-Workspace state; ignore Deltas from any
        // other Workspace so a background failure can't mark rows here.
        if (event.workspaceId === workspaceIdRef.current) {
          if (event.delta.type === "error") {
            setFailedSessionIds((current) =>
              current.has(event.sessionId)
                ? current
                : new Set(current).add(event.sessionId),
            );
          }
          if (
            event.delta.type === "user_message" ||
            event.delta.type === "turn_start"
          ) {
            setFailedSessionIds((current) => {
              if (!current.has(event.sessionId)) return current;
              const updated = new Set(current);
              updated.delete(event.sessionId);
              return updated;
            });
          }
        }
        // The list title comes from the first message; refresh once a
        // previously-Untitled Session receives it so the row renames live.
        if (
          event.delta.type === "user_message" &&
          event.workspaceId === workspaceIdRef.current
        ) {
          const item = sessionsRef.current.find(
            (session) => session.id === event.sessionId,
          );
          if (item && sessionTitle(item) === "Untitled Session") {
            void refreshSessions(event.workspaceId).catch(() => {});
          }
        }
        // The real user_message Delta replaces the pending placeholder.
        if (
          event.delta.type === "user_message" &&
          event.sessionId === selectedIdsRef.current?.sessionId
        ) {
          setPendingPrompt(null);
        }
        if (next === previous) return;
        timelineStreamRef.current = next;
        setTimelineStream(next);
        if (
          event.delta.type === "user_message" ||
          event.delta.type === "error"
        ) {
          setRunCancelled(false);
          setCancelRequested(false);
        }
        if (next.needsSnapshot && !previous.needsSnapshot) {
          void recoverTimeline();
        }
      },
      () => { void recoverConnection().catch(() => {}); },
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      advanceLinkRevision(null, 0);
      setLinkIndex({ status: "building" });
      setLinkIndexWorkspaceId(null);
      return;
    }
    let current = true;
    void client.getWorkspaceLinkIndex(workspaceId).then((snapshot) => {
      if (!current) return;
      const latest = linkRevisionRef.current;
      const stale = latest.workspaceId === workspaceId && latest.revision > 0 &&
        (snapshot.status !== "ready" || snapshot.revision < latest.revision);
      if (!stale) {
        setLinkIndex(snapshot);
        setLinkIndexWorkspaceId(workspaceId);
        if (snapshot.status === "ready") advanceLinkRevision(workspaceId, snapshot.revision);
      }
    }).catch(() => {});
    return () => { current = false; };
  }, [eventStreamRevision, workspaceId, linkRevision]);

  const resolveWorkspaceLink = useCallback((request: WorkspaceLinkResolveRequest) => {
    if (!workspaceId) return Promise.resolve({ status: "building" } as const);
    return client.resolveWorkspaceLink(workspaceId, request);
  }, [workspaceId]);

  useEffect(() => {
    if (workspace && selectedSession) {
      sessionStorage.setItem(
        SELECTION_STORAGE_KEY,
        JSON.stringify({
          workspace,
          selectedSession,
        } satisfies PersistedSelection),
      );
    } else {
      sessionStorage.removeItem(SELECTION_STORAGE_KEY);
    }
  }, [workspace, selectedSession]);

  useEffect(() => {
    setSessionRecoveryError(null);
    timelineRecoveryGenerationRef.current += 1;
    const initial = initialTimelineStream();
    const next =
      workspaceId && selectedSessionId
        ? { ...initial, workspaceId, sessionId: selectedSessionId }
        : initial;
    timelineStreamRef.current = next;
    setTimelineStream(next);
    if (workspaceId && selectedSessionId) void recoverTimeline();
  }, [workspaceId, selectedSessionId, sessionConnectionRevision]);

  useEffect(() => {
    setConfigurationSessionKey(null);
    if (!workspaceId || !selectedSessionId) {
      setSessionConfiguration({});
      setSessionConfigurationStatus("applied");
      return;
    }
    setSessionConfiguration({});
    setSessionConfigurationStatus("applied");
    let cancelled = false;
    void client
      .getSessionConfiguration(workspaceId, selectedSessionId)
      .then((result) => {
        if (cancelled) return;
        setSessionConfiguration(result.configuration);
        setSessionConfigurationStatus(result.status);
        setConfigurationSessionKey(`${workspaceId}/${selectedSessionId}`);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSessionRecoveryError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, selectedSessionId, sessionConnectionRevision]);

  // Renderer selection owns Runtime warmness. Preparation happens before the
  // Composer becomes enabled; cleanup releases only an idle old Runtime and
  // lets a running Turn finish before disposal.
  useEffect(() => {
    if (!workspaceId || !selectedSessionId) {
      setSessionSkills([]);
      setSessionPreparing(false);
      setPreparedSessionKey(null);
      return;
    }
    const selectedWorkspaceId = workspaceId;
    const selectedId = selectedSessionId;
    const preparationKey = `${selectedWorkspaceId}/${selectedId}`;
    const selectionToken = nextSelectionToken(selectionClientId);
    let cancelled = false;
    setSessionSkills([]);
    setPreparedSessionKey(null);
    setSessionPreparing(true);
    void client
      .prepareSession(selectedWorkspaceId, selectedId, selectionToken)
      .then((skills) => {
        if (cancelled) return;
        setSessionSkills(skills);
        setPreparedSessionKey(preparationKey);
        setSessionPreparing(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPreparedSessionKey(null);
        setSessionPreparing(false);
        setSessionRecoveryError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
      void client
        .releaseSession(selectedWorkspaceId, selectedId, selectionToken)
        .catch(() => {});
    };
  }, [workspaceId, selectedSessionId, sessionConnectionRevision]);

  // A shell close/reload must not lose the last navigation change inside
  // the debounce window: flush the pending snapshot before the page hides.
  useEffect(() => {
    const flush = () => {
      flushPanePersist();
      void paneSaveControllerRef.current?.flushAll();
    };
    const blockDirtyExit = (event: BeforeUnloadEvent) => {
      if (!paneSaveControllerRef.current?.hasDirtyDocuments()) return;
      void paneSaveControllerRef.current.flushAll();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", blockDirtyExit);
    return () => {
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", blockDirtyExit);
    };
  }, []);

  useEffect(() => {
    if (startupRanRef.current) return;
    startupRanRef.current = true;
    void (async () => {
      try {
        const known = await refreshKnownWorkspaces();
        if (restoredSelection) {
          await openWorkspaceFlow(restoredSelection.workspace.cwd, restoredSelection.selectedSession.id);
          return;
        }
        // A fresh launch revalidates and opens the last successfully
        // selected Workspace by its canonical path — never a persisted
        // opaque id. A failure keeps the entry known, leaves no selection,
        // and never silently falls back to another Workspace.
        if (known.launchCwd) await openWorkspaceFlow(known.launchCwd);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  // General Settings owns only Thinking and Wiki defaults. The Composer
  // reads the Selected Session configuration below.

  // Surface the cancelled notice once the aborted turn actually settles.
  useEffect(() => {
    if (!sessionBusy && cancelRequested) {
      setCancelRequested(false);
      setRunCancelled(true);
    }
  }, [sessionBusy, cancelRequested]);


  async function refreshSessions(workspaceId: string): Promise<void> {
    const listed = await client.listSessions(workspaceId);
    if (workspaceIdRef.current === workspaceId) setSessions(listed);
  }

  async function refreshSessionConfiguration(
    workspaceId: string,
    sessionId: string,
  ): Promise<void> {
    const result = await client.getSessionConfiguration(workspaceId, sessionId);
    const selected = selectedIdsRef.current;
    if (!selected || selected.workspaceId !== workspaceId || selected.sessionId !== sessionId) {
      return;
    }
    setSessionConfiguration(result.configuration);
    setSessionConfigurationStatus(result.status);
  }

  async function onConfigurationChange(
    patch: SessionConfigurationUpdate,
  ) {
    if (!workspaceId || !selectedSessionId) {
      throw new Error("Select a Session before changing its configuration");
    }
    const result = await client.updateSessionConfiguration(
      workspaceId,
      selectedSessionId,
      patch,
    );
    setSessionConfiguration(result.configuration);
    setSessionConfigurationStatus(result.status);
    if (result.status === "applied" && preparedSessionKey !== selectedSessionKey) {
      setSessionConnectionRevision((revision) => revision + 1);
    }
    return result;
  }

  function applyKnownResponse(known: KnownWorkspaceListResponse): void {
    setKnownWorkspaces(known.workspaces);
    if (known.warning) showToast(known.warning);
  }

  async function refreshKnownWorkspaces(): Promise<KnownWorkspaceListResponse> {
    const known = await client.listKnownWorkspaces();
    applyKnownResponse(known);
    return known;
  }

  function markWorkspaceFailed(cwd: string): void {
    setFailedWorkspaceCwds((current) =>
      current.has(cwd) ? current : new Set(current).add(cwd),
    );
  }

  function clearWorkspaceFailed(cwd: string): void {
    setFailedWorkspaceCwds((current) => {
      if (!current.has(cwd)) return current;
      const next = new Set(current);
      next.delete(cwd);
      return next;
    });
  }

  /** Open (or switch to) a Workspace and restore its remembered Session. */
  async function openWorkspaceFlow(cwd: string, preferredSessionId?: string): Promise<boolean> {
    if (
      paneSaveControllerRef.current &&
      !(await paneSaveControllerRef.current.flushAll())
    ) {
      setError("Save all Markdown changes before switching Workspaces.");
      return false;
    }
    setOpening(true);
    setError(null);
    try {
      const summary = await client.openWorkspace(cwd);
      setWorkspace(summary);
      setSelectedSession(null);
      const [listed, known] = await Promise.all([
        client.listSessions(summary.id),
        client.listKnownWorkspaces(),
      ]);
      setSessions(listed);
      applyKnownResponse(known);
      clearWorkspaceFailed(summary.cwd);
      // Per-Workspace Session restoration: the remembered Session when it
      // still exists, otherwise the most recent, otherwise none.
      const remembered = known.workspaces.find(
        (entry) => entry.cwd === summary.cwd,
      )?.selectedSessionId;
      const target = listed.find((item) => item.id === preferredSessionId)
        ?? listed.find((item) => item.id === remembered) ?? listed[0];
      if (target) {
        const result = await client.openSession(summary.id, target.id);
        setSelectedSession({ id: result.sessionId, action: result.action });
      }
      return true;
    } catch (err) {
      // A failed open must not destroy the Workspace already in use; only a
      // shell with nothing open resets to the welcome state.
      if (!workspace) {
        setWorkspace(null);
        setSelectedSession(null);
        setSessions([]);
      }
      // Mark the Known Workspace row (keyed by its canonical cwd) when the
      // failed path corresponds to one, so the badge lands on the list item.
      const knownCwd =
        knownWorkspaces.find((entry) => entry.cwd === cwd)?.cwd ?? cwd;
      markWorkspaceFailed(knownCwd);
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setOpening(false);
    }
  }

  /**
   * Native directory chooser flow: the Host returns only a path (or null on
   * cancel), which then goes through the validated openWorkspace flow. Picker
   * failures propagate to the switcher without changing the Selected Workspace.
   */
  async function onBrowseWorkspace() {
    if (!client.pickWorkspaceDirectory || picking || opening) return false;
    setPicking(true);
    setError(null);
    try {
      const cwd = await client.pickWorkspaceDirectory();
      // null = the chooser was cancelled: silent, selection unchanged.
      return cwd ? await openWorkspaceFlow(cwd) : false;
    } finally {
      setPicking(false);
    }
  }

  async function onSwitchWorkspace(cwd: string) {
    if (opening || sessionSwitching) return false;
    if (cwd === workspace?.cwd) return true;
    return openWorkspaceFlow(cwd);
  }

  function onRequestRemoveWorkspace(entry: KnownWorkspace) {
    setPendingRemoveWorkspace(entry);
  }

  async function onConfirmRemoveWorkspace() {
    const target = pendingRemoveWorkspace;
    if (!target) return;
    setPendingRemoveWorkspace(null);
    setError(null);
    try {
      await client.removeKnownWorkspace(target.id);
      await refreshKnownWorkspaces();
      // Removing the Selected Workspace leaves no selection and never
      // chooses another automatically.
      if (workspace?.cwd === target.cwd) {
        setWorkspace(null);
        setSelectedSession(null);
        setSessions([]);
      }
      showToast(`Removed "${workspaceName(target.cwd)}"`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onCreateSession() {
    if (!workspace || sessionSwitching) return;
    setSessionSwitching(true);
    setError(null);
    try {
      const result = await client.createSession(workspace.id);
      setSelectedSession({ id: result.sessionId, action: result.action });
      await refreshSessions(workspace.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionSwitching(false);
    }
  }

  async function onOpenSession(sessionId: string) {
    if (!workspace || sessionSwitching) return;
    if (sessionId === selectedSessionId) return;
    setSessionSwitching(true);
    setError(null);
    try {
      const result = await client.openSession(workspace.id, sessionId);
      setSelectedSession({ id: result.sessionId, action: result.action });
      await refreshSessions(workspace.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSessionSwitching(false);
    }
  }

  function onRequestDelete(sessionId: string) {
    const target = sessions.find((item) => item.id === sessionId);
    if (target) setPendingDelete(target);
  }

  async function onConfirmDelete() {
    const target = pendingDelete;
    if (!workspace || !target) return;
    setPendingDelete(null);
    setError(null);
    try {
      await client.deleteSession(workspace.id, target.id);
      await refreshSessions(workspace.id);
      showToast(`Deleted "${sessionTitle(target)}"`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function onLeftModeChange(mode: LeftRailMode) {
    if (mode === leftMode) return;
    setLeftMode(mode);
    recordUiGesture("sidebar.mode", {
      "wikilot.gesture": "sidebar.mode",
      "wikilot.sidebar.mode": mode,
    });
  }

  // The active checklist step deep-links to the next valid Session action.
  function onChecklistStep(step: 1 | 2 | 3) {
    if (step === 2) {
      toggleSidebar(true);
      setLeftMode("sessions");
      void onCreateSession();
      return;
    }
    toggleSidebar(true);
    requestAnimationFrame(() => {
      const selector =
        step === 1 ? "#workspace-trigger" : '[data-testid="composer-input"]';
      const target = document.querySelector<HTMLElement>(selector);
      target?.focus();
      if (step === 1) target?.click();
    });
  }

  /** Persist Pane navigation after a quiet period of Pane activity. */
  const flushPanePersist = useCallback((): void => {
    const pending = panePersistRef.current;
    if (!pending) return;
    panePersistRef.current = null;
    if (pending.timer) clearTimeout(pending.timer);
    void client
      .saveWorkspacePaneState(pending.workspaceId, pending.state)
      .catch(() => {
        // Background persistence: a failed save only loses the restore hint.
      });
  }, []);

  const schedulePanePersist = useCallback((next: WorkspacePaneState): void => {
    if (!workspaceId || paneRestoredWorkspaceRef.current !== workspaceId) return;
    if (panePersistRef.current?.timer) clearTimeout(panePersistRef.current.timer);
    const timer = setTimeout(flushPanePersist, PANE_PERSIST_DEBOUNCE_MS);
    panePersistRef.current = { workspaceId, state: next, timer };
  }, [workspaceId, flushPanePersist]);

  const sidebarWidth = workspaceTabs.columnWidths?.sidebar ?? DEFAULT_SIDEBAR_WIDTH;
  const paneWidth = workspaceTabs.columnWidths?.pane ?? DEFAULT_PANE_WIDTH;

  function resizeColumn(column: "sidebar" | "pane", delta: number): void {
    setWorkspaceTabs((current) => {
      const widths = current.columnWidths ?? { sidebar: DEFAULT_SIDEBAR_WIDTH, pane: DEFAULT_PANE_WIDTH };
      const width = column === "sidebar"
        ? Math.min(480, Math.max(200, widths.sidebar + delta))
        : clampPaneWidth(clampPaneWidth(widths.pane, window.innerWidth - 8, widths.sidebar, sidebarOpen) + delta,
          window.innerWidth - 8, widths.sidebar, sidebarOpen);
      const next = { ...current, columnWidths: { ...widths, [column]: width } };
      schedulePanePersist(next);
      return next;
    });
  }

  function onOpenGraph() {
    recordUiGesture("graph.open", {
      "wikilot.gesture": "graph.open",
    });
    handlePaneTabsChange(openWorkspaceGraphTab(workspaceTabs));
  }

  const onOpenFile = useCallback((path: string, fromFileTree = false) => {
    if (!/\.(md|pdf)$/i.test(path)) {
      setUnsupportedFile(path);
      return;
    }
    const reopened = fromFileTree && paneSaveControllerRef.current?.reopenPath(path);
    setWorkspaceTabs((current) => {
      const next = openWorkspacePaneTab(reopened ? closeWorkspacePaneTab(current, path) : current, path);
      schedulePanePersist(next);
      return next;
    });
  }, [schedulePanePersist]);

  const onNavigateWorkspaceLink = useCallback((
    target: Extract<WorkspaceLinkTarget, { status: "resolved" }>,
  ) => {
    if (target.kind !== "markdown" && target.kind !== "pdf") return;
    recordUiGesture("workspace.link.navigate", {
      "wikilot.gesture": "workspace.link.navigate",
      "wikilot.link.kind": target.kind,
    });
    setLinkNavigation(target);
    onOpenFile(target.path);
  }, [onOpenFile]);

  async function navigateContextClip(clip: ContextClip): Promise<void> {
    if (!workspaceId) return;
    const targetWorkspaceId = workspaceId;
    const navigationId = ++contextClipNavigationId.current;
    const path = clip.source.path;
    const isCurrentNavigation = () =>
      workspaceIdRef.current === targetWorkspaceId &&
      navigationId === contextClipNavigationId.current;
    const closeUnavailablePdf = () => {
      if (!isCurrentNavigation()) return;
      setContextClipNavigation(null);
      setWorkspaceTabs((current) => {
        const next = closeWorkspacePaneTab(current, path);
        schedulePanePersist(next);
        return next;
      });
      showToast("Context Clip source is unavailable");
    };
    let pdfSource: WorkspacePdfSource | undefined;
    if (clip.source.kind === "pdf" && workspaceTabs.activePath !== path) {
      try {
        pdfSource = await client.openWorkspacePdf(targetWorkspaceId, path);
      } catch {
        closeUnavailablePdf();
        return;
      }
    } else if (clip.source.kind !== "pdf" && !workspaceTabs.tabs.includes(path)) {
      try {
        const source: MarkdownDocumentSnapshot = await client.openMarkdownDocument(targetWorkspaceId, path);
        if (source.status !== "ready") {
          showToast("Context Clip source is unavailable");
          return;
        }
      } catch {
        if (
          workspaceIdRef.current === targetWorkspaceId &&
          navigationId === contextClipNavigationId.current
        ) {
          showToast("Context Clip source is unavailable");
        }
        return;
      }
      if (
        workspaceIdRef.current !== targetWorkspaceId ||
        navigationId !== contextClipNavigationId.current
      ) return;
    }
    if (
      workspaceIdRef.current !== targetWorkspaceId ||
      navigationId !== contextClipNavigationId.current
    ) {
      if (pdfSource) {
        void client.releaseWorkspacePdfSource(pdfSource.sourceId).catch(() => {});
      }
      return;
    }
    onOpenFile(path);
    setContextClipNavigation({ id: navigationId, clip, ...(pdfSource ? { pdfSource } : {}) });
    recordUiGesture("context_clip.navigate", {
      "wikilot.gesture": "context_clip.navigate",
    });
  }

  function onContextClipNavigationResult(result: "exact" | "relocated" | "changed") {
    if (result === "relocated") {
      showToast("Source changed; the Context Clip was relocated");
    } else if (result === "changed") {
      showToast("Source changed; the original selection could not be highlighted");
    }
  }

  const onCreateMissingMarkdown = useCallback(async (path: string): Promise<void> => {
    if (!workspaceId) throw new Error("Open a Workspace first");
    await client.createWorkspaceMarkdown(workspaceId, path);
    recordUiGesture("workspace.link.create", {
      "wikilot.gesture": "workspace.link.create",
      "wikilot.link.kind": "markdown",
    });
    showToast(`Created "${path}"`);
  }, [workspaceId, showToast]);

  function handlePaneTabsChange(next: WorkspacePaneState): void {
    setWorkspaceTabs(next);
    schedulePanePersist(next);
  }

  const activePaneIsWide = workspaceTabs.visible && (compactLayout || workspaceTabs.readingMode === "wide");

  function toggleWorkspacePane() {
    const visible = !workspaceTabs.visible;
    recordUiGesture("workspace_pane.toggle", {
      "wikilot.gesture": "workspace_pane.toggle",
      "wikilot.pane.visible": String(visible),
    });
    handlePaneTabsChange({ ...workspaceTabs, visible });
    if (!visible) requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Show Workspace Pane"]')?.focus();
    });
  }

  function toggleWideMode() {
    if (compactLayout) {
      toggleWorkspacePane();
      return;
    }
    const path = workspaceTabs.activePath;
    if (!path) return;
    handlePaneTabsChange(
      setWorkspacePaneReadingMode(
        workspaceTabs,
        activePaneIsWide ? "normal" : "wide",
      ),
    );
  }

  async function onResolveTrust(trusted: boolean) {
    if (!trustRequest) return;
    try {
      const skills = await client.resolveProjectTrust({ ...trustRequest, trusted });
      if (
        workspaceId === trustRequest.workspaceId &&
        selectedSessionId === trustRequest.sessionId
      ) {
        setSessionSkills(skills);
      }
      setTrustRequest(null);
      trustResolver.current?.resolve();
      trustResolver.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      trustResolver.current?.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
      trustResolver.current = null;
    }
  }

  function onTrustRequired(request: ProjectTrustRequest): Promise<void> {
    setTrustRequest(request);
    return new Promise((resolve, reject) => {
      trustResolver.current = { resolve, reject };
    });
  }

  // Register shell built-ins; ⌘K lives in ShortcutProvider.
  // Refs keep the registered handlers pointing at the latest closures.
  const shortcutHandlersRef = useRef({
    onCreateSession,
    toggleTheme,
  });
  useEffect(() => {
    shortcutHandlersRef.current = {
      onCreateSession,
      toggleTheme,
    };
  });
  useEffect(() => {
    const unregisters = [
      registerShortcut("meta+n", {
        label: "New Session",
        when: () => {
          if (!workspaceIdRef.current) return "Open a Workspace first";
          if (sessionSwitchingRef.current) {
            return "Wait for the Session switch to finish";
          }
          return null;
        },
        handler: () => void shortcutHandlersRef.current.onCreateSession(),
      }),
      registerShortcut("meta+d", {
        label: "Toggle Dark Mode",
        handler: () => shortcutHandlersRef.current.toggleTheme(),
      }),
      registerShortcut("meta+e", {
        label: "Toggle Wide Workspace",
        when: () => (workspaceTabs.visible && workspaceTabs.activePath ? null : "Show a Workspace Tab first"),
        handler: toggleWideMode,
      }),
    ];
    return () => {
      for (const unregister of unregisters) unregister();
    };
  }, [registerShortcut, workspaceTabs.activePath, workspaceTabs.visible, activePaneIsWide]);

  // The Composer locks with the rest of the shell during a Session switch so
  // a send can never race the switch and land on the previous Session.
  const composerEnabled =
    workspace !== null &&
    selectedSession !== null &&
    !sessionSwitching &&
    !connectionRecovering &&
    !sessionPreparing &&
    configurationSessionKey === selectedSessionKey &&
    !timelineStream.needsSnapshot;
  // Snapshot restore in flight: the Timeline shows a loading state instead of
  // flashing the empty-state copy during a Session switch.
  const timelineLoading =
    selectedSessionId !== null &&
    timelineStream.needsSnapshot &&
    !sessionRecoveryError &&
    timelineItems.length === 0;

  // Desktop convention: when a Run settles, typing focus returns to the Composer.
  const wasBusyRef = useRef(false);
  useEffect(() => {
    if (wasBusyRef.current && !sessionBusy) {
      if (workspaceId && selectedSessionId) {
        void refreshSessionConfiguration(workspaceId, selectedSessionId).catch(
          (err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
        );
      }
      if (composerEnabled) {
        requestAnimationFrame(() => {
          // Never yank focus out of an open overlay (modal, palette, settings).
          if (
            document.querySelector(
              ".modal-backdrop, .palette-overlay, .settings-popover:not(.settings-popover-closed)",
            )
          ) {
            return;
          }
          document
            .querySelector<HTMLElement>('[data-testid="composer-input"]')
            ?.focus();
        });
      }
    }
    wasBusyRef.current = sessionBusy;
  }, [sessionBusy, composerEnabled, workspaceId, selectedSessionId]);
  const composerKey = `${workspaceId ?? "no-workspace"}/${selectedSessionId ?? "no-session"}`;
  const composerDraft = draftsRef.current.get(composerKey) ?? { text: "", clips: [] };

  function updateComposerDraft(next: { text: string; clips: ContextClip[] }) {
    draftsRef.current.set(composerKey, next);
    setDraftRevision((revision) => revision + 1);
  }

  function addContextClip(clip: ContextClip) {
    if (!workspaceId || !selectedSessionId) return;
    const current = draftsRef.current.get(composerKey) ?? { text: "", clips: [] };
    const clipCharacters = [...clip.text].length;
    if (clipCharacters > MAX_CONTEXT_CLIP_CHARACTERS) {
      showToast(`A Context Clip may contain at most ${MAX_CONTEXT_CLIP_CHARACTERS} characters`);
      return;
    }
    const duplicate = current.clips.some((item) => sameContextClip(item, clip));
    if (duplicate) {
      showToast("This selection is already in the Composer");
      return;
    }
    if (current.clips.length >= MAX_CONTEXT_CLIPS) {
      showToast(`A Prompt may contain at most ${MAX_CONTEXT_CLIPS} Context Clips`);
      return;
    }
    const characters = clipCharacters + current.clips.reduce(
      (total, item) => total + [...item.text].length,
      0,
    );
    if (characters > MAX_CONTEXT_CLIP_TOTAL_CHARACTERS) {
      showToast(`Context Clips may contain at most ${MAX_CONTEXT_CLIP_TOTAL_CHARACTERS} characters in total`);
      return;
    }
    updateComposerDraft({
      ...current,
      clips: [...current.clips, clip],
    });
    recordUiGesture("context_clip.add", {
      "wikilot.gesture": "context_clip.add",
      "wikilot.context_clip.count": "1",
      "wikilot.context_clip.characters": String([...clip.text].length),
    });
  }
  const locked = opening || sessionSwitching || connectionRecovering;
  const lastItemIsError = timelineItems.at(-1)?.kind === "error";
  const runFailed = !sessionBusy && lastItemIsError;

  // The chrome names the current Session and nothing else — workspace path,
  // model, and setup prompts each live in exactly one home elsewhere.
  const activeSessionItem =
    sessions.find((item) => item.id === selectedSessionId) ?? null;
  const chromeTitle = workspace
    ? activeSessionItem
      ? sessionTitle(activeSessionItem)
      : "Untitled Session"
    : "Welcome";

  const applicationActions = <>
    <button type="button" className="icon-btn" onClick={togglePalette}
      title="Command Palette (⌘K)" aria-label="Command Palette" aria-expanded={paletteOpen}>
      <Command size={18} />
    </button>
    <button type="button" className="icon-btn" onClick={toggleTheme}
      title="Toggle Dark Mode (⌘D)" aria-label="Toggle Dark Mode">
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  </>;
  const chromeActions = <>
    {compactLayout && workspaceTabs.visible ? <button type="button" className="btn-secondary shell-session-switch" onClick={toggleWorkspacePane}>Session</button> : null}
    {workspace ? <button type="button" className="icon-btn" onClick={toggleWorkspacePane}
      title={workspaceTabs.visible ? "Hide Workspace Pane" : "Show Workspace Pane"}
      aria-label={workspaceTabs.visible ? "Hide Workspace Pane" : "Show Workspace Pane"}
      aria-expanded={workspaceTabs.visible} aria-controls="workspace-pane">
      <PanelRight size={18} />
    </button> : null}
  </>;

  return (
    <div
      className={`${resizing ? "shell shell-resizing" : "shell"}${activePaneIsWide ? " shell-wide" : ""}${compactLayout ? " shell-compact" : ""}`}
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
          "--sidebar-collapsed-width": `${COLLAPSED_SIDEBAR_WIDTH}px`,
          "--sidebar-offset": `${sidebarOpen && !compactLayout ? sidebarWidth : COLLAPSED_SIDEBAR_WIDTH}px`,
          "--workspace-pane-width": `${clampPaneWidth(paneWidth, viewportWidth - 8, sidebarWidth, sidebarOpen)}px`,
          "--wide-content-inset": `${activePaneIsWide ? wideContentInset : 0}px`,
        } as CSSProperties
      }
    >
      {compactLayout && sidebarOpen ? <button className="shell-rail-backdrop" aria-label="Close Sidebar" onClick={() => toggleSidebar(false)} /> : null}
      <Sidebar
        applicationActions={applicationActions}
        isOpen={sidebarOpen}
        onToggle={() => toggleSidebar(!sidebarOpen)}
        toggleButtonRef={sidebarOpen ? sidebarCloseRef : sidebarOpenRef}
        workspace={workspace}
        selectedSession={selectedSession}
        sessions={sessions}
        locked={locked}
        opening={opening}
        picking={picking}
        onBrowseWorkspace={
          client.pickWorkspaceDirectory
            ? onBrowseWorkspace
            : undefined
        }
        knownWorkspaces={knownWorkspaces}
        failedWorkspaceCwds={failedWorkspaceCwds}
        onSwitchWorkspace={onSwitchWorkspace}
        onRequestRemoveWorkspace={onRequestRemoveWorkspace}
        onCreateSession={() => void onCreateSession()}
        beforeSaveVersion={async () => paneSaveControllerRef.current?.flushAll() ?? true}
        graphActive={workspaceTabs.activePath === WORKSPACE_GRAPH_TAB_ID}
        graphStatus={workspaceGraphStatus}
        onOpenGraph={onOpenGraph}
        onOpenSession={(sessionId) => void onOpenSession(sessionId)}
        onRequestDelete={onRequestDelete}
        failedSessionIds={failedSessionIds}
        settingsOpen={settingsOpen}
        settingsSection={settingsSection}
        onSettingsOpenChange={onSettingsOpenChange}
        leftMode={leftMode}
        onLeftModeChange={onLeftModeChange}
        activePath={workspaceTabs.activePath}
        onTrashFiles={async paths => paneSaveControllerRef.current && workspace
          ? paneSaveControllerRef.current.runFileChange(paths, () => client.changeWorkspaceFiles(workspace.id, { kind: "trash", paths }))
          : { status: "blocked", reason: "unconfirmed", paths }}
        onMoveFiles={async (paths, destination) => paneSaveControllerRef.current && workspace
          ? paneSaveControllerRef.current.runFileChange(paths, () => client.changeWorkspaceFiles(workspace.id, { kind: "move", paths, destination }))
          : { status: "blocked", reason: "save-failed", paths }}
        onRenameFile={async (path, name) => paneSaveControllerRef.current && workspace
          ? paneSaveControllerRef.current.runFileChange([path], () => client.changeWorkspaceFiles(workspace.id, { kind: "rename", path, name }))
          : { status: "blocked", reason: "save-failed", paths: [path] }}
        onOpenFile={path => onOpenFile(path, true)}
      />
      {sidebarOpen && !compactLayout && !activePaneIsWide ? (
        <ColumnResizer
          label="Resize Sidebar"
          onDrag={(delta) => resizeColumn("sidebar", delta)}
          onStep={(direction) => resizeColumn("sidebar", direction * 16)}
          onActiveChange={setResizing}
        />
      ) : null}
      <main className="shell-main">
        <header className="shell-chrome">
          <div className="shell-chrome-titles">
            <h1 className="shell-title">{chromeTitle}</h1>
          </div>
          {!workspace || !workspaceTabs.visible ? <div className="shell-chrome-actions">{chromeActions}</div> : null}
        </header>
        <div className="shell-body">
          {sessionRecoveryError ? <div className="shell-error-banner" role="alert">
            <span>{sessionRecoveryError}</span>
            <button type="button" className="btn-secondary" onClick={() => void recoverConnection()} disabled={connectionRecovering}>Retry Session</button>
          </div> : null}
          {error ? (
            <div
              className="shell-error-banner"
              data-testid="workspace-error"
              role="alert"
            >
              <span>{error}</span>
              <button type="button" className="icon-btn" aria-label="Dismiss error"
                onClick={() => setError(null)}><X size={16} aria-hidden="true" /></button>
            </div>
          ) : null}
          {workspace ? (
            <div className="shell-timeline">
              <Timeline
                // Keying by Session resets stick-to-bottom and scroll state so
                // entering a Session lands on its latest entries.
                key={selectedSessionId ?? "no-session"}
                items={timelineItems}
                sessionBusy={sessionBusy}
                loading={timelineLoading}
                pendingPrompt={pendingPrompt}
                markdownLinks={{
                  resolveLink: resolveWorkspaceLink,
                  onNavigate: onNavigateWorkspaceLink,
                  linkRevision,
                }}
                onClipNavigate={(clip) => void navigateContextClip(clip)}
                toolImageUrl={selectedSessionId ? (imageRef) => client.timelineImageUrl(workspace.id, selectedSessionId, imageRef) : undefined}
                emptyContent={sessionRecoveryError ? <p className="shell-empty-title">Session could not be restored.</p> :
                  <div className="shell-empty-hint-block">
                    <p className="shell-empty-title">
                      {selectedSession
                        ? hasAvailableModels === false ? "Connect a model to start chatting." : "Send your first message."
                        : "Create a Session to start chatting."}
                    </p>
                    <GettingStartedSteps
                      activeStep={selectedSession ? 3 : 2}
                      onActiveStep={onChecklistStep}
                      needsModel={hasAvailableModels === false}
                      onConnectModel={connectModel}
                    />
                  </div>
                }
              />
            </div>
          ) : (
            <div className="shell-empty">
              <div className="shell-empty-inner">
                <p className="shell-empty-title">
                  Choose a local folder for the agent to work in.
                </p>
                <button type="button" className="btn-secondary" onClick={() => onChecklistStep(1)}>
                  {knownWorkspaces.length > 0 ? "Choose Workspace" : "Open Folder…"}
                </button>
              </div>
            </div>
          )}
          <div className="shell-composer-dock">
            <div className="shell-composer-column">
              {runFailed ? (
                <p className="run-finished run-finished-failed" role="status">
                  <span className="run-finished-dot" aria-hidden="true" />
                  Run failed
                </p>
              ) : null}
              {!sessionBusy && runCancelled && !runFailed ? (
                <p className="run-finished" role="status">
                  <span className="run-finished-dot" aria-hidden="true" />
                  Run cancelled
                </p>
              ) : null}
              {!activePaneIsWide ? <Composer
                onModelAvailabilityChange={setHasAvailableModels}
                catalogRevision={catalogRevision}
                context={timelineStream.context}
                contextLoading={!sessionRecoveryError && (sessionPreparing || timelineStream.needsSnapshot || timelineStream.status === "starting")}
                userMessageCount={userMessageCount}
                key={composerKey}
                enabled={composerEnabled}
              sendingEnabled={preparedSessionKey === selectedSessionKey && !sessionRecoveryError}
                sessionBusy={sessionBusy}
                workspaceId={workspace?.id}
                sessionId={selectedSession?.id}
                initialText={composerDraft.text}
                onTextChange={(text) => {
                  const current = draftsRef.current.get(composerKey) ?? composerDraft;
                  draftsRef.current.set(composerKey, { ...current, text });
                }}
                clips={composerDraft.clips}
                onClipNavigate={(clip) => void navigateContextClip(clip)}
                onClipsChange={(clips) => {
                  const current = draftsRef.current.get(composerKey) ?? composerDraft;
                  updateComposerDraft({ ...current, clips });
                }}
                skills={sessionSkills}
                onSkillsChange={setSessionSkills}
                beforeSend={async () =>
                  paneSaveControllerRef.current?.flushAll() ?? true
                }
                configuration={sessionConfiguration}
                configurationStatus={sessionConfigurationStatus}
                onConfigurationChange={onConfigurationChange}
                disabledPlaceholder={
                  sessionRecoveryError
                    ? "Retry Session to continue"
                    : connectionRecovering
                      ? "Restoring Session…"
                      : sessionPreparing
                    ? "Preparing Session resources…"
                    : sessionSwitching
                      ? "Switching Session…"
                      : workspace
                      ? "Select or create a Session to send a message"
                      : "Available after a Workspace is open"
                }
                onCancelled={() => setCancelRequested(true)}
                onPendingChange={setPendingPrompt}
                onTrustRequired={onTrustRequired}
              /> : null}
            </div>
          </div>
        </div>
      </main>
      {workspace && workspaceTabs.visible && !activePaneIsWide ? (
        <ColumnResizer
          label="Resize Workspace Pane"
          onDrag={(delta) => resizeColumn("pane", -delta)}
          onStep={(direction) => resizeColumn("pane", -direction * 16)}
          onActiveChange={setResizing}
        />
      ) : null}
      {workspace ? (
        <WorkspacePane
          key={workspace.id}
          workspaceId={workspace.id}
          tabs={workspaceTabs}
          compact={compactLayout}
          headerActions={workspaceTabs.visible ? chromeActions : null}
          onTabsChange={handlePaneTabsChange}
          restoring={paneRestoring}
          connectionRevision={sessionConnectionRevision}
          restoreReport={paneRestoreReport}
          onDismissRestoreReport={() => setPaneRestoreReport(null)}
          onSaveControllerChange={handlePaneSaveControllerChange}
          linkIndex={linkIndexWorkspaceId === workspace.id ? linkIndex : { status: "building" }}
          resolveLink={resolveWorkspaceLink}
          onNavigate={onNavigateWorkspaceLink}
          onCreateMissing={onCreateMissingMarkdown}
          onGraphStatusChange={setWorkspaceGraphStatus}
          linkRevision={linkRevision}
          propertyRegistry={propertyRegistry}
          navigationTarget={linkNavigation}
          onNavigationConsumed={() => setLinkNavigation(null)}
          contextClipSessionId={selectedSessionId ?? undefined}
          onAddContextClip={addContextClip}
          contextClipNavigation={contextClipNavigation}
          onContextClipNavigationResult={onContextClipNavigationResult}
          onWideModeChange={(mode) => {
            handlePaneTabsChange(setWorkspacePaneReadingMode(workspaceTabs, mode));
          }}
        />
      ) : null}
      {workspace && activePaneIsWide ? (
        <WideSession
          preview={`${chromeTitle} · ${timelinePreview(timelineItems, pendingPrompt)}`}
          onOcclusionChange={setWideContentInset}
          timelineOpen={Boolean(selectedSessionId) && wideTimelineOpen}
          timelineAvailable={Boolean(selectedSessionId)}
          onTimelineOpenChange={setWideTimelineOpen}
          drawerHeight={wideDrawerHeight}
          onDrawerHeightChange={setWideDrawerHeight}
          timeline={
            <Timeline
              key={`wide-${selectedSessionId ?? "none"}`}
              items={timelineItems}
              sessionBusy={sessionBusy}
              loading={timelineLoading}
              pendingPrompt={pendingPrompt}
              markdownLinks={{ resolveLink: resolveWorkspaceLink, onNavigate: onNavigateWorkspaceLink, linkRevision }}
              onClipNavigate={(clip) => void navigateContextClip(clip)}
              toolImageUrl={selectedSessionId ? (imageRef) => client.timelineImageUrl(workspace.id, selectedSessionId, imageRef) : undefined}
            />
          }
          composer={
            <Composer
              onModelAvailabilityChange={setHasAvailableModels}
              catalogRevision={catalogRevision}
              context={timelineStream.context}
              contextLoading={!sessionRecoveryError && (sessionPreparing || timelineStream.needsSnapshot || timelineStream.status === "starting")}
              userMessageCount={userMessageCount}
              key={`wide-${composerKey}`}
              enabled={composerEnabled}
              sendingEnabled={preparedSessionKey === selectedSessionKey && !sessionRecoveryError}
              sessionBusy={sessionBusy}
              layout="bar"
              workspaceId={workspace?.id}
              sessionId={selectedSession?.id}
              initialText={composerDraft.text}
              onTextChange={(text) => {
                const current = draftsRef.current.get(composerKey) ?? composerDraft;
                draftsRef.current.set(composerKey, { ...current, text });
              }}
              clips={composerDraft.clips}
              onClipNavigate={(clip) => void navigateContextClip(clip)}
              onClipsChange={(clips) => {
                const current = draftsRef.current.get(composerKey) ?? composerDraft;
                updateComposerDraft({ ...current, clips });
              }}
              skills={sessionSkills}
              onSkillsChange={setSessionSkills}
              beforeSend={async () => paneSaveControllerRef.current?.flushAll() ?? true}
              configuration={sessionConfiguration}
              configurationStatus={sessionConfigurationStatus}
              onConfigurationChange={onConfigurationChange}
              disabledPlaceholder={sessionRecoveryError ? "Retry Session to continue" : "Select or create a Session to send a message"}
              onCancelled={() => setCancelRequested(true)}
              onPendingChange={setPendingPrompt}
              onTrustRequired={onTrustRequired}
            />
          }
        />
      ) : null}
      {unsupportedFile && workspace ? <Modal label="File preview unavailable" onClose={() => setUnsupportedFile(null)}>
        <h2 className="modal-title">Preview unavailable</h2>
        <p className="modal-copy">Wikilot currently previews Markdown and PDF files.</p>
        <p className="trust-dialog-path">{unsupportedFile}</p>
        <div className="modal-actions">
          <button type="button" className="btn-secondary" onClick={() => setUnsupportedFile(null)}>Close</button>
          <button type="button" className="btn-secondary" onClick={async () => {
            try {
              await navigator.clipboard.writeText(`${workspace.cwd.replace(/\/$/, "")}/${unsupportedFile}`);
              showToast("Path copied");
            } catch {
              showToast("Could not copy the path. Try again.");
            }
          }}>Copy path</button>
        </div>
      </Modal> : null}
      {pendingDelete ? (
        <Modal label="Delete Session" onClose={() => setPendingDelete(null)}>
          <h2 className="modal-title">Delete this Session?</h2>
          <p className="modal-copy">
            “{sessionTitle(pendingDelete)}” and its history will be removed.
            This cannot be undone.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              data-testid="session-delete-confirm"
              onClick={() => void onConfirmDelete()}
            >
              Delete Session
            </button>
          </div>
        </Modal>
      ) : null}
      {pendingRemoveWorkspace ? (
        <Modal
          label="Remove from recent workspaces"
          onClose={() => setPendingRemoveWorkspace(null)}
        >
          <h2 className="modal-title">Remove from recent workspaces?</h2>
          <p className="modal-copy">
            “{workspaceName(pendingRemoveWorkspace.cwd)}” is removed from the
            list. Its folder, Sessions, and settings stay on disk.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setPendingRemoveWorkspace(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              data-testid="workspace-remove-confirm"
              onClick={() => void onConfirmRemoveWorkspace()}
            >
              Remove from list
            </button>
          </div>
        </Modal>
      ) : null}
      {trustRequest ? (
        /* A trust decision is required to proceed: the dialog is modal but not
           dismissible (no Esc/backdrop close). */
        <Modal
          label="Trust this Workspace?"
          dismissible={false}
          className="trust-dialog"
        >
          <h2 id="trust-dialog-title" className="modal-title">
            Trust this Workspace?
          </h2>
          <p className="trust-dialog-path">{trustRequest.cwd}</p>
          <p className="trust-dialog-copy">
            Trusting lets the agent load project settings, Extensions, Skills,
            Prompts, and providers.
          </p>
          <div className="trust-dialog-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void onResolveTrust(false)}
            >
              Do not trust
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => void onResolveTrust(true)}
            >
              Trust Workspace
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
