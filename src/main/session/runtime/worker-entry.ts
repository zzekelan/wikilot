/**
 * Session Worker entry — runs as a dedicated Node child process permanently
 * bound to one Session. Composes Pi SessionManager, ModelRuntime,
 * SettingsManager, ResourceLoader, and AgentSession through the public SDK
 * and is the exclusive Session JSONL writer while alive.
 *
 * Executed directly by Node (≥22.18 native type stripping): every relative
 * import below is either extension-suffixed and erasable-only, or type-only.
 * The process exits when the Host disconnects or sends `shutdown`.
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { SessionContextState } from "../../../shared/timeline";
import {
  CONTEXT_CLIP_ENTRY_TYPE,
  contextClipSidecar,
} from "../../../shared/session/prompt.ts";
import {
  createWikilotModelRuntime,
  syncUserProviders,
} from "../../models/index.ts";
import {
  beginToolExecution,
  beginWorkerTurn,
  endToolExecution,
  endWorkerTurn,
  initHostTelemetry,
  shutdownHostTelemetry,
} from "../../telemetry/index.ts";
import { waitForPersistedUserMessage } from "./context-clip-persistence.ts";
import {
  serializePromptForModel,
} from "./context-clip-prompt.ts";
import { createSessionEventMapper } from "./map-events.ts";
import { createAgentTools } from "../../agent-tools/index.ts";
import { wikilotPromptOptions } from "./system-prompt.ts";
import {
  decodeWorkerCommand,
  type WorkerCommand,
  type WorkerMessage,
  type WorkerResourceState,
  type WorkerStartCommand,
  type WorkerSessionConfig,
} from "./worker-protocol.ts";
import {
  sessionConfigEntryData,
  WIKILOT_SESSION_ENTRY_TYPE,
} from "../../../shared/workspace/index.ts";

function send(message: WorkerMessage): void {
  process.send?.(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

initHostTelemetry();

let session: AgentSession | undefined;
let started: WorkerStartCommand | undefined;
let modelRuntime: ModelRuntime | undefined;
let settingsManager: SettingsManager | undefined;
let resourceLoader: DefaultResourceLoader | undefined;
let currentConfig: WorkerSessionConfig | undefined;
let modelReady = false;
let compacting = false;
let lastContext = "";
let contextRefreshQueued = false;

function publishContext(): void {
  if (!session || !modelRuntime) return;
  const model = session.model;
  // A resource-only Runtime may hold a placeholder or Pi's default model.
  const knownModel = currentConfig?.provider && currentConfig.model && model
    ? modelRuntime.getModel(model.provider, model.id)
    : undefined;
  const usage = knownModel
    ? session.getContextUsage()
    : undefined;
  const context: SessionContextState = usage && model
    ? { status: compacting ? "compacting" : "ready", provider: model.provider,
        model: model.id, contextWindow: usage.contextWindow, usedTokens: usage.tokens }
    : { status: "unavailable" };
  const serialized = JSON.stringify(context);
  if (serialized === lastContext) return;
  lastContext = serialized;
  send({ type: "event", event: { type: "context_usage", context } });
}

function scheduleContextRefresh(): void {
  if (contextRefreshQueued) return;
  contextRefreshQueued = true;
  queueMicrotask(() => {
    contextRefreshQueued = false;
    // Pi persists message_end after notifying subscribers.
    publishContext();
  });
}

type RuntimeModel = ReturnType<ModelRuntime["getModels"]>[number];

/** Keep an unavailable saved Model as a non-executable placeholder. */
function placeholderModel(config: WorkerSessionConfig): RuntimeModel {
  return {
    provider: config.provider!,
    id: config.model!,
    name: config.model!,
    api: "openai-completions",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  } as RuntimeModel;
}

async function resolveModel(config: WorkerSessionConfig): Promise<{
  model: RuntimeModel | undefined;
  ready: boolean;
}> {
  if (!config.provider || !config.model || !modelRuntime) {
    return { model: undefined, ready: false };
  }
  const model = modelRuntime.getModel(config.provider, config.model);
  if (!model) {
    return { model: placeholderModel(config), ready: false };
  }
  try {
    return { model, ready: (await modelRuntime.getAuth(model)) !== undefined };
  } catch {
    // Resource preparation is deliberately independent from auth readiness.
    return { model, ready: false };
  }
}

function resourceState(): WorkerResourceState {
  return {
    skills:
      resourceLoader?.getSkills().skills.map(({ name, description }) => ({
        name,
        description,
      })) ?? [],
    modelReady,
  };
}

/** Compose and fully bind the Pi execution environment for this Session. */
async function handleStart(
  command: WorkerStartCommand,
): Promise<WorkerResourceState> {
  if (session) {
    throw new Error("Worker is already bound to a Session");
  }
  const { config } = command;
  currentConfig = config;

  modelRuntime = await createWikilotModelRuntime(command.agentDir);
  const resolved = await resolveModel(config);
  modelReady = resolved.ready;

  // Project settings and resources use the same Wikilot Agent dir as
  // discovery and model/auth, so menu Skills are executable in the Session.
  settingsManager = SettingsManager.create(command.cwd, command.agentDir, {
    projectTrusted: command.projectTrusted,
  });
  const agentTools = createAgentTools(command.cwd, command.agentDir);
  resourceLoader = new DefaultResourceLoader({
    cwd: command.cwd,
    agentDir: command.agentDir,
    settingsManager,
    additionalExtensionPaths: agentTools.additionalExtensionPaths,
    ...wikilotPromptOptions(() =>
      (currentConfig?.wikiPromptEnabled ?? config.wikiPromptEnabled)
        ? command.wikiPromptFragment
        : undefined),
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.open(
    command.sessionFile,
    command.sessionDir,
    command.cwd,
  );
  const created = await createAgentSession({
    cwd: command.cwd,
    ...(resolved.model ? { model: resolved.model } : {}),
    modelRuntime,
    sessionManager,
    resourceLoader,
    settingsManager,
    customTools: agentTools.customTools,
    thinkingLevel: config.thinkingLevel,
  });
  session = created.session;
  started = command;
  // Keep Wikilot's requested Session configuration distinct from Pi's
  // capability-clamped runtime state (for example, a non-reasoning model
  // turns a requested thinking level into the effective `off` level).
  session.sessionManager.appendCustomEntry(
    WIKILOT_SESSION_ENTRY_TYPE,
    sessionConfigEntryData(config),
  );
  if (config.thinkingLevel !== undefined) {
    // Persist Wikilot's requested value even when Pi clamps the in-memory
    // effective level for a model that does not expose reasoning controls.
    session.sessionManager.appendThinkingLevelChange(config.thinkingLevel);
  }

  // AgentSession construction binds extension tools internally, but the
  // supported non-TUI lifecycle still requires an explicit bind to emit
  // session_start and allow resources_discover to add Skills before the first
  // Turn. Print mode supplies host-neutral actions without importing Pi TUI.
  await session.bindExtensions({
    mode: "print",
    abortHandler: () => {
      void session?.abort();
    },
    shutdownHandler: () => {
      // The Host owns process shutdown; extensions may not terminate it here.
    },
  });

  const mapSessionEvent = createSessionEventMapper();
  session.subscribe((event) => {
    if (event.type === "agent_start") {
      // Read after all before_agent_start extensions have composed the prompt.
      const systemPrompt = session!.systemPrompt;
      send({
        type: "prompt_context",
        context: {
          systemPrompt,
          wikiFragmentPresent:
            (currentConfig?.wikiPromptEnabled ?? config.wikiPromptEnabled) &&
            systemPrompt.includes(command.wikiPromptFragment),
        },
      });
    }
    if (event.type === "message_end") scheduleContextRefresh();
    if (event.type === "compaction_start" || event.type === "compaction_end") {
      compacting = event.type === "compaction_start";
      publishContext();
    }
    if (event.type === "agent_settled") {
      publishContext();
      endWorkerTurn();
    }
    if (event.type === "tool_execution_start") {
      beginToolExecution({
        sessionId: command.sessionId,
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      });
    }
    if (event.type === "tool_execution_end") {
      endToolExecution({
        toolCallId: event.toolCallId,
        outcome: event.isError ? "error" : "success",
      });
    }
    for (const mapped of mapSessionEvent(event)) {
      send({ type: "event", event: mapped });
    }
  });
  publishContext();
  return resourceState();
}

async function handleConfigure(config: WorkerSessionConfig): Promise<void> {
  if (
    !session ||
    !started ||
    !modelRuntime ||
    !config.provider ||
    !config.model
  ) {
    throw new Error("Worker has no executable Model configuration");
  }
  // Main and this Worker own separate ModelRuntime instances. Provider or
  // Credential mutations can happen while this resource-only Worker is warm,
  // so refresh the Worker catalog before applying a newly selected Model.
  await syncUserProviders(modelRuntime, started.agentDir);
  const model = modelRuntime.getModel(config.provider, config.model);
  if (!model) {
    throw new Error(`Model not available: ${config.provider}/${config.model}`);
  }
  await session.setModel(model);
  modelReady = true;
  session.setThinkingLevel(config.thinkingLevel);
  session.sessionManager.appendCustomEntry(
    WIKILOT_SESSION_ENTRY_TYPE,
    sessionConfigEntryData(config),
  );
  session.sessionManager.appendThinkingLevelChange(config.thinkingLevel);
  currentConfig = config;
  started = { ...started, config };
  // Rebuild from the already-loaded ResourceLoader snapshot. On-disk resource
  // changes remain gated behind the explicit Reload command.
  session.setActiveToolsByName(session.getActiveToolNames());
  publishContext();
}

/** Kick off one Turn; the ack answers acceptance, the turn streams via events. */
async function handlePrompt(
  command: Extract<WorkerCommand, { type: "prompt" }>,
): Promise<void> {
  if (
    !session ||
    !started ||
    !started.config.provider ||
    !started.config.model
  ) {
    throw new Error("Worker has no executable Model configuration");
  }
  const { config } = started;
  const provider = config.provider;
  const model = config.model;
  if (!provider || !model) {
    throw new Error("Worker has no executable Model configuration");
  }
  beginWorkerTurn({
    ...(command.traceparent !== undefined
      ? { traceparent: command.traceparent }
      : {}),
    sessionId: started.sessionId,
    provider,
    model,
    thinkingLevel: config.thinkingLevel,
  });
  try {
    const sidecarId = session.sessionManager.appendCustomEntry(
      CONTEXT_CLIP_ENTRY_TYPE,
      contextClipSidecar(command.prompt),
    );
    const turn = session.prompt(serializePromptForModel(command.prompt));
    await waitForPersistedUserMessage(
      () => Boolean(session?.sessionManager.getChildren(sidecarId).find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )),
      turn,
    );
    send({
      type: "event",
      event: {
        type: "user_message",
        text: command.prompt.text,
        ...(command.prompt.command ? { command: command.prompt.command } : {}),
        clips: command.prompt.clips,
      },
    });
    await turn;
  } catch (error) {
    endWorkerTurn();
    throw error;
  }
}

async function handleShutdown(requestId: number): Promise<void> {
  session?.dispose();
  session = undefined;
  send({ type: "ack", requestId });
  await shutdownHostTelemetry();
  process.exit(0);
}

async function handle(command: WorkerCommand): Promise<void> {
  if (command.type === "shutdown") {
    await handleShutdown(command.requestId);
    return;
  }
  try {
    let state: WorkerResourceState | undefined;
    switch (command.type) {
      case "start":
        state = await handleStart(command);
        break;
      case "prompt":
        await handlePrompt(command);
        break;
      case "configure":
        await handleConfigure(command.config);
        break;
      case "reload":
        if (!session || !settingsManager) {
          throw new Error("Worker has no started Session");
        }
        settingsManager.setProjectTrusted(command.projectTrusted);
        await session.reload();
        publishContext();
        started = { ...started!, projectTrusted: command.projectTrusted };
        state = resourceState();
        break;
      case "abort":
        if (!session) {
          throw new Error("Worker has no started Session");
        }
        await session.abort();
        break;
    }
    send({
      type: "ack",
      requestId: command.requestId,
      ...(state
        ? { skills: state.skills, modelReady: state.modelReady }
        : {}),
    });
  } catch (error) {
    send({
      type: "nack",
      requestId: command.requestId,
      message: errorMessage(error),
    });
  }
}

process.on("message", (value: unknown) => {
  const command = decodeWorkerCommand(value);
  if (!command) return;
  void handle(command);
});

// Orphan guard: a Host that disappears takes its Workers with it.
process.on("disconnect", () => {
  void (async () => {
    session?.dispose();
    session = undefined;
    await shutdownHostTelemetry();
    process.exit(0);
  })();
});

// Last-resort closure for direct process.exit() and unexpected Worker failure.
// Export flushing must happen on cooperative paths above; the synchronous exit
// hook still guarantees no lifecycle span remains logically open.
process.on("exit", () => {
  endWorkerTurn();
});
