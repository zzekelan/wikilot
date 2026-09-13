import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForPersistedUserMessage } from "./prompt-persistence";

describe("Prompt record persistence wait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps polling after a Turn settles until the user message is observable", async () => {
    let checks = 0;

    await expect(waitForPersistedUserMessage(
      () => {
        checks += 1;
        return checks >= 2;
      },
      Promise.resolve(),
    )).resolves.toBeUndefined();

    expect(checks).toBe(2);
  });

  it("starts the persistence deadline only after a long Turn settles", async () => {
    vi.useFakeTimers();
    let settleTurn: (() => void) | undefined;
    let persisted = false;
    const turn = new Promise<void>((resolve) => {
      settleTurn = resolve;
    });
    const waiting = waitForPersistedUserMessage(() => persisted, turn);
    let finished = false;
    void waiting.then(() => { finished = true; });

    await vi.advanceTimersByTimeAsync(6_000);
    expect(finished).toBe(false);

    settleTurn?.();
    await vi.advanceTimersByTimeAsync(1_000);
    persisted = true;
    await vi.advanceTimersByTimeAsync(5);

    await expect(waiting).resolves.toBeUndefined();
  });

  it("rejects when persistence stays invisible after a settled Turn", async () => {
    vi.useFakeTimers();
    const waiting = waitForPersistedUserMessage(() => false, Promise.resolve());
    const assertion = expect(waiting).rejects.toThrow(
      "Prompt user message was not durably paired with its Prompt record",
    );

    await vi.advanceTimersByTimeAsync(5_005);

    await assertion;
  });

  it("propagates a Turn rejection while persistence is pending", async () => {
    const failure = new Error("provider failed");

    await expect(waitForPersistedUserMessage(
      () => false,
      Promise.reject(failure),
    )).rejects.toBe(failure);
  });
});
