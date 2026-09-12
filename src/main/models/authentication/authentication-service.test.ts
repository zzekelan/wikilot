import { describe, expect, it, vi } from "vitest";
import { createProviderAuthentication } from "./authentication-service";

function runtimeFor(login: (interaction: any) => Promise<unknown>) {
  return {
    getProvider: () => ({ auth: { oauth: {}, apiKey: { login } } }),
    login: vi.fn(async (_provider: string, _type: string, interaction: any) => login(interaction)),
  } as any;
}

describe("ProviderAuthentication", () => {
  it("routes prompts and completion through the Authentication Session", async () => {
    let resolvePrompt!: (value: string) => void;
    const runtime = runtimeFor(async (interaction) => {
      const value = await interaction.prompt({ type: "secret", message: "Key" });
      expect(value).toBe("secret-value");
    });
    const service = createProviderAuthentication({ getRuntime: async () => runtime });
    const events: any[] = [];
    const { sessionId } = await service.start({ providerId: "demo", type: "api_key" });
    service.subscribe(sessionId, (event) => {
      events.push(event);
      if (event.type === "prompt") resolvePrompt = (value) => void service.respond(sessionId, event.promptId, value);
    });
    await vi.waitFor(() => expect(resolvePrompt).toBeTypeOf("function"));
    resolvePrompt("secret-value");
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("completed"));
    expect(events[0].prompt.type).toBe("secret");
  });

  it("redacts prompt values from failures", async () => {
    const runtime = runtimeFor(async (interaction) => {
      const value = await interaction.prompt({ type: "secret", message: "Key" });
      throw new Error(`bad key ${value}`);
    });
    const service = createProviderAuthentication({ getRuntime: async () => runtime });
    const events: any[] = [];
    const { sessionId } = await service.start({ providerId: "demo", type: "api_key" });
    service.subscribe(sessionId, (event) => {
      events.push(event);
      if (event.type === "prompt") void service.respond(sessionId, event.promptId, "secret-value");
    });
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("failed"));
    expect(events.at(-1).message).toContain("[redacted]");
  });
});


it("cancels a provider waiting for input even when it does not observe the session signal", async () => {
  const runtime = runtimeFor(async (interaction) => {
    await interaction.prompt({ type: "select", message: "Login method", options: [{ id: "browser", label: "Browser" }] });
  });
  const service = createProviderAuthentication({ getRuntime: async () => runtime });
  const events: any[] = [];
  const { sessionId } = await service.start({ providerId: "demo", type: "oauth" });
  service.subscribe(sessionId, (event) => events.push(event));
  await vi.waitFor(() => expect(events[0]?.type).toBe("prompt"));
  await service.cancel(sessionId);
  await vi.waitFor(() => expect(events.at(-1)?.type).toBe("cancelled"));
});
