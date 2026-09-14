import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../../shared/settings/index.ts";

/** Unsupported protocols use prompt guidance directly. */
function constrainJsonSchemaOutput(api: Api, payload: unknown, output: { name: string; schema: Record<string, unknown> }): unknown {
  const request = payload as Record<string, unknown>;
  const format = { type: "json_schema", name: output.name, strict: true, schema: output.schema };
  switch (api) {
    case "openai-completions":
      return { ...request, response_format: { type: "json_schema", json_schema: {
        name: format.name, strict: true, schema: output.schema,
      } } };
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses":
      return { ...request, text: { ...(request.text as object), format } };
    case "anthropic-messages":
      return { ...request, output_config: { ...(request.output_config as object),
        format: { type: "json_schema", schema: output.schema },
      } };
    case "google-generative-ai":
      return { ...request, config: { ...(request.config as object),
        responseMimeType: "application/json", responseJsonSchema: output.schema,
      } };
    default:
      return undefined;
  }
}

/** Match rejected output modes/parameters, not bad schemas or unrelated API errors. */
function isUnsupportedFormat(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const field = "(?:json_schema|response_format(?:[.\\s]+type)?|text\\.format|output_config\\.format|responseJsonSchema|structured outputs?)";
  return new RegExp(`\\b${field}\\b[\\s\"':]*(?:(?:is|are)\\s+)?(?:not supported|unsupported|unavailable|not available)`, "i").test(message) ||
    new RegExp(`(?:unsupported|unknown|unrecognized)\\s+(?:parameter|field|argument|type)[\\s\"':]*${field}\\b`, "i").test(message) ||
    /does not support\s+(?:the\s+)?(?:json_schema|response_format|structured outputs?)/i.test(message) ||
    (/\b(?:response_format|json_schema)\b/i.test(message) &&
      /(?:supported values|must be one of|only supports|expected one of)[^\n]{0,100}\btext\b[^\n]{0,40}\bjson_object\b/i.test(message));
}

/** One validated result, preferring native constraints with one unsupported-format retry.
 * The caller supplies its operation deadline and owns domain validation and failure effects.
 */
export async function completeStructuredOutput<T>(options: {
  runtime: Pick<ModelRuntime, "completeSimple">;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  systemPrompt: string;
  input: string;
  output: { name: string; schema: Record<string, unknown>; parse(text: string): T };
  maxTokens: number;
  signal: AbortSignal;
}): Promise<T> {
  const { runtime, model, output, signal } = options;
  signal.throwIfAborted();
  const systemPrompt = `${options.systemPrompt}
Return exactly one JSON object matching this schema: ${JSON.stringify(output.schema)}.
No Markdown, code fences, commentary, extra fields or tool calls.`;
  const maxTokens = Math.min(options.maxTokens, model.maxTokens);
  if (Math.ceil((systemPrompt.length + options.input.length) / 4) + maxTokens > model.contextWindow) {
    throw new Error("Structured output input exceeds the model context window. Shorten the input or select a larger model.");
  }
  const nativeSchema = constrainJsonSchemaOutput(model.api, {}, output) !== undefined;
  const context = {
    systemPrompt,
    messages: [{ role: "user" as const, content: options.input, timestamp: Date.now() }],
  };
  async function request(constrain: boolean) {
    signal.throwIfAborted();
    let constrained = false;
    const response = await runtime.completeSimple(model, context, {
      signal, timeoutMs: 60_000, maxRetries: 0, maxTokens,
      reasoning: options.thinkingLevel === "off" ? undefined : options.thinkingLevel,
      ...(constrain ? { onPayload(payload: unknown) {
        const result = constrainJsonSchemaOutput(model.api, payload, output);
        constrained = true;
        return result;
      } } : {}),
    });
    signal.throwIfAborted();
    if (response.stopReason !== "stop") {
      throw new Error(response.errorMessage || "The model did not return a complete structured response.");
    }
    if (constrain && !constrained) throw new Error("The requested native schema was not applied.");
    return response;
  }
  let response;
  try {
    response = await request(nativeSchema);
  } catch (error) {
    if (!nativeSchema || signal.aborted || !isUnsupportedFormat(error)) throw error;
    response = await request(false);
  }
  // Invalid output is returned to the caller as an error, never repaired or retried.
  return output.parse(response.content.filter(block => block.type === "text").map(block => block.text).join(""));
}
