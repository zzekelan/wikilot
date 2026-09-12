import { describe, expect, it } from "vitest";
import { createSessionEventMapper, mapSessionEvent } from "./map-events";

describe("mapSessionEvent", () => {
  it("maps streaming text and thinking deltas", () => {
    expect(
      mapSessionEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hi" },
      }),
    ).toEqual({ type: "assistant_text_delta", delta: "Hi" });

    expect(
      mapSessionEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "..." },
      }),
    ).toEqual({ type: "assistant_thinking_delta", delta: "..." });
  });

  it("maps tool lifecycle events with serializable payloads", () => {
    expect(
      mapSessionEvent({
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
        args: { path: "README.md" },
      }),
    ).toEqual({
      type: "tool_start",
      toolCallId: "c1",
      toolName: "read",
      args: { path: "README.md" },
    });

    expect(
      mapSessionEvent({
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "shell",
        args: { command: "ls" },
        partialResult: { content: [{ type: "text", text: "partial" }] },
      }),
    ).toEqual({
      type: "tool_update",
      toolCallId: "c1",
      toolName: "shell",
      progress: "partial",
    });

    expect(
      mapSessionEvent({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "read",
        isError: false,
        result: {
          content: [
            { type: "text", text: "file body" },
            { type: "image", data: "persisted-base64", mimeType: "image/png" },
          ],
          details: { private: "drop" },
        },
      }),
    ).toEqual({
      type: "tool_end",
      toolCallId: "c1",
      toolName: "read",
      isError: false,
      result: {
        text: "file body",
        images: [{
          imageRef: "timeline-image:v1:Xc26Z2FADCV4tUPqG0E_m8t1NZNjFeSTqhLgIDiTBSc",
          mimeType: "image/png",
        }],
      },
    });
  });

  it("omits unclassified and byte-bearing Tool Result payloads", () => {
    expect(
      mapSessionEvent({
        type: "tool_execution_end",
        toolCallId: "c1",
        toolName: "read",
        isError: true,
        result: { data: { type: "Buffer", data: [1, 2, 3] }, details: { secret: true } },
      }),
    ).toEqual({
      type: "tool_end",
      toolCallId: "c1",
      toolName: "read",
      isError: true,
      result: {},
    });
  });

  it("omits absent tool payloads", () => {
    expect(
      mapSessionEvent({
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "read",
      }),
    ).toEqual({ type: "tool_start", toolCallId: "c1", toolName: "read" });
  });

  it("maps only a terminal assistant failure to a Timeline error", () => {
    const failedMessage = {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Provider rejected the request",
    };
    expect(
      mapSessionEvent({
        type: "agent_end",
        messages: [failedMessage],
        willRetry: true,
      }),
    ).toBeNull();
    expect(
      mapSessionEvent({
        type: "agent_end",
        messages: [failedMessage],
        willRetry: false,
      }),
    ).toEqual({ type: "error", message: "Provider rejected the request" });
    expect(
      mapSessionEvent({
        type: "agent_end",
        messages: [{
          role: "assistant",
          content: [],
          stopReason: "error",
        }],
        willRetry: false,
      }),
    ).toEqual({ type: "error", message: "Provider request failed" });
  });

  it("defers errors until the agent settles and discards recovered failures", () => {
    const map = createSessionEventMapper();
    const failed = {
      type: "agent_end",
      messages: [{
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage: "Provider rejected the request",
      }],
      willRetry: false,
    };
    expect(map(failed)).toEqual([]);
    expect(map({
      type: "agent_end",
      messages: [{ role: "assistant", content: [], stopReason: "stop" }],
      willRetry: false,
    })).toEqual([]);
    expect(map({ type: "agent_settled" })).toEqual([
      { type: "agent_settled" },
    ]);

    expect(map(failed)).toEqual([]);
    expect(map({ type: "agent_settled" })).toEqual([
      { type: "error", message: "Provider rejected the request" },
      { type: "agent_settled" },
    ]);
  });

  it("maps turn boundaries and ignores unrelated events", () => {
    expect(mapSessionEvent({ type: "turn_start" })).toEqual({
      type: "turn_start",
    });
    expect(mapSessionEvent({ type: "agent_settled" })).toEqual({
      type: "agent_settled",
    });
    expect(
      mapSessionEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_start" },
      }),
    ).toBeNull();
    expect(mapSessionEvent({ type: "queue_update" })).toBeNull();
  });
});
