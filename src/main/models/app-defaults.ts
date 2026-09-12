import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_APP_DEFAULTS,
  THINKING_LEVELS,
  type AppDefaults,
  type AppDefaultsUpdate,
  type SessionModelDefault,
  type ThinkingLevel,
} from "../../shared/settings/index.ts";
import { defaultAgentDir, resolveDefaultsPath } from "./agent-paths.ts";

/** New-Session defaults persisted under the Wikilot-owned Agent directory. */
export type AppDefaultsStore = {
  read(): AppDefaults;
  update(patch: AppDefaultsUpdate): AppDefaults;
};

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    typeof value === "string" &&
    (THINKING_LEVELS as readonly string[]).includes(value)
  );
}

function parseSessionModel(value: unknown): SessionModelDefault | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const model = value as Record<string, unknown>;
  if (
    typeof model.provider !== "string" ||
    !model.provider.trim() ||
    typeof model.model !== "string" ||
    !model.model.trim() ||
    !isThinkingLevel(model.thinkingLevel)
  ) {
    return undefined;
  }
  return {
    provider: model.provider.trim(),
    model: model.model.trim(),
    thinkingLevel: model.thinkingLevel,
  };
}

function parseDefaults(raw: string): AppDefaults {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const sessionModel = parseSessionModel(parsed.sessionModel);
  return {
    ...(sessionModel ? { sessionModel } : {}),
    wikiPromptEnabled:
      typeof parsed.wikiPromptEnabled === "boolean"
        ? parsed.wikiPromptEnabled
        : DEFAULT_APP_DEFAULTS.wikiPromptEnabled,
  };
}

function validatePatch(patch: AppDefaultsUpdate): void {
  if (
    patch.sessionModel !== undefined &&
    parseSessionModel(patch.sessionModel) === undefined
  ) {
    throw new Error(
      `sessionModel requires provider, model, and thinkingLevel (${THINKING_LEVELS.join(", ")})`,
    );
  }
}

export function createAppDefaultsStore(options: {
  agentDir?: string;
}): AppDefaultsStore {
  const defaultsPath = resolveDefaultsPath(
    options.agentDir ?? defaultAgentDir(),
  );

  function read(): AppDefaults {
    let raw: string;
    try {
      raw = readFileSync(defaultsPath, "utf8");
    } catch {
      return { ...DEFAULT_APP_DEFAULTS };
    }
    try {
      return parseDefaults(raw);
    } catch {
      return { ...DEFAULT_APP_DEFAULTS };
    }
  }

  return {
    read,

    update(patch) {
      validatePatch(patch);
      const current = read();
      const next: AppDefaults = { ...current };
      if (patch.sessionModel !== undefined) {
        next.sessionModel = parseSessionModel(patch.sessionModel)!;
      }
      if (patch.wikiPromptEnabled !== undefined) {
        next.wikiPromptEnabled = patch.wikiPromptEnabled;
      }
      mkdirSync(dirname(defaultsPath), { recursive: true });
      writeFileSync(defaultsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      return next;
    },
  };
}
