import { describe, expect, it, vi } from "vitest";
import type { SessionRuntimeStatus } from "../../../shared/timeline";
import type { SessionWorker } from "./session-worker";
import type { WorkerResourceState } from "./worker-protocol";
import {
  createRuntimeRegistry,
  type RuntimeRegistry,
} from "./runtime-registry";

function fakeWorker(overrides: Partial<SessionWorker> = {}): SessionWorker {
  return {
    start: vi.fn(async (): Promise<WorkerResourceState> => ({
      skills: [],
      modelReady: true,
    })),
    prompt: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    configure: vi.fn(async () => ({ applied: true as const })),
    reload: vi.fn(async (): Promise<WorkerResourceState> => ({
      skills: [],
      modelReady: true,
    })),
    shutdown: vi.fn(async () => {}),
    onTimelineEvent: vi.fn(),
    onPromptContext: vi.fn(),
    onExit: vi.fn(),
    ...overrides,
  };
}

function setup(): {
  registry: RuntimeRegistry;
  statuses: Array<{ key: string; status: SessionRuntimeStatus }>;
} {
  const statuses: Array<{ key: string; status: SessionRuntimeStatus }> = [];
  const registry = createRuntimeRegistry({
    onStatusChange(key, status) {
      statuses.push({ key, status });
    },
  });
  return { registry, statuses };
}

describe("RuntimeRegistry", () => {
  it("starts one Worker lazily and reports starting → idle", async () => {
    const { registry, statuses } = setup();
    const worker = fakeWorker();

    expect(registry.statusOf("ws/s1")).toBe("unloaded");
    const started = await registry.ensureStarted("ws/s1", async () => worker);

    expect(started).toBe(worker);
    expect(registry.statusOf("ws/s1")).toBe("idle");
    expect(statuses.map((entry) => entry.status)).toEqual([
      "starting",
      "idle",
    ]);
  });

  it("never starts a second Worker for the same Session", async () => {
    const { registry } = setup();
    const worker = fakeWorker();
    const factory = vi.fn(async () => worker);

    const first = await registry.ensureStarted("ws/s1", factory);
    const second = await registry.ensureStarted("ws/s1", factory);

    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent starts onto a single Worker process", async () => {
    const { registry, statuses } = setup();
    const worker = fakeWorker();
    let resolveStart: ((worker: SessionWorker) => void) | undefined;
    const factory = vi.fn(
      () =>
        new Promise<SessionWorker>((resolve) => {
          resolveStart = resolve;
        }),
    );

    const a = registry.ensureStarted("ws/s1", factory);
    const b = registry.ensureStarted("ws/s1", factory);
    resolveStart?.(worker);
    const [wa, wb] = await Promise.all([a, b]);

    expect(wa).toBe(worker);
    expect(wb).toBe(worker);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(statuses.map((entry) => entry.status)).toEqual([
      "starting",
      "idle",
    ]);
  });

  it("returns to unloaded when the start fails", async () => {
    const { registry, statuses } = setup();

    await expect(
      registry.ensureStarted("ws/s1", async () => {
        throw new Error("Model not available: openai/nope");
      }),
    ).rejects.toThrow(/Model not available/);

    expect(registry.statusOf("ws/s1")).toBe("unloaded");
    expect(registry.get("ws/s1")).toBeUndefined();
    expect(statuses.map((entry) => entry.status)).toEqual([
      "starting",
      "unloaded",
    ]);
  });

  it("tracks turn state with idle ↔ running transitions", async () => {
    const { registry, statuses } = setup();
    await registry.ensureStarted("ws/s1", async () => fakeWorker());

    registry.setStatus("ws/s1", "running");
    expect(registry.statusOf("ws/s1")).toBe("running");
    registry.setStatus("ws/s1", "idle");
    expect(registry.statusOf("ws/s1")).toBe("idle");

    expect(statuses.map((entry) => entry.status)).toEqual([
      "starting",
      "idle",
      "running",
      "idle",
    ]);
  });

  it("keeps Sessions independent", async () => {
    const { registry } = setup();
    const workerA = fakeWorker();
    const workerB = fakeWorker();

    await registry.ensureStarted("ws/s-a", async () => workerA);
    await registry.ensureStarted("ws/s-b", async () => workerB);

    expect(registry.get("ws/s-a")).toBe(workerA);
    expect(registry.get("ws/s-b")).toBe(workerB);
    registry.setStatus("ws/s-a", "running");
    expect(registry.statusOf("ws/s-b")).toBe("idle");
  });

  it("disposes a Worker through stopping → unloaded and shuts it down", async () => {
    const { registry, statuses } = setup();
    const worker = fakeWorker();
    await registry.ensureStarted("ws/s1", async () => worker);

    await registry.dispose("ws/s1");

    expect(worker.shutdown).toHaveBeenCalledTimes(1);
    expect(registry.statusOf("ws/s1")).toBe("unloaded");
    expect(registry.get("ws/s1")).toBeUndefined();
    expect(statuses.map((entry) => entry.status)).toEqual([
      "starting",
      "idle",
      "stopping",
      "unloaded",
    ]);
  });

  it("makes repeated disposal wait for the same Worker shutdown", async () => {
    let finishShutdown: (() => void) | undefined;
    const worker = fakeWorker({
      shutdown: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishShutdown = resolve;
          }),
      ),
    });
    const { registry } = setup();
    await registry.ensureStarted("ws/s1", async () => worker);

    const first = registry.dispose("ws/s1");
    const second = registry.disposeAll();
    let secondFinished = false;
    void second.then(() => {
      secondFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(secondFinished).toBe(false);
    finishShutdown?.();
    await Promise.all([first, second]);
    expect(worker.shutdown).toHaveBeenCalledTimes(1);
    expect(registry.statusOf("ws/s1")).toBe("unloaded");
  });

  it("does not reuse a Worker whose startup is being disposed", async () => {
    let resolveFirst: ((worker: SessionWorker) => void) | undefined;
    const first = fakeWorker();
    const second = fakeWorker();
    const { registry } = setup();
    const firstStart = registry.ensureStarted(
      "ws/s1",
      () =>
        new Promise<SessionWorker>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const disposal = registry.dispose("ws/s1");
    const replacement = registry.ensureStarted("ws/s1", async () => second);

    resolveFirst?.(first);
    await disposal;
    await expect(firstStart).resolves.toBe(first);
    await expect(replacement).resolves.toBe(second);
    expect(first.shutdown).toHaveBeenCalledTimes(1);
    expect(registry.get("ws/s1")).toBe(second);
  });

  it("waits for a stopping Worker before starting its replacement", async () => {
    let finishShutdown: (() => void) | undefined;
    const first = fakeWorker({
      shutdown: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishShutdown = resolve;
          }),
      ),
    });
    const second = fakeWorker();
    const { registry } = setup();
    await registry.ensureStarted("ws/s1", async () => first);

    const disposal = registry.dispose("ws/s1");
    const replacement = registry.ensureStarted("ws/s1", async () => second);
    expect(registry.statusOf("ws/s1")).toBe("stopping");

    finishShutdown?.();
    await disposal;
    await expect(replacement).resolves.toBe(second);
    expect(registry.statusOf("ws/s1")).toBe("idle");
  });

  it("releases ownership after an unexpected Worker exit without shutting down", async () => {
    const { registry, statuses } = setup();
    const worker = fakeWorker();
    await registry.ensureStarted("ws/s1", async () => worker);
    registry.setStatus("ws/s1", "running");

    registry.releaseAfterExit("ws/s1");

    expect(worker.shutdown).not.toHaveBeenCalled();
    expect(registry.statusOf("ws/s1")).toBe("unloaded");
    expect(statuses.at(-1)?.status).toBe("unloaded");
  });

  it("a released Session can start a fresh Worker later", async () => {
    const { registry } = setup();
    const first = fakeWorker();
    const second = fakeWorker();

    await registry.ensureStarted("ws/s1", async () => first);
    registry.releaseAfterExit("ws/s1");
    const started = await registry.ensureStarted("ws/s1", async () => second);

    expect(started).toBe(second);
  });
});
