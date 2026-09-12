import { describe, expect, it } from "vitest";
import type { TimelineDelta } from "../../shared/timeline";
import { createTimelineReadModel } from "./timeline-read-model";

describe("Session Timeline live Read Model", () => {
  it("projects live Deltas to the same Timeline semantics as a historical Snapshot", () => {
    const model = createTimelineReadModel();
    model.hydrate("workspace-1", "session-1", []);

    const deltas: Array<{ delta: TimelineDelta; at: number }> = [
      { delta: { type: "user_message", text: "question" }, at: 100 },
      { delta: { type: "assistant_thinking_delta", delta: "reason" }, at: 200 },
      { delta: { type: "assistant_text_delta", delta: "ans" }, at: 300 },
      { delta: { type: "assistant_text_delta", delta: "wer" }, at: 301 },
      {
        delta: {
          type: "tool_start",
          toolCallId: "call-1",
          toolName: "read",
          args: { path: "notes.md" },
        },
        at: 400,
      },
      {
        delta: {
          type: "tool_end",
          toolCallId: "call-1",
          toolName: "read",
          isError: false,
          result: { text: "done" },
        },
        at: 500,
      },
    ];

    for (const entry of deltas) {
      model.apply("workspace-1", "session-1", entry.delta, entry.at);
    }

    expect(model.snapshot("workspace-1", "session-1")).toEqual({
      context: { status: "unavailable" },
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sequence: 6,
      status: "unloaded",
      items: [
        { kind: "user", text: "question", at: 100 },
        {
          kind: "assistant",
          at: 200,
          parts: [
            { kind: "reasoning", text: "reason", at: 200, endedAt: 300 },
            { kind: "text", text: "answer", at: 300 },
            {
              kind: "tool",
              toolCallId: "call-1",
              toolName: "read",
              status: "done",
              args: { path: "notes.md" },
              result: { text: "done" },
              at: 400,
              endedAt: 500,
            },
          ],
        },
      ],
    });
  });

  it("publishes sequenced Session Deltas and rejects a Snapshot for another Session", () => {
    const model = createTimelineReadModel();
    model.hydrate("workspace-1", "session-1", []);

    expect(
      model.apply(
        "workspace-1",
        "session-1",
        { type: "session_status", status: "running" },
        100,
      ),
    ).toEqual({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sequence: 1,
      at: 100,
      delta: { type: "session_status", status: "running" },
    });
    expect(
      model.apply(
        "workspace-1",
        "old-session",
        { type: "session_status", status: "unloaded" },
        200,
      ),
    ).toBeUndefined();
    expect(model.snapshot("workspace-1", "session-1").sequence).toBe(1);
    expect(() => model.snapshot("workspace-1", "session-2")).toThrow(
      /not loaded/i,
    );
  });

  it("keeps concurrent Session projections independent", () => {
    const model = createTimelineReadModel();
    model.hydrate("workspace-a", "session-a", []);
    model.hydrate("workspace-b", "session-b", []);

    model.apply("workspace-a", "session-a", {
      type: "user_message",
      text: "A",
    });
    model.apply("workspace-b", "session-b", {
      type: "user_message",
      text: "B",
    });

    expect(model.snapshot("workspace-a", "session-a").items).toEqual([
      expect.objectContaining({ kind: "user", text: "A" }),
    ]);
    expect(model.snapshot("workspace-b", "session-b").items).toEqual([
      expect.objectContaining({ kind: "user", text: "B" }),
    ]);
  });
});
