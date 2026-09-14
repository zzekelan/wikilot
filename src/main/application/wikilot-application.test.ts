import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderInput } from "../../shared/settings";
import type { TimelineDeltaEvent } from "../../shared/timeline";
import {
  initialWorkspacePaneState,
  openWorkspacePaneTab,
  setWorkspacePanePosition,
} from "../../shared/workspace";
import { encodeAbsoluteCwd } from "../workspace";
import {
  createWikilotApplication,
  type WikilotApplication,
} from "./wikilot-application";

describe("WikilotApplication (transport-neutral boundary)", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "wikilot-app-"));
    roots.push(root);
    return root;
  }

  function setup(): { app: WikilotApplication; sessionsRoot: string } {
    const root = tempRoot();
    const sessionsRoot = join(root, "sessions");
    return {
      app: createWikilotApplication({
        sessionsRoot,
        agentDir: join(root, "agent"),
      }),
      sessionsRoot,
    };
  }

  it("validates Utility Model settings at the application boundary before persisting", async () => {
    const { app } = setup();
    try {
      const selection = { model: { provider: "provider", model: "model", thinkingLevel: "off" } };
      expect(app.updateUtilitySettings(selection)).toEqual(selection);
      for (const input of [null, [], {}, { model: {} }, { model: { provider: "provider" } },
        { model: { provider: " ", model: "model" } }, { model: null, extra: true }]) {
        expect(() => app.updateUtilitySettings(input)).toThrow();
        expect(app.getUtilitySettings()).toEqual(selection);
      }
      expect(app.updateUtilitySettings({ model: null })).toEqual({ model: null });
      expect(app.getUtilitySettings()).toEqual({ model: null });
    } finally { await app.shutdown(); }
  });

  function tempWorkspace(name: string): string {
    const cwd = join(tempRoot(), name);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }

  function seedSession(
    sessionDir: string,
    cwd: string,
    sessionId: string,
  ): void {
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    const lines = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
      },
      {
        type: "message",
        id: "msg-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "hello from disk", timestamp: 1000 },
      },
    ];
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  }

  it("manages User Providers through the public facade without rewriting Session history", async () => {
    const root = tempRoot();
    const agentDir = join(root, "agent");
    const app = createWikilotApplication({
      sessionsRoot: join(root, "sessions"),
      agentDir,
    });
    const provider: ProviderInput = {
      providerId: "loopback",
      name: "Loopback Provider",
      baseUrl: "http://127.0.0.1:43121/v1",
      protocol: "openai-completions",
      authMode: "api_key",
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
    };

    const created = await app.createProvider(provider);
    expect(created).toMatchObject({
      providerId: "loopback",
      source: "user",
      authenticated: false,
    });
    expect(await app.getModelCatalog()).not.toContainEqual(
      expect.objectContaining({ id: "loopback" }),
    );

    await app.setCredential({ providerId: "loopback", apiKey: "sk-facade-secret" });
    expect(await app.getModelCatalog()).toContainEqual(
      expect.objectContaining({
        id: "loopback",
        models: [expect.objectContaining({ id: "loopback-model" })],
      }),
    );

    const updated = await app.updateProvider("loopback", {
      ...provider,
      name: "Updated Loopback Provider",
      models: [{ ...provider.models[0]!, name: "Updated Model" }],
    });
    expect(updated).toMatchObject({
      providerId: "loopback",
      name: "Updated Loopback Provider",
    });
    expect(await app.listCredentials()).toContainEqual({
      providerId: "loopback",
      type: "api_key",
    });

    const workspace = app.openWorkspace({ cwd: tempWorkspace("deleted-provider") });
    const session = await app.createSession(workspace.id, {
      provider: "loopback",
      model: "loopback-model",
      thinkingLevel: "off",
      wikiPromptEnabled: true,
    });

    await app.deleteProvider("loopback");
    expect(await app.listProviders()).not.toContainEqual(
      expect.objectContaining({ providerId: "loopback" }),
    );
    expect(await app.getModelCatalog()).not.toContainEqual(
      expect.objectContaining({ id: "loopback" }),
    );
    await expect(
      app.getSessionConfiguration(workspace.id, session.sessionId),
    ).resolves.toMatchObject({
      configuration: { provider: "loopback", model: "loopback-model" },
    });
    await expect(
      app.prompt({ workspaceId: workspace.id, sessionId: session.sessionId, text: "hello", clips: [] }),
    ).rejects.toThrow(/Model not available/i);
  });

  it("opens a Workspace with an opaque identity and no Session side effects", async () => {
    const { app, sessionsRoot } = setup();
    const cwd = tempWorkspace("notes");
    const canonicalCwd = realpathSync(cwd);

    const summary = app.openWorkspace({ cwd });

    expect(summary.id).toBe(encodeAbsoluteCwd(canonicalCwd));
    expect(summary.cwd).toBe(canonicalCwd);
    // No Session is created, continued, or selected in Main state.
    expect(existsSync(sessionsRoot)).toBe(false);
    expect(await app.listSessions(summary.id)).toEqual([]);
    await expect(app.prompt({ workspaceId: summary.id, sessionId: "missing", text: "hi", clips: [] })).rejects.toThrow(
      /Session not found/i,
    );
  });

  it("rejects Context Clip limits at the Application submit boundary", async () => {
    const { app } = setup();
    const workspace = app.openWorkspace({ cwd: tempWorkspace("clip-limits") });
    const session = await app.createSession(workspace.id);
    const text = "x".repeat(50_001);
    const clip = {
      source: { kind: "markdown" as const, path: "notes/large.md" },
      text,
      fingerprint: "fnv1a:large",
      locator: {
        kind: "markdown" as const,
        mode: "editing" as const,
        start: 0,
        end: text.length,
        exact: text,
        prefix: "",
        suffix: "",
      },
    };

    await expect(app.prompt({
      workspaceId: workspace.id,
      sessionId: session.sessionId,
      text: "inspect",
      clips: [clip],
    })).rejects.toThrow(/at most 50000/i);
    await expect(app.prompt({
      workspaceId: workspace.id,
      sessionId: session.sessionId,
      text: "inspect",
      clips: Array.from({ length: 21 }, (_, index) => ({
        ...clip,
        source: { ...clip.source, path: `notes/${index}.md` },
        text: "x",
        locator: { ...clip.locator, exact: "x", end: 1 },
      })),
    })).rejects.toThrow(/at most 20/i);
    await expect(app.prompt({
      workspaceId: workspace.id,
      sessionId: session.sessionId,
      text: "inspect",
      clips: Array.from({ length: 3 }, (_, index) => {
        const part = "x".repeat(40_000);
        return {
          ...clip,
          source: { ...clip.source, path: `notes/total-${index}.md` },
          text: part,
          locator: { ...clip.locator, exact: part, end: part.length },
        };
      }),
    })).rejects.toThrow(/at most 100000/i);
    expect((await app.listSessions(workspace.id))[0]?.runtimeStatus).toBe("unloaded");
  });

  it("requests Project Trust on the first Turn before starting a Worker", async () => {
    const root = tempRoot();
    const cwd = tempWorkspace("untrusted");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "extensions"), "extension");
    const app = createWikilotApplication({
      sessionsRoot: join(root, "sessions"),
      agentDir: join(root, "agent"),
    });
    const workspace = app.openWorkspace({ cwd });
    const session = await app.createSession(workspace.id);

    await expect(
      app.resolveProjectTrust({
        workspaceId: workspace.id,
        sessionId: session.sessionId,
        cwd: realpathSync(cwd),
        trusted: true,
      }),
    ).rejects.toThrow(/no longer active/i);

    await expect(
      app.prompt({ workspaceId: workspace.id, sessionId: session.sessionId, text: "run it", clips: [] }),
    ).rejects.toThrow(/Project trust decision required/);
    expect(
      (await app.listSessions(workspace.id)).find(
        (item) => item.id === session.sessionId,
      )?.runtimeStatus,
    ).toBe("unloaded");
    expect(app.getProjectTrustRequest(workspace.id, session.sessionId)).toEqual({
      workspaceId: workspace.id,
      sessionId: session.sessionId,
      cwd: realpathSync(cwd),
    });

    await app.resolveProjectTrust({
      ...app.getProjectTrustRequest(workspace.id, session.sessionId)!,
      trusted: false,
    });
    expect(app.getProjectTrustRequest(workspace.id, session.sessionId)).toBeNull();
    await expect(
      app.prompt({ workspaceId: workspace.id, sessionId: session.sessionId, text: "run it", clips: [] }),
    ).rejects.toThrow(/Choose a Model and Effort/);
  });

  it("lists Workspace files by opaque identity", () => {
    const { app } = setup();
    const cwd = tempWorkspace("notes");
    writeFileSync(join(cwd, "readme.md"), "# hi\n", "utf8");

    const summary = app.openWorkspace({ cwd });

    expect(app.listWorkspaceFiles(summary.id, "").entries).toEqual([
      { name: "raw", path: "raw", kind: "directory" },
      { name: "wiki", path: "wiki", kind: "directory" },
      { name: "AGENTS.md", path: "AGENTS.md", kind: "file" },
      { name: "readme.md", path: "readme.md", kind: "file" },
    ]);
    expect(() => app.listWorkspaceFiles("--nowhere--", "")).toThrow(
      /Open the Workspace/i,
    );
  });

  it("opens and saves Markdown documents through the transport-neutral boundary", async () => {
    const { app } = setup();
    const cwd = tempWorkspace("notes");
    writeFileSync(join(cwd, "readme.md"), "# one\n", "utf8");
    const summary = app.openWorkspace({ cwd });

    const snapshot = app.openMarkdownDocument(summary.id, "readme.md");
    if (snapshot.status !== "ready") throw new Error("expected ready snapshot");
    const result = await app.saveMarkdownDocument(summary.id, "readme.md", {
      version: snapshot.version,
      content: "# two\n",
    });

    expect(result).toEqual({
      outcome: "saved",
      snapshot: expect.objectContaining({ content: "# two\n" }),
    });
    expect(readFileSync(join(cwd, "readme.md"), "utf8")).toBe("# two\n");
  });

  it("persists and restores Workspace Pane snapshots by opaque identity", () => {
    const { app } = setup();
    const cwd = tempWorkspace("notes");
    const summary = app.openWorkspace({ cwd });
    let state = initialWorkspacePaneState();
    state = openWorkspacePaneTab(state, "readme.md");
    state = setWorkspacePanePosition(state, "readme.md", 64);

    app.saveWorkspacePaneState(summary.id, state);

    expect(app.loadWorkspacePaneState(summary.id)).toEqual({
      state,
      skipped: 0,
    });
    expect(() => app.saveWorkspacePaneState("--nowhere--", state)).toThrow(
      /Open the Workspace|Known Workspace/i,
    );
  });

  it("creates a Session explicitly and exposes its authoritative Timeline Snapshot", async () => {
    const { app } = setup();
    const cwd = tempWorkspace("notes");
    const summary = app.openWorkspace({ cwd });
    const events: TimelineDeltaEvent[] = [];
    const unsubscribe = app.subscribeEvents((event) => {
      if ("delta" in event) {
        events.push(event);
      }
    });
    try {
      const created = await app.createSession(summary.id);

      expect(created.action).toBe("create");
      expect(created.workspaceId).toBe(summary.id);
      expect(events).toEqual([]);
      expect(app.getTimelineSnapshot(summary.id, created.sessionId)).toEqual({
        context: { status: "unavailable" },
        workspaceId: summary.id,
        sessionId: created.sessionId,
        sequence: 0,
        status: "unloaded",
        items: [],
      });
      const listed = await app.listSessions(summary.id);
      expect(listed.map((item) => item.id)).toContain(created.sessionId);
      expect(
        listed.find((item) => item.id === created.sessionId)?.runtimeStatus,
      ).toBe("unloaded");
    } finally {
      unsubscribe();
    }
  });

  it("prepares a selected Session Runtime before its first Turn and releases it by identity", async () => {
    const { app } = setup();
    const workspace = app.openWorkspace({ cwd: tempWorkspace("prepare-runtime") });
    const session = await app.createSession(workspace.id);

    const selectionToken = {
      clientId: "application-test-renderer",
      sequence: 1,
    };
    const skills = await app.prepareSession(
      workspace.id,
      session.sessionId,
      selectionToken,
    );
    expect(skills).toEqual(expect.any(Array));
    expect(
      (await app.listSessions(workspace.id)).find(
        (item) => item.id === session.sessionId,
      )?.runtimeStatus,
    ).toBe("idle");

    await app.releaseSession(workspace.id, session.sessionId, selectionToken);
    expect(
      (await app.listSessions(workspace.id)).find(
        (item) => item.id === session.sessionId,
      )?.runtimeStatus,
    ).toBe("unloaded");
  });

  it("opens a persisted Session and restores its Timeline", async () => {
    const { app, sessionsRoot } = setup();
    const cwd = tempWorkspace("notes");
    const canonicalCwd = realpathSync(cwd);
    const existingId = "11111111-1111-1111-1111-111111111111";
    seedSession(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd)),
      canonicalCwd,
      existingId,
    );

    const summary = app.openWorkspace({ cwd });
    const opened = await app.openSession(summary.id, existingId);

    expect(opened.action).toBe("open");
    expect(opened.sessionId).toBe(existingId);
    expect(opened.timelineItems).toEqual([
      { kind: "user", text: "hello from disk", at: 1000 },
    ]);
  });

  it("opening another Workspace does not affect an existing Session", async () => {
    const { app, sessionsRoot } = setup();
    const cwdA = tempWorkspace("alpha");
    const cwdB = tempWorkspace("beta");
    const seededId = "11111111-1111-1111-1111-111111111111";
    const canonicalA = realpathSync(cwdA);
    seedSession(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalA)),
      canonicalA,
      seededId,
    );
    const workspaceA = app.openWorkspace({ cwd: cwdA });
    const sessionA = await app.createSession(workspaceA.id);

    const workspaceB = app.openWorkspace({ cwd: cwdB });

    expect(workspaceB.id).not.toBe(workspaceA.id);
    expect(app.getTimelineSnapshot(workspaceA.id, sessionA.sessionId).sessionId).toBe(
      sessionA.sessionId,
    );
    // Workspace A's persisted Sessions remain listed; opening B has no Session side effect.
    expect((await app.listSessions(workspaceA.id)).map((item) => item.id)).toContain(
      seededId,
    );
    expect(await app.listSessions(workspaceB.id)).toEqual([]);
  });

  it("re-opening the same Workspace preserves loaded Session state", async () => {
    const { app } = setup();
    const cwd = tempWorkspace("notes");
    const summary = app.openWorkspace({ cwd });
    const session = await app.createSession(summary.id);

    const reopened = app.openWorkspace({ cwd });

    expect(reopened.id).toBe(summary.id);
    expect(app.getTimelineSnapshot(reopened.id, session.sessionId).sessionId).toBe(
      session.sessionId,
    );
  });

  it("snapshots App Defaults into a new Session and never reconfigures existing ones", async () => {
    const { app, sessionsRoot } = setup();
    const cwd = tempWorkspace("notes");
    const canonicalCwd = realpathSync(cwd);
    app.updateAppDefaults({
      sessionModel: {
        provider: "openai",
        model: "gpt-5.4",
        thinkingLevel: "high",
      },
      wikiPromptEnabled: false,
    });
    const summary = app.openWorkspace({ cwd });
    await app.setCredential({ providerId: "openai", apiKey: "test-key" });
    const created = await app.createSession(summary.id, {
      provider: "openai",
      model: "gpt-5.4",
      thinkingLevel: "high",
    });

    // Later Defaults edits must not rewrite the existing Session's snapshot.
    app.updateAppDefaults({
      wikiPromptEnabled: true,
    });

    const sessionDir = join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd));
    const file = readdirSync(sessionDir).find(
      (name) => name.includes(created.sessionId) && name.endsWith(".jsonl"),
    );
    expect(file).toBeTruthy();
    const lines = readFileSync(join(sessionDir, file!), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const entry = lines.find(
      (line) => line.type === "custom" && line.customType === "wikilot.session",
    );
    expect(entry?.data).toMatchObject({
      origin: "wikilot",
      wikiPromptEnabled: false,
    });
    expect(lines).toContainEqual(
      expect.objectContaining({
        type: "model_change",
        provider: "openai",
        modelId: "gpt-5.4",
      }),
    );
    expect(lines).toContainEqual(
      expect.objectContaining({ type: "thinking_level_change", thinkingLevel: "high" }),
    );

    // A Session created after the edit keeps the latest explicit Model choice
    // while taking the new General Defaults.
    const second = await app.createSession(summary.id);
    const secondFile = readdirSync(sessionDir).find(
      (name) => name.includes(second.sessionId) && name.endsWith(".jsonl"),
    );
    const secondEntry = readFileSync(join(sessionDir, secondFile!), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find(
        (line) =>
          line.type === "custom" && line.customType === "wikilot.session",
      );
    expect(secondEntry?.data).toMatchObject({ wikiPromptEnabled: true });
  });

  it("opens a Session without a Model and reports the repair action on Prompt", async () => {
    const { app, sessionsRoot } = setup();
    const cwd = tempWorkspace("notes");
    const canonicalCwd = realpathSync(cwd);
    const existingId = "11111111-1111-1111-1111-111111111111";
    seedSession(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd)),
      canonicalCwd,
      existingId,
    );
    const summary = app.openWorkspace({ cwd });

    // No Credentials and no Defaults exist — reads still work.
    const opened = await app.openSession(summary.id, existingId);
    expect(opened.timelineItems).toEqual([
      { kind: "user", text: "hello from disk", at: 1000 },
    ]);

    // Execution alone is blocked until the Composer selects a Model.
    await expect(app.prompt({ workspaceId: summary.id, sessionId: existingId, text: "hi", clips: [] })).rejects.toThrow(
      /Choose a Model.*Composer/i,
    );

    // A Model selection is validated against the executable catalog.
    await expect(
      app.updateSessionConfiguration(summary.id, existingId, {
        provider: "missing-provider",
        model: "missing-model",
        thinkingLevel: "medium",
      }),
    ).rejects.toThrow(/Model not available/i);
  });

  it("prefers explicit creation choices over trusted project and App defaults", async () => {
    const { app } = setup();
    const cwd = tempWorkspace("configured");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
        defaultThinkingLevel: "low",
      }),
    );
    app.updateAppDefaults({
      sessionModel: {
        provider: "openai",
        model: "gpt-5.4",
        thinkingLevel: "medium",
      },
      wikiPromptEnabled: true,
    });
    const workspace = app.openWorkspace({ cwd });
    await app.setCredential({ providerId: "openai", apiKey: "test-key" });

    const created = await app.createSession(workspace.id, {
      provider: "openai",
      model: "gpt-5.4",
      thinkingLevel: "high",
      wikiPromptEnabled: false,
    });

    await expect(
      app.getSessionConfiguration(workspace.id, created.sessionId),
    ).resolves.toEqual({
      status: "applied",
      configuration: {
        accessMode: "auto-review",
        provider: "openai",
        model: "gpt-5.4",
        thinkingLevel: "high",
        wikiPromptEnabled: false,
      },
    });
  });

  it("uses trusted project defaults before App Defaults for new Sessions", async () => {
    const cwd = tempWorkspace("project-defaults");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "settings.json"),
      JSON.stringify({
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
        defaultThinkingLevel: "low",
      }),
    );
    const root = tempRoot();
    const app = createWikilotApplication({
      sessionsRoot: join(root, "sessions"),
      agentDir: join(root, "agent"),
      projectTrust: {
        evaluate: () => ({
          requiresDecision: true,
          decision: "trusted",
          projectTrusted: true,
        }),
        set: () => {},
      },
    });
    app.updateAppDefaults({
      wikiPromptEnabled: false,
    });
    await app.setCredential({ providerId: "anthropic", apiKey: "test-key" });
    const workspace = app.openWorkspace({ cwd });

    const created = await app.createSession(workspace.id);

    await expect(
      app.getSessionConfiguration(workspace.id, created.sessionId),
    ).resolves.toEqual({
      status: "applied",
      configuration: {
        accessMode: "auto-review",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        thinkingLevel: "low",
        wikiPromptEnabled: false,
      },
    });
  });

  it("lets Main persist configuration while the Session has no Worker", async () => {
    const { app } = setup();
    const workspace = app.openWorkspace({ cwd: tempWorkspace("idle-config") });
    await app.setCredential({ providerId: "deepseek", apiKey: "test-key" });
    const created = await app.createSession(workspace.id, {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinkingLevel: "high",
      wikiPromptEnabled: true,
    });

    await expect(
      app.updateSessionConfiguration(workspace.id, created.sessionId, {
        thinkingLevel: "max",
        wikiPromptEnabled: false,
      }),
    ).resolves.toEqual({
      status: "applied",
      configuration: {
        accessMode: "auto-review",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinkingLevel: "max",
        wikiPromptEnabled: false,
      },
    });
    await expect(
      app.getSessionConfiguration(workspace.id, created.sessionId),
    ).resolves.toEqual({
      status: "applied",
      configuration: expect.objectContaining({
        thinkingLevel: "max",
        wikiPromptEnabled: false,
      }),
    });
  });

  it("rejects deleting a Session as soon as its Turn begins validation", async () => {
    const root = tempRoot();
    const app = createWikilotApplication({
      sessionsRoot: join(root, "sessions"),
      agentDir: join(root, "agent"),
    });
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const workspace = app.openWorkspace({ cwd: tempWorkspace("validating-delete") });
      await app.setCredential({ providerId: "openai", apiKey: "test-key" });
      const session = await app.createSession(workspace.id, {
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "off",
      });
      const turn = app
        .prompt({ workspaceId: workspace.id, sessionId: session.sessionId, text: "begin validation", clips: [] })
        .catch((error: unknown) => error);
      await app.createSession(workspace.id);

      await expect(
        app.deleteSession(workspace.id, session.sessionId),
      ).rejects.toThrow(/Cannot delete.*active Turn/i);

      await app.shutdown();
      await turn;
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("records each successfully opened Workspace as durable and known, without duplicates", async () => {
    const { app } = setup();
    const cwdA = tempWorkspace("alpha");
    const cwdB = tempWorkspace("beta");

    app.openWorkspace({ cwd: cwdA });
    app.openWorkspace({ cwd: cwdB });
    app.openWorkspace({ cwd: cwdA });

    const known = await app.listKnownWorkspaces();
    expect(known.workspaces.map((entry) => entry.cwd)).toEqual([
      realpathSync(cwdA),
      realpathSync(cwdB),
    ]);
    expect(known.launchCwd).toBe(realpathSync(cwdA));
    expect(known.warning).toBeUndefined();
    // A failed open leaves recency and the launch target untouched.
    expect(() => app.openWorkspace({ cwd: join(cwdB, "missing") })).toThrow();
    const after = await app.listKnownWorkspaces();
    expect(after.launchCwd).toBe(realpathSync(cwdA));
    expect(after.workspaces.map((entry) => entry.cwd)).toEqual(
      known.workspaces.map((entry) => entry.cwd),
    );
  });

  it("remembers each Workspace's Selected Session and forgets it on delete", async () => {
    const { app } = setup();
    const cwdA = tempWorkspace("alpha");
    const cwdB = tempWorkspace("beta");
    const workspaceA = app.openWorkspace({ cwd: cwdA });
    const workspaceB = app.openWorkspace({ cwd: cwdB });

    const sessionA = await app.createSession(workspaceA.id);
    const sessionB = await app.createSession(workspaceB.id);

    let known = await app.listKnownWorkspaces();
    expect(
      known.workspaces.find((entry) => entry.id === workspaceA.id)
        ?.selectedSessionId,
    ).toBe(sessionA.sessionId);
    expect(
      known.workspaces.find((entry) => entry.id === workspaceB.id)
        ?.selectedSessionId,
    ).toBe(sessionB.sessionId);

    // Remembering a Session never changes recency or the launch target.
    expect(known.workspaces[0]?.id).toBe(workspaceB.id);
    expect(known.launchCwd).toBe(realpathSync(cwdB));

    await app.deleteSession(workspaceA.id, sessionA.sessionId);
    known = await app.listKnownWorkspaces();
    expect(
      known.workspaces.find((entry) => entry.id === workspaceA.id)
        ?.selectedSessionId,
    ).toBeUndefined();
  });

  it("removes a Known Workspace without deleting its directory, Sessions, or trust", async () => {
    const { app, sessionsRoot } = setup();
    const cwd = tempWorkspace("notes");
    const workspace = app.openWorkspace({ cwd });
    const session = await app.createSession(workspace.id);
    const sessionDir = join(
      sessionsRoot,
      encodeAbsoluteCwd(realpathSync(cwd)),
    );

    await app.removeKnownWorkspace(workspace.id);

    const known = await app.listKnownWorkspaces();
    expect(known.workspaces).toEqual([]);
    expect(known.launchCwd).toBeNull();
    // Sessions stay on disk; opening the path again makes it known again.
    expect(readdirSync(sessionDir).some((name) => name.endsWith(".jsonl"))).toBe(
      true,
    );
    const reopened = app.openWorkspace({ cwd });
    expect((await app.listSessions(reopened.id)).map((item) => item.id)).toContain(
      session.sessionId,
    );
    expect(
      (await app.listKnownWorkspaces()).workspaces.map((entry) => entry.cwd),
    ).toEqual([realpathSync(cwd)]);
  });

  it("rejects removing a Workspace while one of its Sessions has an active Turn", async () => {
    const root = tempRoot();
    const app = createWikilotApplication({
      sessionsRoot: join(root, "sessions"),
      agentDir: join(root, "agent"),
    });
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-key";
    try {
      const cwd = tempWorkspace("busy-removal");
      const workspace = app.openWorkspace({ cwd });
      await app.setCredential({ providerId: "openai", apiKey: "test-key" });
      const session = await app.createSession(workspace.id, {
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "off",
      });
      const turn = app
        .prompt({ workspaceId: workspace.id, sessionId: session.sessionId, text: "begin validation", clips: [] })
        .catch((error: unknown) => error);
      await app.createSession(workspace.id);

      await expect(
        app.removeKnownWorkspace(workspace.id),
      ).rejects.toThrow(/active Turn/i);
      expect(
        (await app.listKnownWorkspaces()).workspaces.find(
          (entry) => entry.cwd === realpathSync(cwd),
        )?.hasActiveTurn,
      ).toBe(true);

      await app.shutdown();
      await turn;
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });

  it("warns once and continues empty when the Known Workspace document is malformed", async () => {
    const root = tempRoot();
    const agentDir = join(root, "agent");
    const app = createWikilotApplication({
      sessionsRoot: join(root, "sessions"),
      agentDir,
    });
    const workspace = app.openWorkspace({ cwd: tempWorkspace("notes") });
    expect((await app.listKnownWorkspaces()).workspaces).toHaveLength(1);

    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "workspaces.json"), "{ not json", "utf8");

    const recovered = await app.listKnownWorkspaces();
    expect(recovered.workspaces).toEqual([]);
    expect(recovered.launchCwd).toBeNull();
    expect(recovered.warning).toMatch(/malformed/i);
    expect(
      readdirSync(agentDir).some(
        (name) => name.startsWith("workspaces.json.") && name.endsWith(".corrupt"),
      ),
    ).toBe(true);

    // One-time warning; the collection works again afterwards.
    expect((await app.listKnownWorkspaces()).warning).toBeUndefined();
    app.openWorkspace({ cwd: workspace.cwd });
    expect((await app.listKnownWorkspaces()).workspaces).toHaveLength(1);
  });

});
