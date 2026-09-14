import { expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { completeStructuredOutput } from "./index";

const schema = { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false };

it.each([
  ["openai-completions", "response_format.json_schema.schema"],
  ["openai-responses", "text.format.schema"],
  ["openai-codex-responses", "text.format.schema"],
  ["azure-openai-responses", "text.format.schema"],
  ["anthropic-messages", "output_config.format.schema"],
  ["google-generative-ai", "config.responseJsonSchema"],
  ["unknown-api", undefined],
])("requests and validates structured output with %s", async (api, schemaPath) => {
  const model: Model<Api> = { id: "fixture", name: "Fixture", api: api!, provider: "fixture", baseUrl: "https://example.invalid",
    reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const parse = vi.fn((text: string) => {
    const value = JSON.parse(text);
    if (typeof value.message !== "string") throw new Error("Invalid message");
    return value.message.trim();
  });
  const complete = vi.fn<ModelRuntime["completeSimple"]>(async (_model, context, options) => {
    const original = { text: { verbosity: "low" }, output_config: { effort: "high" }, config: { temperature: 0 }, marker: "preserved" };
    const payload = await options?.onPayload?.(original, model);
    if (schemaPath) {
      expect(payload).toHaveProperty(schemaPath, schema);
      expect(payload).toMatchObject(original);
    } else {
      expect(options?.onPayload).toBeUndefined();
    }
    expect(context.systemPrompt).toContain("Summarize the changes.");
    expect(context.systemPrompt).toContain(JSON.stringify(schema));
    expect(context.tools).toBeUndefined();
    return { role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: 0,
      content: [{ type: "text", text: '{"message":" Done "}' }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  });
  const result = await completeStructuredOutput({ runtime: { completeSimple: complete }, model, thinkingLevel: "off",
    systemPrompt: "Summarize the changes.", input: "A change", output: { name: "summary", schema, parse },
    maxTokens: 1024, signal: AbortSignal.timeout(60000) });
  expect(result).toBe("Done");
  expect(parse).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(1);
});
