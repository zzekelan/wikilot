import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_APP_DEFAULTS } from "../../shared/settings";
import { createAppDefaultsStore } from "./app-defaults";

describe("AppDefaultsStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempAgentDir(): string {
    const root = mkdtempSync(join(tmpdir(), "wikilot-defaults-"));
    roots.push(root);
    return join(root, "agent");
  }

  it("starts without a Session Model default", () => {
    const store = createAppDefaultsStore({ agentDir: tempAgentDir() });
    expect(store.read()).toEqual(DEFAULT_APP_DEFAULTS);
    expect(store.read().sessionModel).toBeUndefined();
  });

  it("persists an atomic Model and Effort default across store instances", () => {
    const agentDir = tempAgentDir();
    const store = createAppDefaultsStore({ agentDir });

    const next = store.update({
      sessionModel: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingLevel: "max",
      },
      wikiPromptEnabled: false,
    });

    expect(next).toEqual({
      sessionModel: {
        provider: "deepseek",
        model: "deepseek-v4-flash",
        thinkingLevel: "max",
      },
      wikiPromptEnabled: false,
    });
    expect(createAppDefaultsStore({ agentDir }).read()).toEqual(next);
  });

  it("patches the Wiki default without changing the Session Model", () => {
    const store = createAppDefaultsStore({ agentDir: tempAgentDir() });
    store.update({
      sessionModel: {
        provider: "openai",
        model: "gpt-5.6",
        thinkingLevel: "high",
      },
    });

    const patched = store.update({ wikiPromptEnabled: false });
    expect(patched.sessionModel).toEqual({
      provider: "openai",
      model: "gpt-5.6",
      thinkingLevel: "high",
    });
    expect(patched.wikiPromptEnabled).toBe(false);
  });

  it("rejects an incomplete or unknown Session Model effort", () => {
    const store = createAppDefaultsStore({ agentDir: tempAgentDir() });
    expect(() =>
      store.update({
        sessionModel: {
          provider: "openai",
          model: "gpt-5.6",
          thinkingLevel: "galaxy" as never,
        },
      }),
    ).toThrow(/sessionModel/);
    expect(store.read()).toEqual(DEFAULT_APP_DEFAULTS);
  });

  it("tolerates a malformed file by falling back to defaults", () => {
    const agentDir = tempAgentDir();
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "defaults.json"), "{ not json", "utf8");

    const store = createAppDefaultsStore({ agentDir });
    expect(store.read()).toEqual(DEFAULT_APP_DEFAULTS);
  });
});
