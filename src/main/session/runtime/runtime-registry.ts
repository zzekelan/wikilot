import type { SessionRuntimeStatus } from "../../../shared/timeline";
import type { SessionWorker } from "./session-worker";

type RegistryEntry = {
  worker: SessionWorker | undefined;
  status: SessionRuntimeStatus;
  /** Single-flight start promise coalescing concurrent ensureStarted calls. */
  starting: Promise<SessionWorker> | undefined;
  /** Single-flight shutdown promise shared by every disposal caller. */
  stopping: Promise<void> | undefined;
};

export type RuntimeRegistryDeps = {
  /** Status transitions stream to Application event subscribers. */
  onStatusChange(key: string, status: SessionRuntimeStatus): void;
};

export type RuntimeRegistry = {
  statusOf(key: string): SessionRuntimeStatus;
  get(key: string): SessionWorker | undefined;
  /**
   * Lazily start (or return) the one Worker bound to a Session key. A second
   * Worker can never start for the same Session: concurrent calls coalesce
   * onto the in-flight start, and later calls return the live Worker.
   */
  ensureStarted(
    key: string,
    start: () => Promise<SessionWorker>,
  ): Promise<SessionWorker>;
  /** Turn-state transitions for a live Worker (idle ↔ running). */
  setStatus(key: string, status: "idle" | "running"): void;
  /** Release ownership after an unexpected Worker exit (no shutdown). */
  releaseAfterExit(key: string): void;
  /** Stop and remove the Session's Worker, if any. */
  dispose(key: string): Promise<void>;
  disposeAll(): Promise<void>;
};

/**
 * Per-Session Worker ownership. Guarantees a single Worker per Session and
 * owns the ephemeral runtime status (unloaded → starting → idle ↔ running →
 * stopping → unloaded) that replaces the old global busy flag.
 */
export function createRuntimeRegistry(
  deps: RuntimeRegistryDeps,
): RuntimeRegistry {
  const entries = new Map<string, RegistryEntry>();

  function transition(key: string, status: SessionRuntimeStatus): void {
    const entry = entries.get(key);
    if (entry) {
      entry.status = status;
    }
    deps.onStatusChange(key, status);
  }

  async function dispose(key: string): Promise<void> {
    const entry = entries.get(key);
    if (!entry) return;
    if (entry.stopping) return entry.stopping;

    transition(key, "stopping");
    entry.stopping = (async () => {
      try {
        // A Worker still starting has no handle yet; wait for the single-flight
        // start and shut down whatever it produces.
        const worker =
          entry.worker ?? (await entry.starting?.catch(() => undefined));
        if (worker) {
          await worker.shutdown().catch(() => {});
        }
      } finally {
        if (entries.get(key) === entry) entries.delete(key);
        transition(key, "unloaded");
      }
    })();
    return entry.stopping;
  }

  async function ensureStarted(
    key: string,
    start: () => Promise<SessionWorker>,
  ): Promise<SessionWorker> {
    const existing = entries.get(key);
    if (existing?.status === "stopping") {
      await existing.stopping;
      return ensureStarted(key, start);
    }
    if (existing?.starting) return existing.starting;
    if (existing?.worker) return existing.worker;

    const entry: RegistryEntry = {
      worker: undefined,
      status: "starting",
      starting: undefined,
      stopping: undefined,
    };
    entries.set(key, entry);
    transition(key, "starting");

    entry.starting = (async () => {
      try {
        const worker = await start();
        entry.worker = worker;
        entry.starting = undefined;
        // A dispose may have started while the Worker was spawning.
        if (entry.status !== "stopping") {
          transition(key, "idle");
        }
        return worker;
      } catch (error) {
        entries.delete(key);
        transition(key, "unloaded");
        throw error;
      }
    })();
    return entry.starting;
  }

  return {
    statusOf(key) {
      return entries.get(key)?.status ?? "unloaded";
    },

    get(key) {
      const entry = entries.get(key);
      return entry && entry.status !== "stopping" ? entry.worker : undefined;
    },

    ensureStarted,

    setStatus(key, status) {
      const entry = entries.get(key);
      if (!entry || entry.starting || entry.status === "stopping") return;
      transition(key, status);
    },

    releaseAfterExit(key) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.starting = undefined;
      entries.delete(key);
      transition(key, "unloaded");
    },

    dispose,

    async disposeAll() {
      for (const key of [...entries.keys()]) {
        await dispose(key);
      }
    },
  };
}
