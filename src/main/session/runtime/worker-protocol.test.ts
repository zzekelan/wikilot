import { describe, expect, it } from "vitest";
import {
  decodeWorkerCommand,
  decodeWorkerMessage,
  type WorkerCommand,
  type WorkerMessage,
} from "./worker-protocol";

describe("decodeWorkerMessage", () => {
  it("preserves unknown, zero and over-capacity usage, rejecting invalid context frames", () => {
    const context = { status: "ready", provider: "p", model: "m", contextWindow: 128000, usedTokens: 0 };
    const frame = (value: unknown) => ({ type: "event", event: { type: "context_usage", context: value } });
    for (const usedTokens of [null, 0, 150000]) {
      const message = frame({ ...context, usedTokens });
      expect(decodeWorkerMessage(message)).toEqual(message);
    }
    expect(decodeWorkerMessage(frame({ status: "unavailable" }))).toEqual(frame({ status: "unavailable" }));
    for (const patch of [{ usedTokens: -1 }, { usedTokens: NaN }, { contextWindow: 0 },
      { contextWindow: Infinity }, { model: "" }, { status: "unknown" }, { secret: "no" }]) {
      expect(decodeWorkerMessage(frame({ ...context, ...patch }))).toBeUndefined();
    }
  });
  it("decodes ack/nack by requestId", () => {
    expect(decodeWorkerMessage({ type: "ack", requestId: 7 })).toEqual({
      type: "ack",
      requestId: 7,
    });
    expect(
      decodeWorkerMessage({ type: "nack", requestId: 7, message: "boom" }),
    ).toEqual({ type: "nack", requestId: 7, message: "boom" });
    expect(
      decodeWorkerMessage({
        type: "ack",
        requestId: 8,
        skills: [{ name: "research", description: "Investigate" }],
        modelReady: false,
      }),
    ).toEqual({
      type: "ack",
      requestId: 8,
      skills: [{ name: "research", description: "Investigate" }],
      modelReady: false,
    });
    expect(
      decodeWorkerMessage({
        type: "ack",
        requestId: 9,
        skills: [{ name: "research", description: 42 }],
      }),
    ).toBeUndefined();
    expect(decodeWorkerMessage({ type: "ack" })).toBeUndefined();
    expect(
      decodeWorkerMessage({ type: "nack", requestId: "7", message: "boom" }),
    ).toBeUndefined();
  });

  it("decodes Timeline events and drops malformed frames", () => {
    const message: WorkerMessage = {
      type: "event",
      event: { type: "assistant_text_delta", delta: "hi" },
    };
    expect(decodeWorkerMessage(JSON.parse(JSON.stringify(message)))).toEqual(
      message,
    );
    expect(decodeWorkerMessage({ type: "event", event: null })).toBeUndefined();
    expect(decodeWorkerMessage({ type: "event" })).toBeUndefined();
    expect(
      decodeWorkerMessage({
        type: "event",
        event: {
          type: "tool_end",
          toolCallId: "c1",
          toolName: "vision",
          isError: false,
          result: {
            images: [{ imageRef: "ref", mimeType: "image/png", data: "base64" }],
          },
        },
      }),
    ).toBeUndefined();
    expect(
      decodeWorkerMessage({
        type: "event",
        event: {
          type: "tool_end",
          toolCallId: "c1",
          toolName: "vision",
          isError: false,
          result: {
            images: [{ imageRef: "data:image/png;base64,bytes", mimeType: "image/png" }],
          },
        },
      }),
    ).toBeUndefined();
    expect(
      decodeWorkerMessage({
        type: "event",
        event: {
          type: "tool_end",
          toolCallId: "c1",
          toolName: "read_pdf_page",
          isError: false,
          result: { text: "ok", details: { private: true } },
        },
      }),
    ).toBeUndefined();
    expect(
      decodeWorkerMessage({
        type: "event",
        event: {
          type: "tool_end",
          toolCallId: "c1",
          toolName: "another_tool",
          isError: false,
          result: {
            metadata: {
              kind: "pdf_pages",
              path: "paper.pdf",
              pageCount: 1, pages: [{ page: 1, width: 100, height: 100 }],
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("decodes prompt context", () => {
    expect(
      decodeWorkerMessage({
        type: "prompt_context",
        context: { systemPrompt: "sys", wikiFragmentPresent: true },
      }),
    ).toEqual({
      type: "prompt_context",
      context: { systemPrompt: "sys", wikiFragmentPresent: true },
    });
    expect(
      decodeWorkerMessage({
        type: "prompt_context",
        context: { systemPrompt: 1, wikiFragmentPresent: true },
      }),
    ).toBeUndefined();
  });

  it("survives a JSON round trip unchanged", () => {
    const messages: WorkerMessage[] = [
      { type: "ack", requestId: 1 },
      { type: "nack", requestId: 2, message: "bad" },
      { type: "event", event: { type: "turn_start" } },
      {
        type: "event",
        event: {
          type: "tool_end",
          toolCallId: "c1",
          toolName: "bash",
          isError: false,
          result: {
            text: "ok",
            images: [{
              imageRef: "timeline-image:v1:Xc26Z2FADCV4tUPqG0E_m8t1NZNjFeSTqhLgIDiTBSc",
              mimeType: "image/png",
            }],
          },
        },
      },
      {
        type: "prompt_context",
        context: { systemPrompt: "sys", wikiFragmentPresent: false },
      },
    ];
    for (const message of messages) {
      const serialized = JSON.stringify(message);
      expect(decodeWorkerMessage(JSON.parse(serialized))).toEqual(message);
      expect(serialized).not.toMatch(/base64|\"data\"|\"details\"|\"type\":\"Buffer\"/);
    }
  });
});

describe("decodeWorkerCommand", () => {
  it("decodes a resource-only start without Provider or Model", () => {
    expect(
      decodeWorkerCommand({
        type: "start",
        requestId: 1,
        sessionId: "s1",
        cwd: "/tmp/ws",
        sessionDir: "/tmp/sessions",
        sessionFile: "/tmp/sessions/s1.jsonl",
        agentDir: "/tmp/agent",
        wikiPromptFragment: "# LLM Wiki",
        projectTrusted: false,
        config: {
          thinkingLevel: "medium",
          wikiPromptEnabled: true,
        },
      }),
    ).toMatchObject({ type: "start", config: { thinkingLevel: "medium" } });
  });

  it("decodes a start command with its Session config", () => {
    const command: WorkerCommand = {
      type: "start",
      requestId: 1,
      sessionId: "s1",
      cwd: "/tmp/ws",
      sessionDir: "/tmp/sessions",
      sessionFile: "/tmp/sessions/s1.jsonl",
      agentDir: "/tmp/agent",
      wikiPromptFragment: "# LLM Wiki",
      projectTrusted: false,
      config: {
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "high",
        wikiPromptEnabled: true,
      },
    };
    expect(decodeWorkerCommand(JSON.parse(JSON.stringify(command)))).toEqual(
      command,
    );
  });

  it("decodes prompt/configure/reload/abort/shutdown commands", () => {
    const prompt = {
      workspaceId: "w1",
      sessionId: "s1",
      text: "hi",
      clips: [],
    };
    expect(
      decodeWorkerCommand({ type: "prompt", requestId: 2, prompt }),
    ).toEqual({ type: "prompt", requestId: 2, prompt });
    expect(
      decodeWorkerCommand({
        type: "prompt",
        requestId: 2,
        prompt,
        traceparent: "00-abc-def-01",
      }),
    ).toEqual({
      type: "prompt",
      requestId: 2,
      prompt,
      traceparent: "00-abc-def-01",
    });
    expect(decodeWorkerCommand({ type: "abort", requestId: 3 })).toEqual({
      type: "abort",
      requestId: 3,
    });
    expect(
      decodeWorkerCommand({
        type: "configure",
        requestId: 4,
        config: {
          provider: "openai",
          model: "gpt-4.1",
          thinkingLevel: "high",
          wikiPromptEnabled: false,
        },
      }),
    ).toEqual({
      type: "configure",
      requestId: 4,
      config: {
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "high",
        wikiPromptEnabled: false,
      },
    });
    expect(
      decodeWorkerCommand({ type: "reload", requestId: 5, projectTrusted: true }),
    ).toEqual({
      type: "reload",
      requestId: 5,
      projectTrusted: true,
    });
    expect(decodeWorkerCommand({ type: "shutdown", requestId: 6 })).toEqual({
      type: "shutdown",
      requestId: 6,
    });
  });

  it("rejects commands with missing or mistyped fields", () => {
    expect(decodeWorkerCommand(undefined)).toBeUndefined();
    expect(decodeWorkerCommand({ type: "prompt", requestId: 1 })).toBeUndefined();
    expect(
      decodeWorkerCommand({ type: "start", requestId: 1, cwd: "/tmp/ws" }),
    ).toBeUndefined();
    expect(
      decodeWorkerCommand({
        type: "start",
        requestId: 1,
        sessionId: "s1",
        cwd: "/tmp/ws",
        sessionDir: "/tmp/sessions",
        sessionFile: "/tmp/sessions/s1.jsonl",
        agentDir: "/tmp/agent",
        wikiPromptFragment: "# LLM Wiki",
        config: {
          provider: "openai",
          model: "gpt-4.1",
          thinkingLevel: "high",
          wikiPromptEnabled: true,
        },
      }),
    ).toBeUndefined();
    expect(
      decodeWorkerCommand({ type: "reload", requestId: 1 }),
    ).toBeUndefined();
    expect(
      decodeWorkerCommand({ type: "nonsense", requestId: 1 }),
    ).toBeUndefined();
  });
});
