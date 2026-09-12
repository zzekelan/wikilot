import type { StructuredPrompt } from "../../../shared/session";
import type { TimelineDelta } from "../../../shared/timeline";
import type {
  WorkerPromptContext,
  WorkerResourceState,
  WorkerSessionConfig,
  WorkerStartParams,
} from "./worker-protocol";

/**
 * Main-side handle for one Session Worker child process. Implementations:
 * the real fork-based Worker (worker-process.ts) or test fakes. The Worker
 * is permanently bound to one Session and is the exclusive JSONL writer
 * while alive.
 */
export type SessionWorker = {
  /** Compose Pi services, bind Extensions, and prepare resources. */
  start(params: WorkerStartParams): Promise<WorkerResourceState>;
  /** Run one Prompt; resolves when the Worker accepts it (turn streams via events). */
  prompt(prompt: StructuredPrompt, traceparent?: string): Promise<void>;
  /** Abort the in-flight turn. */
  abort(): Promise<void>;
  /** Apply a new Session configuration between Turns. */
  configure(config: WorkerSessionConfig): Promise<{ applied: true }>;
  /** Reload Pi settings/resources while idle and return fresh metadata. */
  reload(projectTrusted: boolean): Promise<WorkerResourceState>;
  /** Graceful dispose and process exit. */
  shutdown(): Promise<void>;
  onTimelineEvent(listener: (event: TimelineDelta) => void): void;
  onPromptContext(listener: (context: WorkerPromptContext) => void): void;
  /** The Worker process exited; expected only after shutdown(). */
  onExit(listener: (exit: { expected: boolean; message: string }) => void): void;
};

/** Factory for Session Worker handles (injectable for tests). */
export type WorkerFactory = () => SessionWorker;
