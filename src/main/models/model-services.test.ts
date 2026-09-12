import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelServices } from "./model-services";
import type { ProviderInput } from "../../shared/settings";

describe("ModelServices (Pi CredentialStore + Base Model Catalog)", () => {
  const roots: string[] = [];

  beforeEach(() => {
    // Keep Pi's online catalog/availability refresh out of unit tests;
    // credential and catalog behavior under test is file-backed either way.
    vi.stubEnv("PI_OFFLINE", "1");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempAgentDir(): string {
    const root = mkdtempSync(join(tmpdir(), "wikilot-models-"));
    roots.push(root);
    return join(root, "agent");
  }

  function providerInput(
    providerId: string,
    overrides: Partial<ProviderInput> = {},
  ): ProviderInput {
    return {
      providerId,
      name: "Loopback Provider",
      baseUrl: "http://127.0.0.1:43121/v1",
      protocol: "openai-completions",
      authMode: "none",
      models: [
        {
          id: "loopback-model",
          name: "Loopback Model",
          reasoning: false,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 4_096,
        },
      ],
      ...overrides,
    };
  }

  it("notifies Runtime owners after Provider and Credential mutations", { timeout: 30_000 }, async () => {
    const services = createModelServices({ agentDir: tempAgentDir() });
    const changes: string[] = [];
    const unsubscribe = services.subscribeChanges((providerId) => {
      changes.push(providerId);
    });

    await services.createProvider(providerInput("refresh-me"));
    await services.updateProvider("refresh-me", {
      ...providerInput("refresh-me"),
      name: "Updated Provider",
    });
    await services.setApiKeyCredential("openai", "sk-refresh");
    await services.deleteCredential("openai");
    await services.deleteProvider("refresh-me");
    unsubscribe();

    expect(changes).toEqual([
      "refresh-me",
      "refresh-me",
      "openai",
      "openai",
      "refresh-me",
    ]);
  });

  it("lists a serializable Base Model Catalog from Pi built-ins", { timeout: 30_000 }, async () => {
    const services = createModelServices({ agentDir: tempAgentDir() });
    await services.setApiKeyCredential("openai", "sk-catalog-test");
    await services.setApiKeyCredential("deepseek", "sk-deepseek-catalog-test");

    const catalog = await services.listBaseCatalog();

    expect(catalog.length).toBeGreaterThan(0);
    const openai = catalog.find((provider) => provider.id === "openai");
    expect(openai?.models.length).toBeGreaterThan(0);
    expect(
      catalog
        .find((provider) => provider.id === "deepseek")
        ?.models.find((model) => model.id === "deepseek-v4-flash")
        ?.thinkingLevels,
    ).toEqual(["off", "low", "high", "max"]);
    // Fully serializable — no ModelRuntime objects cross the boundary.
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog);
  });

  it("persists Credentials under the Wikilot Agent dir and lists metadata only", { timeout: 30_000 }, async () => {
    const agentDir = tempAgentDir();
    const services = createModelServices({ agentDir });

    const saved = await services.setApiKeyCredential("openai", "sk-secret-1");

    expect(saved).toEqual({ providerId: "openai", type: "api_key" });
    expect(await services.listCredentials()).toEqual([
      { providerId: "openai", type: "api_key" },
    ]);
    // The plaintext lives only in Pi's file store under the Wikilot Agent dir.
    const authFile = readFileSync(join(agentDir, "auth.json"), "utf8");
    expect(authFile).toContain("sk-secret-1");
    const listed = await services.listCredentials();
    expect(JSON.stringify(listed)).not.toContain("sk-secret-1");
  });

  it("shares Credentials across independent service instances (file-backed store)", { timeout: 30_000 }, async () => {
    const agentDir = tempAgentDir();
    await createModelServices({ agentDir }).setApiKeyCredential(
      "anthropic",
      "sk-ant-secret",
    );

    // A second instance (what another process would see) lists the Credential.
    const other = createModelServices({ agentDir });
    expect(await other.listCredentials()).toEqual([
      { providerId: "anthropic", type: "api_key" },
    ]);
  });

  it("deletes a Credential", { timeout: 30_000 }, async () => {
    const agentDir = tempAgentDir();
    const services = createModelServices({ agentDir });
    await services.setApiKeyCredential("openai", "sk-secret-1");

    await services.deleteCredential("openai");

    expect(await services.listCredentials()).toEqual([]);
  });

  it("does not let ambient credentials keep a removed Provider executable", { timeout: 30_000 }, async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-test-key";
    try {
      const services = createModelServices({ agentDir: tempAgentDir() });
      await services.setApiKeyCredential("openai", "stored-test-key");
      expect((await services.listBaseCatalog()).some((entry) => entry.id === "openai")).toBe(true);

      await services.deleteCredential("openai");

      expect((await services.listBaseCatalog()).some((entry) => entry.id === "openai")).toBe(false);
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("supports Built-in API-key login flows with an API-key selector", { timeout: 30_000 }, async () => {
    const services = createModelServices({ agentDir: tempAgentDir() });

    await services.setApiKeyCredential("google-vertex", "vertex-test-key");

    expect(await services.listCredentials()).toContainEqual({
      providerId: "google-vertex",
      type: "api_key",
    });
  });

  it("loads online catalog models after saving a Built-in Credential", { timeout: 30_000 }, async () => {
    delete process.env.PI_OFFLINE;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "https://pi.dev/api/models/providers/deepseek") {
        return Response.json({ models: [{
          id: "deepseek-flash",
          name: "DeepSeek V4.1 Flash",
          api: "openai-completions",
          provider: "deepseek",
          baseUrl: "https://api.deepseek.com",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 384_000,
        }] }, { headers: { "last-modified": "Thu, 01 Jan 2099 00:00:00 GMT" } });
      }
      return new Response(null, { status: 404 });
    });
    try {
      const services = createModelServices({ agentDir: tempAgentDir() });
      await services.setApiKeyCredential("deepseek", "catalog-test-key");

      const catalog = await services.listBaseCatalog();
      expect(catalog.find((provider) => provider.id === "deepseek")?.models)
        .toEqual(expect.arrayContaining([expect.objectContaining({
          id: "deepseek-flash",
          name: "DeepSeek V4.1 Flash",
        })]));
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("stores API-key input as literal Credential values", { timeout: 30_000 }, async () => {
    const agentDir = tempAgentDir();
    const marker = join(agentDir, "command-ran");
    const services = createModelServices({ agentDir });
    const cases = [
      [`!touch ${marker}`, `$!touch ${marker}`],
      ["$OPENAI_API_KEY", "$$OPENAI_API_KEY"],
      ["${OPENAI_API_KEY}", "$${OPENAI_API_KEY}"],
      ["literal$!value", "literal$$!value"],
    ] as const;

    for (const [apiKey, storedKey] of cases) {
      await services.setApiKeyCredential("openai", apiKey);
      const auth = JSON.parse(
        readFileSync(join(agentDir, "auth.json"), "utf8"),
      ) as { openai?: { key?: string } };
      expect(auth.openai?.key).toBe(storedKey);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("lists non-OAuth Built-ins even when Settings cannot configure their auth", { timeout: 30_000 }, async () => {
    const services = createModelServices({ agentDir: tempAgentDir() });
    const providers = await services.listProviders();

    for (const providerId of [
      "amazon-bedrock",
      "cloudflare-workers-ai",
      "cloudflare-ai-gateway",
    ]) {
      expect(providers).toContainEqual(
        expect.objectContaining({
          providerId,
          source: "builtin",
          authenticated: false,
          supportsApiKey: false,
        }),
      );
    }
  });

  it("rejects empty credential fields", async () => {
    const services = createModelServices({ agentDir: tempAgentDir() });
    await expect(
      services.setApiKeyCredential(" ", "sk-secret-1"),
    ).rejects.toThrow(/providerId/);
    await expect(
      services.setApiKeyCredential("openai", " "),
    ).rejects.toThrow(/apiKey/);
  });

  it("rejects incomplete persisted Provider documents", async () => {
    const agentDir = tempAgentDir();
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          broken: {
            name: "Broken Provider",
            baseUrl: "http://127.0.0.1:43121/v1",
            api: "openai-completions",
            authMode: "api_key",
            models: [{ id: "broken-model" }],
          },
        },
      }),
    );

    await expect(
      createModelServices({ agentDir }).listProviders(),
    ).rejects.toThrow(/Invalid Provider configuration/);
  });

  it("reads Pi-native reasoning metadata from persisted User Providers", async () => {
    const agentDir = tempAgentDir();
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          loopback: {
            name: "Loopback Provider",
            baseUrl: "http://127.0.0.1:43121/v1",
            api: "openai-completions",
            authMode: "none",
            models: [
              {
                id: "loopback-model",
                reasoning: true,
                input: ["text"],
              },
            ],
          },
        },
      }),
    );

    const services = createModelServices({ agentDir });
    expect(await services.listProviders()).toContainEqual(
      expect.objectContaining({
        providerId: "loopback",
        models: [
          expect.objectContaining({
            id: "loopback-model",
            reasoning: true,
          }),
        ],
      }),
    );
    expect(await services.listBaseCatalog()).toContainEqual(
      expect.objectContaining({
        id: "loopback",
        models: [
          expect.objectContaining({
            id: "loopback-model",
            thinkingLevels: ["off", "minimal", "low", "medium", "high"],
          }),
        ],
      }),
    );
  });

  it("rejects unsupported persisted Provider fields", async () => {
    const validProvider = {
      name: "Loopback Provider",
      baseUrl: "http://127.0.0.1:43121/v1",
      api: "openai-completions",
      authMode: "none",
      models: [{ id: "loopback-model", reasoning: false, input: ["text"] }],
    };
    const documents = [
      {
        providers: {
          legacy: { ...validProvider, apiKey: "legacy-secret" },
        },
      },
      {
        providers: {
          legacy: {
            ...validProvider,
            models: [{ ...validProvider.models[0], cost: { input: 1 } }],
          },
        },
      },
      {
        providers: {
          legacy: {
            ...validProvider,
            models: [
              {
                id: "loopback-model",
                thinkingLevels: ["off"],
                input: ["text"],
              },
            ],
          },
        },
      },
      {
        providers: { legacy: validProvider },
        metadata: { version: 1 },
      },
    ];

    for (const document of documents) {
      const agentDir = tempAgentDir();
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "models.json"), JSON.stringify(document));

      await expect(
        createModelServices({ agentDir }).listProviders(),
      ).rejects.toThrow(/unsupported field/);
    }
  });

  it("rejects persisted Built-in Provider identities", async () => {
    const agentDir = tempAgentDir();
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            name: "Replacement OpenAI",
            baseUrl: "http://127.0.0.1:43121/v1",
            api: "openai-completions",
            authMode: "none",
            models: [
              {
                id: "replacement-model",
                reasoning: false,
                input: ["text"],
              },
            ],
          },
        },
      }),
    );

    await expect(
      createModelServices({ agentDir }).listProviders(),
    ).rejects.toThrow(/Built-in Provider/);
  });

  it("removes OAuth credentials while preserving the Provider definition", { timeout: 30_000 }, async () => {
    const agentDir = tempAgentDir();
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, "auth.json"),
      JSON.stringify({
        anthropic: {
          type: "oauth",
          refresh: "refresh-token",
          access: "access-token",
          expires: Date.now() + 3_600_000,
        },
      }),
    );
    const services = createModelServices({ agentDir });

    const providers = await services.listProviders();
    expect(providers).toContainEqual(
      expect.objectContaining({
        providerId: "anthropic",
        authenticated: true,
      }),
    );
    expect(providers.find((provider) => provider.providerId === "anthropic")).not.toHaveProperty(
      "credential",
    );
    await services.deleteCredential("anthropic");
    expect(await services.listCredentials()).not.toContainEqual(expect.objectContaining({ providerId: "anthropic" }));
    expect((await services.listProviders()).some((provider) => provider.providerId === "anthropic")).toBe(true);
    expect(JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"))).not.toHaveProperty("anthropic");
  });

  it("replaces an OAuth credential with an API key through the supported login adapter", async () => {
    const agentDir = tempAgentDir();
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      anthropic: { type: "oauth", refresh: "old-refresh", access: "old-access", expires: Date.now() + 3_600_000 },
    }));
    const services = createModelServices({ agentDir });
    await services.setApiKeyCredential("anthropic", "replacement-key");
    expect(await services.listCredentials()).toContainEqual({ providerId: "anthropic", type: "api_key" });
    const stored = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    expect(stored.anthropic).toEqual({ type: "api_key", key: "replacement-key" });
  });

  it("validates User Provider fields through the public service", async () => {
    const services = createModelServices({ agentDir: tempAgentDir() });

    await expect(
      services.createProvider(providerInput(" ")),
    ).rejects.toThrow(/providerId/);
    await expect(
      services.createProvider(
        providerInput("invalid-url", { baseUrl: "localhost" }),
      ),
    ).rejects.toThrow(/baseUrl/);
    await expect(
      services.createProvider(
        providerInput("url-credentials", {
          baseUrl: "https://user:secret@example.com/v1",
        }),
      ),
    ).rejects.toThrow(/URL credentials/);
    await expect(
      services.createProvider(
        providerInput("url-query", {
          baseUrl: "https://example.com/v1?api_key=secret",
        }),
      ),
    ).rejects.toThrow(/query parameters/);
    await expect(
      services.createProvider(
        providerInput("url-fragment", {
          baseUrl: "https://example.com/v1#api-key=secret",
        }),
      ),
    ).rejects.toThrow(/query parameters or fragments/);
    await expect(
      services.createProvider(
        providerInput("invalid-protocol", { protocol: "unknown" as never }),
      ),
    ).rejects.toThrow(/protocol/);
    await expect(
      services.createProvider(
        providerInput("invalid-auth", { authMode: "oauth" as never }),
      ),
    ).rejects.toThrow(/authMode/);
    await expect(
      services.createProvider(providerInput("missing-models", { models: [] })),
    ).rejects.toThrow(/At least one Model/);
    await expect(
      services.createProvider(
        providerInput("invalid-effort", {
          models: [{
            ...providerInput("unused").models[0]!,
            reasoning: true,
            thinkingLevelMap: { galaxy: "galaxy" } as never,
          }],
        }),
      ),
    ).rejects.toThrow(/thinkingLevelMap/);
    await expect(
      services.createProvider(
        providerInput("duplicate-models", {
          models: [
            providerInput("unused").models[0]!,
            { ...providerInput("unused").models[0]! },
          ],
        }),
      ),
    ).rejects.toThrow(/Duplicate Model ID/);
  });

  it("manages User Providers and keeps their definitions separate from Credentials", { timeout: 30_000 }, async () => {
    const agentDir = tempAgentDir();
    const services = createModelServices({ agentDir });
    const created = await services.createProvider(providerInput("loopback"));

    expect(created).toMatchObject({
      providerId: "loopback",
      source: "user",
      authMode: "none",
      authenticated: true,
    });
    expect(await services.listCredentials()).toEqual([]);
    expect((await services.listBaseCatalog()).find((entry) => entry.id === "loopback"))
      .toMatchObject({ models: [{ id: "loopback-model" }] });

    const config = readFileSync(join(agentDir, "models.json"), "utf8");
    expect(config).toContain('"authMode": "none"');
    expect(config).toContain('"reasoning": false');
    expect(config).not.toContain("thinkingLevels");
    expect(config).not.toContain("sk-secret");

    const apiKeyProvider = await services.createProvider(
      providerInput("loopback-key", { authMode: "api_key" }),
    );
    expect(apiKeyProvider.authenticated).toBe(false);
    expect(
      (await services.listBaseCatalog()).some((entry) => entry.id === "loopback-key"),
    ).toBe(false);

    await services.setApiKeyCredential("loopback-key", "sk-secret");
    expect(
      (await services.listBaseCatalog()).some((entry) => entry.id === "loopback-key"),
    ).toBe(true);
    expect(readFileSync(join(agentDir, "models.json"), "utf8")).not.toContain(
      "sk-secret",
    );
    expect(JSON.stringify(await services.listProviders())).not.toContain("sk-secret");

    await services.deleteCredential("loopback-key");
    expect(
      (await services.listBaseCatalog()).some((entry) => entry.id === "loopback-key"),
    ).toBe(false);
    expect(
      (await services.listProviders()).find((entry) => entry.providerId === "loopback-key"),
    ).toMatchObject({ source: "user", authenticated: false });
  });

  it("round-trips exact Thinking Levels through Pi-native model metadata", async () => {
    const agentDir = tempAgentDir();
    const services = createModelServices({ agentDir });
    await services.createProvider(
      providerInput("selective-thinking", {
        models: [
          {
            ...providerInput("unused").models[0]!,
            reasoning: true,
            thinkingLevelMap: {
              off: "off",
              minimal: null,
              low: null,
              medium: null,
              high: "high",
              xhigh: null,
              max: "max",
            },
          },
        ],
      }),
    );

    const stored = JSON.parse(
      readFileSync(join(agentDir, "models.json"), "utf8"),
    ) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    expect(stored.providers["selective-thinking"]?.models[0]).toMatchObject({
      reasoning: true,
      thinkingLevelMap: {
        off: "off",
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
    });
    const restored = await createModelServices({ agentDir }).listProviders();
    expect(
      restored.find((provider) => provider.providerId === "selective-thinking")
        ?.models[0],
    ).toMatchObject({
      reasoning: true,
      thinkingLevelMap: {
        off: "off",
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
    });
    expect(
      (await createModelServices({ agentDir }).listBaseCatalog())
        .find((provider) => provider.id === "selective-thinking")
        ?.models[0]?.thinkingLevels,
    ).toEqual(["off", "high", "max"]);
  });

  it("serializes concurrent Provider writes across independent service instances", { timeout: 30_000 }, async () => {
    const agentDir = tempAgentDir();
    const left = createModelServices({ agentDir });
    const right = createModelServices({ agentDir });

    await Promise.all([
      left.createProvider(providerInput("left")),
      right.createProvider(providerInput("right")),
    ]);

    const providers = await createModelServices({ agentDir }).listProviders();
    expect(providers.map((provider) => provider.providerId)).toEqual(
      expect.arrayContaining(["left", "right"]),
    );
  });

  it("enforces User Provider identity rules and cross-instance persistence", { timeout: 30_000 }, async () => {
    const agentDir = tempAgentDir();
    const services = createModelServices({ agentDir });
    await services.createProvider(providerInput("persistent"));

    const other = createModelServices({ agentDir });
    expect(
      (await other.listProviders()).find((entry) => entry.providerId === "persistent"),
    ).toMatchObject({ source: "user", authMode: "none" });

    await expect(
      services.createProvider(providerInput("openai")),
    ).rejects.toThrow(/Built-in Provider identifier/i);
    await expect(
      services.createProvider(providerInput("persistent")),
    ).rejects.toThrow(/already in use/i);
    await expect(
      services.createProvider(providerInput("bad id")),
    ).rejects.toThrow(/providerId/i);
    await expect(
      services.updateProvider(
        "persistent",
        providerInput("renamed"),
      ),
    ).rejects.toThrow(/identity cannot be changed/i);

    await services.updateProvider(
      "persistent",
      providerInput("persistent", { name: "Updated Provider" }),
    );
    expect(
      (await other.listProviders()).find((entry) => entry.providerId === "persistent"),
    ).toMatchObject({ name: "Updated Provider" });

    await services.deleteProvider("persistent");
    expect(
      (await other.listProviders()).some((entry) => entry.providerId === "persistent"),
    ).toBe(false);
  });
});
