export const versionMessageSchema = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
  additionalProperties: false,
};

export function parseVersionMessage(text: string): string {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error("The model returned an invalid version message."); }
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !("message" in value) ||
      typeof value.message !== "string" || !value.message.trim()) {
    throw new Error("The model returned an invalid version message.");
  }
  return value.message.trim();
}
