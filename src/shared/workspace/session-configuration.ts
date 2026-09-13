import type { SessionConfiguration } from "./types.ts";

/** Namespaced custom entry type carrying Wikilot-only Session state. */
export const WIKILOT_SESSION_ENTRY_TYPE = "wikilot.session";

/** Plain custom entries are excluded from Pi's LLM context. */
export function sessionConfigEntryData(
  config: Pick<
    SessionConfiguration,
    "provider" | "model" | "thinkingLevel" | "wikiPromptEnabled" | "accessMode"
  >,
): Record<string, unknown> {
  return {
    origin: "wikilot",
    accessMode: config.accessMode ?? "auto-review",
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.thinkingLevel !== undefined
      ? { thinkingLevel: config.thinkingLevel }
      : {}),
    ...(config.wikiPromptEnabled !== undefined
      ? { wikiPromptEnabled: config.wikiPromptEnabled }
      : {}),
  };
}
