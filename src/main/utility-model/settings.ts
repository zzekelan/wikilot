import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertKnownFields, THINKING_LEVELS, type ThinkingLevel, type UtilitySettings } from "../../shared/settings/index.ts";

function parseUtilitySettings(value: unknown): UtilitySettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Utility settings must be an object");
  }
  const settings = value as Record<string, unknown>;
  assertKnownFields(settings, ["model"], "Utility settings");
  if (settings.model === null) return { model: null };
  if (!settings.model || typeof settings.model !== "object" || Array.isArray(settings.model)) {
    throw new Error("Utility Model must contain provider and model, or be null");
  }
  const model = settings.model as Record<string, unknown>;
  assertKnownFields(model, ["provider", "model", "thinkingLevel"], "Utility Model");
  if (typeof model.provider !== "string" || !model.provider.trim() ||
      typeof model.model !== "string" || !model.model.trim()) {
    throw new Error("Utility Model requires provider and model");
  }
  if (!(THINKING_LEVELS as readonly unknown[]).includes(model.thinkingLevel)) {
    throw new Error("Utility Model requires a Thinking Level");
  }
  return { model: { provider: model.provider.trim(), model: model.model.trim(), thinkingLevel: model.thinkingLevel as ThinkingLevel } };
}

export function createUtilitySettingsStore(agentDir: string) {
  const path = join(agentDir, "utility-model.json");
  return {
    read(): UtilitySettings {
      try {
        return parseUtilitySettings(JSON.parse(readFileSync(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { model: null };
        throw new Error("Could not read Utility Model settings", { cause: error });
      }
    },
    update(value: unknown): UtilitySettings {
      const settings = parseUtilitySettings(value);
      mkdirSync(agentDir, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      renameSync(temporary, path);
      return settings;
    },
  };
}
