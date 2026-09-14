/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { ProviderSummary } from "../../shared/settings";
import { ProviderSettingsSection } from "./ProviderSettingsSection";

const fake = vi.hoisted(() => ({
  client: {
    startAuthentication: vi.fn(),
    subscribeAuthentication: vi.fn(),
    cancelAuthentication: vi.fn(),
    respondAuthentication: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    setCredential: vi.fn(),
    deleteCredential: vi.fn(),
  },
}));

vi.mock("../client", () => ({ client: fake.client }));
vi.mock("../telemetry", () => ({ recordUiGesture: vi.fn() }));

function userProvider(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    providerId: "loopback",
    name: "Loopback",
    baseUrl: "http://127.0.0.1:43121/v1",
    protocol: "openai-completions",
    authMode: "none",
    models: [
      {
        id: "local-model",
        name: "Local Model",
        reasoning: false,
        input: ["text"],
      },
    ],
    source: "user",
    authenticated: true,
    supportsApiKey: false,
    ...overrides,
  };
}

const builtin = userProvider({
  providerId: "openai",
  name: "OpenAI",
  source: "builtin",
  authMode: "api_key",
  supportsApiKey: true,
  authenticated: false,
});

const oauthBuiltin = userProvider({
  providerId: "anthropic",
  name: "Anthropic",
  source: "builtin",
  authMode: "api_key",
  supportsApiKey: true,
  supportsOAuth: true,
  authenticated: true,
});

const unsupportedApiKeyBuiltin = userProvider({
  providerId: "amazon-bedrock",
  name: "Amazon Bedrock",
  source: "builtin",
  authMode: "api_key",
  supportsApiKey: false,
  authenticated: true,
});

function renderSection(
  providers: ProviderSummary[],
  credentials: Array<{ providerId: string; type: "api_key" | "oauth" }> = [],
  callbacks: Partial<Pick<ComponentProps<typeof ProviderSettingsSection>, "onError" | "onChanged">> = {},
) {
  return render(
    <ProviderSettingsSection
      providers={providers}
      credentials={credentials}
      busy={false}
      setBusy={vi.fn()}
      onChanged={vi.fn(async () => {})}
      onError={vi.fn()}
      onToast={vi.fn()}
      {...callbacks}
    />,
  );
}

function addCustomProvider() {
  fireEvent.click(screen.getByTestId("provider-add"));
  fireEvent.click(screen.getByTestId("provider-new"));
}

function selectProvider(id: string) {
  if (!screen.queryByTestId(`provider-row-${id}`)) fireEvent.click(screen.getByTestId("provider-add"));
  fireEvent.click(screen.getByTestId(`provider-row-${id}`));
}

beforeEach(() => {
  for (const mock of Object.values(fake.client)) mock.mockReset();
  fake.client.createProvider.mockResolvedValue(userProvider());
  fake.client.updateProvider.mockResolvedValue(userProvider({ name: "Updated" }));
  fake.client.setCredential.mockResolvedValue({
    providerId: "openai",
    type: "api_key",
  });
  fake.client.deleteCredential.mockResolvedValue(undefined);
  fake.client.deleteProvider.mockResolvedValue(undefined);
  fake.client.cancelAuthentication.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ProviderSettingsSection", () => {
  it("starts with an empty directory and opens custom creation through Add Provider", () => {
    renderSection([builtin]);

    expect(screen.getByTestId("provider-empty")).toBeTruthy();

    addCustomProvider();
    expect(screen.queryByTestId("provider-empty")).toBeNull();
    expect(screen.getByTestId("provider-form")).toBeTruthy();
  });

  it("keeps the Model editor focused while its ID changes", () => {
    renderSection([]);
    addCustomProvider();
    const modelId = screen.getByTestId("provider-model-id-0");
    modelId.focus();

    fireEvent.change(modelId, { target: { value: "l" } });

    expect(document.activeElement).toBe(modelId);
  });

  it("creates a User Provider and saves its API key from the same form", async () => {
    renderSection([builtin]);

    addCustomProvider();
    fireEvent.change(screen.getByTestId("provider-id"), {
      target: { value: "loopback" },
    });
    fireEvent.change(screen.getByTestId("provider-model-id-0"), {
      target: { value: "local-model" },
    });
    const keyInput = screen.getByLabelText("API key") as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    fireEvent.change(keyInput, { target: { value: "custom-secret" } });
    fireEvent.submit(screen.getByTestId("provider-form"));

    await waitFor(() =>
      expect(fake.client.createProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          providerId: "loopback",
          authMode: "api_key",
          models: [
            expect.objectContaining({
              id: "local-model",
              reasoning: false,
            }),
          ],
        }),
      ),
    );
    expect(fake.client.createProvider.mock.calls[0]?.[0].models[0]).not.toHaveProperty(
      "key",
    );
    expect(fake.client.createProvider.mock.calls[0]?.[0].models[0]).not.toHaveProperty(
      "thinkingLevels",
    );
    expect(fake.client.createProvider.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
    await waitFor(() => expect(fake.client.setCredential).toHaveBeenCalledWith({
      providerId: "loopback", apiKey: "custom-secret",
    }));
    await waitFor(() => expect(screen.queryByTestId("provider-form")).toBeNull());
  });

  it("discards the key when switching to no authentication", async () => {
    renderSection([]);
    addCustomProvider();
    fireEvent.change(screen.getByTestId("provider-draft-api-key"), { target: { value: "discarded-secret" } });
    fireEvent.change(screen.getByTestId("provider-auth-mode"), { target: { value: "none" } });
    expect(screen.queryByTestId("provider-draft-api-key")).toBeNull();
    fireEvent.change(screen.getByTestId("provider-auth-mode"), { target: { value: "api_key" } });
    expect((screen.getByTestId("provider-draft-api-key") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByTestId("provider-auth-mode"), { target: { value: "none" } });
    fireEvent.change(screen.getByTestId("provider-model-id-0"), { target: { value: "local-model" } });
    fireEvent.submit(screen.getByTestId("provider-form"));
    await waitFor(() => expect(screen.queryByTestId("provider-form")).toBeNull());
    expect(fake.client.createProvider).toHaveBeenCalledWith(expect.objectContaining({ authMode: "none" }));
    expect(fake.client.setCredential).not.toHaveBeenCalled();
  });

  it("retains input after a key save fails and retries without creating another Provider", async () => {
    const onError = vi.fn();
    fake.client.setCredential.mockRejectedValueOnce(new Error("Credential storage unavailable"));
    renderSection([], [], { onError });
    addCustomProvider();
    fireEvent.change(screen.getByTestId("provider-id"), { target: { value: "loopback" } });
    fireEvent.change(screen.getByTestId("provider-model-id-0"), { target: { value: "local-model" } });
    fireEvent.change(screen.getByTestId("provider-draft-api-key"), { target: { value: "retry-secret" } });
    fireEvent.submit(screen.getByTestId("provider-form"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("API key could not be saved")));
    expect((screen.getByTestId("provider-draft-api-key") as HTMLInputElement).value).toBe("retry-secret");
    expect((screen.getByTestId("provider-id") as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("provider-name"), { target: { value: "Revised name" } });
    fireEvent.submit(screen.getByTestId("provider-form"));
    await waitFor(() => expect(screen.queryByTestId("provider-form")).toBeNull());
    expect(fake.client.createProvider).toHaveBeenCalledTimes(1);
    expect(fake.client.updateProvider).toHaveBeenCalledWith("loopback", expect.objectContaining({ name: "Revised name" }));
    expect(fake.client.setCredential).toHaveBeenCalledTimes(2);
    expect(fake.client.setCredential).toHaveBeenLastCalledWith({ providerId: "loopback", apiKey: "retry-secret" });
  });

  it("retries a failed refresh without recreating the Provider or resending its saved key", async () => {
    const onError = vi.fn();
    const onChanged = vi.fn().mockRejectedValueOnce(new Error("Refresh unavailable")).mockResolvedValue(undefined);
    renderSection([], [], { onError, onChanged });
    addCustomProvider();
    fireEvent.change(screen.getByTestId("provider-id"), { target: { value: "loopback" } });
    fireEvent.change(screen.getByTestId("provider-model-id-0"), { target: { value: "local-model" } });
    fireEvent.change(screen.getByTestId("provider-draft-api-key"), { target: { value: "saved-secret" } });
    fireEvent.submit(screen.getByTestId("provider-form"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Refresh unavailable"));
    expect((screen.getByTestId("provider-draft-api-key") as HTMLInputElement).value).toBe("");
    fireEvent.submit(screen.getByTestId("provider-form"));
    await waitFor(() => expect(screen.queryByTestId("provider-form")).toBeNull());
    expect(fake.client.createProvider).toHaveBeenCalledTimes(1);
    expect(fake.client.updateProvider).toHaveBeenCalledTimes(1);
    expect(fake.client.setCredential).toHaveBeenCalledTimes(1);
  });

  it("keeps an existing Credential when configuration is saved with a blank key", async () => {
    renderSection([userProvider({ authMode: "api_key", supportsApiKey: true })], [{ providerId: "loopback", type: "api_key" }]);
    selectProvider("loopback");
    fireEvent.click(screen.getByTestId("provider-edit"));
    expect(screen.getByText("Leave blank to keep the saved credential.")).toBeTruthy();
    expect((screen.getByTestId("provider-draft-api-key") as HTMLInputElement).value).toBe("");
    fireEvent.submit(screen.getByTestId("provider-form"));
    await waitFor(() => expect(screen.queryByTestId("provider-form")).toBeNull());
    expect(fake.client.updateProvider).toHaveBeenCalledTimes(1);
    expect(fake.client.setCredential).not.toHaveBeenCalled();
    expect(fake.client.deleteCredential).not.toHaveBeenCalled();
  });

  it("discards a replacement key when leaving the configuration editor", () => {
    renderSection([userProvider({ authMode: "api_key", supportsApiKey: true })], [{ providerId: "loopback", type: "api_key" }]);
    selectProvider("loopback");
    fireEvent.click(screen.getByTestId("provider-edit"));
    fireEvent.change(screen.getByTestId("provider-draft-api-key"), { target: { value: "discarded-secret" } });
    fireEvent.click(screen.getByTestId("provider-back"));
    fireEvent.click(screen.getByRole("button", { name: "Change credential" }));
    expect((screen.getByTestId("provider-api-key-loopback") as HTMLInputElement).value).toBe("");
    expect(fake.client.setCredential).not.toHaveBeenCalled();
  });

  it("edits Supported Effort as Pi-native reasoning metadata", async () => {
    renderSection([]);
    addCustomProvider();
    fireEvent.change(screen.getByTestId("provider-id"), {
      target: { value: "selective" },
    });
    fireEvent.change(screen.getByTestId("provider-model-id-0"), {
      target: { value: "selective-model" },
    });
    fireEvent.click(screen.getByTestId("provider-model-thinking-high-0"));
    fireEvent.click(screen.getByTestId("provider-model-thinking-max-0"));
    fireEvent.submit(screen.getByTestId("provider-form"));

    await waitFor(() => expect(fake.client.createProvider).toHaveBeenCalled());
    expect(fake.client.createProvider.mock.calls[0]?.[0].models[0]).toEqual(
      expect.objectContaining({
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
      }),
    );
  });

  it("saves a Built-in API key without rendering it back", async () => {
    renderSection([builtin]);
    selectProvider("openai");
    fireEvent.change(screen.getByTestId("provider-api-key-openai"), {
      target: { value: "sk-secret" },
    });
    fireEvent.click(screen.getByTestId("provider-credential-save-openai"));

    await waitFor(() =>
      expect(fake.client.setCredential).toHaveBeenCalledWith({
        providerId: "openai",
        apiKey: "sk-secret",
      }),
    );
    expect(
      (screen.getByTestId("provider-api-key-openai") as HTMLInputElement).value,
    ).toBe("");
  });

  it("lets a dual-auth Provider switch from account login to an API key", () => {
    renderSection([oauthBuiltin], [
      { providerId: "anthropic", type: "oauth" },
    ]);
    selectProvider("anthropic");

    expect(screen.queryByTestId("provider-api-key-anthropic")).toBeNull();
    expect(screen.getByText("Credential saved · Account")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change credential" }));
    fireEvent.click(screen.getByRole("radio", { name: "API key / token" }));
    const input = screen.getByTestId("provider-api-key-anthropic") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "draft-key" } });
    expect(screen.queryByText("Credential saved · Account")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove credential" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard credential changes" }));
    expect(screen.queryByTestId("provider-api-key-anthropic")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change credential" }));
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change credential" }));
    expect((screen.getByTestId("provider-api-key-anthropic") as HTMLInputElement).value).toBe("");
  });

  it("allows removal of an existing unsupported API-key Credential", async () => {
    renderSection([unsupportedApiKeyBuiltin], [
      { providerId: "amazon-bedrock", type: "api_key" },
    ]);
    selectProvider("amazon-bedrock");

    expect(screen.queryByTestId("provider-api-key-amazon-bedrock")).toBeNull();
    fireEvent.click(screen.getByTestId("provider-credential-remove-amazon-bedrock"));

    await waitFor(() =>
      expect(fake.client.deleteCredential).toHaveBeenCalledWith("amazon-bedrock"),
    );
  });

  it("confirms User Provider deletion in the shared modal", async () => {
    renderSection([userProvider()]);
    selectProvider("loopback");
    fireEvent.click(screen.getByRole("button", { name: "Provider actions" }));
    fireEvent.click(screen.getByTestId("provider-delete"));

    expect(screen.getByRole("dialog", { name: "Delete User Provider loopback" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("provider-delete-confirm"));

    await waitFor(() =>
      expect(fake.client.deleteProvider).toHaveBeenCalledWith("loopback"),
    );
  });
});

it("connects before starting OAuth and retains authorization emitted before the start response", async () => {
  let receive: (event: unknown) => void;
  let connected: () => void;
  fake.client.subscribeAuthentication.mockImplementation((listener, ready) => {
    receive = listener;
    connected = ready;
    return vi.fn();
  });
  fake.client.startAuthentication.mockImplementation(async () => {
    receive({ type: "authentication_event", sessionId: "login", event: { type: "auth_url", url: "https://example.com/authorize" } });
    return { sessionId: "login" };
  });
  renderSection([userProvider({ providerId: "openai-codex", source: "builtin", authMode: undefined, supportsOAuth: true, authenticated: false })]);
  selectProvider("openai-codex");
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(fake.client.startAuthentication).not.toHaveBeenCalled();
  expect(connected!).toBeTypeOf("function");
  connected!();
  await waitFor(() => expect(screen.getByRole("link", { name: "Open sign-in page" }).getAttribute("href")).toBe("https://example.com/authorize"));
});

it("renders manual OAuth input without a browser dialog and sends the answer", async () => {
  fake.client.subscribeAuthentication.mockImplementation((listener, ready) => {
    queueMicrotask(ready);
    fake.client.startAuthentication.mockImplementation(async () => {
      listener({ type: "authentication_prompt", sessionId: "login", promptId: "code", prompt: { type: "manual_code", message: "Paste the redirect URL" } });
      return { sessionId: "login" };
    });
    return vi.fn();
  });
  fake.client.respondAuthentication.mockResolvedValue(undefined);
  fake.client.cancelAuthentication.mockResolvedValue(undefined);
  renderSection([userProvider({ providerId: "openai-codex", source: "builtin", authMode: undefined, supportsOAuth: true, authenticated: false })]);
  selectProvider("openai-codex");
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  fireEvent.change(await screen.findByLabelText("Paste the redirect URL"), { target: { value: "redirect-code" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(fake.client.respondAuthentication).toHaveBeenCalledWith({ sessionId: "login", promptId: "code", value: "redirect-code" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(fake.client.cancelAuthentication).toHaveBeenCalledWith({ sessionId: "login" });
});

it("handles a failure emitted before the start response and closes the subscription", async () => {
  const stop = vi.fn();
  fake.client.subscribeAuthentication.mockImplementation((listener, ready) => {
    queueMicrotask(ready);
    fake.client.startAuthentication.mockImplementation(async () => {
      listener({ type: "authentication_failed", sessionId: "login", message: "Login unavailable" });
      return { sessionId: "login" };
    });
    return stop;
  });
  renderSection([userProvider({ providerId: "openai-codex", source: "builtin", authMode: undefined, supportsOAuth: true, authenticated: false })]);
  selectProvider("openai-codex");
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(stop).toHaveBeenCalled());
  expect(screen.queryByRole("button", { name: "Cancel sign-in" })).toBeNull();
});

it("keeps added services on the home page and discovers unused services separately", () => {
  renderSection([
    builtin,
    userProvider({ providerId: "zulu", name: "Zulu", authMode: "api_key", authenticated: false }),
    userProvider({ providerId: "alpha", name: "Alpha", authMode: "none" }),
    userProvider({ providerId: "unfinished", name: "Unfinished", authMode: "api_key" }),
  ], [{ providerId: "zulu", type: "api_key" }]);
  expect([...screen.getByTestId("provider-list").querySelectorAll("strong")].map((node) => node.textContent)).toEqual(["Alpha", "Unfinished", "Zulu"]);
  expect(screen.queryByTestId("provider-detail")).toBeNull();
  expect(screen.queryByTestId("provider-row-openai")).toBeNull();
  selectProvider("alpha");
  expect(screen.getByTestId("provider-detail").textContent).toContain("No authentication required");
  fireEvent.click(screen.getByTestId("provider-back"));
  fireEvent.click(screen.getByTestId("provider-add"));
  fireEvent.change(screen.getByTestId("provider-filter"), { target: { value: "openai" } });
  expect(screen.queryByTestId("provider-row-zulu")).toBeNull();
  expect(screen.getByTestId("provider-row-openai")).toBeTruthy();
});

it("opens custom details before editing and discards cancelled changes", () => {
  renderSection([builtin, userProvider()]);
  selectProvider("loopback");
  expect(screen.getByTestId("provider-detail")).toBeTruthy();
  expect(screen.queryByTestId("provider-form")).toBeNull();
  expect(screen.getByText(/Supported models/).closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByTestId("provider-edit"));
  fireEvent.change(screen.getByTestId("provider-name"), { target: { value: "Unsaved" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByTestId("provider-form")).toBeNull();
  fireEvent.click(screen.getByTestId("provider-edit"));
  expect((screen.getByTestId("provider-name") as HTMLInputElement).value).toBe("Loopback");
  expect(fake.client.updateProvider).not.toHaveBeenCalled();
});

it("offers both authentication methods when no credential is configured", () => {
  renderSection([oauthBuiltin]);
  selectProvider("anthropic");
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "API key / token" }));
  expect(screen.getByTestId("provider-api-key-anthropic")).toBeTruthy();
});

it("replaces credential management with one authentication step and restores it on cancellation", async () => {
  let receive: (event: unknown) => void = () => {};
  fake.client.subscribeAuthentication.mockImplementation((listener, ready) => {
    receive = listener;
    queueMicrotask(ready);
    return vi.fn();
  });
  fake.client.startAuthentication.mockImplementation(async () => {
    receive({ type: "authentication_prompt", sessionId: "login", promptId: "method", prompt: {
      type: "select", message: "Choose a login method", options: [{ id: "browser", label: "Browser login" }, { id: "device", label: "Device code" }],
    } });
    return { sessionId: "login" };
  });
  fake.client.respondAuthentication.mockImplementation(async () => {
    receive({ type: "authentication_event", sessionId: "login", event: { type: "auth_url", url: "https://example.com/authorize" } });
  });
  fake.client.cancelAuthentication.mockImplementation(async () => {
    receive({ type: "authentication_cancelled", sessionId: "login" });
  });
  renderSection([{ ...oauthBuiltin, supportsApiKey: false }], [{ providerId: "anthropic", type: "oauth" }]);
  selectProvider("anthropic");
  expect(screen.queryByRole("button", { name: "Change credential" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
  const choice = await screen.findByRole("combobox", { name: "Choose a login method" });
  expect(screen.getAllByRole("heading", { name: "Authentication" })).toHaveLength(1);
  expect(screen.queryByText("Waiting for sign-in…")).toBeNull();
  expect(screen.queryByText("Credential saved · Account")).toBeNull();
  expect(screen.queryByRole("button", { name: "Remove credential" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Cancel$/ })).toBeNull();
  fireEvent.change(choice, { target: { value: "device" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("link", { name: "Open sign-in page" });
  expect(fake.client.respondAuthentication).toHaveBeenCalledWith({ sessionId: "login", promptId: "method", value: "device" });
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  await screen.findByRole("button", { name: "Sign in again" });
  expect(screen.getByText("Credential saved · Account")).toBeTruthy();
  expect(fake.client.deleteCredential).not.toHaveBeenCalled();
});

it("presents browser sign-in as the primary path with optional manual submission", async () => {
  fake.client.subscribeAuthentication.mockImplementation((listener, ready) => {
    queueMicrotask(ready);
    fake.client.startAuthentication.mockImplementation(async () => {
      listener({ type: "authentication_event", sessionId: "login", event: { type: "auth_url", url: "https://example.com/authorize" } });
      listener({ type: "authentication_prompt", sessionId: "login", promptId: "code", prompt: { type: "manual_code", message: "Complete sign-in or enter a code" } });
      return { sessionId: "login" };
    });
    return vi.fn();
  });
  fake.client.respondAuthentication.mockResolvedValue(undefined);
  renderSection([oauthBuiltin]);
  selectProvider("anthropic");
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("link", { name: "Open sign-in page" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  fireEvent.click(screen.getByText("Use an authorization code or redirect URL"));
  const input = screen.getByRole("textbox", { name: "Authorization code or redirect URL" });
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: "manual-code" } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(fake.client.respondAuthentication).toHaveBeenCalledWith({ sessionId: "login", promptId: "code", value: "manual-code" }));
});


it("focuses the new Model ID when adding a Model below existing fields", () => {
  renderSection([userProvider()]);
  selectProvider("loopback");
  fireEvent.click(screen.getByTestId("provider-edit"));
  fireEvent.click(screen.getByTestId("provider-model-add"));
  expect(document.activeElement).toBe(screen.getByTestId("provider-model-id-1"));
});
