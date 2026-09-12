import { describe, expect, it } from "vitest";
import {
  attributesLeakSecret,
  buildCredentialSaveSpanAttributes,
  buildDefaultsSaveSpanAttributes,
  buildToolCompletionSpanAttributes,
  buildToolSpanAttributes,
  buildTurnSpanAttributes,
} from "./span-attributes";

describe("turn telemetry attributes", () => {
  const apiKey = "sk-super-secret-key-value";

  it("includes provider/model/wiki metadata without the API key", () => {
    const attrs = buildTurnSpanAttributes({
      sessionId: "s1",
      cwd: "/tmp/ws",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: true,
      apiKey,
    });

    expect(attrs["wikilot.gesture"]).toBe("session.prompt");
    expect(attrs["wikilot.llm.provider"]).toBe("openai");
    expect(attrs["wikilot.llm.model"]).toBe("gpt-4.1");
    expect(attrs["wikilot.llm.thinking"]).toBe("high");
    expect(attrs["wikilot.wiki.enabled"]).toBe("true");
    expect(attrs["wikilot.wiki.prompt"]).toBeUndefined();
    expect(attrs["wikilot.llm.system_prompt"]).toBeUndefined();
    expect(attributesLeakSecret(attrs, apiKey)).toBe(false);
    expect(JSON.stringify(attrs)).not.toContain(apiKey);
  });

  it("records only Context Clip counts and character totals", () => {
    const attrs = buildTurnSpanAttributes({
      sessionId: "s1",
      workspaceId: "workspace-1",
      cwd: "/tmp/ws",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: true,
      clipCount: 2,
      clipCharacters: 42,
    });

    expect(attrs["wikilot.context_clip.count"]).toBe("2");
    expect(attrs["wikilot.context_clip.characters"]).toBe("42");
    expect(attrs["wikilot.workspace.id"]).toBe("484d4f88b59b95fc9409ad7018107c51");
    expect(JSON.stringify(attrs)).not.toContain("/tmp/ws");
    expect(JSON.stringify(attrs)).not.toContain("notes/private.md");
    expect(JSON.stringify(attrs)).not.toContain("locator");
  });

  it("includes Wiki fragment and assembled system prompt when supplied", () => {
    const fragment = "# LLM Wiki\n\ncompounding wiki";
    const systemPrompt = `You are helpful.\n\n${fragment}\n\n<project_context>`;
    const attrs = buildTurnSpanAttributes({
      sessionId: "s1",
      cwd: "/tmp/ws",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: true,
      wikiPromptFragment: fragment,
      systemPrompt,
      apiKey,
    });

    expect(attrs["wikilot.wiki.prompt"]).toBe(fragment);
    expect(attrs["wikilot.llm.system_prompt"]).toBe(systemPrompt);
    expect(attributesLeakSecret(attrs, apiKey)).toBe(false);
  });

  it("records wiki disabled without a prompt body", () => {
    const attrs = buildTurnSpanAttributes({
      sessionId: "s1",
      cwd: "/tmp/ws",
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
      apiKey,
    });

    expect(attrs["wikilot.wiki.enabled"]).toBe("false");
    expect(attrs["wikilot.wiki.prompt"]).toBeUndefined();
    expect(attrs["wikilot.llm.system_prompt"]).toBeUndefined();
  });

  it("builds credential.save spans with provider id and no secret", () => {
    const attrs = buildCredentialSaveSpanAttributes({
      providerId: "openai",
      apiKey,
    });

    expect(attrs["wikilot.gesture"]).toBe("credential.save");
    expect(attrs["wikilot.llm.provider"]).toBe("openai");
    expect(attributesLeakSecret(attrs, apiKey)).toBe(false);
    expect(JSON.stringify(attrs)).not.toContain(apiKey);
  });

  it("builds defaults.save spans with model/wiki state and no credentials", () => {
    const attrs = buildDefaultsSaveSpanAttributes({
      sessionModel: {
        provider: "openai",
        model: "gpt-5.6",
        thinkingLevel: "high",
      },
      wikiPromptEnabled: false,
      apiKey,
    });

    expect(attrs["wikilot.gesture"]).toBe("defaults.save");
    expect(attrs["wikilot.llm.provider"]).toBe("openai");
    expect(attrs["wikilot.llm.model"]).toBe("gpt-5.6");
    expect(attrs["wikilot.llm.thinking"]).toBe("high");
    expect(attrs["wikilot.wiki.enabled"]).toBe("false");
    expect(attributesLeakSecret(attrs, apiKey)).toBe(false);
  });

  it("builds generic Tool lifecycle attributes without credential material", () => {
    const attrs = {
      ...buildToolSpanAttributes({
        sessionId: "s1",
        toolName: "bash",
        toolCallId: "t1",
        apiKey,
      }),
      ...buildToolCompletionSpanAttributes({ outcome: "error" }),
    };

    expect(attrs).toEqual({
      "wikilot.gesture": "session.tool",
      "wikilot.session.id": "s1",
      "wikilot.tool.name": "bash",
      "wikilot.tool.call_id": "t1",
      "wikilot.tool.outcome": "error",
    });
    expect(attributesLeakSecret(attrs, apiKey)).toBe(false);
  });

  it("allows only privacy-safe read_pdf_page facts", () => {
    const attrs = {
      ...buildToolSpanAttributes({
        sessionId: "s1",
        toolName: "read_pdf_page",
        toolCallId: "pdf-1",
        timeoutSeconds: 60,
      }),
      ...buildToolCompletionSpanAttributes({
        outcome: "success",
        timeoutSeconds: 60,
        imageCount: 1,
        imageMimeType: "image/png",
        imageWidth: 1224,
        imageHeight: 1584,
      }),
    };

    expect(attrs).toEqual({
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
  });

  it("detects leaked apiKey values in attributes", () => {
    expect(
      attributesLeakSecret({ "wikilot.note": `using ${apiKey}` }, apiKey),
    ).toBe(true);
    expect(attributesLeakSecret({ apiKey: "x" }, "unused")).toBe(true);
  });
});
