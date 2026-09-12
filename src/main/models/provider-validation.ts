import {
  assertKnownFields,
  PROVIDER_AUTH_MODES,
  PROVIDER_INPUT_FIELDS,
  PROVIDER_MODEL_FIELDS,
  PROVIDER_MODEL_INPUTS,
  PROVIDER_PROTOCOLS,
  THINKING_LEVELS,
  type ProviderInput,
  type ProviderModel,
  type ThinkingLevelMap,
} from "../../shared/settings/index.ts";

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

function normalizedOptionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Provider field must be text");
  const trimmed = value.trim();
  return trimmed || undefined;
}

function positiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function validateThinkingLevelMap(
  value: unknown,
  index: number,
): ThinkingLevelMap | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`models[${index}].thinkingLevelMap must be an object`);
  }
  const map = value as Record<string, unknown>;
  assertKnownFields(
    map,
    THINKING_LEVELS,
    `models[${index}].thinkingLevelMap`,
  );
  return Object.fromEntries(
    Object.entries(map).map(([level, mapped]) => {
      if (mapped === null) return [level, null];
      if (typeof mapped !== "string" || !mapped.trim()) {
        throw new Error(
          `models[${index}].thinkingLevelMap.${level} must be text or null`,
        );
      }
      return [level, mapped.trim()];
    }),
  ) as ThinkingLevelMap;
}

function validateModel(value: ProviderModel, index: number): ProviderModel {
  if (!value || typeof value !== "object") {
    throw new Error(`models[${index}] is required`);
  }
  assertKnownFields(
    value as unknown as Record<string, unknown>,
    PROVIDER_MODEL_FIELDS,
    `models[${index}]`,
  );
  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!id) throw new Error(`models[${index}].id is required`);
  const name = normalizedOptionalString(value.name);
  if (typeof value.reasoning !== "boolean") {
    throw new Error(`models[${index}].reasoning must be boolean`);
  }
  const thinkingLevelMap = validateThinkingLevelMap(
    value.thinkingLevelMap,
    index,
  );
  if (!Array.isArray(value.input) || value.input.length === 0) {
    throw new Error(`models[${index}].input must include text or image`);
  }
  const input = [...new Set(value.input)];
  if (
    input.some(
      (entry) =>
        typeof entry !== "string" ||
        !PROVIDER_MODEL_INPUTS.includes(entry as (typeof PROVIDER_MODEL_INPUTS)[number]),
    )
  ) {
    throw new Error(`models[${index}].input is invalid`);
  }
  const contextWindow = positiveInteger(
    value.contextWindow,
    `models[${index}].contextWindow`,
  );
  const maxTokens = positiveInteger(
    value.maxTokens,
    `models[${index}].maxTokens`,
  );
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    reasoning: value.reasoning,
    ...(thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
    input: input as ProviderModel["input"],
  };
}

export function validateProviderInput(
  value: ProviderInput,
  options: { builtInIds: Iterable<string>; existingIds: Iterable<string>; currentId?: string },
): ProviderInput {
  if (!value || typeof value !== "object") {
    throw new Error("Provider input is required");
  }
  assertKnownFields(
    value as unknown as Record<string, unknown>,
    PROVIDER_INPUT_FIELDS,
    "Provider input",
  );
  const providerId = typeof value.providerId === "string" ? value.providerId.trim() : "";
  if (!providerId) throw new Error("providerId is required");
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    throw new Error(
      "providerId must contain only letters, numbers, dots, underscores, or hyphens",
    );
  }

  const lowerId = providerId.toLowerCase();
  for (const builtInId of options.builtInIds) {
    if (builtInId.toLowerCase() === lowerId) {
      throw new Error(`providerId "${providerId}" is a Built-in Provider identifier`);
    }
  }
  for (const existingId of options.existingIds) {
    if (existingId !== options.currentId && existingId.toLowerCase() === lowerId) {
      throw new Error(`Provider identifier "${providerId}" is already in use`);
    }
  }
  if (options.currentId !== undefined && providerId !== options.currentId) {
    throw new Error("Provider identity cannot be changed");
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) throw new Error("name is required");
  if (name.length > 200) throw new Error("name is too long");

  const baseUrl = typeof value.baseUrl === "string" ? value.baseUrl.trim() : "";
  if (!baseUrl) throw new Error("baseUrl is required");
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error("baseUrl must be an absolute http or https URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("baseUrl must be an absolute http or https URL");
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error("baseUrl must not include URL credentials");
  }
  if (parsedUrl.search || parsedUrl.hash) {
    throw new Error("baseUrl must not include query parameters or fragments");
  }

  if (!PROVIDER_PROTOCOLS.includes(value.protocol)) {
    throw new Error("protocol is invalid");
  }
  if (!PROVIDER_AUTH_MODES.includes(value.authMode)) {
    throw new Error("authMode is invalid");
  }
  if (!Array.isArray(value.models) || value.models.length === 0) {
    throw new Error("At least one Model is required");
  }
  const models = value.models.map(validateModel);
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) throw new Error(`Duplicate Model ID "${model.id}"`);
    modelIds.add(model.id);
  }

  return {
    providerId,
    name,
    baseUrl,
    protocol: value.protocol,
    authMode: value.authMode,
    models,
  };
}
