import { randomUUID } from "node:crypto";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { StructuredPrompt } from "../../shared/session";
import {
  DEFAULT_APP_DEFAULTS,
  type SessionModelDefault,
  type ThinkingLevel,
} from "../../shared/settings";
import type {
  SessionConfigurationUpdate,
  SessionConfigurationUpdateResult,
  SessionSkill,
} from "../../shared/workspace";
import type {
  SessionRuntimeStatus,
  TimelineDelta,
} from "../../shared/timeline";
import type { ModelServices } from "../models";
import {
  beginSessionPrompt,
  endSessionPrompt,
  recordSessionRuntimeDisposal,
  setSessionPromptContent,
} from "../telemetry";
import { appendSessionConfig, readSessionConfig, type SessionConfig } from "./session-config";
import type { SessionHandle } from "./session-repository";
import { sessionIdentityKey } from "./session-identity";
import {
  createRuntimeRegistry,
  type RuntimeRegistry,
} from "./runtime/runtime-registry";
import type { SessionWorker, WorkerFactory } from "./runtime/session-worker";
import { loadWikiPromptFragment } from "./runtime/wiki-prompt";
import { createForkedSessionWorker } from "./runtime/worker-process";
import type {
  WorkerResourceState,
  WorkerSessionConfig,
} from "./runtime/worker-protocol";

export type RuntimeSessionIdentity = {
  workspaceId: string;
  sessionId: string;
};

type ExecutableWorkerSessionConfig = WorkerSessionConfig & {
  provider: string;
  model: string;
};

export type TimelineListener = (
  delta: TimelineDelta,
  session: RuntimeSessionIdentity,
) => void;

export type SessionExecutionDeps = {
  /** Model/Credential services (Main-internal ModelRuntime access). */
  modelServices: Pick<ModelServices, "getModelRuntime">;
  /** Persist the last explicit Composer Model/Effort for future Sessions. */
  setSessionModelDefault(selection: SessionModelDefault): void;
  /** Wikilot-owned Agent data root handed to the Worker's ModelRuntime. */
  getAgentDir(): string;
  /** Main-resolved project trust decision consumed by the Worker. */
  getProjectTrust(cwd: string): boolean;
  /** Worker factory; defaults to forking a real child process. */
  createWorker?: WorkerFactory;
  /** Main-side writer used only when no Worker owns the Session file. */
  persistConfiguration?: (
    session: SessionHandle,
    config: SessionConfig,
  ) => Promise<void> | void;
};

export type SessionExecution = {
  /** Prepare the explicitly identified Session's resources and return Skills. */
  prepare(session: SessionHandle): Promise<SessionSkill[]>;
  /** Release a Session Runtime when its Renderer selection changes. */
  release(workspaceId: string, sessionId: string): Promise<void>;
  /** Forget a deleted Session's internal handle. */
  forget(workspaceId: string, sessionId: string): void;
  /** Invalidate loaded Runtimes affected by a Provider/Credential change. */
  invalidateProvider(providerId: string): void;
  /** Send a user message through the explicitly identified Session's Worker. */
  prompt(session: SessionHandle, prompt: StructuredPrompt): Promise<void>;
  /** Abort exactly one Session's in-flight Turn and wait for it to settle. */
  abort(workspaceId: string, sessionId: string): Promise<void>;
  updateConfiguration(
    session: SessionHandle,
    patch: SessionConfigurationUpdate,
  ): Promise<SessionConfigurationUpdateResult>;
  getConfiguration(session: SessionHandle): SessionConfigurationUpdateResult;
  reloadResources(session: SessionHandle): Promise<SessionSkill[]>;
  getStatusFor(workspaceId: string, sessionId: string): SessionRuntimeStatus;
  isTurnInFlight(workspaceId: string, sessionId: string): boolean;
  disposeIfIdle(workspaceId: string, sessionId: string): Promise<void>;
  /** Host lifecycle boundary: gracefully stop every loaded Session Worker. */
  shutdown(): Promise<void>;
  /** Subscribe to Timeline events from the selected Session's Worker. */
  subscribe(listener: TimelineListener): () => void;
};

const IDLE_DISPOSAL_DELAY_MS = 250;

function sessionKey(session: SessionHandle): string {
  return sessionIdentityKey(session.workspaceId, session.sessionId);
}

/** Composer send is allowed only while the Session has no turn in flight. */
function canSendPrompt(status: SessionRuntimeStatus): boolean {
  return status === "unloaded" || status === "idle" || status === "stopping";
}

type InFlightTurn = {
  settled: Promise<void>;
  markSettled(): void;
  workerReady: Promise<SessionWorker>;
  markWorkerReady(worker: SessionWorker): void;
};

function createInFlightTurn(): InFlightTurn {
  let markSettled!: () => void;
  let markWorkerReady!: (worker: SessionWorker) => void;
  return {
    settled: new Promise<void>((resolve) => {
      markSettled = resolve;
    }),
    markSettled: () => markSettled(),
    workerReady: new Promise<SessionWorker>((resolve) => {
      markWorkerReady = resolve;
    }),
    markWorkerReady: (worker) => markWorkerReady(worker),
  };
}

/**
 * Per-Session execution through dedicated Worker child processes. Renderer
 * selection explicitly prepares one Session's resources before its first
 * Prompt; a direct Prompt can still start an unloaded Runtime as a fallback.
 * While a Worker lives it is the exclusive Session JSONL writer (Main stays
 * read-only). Runtime status is per-Session — no global busy singleton.
 */
export function createSessionExecution(
  deps: SessionExecutionDeps,
): SessionExecution {
  const createWorker = deps.createWorker ?? createForkedSessionWorker;
  const listeners = new Set<TimelineListener>();
  const sessionIdentities = new Map<string, RuntimeSessionIdentity>();
  const configurations = new Map<string, WorkerSessionConfig>();
  const pendingConfigurations = new Map<string, WorkerSessionConfig>();
  const resourceStates = new Map<string, WorkerResourceState>();
  const workerInstanceIds = new Map<string, string>();
  const sessionHandles = new Map<string, SessionHandle>();
  const selectedSessions = new Set<string>();
  const invalidatedSessions = new Set<string>();
  const rebuildingSessions = new Map<string, Promise<void>>();
  const applyingConfigurations = new Map<string, Promise<void>>();
  const inFlightTurns = new Map<string, InFlightTurn>();
  const idleDisposals = new Map<string, ReturnType<typeof setTimeout>>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;

  async function persistConfiguration(
    session: SessionHandle,
    config: SessionConfig,
  ): Promise<void> {
    if (deps.persistConfiguration) {
      await deps.persistConfiguration(session, config);
    } else {
      appendSessionConfig(session.sessionManager, config);
    }
  }

  function saveSessionModelDefault(
    config: ExecutableWorkerSessionConfig,
  ): void {
    deps.setSessionModelDefault({
      provider: config.provider,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
    });
  }

  function emitToSession(
    session: RuntimeSessionIdentity,
    delta: TimelineDelta,
  ): void {
    for (const listener of listeners) {
      listener(delta, session);
    }
  }

  function emit(key: string, delta: TimelineDelta): void {
    const session = sessionIdentities.get(key);
    if (session) emitToSession(session, delta);
  }

  function cancelIdleDisposal(key: string): void {
    const timer = idleDisposals.get(key);
    if (!timer) return;
    clearTimeout(timer);
    idleDisposals.delete(key);
  }

  function scheduleIdleDisposal(key: string): void {
    if (selectedSessions.has(key)) return;
    cancelIdleDisposal(key);
    const timer = setTimeout(() => {
      idleDisposals.delete(key);
      if (registry.statusOf(key) !== "idle") return;
      const session = sessionIdentities.get(key);
      const workerInstanceId = workerInstanceIds.get(key);
      if (session && workerInstanceId) {
        recordSessionRuntimeDisposal({
          ...session,
          workerInstanceId,
          reason: "background_idle",
        });
      }
      void registry.dispose(key);
    }, IDLE_DISPOSAL_DELAY_MS);
    timer.unref?.();
    idleDisposals.set(key, timer);
  }

  const registry: RuntimeRegistry = createRuntimeRegistry({
    onStatusChange(key, status) {
      if (status === "starting") {
        // ensureStarted may have waited for an old Runtime to unload. Restore
        // identity before publishing replacement startup or Worker events.
        const session = sessionHandles.get(key);
        if (session) sessionIdentities.set(key, {
          workspaceId: session.workspaceId,
          sessionId: session.sessionId,
        });
      }
      emit(key, { type: "session_status", status });
      if (status === "idle" && invalidatedSessions.has(key)) {
        if (selectedSessions.has(key)) {
          void rebuildRuntime(key).catch((error: unknown) => {
            emit(key, {
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
        } else {
          scheduleIdleDisposal(key);
        }
      }
      if (status === "unloaded") {
        cancelIdleDisposal(key);
        invalidatedSessions.delete(key);
        sessionIdentities.delete(key);
        resourceStates.delete(key);
        workerInstanceIds.delete(key);
      }
    },
  });

  function storedConfiguration(session: SessionHandle): SessionConfig {
    const snapshot = readSessionConfig(session.sessionManager);
    return {
      ...snapshot,
      wikiPromptEnabled:
        snapshot.wikiPromptEnabled ?? DEFAULT_APP_DEFAULTS.wikiPromptEnabled,
    };
  }

  /** The Session history is the source of truth for its Model. */
  function resolveRuntimeConfig(session: SessionHandle): WorkerSessionConfig {
    const snapshot = storedConfiguration(session);
    return {
      ...(snapshot.provider && snapshot.model
        ? { provider: snapshot.provider, model: snapshot.model }
        : {}),
      thinkingLevel: snapshot.thinkingLevel ?? "off",
      wikiPromptEnabled:
        snapshot.wikiPromptEnabled ?? DEFAULT_APP_DEFAULTS.wikiPromptEnabled,
    };
  }

  /** Prompt execution alone still requires an executable Session Model. */
  function resolveConfig(session: SessionHandle): ExecutableWorkerSessionConfig {
    const config = resolveRuntimeConfig(session);
    if (
      !config.provider ||
      !config.model ||
      !readSessionConfig(session.sessionManager).thinkingLevel
    ) {
      throw new Error("Choose a Model and Effort in the Composer before sending");
    }
    return config as ExecutableWorkerSessionConfig;
  }

  /** Fail fast with actionable errors before a Worker is even spawned. */
  async function assertModelExecutable(
    config: { provider: string; model: string; thinkingLevel?: ThinkingLevel },
  ): Promise<void> {
    const modelRuntime = await deps.modelServices.getModelRuntime();
    const model = modelRuntime.getModel(config.provider, config.model);
    if (!model) {
      throw new Error(
        `Model not available: ${config.provider}/${config.model}. Check the Base Model Catalog in Settings`,
      );
    }
    if (
      config.thinkingLevel !== undefined &&
      !getSupportedThinkingLevels(model).includes(config.thinkingLevel)
    ) {
      throw new Error(
        `Effort ${config.thinkingLevel} is not available for ${config.provider}/${config.model}`,
      );
    }
    const auth = await modelRuntime.getAuth(model);
    if (!auth) {
      throw new Error(
        `No Credential configured for provider "${config.provider}" — add one in Settings`,
      );
    }
  }

  function markModelReady(key: string): void {
    const state = resourceStates.get(key);
    resourceStates.set(key, {
      skills: state?.skills ?? [],
      modelReady: true,
    });
  }

  function completeIdleTransition(key: string): void {
    registry.setStatus(key, "idle");
    // The Registry status callback owns invalidated selected Runtimes. Keep an
    // invalidation on an unselected settled Runtime until its disposal timer
    // fires, so a quick reselection still rebuilds before the next Turn.
    if (invalidatedSessions.has(key) && selectedSessions.has(key)) return;
    if (!selectedSessions.has(key)) {
      scheduleIdleDisposal(key);
      return;
    }
    invalidatedSessions.delete(key);
  }

  async function applyPendingConfiguration(
    key: string,
    worker: SessionWorker,
  ): Promise<void> {
    const existing = applyingConfigurations.get(key);
    if (existing) {
      await existing;
      return;
    }
    const task = (async () => {
      try {
        for (;;) {
          const pending = pendingConfigurations.get(key);
          if (!pending) break;
          await worker.configure(pending);
          configurations.set(key, pending);
          markModelReady(key);
          if (pendingConfigurations.get(key) === pending) {
            pendingConfigurations.delete(key);
          }
        }
      } catch (error) {
        pendingConfigurations.delete(key);
        emit(key, {
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        completeIdleTransition(key);
      }
    })();
    applyingConfigurations.set(key, task);
    try {
      await task;
    } finally {
      if (applyingConfigurations.get(key) === task) {
        applyingConfigurations.delete(key);
      }
    }
  }

  async function rebuildRuntime(key: string): Promise<void> {
    const existing = rebuildingSessions.get(key);
    if (existing) return existing;
    const task = (async () => {
      for (;;) {
        if (registry.statusOf(key) !== "idle") return;
        invalidatedSessions.delete(key);
        cancelIdleDisposal(key);
        await registry.dispose(key);
        const session = sessionHandles.get(key);
        if (!session || !selectedSessions.has(key) || shuttingDown) return;
        await ensureWorker(
          session,
          configurations.get(key) ?? resolveRuntimeConfig(session),
        );
        // A Provider/Credential mutation can arrive while the replacement
        // Worker is starting. Drain that invalidation before exposing this
        // Runtime as ready for the next Prompt.
        if (
          !invalidatedSessions.has(key) ||
          !selectedSessions.has(key) ||
          shuttingDown
        ) {
          return;
        }
      }
    })();
    rebuildingSessions.set(key, task);
    try {
      await task;
    } finally {
      if (rebuildingSessions.get(key) === task) {
        rebuildingSessions.delete(key);
      }
    }
  }

  function wireWorker(
    key: string,
    originatingSession: SessionHandle,
    worker: SessionWorker,
    config: WorkerSessionConfig,
  ): void {
    const instanceId = workerInstanceIds.get(key);
    const isCurrentWorker = () => workerInstanceIds.get(key) === instanceId &&
      registry.statusOf(key) !== "stopping" && registry.statusOf(key) !== "unloaded";
    worker.onTimelineEvent((event) => {
      if (!isCurrentWorker()) return;
      emit(key, event);
      if (event.type === "agent_settled") {
        endSessionPrompt(sessionIdentities.get(key)?.sessionId);
        if (
          pendingConfigurations.has(key) ||
          applyingConfigurations.has(key)
        ) {
          void applyPendingConfiguration(key, worker).catch(() => {});
        } else {
          completeIdleTransition(key);
        }
      }
    });
    worker.onPromptContext((context) => {
      if (!isCurrentWorker()) return;
      const effective = configurations.get(key) ?? config;
      setSessionPromptContent({
        sessionId: sessionIdentities.get(key)?.sessionId,
        systemPrompt: context.systemPrompt,
        ...(effective.wikiPromptEnabled && context.wikiFragmentPresent
          ? { wikiPromptFragment: loadWikiPromptFragment() }
          : {}),
      });
    });
    worker.onExit((exit) => {
      if (exit.expected || !isCurrentWorker()) return;
      // Crash: report against its originating Session before releasing identity.
      emit(key, { type: "error", message: exit.message });
      endSessionPrompt(sessionIdentities.get(key)?.sessionId);
      const identity = sessionIdentities.get(key);
      const workerInstanceId = workerInstanceIds.get(key);
      if (identity && workerInstanceId) {
        recordSessionRuntimeDisposal({
          ...identity,
          workerInstanceId,
          reason: "worker_failure",
        });
      }
      registry.releaseAfterExit(key);
      const pending = pendingConfigurations.get(key);
      if (pending) {
        pendingConfigurations.delete(key);
        void persistConfiguration(originatingSession, pending).catch(
          (error: unknown) => {
            if (identity) {
              emitToSession(identity, {
                type: "error",
                message: error instanceof Error ? error.message : String(error),
              });
            }
          },
        );
        configurations.set(key, pending);
      }
    });
  }

  async function ensureWorker(
    session: SessionHandle,
    config: WorkerSessionConfig,
  ): Promise<SessionWorker> {
    const key = sessionKey(session);
    sessionHandles.set(key, session);
    sessionIdentities.set(key, {
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
    });
    const worker = await registry.ensureStarted(key, async () => {
      if (!session.sessionFile) {
        throw new Error("Session has no persistence target");
      }
      const worker = createWorker();
      workerInstanceIds.set(key, randomUUID());
      configurations.set(key, config);
      wireWorker(key, session, worker, config);
      try {
        const state = await worker.start({
          sessionId: session.sessionId,
          cwd: session.cwd,
          sessionDir: session.sessionDir,
          sessionFile: session.sessionFile,
          agentDir: deps.getAgentDir(),
          config,
          projectTrusted: deps.getProjectTrust(session.cwd),
          wikiPromptFragment: loadWikiPromptFragment(),
        });
        resourceStates.set(key, state);
      } catch (error) {
        // A nacked start leaves a forked child behind; stop it before
        // propagating so a failed lazy start never leaks a process.
        await worker.shutdown().catch(() => {});
        throw error;
      }
      return worker;
    });
    if (
      pendingConfigurations.has(key) ||
      applyingConfigurations.has(key)
    ) {
      await applyPendingConfiguration(key, worker);
    }
    return worker;
  }

  return {
    async prepare(session) {
      if (shuttingDown) throw new Error("Host is shutting down");
      const key = sessionKey(session);
      selectedSessions.add(key);
      cancelIdleDisposal(key);
      sessionHandles.set(key, session);
      sessionIdentities.set(key, {
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
      });
      await ensureWorker(
        session,
        configurations.get(key) ?? resolveRuntimeConfig(session),
      );
      const rebuild = rebuildingSessions.get(key);
      if (rebuild) {
        await rebuild;
      } else if (
        invalidatedSessions.has(key) &&
        registry.statusOf(key) === "idle"
      ) {
        await rebuildRuntime(key);
      }
      return resourceStates.get(key)?.skills ?? [];
    },

    async release(workspaceId, sessionId) {
      const key = sessionIdentityKey(workspaceId, sessionId);
      selectedSessions.delete(key);
      cancelIdleDisposal(key);
      const status = registry.statusOf(key);
      if (status === "idle" || status === "starting" || status === "stopping") {
        invalidatedSessions.delete(key);
        const identity = sessionIdentities.get(key);
        const workerInstanceId = workerInstanceIds.get(key);
        if (identity && workerInstanceId) {
          recordSessionRuntimeDisposal({
            ...identity,
            workerInstanceId,
            reason: "selection_release",
          });
        }
        await registry.dispose(key);
      } else if (status === "running") {
        // The active Turn owns the JSONL lease until agent_settled. Its
        // completion path observes that the Session is no longer selected and
        // disposes the Worker without interrupting the Turn.
      }
    },

    forget(workspaceId, sessionId) {
      const key = sessionIdentityKey(workspaceId, sessionId);
      selectedSessions.delete(key);
      sessionHandles.delete(key);
      configurations.delete(key);
      pendingConfigurations.delete(key);
      invalidatedSessions.delete(key);
      resourceStates.delete(key);
      sessionIdentities.delete(key);
      workerInstanceIds.delete(key);
    },

    invalidateProvider(providerId) {
      const target = providerId.trim();
      if (!target) return;

      // Each Worker owns a private ModelRuntime catalog. A Provider or
      // Credential mutation can change visibility or definitions for any
      // loaded Worker, including a resource-only Worker with no Model yet.
      for (const key of sessionIdentities.keys()) {
        const status = registry.statusOf(key);
        if (status === "unloaded") continue;
        invalidatedSessions.add(key);
        if (status === "idle") {
          void rebuildRuntime(key).catch((error: unknown) => {
            emit(key, {
              type: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
    },

    async prompt(session, prompt) {
      if (shuttingDown) throw new Error("Host is shutting down");
      if (!prompt.text && prompt.clips.length === 0) {
        throw new Error("Prompt text or at least one Context Clip is required");
      }
      const key = sessionKey(session);
      cancelIdleDisposal(key);
      sessionIdentities.set(key, {
        workspaceId: session.workspaceId,
        sessionId: session.sessionId,
      });
      if (inFlightTurns.has(key) || !canSendPrompt(registry.statusOf(key))) {
        throw new Error("Cannot send while a Session is busy");
      }
      const inFlight = createInFlightTurn();
      inFlightTurns.set(key, inFlight);

      try {
        const cached = configurations.get(key);
        const requested = pendingConfigurations.get(key) ?? cached;
        const config: ExecutableWorkerSessionConfig =
          requested?.provider && requested.model
            ? {
                ...requested,
                provider: requested.provider,
                model: requested.model,
              }
            : resolveConfig(session);
        configurations.set(key, config);
        await assertModelExecutable(config);
        if (shuttingDown) throw new Error("Host is shutting down");
        const worker = await ensureWorker(session, config);
        if (shuttingDown) throw new Error("Host is shutting down");

        const applied = configurations.get(key);
        const effectiveConfig: ExecutableWorkerSessionConfig =
          applied?.provider && applied.model
            ? {
                ...applied,
                provider: applied.provider,
                model: applied.model,
              }
            : config;

        // A resource-only preparation may have deliberately started without
        // an executable Model. Configure it only now, after Main has verified
        // the latest Provider/Credential state.
        const state = resourceStates.get(key);
        if (!state?.modelReady) {
          await worker.configure(effectiveConfig);
          markModelReady(key);
          configurations.set(key, effectiveConfig);
        }

        // A Prompt may have waited for an automatic idle disposal. That
        // disposal emits unloaded and releases the old runtime's identity.
        sessionIdentities.set(key, {
          workspaceId: session.workspaceId,
          sessionId: session.sessionId,
        });
        const traceparent = beginSessionPrompt({
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          cwd: session.cwd,
          provider: effectiveConfig.provider,
          model: effectiveConfig.model,
          thinkingLevel: effectiveConfig.thinkingLevel,
          wikiPromptEnabled: effectiveConfig.wikiPromptEnabled,
          clipCount: prompt.clips.length,
          clipCharacters: prompt.clips.reduce(
            (total, clip) => total + [...clip.text].length,
            0,
          ),
        });
        registry.setStatus(key, "running");

        try {
          const workerTurn = worker.prompt(prompt, traceparent);
          inFlight.markWorkerReady(worker);
          await workerTurn;
        } catch (error) {
          // A Worker crash already emitted its own error via onExit (the
          // registry is back to unloaded); only report plain turn failures.
          if (registry.statusOf(key) !== "unloaded") {
            completeIdleTransition(key);
            const message =
              error instanceof Error ? error.message : String(error);
            emit(key, { type: "error", message });
          }
          endSessionPrompt(session.sessionId);
          throw error;
        }
      } finally {
        inFlight.markSettled();
        if (inFlightTurns.get(key) === inFlight) {
          inFlightTurns.delete(key);
        }
      }
    },

    async abort(workspaceId, sessionId) {
      const key = sessionIdentityKey(workspaceId, sessionId);
      const inFlight = inFlightTurns.get(key);
      if (!inFlight) {
        throw new Error("No in-flight turn to cancel");
      }
      const target = await Promise.race([
        inFlight.workerReady.then((worker) => ({ worker })),
        inFlight.settled.then(() => ({ worker: undefined })),
      ]);
      if (target.worker) {
        await target.worker.abort();
      }
      await inFlight.settled;
    },

    async updateConfiguration(session, patch) {
      const key = sessionKey(session);
      cancelIdleDisposal(key);
      if (
        (patch.provider !== undefined) !==
          (patch.model !== undefined)
      ) {
        throw new Error("Session Provider and Model must be chosen together");
      }

      const current =
        pendingConfigurations.get(key) ??
        configurations.get(key) ??
        storedConfiguration(session);
      const next: SessionConfig = { ...current, ...patch };
      const selectingModel =
        patch.provider !== undefined && patch.model !== undefined;
      const confirmedModelSelection =
        selectingModel || patch.thinkingLevel !== undefined;
      if (selectingModel && patch.thinkingLevel === undefined) {
        throw new Error("Session Model and Effort must be chosen together");
      }
      const hasExecutablePair = Boolean(
        next.provider && next.model && next.thinkingLevel,
      );
      if (
        next.provider &&
        next.model &&
        next.thinkingLevel &&
        (selectingModel || patch.thinkingLevel !== undefined)
      ) {
        await assertModelExecutable({
          provider: next.provider,
          model: next.model,
          thinkingLevel: next.thinkingLevel,
        });
      }

      const status = registry.statusOf(key);
      const configurationTransitioning =
        status === "running" ||
        status === "starting" ||
        status === "stopping" ||
        applyingConfigurations.has(key);
      if (configurationTransitioning && hasExecutablePair) {
        const pending: ExecutableWorkerSessionConfig = {
          provider: next.provider!,
          model: next.model!,
          thinkingLevel: next.thinkingLevel!,
          wikiPromptEnabled:
            next.wikiPromptEnabled ?? DEFAULT_APP_DEFAULTS.wikiPromptEnabled,
        };
        pendingConfigurations.set(key, pending);
        if (confirmedModelSelection) saveSessionModelDefault(pending);
        if (applyingConfigurations.has(key)) {
          const worker = registry.get(key);
          if (worker) {
            void applyPendingConfiguration(key, worker).catch(() => {});
          }
        }
        return { status: "pending", configuration: pending };
      }

      if (
        configurationTransitioning &&
        !hasExecutablePair
      ) {
        throw new Error("Choose a Model in the Composer before sending");
      }

      const worker = registry.get(key);
      if (worker) {
        if (!next.provider || !next.model) {
          throw new Error("Choose a Model in the Composer before sending");
        }
        const applied: ExecutableWorkerSessionConfig = {
          provider: next.provider,
          model: next.model,
          thinkingLevel: next.thinkingLevel!,
          wikiPromptEnabled:
            next.wikiPromptEnabled ?? DEFAULT_APP_DEFAULTS.wikiPromptEnabled,
        };
        pendingConfigurations.set(key, applied);
        await applyPendingConfiguration(key, worker);
        if (confirmedModelSelection) saveSessionModelDefault(applied);
        return { status: "applied", configuration: applied };
      }

      await persistConfiguration(session, next);
      if (next.provider && next.model) {
        const applied: ExecutableWorkerSessionConfig = {
          provider: next.provider,
          model: next.model,
          thinkingLevel: next.thinkingLevel!,
          wikiPromptEnabled:
            next.wikiPromptEnabled ?? DEFAULT_APP_DEFAULTS.wikiPromptEnabled,
        };
        configurations.set(key, applied);
        if (confirmedModelSelection) saveSessionModelDefault(applied);
      } else {
        configurations.set(key, {
          thinkingLevel: next.thinkingLevel ?? "off",
          wikiPromptEnabled:
            next.wikiPromptEnabled ?? DEFAULT_APP_DEFAULTS.wikiPromptEnabled,
        });
      }
      return { status: "applied", configuration: next };
    },

    getConfiguration(session) {
      const key = sessionKey(session);
      const pending = pendingConfigurations.get(key);
      return {
        status: pending ? "pending" : "applied",
        configuration:
          pending ?? configurations.get(key) ?? storedConfiguration(session),
      };
    },

    async reloadResources(session) {
      const key = sessionKey(session);
      cancelIdleDisposal(key);
      const status = registry.statusOf(key);
      if (
        status === "running" ||
        status === "starting" ||
        status === "stopping"
      ) {
        throw new Error("Resources can only be reloaded while the Session is idle");
      }
      const worker = registry.get(key);
      if (!worker) return [];
      const state = await worker.reload(deps.getProjectTrust(session.cwd));
      resourceStates.set(key, state);
      if (registry.statusOf(key) === "idle") completeIdleTransition(key);
      return state.skills;
    },

    getStatusFor(workspaceId, sessionId) {
      return registry.statusOf(sessionIdentityKey(workspaceId, sessionId));
    },

    isTurnInFlight(workspaceId, sessionId) {
      return inFlightTurns.has(sessionIdentityKey(workspaceId, sessionId));
    },

    async disposeIfIdle(workspaceId, sessionId) {
      const key = sessionIdentityKey(workspaceId, sessionId);
      if (registry.statusOf(key) === "idle") {
        cancelIdleDisposal(key);
        await registry.dispose(key);
      }
    },

    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      for (const key of idleDisposals.keys()) cancelIdleDisposal(key);
      const turns = [...inFlightTurns.values()];
      shutdownPromise = (async () => {
        for (const [key, identity] of sessionIdentities) {
          const workerInstanceId = workerInstanceIds.get(key);
          if (workerInstanceId) {
            recordSessionRuntimeDisposal({
              ...identity,
              workerInstanceId,
              reason: "host_shutdown",
            });
          }
        }
        await registry.disposeAll();
        await Promise.all(turns.map((turn) => turn.settled));
        workerInstanceIds.clear();
      })();
      return shutdownPromise;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
