import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDefaults } from "../../shared/settings";
import type { TimelineDelta } from "../../shared/timeline";
import type { SessionSelectionToken } from "../../shared/workspace";
import type { SessionWorker } from "./runtime/session-worker";
import type { WorkerResourceState } from "./runtime/worker-protocol";
import type { SessionConfig } from "./session-config";
import { createSessionModuleWithAdapters } from "./session-module";
import { createTestWorkspaces } from "./test-workspaces";

type ControllableWorker = SessionWorker & {
  emit(delta: TimelineDelta): void;
  releasePrompt(): void;
};

function controllableWorker(): ControllableWorker {
  const listeners = new Set<(delta: TimelineDelta) => void>();
  let releasePrompt: (() => void) | undefined;
  return {
    start: vi.fn(async (): Promise<WorkerResourceState> => ({
      skills: [],
      modelReady: true,
    })),
    prompt: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasePrompt = resolve;
        }),
    ),
    abort: vi.fn(async () => {}),
    configure: vi.fn(async () => ({ applied: true as const })),
    reload: vi.fn(async (): Promise<WorkerResourceState> => ({
      skills: [],
      modelReady: true,
    })),
    shutdown: vi.fn(async () => {}),
    onTimelineEvent: (listener) => listeners.add(listener),
    onPromptContext: vi.fn(),
    onExit: vi.fn(),
    emit(delta) {
      for (const listener of listeners) listener(delta);
    },
    releasePrompt() {
      releasePrompt?.();
    },
  };
}

function selectionToken(sequence: number): SessionSelectionToken {
  return { clientId: "test-renderer", sequence };
}

describe("SessionModule", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function setup(
    projectDefaults: SessionConfig = {},
    appDefaults: AppDefaults = {
      sessionModel: {
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "medium",
      },
      wikiPromptEnabled: true,
    },
  ) {
    const root = mkdtempSync(join(tmpdir(), "wikilot-session-module-"));
    roots.push(root);
    const workspaces = createTestWorkspaces();
    const workers: ControllableWorker[] = [];
    const modelChangeListeners = new Set<(providerId: string) => void>();
    const setSessionModelDefault = vi.fn();
    const modelRuntime = {
      getModel: vi.fn(() => ({
        id: "gpt-4.1",
        provider: "openai",
        reasoning: true,
      })),
      getModels: vi.fn(() => [
        { provider: "ambient", id: "hidden-model" },
        { provider: "openai", id: "gpt-4.1" },
      ]),
      getAuth: vi.fn(async () => ({ type: "api_key" })),
    } as unknown as ModelRuntime;
    const sessions = createSessionModuleWithAdapters(
      {
        resolveWorkspace: workspaces.resolve,
        sessionsRoot: join(root, "sessions"),
        agentDir: join(root, "agent"),
        modelServices: {
          getModelRuntime: async () => modelRuntime,
          subscribeChanges: (listener) => {
            modelChangeListeners.add(listener);
            return () => modelChangeListeners.delete(listener);
          },
          listBaseCatalog: async () => [
            {
              id: "openai",
              name: "OpenAI",
              models: [{
                id: "gpt-4.1",
                name: "GPT-4.1",
                thinkingLevels: ["off", "minimal", "low", "medium", "high"],
              }],
            },
          ],
        },
        getAppDefaults: () => appDefaults,
        setSessionModelDefault,
        getProjectDefaults: () => projectDefaults,
        getProjectTrust: () => true,
        beforePrompt: () => {},
      },
      {
        createWorker: () => {
          const worker = controllableWorker();
          workers.push(worker);
          return worker;
        },
      },
    );

    function openWorkspace(name: string) {
      const cwd = join(root, name);
      mkdirSync(cwd, { recursive: true });
      return workspaces.open(cwd);
    }

    return {
      sessions,
      workers,
      openWorkspace,
      setSessionModelDefault,
      notifyProviderChange(providerId: string) {
        for (const listener of modelChangeListeners) listener(providerId);
      },
    };
  }

  it("prepares and releases the selected Session Runtime explicitly", async () => {
    const { sessions, workers, openWorkspace } = setup();
    const workspace = openWorkspace("prepare");
    const session = await sessions.create(workspace.id);

    await expect(
      sessions.prepare(workspace.id, session.sessionId, selectionToken(1)),
    ).resolves.toEqual([]);
    expect(workers).toHaveLength(1);
    expect(
      (await sessions.list(workspace.id)).find((item) => item.id === session.sessionId)
        ?.runtimeStatus,
    ).toBe("idle");

    await sessions.release(workspace.id, session.sessionId, selectionToken(1));
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    await sessions.shutdown();
  });

  it("rebuilds an idle selected Runtime after a Provider change notification", async () => {
    const { sessions, workers, openWorkspace, notifyProviderChange } = setup();
    const workspace = openWorkspace("provider-refresh");
    const session = await sessions.create(workspace.id);
    await sessions.prepare(workspace.id, session.sessionId, selectionToken(1));

    notifyProviderChange("openai");

    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    await sessions.shutdown();
  });

  it("ignores a stale selection release after the Session is selected again", async () => {
    const { sessions, workers, openWorkspace } = setup();
    const workspace = openWorkspace("selection-race");
    const session = await sessions.create(workspace.id);

    await sessions.prepare(workspace.id, session.sessionId, selectionToken(1));
    const secondPreparation = sessions.prepare(
      workspace.id,
      session.sessionId,
      selectionToken(2),
    );
    await Promise.resolve();
    await sessions.release(workspace.id, session.sessionId, selectionToken(1));
    await secondPreparation;

    expect(workers[0]?.shutdown).not.toHaveBeenCalled();
    await sessions.release(workspace.id, session.sessionId, selectionToken(2));
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    await sessions.shutdown();
  });

  it("ignores a late older Prepare request after a newer selection arrives", async () => {
    const { sessions, workers, openWorkspace } = setup();
    const workspace = openWorkspace("prepare-order");
    const session = await sessions.create(workspace.id);

    const newerPreparation = sessions.prepare(
      workspace.id,
      session.sessionId,
      selectionToken(2),
    );
    await Promise.resolve();
    const olderPreparation = sessions.prepare(
      workspace.id,
      session.sessionId,
      selectionToken(1),
    );

    await expect(Promise.all([newerPreparation, olderPreparation])).resolves.toEqual([
      [],
      [],
    ]);
    await sessions.release(workspace.id, session.sessionId, selectionToken(1));
    expect(workers[0]?.shutdown).not.toHaveBeenCalled();
    await sessions.release(workspace.id, session.sessionId, selectionToken(2));
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    await sessions.shutdown();
  });

  it("does not let a different client steal a newer selection lease", async () => {
    const { sessions, workers, openWorkspace } = setup();
    const workspace = openWorkspace("prepare-client-order");
    const session = await sessions.create(workspace.id);

    const newerPreparation = sessions.prepare(
      workspace.id,
      session.sessionId,
      { clientId: "new-renderer", sequence: 1 },
    );
    await Promise.resolve();
    const latePreparation = sessions.prepare(
      workspace.id,
      session.sessionId,
      { clientId: "old-renderer", sequence: 7 },
    );

    await expect(Promise.all([newerPreparation, latePreparation])).resolves.toEqual([
      [],
      [],
    ]);
    await sessions.release(workspace.id, session.sessionId, {
      clientId: "old-renderer",
      sequence: 7,
    });
    expect(workers[0]?.shutdown).not.toHaveBeenCalled();
    await sessions.release(workspace.id, session.sessionId, {
      clientId: "new-renderer",
      sequence: 1,
    });
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    await sessions.shutdown();
  });

  it("runs Sessions concurrently through explicit identities", async () => {
    const { sessions, workers, openWorkspace } = setup();
    const workspaceA = openWorkspace("a");
    const workspaceB = openWorkspace("b");
    const sessionA = await sessions.create(workspaceA.id);
    const sessionB = await sessions.create(workspaceB.id);

    const turnA = sessions.prompt({ workspaceId: workspaceA.id, sessionId: sessionA.sessionId, text: "A", clips: [] });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const turnB = sessions.prompt({ workspaceId: workspaceB.id, sessionId: sessionB.sessionId, text: "B", clips: [] });
    await vi.waitFor(() => expect(workers).toHaveLength(2));

    expect(
      (await sessions.list(workspaceA.id)).find(
        (item) => item.id === sessionA.sessionId,
      )?.runtimeStatus,
    ).toBe("running");
    expect(
      (await sessions.list(workspaceB.id)).find(
        (item) => item.id === sessionB.sessionId,
      )?.runtimeStatus,
    ).toBe("running");

    for (const worker of workers) {
      worker.emit({ type: "agent_settled" });
      worker.releasePrompt();
    }
    await Promise.all([turnA, turnB]);
    await sessions.shutdown();
  });

  it("recovers context by Session identity and rejects usage from a released Worker", async () => {
    const { sessions, workers, openWorkspace } = setup();
    const workspace = openWorkspace("context");
    const a = await sessions.create(workspace.id);
    const b = await sessions.create(workspace.id);
    const context = { status: "ready" as const, provider: "openai", model: "gpt-4.1", contextWindow: 128000, usedTokens: 38400 };
    await sessions.prepare(workspace.id, a.sessionId, selectionToken(1));
    workers[0]!.emit({ type: "context_usage", context });
    expect(sessions.getTimelineSnapshot(workspace.id, a.sessionId).context).toEqual(context);
    expect(sessions.getTimelineSnapshot(workspace.id, b.sessionId).context).toEqual({ status: "unavailable" });
    await sessions.release(workspace.id, a.sessionId, selectionToken(1));
    expect(sessions.getTimelineSnapshot(workspace.id, a.sessionId).context).toEqual({ status: "unavailable" });
    await sessions.prepare(workspace.id, a.sessionId, selectionToken(2));
    const restored = { ...context, usedTokens: null };
    workers[1]!.emit({ type: "context_usage", context: restored });
    workers[0]!.emit({ type: "context_usage", context });
    expect(sessions.getTimelineSnapshot(workspace.id, a.sessionId).context).toEqual(restored);
    await sessions.shutdown();
  });

  it("retains replacement context identity when Prepare overlaps old Runtime disposal", async () => {
    const { sessions, workers, openWorkspace } = setup();
    const workspace = openWorkspace("context-reprepare");
    const session = await sessions.create(workspace.id);
    await sessions.prepare(workspace.id, session.sessionId, selectionToken(1));
    let finishShutdown!: () => void;
    vi.mocked(workers[0]!.shutdown).mockImplementation(() => new Promise<void>(resolve => { finishShutdown = resolve; }));
    const releasing = sessions.release(workspace.id, session.sessionId, selectionToken(1));
    await vi.waitFor(() => expect(finishShutdown).toBeTypeOf("function"));
    const preparing = sessions.prepare(workspace.id, session.sessionId, selectionToken(2));
    await new Promise(resolve => setTimeout(resolve, 0));
    finishShutdown();
    await Promise.all([releasing, preparing]);
    const context = { status: "ready" as const, provider: "openai", model: "gpt-4.1", contextWindow: 128000, usedTokens: 38400 };
    workers[1]!.emit({ type: "context_usage", context });
    expect(sessions.getTimelineSnapshot(workspace.id, session.sessionId)).toMatchObject({ status: "idle", context });
    await sessions.shutdown();
  });

  it("preserves the live projection when a running Session is opened again", async () => {
    const { sessions, workers, openWorkspace } = setup();
    const workspace = openWorkspace("live");
    const session = await sessions.create(workspace.id);
    const turn = sessions.prompt({ workspaceId: workspace.id, sessionId: session.sessionId, text: "observe me", clips: [] });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0]?.emit({
      type: "assistant_thinking_delta",
      delta: "live reasoning",
    });

    await sessions.open(workspace.id, session.sessionId);
    const snapshot = sessions.getTimelineSnapshot(workspace.id, session.sessionId);

    expect(snapshot.status).toBe("running");
    expect(JSON.stringify(snapshot.items)).toContain("live reasoning");
    workers[0]?.emit({ type: "agent_settled" });
    workers[0]?.releasePrompt();
    await turn;
    await sessions.shutdown();
  });

  it("reserves a Prompt identity before asynchronous Session resolution", async () => {
    const { sessions, workers, openWorkspace } = setup();
    const workspace = openWorkspace("delete-race");
    const session = await sessions.create(workspace.id);

    const turn = sessions.prompt({ workspaceId: workspace.id, sessionId: session.sessionId, text: "start now", clips: [] });
    await expect(sessions.delete(workspace.id, session.sessionId)).rejects.toThrow(
      /Cannot delete.*active Turn/i,
    );

    await vi.waitFor(() => expect(workers[0]?.prompt).toHaveBeenCalledTimes(1));
    expect(workers[0]?.abort).not.toHaveBeenCalled();
    workers[0]?.emit({ type: "agent_settled" });
    workers[0]?.releasePrompt();
    await turn;
    await sessions.shutdown();
  });

  it("requires the first Session Model to be selected by the user", async () => {
    const { sessions, openWorkspace } = setup({}, { wikiPromptEnabled: true });
    const workspace = openWorkspace("first-use");

    const created = await sessions.create(workspace.id);
    await expect(
      sessions.getConfiguration(workspace.id, created.sessionId),
    ).resolves.toMatchObject({
      configuration: { provider: undefined, model: undefined },
    });
    await sessions.shutdown();
  });

  it("copies an available App Default into a new Session", async () => {
    const { sessions, openWorkspace } = setup();
    const workspace = openWorkspace("app-default");

    const created = await sessions.create(workspace.id);
    await expect(
      sessions.getConfiguration(workspace.id, created.sessionId),
    ).resolves.toMatchObject({
      configuration: {
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "medium",
      },
    });
    await sessions.shutdown();
  });

  it("does not replace a stale App Default with the first catalog Model", async () => {
    const { sessions, openWorkspace } = setup({}, {
      sessionModel: {
        provider: "missing",
        model: "removed-model",
        thinkingLevel: "high",
      },
      wikiPromptEnabled: true,
    });
    const workspace = openWorkspace("stale-default");

    const created = await sessions.create(workspace.id);
    await expect(
      sessions.getConfiguration(workspace.id, created.sessionId),
    ).resolves.toMatchObject({
      configuration: { provider: undefined, model: undefined },
    });
    await sessions.shutdown();
  });

  it("saves an explicit Model and Effort as one App Default", async () => {
    const { sessions, openWorkspace, setSessionModelDefault } = setup();
    const workspace = openWorkspace("default-update");

    await sessions.create(workspace.id, {
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
    });
    expect(setSessionModelDefault).toHaveBeenCalledOnce();
    expect(setSessionModelDefault).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
    });
    await sessions.shutdown();
  });
});
