/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";

const fake = vi.hoisted(() => ({
  client: { listProviders: vi.fn(), listCredentials: vi.fn(), getAppDefaults: vi.fn(), updateAppDefaults: vi.fn() },
  gesture: vi.fn(),
}));
vi.mock("../client", () => ({ client: fake.client }));
vi.mock("../telemetry", () => ({ recordUiGesture: fake.gesture }));
vi.mock("./theme", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
beforeEach(() => {
  vi.clearAllMocks();
  fake.client.listProviders.mockResolvedValue([]);
  fake.client.listCredentials.mockResolvedValue([]);
  fake.client.getAppDefaults.mockResolvedValue({ wikiPromptEnabled: true });
});
afterEach(cleanup);

it("saves a new-Session preference immediately and reports the persisted value", async () => {
  fake.client.updateAppDefaults.mockResolvedValue({ wikiPromptEnabled: false });
  render(<SettingsPanel open onClose={vi.fn()} />);
  const toggle = screen.getByRole("switch", { name: "LLM Wiki Prompt" }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  await waitFor(() => expect(fake.client.updateAppDefaults).toHaveBeenCalledWith({ wikiPromptEnabled: false }));
  expect(toggle.checked).toBe(false);
  await waitFor(() => expect(fake.gesture).toHaveBeenCalledWith("defaults.save", expect.objectContaining({ "wikilot.wiki.enabled": "false" })));
});

it("restores the preference if saving fails and lets the user retry", async () => {
  fake.client.updateAppDefaults.mockRejectedValueOnce(new Error("Could not save"));
  render(<SettingsPanel open onClose={vi.fn()} />);
  const toggle = screen.getByRole("switch", { name: "LLM Wiki Prompt" }) as HTMLInputElement;
  await waitFor(() => expect(toggle.disabled).toBe(false));
  fireEvent.click(toggle);
  await screen.findByRole("alert");
  expect(toggle.checked).toBe(true);
  expect(toggle.disabled).toBe(false);
  expect(fake.gesture).not.toHaveBeenCalled();
  fake.client.updateAppDefaults.mockResolvedValueOnce({ wikiPromptEnabled: false });
  fireEvent.click(toggle);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(toggle.checked).toBe(false);
});


it("returns to the Providers directory when its category is selected again", async () => {
  render(<SettingsPanel open onClose={vi.fn()} />);
  await waitFor(() => expect(fake.client.listProviders).toHaveBeenCalled());
  fireEvent.click(screen.getByTestId("settings-section-providers"));
  fireEvent.click(screen.getByTestId("provider-add"));
  fireEvent.click(screen.getByTestId("provider-new"));
  expect(screen.getByTestId("provider-form")).toBeTruthy();
  fireEvent.click(screen.getByTestId("settings-section-providers"));
  expect(screen.queryByTestId("provider-form")).toBeNull();
  expect(screen.getByTestId("provider-add")).toBeTruthy();
});
