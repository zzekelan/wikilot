/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserClient } from "./browser-client";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  private readonly listeners = new Map<string, Array<(event: Event | MessageEvent<string>) => void>>();
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: string, listener: (event: Event | MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: Event | MessageEvent<string> = new Event(type)): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("browser client event stream", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("releases a PDF source through the Browser Host", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await createBrowserClient().releaseWorkspacePdfSource("opaque source");

    expect(fetch).toHaveBeenCalledWith("/api/workspace/pdf/release", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceId: "opaque source" }),
    });
  });

  it("retries an EventSource that remains half-open", () => {
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    const onEvent = vi.fn();
    const onConnected = vi.fn();
    const unsubscribe = createBrowserClient().subscribeEvents(onEvent, onConnected);

    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(3_500);
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.instances[1]?.emit("open");
    FakeEventSource.instances[1]?.emit("message", new MessageEvent("message", {
      data: JSON.stringify({ type: "workspace_link_index_changed", workspaceId: "workspace-1", revision: 2 }),
    }));
    vi.advanceTimersByTime(4_000);

    expect(onConnected).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith({
      type: "workspace_link_index_changed",
      workspaceId: "workspace-1",
      revision: 2,
    });
    expect(FakeEventSource.instances).toHaveLength(2);

    unsubscribe();
    expect(FakeEventSource.instances[1]?.closed).toBe(true);
  });
});
