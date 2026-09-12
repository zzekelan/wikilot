import { buildSessionContext, type SessionManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../../shared/settings";
import {
  sessionConfigEntryData,
  WIKILOT_SESSION_ENTRY_TYPE,
} from "../../shared/workspace";

/**
 * Durable per-Session configuration snapshot. Written into the Session's
 * Wikilot-namespaced custom entry at creation (a Defaults snapshot), so
 * existing Sessions restore their configuration from history instead of
 * recomputing current Defaults. Custom entries never enter LLM context.
 */
export type SessionConfig = {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  wikiPromptEnabled?: boolean;
};

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Read the latest configuration snapshot from a Session's history. Fields the
 * entry omits stay undefined, so callers can fall back to current Defaults.
 */
export function readSessionConfig(
  sessionManager: SessionManager,
): SessionConfig {
  const entries = sessionManager.getEntries();
  let wikilot: SessionConfig = {};
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type !== "custom" ||
      entry.customType !== WIKILOT_SESSION_ENTRY_TYPE
    ) {
      continue;
    }
    const data = (entry.data ?? {}) as Record<string, unknown>;
    wikilot = {
      provider: stringField(data.provider),
      model: stringField(data.model),
      thinkingLevel: stringField(data.thinkingLevel) as
        | ThinkingLevel
        | undefined,
      wikiPromptEnabled:
        typeof data.wikiPromptEnabled === "boolean"
          ? data.wikiPromptEnabled
          : undefined,
    };
    break;
  }
  const hasModelEntry = entries.some((entry) => entry.type === "model_change");
  const hasThinkingEntry = entries.some(
    (entry) => entry.type === "thinking_level_change",
  );
  if (!hasModelEntry && !hasThinkingEntry && Object.keys(wikilot).length === 0) {
    return {};
  }
  const context = buildSessionContext(entries, sessionManager.getLeafId());
  return {
    provider: wikilot.provider ?? (hasModelEntry ? context.model?.provider : undefined),
    model: wikilot.model ?? (hasModelEntry ? context.model?.modelId : undefined),
    thinkingLevel:
      wikilot.thinkingLevel ??
      (hasThinkingEntry
        ? (stringField(context.thinkingLevel) as ThinkingLevel | undefined)
        : undefined),
    wikiPromptEnabled: wikilot.wikiPromptEnabled,
  };
}

/** Persist Pi-owned values natively and Wikilot-only values as custom state. */
export function appendSessionConfig(
  sessionManager: SessionManager,
  config: SessionConfig,
): void {
  if (config.provider !== undefined && config.model !== undefined) {
    sessionManager.appendModelChange(config.provider, config.model);
  }
  if (config.thinkingLevel !== undefined) {
    sessionManager.appendThinkingLevelChange(config.thinkingLevel);
  }
  sessionManager.appendCustomEntry(
    WIKILOT_SESSION_ENTRY_TYPE,
    sessionConfigEntryData(config),
  );
}
