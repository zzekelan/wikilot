import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type ProviderInput,
  type ProviderProtocol,
} from "../../shared/settings/index.ts";
import { resolveAuthPath, resolveModelsPath } from "./agent-paths.ts";
import { createProviderStore } from "./provider-store.ts";

type RuntimeProvider = Parameters<ModelRuntime["registerNativeProvider"]>[0];
type RuntimeModel = ReturnType<RuntimeProvider["getModels"]>[number];

const BASE_PROVIDER_BY_PROTOCOL: Record<ProviderProtocol, string> = {
  "openai-completions": "openrouter",
  "openai-responses": "openai",
  "anthropic-messages": "anthropic",
  "google-generative-ai": "google",
};

const syncedDefinitions = new WeakMap<ModelRuntime, Map<string, string>>();
const builtInProviderIds = new WeakMap<ModelRuntime, Set<string>>();

function modelFromInput(
  provider: ProviderInput,
  model: ProviderInput["models"][number],
): RuntimeModel {
  return {
    id: model.id,
    name: model.name ?? model.id,
    api: provider.protocol,
    provider: provider.providerId,
    baseUrl: provider.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: model.thinkingLevelMap }
      : {}),
    input: model.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 16_384,
    ...(provider.protocol === "openai-completions"
      ? {
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: model.reasoning,
          },
        }
      : {}),
  };
}

function storedApiKeyAuth(): RuntimeProvider["auth"] {
  return {
    apiKey: {
      name: "API key",
      login: async (interaction) => ({
        type: "api_key",
        key: await interaction.prompt({
          type: "secret",
          message: "Enter API key",
        }),
      }),
      check: async ({ credential }) =>
        credential?.type === "api_key" && credential.key?.trim()
          ? { type: "api_key", source: "stored credential" }
          : undefined,
      resolve: async ({ credential }) =>
        credential?.type === "api_key" && credential.key?.trim()
          ? {
              auth: { apiKey: credential.key },
              source: "stored credential",
            }
          : undefined,
    },
  };
}

function noAuthentication(): RuntimeProvider["auth"] {
  return {
    apiKey: {
      name: "No authentication",
      check: async () => ({
        type: "api_key",
        source: "No authentication",
      }),
      resolve: async () => ({
        auth: {},
        source: "No authentication",
      }),
    },
  };
}

function createRegisteredProvider(
  runtime: ModelRuntime,
  definition: ProviderInput,
): RuntimeProvider {
  const base = runtime.getProvider(BASE_PROVIDER_BY_PROTOCOL[definition.protocol]);
  if (!base) {
    throw new Error(`Pi does not support protocol "${definition.protocol}"`);
  }
  const models = definition.models.map((model) =>
    modelFromInput(definition, model),
  );
  return {
    id: definition.providerId,
    name: definition.name,
    baseUrl: definition.baseUrl,
    auth:
      definition.authMode === "none"
        ? noAuthentication()
        : storedApiKeyAuth(),
    getModels: () => models,
    stream: (model, context, options) => base.stream(model, context, options),
    streamSimple: (model, context, options) =>
      base.streamSimple(model, context, options),
  };
}

function fingerprint(definition: ProviderInput): string {
  return JSON.stringify(definition);
}

/** Register the current on-disk User Providers in a Main or Worker runtime. */
export async function syncUserProviders(
  runtime: ModelRuntime,
  agentDir: string,
): Promise<ProviderInput[]> {
  const definitions = await createProviderStore(
    resolveModelsPath(agentDir),
  ).list();
  const nativeBuiltInIds =
    builtInProviderIds.get(runtime) ??
    new Set(runtime.getProviders().map((provider) => provider.id.toLowerCase()));
  builtInProviderIds.set(runtime, nativeBuiltInIds);
  for (const definition of definitions) {
    if (nativeBuiltInIds.has(definition.providerId.toLowerCase())) {
      throw new Error(
        `User Provider identifier "${definition.providerId}" conflicts with a Built-in Provider`,
      );
    }
  }

  const known =
    syncedDefinitions.get(runtime) ?? new Map<string, string>();

  for (const providerId of [...known.keys()]) {
    if (definitions.some((definition) => definition.providerId === providerId)) {
      continue;
    }
    runtime.unregisterProvider(providerId);
    known.delete(providerId);
  }

  for (const definition of definitions) {
    const nextFingerprint = fingerprint(definition);
    if (known.get(definition.providerId) === nextFingerprint) continue;
    runtime.registerNativeProvider(createRegisteredProvider(runtime, definition));
    known.set(definition.providerId, nextFingerprint);
  }
  syncedDefinitions.set(runtime, known);
  await runtime.refresh();
  return definitions;
}

/** Create the Wikilot runtime with online Pi catalogs and the shared CredentialStore. */
export async function createWikilotModelRuntime(
  agentDir: string,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({
    authPath: resolveAuthPath(agentDir),
    // Wikilot registers User Providers itself so the explicit No-auth mode can
    // use a real keyless auth resolver instead of a fake models.json secret.
    modelsPath: null,
    allowModelNetwork: true,
  });
  await syncUserProviders(runtime, agentDir);
  return runtime;
}
