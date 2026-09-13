import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertKnownFields, type ReviewSettings } from "../../shared/settings/index.ts";

export function parseReviewSettings(value: unknown): ReviewSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Review settings must be an object");
  }
  const settings = value as Record<string, unknown>;
  assertKnownFields(settings, ["model"], "Review settings");
  if (settings.model === null) return { model: null };
  if (!settings.model || typeof settings.model !== "object" || Array.isArray(settings.model)) {
    throw new Error("Review Model must contain provider and model, or be null");
  }
  const model = settings.model as Record<string, unknown>;
  assertKnownFields(model, ["provider", "model"], "Review Model");
  if (typeof model.provider !== "string" || !model.provider.trim() ||
      typeof model.model !== "string" || !model.model.trim()) {
    throw new Error("Review Model requires provider and model");
  }
  return { model: { provider: model.provider.trim(), model: model.model.trim() } };
}

export function createReviewSettingsStore(agentDir: string) {
  const path = join(agentDir, "review.json");
  return {
    read(): ReviewSettings {
      try {
        return parseReviewSettings(JSON.parse(readFileSync(path, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { model: null };
        throw new Error("Could not read Automatic Review settings", { cause: error });
      }
    },
    update(value: ReviewSettings): ReviewSettings {
      const settings = parseReviewSettings(value);
      mkdirSync(agentDir, { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
      renameSync(temporary, path);
      return settings;
    },
  };
}
