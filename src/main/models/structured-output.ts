import type { Api } from "@earendil-works/pi-ai";

/** Apply native response constraints; callers own any fallback policy for unsupported protocols. */
export function constrainJsonSchemaOutput(api: Api, payload: unknown, output: { name: string; schema: Record<string, unknown> }): unknown {
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
      throw new Error(`Native JSON Schema output is required; unsupported protocol: ${api}`);
  }
}
