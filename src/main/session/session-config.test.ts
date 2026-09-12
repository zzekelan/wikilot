import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSessionConfig,
} from "./session-config";
import {
  sessionConfigEntryData,
  WIKILOT_SESSION_ENTRY_TYPE,
} from "../../shared/workspace";

describe("durable Session configuration snapshot (wikilot.session entry)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempSessionManager(): SessionManager {
    const root = mkdtempSync(join(tmpdir(), "wikilot-session-config-"));
    roots.push(root);
    const cwd = join(root, "notes");
    mkdirSync(cwd, { recursive: true });
    return SessionManager.create(cwd, join(root, "sessions"));
  }

  it("reads the requested Session configuration from a Wikilot entry", () => {
    const sessionManager = tempSessionManager();
    sessionManager.appendCustomEntry(
      WIKILOT_SESSION_ENTRY_TYPE,
      {
        origin: "wikilot",
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "high",
        wikiPromptEnabled: false,
      },
    );

    expect(readSessionConfig(sessionManager)).toEqual({
      provider: "openai",
      model: "gpt-4.1",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
  });

  it("omits undefined fields so callers can fall back to App Defaults", () => {
    const sessionManager = tempSessionManager();
    sessionManager.appendCustomEntry(
      WIKILOT_SESSION_ENTRY_TYPE,
      sessionConfigEntryData({ wikiPromptEnabled: true }),
    );

    expect(readSessionConfig(sessionManager)).toEqual({
      provider: undefined,
      model: undefined,
      thinkingLevel: undefined,
      wikiPromptEnabled: true,
    });
  });

  it("returns an empty snapshot for Sessions predating configuration entries", () => {
    expect(readSessionConfig(tempSessionManager())).toEqual({});
  });

  it("uses Pi-native values when the Wikilot entry omits requested values", () => {
    const sessionManager = tempSessionManager();
    sessionManager.appendModelChange("anthropic", "claude-sonnet-4-5");
    sessionManager.appendThinkingLevelChange("high");
    sessionManager.appendCustomEntry(
      WIKILOT_SESSION_ENTRY_TYPE,
      sessionConfigEntryData({ wikiPromptEnabled: false }),
    );

    expect(readSessionConfig(sessionManager)).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });
  });
});
