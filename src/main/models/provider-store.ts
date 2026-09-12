import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { dirname } from "node:path";
import {
  assertKnownFields,
  type ProviderAuthMode,
  type ProviderInput,
  type ProviderModel,
  type ProviderProtocol,
  PROVIDER_MODEL_FIELDS,
} from "../../shared/settings/index.ts";
import { validateProviderInput } from "./provider-validation.ts";

type ProviderDocument = {
  providers: Record<string, Record<string, unknown>>;
};

type ProviderStoreMutation<T> = (providers: ProviderInput[]) => {
  providers: ProviderInput[];
  value: T;
};

const STORED_PROVIDER_FIELDS = [
  "name",
  "baseUrl",
  "api",
  "authMode",
  "models",
] as const;
const PROVIDER_DOCUMENT_FIELDS = ["providers"] as const;

export type ProviderStore = {
  list(): Promise<ProviderInput[]>;
  mutate<T>(mutation: ProviderStoreMutation<T>): Promise<T>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProvider(
  providerId: string,
  value: Record<string, unknown>,
): ProviderInput {
  try {
    assertKnownFields(
      value,
      STORED_PROVIDER_FIELDS,
      `Provider "${providerId}"`,
    );
    if (Array.isArray(value.models)) {
      value.models.forEach((model, index) => {
        if (isRecord(model)) {
          assertKnownFields(
            model,
            PROVIDER_MODEL_FIELDS,
            `Provider "${providerId}" model ${index}`,
          );
        }
      });
    }
    return validateProviderInput(
      {
        providerId,
        name: value.name as string,
        baseUrl: value.baseUrl as string,
        protocol: value.api as ProviderProtocol,
        authMode: value.authMode as ProviderAuthMode,
        models: value.models as ProviderModel[],
      },
      {
        builtInIds: [],
        existingIds: [],
      },
    );
  } catch (error) {
    const message = error instanceof Error ? `: ${error.message}` : "";
    throw new Error(
      `Invalid Provider configuration for "${providerId}"${message}`,
    );
  }
}

async function readProviders(modelsPath: string): Promise<ProviderInput[]> {
  let raw: string;
  try {
    raw = await readFile(modelsPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Unable to read Provider configuration");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Unable to parse Provider configuration");
  }
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new Error("Invalid Provider configuration");
  }
  assertKnownFields(parsed, PROVIDER_DOCUMENT_FIELDS, "Provider document");
  const providers = Object.entries(parsed.providers).map(([providerId, value]) => {
    if (!isRecord(value)) {
      throw new Error(`Invalid Provider configuration for "${providerId}"`);
    }
    return readProvider(providerId, value);
  });
  const ids = new Set<string>();
  for (const provider of providers) {
    const normalizedId = provider.providerId.toLowerCase();
    if (ids.has(normalizedId)) {
      throw new Error(`Invalid Provider configuration for "${provider.providerId}"`);
    }
    ids.add(normalizedId);
  }
  return providers;
}

function serializeModel(model: ProviderModel): Record<string, unknown> {
  return {
    id: model.id,
    ...(model.name !== undefined ? { name: model.name } : {}),
    ...(model.contextWindow !== undefined
      ? { contextWindow: model.contextWindow }
      : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: model.thinkingLevelMap }
      : {}),
    input: model.input,
  };
}

function serializeProviders(providers: ProviderInput[]): ProviderDocument {
  const entries = [...providers]
    .sort((left, right) => left.providerId.localeCompare(right.providerId))
    .map((provider) => [
      provider.providerId,
      {
        name: provider.name,
        baseUrl: provider.baseUrl,
        api: provider.protocol,
        authMode: provider.authMode,
        models: provider.models.map(serializeModel),
      },
    ] as const);
  return { providers: Object.fromEntries(entries) };
}

async function withFileLock<T>(
  modelsPath: string,
  task: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(modelsPath), { recursive: true });
  const release = await lockfile.lock(modelsPath, {
    realpath: false,
    stale: 30_000,
    retries: {
      retries: 10,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 10_000,
      randomize: true,
    },
  });
  try {
    return await task();
  } finally {
    await release();
  }
}

async function writeProviders(
  modelsPath: string,
  providers: ProviderInput[],
): Promise<void> {
  await mkdir(dirname(modelsPath), { recursive: true });
  const temporaryPath = `${modelsPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(serializeProviders(providers), null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryPath, modelsPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export function createProviderStore(modelsPath: string): ProviderStore {
  return {
    list() {
      return readProviders(modelsPath);
    },

    async mutate<T>(mutation: ProviderStoreMutation<T>): Promise<T> {
      return withFileLock(modelsPath, async () => {
        const current = await readProviders(modelsPath);
        const result = mutation(current);
        await writeProviders(modelsPath, result.providers);
        return result.value;
      });
    },
  };
}
