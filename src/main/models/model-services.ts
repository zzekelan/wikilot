import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type {
  ModelCatalogProvider,
  ProviderCredential,
  ProviderInput,
  ProviderSummary,
} from "../../shared/settings";
import { defaultAgentDir, resolveModelsPath } from "./agent-paths.ts";
import { createProviderStore } from "./provider-store.ts";
import { validateProviderInput } from "./provider-validation.ts";
import {
  createWikilotModelRuntime,
  syncUserProviders,
} from "./provider-runtime.ts";
import {
  createProviderAuthentication,
  type ProviderAuthentication,
} from "./authentication/authentication-service.ts";

/**
 * Provider, Model, and Credential services backed by Wikilot's Agent data.
 * Provider definitions are declarative and secret-free; API keys are handled
 * only by Pi's CredentialStore through the ModelRuntime.
 */
export type ModelServices = {
  getAuthentication(): Promise<ProviderAuthentication>;
  listProviders(): Promise<ProviderSummary[]>;
  createProvider(input: ProviderInput): Promise<ProviderSummary>;
  updateProvider(providerId: string, input: ProviderInput): Promise<ProviderSummary>;
  deleteProvider(providerId: string): Promise<void>;
  /** Base Model Catalog containing only executable Models. */
  listBaseCatalog(): Promise<ModelCatalogProvider[]>;
  /** Credential metadata (provider ids + types) — never secret material. */
  listCredentials(): Promise<ProviderCredential[]>;
  /** Save an API-key Credential through Pi's CredentialStore. */
  setApiKeyCredential(
    providerId: string,
    apiKey: string,
  ): Promise<ProviderCredential>;
  /** Remove a provider Credential. */
  deleteCredential(providerId: string): Promise<void>;
  /** Shared runtime for Session execution (Main-internal, never exposed). */
  getModelRuntime(): Promise<ModelRuntime>;
  /** Notify the Session module after a Provider/Credential mutation. */
  subscribeChanges(listener: (providerId: string) => void): () => void;
};

export type ModelServicesOptions = {
  /** Override the Wikilot Agent data root (tests; default `~/.wikilot/agent`). */
  agentDir?: string;
};

function modelCatalogName(model: { id: string; name?: string }): string {
  return model.name ?? model.id;
}

function modelSummary(
  model: ReturnType<ModelRuntime["getModels"]>[number],
): ProviderSummary["models"][number] {
  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindow > 0 ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens > 0 ? { maxTokens: model.maxTokens } : {}),
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
      : {}),
    input: model.input,
  };
}

function providerProtocol(
  models: readonly ReturnType<ModelRuntime["getModels"]>[number][],
): ProviderSummary["protocol"] {
  const protocol = models[0]?.api as string | undefined;
  if (
    protocol === "openai-completions" ||
    protocol === "openai-responses" ||
    protocol === "anthropic-messages" ||
    protocol === "google-generative-ai"
  ) {
    return protocol;
  }
  return undefined;
}

const UNSUPPORTED_BUILTIN_API_KEY_PROVIDERS = new Set([
  "amazon-bedrock",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
]);

function supportsSettingsApiKey(
  provider: ReturnType<ModelRuntime["getProviders"]>[number],
): boolean {
  return (
    provider.auth.apiKey?.login !== undefined &&
    !UNSUPPORTED_BUILTIN_API_KEY_PROVIDERS.has(provider.id)
  );
}

function literalCredentialValue(value: string): string {
  const escaped = value.replaceAll("$", () => "$$");
  return escaped.startsWith("!") ? `$!${escaped.slice(1)}` : escaped;
}

async function hasUsableStoredAuthentication(
  models: ModelRuntime,
  providerId: string,
  definition: ProviderInput | undefined,
  credentials: readonly ProviderCredential[],
): Promise<boolean> {
  if (definition?.authMode === "none") return true;
  if (!credentials.some((entry) => entry.providerId === providerId)) {
    return false;
  }
  return (await models.checkAuth(providerId)) !== undefined;
}

export function createModelServices(
  options: ModelServicesOptions = {},
): ModelServices {
  const agentDir = options.agentDir ?? defaultAgentDir();
  const providerStore = createProviderStore(resolveModelsPath(agentDir));
  const changeListeners = new Set<(providerId: string) => void>();
  let runtime: Promise<ModelRuntime> | undefined;
  let authentication: ProviderAuthentication | undefined;

  function notifyChange(providerId: string): void {
    for (const listener of changeListeners) listener(providerId);
  }

  async function getModelRuntime(): Promise<ModelRuntime> {
    runtime ??= createWikilotModelRuntime(agentDir);
    const models = await runtime;
    await syncUserProviders(models, agentDir);
    return models;
  }

  async function getAuthentication(): Promise<ProviderAuthentication> {
    authentication ??= createProviderAuthentication({
      getRuntime: getModelRuntime,
      onCredentialChanged: ({ providerId }) => notifyChange(providerId),
    });
    return authentication;
  }

  async function readDefinitions(): Promise<{
    models: ModelRuntime;
    definitions: ProviderInput[];
    builtInIds: string[];
  }> {
    const models = await getModelRuntime();
    const definitions = await providerStore.list();
    const userIds = new Set(definitions.map((definition) => definition.providerId));
    const builtInIds = models
      .getProviders()
      .map((provider) => provider.id)
      .filter((providerId) => !userIds.has(providerId));
    return { models, definitions, builtInIds };
  }

  async function summaries(): Promise<ProviderSummary[]> {
    const { models, definitions } = await readDefinitions();
    const credentials = await models.listCredentials();
    const result: ProviderSummary[] = [];

    for (const provider of models.getProviders()) {
      const definition = definitions.find(
        (entry) => entry.providerId === provider.id,
      );
      if (definition) {
        result.push({
          ...definition,
          source: "user",
          authenticated: await hasUsableStoredAuthentication(
            models,
            provider.id,
            definition,
            credentials,
          ),
          supportsApiKey: definition.authMode === "api_key",
          supportsOAuth: false,
        });
        continue;
      }

      const supportsApiKey = supportsSettingsApiKey(provider);
      const supportsOAuth = provider.auth.oauth !== undefined;
      const authenticated = await hasUsableStoredAuthentication(
        models,
        provider.id,
        undefined,
        credentials,
      );
      const providerModels = models.getModels(provider.id);
      result.push({
        providerId: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl ?? "",
        protocol: providerProtocol(providerModels),
        ...(supportsApiKey ? { authMode: "api_key" as const } : {}),
        models: providerModels.map(modelSummary),
        source: "builtin",
        authenticated,
        supportsApiKey,
        supportsOAuth,
        ...(supportsOAuth
          ? { oauthLabel: provider.auth.oauth?.loginLabel ?? "Sign in with account" }
          : {}),
      });
    }

    return result;
  }

  async function refreshProviderSummary(
    models: ModelRuntime,
    providerId: string,
  ): Promise<ProviderSummary> {
    await syncUserProviders(models, agentDir);
    const result = (await summaries()).find(
      (provider) => provider.providerId === providerId,
    );
    if (!result) throw new Error("Provider was not persisted");
    return result;
  }

  return {
    getModelRuntime,
    getAuthentication,

    listProviders: summaries,

    async createProvider(input) {
      const { models, builtInIds } = await readDefinitions();
      const created = await providerStore.mutate((current) => {
        const definition = validateProviderInput(input, {
          builtInIds,
          existingIds: current.map((entry) => entry.providerId),
        });
        return {
          providers: [...current, definition],
          value: definition,
        };
      });
      const summary = await refreshProviderSummary(models, created.providerId);
      notifyChange(created.providerId);
      return summary;
    },

    async updateProvider(providerId, input) {
      const trimmedId = providerId.trim();
      if (!trimmedId) throw new Error("providerId is required");
      const { models, builtInIds } = await readDefinitions();
      const updated = await providerStore.mutate((current) => {
        if (!current.some((entry) => entry.providerId === trimmedId)) {
          throw new Error(`User Provider "${trimmedId}" was not found`);
        }
        const definition = validateProviderInput(input, {
          builtInIds,
          existingIds: current.map((entry) => entry.providerId),
          currentId: trimmedId,
        });
        return {
          providers: current.map((entry) =>
            entry.providerId === trimmedId ? definition : entry,
          ),
          value: definition,
        };
      });
      const summary = await refreshProviderSummary(models, updated.providerId);
      notifyChange(updated.providerId);
      return summary;
    },

    async deleteProvider(providerId) {
      const trimmedId = providerId.trim();
      if (!trimmedId) throw new Error("providerId is required");
      const { models, builtInIds } = await readDefinitions();
      if (builtInIds.includes(trimmedId)) {
        throw new Error("Built-in Provider definitions cannot be deleted");
      }
      await providerStore.mutate((current) => {
        if (!current.some((entry) => entry.providerId === trimmedId)) {
          throw new Error(`User Provider "${trimmedId}" was not found`);
        }
        return {
          providers: current.filter((entry) => entry.providerId !== trimmedId),
          value: undefined,
        };
      });
      await syncUserProviders(models, agentDir);
      notifyChange(trimmedId);
    },

    async listBaseCatalog() {
      const { models, definitions } = await readDefinitions();
      const credentials = await models.listCredentials();
      const byProvider = new Map<
        string,
        Array<ReturnType<ModelRuntime["getModels"]>[number]>
      >();
      for (const provider of models.getProviders()) {
        const definition = definitions.find(
          (entry) => entry.providerId === provider.id,
        );
        const authenticated = await hasUsableStoredAuthentication(
          models,
          provider.id,
          definition,
          credentials,
        );
        if (!authenticated) continue;
        const providerModels = models.getModels(provider.id);
        if (providerModels.length > 0) {
          byProvider.set(provider.id, [...providerModels]);
        }
      }
      return models
        .getProviders()
        .flatMap((provider) => {
          const providerModels = byProvider.get(provider.id);
          if (!providerModels?.length) return [];
          return [
            {
              id: provider.id,
              name: provider.name,
              models: providerModels.map((model) => ({
                id: model.id,
                name: modelCatalogName(model),
                thinkingLevels: getSupportedThinkingLevels(model),
              })),
            },
          ];
        });
    },

    async listCredentials() {
      const models = await getModelRuntime();
      const infos = await models.listCredentials();
      return infos.map((info) => ({ providerId: info.providerId, type: info.type }));
    },

    async setApiKeyCredential(providerId, apiKey) {
      const trimmedProvider = providerId.trim();
      const trimmedKey = apiKey.trim();
      if (!trimmedProvider) throw new Error("providerId is required");
      if (!trimmedKey) throw new Error("apiKey is required");

      const models = await getModelRuntime();
      const definitions = await providerStore.list();
      const definition = definitions.find(
        (entry) => entry.providerId === trimmedProvider,
      );
      if (definition?.authMode === "none") {
        throw new Error("This Provider does not use an API key");
      }
      const provider = models.getProvider(trimmedProvider);
      if (!provider) {
        throw new Error(`Unknown Provider: ${trimmedProvider}`);
      }
      if (!definition && !supportsSettingsApiKey(provider)) {
        throw new Error("This Provider's API-key flow is not supported in Settings");
      }
      const storedKey = literalCredentialValue(trimmedKey);
      try {
        await models.login(trimmedProvider, "api_key", {
          prompt: async (request) => {
            if (request.type === "secret") return storedKey;
            if (request.type === "select") {
              const apiKeyOption = request.options.find(
                (option) =>
                  /api[\s_-]*key/iu.test(option.id) ||
                  /api[\s_-]*key/iu.test(option.label),
              );
              if (apiKeyOption) return apiKeyOption.id;
            }
            throw new Error(
              "This Provider requires an authentication flow that Settings does not support",
            );
          },
          notify: () => {},
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          message
            .replaceAll(storedKey, "[redacted]")
            .replaceAll(trimmedKey, "[redacted]"),
        );
      }
      notifyChange(trimmedProvider);
      return { providerId: trimmedProvider, type: "api_key" };
    },

    async deleteCredential(providerId) {
      const trimmedProvider = providerId.trim();
      if (!trimmedProvider) throw new Error("providerId is required");
      const models = await getModelRuntime();
      await models.logout(trimmedProvider);
      notifyChange(trimmedProvider);
    },

    subscribeChanges(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
  };
}
