import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { TimelineDelta } from "../../shared/timeline";
import type { SessionHandle } from "./session-repository";
import {
  sessionConfigEntryData,
  WIKILOT_SESSION_ENTRY_TYPE,
} from "../../shared/workspace";
import {
  createSessionExecution,
  type SessionExecutionDeps,
  type RuntimeSessionIdentity,
} from "./session-execution";
import type { SessionWorker } from "./runtime/session-worker";
import type {
  WorkerPromptContext,
  WorkerResourceState,
  WorkerStartParams,
} from "./runtime/worker-protocol";
import { initHostTelemetry, shutdownHostTelemetry } from "../telemetry";

type FakeWorker = SessionWorker & {
  startParams: WorkerStartParams | undefined;
  emitTimeline(event: TimelineDelta): void;
  emitContext(context: WorkerPromptContext): void;
  emitExit(exit: { expected: boolean; message: string }): void;
};

function makeFakeWorker(overrides: {
  start?: (params: WorkerStartParams) => Promise<WorkerResourceState>;
  prompt?: SessionWorker["prompt"];
  configure?: SessionWorker["configure"];
  shutdown?: SessionWorker["shutdown"];
}): FakeWorker {
  const timelineListeners = new Set<(event: TimelineDelta) => void>();
  const contextListeners = new Set<(context: WorkerPromptContext) => void>();
  const exitListeners = new Set<
    (exit: { expected: boolean; message: string }) => void
  >();
  const fake: FakeWorker = {
    startParams: undefined,
    start: vi.fn(
      overrides.start ??
        (async (params: WorkerStartParams) => {
          fake.startParams = params;
          return {
            skills: [{ name: "research", description: "Investigate" }],
            modelReady: Boolean(params.config.provider && params.config.model),
          } satisfies WorkerResourceState;
        }),
    ) as SessionWorker["start"],
    prompt: vi.fn(
      overrides.prompt ?? (async () => {}),
    ) as SessionWorker["prompt"],
    abort: vi.fn(async () => {}),
    configure: vi.fn(
      overrides.configure ?? (async () => ({ applied: true as const })),
    ) as SessionWorker["configure"],
    reload: vi.fn(async (): Promise<WorkerResourceState> => ({
      skills: [],
      modelReady: true,
    })),
    shutdown: vi.fn(overrides.shutdown ?? (async () => {})),
    onTimelineEvent: (listener) => timelineListeners.add(listener),
    onPromptContext: (listener) => contextListeners.add(listener),
    onExit: (listener) => exitListeners.add(listener),
    emitTimeline: (event) => {
      for (const listener of timelineListeners) listener(event);
    },
    emitContext: (context) => {
      for (const listener of contextListeners) listener(context);
    },
    emitExit: (exit) => {
      for (const listener of exitListeners) listener(exit);
    },
  };
  return fake;
}

describe("Session execution (per-Session Runtime)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempSession(workspaceId = "ws-1", withModel = true): SessionHandle {
    const root = mkdtempSync(join(tmpdir(), "wikilot-runtime-"));
    roots.push(root);
    const cwd = join(root, "ws");
    const sessionDir = join(root, "sessions");
    const sessionManager = SessionManager.create(cwd, sessionDir);
    if (withModel) {
      sessionManager.appendModelChange("openai", "gpt-4.1");
      sessionManager.appendThinkingLevelChange("medium");
      sessionManager.appendCustomEntry(
        WIKILOT_SESSION_ENTRY_TYPE,
        sessionConfigEntryData({ wikiPromptEnabled: true }),
      );
    }
    return {
      workspaceId,
      cwd,
      sessionDir,
      sessionId: sessionManager.getSessionId(),
      sessionFile: join(sessionDir, "session.jsonl"),
      sessionManager,
    };
  }

  function setup(
    overrides: {
      modelConfigured?: boolean;
      modelAvailable?: boolean;
      credentialConfigured?: boolean;
      start?: (params: WorkerStartParams) => Promise<WorkerResourceState>;
      prompt?: SessionWorker["prompt"];
      configure?: SessionWorker["configure"];
      shutdown?: SessionWorker["shutdown"];
      persistConfiguration?: SessionExecutionDeps["persistConfiguration"];
      getModelRuntime?: () => Promise<ModelRuntime>;
    } = {},
  ) {
    const active = tempSession("ws-1", overrides.modelConfigured !== false);
    const workers: FakeWorker[] = [];
    const events: TimelineDelta[] = [];
    const eventSessions: RuntimeSessionIdentity[] = [];
    const modelRuntime = {
      getModel: vi.fn(() =>
        overrides.modelAvailable === false
          ? undefined
          : { id: "gpt-4.1", provider: "openai", reasoning: true },
      ),
      getAuth: vi.fn(async () =>
        overrides.credentialConfigured === false
          ? undefined
          : { type: "api_key" },
      ),
    } as unknown as ModelRuntime;
    const setSessionModelDefault = vi.fn();
    const execution = createSessionExecution({
      modelServices: {
        getModelRuntime:
          overrides.getModelRuntime ?? (async () => modelRuntime),
      },
      setSessionModelDefault,
      getAgentDir: () => "/tmp/wikilot-agent",
      getProjectTrust: () => true,
      createWorker: () => {
        const worker = makeFakeWorker({
          ...(overrides.start !== undefined ? { start: overrides.start } : {}),
          ...(overrides.prompt !== undefined
            ? { prompt: overrides.prompt }
            : {}),
          ...(overrides.configure !== undefined
            ? { configure: overrides.configure }
            : {}),
          ...(overrides.shutdown !== undefined
            ? { shutdown: overrides.shutdown }
            : {}),
        });
        workers.push(worker);
        return worker;
      },
      ...(overrides.persistConfiguration !== undefined
        ? { persistConfiguration: overrides.persistConfiguration }
        : {}),
    });
    const runtime = {
      ...execution,
      prompt(session: SessionHandle, text: string) {
        return execution.prompt(session, {
          workspaceId: session.workspaceId,
          sessionId: session.sessionId,
          text,
          clips: [],
        });
      },
    };
    execution.subscribe((event, session) => {
      events.push(event);
      eventSessions.push(session);
    });
    return {
      active,
      runtime,
      events,
      eventSessions,
      workers,
      setSessionModelDefault,
    };
  }

  it("fails fast before spawning a Worker when configuration is missing", async () => {
    const { active, runtime, workers } = setup({
      modelConfigured: false,
    });
    await expect(runtime.prompt(active, "hi")).rejects.toThrow(
      /Choose a Model.*Composer/i,
    );
    expect(workers).toHaveLength(0);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("unloaded");
  });

  it("fails fast on an unavailable model without spawning a Worker", async () => {
    const { active, runtime, workers } = setup({ modelAvailable: false });
    await expect(runtime.prompt(active, "hi")).rejects.toThrow(/Model not available/i);
    expect(workers).toHaveLength(0);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("unloaded");
  });

  it("rejects an Effort the selected Model does not advertise", async () => {
    const modelRuntime = {
      getModel: vi.fn(() => ({
        id: "deepseek-v4-flash",
        provider: "deepseek",
        reasoning: true,
        thinkingLevelMap: {
          off: "off",
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      })),
      getAuth: vi.fn(async () => ({ type: "api_key" })),
    } as unknown as ModelRuntime;
    const { active, runtime } = setup({
      getModelRuntime: async () => modelRuntime,
    });

    await expect(
      runtime.updateConfiguration(active, {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingLevel: "medium",
      }),
    ).rejects.toThrow(/Effort medium is not available/);
  });

  it("stores a confirmed Model and Effort as one new-Session default", async () => {
    const { active, runtime, setSessionModelDefault } = setup();

    await runtime.updateConfiguration(active, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
    });

    expect(setSessionModelDefault).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
    });
  });

  it("updates the new-Session default when Effort changes for the active Model", async () => {
    const { active, runtime, setSessionModelDefault } = setup();

    await runtime.updateConfiguration(active, { thinkingLevel: "high" });

    expect(setSessionModelDefault).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
    });
  });

  it("fails fast on a missing Credential without spawning a Worker", async () => {
    const { active, runtime, workers } = setup({ credentialConfigured: false });
    await expect(runtime.prompt(active, "hi")).rejects.toThrow(/No Credential/i);
    expect(workers).toHaveLength(0);
  });

  it("prepares resources without requiring an executable Model", async () => {
    const { active, runtime, workers } = setup({
      modelAvailable: false,
      credentialConfigured: false,
    });

    await expect(runtime.prepare(active)).resolves.toEqual([
      { name: "research", description: "Investigate" },
    ]);
    expect(workers).toHaveLength(1);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle");
  });

  it("restarts a released Runtime with its latest requested configuration", async () => {
    const { active, runtime, workers } = setup();
    await runtime.prepare(active);
    await runtime.updateConfiguration(active, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
    await runtime.release(active.workspaceId, active.sessionId);
    await runtime.prepare(active);

    expect(workers).toHaveLength(2);
    expect(workers[1]?.startParams?.config).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
  });

  it("keeps the selected idle Runtime warm until it is released", async () => {
    const { active, runtime, workers } = setup();
    await runtime.prepare(active);
    workers[0]?.emitTimeline({ type: "agent_settled" });

    await vi.waitFor(() =>
      expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle"),
    );
    expect(workers[0]?.shutdown).not.toHaveBeenCalled();

    await runtime.release(active.workspaceId, active.sessionId);
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("unloaded");
  });

  it("releases a running unselected Runtime only after its Turn settles", async () => {
    let settle: (() => void) | undefined;
    const { active, runtime, workers } = setup({
      prompt: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    });
    await runtime.prepare(active);
    const turn = runtime.prompt(active, "background");
    await vi.waitFor(() =>
      expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("running"),
    );

    await runtime.release(active.workspaceId, active.sessionId);
    expect(workers[0]?.shutdown).not.toHaveBeenCalled();
    workers[0]?.emitTimeline({ type: "agent_settled" });
    settle?.();
    await turn;
    await vi.waitFor(() => expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1));
  });

  it("rebuilds an idle selected Runtime after a Provider change", async () => {
    const { active, runtime, workers } = setup();
    await runtime.prepare(active);
    await runtime.updateConfiguration(active, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });

    runtime.invalidateProvider("anthropic");

    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(workers[1]?.startParams?.config).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle");
  });

  it("rebuilds loaded Runtimes when a new Provider enters the catalog", async () => {
    const { active, runtime, workers } = setup();
    await runtime.prepare(active);

    runtime.invalidateProvider("new-provider");

    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle");
  });

  it("rebuilds a selected Runtime if a Provider changes during preparation", async () => {
    let finishStart: (() => void) | undefined;
    let starts = 0;
    const { active, runtime, workers } = setup({
      start: () => {
        if (starts++ > 0) {
          return Promise.resolve({ skills: [], modelReady: true });
        }
        return new Promise<WorkerResourceState>((resolve) => {
          finishStart = () => resolve({ skills: [], modelReady: true });
        });
      },
    });
    const prepared = runtime.prepare(active);
    await vi.waitFor(() => expect(workers).toHaveLength(1));

    runtime.invalidateProvider("openai");
    finishStart?.();
    await prepared;

    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle");
  });

  it("drains a Provider invalidation that arrives while a replacement starts", async () => {
    let finishSecondStart: (() => void) | undefined;
    let starts = 0;
    const { active, runtime, workers } = setup({
      start: () => {
        if (starts++ === 0) {
          return Promise.resolve({ skills: [], modelReady: true });
        }
        if (starts === 2) {
          return new Promise<WorkerResourceState>((resolve) => {
            finishSecondStart = () =>
              resolve({ skills: [], modelReady: true });
          });
        }
        return Promise.resolve({ skills: [], modelReady: true });
      },
    });
    await runtime.prepare(active);

    runtime.invalidateProvider("openai");
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    runtime.invalidateProvider("openai");

    finishSecondStart?.();
    await vi.waitFor(() => expect(workers).toHaveLength(3));
    expect(workers[1]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle");
  });

  it("defers Provider invalidation until a busy Turn settles", async () => {
    let settle: (() => void) | undefined;
    const { active, runtime, workers } = setup({
      prompt: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    });
    await runtime.prepare(active);
    const turn = runtime.prompt(active, "busy");
    await vi.waitFor(() =>
      expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("running"),
    );

    runtime.invalidateProvider("openai");
    expect(workers[0]?.shutdown).not.toHaveBeenCalled();
    workers[0]?.emitTimeline({ type: "agent_settled" });
    settle?.();
    await turn;

    await vi.waitFor(() => expect(workers).toHaveLength(2));
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
  });

  it("applies a configuration queued while an invalidated Runtime rebuilds", async () => {
    let finishSecondStart: (() => void) | undefined;
    let starts = 0;
    const { active, runtime, workers } = setup({
      start: () => {
        if (starts++ === 0) {
          return Promise.resolve({ skills: [], modelReady: true });
        }
        return new Promise<WorkerResourceState>((resolve) => {
          finishSecondStart = () =>
            resolve({ skills: [], modelReady: true });
        });
      },
    });
    await runtime.prepare(active);

    runtime.invalidateProvider("openai");
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    const update = runtime.updateConfiguration(active, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
    await expect(update).resolves.toMatchObject({ status: "pending" });

    finishSecondStart?.();
    await vi.waitFor(() =>
      expect(workers[1]?.configure).toHaveBeenCalledWith({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        thinkingLevel: "high",
        wikiPromptEnabled: false,
      }),
    );
    expect(runtime.getConfiguration(active)).toMatchObject({
      status: "applied",
      configuration: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      },
    });
  });

  it("waits for a rebuilding configuration before starting the next Prompt", async () => {
    let finishSecondStart: (() => void) | undefined;
    let finishConfigure: (() => void) | undefined;
    let starts = 0;
    let configureCalls = 0;
    const { active, runtime, workers } = setup({
      start: () => {
        if (starts++ === 0) {
          return Promise.resolve({ skills: [], modelReady: true });
        }
        return new Promise<WorkerResourceState>((resolve) => {
          finishSecondStart = () =>
            resolve({ skills: [], modelReady: true });
        });
      },
      configure: async () => {
        if (configureCalls++ === 0) {
          await new Promise<void>((resolve) => {
            finishConfigure = resolve;
          });
        }
        return { applied: true as const };
      },
    });
    await runtime.prepare(active);

    runtime.invalidateProvider("openai");
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    await expect(
      runtime.updateConfiguration(active, {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        thinkingLevel: "high",
      }),
    ).resolves.toMatchObject({ status: "pending" });
    finishSecondStart?.();
    await vi.waitFor(() => expect(configureCalls).toBe(1));

    const prompt = runtime.prompt(active, "after-rebuild");
    await Promise.resolve();
    expect(workers[1]?.prompt).not.toHaveBeenCalled();
    finishConfigure?.();
    await prompt;
    expect(workers[1]?.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "after-rebuild", clips: [] }),
      undefined,
    );
    workers[1]?.emitTimeline({ type: "agent_settled" });
  });

  it("serializes an idle configuration update before the next Prompt", async () => {
    let finishConfigure: (() => void) | undefined;
    const { active, runtime, workers } = setup({
      configure: async () => {
        await new Promise<void>((resolve) => {
          finishConfigure = resolve;
        });
        return { applied: true as const };
      },
    });
    await runtime.prepare(active);

    const update = runtime.updateConfiguration(active, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
    });
    await vi.waitFor(() => expect(workers[0]?.configure).toHaveBeenCalled());

    const prompt = runtime.prompt(active, "after-idle-config");
    await Promise.resolve();
    expect(workers[0]?.prompt).not.toHaveBeenCalled();
    finishConfigure?.();
    await update;
    await prompt;
    expect(workers[0]?.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "after-idle-config", clips: [] }),
      undefined,
    );
    workers[0]?.emitTimeline({ type: "agent_settled" });
  });

  it("keeps configuration changes pending while an invalidated Runtime stops", async () => {
    let finishShutdown: (() => void) | undefined;
    let finishSecondStart: (() => void) | undefined;
    let starts = 0;
    let shutdowns = 0;
    const { active, runtime, workers } = setup({
      start: () => {
        if (starts++ === 0) {
          return Promise.resolve({ skills: [], modelReady: true });
        }
        return new Promise<WorkerResourceState>((resolve) => {
          finishSecondStart = () =>
            resolve({ skills: [], modelReady: true });
        });
      },
      shutdown: () => {
        if (shutdowns++ > 0) return Promise.resolve();
        return new Promise<void>((resolve) => {
          finishShutdown = resolve;
        });
      },
    });
    await runtime.prepare(active);

    runtime.invalidateProvider("openai");
    await vi.waitFor(() =>
      expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe(
        "stopping",
      ),
    );
    await expect(
      runtime.updateConfiguration(active, {
        thinkingLevel: "high",
        wikiPromptEnabled: false,
      }),
    ).resolves.toMatchObject({ status: "pending" });

    finishShutdown?.();
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    finishSecondStart?.();
    await vi.waitFor(() =>
      expect(workers[1]?.configure).toHaveBeenCalledWith({
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "high",
        wikiPromptEnabled: false,
      }),
    );
    expect(runtime.getConfiguration(active)).toMatchObject({
      status: "applied",
      configuration: { thinkingLevel: "high", wikiPromptEnabled: false },
    });
    await runtime.shutdown();
  });

  it("coalesces concurrent resource preparation for one Session", async () => {
    let finishStart: (() => void) | undefined;
    const { active, runtime, workers } = setup({
      start: () =>
        new Promise<WorkerResourceState>((resolve) => {
          finishStart = () => resolve({ skills: [], modelReady: true });
        }),
    });

    const first = runtime.prepare(active);
    const second = runtime.prepare(active);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    finishStart?.();
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });

  it("lazily starts one Worker bound to the Session on the first Prompt", async () => {
    const { active, runtime, events, eventSessions, workers } = setup();

    await runtime.prompt(active, "hello");

    expect(workers).toHaveLength(1);
    const params = workers[0]?.startParams;
    expect(params).toMatchObject({
      sessionId: active.sessionId,
      cwd: active.cwd,
      sessionDir: active.sessionDir,
      sessionFile: active.sessionFile,
      agentDir: "/tmp/wikilot-agent",
      config: {
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "medium",
        wikiPromptEnabled: true,
      },
    });
    expect(typeof params?.wikiPromptFragment).toBe("string");
    expect(workers[0]?.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "hello", clips: [] }),
      undefined,
    );
    // Status stream: starting → idle → running. The real Worker emits the
    // clean user projection only after its Context Clip sidecar is durable.
    expect(events).toEqual([
      { type: "session_status", status: "starting" },
      { type: "session_status", status: "idle" },
      { type: "session_status", status: "running" },
    ]);
    expect(eventSessions).not.toHaveLength(0);
    expect(
      eventSessions.every(
        (session) =>
          session.workspaceId === active.workspaceId &&
          session.sessionId === active.sessionId,
      ),
    ).toBe(true);
  });

  it("uses the Session's persisted configuration snapshot", async () => {
    const { active, runtime, workers } = setup();
    active.sessionManager.appendModelChange("openai", "gpt-4.1");
    active.sessionManager.appendThinkingLevelChange("high");
    active.sessionManager.appendCustomEntry(
      WIKILOT_SESSION_ENTRY_TYPE,
      sessionConfigEntryData({ wikiPromptEnabled: true }),
    );

    await runtime.prompt(active, "hello");

    expect(workers[0]?.startParams?.config).toEqual({
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: true,
    });
  });

  it("streams Worker events back and settles to idle on agent_settled", async () => {
    const { active, runtime, events, workers } = setup();
    await runtime.prompt(active, "hello");
    events.length = 0;

    workers[0]?.emitTimeline({
      type: "assistant_text_delta",
      delta: "hi there",
    });
    workers[0]?.emitTimeline({
      type: "tool_start",
      toolCallId: "c1",
      toolName: "bash",
    });
    workers[0]?.emitTimeline({ type: "agent_settled" });

    expect(events).toEqual([
      { type: "assistant_text_delta", delta: "hi there" },
      { type: "tool_start", toolCallId: "c1", toolName: "bash" },
      { type: "agent_settled" },
      { type: "session_status", status: "idle" },
    ]);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle");
  });

  it("reuses the same Worker for later Prompts", async () => {
    const { active, runtime, workers } = setup();
    await runtime.prompt(active, "first");
    workers[0]?.emitTimeline({ type: "agent_settled" });

    await runtime.prompt(active, "second");

    expect(workers).toHaveLength(1);
    expect(workers[0]?.prompt).toHaveBeenCalledTimes(2);
  });

  it("releases an idle Worker when a lifecycle operation needs the Session", async () => {
    const { active, runtime, workers } = setup();
    await runtime.prompt(active, "first");
    workers[0]?.emitTimeline({ type: "agent_settled" });

    await runtime.disposeIfIdle(active.workspaceId, active.sessionId);

    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe(
      "unloaded",
    );
  });

  it("starts a fresh Worker when a Prompt races idle disposal", async () => {
    let finishShutdown: (() => void) | undefined;
    const { active, runtime, workers } = setup({
      shutdown: () =>
        new Promise<void>((resolve) => {
          finishShutdown = resolve;
        }),
    });
    await runtime.prompt(active, "first");
    workers[0]?.emitTimeline({ type: "agent_settled" });

    const disposal = runtime.disposeIfIdle(active.workspaceId, active.sessionId);
    await vi.waitFor(() =>
      expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe(
        "stopping",
      ),
    );
    const second = runtime.prompt(active, "second");

    finishShutdown?.();
    await disposal;
    await expect(second).resolves.toBeUndefined();
    expect(workers).toHaveLength(2);
    expect(workers[1]?.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "second", clips: [] }),
      undefined,
    );
  });

  it("rejects a second Prompt while a turn is in flight", async () => {
    let settle: (() => void) | undefined;
    const { active, runtime, events } = setup({
      prompt: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    });

    const first = runtime.prompt(active, "first");
    await expect(runtime.prompt(active, "second")).rejects.toThrow(/busy/i);
    await vi.waitFor(() => {
      expect(settle).toBeDefined();
    });
    settle?.();
    await first;

    expect(events).not.toContainEqual({
      type: "user_message",
      text: "second",
    });
  });

  it("runs distinct Sessions concurrently and disposes each settled Runtime", async () => {
    const releases = new Map<string, () => void>();
    const { active: sessionA, runtime, workers } = setup({
      prompt: (prompt) =>
        new Promise<void>((resolve) => {
          releases.set(prompt.text, resolve);
        }),
    });
    const sessionB = tempSession("ws-2");

    const turnA = runtime.prompt(sessionA, "A");
    await vi.waitFor(() => {
      expect(runtime.getStatusFor(sessionA.workspaceId, sessionA.sessionId)).toBe(
        "running",
      );
    });

    const turnB = runtime.prompt(sessionB, "B");
    await vi.waitFor(() => expect(workers).toHaveLength(2));

    expect(runtime.getStatusFor(sessionA.workspaceId, sessionA.sessionId)).toBe(
      "running",
    );
    expect(runtime.getStatusFor(sessionB.workspaceId, sessionB.sessionId)).toBe(
      "running",
    );
    expect(workers[0]?.shutdown).not.toHaveBeenCalled();

    workers[0]?.emitTimeline({ type: "agent_settled" });
    await vi.waitFor(() => expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1));
    workers[1]?.emitTimeline({ type: "agent_settled" });
    await vi.waitFor(() => expect(workers[1]?.shutdown).toHaveBeenCalledTimes(1));

    releases.get("A")?.();
    releases.get("B")?.();
    await Promise.all([turnA, turnB]);
  });

  it("aborts only while a turn is in flight", async () => {
    let settle: (() => void) | undefined;
    const { active, runtime, workers } = setup({
      prompt: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    });

    await expect(
      runtime.abort(active.workspaceId, active.sessionId),
    ).rejects.toThrow(/No in-flight turn/i);
    const first = runtime.prompt(active, "first");
    await vi.waitFor(() => {
      expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("running");
    });
    const abort = runtime.abort(active.workspaceId, active.sessionId);
    await vi.waitFor(() => expect(workers[0]?.abort).toHaveBeenCalledTimes(1));
    settle?.();
    await Promise.all([first, abort]);
  });

  it("aborts exactly the addressed Session and waits for its Turn to settle", async () => {
    let settleA: (() => void) | undefined;
    let settleB: (() => void) | undefined;
    const { active: sessionA, runtime, workers } = setup({
      prompt: (prompt) =>
        new Promise<void>((resolve) => {
          if (prompt.text === "A") settleA = resolve;
          if (prompt.text === "B") settleB = resolve;
        }),
    });
    const sessionB = tempSession("ws-2");
    const turnA = runtime.prompt(sessionA, "A");
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const turnB = runtime.prompt(sessionB, "B");
    await vi.waitFor(() => {
      expect(runtime.getStatusFor(sessionB.workspaceId, sessionB.sessionId)).toBe(
        "running",
      );
    });

    let abortSettled = false;
    const abort = runtime
      .abort(sessionA.workspaceId, sessionA.sessionId)
      .then(() => {
        abortSettled = true;
      });
    await vi.waitFor(() => {
      expect(workers[0]?.abort).toHaveBeenCalledTimes(1);
    });
    expect(workers[1]?.abort).not.toHaveBeenCalled();
    expect(abortSettled).toBe(false);

    settleA?.();
    await Promise.all([turnA, abort]);
    expect(abortSettled).toBe(true);

    settleB?.();
    await turnB;
  });

  it("accepts Abort while the addressed Session Worker is still starting", async () => {
    let finishStart: (() => void) | undefined;
    let settleTurn: (() => void) | undefined;
    const { active, runtime, workers } = setup({
      start: () =>
        new Promise<WorkerResourceState>((resolve) => {
          finishStart = () => resolve({ skills: [], modelReady: true });
        }),
      prompt: () =>
        new Promise<void>((resolve) => {
          settleTurn = resolve;
        }),
    });
    const turn = runtime.prompt(active, "first");
    await vi.waitFor(() => expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("starting"));

    let abortSettled = false;
    const abort = runtime.abort(active.workspaceId, active.sessionId).then(() => {
      abortSettled = true;
    });
    expect(abortSettled).toBe(false);
    finishStart?.();
    await vi.waitFor(() => expect(workers[0]?.abort).toHaveBeenCalledTimes(1));
    expect(abortSettled).toBe(false);

    settleTurn?.();
    await Promise.all([turn, abort]);
    expect(abortSettled).toBe(true);
  });

  it("reports a failed turn as an error event and returns to idle", async () => {
    const { active, runtime, events } = setup({
      prompt: async () => {
        throw new Error("provider exploded");
      },
    });

    await expect(runtime.prompt(active, "first")).rejects.toThrow(/provider exploded/);

    expect(events).toContainEqual({ type: "error", message: "provider exploded" });
    expect(events.at(-1)).toEqual({ type: "error", message: "provider exploded" });
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle");
  });

  it("releases the Session after a Worker crash and starts fresh on the next Prompt", async () => {
    const { active, runtime, events, workers } = setup();
    await runtime.prompt(active, "first");
    workers[0]?.emitTimeline({ type: "agent_settled" });

    workers[0]?.emitExit({
      expected: false,
      message: "Session Runtime exited unexpectedly (code 1)",
    });

    expect(events).toContainEqual({
      type: "error",
      message: "Session Runtime exited unexpectedly (code 1)",
    });
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("unloaded");
    // No automatic replay; the next explicit Prompt starts a new Worker.
    await runtime.prompt(active, "second");
    expect(workers).toHaveLength(2);
    expect(workers[1]?.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "second", clips: [] }),
      undefined,
    );
  });

  it("stops the spawned Worker when its start is rejected", async () => {
    const { active, runtime, workers } = setup({
      start: async () => {
        throw new Error("No Credential configured for provider");
      },
    });

    await expect(runtime.prompt(active, "hello")).rejects.toThrow(/No Credential/i);

    expect(workers).toHaveLength(1);
    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("unloaded");
  });

  it("emits exactly one error when the Worker crashes mid-turn", async () => {
    let rejectPrompt: ((error: Error) => void) | undefined;
    const { active, runtime, events, workers } = setup({
      prompt: () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
    });
    const first = runtime.prompt(active, "first");
    await vi.waitFor(() => {
      expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("running");
    });
    const settled = first.catch((error: unknown) => error);

    workers[0]?.emitExit({
      expected: false,
      message: "Session Runtime exited unexpectedly (code 1)",
    });
    // The real fork handle rejects the pending prompt on exit; mirror that.
    rejectPrompt?.(new Error("Session Runtime exited (code 1)"));
    await settled;

    const errors = events.filter((event) => event.type === "error");
    expect(errors).toEqual([
      { type: "error", message: "Session Runtime exited unexpectedly (code 1)" },
    ]);
    expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("unloaded");
  });

  it("applies pending configuration after a background Worker crash releases ownership", async () => {
    let rejectPrompt: ((error: Error) => void) | undefined;
    const persistConfiguration = vi.fn(async () => {});
    const { active: sessionA, runtime, workers } = setup({
      prompt: () =>
        new Promise<void>((_resolve, reject) => {
          rejectPrompt = reject;
        }),
      persistConfiguration,
    });
    const turn = runtime.prompt(sessionA, "first").catch((error: unknown) => error);
    await vi.waitFor(() => expect(runtime.getStatusFor(sessionA.workspaceId, sessionA.sessionId)).toBe("running"));
    await runtime.updateConfiguration(sessionA, { thinkingLevel: "high" });

    workers[0]?.emitExit({
      expected: false,
      message: "Session Runtime exited unexpectedly (code 1)",
    });
    rejectPrompt?.(new Error("Session Runtime exited (code 1)"));
    await turn;

    await vi.waitFor(() => {
      expect(persistConfiguration).toHaveBeenCalledWith(
        sessionA,
        expect.objectContaining({ thinkingLevel: "high" }),
      );
    });
    expect(runtime.getStatusFor(sessionA.workspaceId, sessionA.sessionId)).toBe(
      "unloaded",
    );
  });

  it("shuts down every loaded Session Worker on Host termination", async () => {
    const { active: sessionA, runtime, workers } = setup();
    await runtime.prompt(sessionA, "A");
    workers[0]?.emitTimeline({ type: "agent_settled" });
    const sessionB = tempSession("ws-2");
    await runtime.prompt(sessionB, "B");
    workers[1]?.emitTimeline({ type: "agent_settled" });

    await runtime.shutdown();

    expect(workers[0]?.shutdown).toHaveBeenCalledTimes(1);
    expect(workers[1]?.shutdown).toHaveBeenCalledTimes(1);
    expect(runtime.getStatusFor(sessionA.workspaceId, sessionA.sessionId)).toBe(
      "unloaded",
    );
    expect(runtime.getStatusFor(sessionB.workspaceId, sessionB.sessionId)).toBe(
      "unloaded",
    );
  });

  it("prevents a validating Prompt from starting a Worker after Host shutdown", async () => {
    let releaseModelRuntime: ((runtime: ModelRuntime) => void) | undefined;
    const modelRuntime = {
      getModel: vi.fn(() => ({
        id: "gpt-4.1",
        provider: "openai",
        reasoning: true,
      })),
      getAuth: vi.fn(async () => ({ type: "api_key" })),
    } as unknown as ModelRuntime;
    const { active, runtime, workers } = setup({
      getModelRuntime: () =>
        new Promise<ModelRuntime>((resolve) => {
          releaseModelRuntime = resolve;
        }),
    });
    const turn = runtime.prompt(active, "first");
    await vi.waitFor(() => {
      expect(runtime.isTurnInFlight(active.workspaceId, active.sessionId)).toBe(
        true,
      );
    });

    const shutdown = runtime.shutdown();
    releaseModelRuntime?.(modelRuntime);

    await expect(turn).rejects.toThrow(/Host is shutting down/i);
    await shutdown;
    expect(workers).toHaveLength(0);
    await expect(runtime.prompt(active, "after shutdown")).rejects.toThrow(
      /Host is shutting down/i,
    );
  });

  it("keeps a configuration update pending until the current Turn settles", async () => {
    let resolvePrompt: (() => void) | undefined;
    const { active, runtime, workers } = setup({
      prompt: () => new Promise<void>((resolve) => { resolvePrompt = resolve; }),
    });

    const turn = runtime.prompt(active, "first");
    await vi.waitFor(() => expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("running"));
    await expect(runtime.updateConfiguration(active, { thinkingLevel: "high" })).resolves.toEqual({
      status: "pending",
      configuration: expect.objectContaining({ thinkingLevel: "high" }),
    });
    expect(workers[0]?.configure).not.toHaveBeenCalled();

    workers[0]?.emitTimeline({ type: "agent_settled" });
    await vi.waitFor(() => expect(workers[0]?.configure).toHaveBeenCalled());
    resolvePrompt?.();
    await turn;
  });

  it("records the old configuration for the current Turn and the new one for the next", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });
    try {
      const { active, runtime, workers } = setup();
      await runtime.prompt(active, "first");
      await runtime.updateConfiguration(active, {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        thinkingLevel: "high",
        wikiPromptEnabled: false,
      });
      workers[0]?.emitTimeline({ type: "agent_settled" });
      await vi.waitFor(() => expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle"));
      expect(workers[0]?.reload).not.toHaveBeenCalled();

      await runtime.prompt(active, "second");
      workers[0]?.emitTimeline({ type: "agent_settled" });
      await vi.waitFor(() => expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle"));

      const prompts = exporter
        .getFinishedSpans()
        .filter((span) => span.name === "session.prompt");
      expect(prompts.map((span) => span.attributes)).toEqual([
        expect.objectContaining({
          "wikilot.llm.provider": "openai",
          "wikilot.llm.model": "gpt-4.1",
          "wikilot.llm.thinking": "medium",
          "wikilot.wiki.enabled": "true",
        }),
        expect.objectContaining({
          "wikilot.llm.provider": "anthropic",
          "wikilot.llm.model": "claude-sonnet-4-5",
          "wikilot.llm.thinking": "high",
          "wikilot.wiki.enabled": "false",
        }),
      ]);
    } finally {
      await shutdownHostTelemetry();
    }
  });

  it("reloads resources only while the Session Runtime is idle", async () => {
    const { active, runtime, workers } = setup();
    await runtime.prompt(active, "first");

    await expect(runtime.reloadResources(active)).rejects.toThrow(/only.*idle/i);
    expect(workers[0]?.reload).not.toHaveBeenCalled();

    workers[0]?.emitTimeline({ type: "agent_settled" });
    await runtime.reloadResources(active);
    expect(workers[0]?.reload).toHaveBeenCalledWith(true);
    expect(workers[0]?.reload).toHaveBeenCalledTimes(1);
  });

  it("drains configuration updates that arrive while a pending update is applying", async () => {
    let releaseFirst: (() => void) | undefined;
    const configure = vi.fn(
      (_config: WorkerStartParams["config"]) =>
        configure.mock.calls.length === 1
          ? new Promise<{ applied: true }>((resolve) => {
              releaseFirst = () => resolve({ applied: true });
            })
          : Promise.resolve({ applied: true as const }),
    );
    const { active, runtime, workers } = setup({ configure });
    await runtime.prompt(active, "first");
    const first = runtime.updateConfiguration(active, { thinkingLevel: "high" });
    workers[0]?.emitTimeline({ type: "agent_settled" });
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    const second = runtime.updateConfiguration(active, { wikiPromptEnabled: false });
    releaseFirst?.();
    await expect(first).resolves.toMatchObject({ status: "applied" });
    await expect(second).resolves.toMatchObject({ status: "pending" });
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(runtime.getStatusFor(active.workspaceId, active.sessionId)).toBe("idle"));
    expect(configure.mock.calls[1]?.[0]).toMatchObject({
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
  });
});
