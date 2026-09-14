export const reviewSchema = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: ["allow", "deny"] },
    reason: { type: "string" },
  },
  required: ["outcome", "reason"],
  additionalProperties: false,
};

export type ReviewDecision = { outcome: "allow" | "deny"; reason: string };

/** Match rejected output modes/parameters, not bad schemas or unrelated API errors. */
export function isUnsupportedReviewFormat(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const field = "(?:json_schema|response_format(?:[.\\s]+type)?|text\\.format|output_config\\.format|responseJsonSchema|structured outputs?)";
  return new RegExp(`\\b${field}\\b[\\s\"':]*(?:(?:is|are)\\s+)?(?:not supported|unsupported|unavailable|not available)`, "i").test(message) ||
    new RegExp(`(?:unsupported|unknown|unrecognized)\\s+(?:parameter|field|argument|type)[\\s\"':]*${field}\\b`, "i").test(message) ||
    /does not support\s+(?:the\s+)?(?:json_schema|response_format|structured outputs?)/i.test(message) ||
    (/\b(?:response_format|json_schema)\b/i.test(message) &&
      /(?:supported values|must be one of|only supports|expected one of)[^\n]{0,100}\btext\b[^\n]{0,40}\bjson_object\b/i.test(message));
}

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
