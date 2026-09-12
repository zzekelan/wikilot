import { fork, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TimelineDelta } from "../../../shared/timeline";
import type { SessionWorker } from "./session-worker";
import {
  decodeWorkerMessage,
  type WorkerCommand,
  type WorkerResourceState,
  type WorkerSessionConfig,
  type WorkerPromptContext,
  type WorkerStartParams,
} from "./worker-protocol";

/**
 * The Worker entry runs directly under Node's native type stripping
 * (Node ≥ 22.18): its import graph is erasable-only, so no bundle step.
 */
const WORKER_ENTRY = join(
  dirname(fileURLToPath(import.meta.url)),
  "worker-entry.ts",
);

const SHUTDOWN_TIMEOUT_MS = 5_000;

type PendingRequest = {
  resolve(value?: WorkerResourceState): void;
  reject(error: Error): void;
};

/**
 * Fork-based Session Worker: one child process per Session, communicating
 * over Node IPC with the worker-protocol command/event shapes.
 */
export function createForkedSessionWorker(): SessionWorker {
  let child: ChildProcess | undefined;
  let nextRequestId = 0;
  let expectedExit = false;
  const pending = new Map<number, PendingRequest>();
  const timelineListeners = new Set<(event: TimelineDelta) => void>();
  const contextListeners = new Set<(context: WorkerPromptContext) => void>();
  const exitListeners = new Set<
    (exit: { expected: boolean; message: string }) => void
  >();

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      request.reject(error);
    }
    pending.clear();
  }

  function requireResourceState(
    state: WorkerResourceState | undefined,
  ): WorkerResourceState {
    if (!state) throw new Error("Session Worker omitted resource state");
    return state;
  }

  function request(command: WorkerCommand): Promise<WorkerResourceState | undefined> {
    return new Promise<WorkerResourceState | undefined>((resolve, reject) => {
      if (!child || child.killed) {
        reject(new Error("Session Runtime is not running"));
        return;
      }
      pending.set(command.requestId, { resolve, reject });
      child.send(command, (error) => {
        if (error) {
          pending.delete(command.requestId);
          reject(error);
        }
      });
    });
  }

  function onMessage(value: unknown): void {
    const message = decodeWorkerMessage(value);
    if (!message) return;
    switch (message.type) {
      case "ack": {
        const request = pending.get(message.requestId);
        if (request) {
          request.resolve(
            message.skills !== undefined
              ? {
                  skills: message.skills,
                  modelReady: message.modelReady === true,
                }
              : undefined,
          );
          pending.delete(message.requestId);
        }
        return;
      }
      case "nack": {
        pending.get(message.requestId)?.reject(new Error(message.message));
        pending.delete(message.requestId);
        return;
      }
      case "event": {
        for (const listener of timelineListeners) {
          listener(message.event);
        }
        return;
      }
      case "prompt_context": {
        for (const listener of contextListeners) {
          listener(message.context);
        }
        return;
      }
    }
  }

  function onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const expected = expectedExit;
    const reason = signal ?? `code ${code ?? "unknown"}`;
    rejectPending(new Error(`Session Runtime exited (${reason})`));
    const exit = {
      expected,
      message: expected
        ? "Session Runtime stopped"
        : `Session Runtime exited unexpectedly (${reason})`,
    };
    for (const listener of exitListeners) {
      listener(exit);
    }
  }

  return {
    async start(params: WorkerStartParams) {
      if (child) {
        throw new Error("Session Runtime already started");
      }
      const spawned = fork(WORKER_ENTRY, [], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: { ...process.env, PI_CODING_AGENT_DIR: params.agentDir },
      });
      child = spawned;
      spawned.on("message", onMessage);
      spawned.on("exit", (code, signal) => {
        child = undefined;
        onExit(code, signal);
      });
      spawned.on("error", (error) => {
        rejectPending(error);
      });
      const state = await request({
        type: "start",
        requestId: ++nextRequestId,
        ...params,
      });
      return requireResourceState(state);
    },

    async prompt(prompt, traceparent) {
      await request({
        type: "prompt",
        requestId: ++nextRequestId,
        prompt,
        ...(traceparent !== undefined ? { traceparent } : {}),
      });
    },

    async abort() {
      await request({ type: "abort", requestId: ++nextRequestId });
    },

    async configure(config: WorkerSessionConfig) {
      await request({ type: "configure", requestId: ++nextRequestId, config });
      return { applied: true as const };
    },

    async reload(projectTrusted) {
      const state = await request({
        type: "reload",
        requestId: ++nextRequestId,
        projectTrusted,
      });
      return requireResourceState(state);
    },

    async shutdown() {
      const running = child;
      if (!running) return;
      expectedExit = true;
      const exited = new Promise<void>((resolve) => {
        running.once("exit", () => resolve());
      });
      await request({ type: "shutdown", requestId: ++nextRequestId }).catch(
        () => {},
      );
      await Promise.race([
        exited,
        new Promise<void>((resolve) => {
          setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
        }),
      ]);
      if (!running.killed) {
        running.kill("SIGKILL");
      }
    },

    onTimelineEvent(listener) {
      timelineListeners.add(listener);
    },

    onPromptContext(listener) {
      contextListeners.add(listener);
    },

    onExit(listener) {
      exitListeners.add(listener);
    },
  };
}
