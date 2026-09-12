import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginSessionPrompt,
  beginToolExecution,
  beginWorkerTurn,
  endSessionPrompt,
  endToolExecution,
  endWorkerTurn,
  initHostTelemetry,
  recordAppDefaultsSave,
  recordCredentialSave,
  recordSessionSwitch,
  recordSessionRuntimeDisposal,
  recordWorkspaceFilesChanged,
  recordWorkspaceOpen,
  resolveHostTelemetryEnabled,
  setSessionPromptContent,
  setReadPdfPageToolCompletion,
  shutdownHostTelemetry,
} from "./index";

describe("resolveHostTelemetryEnabled", () => {
  it("defaults to on when NODE_ENV is not production", () => {
    expect(resolveHostTelemetryEnabled({ NODE_ENV: "development" })).toBe(true);
  });

  it("defaults to off in production", () => {
    expect(resolveHostTelemetryEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("honors WIKILOT_OTEL_ENABLED=false", () => {
    expect(
      resolveHostTelemetryEnabled({
        NODE_ENV: "development",
        WIKILOT_OTEL_ENABLED: "false",
      }),
    ).toBe(false);
  });
});

describe("recordWorkspaceOpen", () => {
  afterEach(async () => {
    await shutdownHostTelemetry();
  });

  it("emits workspace.files_changed without file paths or content", () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    recordWorkspaceFilesChanged({ workspaceId: "--tmp-notes--", pathCount: 2 });

    expect(exporter.getFinishedSpans()[0]).toMatchObject({
      name: "workspace.files_changed",
      attributes: {
        "wikilot.workspace.id": "c0d842e8bc5d4a7150c82bd97631b9ac",
        "wikilot.workspace.path_count": "2",
      },
    });
    expect(Object.keys(exporter.getFinishedSpans()[0]?.attributes ?? {}).sort()).toEqual([
      "wikilot.workspace.id",
      "wikilot.workspace.path_count",
    ]);
  });

  it("emits workspace.open with Workspace attributes only", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    recordWorkspaceOpen({
      id: "--tmp-notes--",
      cwd: "/tmp/notes",
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("workspace.open");
    expect(spans[0]?.attributes["wikilot.gesture"]).toBe("workspace.open");
    expect(spans[0]?.attributes["wikilot.workspace.id"]).toBe("c0d842e8bc5d4a7150c82bd97631b9ac");
    expect(spans[0]?.attributes["wikilot.workspace.cwd"]).toBeUndefined();
    // Opening a Workspace never touches Session state: no persistence internals.
    expect(spans[0]?.attributes["wikilot.session.dir"]).toBeUndefined();
    expect(spans[0]?.attributes["wikilot.session.id"]).toBeUndefined();
    expect(spans[0]?.attributes["wikilot.session.resumed"]).toBeUndefined();
    expect(spans[0]?.attributes["wikilot.session.file"]).toBeUndefined();
  });
});

describe("recordSessionSwitch", () => {
  afterEach(async () => {
    await shutdownHostTelemetry();
  });

  it("emits session.create and session.open with Session attributes", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    recordSessionSwitch({
      sessionId: "new-1",
      action: "create",
    });
    recordSessionSwitch({
      sessionId: "old-1",
      action: "open",
    });

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      "session.create",
      "session.open",
    ]);
    expect(spans[0]?.attributes["wikilot.gesture"]).toBe("session.create");
    expect(spans[0]?.attributes["wikilot.session.id"]).toBe("new-1");
    expect(spans[1]?.attributes["wikilot.gesture"]).toBe("session.open");
    expect(spans[1]?.attributes["wikilot.session.id"]).toBe("old-1");
    expect(spans[1]?.attributes["wikilot.workspace.cwd"]).toBeUndefined();
    expect(spans[1]?.attributes["wikilot.session.dir"]).toBeUndefined();
    expect(spans[1]?.attributes["wikilot.session.file"]).toBeUndefined();
  });
});

describe("session.prompt span", () => {
  afterEach(async () => {
    await shutdownHostTelemetry();
  });

  it("emits session.prompt with wiki metadata and no credentials", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    const traceparent = beginSessionPrompt({
      sessionId: "s1",
      cwd: "/tmp/notes",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: true,
    });
    expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(exporter.getFinishedSpans()).toHaveLength(0);

    endSessionPrompt();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("session.prompt");
    expect(spans[0]?.attributes["wikilot.llm.provider"]).toBe("openai");
    expect(spans[0]?.attributes["wikilot.llm.model"]).toBe("gpt-4.1");
    expect(spans[0]?.attributes["wikilot.llm.thinking"]).toBe("high");
    expect(spans[0]?.attributes["wikilot.wiki.enabled"]).toBe("true");
    // Default capture is metadata — prompt bodies omitted.
    expect(spans[0]?.attributes["wikilot.wiki.prompt"]).toBeUndefined();
    expect(spans[0]?.attributes["wikilot.llm.system_prompt"]).toBeUndefined();
    expect(spans[0]?.attributes["apiKey"]).toBeUndefined();
    expect(spans[0]?.attributes["wikilot.llm.apiKey"]).toBeUndefined();
  });

  it("keeps distinct Session prompt spans open concurrently", () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    beginSessionPrompt({
      sessionId: "s1",
      cwd: "/tmp/a",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: true,
    });
    beginSessionPrompt({
      sessionId: "s2",
      cwd: "/tmp/b",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: true,
    });

    endSessionPrompt("s1");
    expect(
      exporter.getFinishedSpans().map((span) => span.attributes["wikilot.session.id"]),
    ).toEqual(["s1"]);

    endSessionPrompt("s2");
    expect(
      exporter.getFinishedSpans().map((span) => span.attributes["wikilot.session.id"]),
    ).toEqual(["s1", "s2"]);
  });

  it("records background runtime disposal with its Session identity", () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    recordSessionRuntimeDisposal({
      workspaceId: "ws-1",
      sessionId: "s1",
      workerInstanceId: "worker-1",
      reason: "background_idle",
    });

    expect(exporter.getFinishedSpans()[0]).toMatchObject({
      name: "session.runtime.dispose",
      attributes: {
        "wikilot.session.id": "s1",
        "wikilot.workspace.id": "769446044ae954903e45edd729af5598",
        "wikilot.worker.instance_id": "worker-1",
        "wikilot.runtime.dispose_reason": "background_idle",
      },
    });
  });

  it.each(["worker_failure", "host_shutdown"] as const)(
    "records %s with Workspace, Session, and Worker identity",
    (reason) => {
      const exporter = new InMemorySpanExporter();
      initHostTelemetry({
        enabled: true,
        spanProcessor: new SimpleSpanProcessor(exporter),
      });

      recordSessionRuntimeDisposal({
        workspaceId: "ws-1",
        sessionId: "s1",
        workerInstanceId: "worker-42",
        reason,
      });

      expect(exporter.getFinishedSpans()[0]?.attributes).toMatchObject({
        "wikilot.workspace.id": "769446044ae954903e45edd729af5598",
        "wikilot.session.id": "s1",
        "wikilot.worker.instance_id": "worker-42",
        "wikilot.runtime.dispose_reason": reason,
      });
    },
  );

  it("enriches the open span with Worker-reported content when captureContent=full", async () => {
    const previous = process.env.WIKILOT_CAPTURE_CONTENT;
    process.env.WIKILOT_CAPTURE_CONTENT = "full";
    try {
      const exporter = new InMemorySpanExporter();
      initHostTelemetry({
        enabled: true,
        spanProcessor: new SimpleSpanProcessor(exporter),
      });

      const fragment = "# LLM Wiki\n\ncompounding artifact";
      const systemPrompt = `Base instructions\n\n${fragment}\n\n<project_context>`;
      beginSessionPrompt({
        sessionId: "s1",
        cwd: "/tmp/notes",
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "high",
        wikiPromptEnabled: true,
      });
      setSessionPromptContent({
        systemPrompt,
        wikiPromptFragment: fragment,
      });
      endSessionPrompt();

      const spans = exporter.getFinishedSpans();
      expect(spans[0]?.attributes["wikilot.wiki.prompt"]).toBe(fragment);
      expect(spans[0]?.attributes["wikilot.llm.system_prompt"]).toBe(
        systemPrompt,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.WIKILOT_CAPTURE_CONTENT;
      } else {
        process.env.WIKILOT_CAPTURE_CONTENT = previous;
      }
    }
  });

  it("keeps Worker-reported content off the span at default capture", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    beginSessionPrompt({
      sessionId: "s1",
      cwd: "/tmp/notes",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: true,
    });
    setSessionPromptContent({
      systemPrompt: "assembled prompt body",
      wikiPromptFragment: "# LLM Wiki",
    });
    endSessionPrompt();

    const spans = exporter.getFinishedSpans();
    expect(spans[0]?.attributes["wikilot.llm.system_prompt"]).toBeUndefined();
    expect(spans[0]?.attributes["wikilot.wiki.prompt"]).toBeUndefined();
  });
});

describe("Worker turn spans", () => {
  afterEach(async () => {
    await shutdownHostTelemetry();
  });

  it("connects Worker turn and tool spans to the Main prompt trace", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    // Main side: the gesture span yields the cross-process traceparent.
    const traceparent = beginSessionPrompt({
      sessionId: "s1",
      cwd: "/tmp/notes",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
    // Worker side: same module, separate process — here simulated in-process.
    endSessionPrompt();
    beginWorkerTurn({
      traceparent,
      sessionId: "s1",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
    });
    beginToolExecution({
      sessionId: "s1",
      toolName: "bash",
      toolCallId: "c1",
    });
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "session.prompt",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    endToolExecution({ toolCallId: "c1", outcome: "success" });
    endWorkerTurn();

    const spans = exporter.getFinishedSpans();
    const promptSpan = spans.find((span) => span.name === "session.prompt");
    const turnSpan = spans.find((span) => span.name === "session.turn");
    const toolSpan = spans.find((span) => span.name === "session.tool");
    expect(promptSpan).toBeTruthy();
    expect(turnSpan).toBeTruthy();
    expect(toolSpan).toBeTruthy();
    // One trace across the process boundary; turn under prompt, tool under turn.
    expect(turnSpan?.spanContext().traceId).toBe(
      promptSpan?.spanContext().traceId,
    );
    expect(toolSpan?.spanContext().traceId).toBe(
      promptSpan?.spanContext().traceId,
    );
    expect(turnSpan?.parentSpanId).toBe(promptSpan?.spanContext().spanId);
    expect(toolSpan?.parentSpanId).toBe(turnSpan?.spanContext().spanId);
    const toolDurationNanos = (toolSpan?.duration[0] ?? 0) * 1e9 +
      (toolSpan?.duration[1] ?? 0);
    expect(toolDurationNanos).toBeGreaterThanOrEqual(1e6);
  });

  it("adds the acceptance run id to the complete cross-process Tool trace", () => {
    const previous = process.env.WIKILOT_ACCEPTANCE_RUN_ID;
    process.env.WIKILOT_ACCEPTANCE_RUN_ID = "pdf-page-run";
    try {
      const exporter = new InMemorySpanExporter();
      initHostTelemetry({
        enabled: true,
        spanProcessor: new SimpleSpanProcessor(exporter),
      });
      const traceparent = beginSessionPrompt({
        sessionId: "s1",
        cwd: "/tmp/notes",
        provider: "loopback",
        model: "vision",
        thinkingLevel: "low",
        wikiPromptEnabled: false,
      });
      endSessionPrompt("s1");
      beginWorkerTurn({
        traceparent,
        sessionId: "s1",
        provider: "loopback",
        model: "vision",
        thinkingLevel: "low",
      });
      beginToolExecution({
        sessionId: "s1",
        toolName: "read_pdf_page",
        toolCallId: "pdf-1",
      });
      endToolExecution({ toolCallId: "pdf-1", outcome: "success" });
      endWorkerTurn();

      expect(exporter.getFinishedSpans().map((span) => [
        span.name,
        span.attributes["wikilot.acceptance.run_id"],
      ])).toEqual([
        ["session.prompt", "pdf-page-run"],
        ["session.tool", "pdf-page-run"],
        ["session.turn", "pdf-page-run"],
      ]);
    } finally {
      if (previous === undefined) delete process.env.WIKILOT_ACCEPTANCE_RUN_ID;
      else process.env.WIKILOT_ACCEPTANCE_RUN_ID = previous;
    }
  });

  it("correlates concurrent Tool calls by call id and records distinct outcomes", () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });
    const traceparent = beginSessionPrompt({
      sessionId: "s1",
      cwd: "/tmp/notes",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
    endSessionPrompt("s1");
    beginWorkerTurn({
      traceparent,
      sessionId: "s1",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
    });

    beginToolExecution({ sessionId: "s1", toolName: "bash", toolCallId: "a" });
    beginToolExecution({ sessionId: "s1", toolName: "read", toolCallId: "b" });
    endToolExecution({ toolCallId: "b", outcome: "error" });
    expect(exporter.getFinishedSpans().find((span) => span.name === "session.tool")?.attributes)
      .toMatchObject({ "wikilot.tool.call_id": "b", "wikilot.tool.outcome": "error" });
    endToolExecution({ toolCallId: "a", outcome: "success" });

    const tools = exporter.getFinishedSpans().filter((span) => span.name === "session.tool");
    expect(tools.map((span) => span.attributes["wikilot.tool.call_id"])).toEqual(["b", "a"]);
    expect(tools.map((span) => span.attributes["wikilot.tool.outcome"])).toEqual(["error", "success"]);
  });

  it("ends abandoned Tool spans on Turn settlement without inventing success", () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });
    const traceparent = beginSessionPrompt({
      sessionId: "s1",
      cwd: "/tmp/notes",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
    endSessionPrompt("s1");
    beginWorkerTurn({
      traceparent,
      sessionId: "s1",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
    });
    beginToolExecution({ sessionId: "s1", toolName: "bash", toolCallId: "lost" });

    endWorkerTurn();

    const tool = exporter.getFinishedSpans().find((span) => span.name === "session.tool");
    expect(tool?.attributes["wikilot.tool.call_id"]).toBe("lost");
    expect(tool?.attributes["wikilot.tool.outcome"]).toBeUndefined();
  });

  it("ends open Tool spans during telemetry shutdown", async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    const onEnd = vi.spyOn(processor, "onEnd");
    initHostTelemetry({
      enabled: true,
      spanProcessor: processor,
    });
    const traceparent = beginSessionPrompt({
      sessionId: "s1",
      cwd: "/tmp/notes",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
    endSessionPrompt("s1");
    beginWorkerTurn({
      traceparent,
      sessionId: "s1",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
    });
    beginToolExecution({ sessionId: "s1", toolName: "bash", toolCallId: "open" });

    await shutdownHostTelemetry();

    const tool = onEnd.mock.calls.map(([span]) => span).find((span) => span.name === "session.tool");
    expect(tool?.attributes["wikilot.tool.call_id"]).toBe("open");
    expect(tool?.attributes["wikilot.tool.outcome"]).toBeUndefined();
  });

  it("records only approved read_pdf_page completion facts", () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });
    const traceparent = beginSessionPrompt({
      sessionId: "s1",
      cwd: "/private/workspace",
      provider: "openai",
      model: "vision-model",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
    endSessionPrompt("s1");
    beginWorkerTurn({ traceparent, sessionId: "s1", provider: "openai", model: "vision-model", thinkingLevel: "high" });
    const privateStartFacts = {
      sessionId: "s1",
      toolName: "read_pdf_page",
      toolCallId: "pdf-1",
      timeoutSeconds: 60,
      path: "references/private.pdf",
      absolutePath: "/private/workspace/references/private.pdf",
      page: 7,
      pageCount: 99,
      prompt: "prompt secret",
      nonce: "nonce-123",
      apiKey: "sk-credential",
    };
    beginToolExecution(privateStartFacts);
    const privateCompletionFacts = {
      toolCallId: "pdf-1",
      outcome: "success" as const,
      timeoutSeconds: 60,
      imageCount: 1,
      imageMimeType: "image/png" as const,
      imageWidth: 1224,
      imageHeight: 1584,
      imageRef: "timeline-image:private",
      imageData: "base64-png-data",
      sourceReadCount: 12,
      rawError: "raw exception",
      response: "model response",
    };
    setReadPdfPageToolCompletion(privateCompletionFacts);
    endToolExecution({ toolCallId: "pdf-1", outcome: "success" });

    const attributes = exporter.getFinishedSpans().find((span) => span.name === "session.tool")?.attributes ?? {};
    expect(attributes).toEqual({
      "wikilot.gesture": "session.tool",
      "wikilot.session.id": "s1",
      "wikilot.tool.name": "read_pdf_page",
      "wikilot.tool.call_id": "pdf-1",
      "wikilot.tool.timeout_seconds": 60,
      "wikilot.tool.outcome": "success",
      "wikilot.tool.image_count": 1,
      "wikilot.tool.image_mime_type": "image/png",
      "wikilot.tool.image_width": 1224,
      "wikilot.tool.image_height": 1584,
    });
    const serialized = JSON.stringify(attributes);
    for (const forbidden of [
      "/private/workspace",
      "references/private.pdf",
      "pageCount",
      "page_number",
      "timeline-image:",
      "base64",
      "raw exception",
      "prompt secret",
      "model response",
      "nonce-123",
      "sk-credential",
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("records typed read_pdf_page timeout and error outcomes without raw errors", () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({ enabled: true, spanProcessor: new SimpleSpanProcessor(exporter) });
    const traceparent = beginSessionPrompt({ sessionId: "s1", cwd: "/tmp", provider: "p", model: "m", thinkingLevel: "off", wikiPromptEnabled: false });
    endSessionPrompt("s1");
    beginWorkerTurn({ traceparent, sessionId: "s1", provider: "p", model: "m", thinkingLevel: "off" });
    beginToolExecution({ sessionId: "s1", toolName: "read_pdf_page", toolCallId: "timeout" });
    setReadPdfPageToolCompletion({ toolCallId: "timeout", outcome: "timeout", timeoutSeconds: 5, errorCode: "timeout" });
    endToolExecution({ toolCallId: "timeout", outcome: "error" });
    beginToolExecution({ sessionId: "s1", toolName: "read_pdf_page", toolCallId: "cancel" });
    setReadPdfPageToolCompletion({ toolCallId: "cancel", outcome: "cancelled", timeoutSeconds: 60, errorCode: "cancelled" });
    endToolExecution({ toolCallId: "cancel", outcome: "error" });

    const tools = exporter.getFinishedSpans().filter((span) => span.name === "session.tool");
    expect(tools.map((span) => [
      span.attributes["wikilot.tool.outcome"],
      span.attributes["wikilot.tool.error_code"],
      span.attributes["wikilot.tool.timeout_seconds"],
    ])).toEqual([
      ["timeout", "timeout", 5],
      ["cancelled", "cancelled", 60],
    ]);
    expect(JSON.stringify(tools.map((span) => span.attributes))).not.toContain("exception");
  });

  it("starts no Worker turn span without a valid traceparent", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    beginWorkerTurn({
      traceparent: "not-a-traceparent",
      sessionId: "s1",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
    });
    beginWorkerTurn({
      sessionId: "s1",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
    });
    endWorkerTurn();

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("credential.save / defaults.save spans", () => {
  afterEach(async () => {
    await shutdownHostTelemetry();
  });

  it("emits credential.save with provider id only", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    recordCredentialSave({ providerId: "openai" });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("credential.save");
    expect(spans[0]?.attributes["wikilot.llm.provider"]).toBe("openai");
    expect(spans[0]?.attributes["wikilot.llm.apiKey"]).toBeUndefined();
  });

  it("emits defaults.save with thinking/wiki state and no credentials", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });

    recordAppDefaultsSave({
      sessionModel: {
        provider: "openai",
        model: "gpt-5.6",
        thinkingLevel: "high",
      },
      wikiPromptEnabled: false,
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("defaults.save");
    expect(spans[0]?.attributes["wikilot.llm.thinking"]).toBe("high");
    expect(spans[0]?.attributes["wikilot.wiki.enabled"]).toBe("false");
    expect(spans[0]?.attributes["wikilot.llm.apiKey"]).toBeUndefined();
  });
});
