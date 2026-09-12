import { describe, expect, it } from "vitest";
import type { TimelineDeltaEvent, TimelineSnapshot } from "../../shared/timeline";
import { applyTimelineDelta, applyTimelineSnapshot, initialTimelineStream } from "./timeline-stream";

const snapshot: TimelineSnapshot = {
  context: { status: "unavailable" },
  workspaceId: "workspace-1",
  sessionId: "session-1",
  sequence: 2,
  status: "running",
  items: [{ kind: "user", text: "question", at: 100 }],
};

function event(sequence: number, text: string): TimelineDeltaEvent {
  return {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sequence,
    at: sequence * 100,
    delta: { type: "assistant_text_delta", delta: text },
  };
}

describe("Renderer Timeline stream recovery", () => {
  it("recovers context with buffered updates and clears it when the Runtime unloads", () => {
    const context = { status: "ready" as const, provider: "p", model: "m", contextWindow: 128000, usedTokens: 38400 };
    let state = applyTimelineSnapshot(initialTimelineStream(), snapshot);
    state = applyTimelineDelta(state, { ...event(4, ""), delta: { type: "context_usage", context } });
    state = applyTimelineSnapshot(state, { ...snapshot, sequence: 3 });
    expect(state.context).toEqual(context);
    expect(state.items).toEqual(snapshot.items);
    state = applyTimelineDelta(state, { ...event(5, ""), sessionId: "other", delta: { type: "context_usage", context: { status: "unavailable" } } });
    expect(state.context).toEqual(context);
    state = applyTimelineDelta(state, { ...event(5, ""), delta: { type: "session_status", status: "unloaded" } });
    expect(state.context).toEqual({ status: "unavailable" });
  });
  it("applies contiguous Deltas and ignores duplicate delivery", () => {
    let state = applyTimelineSnapshot(initialTimelineStream(), snapshot);
    state = applyTimelineDelta(state, event(3, "A"));
    state = applyTimelineDelta(state, event(3, "A"));

    expect(state.sequence).toBe(3);
    expect(state.needsSnapshot).toBe(false);
    expect(state.items.at(-1)).toEqual({
      kind: "assistant",
      at: 300,
      parts: [{ kind: "text", text: "A", at: 300 }],
    });
  });

  it("detects a sequence gap once, pauses Deltas, then resumes after one Snapshot", () => {
    let state = applyTimelineSnapshot(initialTimelineStream(), snapshot);
    state = applyTimelineDelta(state, event(4, "missed"));
    expect(state.needsSnapshot).toBe(true);
    expect(state.sequence).toBe(2);

    state = applyTimelineDelta(state, event(5, "also paused"));
    expect(state.sequence).toBe(2);
    expect(state.items).toEqual(snapshot.items);

    state = applyTimelineSnapshot(state, {
      ...snapshot,
      sequence: 5,
      items: [
        ...snapshot.items,
        {
          kind: "assistant",
          at: 200,
          parts: [{ kind: "text" as const, text: "recovered", at: 200 }],
        },
      ],
    });
    state = applyTimelineDelta(state, event(6, " next"));

    expect(state.needsSnapshot).toBe(false);
    expect(state.sequence).toBe(6);
    expect(state.items.at(-1)).toMatchObject({
      parts: [{ kind: "text", text: "recovered next" }],
    });
  });

  it("replays a final Delta that arrives while the Snapshot request is in flight", () => {
    let state = initialTimelineStream();
    state = {
      ...state,
      workspaceId: "workspace-1",
      sessionId: "session-1",
    };
    state = applyTimelineDelta(state, event(3, "after snapshot"));
    state = applyTimelineSnapshot(state, snapshot);

    expect(state.sequence).toBe(3);
    expect(state.needsSnapshot).toBe(false);
    expect(state.items.at(-1)).toMatchObject({
      parts: [{ kind: "text", text: "after snapshot" }],
    });
  });

  it("ignores another Session and never regresses to an older Snapshot", () => {
    let state = applyTimelineSnapshot(initialTimelineStream(), snapshot);
    state = applyTimelineDelta(state, { ...event(3, "A"), sessionId: "session-2" });
    state = applyTimelineSnapshot(state, { ...snapshot, sequence: 1, items: [] });

    expect(state.sequence).toBe(2);
    expect(state.items).toEqual(snapshot.items);
  });
});
