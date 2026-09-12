import { DEFAULT_APP_DEFAULTS, type AppDefaults, type SessionModelDefault } from "../../shared/settings";
import type { StructuredPrompt } from "../../shared/session";
import type {
  TimelineDeltaEvent,
  TimelineSnapshot,
} from "../../shared/timeline";
import type {
  SessionConfigurationUpdate,
  SessionConfigurationUpdateResult,
  SessionListItem,
  SessionSelectionToken,
  SessionSkill,
  SessionSwitchResult,
  WorkspaceSummary,
} from "../../shared/workspace";
import type { ModelServices } from "../models";
import {
  recordSessionSwitch,
  recordTimelineRecovery,
  type SessionSwitchSpanInput,
} from "../telemetry";
import type { WorkerFactory } from "./runtime/session-worker";
import {
  createSessionExecution,
  type SessionExecution,
} from "./session-execution";
import { resolveAppSessionDir } from "./session-paths";
import {
  createSessionRepository,
  type SessionRepository,
  type SessionSwitchDetails,
} from "./session-repository";
import { createTimelineReadModel } from "./timeline-read-model";
import type { SessionConfig } from "./session-config";
import { sessionIdentityKey } from "./session-identity";

export type SessionImageResult =
  | { status: "ready"; bytes: Uint8Array; mimeType: string }
  | { status: "pending" }
  | { status: "not-found" };

export type SessionModule = {
  list(workspaceId: string): Promise<SessionListItem[]>;
  prepare(
    workspaceId: string,
    sessionId: string,
    selectionToken: SessionSelectionToken,
  ): Promise<SessionSkill[]>;
  release(
    workspaceId: string,
    sessionId: string,
    selectionToken: SessionSelectionToken,
  ): Promise<void>;
  create(
    workspaceId: string,
    configuration?: SessionConfigurationUpdate,
  ): Promise<SessionSwitchResult>;
  open(workspaceId: string, sessionId: string): Promise<SessionSwitchResult>;
  delete(workspaceId: string, sessionId: string): Promise<void>;
  prompt(prompt: StructuredPrompt): Promise<void>;
  abort(workspaceId: string, sessionId: string): Promise<void>;
  getConfiguration(
    workspaceId: string,
    sessionId: string,
  ): Promise<SessionConfigurationUpdateResult>;
  updateConfiguration(
    workspaceId: string,
    sessionId: string,
    patch: SessionConfigurationUpdate,
  ): Promise<SessionConfigurationUpdateResult>;
  reloadResources(workspaceId: string, sessionId: string): Promise<SessionSkill[]>;
  getTimelineSnapshot(workspaceId: string, sessionId: string): TimelineSnapshot;
  getImage(
    workspaceId: string,
    sessionId: string,
    imageRef: string,
  ): Promise<SessionImageResult>;
  /** True while any Session of the Workspace has an active Turn (removal guard). */
  hasActiveTurn(workspaceId: string): Promise<boolean>;
  subscribe(listener: (event: TimelineDeltaEvent) => void): () => void;
  shutdown(): Promise<void>;
};

export type SessionModuleDeps = {
  resolveWorkspace(workspaceId: string): WorkspaceSummary;
  sessionsRoot?: string;
  agentDir: string;
  modelServices: Pick<
    ModelServices,
    "getModelRuntime" | "listBaseCatalog" | "subscribeChanges"
  >;
  getAppDefaults(): AppDefaults;
  setSessionModelDefault(selection: SessionModelDefault): void;
  getProjectDefaults(cwd: string): SessionConfig;
  getProjectTrust(cwd: string): boolean;
  beforePrompt(session: {
    workspaceId: string;
    sessionId: string;
    cwd: string;
  }): void;
};

type SessionModuleAdapters = {
  createWorker: WorkerFactory;
};

function sameSelectionToken(
  left: SessionSelectionToken,
  right: SessionSelectionToken,
): boolean {
  return left.clientId === right.clientId && left.sequence === right.sequence;
}

function acceptsSelectionToken(
  current: SessionSelectionToken | undefined,
  incoming: SessionSelectionToken,
): boolean {
  // One Desktop Shell owns a Session selection lease at a time. A different
  // client must wait for the owner to release it; otherwise a late request
  // from the old client could not be distinguished from a fresh takeover.
  if (!current) return true;
  if (current.clientId !== incoming.clientId) return false;
  return incoming.sequence > current.sequence;
}

function toSpanInput(
  action: "create" | "open",
  details: SessionSwitchDetails,
): SessionSwitchSpanInput {
  return {
    action,
    sessionId: details.result.sessionId,
  };
}

/**
 * Deep Session module. Its identity-based interface hides Pi persistence,
 * Timeline projection, Runtime Registry, and Worker process ownership.
 */
export function createSessionModule(deps: SessionModuleDeps): SessionModule {
  return createSessionModuleWithAdapters(deps);
}

/** Session-internal adapter seam used by tests beside this module. */
export function createSessionModuleWithAdapters(
  deps: SessionModuleDeps,
  adapters: Partial<SessionModuleAdapters> = {},
): SessionModule {
  const repository: SessionRepository = createSessionRepository({
    resolveWorkspace: deps.resolveWorkspace,
    resolveSessionDir: (cwd) => resolveAppSessionDir(cwd, deps.sessionsRoot),
  });
  const execution: SessionExecution = createSessionExecution({
    modelServices: deps.modelServices,
    setSessionModelDefault: deps.setSessionModelDefault,
    getAgentDir: () => deps.agentDir,
    getProjectTrust: deps.getProjectTrust,
    ...(adapters.createWorker ? { createWorker: adapters.createWorker } : {}),
  });
  const unsubscribeModelChanges = deps.modelServices.subscribeChanges(
    (providerId) => execution.invalidateProvider(providerId),
  );
  const timeline = createTimelineReadModel();
  const listeners = new Set<(event: TimelineDeltaEvent) => void>();
  const deleting = new Set<string>();
  const promptReservations = new Set<string>();
  const selectionLeases = new Map<string, SessionSelectionToken>();

  execution.subscribe((delta, identity) => {
    const event = timeline.apply(identity.workspaceId, identity.sessionId, delta);
    if (!event) return;
    for (const listener of listeners) listener(event);
  });

  async function resolveNewSessionConfig(
    workspaceId: string,
    explicit: SessionConfigurationUpdate = {},
  ): Promise<SessionConfig> {
    if ((explicit.provider === undefined) !== (explicit.model === undefined)) {
      throw new Error("Explicit Session Provider and Model must be chosen together");
    }
    if (
      (explicit.provider !== undefined || explicit.model !== undefined) &&
      explicit.thinkingLevel === undefined
    ) {
      throw new Error("Explicit Session Model and Effort must be chosen together");
    }
    if (
      explicit.thinkingLevel !== undefined &&
      (explicit.provider === undefined || explicit.model === undefined)
    ) {
      throw new Error("Explicit Session Model and Effort must be chosen together");
    }

    const cwd = deps.resolveWorkspace(workspaceId).cwd;
    const project = deps.getProjectDefaults(cwd);
    const defaults = deps.getAppDefaults();
    const explicitModel =
      explicit.provider && explicit.model && explicit.thinkingLevel
        ? {
            provider: explicit.provider,
            model: explicit.model,
            thinkingLevel: explicit.thinkingLevel,
          }
        : undefined;
    const projectModel =
      project.provider && project.model && project.thinkingLevel
        ? {
            provider: project.provider,
            model: project.model,
            thinkingLevel: project.thinkingLevel,
          }
        : undefined;
    const candidate = explicitModel ?? projectModel ?? defaults.sessionModel;
    let sessionModel: SessionModelDefault | undefined;
    if (candidate) {
      const catalog = await deps.modelServices.listBaseCatalog();
      const model = catalog
        .find((provider) => provider.id === candidate.provider)
        ?.models.find((entry) => entry.id === candidate.model);
      if (model?.thinkingLevels.includes(candidate.thinkingLevel)) {
        sessionModel = candidate;
      } else if (explicitModel) {
        throw new Error(
          `Effort ${candidate.thinkingLevel} is not available for ${candidate.provider}/${candidate.model}`,
        );
      }
    }

    return {
      ...(sessionModel ?? {}),
      wikiPromptEnabled:
        explicit.wikiPromptEnabled ??
        defaults.wikiPromptEnabled ??
        DEFAULT_APP_DEFAULTS.wikiPromptEnabled,
    };
  }

  return {
    async list(workspaceId) {
      const listed = await repository.list(workspaceId);
      return listed.map((session) => ({
        ...session,
        runtimeStatus: execution.getStatusFor(workspaceId, session.id),
      }));
    },

    prepare(workspaceId, sessionId, selectionToken) {
      const key = sessionIdentityKey(workspaceId, sessionId);
      const accepted = acceptsSelectionToken(
        selectionLeases.get(key),
        selectionToken,
      );
      if (accepted) selectionLeases.set(key, selectionToken);
      return repository.require(workspaceId, sessionId).then((session) => {
        const current = selectionLeases.get(key);
        if (!accepted || !current || !sameSelectionToken(current, selectionToken)) {
          return [];
        }
        return execution.prepare(session);
      });
    },

    release(workspaceId, sessionId, selectionToken) {
      const key = sessionIdentityKey(workspaceId, sessionId);
      const current = selectionLeases.get(key);
      if (!current || !sameSelectionToken(current, selectionToken)) {
        return Promise.resolve();
      }
      selectionLeases.delete(key);
      return execution.release(workspaceId, sessionId);
    },

    async create(workspaceId, explicitConfiguration) {
      const configuration = await resolveNewSessionConfig(
        workspaceId,
        explicitConfiguration,
      );
      const details = await repository.create(workspaceId, configuration);
      if (
        explicitConfiguration?.provider &&
        explicitConfiguration.model &&
        explicitConfiguration.thinkingLevel
      ) {
        deps.setSessionModelDefault({
          provider: configuration.provider!,
          model: configuration.model!,
          thinkingLevel: explicitConfiguration.thinkingLevel,
        });
      }
      recordSessionSwitch(toSpanInput("create", details));
      timeline.hydrate(
        details.result.workspaceId,
        details.result.sessionId,
        details.result.timelineItems,
      );
      return details.result;
    },

    async open(workspaceId, sessionId) {
      const details = await repository.open(workspaceId, sessionId);
      recordSessionSwitch(toSpanInput("open", details));
      const status = execution.getStatusFor(workspaceId, sessionId);
      if (
        status === "unloaded" ||
        !timeline.has(details.result.workspaceId, details.result.sessionId)
      ) {
        timeline.hydrate(
          details.result.workspaceId,
          details.result.sessionId,
          details.result.timelineItems,
        );
      }
      return details.result;
    },

    async delete(workspaceId, sessionId) {
      const key = sessionIdentityKey(workspaceId, sessionId);
      if (deleting.has(key)) throw new Error("Session deletion is already in progress");
      if (
        promptReservations.has(key) ||
        execution.isTurnInFlight(workspaceId, sessionId)
      ) {
        throw new Error("Cannot delete a Session with an active Turn");
      }
      deleting.add(key);
      try {
        selectionLeases.delete(key);
        await execution.release(workspaceId, sessionId);
        let status = execution.getStatusFor(workspaceId, sessionId);
        if (status === "idle") {
          await execution.disposeIfIdle(workspaceId, sessionId);
          status = execution.getStatusFor(workspaceId, sessionId);
        }
        if (status !== "unloaded") {
          throw new Error(`Cannot delete a Session while its Runtime is ${status}`);
        }
        await repository.delete(workspaceId, sessionId);
        execution.forget(workspaceId, sessionId);
        timeline.remove(workspaceId, sessionId);
      } finally {
        deleting.delete(key);
      }
    },

    async prompt(prompt) {
      const { workspaceId, sessionId } = prompt;
      const key = sessionIdentityKey(workspaceId, sessionId);
      if (deleting.has(key)) {
        throw new Error("Cannot prompt a Session while it is being deleted");
      }
      if (promptReservations.has(key)) {
        throw new Error("Cannot send while a Session is busy");
      }
      promptReservations.add(key);
      try {
        const session = await repository.require(workspaceId, sessionId);
        deps.beforePrompt({
          workspaceId: session.workspaceId,
          sessionId: session.sessionId,
          cwd: session.cwd,
        });
        await execution.prompt(session, prompt);
      } finally {
        promptReservations.delete(key);
      }
    },

    abort(workspaceId, sessionId) {
      return execution.abort(workspaceId, sessionId);
    },

    async getConfiguration(workspaceId, sessionId) {
      return execution.getConfiguration(
        await repository.require(workspaceId, sessionId),
      );
    },

    async updateConfiguration(workspaceId, sessionId, patch) {
      return execution.updateConfiguration(
        await repository.require(workspaceId, sessionId),
        patch,
      );
    },

    reloadResources(workspaceId, sessionId) {
      return repository
        .require(workspaceId, sessionId)
        .then((session) => execution.reloadResources(session));
    },

    getTimelineSnapshot(workspaceId, sessionId) {
      const snapshot = timeline.snapshot(workspaceId, sessionId);
      recordTimelineRecovery(snapshot);
      return snapshot;
    },

    async getImage(workspaceId, sessionId, imageRef) {
      let snapshot: TimelineSnapshot;
      try {
        snapshot = timeline.snapshot(workspaceId, sessionId);
      } catch {
        return { status: "not-found" };
      }
      const projected = snapshot.items.some(
        (item) => item.kind === "assistant" && item.parts.some(
          (part) => part.kind === "tool" && part.result?.images?.some(
            (image) => image.imageRef === imageRef,
          ),
        ),
      );
      if (!projected) return { status: "not-found" };

      const initial = await repository.readImage(workspaceId, sessionId, imageRef);
      if (initial.status === "ready") return initial;
      if (snapshot.status !== "running") return { status: "not-found" };

      const deadline = Date.now() + 500;
      do {
        const result = await repository.readImage(workspaceId, sessionId, imageRef);
        if (result.status === "ready") return result;
        if (Date.now() >= deadline) return { status: "pending" };
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (true);
    },

    async hasActiveTurn(workspaceId) {
      const listed = await repository.list(workspaceId);
      return listed.some((session) => {
        const key = sessionIdentityKey(workspaceId, session.id);
        const status = execution.getStatusFor(workspaceId, session.id);
        return (
          promptReservations.has(key) ||
          execution.isTurnInFlight(workspaceId, session.id) ||
          status === "running"
        );
      });
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async shutdown() {
      unsubscribeModelChanges();
      selectionLeases.clear();
      await execution.shutdown();
    },
  };
}
