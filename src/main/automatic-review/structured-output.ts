import type { Api } from "@earendil-works/pi-ai";

export const reviewSchema = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["allow", "deny"] },
    reason: { type: "string" },
  },
  required: ["outcome", "reason"],
  additionalProperties: false,
};

/** Native response constraints. Unsupported protocols must never use prompt-only JSON. */
export function constrainReviewOutput(api: Api, payload: unknown): unknown {
  const request = payload as Record<string, unknown>;
  const format = { type: "json_schema", name: "automatic_review", strict: true, schema: reviewSchema };
  switch (api) {
    case "openai-completions":
      return { ...request, response_format: { type: "json_schema", json_schema: {
        name: format.name, strict: true, schema: reviewSchema,
      } } };
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses":
      return { ...request, text: { ...(request.text as object), format } };
    case "anthropic-messages":
      return { ...request, output_config: { ...(request.output_config as object),
        format: { type: "json_schema", schema: reviewSchema },
      } };
    case "google-generative-ai":
      return { ...request, config: { ...(request.config as object),
        responseMimeType: "application/json", responseJsonSchema: reviewSchema,
      } };
    default:
      throw new Error(`Automatic Review requires native JSON Schema output; unsupported protocol: ${api}`);
  }
}

export type ReviewDecision = { outcome: "allow" | "deny"; reason: string };

export function parseReviewDecision(text: string): ReviewDecision {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Automatic Review response");
  }
  const decision = value as Record<string, unknown>;
  if (Object.keys(decision).length !== 2 ||
      (decision.outcome !== "allow" && decision.outcome !== "deny") ||
      typeof decision.reason !== "string" || !decision.reason.trim()) {
    throw new Error("Invalid Automatic Review response");
  }
  return { outcome: decision.outcome, reason: decision.reason };
}
