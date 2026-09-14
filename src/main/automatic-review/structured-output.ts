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
