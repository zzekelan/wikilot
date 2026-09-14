/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_DEFAULTS } from "../../shared/settings";
import type {
  ApplicationEvent,
  KnownWorkspaceListResponse,
  SessionListItem,
  WorkspaceSummary,
} from "../../shared/workspace";
import { initialWorkspacePaneState } from "../../shared/workspace";
import { ShortcutProvider } from "../shortcuts";
import { ThemeProvider } from "./theme";
import { ToastProvider } from "../feedback";
import { DesktopShell } from "./DesktopShell";

const WORKSPACE_A: WorkspaceSummary = { id: "--work-a--", cwd: "/work/a" };
const WORKSPACE_B: WorkspaceSummary = { id: "--work-b--", cwd: "/work/b" };

function sessionItem(id: string): SessionListItem {
  return {
    id,
    created: "2026-08-18T00:00:00.000Z",
    modified: "2026-08-18T00:00:00.000Z",
    messageCount: 1,
    firstMessage: `message in ${id}`,
    runtimeStatus: "unloaded",
  };
}

function knownResponse(
  overrides: Partial<KnownWorkspaceListResponse> = {},
): KnownWorkspaceListResponse {
  return {
    workspaces: [
      {
        id: WORKSPACE_A.id,
        cwd: WORKSPACE_A.cwd,
        lastOpenedAt: "2026-08-18T00:00:02.000Z",
        selectedSessionId: "s2",
        hasActiveTurn: false,
      },
      {
        id: WORKSPACE_B.id,
        cwd: WORKSPACE_B.cwd,
        lastOpenedAt: "2026-08-18T00:00:01.000Z",
        hasActiveTurn: false,
      },
    ],
    launchCwd: null,
    ...overrides,
  };
}

const fake = vi.hoisted(() => ({
  telemetry: {
    recordUiGesture: vi.fn(),
  },
  client: {
    openWorkspace: vi.fn(),
    pickWorkspaceDirectory: vi.fn(),
    listKnownWorkspaces: vi.fn(),
    removeKnownWorkspace: vi.fn(),
    listSessions: vi.fn(),
    prepareSession: vi.fn(),
    releaseSession: vi.fn(),
    createSession: vi.fn(),
    openSession: vi.fn(),
    deleteSession: vi.fn(),
    getSessionConfiguration: vi.fn(),
    updateSessionConfiguration: vi.fn(),
    reloadSessionResources: vi.fn(),
    listWorkspaceFiles: vi.fn(),
    openWorkspacePdf: vi.fn(),
    openMarkdownDocument: vi.fn(),
    saveMarkdownDocument: vi.fn(),
    getWorkspaceGraph: vi.fn(),
    retryWorkspaceGraph: vi.fn(),
    getWorkspaceLinkIndex: vi.fn(),
    resolveWorkspaceLink: vi.fn(),
    createWorkspaceMarkdown: vi.fn(),
    workspacePdfSourceUrl: vi.fn((sourceId: string) => `/pdf/${sourceId}`),
    releaseWorkspacePdfSource: vi.fn(async () => {}),
    loadWorkspacePaneState: vi.fn(),
    saveWorkspacePaneState: vi.fn(),
    listProviders: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    getModelCatalog: vi.fn(),
    listCredentials: vi.fn(),
    setCredential: vi.fn(),
    deleteCredential: vi.fn(),
    getAppDefaults: vi.fn(async () => DEFAULT_APP_DEFAULTS),
    getUtilitySettings: vi.fn(async () => ({ model: null })),
    updateUtilitySettings: vi.fn(async (settings) => settings),
    updateAppDefaults: vi.fn(),
    prompt: vi.fn(),
    getProjectTrustRequest: vi.fn(async () => null),
    resolveProjectTrust: vi.fn(),
    abort: vi.fn(),
    getTimelineSnapshot: vi.fn(),
    subscribeEvents: vi.fn((
      _onEvent: (event: ApplicationEvent) => void,
      _onConnected?: () => void,
    ) => () => {}),
  },
}));

vi.mock("../client", () => ({ client: fake.client }));
vi.mock("../telemetry", () => fake.telemetry);
vi.mock("../workspace-pane/PdfReader", () => ({
  PdfReader: ({ onAddContextClip }: { onAddContextClip?: (clip: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onAddContextClip?.({
        source: { kind: "pdf", path: "paper.pdf" },
        text: "evidence",
        fingerprint: "pdf:v1",
        locator: {
          kind: "pdf",
          spans: [{
            page: 1,
            start: 0,
            end: 8,
            exact: "evidence",
            prefix: "",
            suffix: "",
            boxes: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.04 }],
          }],
        },
      })}
    >
      Add mock PDF clip
    </button>
  ),
}));
vi.mock("../workspace-pane/WorkspaceGraph", () => ({ WorkspaceGraph: () => null }));

function renderShell() {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <ShortcutProvider>
          <DesktopShell />
        </ShortcutProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  // jsdom has no layout observer; scroll geometry is verified in the browser.
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  window.sessionStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
  });
  // Restore the capability in case a test removed it, then reset all mocks.
  fake.client.pickWorkspaceDirectory = vi.fn();
  for (const mock of Object.values(fake.client)) mock.mockReset();
  fake.telemetry.recordUiGesture.mockReset();
  // Benign defaults for every query the shell fires on mount.
  fake.client.getAppDefaults.mockResolvedValue(DEFAULT_APP_DEFAULTS);
  fake.client.listProviders.mockResolvedValue([]);
  fake.client.getModelCatalog.mockResolvedValue([]);
  fake.client.prepareSession.mockResolvedValue([]);
  fake.client.releaseSession.mockResolvedValue(undefined);
  fake.client.listCredentials.mockResolvedValue([]);
  fake.client.getProjectTrustRequest.mockResolvedValue(null);
  fake.client.subscribeEvents.mockReturnValue(() => {});
  fake.client.listWorkspaceFiles.mockResolvedValue([]);
  fake.client.openMarkdownDocument.mockImplementation(async (_workspaceId, path) => ({
    path,
    status: "ready" as const,
    version: "v1",
    size: 3,
    content: "# A",
  }));
  fake.client.saveMarkdownDocument.mockImplementation(
    async (_workspaceId, path, _version, content) => ({
      outcome: "saved" as const,
      snapshot: { path, status: "ready" as const, version: "v2", size: content.length, content },
    }),
  );
  fake.client.getWorkspaceGraph.mockResolvedValue({ status: "building" });
  fake.client.getWorkspaceLinkIndex.mockResolvedValue({ status: "building" });
  fake.client.resolveWorkspaceLink.mockResolvedValue({ status: "building" });
  fake.client.createWorkspaceMarkdown.mockResolvedValue({
    path: "New.md",
    kind: "markdown",
    content: "",
  });
  fake.client.loadWorkspacePaneState.mockResolvedValue({
    state: initialWorkspacePaneState(),
    skipped: 0,
  });
  fake.client.saveWorkspacePaneState.mockResolvedValue(undefined);
  fake.client.reloadSessionResources.mockResolvedValue([]);
  fake.client.getTimelineSnapshot.mockImplementation(
    async (workspaceId: string, sessionId: string) => ({
      context: { status: "unavailable" },
      workspaceId,
      sessionId,
      sequence: 0,
      status: "unloaded",
      items: [],
    }),
  );
  fake.client.getSessionConfiguration.mockResolvedValue({
    status: "applied",
    configuration: {
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "medium",
      wikiPromptEnabled: true,
    },
  });
  fake.client.updateSessionConfiguration.mockResolvedValue({
    status: "applied",
    configuration: {
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "medium",
      wikiPromptEnabled: true,
    },
  });
  fake.client.openWorkspace.mockImplementation(async (cwd: string) => {
    if (cwd === WORKSPACE_A.cwd) return WORKSPACE_A;
    if (cwd === WORKSPACE_B.cwd) return WORKSPACE_B;
    throw new Error(`Workspace path does not exist: ${cwd}`);
  });
  fake.client.listKnownWorkspaces.mockResolvedValue(knownResponse());
  fake.client.listSessions.mockImplementation(async (workspaceId: string) =>
    workspaceId === WORKSPACE_A.id
      ? [sessionItem("s1"), sessionItem("s2")]
      : [],
  );
  fake.client.openSession.mockImplementation(
    async (workspaceId: string, sessionId: string) => ({
      workspaceId,
      sessionId,
      action: "open" as const,
      timelineItems: [],
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Timeline model setup", () => {
  it("opens Providers from the empty-catalog checklist and removes the extra step after setup without losing the draft", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(knownResponse({ launchCwd: WORKSPACE_A.cwd }));
    fake.client.getSessionConfiguration.mockResolvedValue({ status: "applied", configuration: {} });
    const { container } = renderShell();
    const connect = await screen.findByRole("button", { name: "Connect a model" });
    expect(connect.closest(".shell-empty-steps")).not.toBeNull();
    expect(container.querySelectorAll(".shell-empty-steps li")).toHaveLength(4);
    expect(container.querySelector(".composer-setup")).toBeNull();
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "Keep this draft" } });
    fireEvent.click(connect);
    expect(fake.telemetry.recordUiGesture).toHaveBeenCalledWith("onboarding.connect-model", { "wikilot.gesture": "onboarding.connect-model" });
    await screen.findByRole("button", { name: "Add Provider" });
    fake.client.getModelCatalog.mockResolvedValue([{ id: "local", name: "Local", models: [{ id: "demo", name: "Demo", thinkingLevels: ["off"] }] }]);
    fireEvent.click(screen.getByRole("button", { name: "Close Settings" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Connect a model" })).toBeNull());
    expect(container.querySelectorAll(".shell-empty-steps li")).toHaveLength(3);
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("Keep this draft");
    fireEvent.click(screen.getByRole("button", { name: "Send a message" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("composer-input")));
  });
});

describe("Session running indicator", () => {
  it("clears a stale background running indicator after the event stream reconnects", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.listSessions.mockResolvedValue([
      { ...sessionItem("s1"), runtimeStatus: "running" }, sessionItem("s2"),
    ]);
    renderShell();
    await screen.findByText("message in s1");
    const row = screen.getByText("message in s1").closest("button")!;
    expect(row.querySelector(".session-badge-running")).not.toBeNull();
    fake.client.listSessions.mockResolvedValue([sessionItem("s1"), sessionItem("s2")]);
    act(() => fake.client.subscribeEvents.mock.calls[0][1]?.());
    await waitFor(() => expect(row.querySelector(".session-badge-running")).toBeNull());
  });

  it("animates only an executing agent, not runtime preparation or disposal", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    renderShell();
    await screen.findByText("message in s1");
    const onEvent = fake.client.subscribeEvents.mock.calls[0][0];
    const row = screen.getByText("message in s1").closest("button")!;
    let sequence = 0;
    for (const status of ["starting", "idle", "running", "idle", "stopping", "unloaded"] as const) {
      act(() => onEvent({
        workspaceId: WORKSPACE_A.id,
        sessionId: "s1",
        sequence: ++sequence,
        at: Date.now(),
        delta: { type: "session_status", status },
      }));
      expect(row.querySelector(".session-badge-running") !== null, status).toBe(status === "running");
    }
  });
});

describe("DesktopShell Sidebar focus", () => {
  it("keeps the collapsed rail interactive and focuses its toggle", async () => {
    renderShell();
    const close = screen.getByRole("button", { name: "Close Sidebar" });
    const rail = screen.getByRole("complementary", { name: "Workspace rail" });
    close.focus();
    fireEvent.click(close);

    const open = screen.getByRole("button", { name: "Open Sidebar" });
    expect(document.activeElement).toBe(open);
    expect(rail.parentElement?.hasAttribute("inert")).toBe(false);
    expect(rail.parentElement?.classList.contains("sidebar-shell-collapsed")).toBe(true);
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();

    fireEvent.click(open);
    expect(document.activeElement).toBe(close);
    expect(rail.parentElement?.hasAttribute("inert")).toBe(false);
    await waitFor(() => expect(fake.client.listKnownWorkspaces).toHaveBeenCalled());
  });
});

describe("DesktopShell Known Workspaces", () => {
  it("revalidates and opens the launch target by path, restoring its remembered Session", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );

    renderShell();

    await waitFor(() =>
      expect(fake.client.openWorkspace).toHaveBeenCalledWith(WORKSPACE_A.cwd),
    );
    // The remembered Session (s2) wins over the most recent (s1).
    await waitFor(() =>
      expect(fake.client.openSession).toHaveBeenCalledWith(
        WORKSPACE_A.id,
        "s2",
      ),
    );
    await waitFor(() =>
      expect(fake.client.prepareSession).toHaveBeenCalledWith(
        WORKSPACE_A.id,
        "s2",
        expect.objectContaining({
          clientId: expect.any(String),
          sequence: expect.any(Number),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("workspace-status")).toBeTruthy(),
    );
  });

  it("falls back to the most recent Session when the remembered one is gone", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.listSessions.mockResolvedValue([sessionItem("s1")]);

    renderShell();

    await waitFor(() =>
      expect(fake.client.openSession).toHaveBeenCalledWith(
        WORKSPACE_A.id,
        "s1",
      ),
    );
  });

  it("renders Sessions as one ungrouped list without a repeated heading", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );

    renderShell();

    await screen.findByTestId("session-list");
    expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();
    expect(screen.queryByText("Earlier")).toBeNull();
    expect(screen.queryByText("Today")).toBeNull();
    expect(screen.queryByText("Yesterday")).toBeNull();
  });

  it("keeps an unavailable launch target known, selects nothing, and reports the failure", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: "/gone" }),
    );

    renderShell();

    await waitFor(() =>
      expect(screen.getByTestId("workspace-error").textContent).toMatch(
        /does not exist/i,
      ),
    );
    fireEvent.click(screen.getByLabelText("Dismiss error"));
    expect(screen.queryByTestId("workspace-error")).toBeNull();
    // No Workspace is opened and no other entry is chosen silently.
    expect(fake.client.openWorkspace).toHaveBeenCalledTimes(1);
    expect(fake.client.openWorkspace).toHaveBeenCalledWith("/gone");
    expect(fake.client.openSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-status")).toBeNull();
  });

  it("switches via the Known Workspace list; a failed switch keeps the current Workspace and retries", async () => {
    renderShell();

    // Open Workspace A manually (remembered Session s2 is restored).
    fake.client.pickWorkspaceDirectory.mockResolvedValue(WORKSPACE_A.cwd);
    fireEvent.click(screen.getByTestId("workspace-browse"));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-status")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(fake.client.openSession).toHaveBeenCalledWith(
        WORKSPACE_A.id,
        "s2",
      ),
    );

    // Expand the switcher and select Workspace B while it is unavailable.
    fireEvent.click(screen.getByLabelText("Change Workspace"));
    const knownItems = screen.getAllByTestId("workspace-known-item");
    const itemB = knownItems.find(
      (item) => item.getAttribute("data-workspace-cwd") === WORKSPACE_B.cwd,
    )!;
    fake.client.openWorkspace.mockImplementation(async (cwd: string) => {
      if (cwd === WORKSPACE_A.cwd) return WORKSPACE_A;
      throw new Error(`Workspace path does not exist: ${cwd}`);
    });
    fireEvent.click(itemB);

    await waitFor(() =>
      expect(screen.getByTestId("workspace-error").textContent).toMatch(
        /does not exist/i,
      ),
    );
    // The current Selected Workspace is intact: A stays in the summary bar,
    // its Sessions stay listed, and no Session switch happened.
    expect(screen.getByTestId("workspace-status").textContent).toContain("a");
    expect(screen.getByTestId("session-list").textContent).toContain(
      "message in s2",
    );
    expect(fake.client.openSession).toHaveBeenCalledTimes(1);

    // Selecting the failed item again retries — now it succeeds.
    fake.client.openWorkspace.mockImplementation(async (cwd: string) => {
      if (cwd === WORKSPACE_A.cwd) return WORKSPACE_A;
      if (cwd === WORKSPACE_B.cwd) return WORKSPACE_B;
      throw new Error(`Workspace path does not exist: ${cwd}`);
    });
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_B.cwd }),
    );
    fireEvent.click(
      screen
        .getAllByTestId("workspace-known-item")
        .find(
          (item) => item.getAttribute("data-workspace-cwd") === WORKSPACE_B.cwd,
        )!,
    );
    await waitFor(() =>
      expect(screen.getByTestId("workspace-status").textContent).toContain("b"),
    );
    expect(screen.getByTestId("workspace-status").getAttribute("title")).toBe(
      WORKSPACE_B.cwd,
    );
    // Workspace B has no Sessions, so no Selected Session is restored.
    expect(screen.getByTestId("session-list-empty")).toBeTruthy();
  });

  it("expands and collapses the Workspace controls from the summary bar", async () => {
    renderShell();
    fake.client.pickWorkspaceDirectory.mockResolvedValue(WORKSPACE_A.cwd);
    fireEvent.click(screen.getByTestId("workspace-browse"));

    const workspaceBar = await screen.findByTestId("workspace-status");
    await waitFor(() =>
      expect(workspaceBar.getAttribute("aria-expanded")).toBe("false"),
    );
    expect(screen.queryByTestId("workspace-known-list")).toBeNull();
    const newSession = screen.getByTestId("session-new");
    const graph = screen.getByRole("button", { name: "Open Graph" });
    expect(workspaceBar.closest("section")?.nextElementSibling).toBe(
      newSession,
    );
    expect(newSession.nextElementSibling).toBe(graph);
    expect(newSession.classList.contains("sidebar-primary-row")).toBe(true);
    expect(graph.classList.contains("sidebar-primary-row")).toBe(true);
    expect(workspaceBar.classList.contains("sidebar-primary-row")).toBe(true);

    fireEvent.click(workspaceBar);
    expect(workspaceBar.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("workspace-known-list")).toBeTruthy();
    expect(workspaceBar.textContent).toBe("a");
    expect(workspaceBar.getAttribute("title")).toBe(WORKSPACE_A.cwd);
    expect(
      screen
        .getAllByTestId("workspace-known-item")
        .some(
          (item) => item.getAttribute("data-workspace-cwd") === WORKSPACE_A.cwd,
        ),
    ).toBe(true);

    expect(screen.queryByTestId("workspace-path")).toBeNull();
    expect(screen.queryByText("Enter path manually…")).toBeNull();

    fireEvent.click(workspaceBar);
    expect(workspaceBar.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("workspace-known-list")).toBeNull();
  });

  it("removes another Known Workspace without changing the selection", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    renderShell();
    await waitFor(() =>
      expect(screen.getByTestId("workspace-status")).toBeTruthy(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("session-new").hasAttribute("disabled")).toBe(
        false,
      ),
    );

    fireEvent.click(screen.getByLabelText("Change Workspace"));
    fireEvent.click(screen.getByLabelText(`Workspace options: b`));
    fireEvent.click(screen.getByLabelText(`Remove Workspace: b`));
    fireEvent.click(await screen.findByTestId("workspace-remove-confirm"));

    await waitFor(() =>
      expect(fake.client.removeKnownWorkspace).toHaveBeenCalledWith(
        WORKSPACE_B.id,
      ),
    );
    expect(screen.getByTestId("workspace-status").textContent).toContain(
      "a",
    );
    expect(fake.client.openWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("DesktopShell native directory chooser", () => {
  it("opens the picked directory through the same validated Workspace flow", async () => {
    fake.client.pickWorkspaceDirectory.mockResolvedValue(WORKSPACE_A.cwd);

    renderShell();
    fireEvent.click(screen.getByTestId("workspace-browse"));

    await waitFor(() =>
      expect(fake.client.openWorkspace).toHaveBeenCalledWith(WORKSPACE_A.cwd),
    );
    await waitFor(() =>
      expect(screen.getByTestId("workspace-status")).toBeTruthy(),
    );
  });

  it("stays silent when the chooser is cancelled", async () => {
    fake.client.pickWorkspaceDirectory.mockResolvedValue(null);

    renderShell();
    fireEvent.click(screen.getByTestId("workspace-browse"));

    await waitFor(() =>
      expect(fake.client.pickWorkspaceDirectory).toHaveBeenCalled(),
    );
    expect(fake.client.openWorkspace).not.toHaveBeenCalled();
    expect(screen.queryByTestId("workspace-error")).toBeNull();
    expect(screen.queryByTestId("workspace-status")).toBeNull();
  });

  it("reports chooser failures without destroying the current selection", async () => {
    renderShell();
    fake.client.pickWorkspaceDirectory.mockResolvedValue(WORKSPACE_A.cwd);
    fireEvent.click(screen.getByTestId("workspace-browse"));
    await waitFor(() =>
      expect(screen.getByTestId("workspace-status")).toBeTruthy(),
    );

    await waitFor(() => expect(screen.getByLabelText("Change Workspace").hasAttribute("disabled")).toBe(false));
    fake.client.pickWorkspaceDirectory.mockRejectedValue(
      new Error("The macOS directory chooser failed: boom"),
    );
    fireEvent.click(screen.getByLabelText("Change Workspace"));
    fireEvent.click(screen.getByTestId("workspace-browse"));

    await waitFor(() =>
      expect(screen.getByTestId("workspace-picker-error").textContent).toMatch(
        /chooser failed: boom/,
      ),
    );
    expect(screen.queryByTestId("workspace-error")).toBeNull();
    fireEvent.click(screen.getByLabelText("Dismiss folder error"));
    expect(screen.queryByTestId("workspace-picker-error")).toBeNull();
    fireEvent.click(screen.getByLabelText("Change Workspace"));
    // The current Workspace remains checked in the switcher.
    expect(screen.getByTestId("workspace-status").textContent).toContain("a");
    expect(
      screen
        .getAllByTestId("workspace-known-item")
        .some(
          (item) => item.getAttribute("data-workspace-cwd") === WORKSPACE_A.cwd,
        ),
    ).toBe(true);
  });

  it("hides the chooser button when the Host has no picker capability", async () => {
    (
      fake.client as { pickWorkspaceDirectory?: unknown }
    ).pickWorkspaceDirectory = undefined;

    fake.client.listKnownWorkspaces.mockResolvedValue(knownResponse({ workspaces: [] }));
    renderShell();
    expect(document.getElementById("workspace-trigger")!.hasAttribute("disabled")).toBe(true);
    expect(screen.queryByTestId("workspace-path")).toBeNull();

    expect(screen.queryByTestId("workspace-browse")).toBeNull();
  });
});

describe("DesktopShell Workspace Pane sizing", () => {
  it("does not let a stale Link Index response overwrite a newer event revision", async () => {
    let onEvent: ((event: ApplicationEvent) => void) | undefined;
    let resolveStale: ((snapshot: {
      status: "ready";
      revision: number;
      targets: [];
      records: [];
      propertyRegistry: [];
    }) => void) | undefined;
    const stale = new Promise<{
      status: "ready";
      revision: number;
      targets: [];
      records: [];
      propertyRegistry: [];
    }>((resolve) => { resolveStale = resolve; });
    fake.client.subscribeEvents.mockImplementation((next) => {
      onEvent = next;
      return () => {};
    });
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.getWorkspaceLinkIndex
      .mockResolvedValueOnce({ status: "ready", revision: 1, targets: [], records: [], propertyRegistry: [] })
      .mockReturnValueOnce(stale)
      .mockResolvedValue({ status: "ready", revision: 2, targets: [], records: [], propertyRegistry: [] });

    renderShell();
    await waitFor(() => expect(fake.client.getWorkspaceLinkIndex.mock.calls.length).toBeGreaterThan(1));
    fake.client.getWorkspaceGraph.mockClear();

    await act(async () => {
      onEvent?.({
        type: "workspace_link_index_changed",
        workspaceId: WORKSPACE_A.id,
        revision: 2,
      });
      resolveStale?.({ status: "ready", revision: 1, targets: [], records: [], propertyRegistry: [] });
      await stale;
    });

    await waitFor(() => expect(fake.client.getWorkspaceGraph).toHaveBeenCalled());
    await waitFor(() => expect(fake.client.getWorkspaceLinkIndex.mock.calls.length).toBeGreaterThan(2));
  });

  it("resynchronizes the Link Index whenever the browser event stream reconnects", async () => {
    let onConnected: (() => void) | undefined;
    fake.client.subscribeEvents.mockImplementation((_onEvent, connected) => {
      onConnected = connected;
      return () => {};
    });
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.getWorkspaceLinkIndex
      .mockResolvedValueOnce({ status: "ready", revision: 1, targets: [], records: [], propertyRegistry: [] })
      .mockResolvedValue({ status: "ready", revision: 2, targets: [], records: [], propertyRegistry: [] });

    renderShell();
    await waitFor(() => expect(fake.client.getWorkspaceLinkIndex).toHaveBeenCalled());
    onConnected?.();

    await waitFor(() => expect(fake.client.getWorkspaceLinkIndex.mock.calls.length).toBeGreaterThan(1));
  });

  it("removes the Sidebar resizer while the Workspace Pane is wide", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.loadWorkspacePaneState.mockResolvedValue({
      state: {
        tabs: ["a.md"], activePath: "a.md", mru: ["a.md"], positions: {},
        modes: { "a.md": "reading" }, editorSelections: {}, pdfViews: {},
        visible: true,
        readingMode: "wide", history: ["a.md"], historyIndex: 0,
      },
      skipped: 0,
    });
    fake.client.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: 7, content: "# Notes",
    });

    renderShell();
    await screen.findByRole("button", { name: "Exit Wide Mode" });
    expect(screen.queryByLabelText("Resize Sidebar")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Exit Wide Mode" }));
    expect(screen.getByLabelText("Resize Sidebar")).toBeTruthy();
  });

  it("defaults to a width that fits common PDF pages in a roomy window", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1600,
    });
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.listWorkspaceFiles.mockResolvedValue([
      { name: "paper.pdf", path: "paper.pdf", kind: "file" },
    ]);

    const { container } = renderShell();
    await screen.findByTestId("workspace-status");
    fireEvent.click(screen.getByTestId("left-mode-files"));
    fireEvent.click(await screen.findByTestId("file-tree-file"));

    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        "--workspace-pane-width",
      ),
    ).toBe("640px");
  });

  it("saves column widths per Workspace and restores them after switching, reload, and window resizing", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1800 });
    fake.client.listKnownWorkspaces.mockResolvedValue(knownResponse({ launchCwd: WORKSPACE_A.cwd }));
    const saved = new Map<string, ReturnType<typeof initialWorkspacePaneState>>([
      [WORKSPACE_A.id, { ...initialWorkspacePaneState(), visible: true, columnWidths: { sidebar: 300, pane: 900 } }],
      [WORKSPACE_B.id, { ...initialWorkspacePaneState(), columnWidths: { sidebar: 220, pane: 500 } }],
    ]);
    fake.client.loadWorkspacePaneState.mockImplementation(async (id: string) => ({ state: saved.get(id)!, skipped: 0 }));
    fake.client.saveWorkspacePaneState.mockImplementation(async (id: string, state: ReturnType<typeof initialWorkspacePaneState>) => { saved.set(id, state); });
    let shell = renderShell();
    const widths = () => {
      const style = (shell.container.firstElementChild as HTMLElement).style;
      return [style.getPropertyValue("--sidebar-width"), style.getPropertyValue("--workspace-pane-width")];
    };
    await waitFor(() => expect(widths()).toEqual(["300px", "900px"]));
    fireEvent.keyDown(screen.getByLabelText("Resize Sidebar"), { key: "ArrowRight" });
    fireEvent.keyDown(screen.getByLabelText("Resize Workspace Pane"), { key: "ArrowLeft" });
    await waitFor(() => expect(saved.get(WORKSPACE_A.id)?.columnWidths).toEqual({ sidebar: 316, pane: 916 }));
    fireEvent.click(screen.getByLabelText("Change Workspace"));
    fireEvent.click(screen.getAllByTestId("workspace-known-item").find(item => item.getAttribute("data-workspace-cwd") === WORKSPACE_B.cwd)!);
    await waitFor(() => expect(widths()).toEqual(["220px", "500px"]));
    fireEvent.click(screen.getByLabelText("Change Workspace"));
    fireEvent.click(screen.getAllByTestId("workspace-known-item").find(item => item.getAttribute("data-workspace-cwd") === WORKSPACE_A.cwd)!);
    await waitFor(() => expect(widths()).toEqual(["316px", "916px"]));
    shell.unmount();
    shell = renderShell();
    await waitFor(() => expect(widths()).toEqual(["316px", "916px"]));
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
    fireEvent(window, new Event("resize"));
    expect(widths()).toEqual(["316px", "456px"]);
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1800 });
    fireEvent(window, new Event("resize"));
    expect(widths()).toEqual(["316px", "916px"]);
    expect(saved.get(WORKSPACE_A.id)?.columnWidths).toEqual({ sidebar: 316, pane: 916 });
  });

  it("clamps the preferred width to the available room and a 320px floor", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 896,
    });
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.listWorkspaceFiles.mockResolvedValue([
      { name: "paper.pdf", path: "paper.pdf", kind: "file" },
    ]);

    const { container } = renderShell();
    await screen.findByTestId("workspace-status");
    fireEvent.click(screen.getByTestId("left-mode-files"));
    fireEvent.click(await screen.findByTestId("file-tree-file"));

    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        "--workspace-pane-width",
      ),
    ).toBe("512px");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
    fireEvent(window, new Event("resize"));
    expect((container.firstElementChild as HTMLElement).style.getPropertyValue("--workspace-pane-width")).toBe("320px");
  });

  it("lets the Workspace Pane grow beyond 720px while preserving the main pane", async () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1600,
    });
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.listWorkspaceFiles.mockResolvedValue([
      { name: "paper.pdf", path: "paper.pdf", kind: "file" },
    ]);

    const { container } = renderShell();
    await screen.findByTestId("workspace-status");
    fireEvent.click(screen.getByTestId("left-mode-files"));
    fireEvent.click(await screen.findByTestId("file-tree-file"));

    const paneResizer = screen.getByLabelText("Resize Workspace Pane");
    for (let index = 0; index < 80; index += 1) {
      fireEvent.keyDown(paneResizer, { key: "ArrowLeft" });
    }

    expect(
      (container.firstElementChild as HTMLElement).style.getPropertyValue(
        "--workspace-pane-width",
      ),
    ).toBe("1016px");
  });

  it("captures rendered Markdown into the Selected Session Composer and sends a structured Prompt", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.loadWorkspacePaneState.mockResolvedValue({
      state: {
        tabs: ["a.md"],
        activePath: "a.md",
        mru: ["a.md"],
        positions: {},
        modes: { "a.md": "reading" },
        editorSelections: {},
        pdfViews: {},
        visible: true,
        readingMode: "normal",
        history: ["a.md"],
        historyIndex: 0,
      },
      skipped: 0,
    });
    fake.client.openMarkdownDocument.mockResolvedValue({
      path: "a.md",
      status: "ready",
      version: "v1",
      size: 38,
      content: "# Evidence\n\nSelect this passage today.",
    });
    fake.client.prompt
      .mockRejectedValueOnce(new Error("Prompt record write failed"))
      .mockResolvedValue(undefined);

    renderShell();
    const paragraph = await screen.findByText("Select this passage today.");
    await waitFor(() => expect(fake.client.openSession).toHaveBeenCalled());
    const textNode = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, "Select ".length);
    range.setEnd(textNode, "Select this passage".length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(paragraph.closest("article")!);

    fireEvent.click(await screen.findByRole("button", { name: "Ask Wikilot" }));
    expect(await screen.findByRole("button", { name: "1 clip" })).toBeTruthy();

    const duplicateParagraph = await screen.findByText("Select this passage today.");
    const duplicateNode = duplicateParagraph.firstChild!;
    const duplicateRange = document.createRange();
    duplicateRange.setStart(duplicateNode, "Select ".length);
    duplicateRange.setEnd(duplicateNode, "Select this passage".length);
    selection.addRange(duplicateRange);
    fireEvent.mouseUp(duplicateParagraph.closest("article")!);
    fireEvent.click(await screen.findByRole("button", { name: "Ask Wikilot" }));
    expect(await screen.findByText("This selection is already in the Composer")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "1 clip" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fake.client.prompt).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_A.id,
      sessionId: "s2",
      text: "",
      clips: [expect.objectContaining({
        source: { kind: "markdown", path: "a.md" },
        text: "this passage",
        fingerprint: expect.stringMatching(/^fnv1a:/),
        locator: expect.objectContaining({ kind: "markdown", mode: "reading" }),
      })],
    }));
    expect(await screen.findByText("Prompt record write failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "1 clip" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(fake.client.prompt).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "1 clip" })).toBeNull());
  });

  it("keeps text and ordered Clips in separate per-Session drafts", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.loadWorkspacePaneState.mockResolvedValue({
      state: {
        tabs: ["a.md"], activePath: "a.md", mru: ["a.md"], positions: {},
        modes: { "a.md": "reading" }, editorSelections: {}, pdfViews: {},
        visible: true,
        readingMode: "normal", history: ["a.md"], historyIndex: 0,
      },
      skipped: 0,
    });
    const content = "# Evidence\n\nKeep this source.";
    fake.client.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: content.length, content,
    });

    renderShell();
    const paragraph = await screen.findByText("Keep this source.");
    await waitFor(() => expect(fake.client.openSession).toHaveBeenCalledWith(WORKSPACE_A.id, "s2"));
    const textNode = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, "Keep this source".length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(paragraph.closest("article")!);
    fireEvent.click(await screen.findByRole("button", { name: "Ask Wikilot" }));
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "draft for s2" } });

    const sessionRow = (id: string) => screen.getAllByTestId("session-list-item")
      .find((item) => item.getAttribute("data-session-id") === id)!;
    fireEvent.click(sessionRow("s1"));
    await waitFor(() => expect(fake.client.openSession).toHaveBeenCalledWith(WORKSPACE_A.id, "s1"));
    expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "1 clip" })).toBeNull();
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "draft for s1" } });

    fireEvent.click(sessionRow("s2"));
    await waitFor(() => expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).value).toBe("draft for s2"));
    expect(screen.getByRole("button", { name: "1 clip" })).toBeTruthy();
  });

  it("keeps a Clip after its source Tab closes and does not reopen a deleted source", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.loadWorkspacePaneState.mockResolvedValue({
      state: {
        tabs: ["a.md"], activePath: "a.md", mru: ["a.md"], positions: {},
        modes: { "a.md": "reading" }, editorSelections: {}, pdfViews: {},
        visible: true,
        readingMode: "normal", history: ["a.md"], historyIndex: 0,
      },
      skipped: 0,
    });
    const content = "# Source\n\nOld source text.";
    fake.client.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "ready", version: "v1", size: content.length, content,
    });

    renderShell();
    const paragraph = await screen.findByText("Old source text.");
    await waitFor(() => expect(fake.client.openSession).toHaveBeenCalledWith(WORKSPACE_A.id, "s2"));
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(paragraph.closest("article")!);
    fireEvent.click(await screen.findByRole("button", { name: "Ask Wikilot" }));
    fireEvent.click(screen.getByRole("button", { name: "Close a.md" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "a.md" })).toBeNull());
    expect(screen.getByRole("button", { name: "1 clip" })).toBeTruthy();

    fake.client.openMarkdownDocument.mockResolvedValue({
      path: "a.md", status: "deleted", version: null, size: null,
    });
    fireEvent.click(screen.getByRole("button", { name: "1 clip" }));
    fireEvent.click(screen.getByRole("button", { name: /open clip 1 source/i }));

    expect(await screen.findByText("Context Clip source is unavailable")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "a.md" })).toBeNull();
  });

  it("navigates an active PDF Clip without reopening the loaded source", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.loadWorkspacePaneState.mockResolvedValue({
      state: {
        tabs: ["paper.pdf"], activePath: "paper.pdf", mru: ["paper.pdf"], positions: {},
        modes: { "paper.pdf": "reading" }, editorSelections: {}, pdfViews: {},
        visible: true,
        readingMode: "normal", history: ["paper.pdf"], historyIndex: 0,
      },
      skipped: 0,
    });
    fake.client.openWorkspacePdf.mockResolvedValue({
      sourceId: "source-v1", version: "v1", size: 1000, mediaType: "application/pdf",
    });

    renderShell();
    await screen.findByRole("tab", { name: "paper.pdf" });
    await waitFor(() => expect(fake.client.openWorkspacePdf).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Add mock PDF clip" }));
    fireEvent.click(await screen.findByRole("button", { name: "1 clip" }));
    fireEvent.click(screen.getByRole("button", { name: "Open clip 1 source" }));

    await waitFor(() => expect(fake.telemetry.recordUiGesture).toHaveBeenCalledWith(
      "context_clip.navigate",
      { "wikilot.gesture": "context_clip.navigate" },
    ));
    expect(fake.client.openWorkspacePdf).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("tab", { name: "paper.pdf", selected: true })).toBeTruthy();
  });

  it("revalidates a closed PDF Clip source and keeps it closed when it was deleted", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.loadWorkspacePaneState.mockResolvedValue({
      state: {
        tabs: ["paper.pdf"], activePath: "paper.pdf", mru: ["paper.pdf"], positions: {},
        modes: { "paper.pdf": "reading" }, editorSelections: {}, pdfViews: {},
        visible: true,
        readingMode: "normal", history: ["paper.pdf"], historyIndex: 0,
      },
      skipped: 0,
    });
    fake.client.openWorkspacePdf
      .mockResolvedValueOnce({
        sourceId: "source-v1", version: "v1", size: 1000, mediaType: "application/pdf",
      })
      .mockRejectedValue(new Error("deleted"));

    renderShell();
    await screen.findByRole("tab", { name: "paper.pdf" });
    await waitFor(() => expect(fake.client.openWorkspacePdf).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Add mock PDF clip" }));
    fireEvent.click(screen.getByRole("button", { name: "Close paper.pdf" }));
    fireEvent.click(await screen.findByRole("button", { name: "1 clip" }));
    fireEvent.click(screen.getByRole("button", { name: "Open clip 1 source" }));

    expect(await screen.findByText("Context Clip source is unavailable")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "paper.pdf" })).toBeNull();
    expect(fake.client.openWorkspacePdf).toHaveBeenCalledTimes(2);
  });

  it("restores the Workspace Pane snapshot on open and persists navigation changes", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.openMarkdownDocument.mockResolvedValue({
      path: "a.md",
      status: "ready",
      version: "v1",
      size: 3,
      content: "# A",
    });
    fake.client.loadWorkspacePaneState.mockResolvedValue({
      state: {
        tabs: ["a.md"],
        activePath: "a.md",
        mru: ["a.md"],
        positions: { "a.md": 12 },
        modes: { "a.md": "reading" },
        editorSelections: {},
        pdfViews: {},
        visible: true,
        readingMode: "normal",
        history: ["a.md"],
        historyIndex: 0,
      },
      skipped: 0,
    });
    fake.client.listWorkspaceFiles.mockResolvedValue([
      { name: "b.md", path: "b.md", kind: "file" },
    ]);

    renderShell();
    await screen.findByTestId("workspace-status");

    await waitFor(() =>
      expect(fake.client.loadWorkspacePaneState).toHaveBeenCalledWith(WORKSPACE_A.id),
    );
    expect(await screen.findByRole("tab", { name: "a.md" })).toBeTruthy();
    expect(screen.queryByTestId("pane-restore-banner")).toBeNull();

    fireEvent.click(screen.getByTestId("left-mode-files"));
    fireEvent.click(await screen.findByTestId("file-tree-file"));
    await waitFor(() =>
      expect(fake.client.saveWorkspacePaneState).toHaveBeenCalledWith(
        WORKSPACE_A.id,
        expect.objectContaining({ tabs: ["a.md", "b.md"] }),
      ),
    );
  });

  it("open-or-activates resolved Workspace links and creates safe missing notes explicitly", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.loadWorkspacePaneState.mockResolvedValue({
      state: {
        tabs: ["a.md"],
        activePath: "a.md",
        mru: ["a.md"],
        positions: {},
        modes: { "a.md": "reading" },
        editorSelections: {},
        pdfViews: {},
        visible: true,
        readingMode: "normal",
        history: ["a.md"],
        historyIndex: 0,
      },
      skipped: 0,
    });
    fake.client.getWorkspaceLinkIndex.mockResolvedValue({
      status: "ready",
      revision: 3,
      targets: [],
      records: [],
    });
    fake.client.openMarkdownDocument.mockImplementation(async (_workspaceId: string, path: string) => ({
      path,
      status: "ready",
      version: `version-${path}`,
      size: 1,
      content: path === "a.md" ? "[Target](Target.md) [[Missing]]" : `# ${path}`,
    }));
    fake.client.resolveWorkspaceLink.mockImplementation(async (
      _workspaceId: string,
      request: { authoredTarget: string },
    ) => request.authoredTarget === "Missing"
      ? {
          status: "ready",
          revision: 3,
          target: { status: "missing", creationSuggestion: { path: "Missing.md" } },
        }
      : {
          status: "ready",
          revision: 3,
          target: { status: "resolved", path: "Target.md", kind: "markdown" },
        });

    renderShell();
    await screen.findByRole("tab", { name: "a.md" });
    fireEvent.click(await screen.findByRole("link", { name: "Target" }));
    expect(await screen.findByRole("tab", { name: "Target.md" })).toBeTruthy();
    expect(fake.telemetry.recordUiGesture).toHaveBeenCalledWith(
      "workspace.link.navigate",
      {
        "wikilot.gesture": "workspace.link.navigate",
        "wikilot.link.kind": "markdown",
      },
    );

    fireEvent.click(screen.getByRole("tab", { name: "a.md" }));
    fireEvent.click(await screen.findByRole("button", { name: "Missing" }));
    await waitFor(() => expect(fake.client.createWorkspaceMarkdown).toHaveBeenCalledWith(
      WORKSPACE_A.id,
      "Missing.md",
    ));
    expect(await screen.findByRole("tab", { name: "Missing.md" })).toBeTruthy();
    expect(fake.telemetry.recordUiGesture).toHaveBeenCalledWith(
      "workspace.link.create",
      {
        "wikilot.gesture": "workspace.link.create",
        "wikilot.link.kind": "markdown",
      },
    );
  });

  it("shows the one-time restore banner when stored Pane items were skipped", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(
      knownResponse({ launchCwd: WORKSPACE_A.cwd }),
    );
    fake.client.openMarkdownDocument.mockResolvedValue({
      path: "a.md",
      status: "ready",
      version: "v1",
      size: 3,
      content: "# A",
    });
    fake.client.loadWorkspacePaneState.mockResolvedValue({
      state: {
        tabs: ["a.md"],
        activePath: "a.md",
        mru: ["a.md"],
        positions: {},
        modes: { "a.md": "reading" },
        editorSelections: {},
        pdfViews: {},
        visible: true,
        readingMode: "normal",
        history: ["a.md"],
        historyIndex: 0,
      },
      skipped: 3,
    });

    renderShell();
    expect(await screen.findByTestId("pane-restore-banner")).toBeTruthy();
    expect(screen.getByTestId("pane-restore-banner").textContent).toMatch(
      /skipped 3 invalid items/i,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("pane-restore-banner")).toBeNull();
  });
});

describe("DesktopShell Host recovery", () => {
  it("reopens the saved path before using its ids and preserves this tab's Session", async () => {
    sessionStorage.setItem("wikilot.selected-session", JSON.stringify({
      workspace: WORKSPACE_A, selectedSession: { id: "s1", action: "open" },
    }));
    let opened = false;
    let finishOpen!: (value: WorkspaceSummary) => void;
    fake.client.openWorkspace.mockImplementation(() => new Promise<WorkspaceSummary>((resolve) => {
      finishOpen = (value) => { opened = true; resolve(value); };
    }));
    fake.client.listSessions.mockImplementation(async () => {
      expect(opened).toBe(true);
      return [sessionItem("s1"), sessionItem("s2")];
    });
    renderShell();
    await waitFor(() => expect(fake.client.openWorkspace).toHaveBeenCalledWith(WORKSPACE_A.cwd));
    expect(fake.client.getSessionConfiguration).not.toHaveBeenCalled();
    expect(fake.client.getTimelineSnapshot).not.toHaveBeenCalled();
    expect(fake.client.prepareSession).not.toHaveBeenCalled();
    await act(async () => finishOpen(WORKSPACE_A));
    await waitFor(() => expect(fake.client.openSession).toHaveBeenCalledWith(WORKSPACE_A.id, "s1"));
    await waitFor(() => expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(false));
  });

  it("ends loading on snapshot failure and restores through Retry Session", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(knownResponse({ launchCwd: WORKSPACE_A.cwd }));
    fake.client.getTimelineSnapshot.mockRejectedValue(new Error("Snapshot unavailable"));
    renderShell();
    await screen.findByText("Snapshot unavailable");
    expect(screen.queryByText("Restoring Session…")).toBeNull();
    expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(true);
    fake.client.getTimelineSnapshot.mockResolvedValue({
      workspaceId: WORKSPACE_A.id, sessionId: "s2", sequence: 0, status: "idle",
      context: { status: "unavailable" }, items: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry Session" }));
    await waitFor(() => expect(screen.queryByText("Snapshot unavailable")).toBeNull());
    await waitFor(() => expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(false));
  });

  it("does not treat failed preparation as ready to send, while allowing model repair", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(knownResponse({ launchCwd: WORKSPACE_A.cwd }));
    fake.client.prepareSession.mockRejectedValue(new Error("Model not available"));
    renderShell();
    await screen.findByText("Model not available");
    fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "Keep my draft" } });
    expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("composer-model-chip") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Enter" });
    expect(fake.client.prompt).not.toHaveBeenCalled();
  });

  it("reopens Workspace and Session before recovering after SSE reconnect", async () => {
    fake.client.listKnownWorkspaces.mockResolvedValue(knownResponse({ launchCwd: WORKSPACE_A.cwd }));
    renderShell();
    await waitFor(() => expect(fake.client.prepareSession).toHaveBeenCalled());
    fake.client.openWorkspace.mockClear(); fake.client.openSession.mockClear();
    fake.client.getTimelineSnapshot.mockClear();
    act(() => fake.client.subscribeEvents.mock.calls[0][1]?.());
    await waitFor(() => expect(fake.client.openSession).toHaveBeenCalledWith(WORKSPACE_A.id, "s2"));
    expect(fake.client.openWorkspace.mock.invocationCallOrder[0]).toBeLessThan(fake.client.openSession.mock.invocationCallOrder[0]);
    await waitFor(() => expect(fake.client.getTimelineSnapshot).toHaveBeenCalled());
    expect(fake.client.openSession.mock.invocationCallOrder[0]).toBeLessThan(fake.client.getTimelineSnapshot.mock.invocationCallOrder[0]);
  });
});

it("ignores a snapshot failure from before the latest connection recovery", async () => {
  fake.client.listKnownWorkspaces.mockResolvedValue(knownResponse({ launchCwd: WORKSPACE_A.cwd }));
  let rejectOld!: (error: Error) => void;
  fake.client.getTimelineSnapshot.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  renderShell();
  await waitFor(() => expect(fake.client.getTimelineSnapshot).toHaveBeenCalledOnce());
  act(() => fake.client.subscribeEvents.mock.calls[0][1]?.());
  await waitFor(() => expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(false));
  await act(async () => rejectOld(new Error("Old Host snapshot failed")));
  expect(screen.queryByText("Old Host snapshot failed")).toBeNull();
  expect((screen.getByTestId("composer-input") as HTMLTextAreaElement).disabled).toBe(false);
});
