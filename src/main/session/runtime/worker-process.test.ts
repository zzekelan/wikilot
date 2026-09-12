import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createForkedSessionWorker } from "./worker-process";
import type { TimelineDelta } from "../../../shared/timeline";

/**
 * Real child-process coverage: the forked Worker composes Pi SessionManager,
 * ModelRuntime, SettingsManager, ResourceLoader, and AgentSession through the
 * public SDK and answers the IPC protocol. No model calls are made — startup
 * only needs the offline built-in catalog and a file-backed Credential.
 */

const SESSION_ID = "integration-session-1";

function seedEnvironment(root: string): {
  cwd: string;
  sessionDir: string;
  sessionFile: string;
  agentDir: string;
} {
  const cwd = join(root, "ws");
  const sessionDir = join(root, "sessions");
  const agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const sessionFile = join(sessionDir, `${SESSION_ID}.jsonl`);
  writeFileSync(
    sessionFile,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: SESSION_ID,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
    })}\n`,
  );
  // File-backed Pi CredentialStore content (openai api_key) — the Worker only
  // checks presence at startup; no request leaves the machine.
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "sk-integration-fake" } }),
  );
  const skillDir = join(agentDir, "skills", "worker-fixture-skill");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    "---\nname: worker-fixture-skill\ndescription: Worker integration fixture\n---\nbody\n",
  );
  return { cwd, sessionDir, sessionFile, agentDir };
}

describe("forked Session Worker (real child process)", () => {
  const roots: string[] = [];
  let previousOffline: string | undefined;
  let previousOtel: string | undefined;

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function isolateEnv(): void {
    previousOffline = process.env.PI_OFFLINE;
    previousOtel = process.env.WIKILOT_OTEL_ENABLED;
    process.env.PI_OFFLINE = "1";
    process.env.WIKILOT_OTEL_ENABLED = "false";
  }

  function restoreEnv(): void {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousOtel === undefined) delete process.env.WIKILOT_OTEL_ENABLED;
    else process.env.WIKILOT_OTEL_ENABLED = previousOtel;
  }

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "wikilot-worker-"));
    roots.push(root);
    return root;
  }

  it(
    "starts through the real Pi SDK composition and shuts down cleanly",
    async () => {
      isolateEnv();
      try {
        const env = seedEnvironment(tempRoot());
        const worker = createForkedSessionWorker();
        const exits: Array<{ expected: boolean; message: string }> = [];
        worker.onExit((exit) => exits.push(exit));

        const prepared = await worker.start({
          sessionId: SESSION_ID,
          cwd: env.cwd,
          sessionDir: env.sessionDir,
          sessionFile: env.sessionFile,
          agentDir: env.agentDir,
          config: {
            provider: "openai",
            model: "gpt-4.1",
            thinkingLevel: "medium",
            wikiPromptEnabled: true,
          },
          wikiPromptFragment: "# LLM Wiki\n",
          projectTrusted: true,
        });

        expect(prepared.modelReady).toBe(true);
        expect(JSON.parse(await readFile(join(env.agentDir, "web-search.json"), "utf8")))
          .toEqual({ workflow: "none" });
        expect(prepared.skills).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "worker-fixture-skill" }),
          ]),
        );
        // The Session file remains a valid Pi JSONL the Worker now owns.
        const lines = (await readFile(env.sessionFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(lines[0]).toMatchObject({ type: "session", id: SESSION_ID });

        await worker.configure({
          provider: "openai",
          model: "gpt-4.1",
          thinkingLevel: "high",
          wikiPromptEnabled: false,
        });
        const configuredLines = (await readFile(env.sessionFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(configuredLines).toContainEqual(
          expect.objectContaining({
            type: "custom",
            customType: "wikilot.session",
            data: expect.objectContaining({ wikiPromptEnabled: false }),
          }),
        );

        await worker.shutdown();
        expect(exits).toEqual([
          { expected: true, message: "Session Runtime stopped" },
        ]);
      } finally {
        restoreEnv();
      }
    },
    30_000,
  );

  it(
    "prepares resources without a saved Provider or Model",
    async () => {
      isolateEnv();
      try {
        const env = seedEnvironment(tempRoot());
        const worker = createForkedSessionWorker();
        const events: TimelineDelta[] = [];
        worker.onTimelineEvent(event => events.push(event));

        const prepared = await worker.start({
          sessionId: SESSION_ID,
          cwd: env.cwd,
          sessionDir: env.sessionDir,
          sessionFile: env.sessionFile,
          agentDir: env.agentDir,
          config: {
            thinkingLevel: "medium",
            wikiPromptEnabled: true,
          },
          wikiPromptFragment: "# LLM Wiki\n",
          projectTrusted: true,
        });

        expect(prepared.modelReady).toBe(false);
        expect(events).toContainEqual({ type: "context_usage", context: { status: "unavailable" } });
        expect(prepared.skills.length).toBeGreaterThan(0);
        await worker.shutdown();
      } finally {
        restoreEnv();
      }
    },
    30_000,
  );

  it(
    "prepares resources even when the saved Model is unavailable",
    async () => {
      isolateEnv();
      try {
        const env = seedEnvironment(tempRoot());
        const worker = createForkedSessionWorker();
        const events: TimelineDelta[] = [];
        worker.onTimelineEvent(event => events.push(event));

        const prepared = await worker.start({
          sessionId: SESSION_ID,
          cwd: env.cwd,
          sessionDir: env.sessionDir,
          sessionFile: env.sessionFile,
          agentDir: env.agentDir,
          config: {
            provider: "openai",
            model: "wikilot-no-such-model",
            thinkingLevel: "medium",
            wikiPromptEnabled: true,
          },
          wikiPromptFragment: "# LLM Wiki\n",
          projectTrusted: true,
        });

        expect(prepared.modelReady).toBe(false);
        expect(events).toContainEqual({ type: "context_usage", context: { status: "unavailable" } });
        expect(prepared.skills.length).toBeGreaterThan(0);
        await worker.shutdown();
      } finally {
        restoreEnv();
      }
    },
    30_000,
  );

  it(
    "binds trusted Extensions and reports their effective Model with discovered Skills",
    async () => {
      isolateEnv();
      try {
        const env = seedEnvironment(tempRoot());
        const lifecycleMarker = join(env.cwd, "lifecycle-marker");
        mkdirSync(join(env.cwd, ".pi", "extensions"), { recursive: true });
        mkdirSync(
          join(env.cwd, ".agents", "skills", "worker-skill"),
          { recursive: true },
        );
        writeFileSync(
          join(env.cwd, ".agents", "skills", "worker-skill", "SKILL.md"),
          "---\nname: worker-skill\ndescription: Worker-discovered Skill\n---\nbody\n",
        );
        writeFileSync(
          join(env.cwd, ".pi", "extensions", "lifecycle.js"),
          `import { writeFileSync } from "node:fs";
export default (pi) => {
  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.modelRegistry.find("openai", "gpt-4.1-mini");
    if (!model || !await pi.setModel(model)) throw new Error("Fixture Model switch failed");
    writeFileSync(${JSON.stringify(lifecycleMarker)}, "started");
  });
};\n`,
        );

        const worker = createForkedSessionWorker();
        const events: TimelineDelta[] = [];
        worker.onTimelineEvent(event => events.push(event));
        const prepared = await worker.start({
          sessionId: SESSION_ID,
          cwd: env.cwd,
          sessionDir: env.sessionDir,
          sessionFile: env.sessionFile,
          agentDir: env.agentDir,
          config: {
            provider: "openai",
            model: "gpt-4.1",
            thinkingLevel: "medium",
            wikiPromptEnabled: true,
          },
          wikiPromptFragment: "# LLM Wiki\n",
          projectTrusted: true,
        });

        expect(prepared.skills).toContainEqual({
          name: "worker-skill",
          description: "Worker-discovered Skill",
        });
        await expect(readFile(lifecycleMarker, "utf8")).resolves.toBe("started");
        expect(events).toContainEqual({ type: "context_usage", context: expect.objectContaining({
          status: "ready", provider: "openai", model: "gpt-4.1-mini", usedTokens: 0,
        }) });
        await worker.shutdown();
      } finally {
        restoreEnv();
      }
    },
    30_000,
  );

  it(
    "starts a keyless User Provider from the shared Provider configuration",
    async () => {
      isolateEnv();
      try {
        const env = seedEnvironment(tempRoot());
        writeFileSync(join(env.agentDir, "auth.json"), "{}\n");
        writeFileSync(
          join(env.agentDir, "models.json"),
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
                    name: "Loopback Model",
                    reasoning: false,
                    input: ["text"],
                  },
                ],
              },
            },
          }),
        );
        const worker = createForkedSessionWorker();

        await worker.start({
          sessionId: SESSION_ID,
          cwd: env.cwd,
          sessionDir: env.sessionDir,
          sessionFile: env.sessionFile,
          agentDir: env.agentDir,
          config: {
            provider: "loopback",
            model: "loopback-model",
            thinkingLevel: "medium",
            wikiPromptEnabled: true,
          },
          wikiPromptFragment: "# LLM Wiki\n",
          projectTrusted: true,
        });

        await worker.shutdown();
      } finally {
        restoreEnv();
      }
    },
    30_000,
  );

  it(
    "refreshes User Providers before configuring a prepared resource-only Worker",
    async () => {
      isolateEnv();
      try {
        const env = seedEnvironment(tempRoot());
        writeFileSync(join(env.agentDir, "auth.json"), "{}\n");
        writeFileSync(
          join(env.agentDir, "models.json"),
          JSON.stringify({
            providers: {
              initial: {
                name: "Initial Provider",
                baseUrl: "http://127.0.0.1:43121/v1",
                api: "openai-completions",
                authMode: "none",
                models: [
                  {
                    id: "initial-model",
                    name: "Initial Model",
                    reasoning: false,
                    input: ["text"],
                  },
                ],
              },
            },
          }),
        );
        const worker = createForkedSessionWorker();

        const prepared = await worker.start({
          sessionId: SESSION_ID,
          cwd: env.cwd,
          sessionDir: env.sessionDir,
          sessionFile: env.sessionFile,
          agentDir: env.agentDir,
          config: {
            thinkingLevel: "medium",
            wikiPromptEnabled: true,
          },
          wikiPromptFragment: "# LLM Wiki\n",
          projectTrusted: true,
        });

        expect(prepared.modelReady).toBe(false);
        writeFileSync(
          join(env.agentDir, "models.json"),
          JSON.stringify({
            providers: {
              replacement: {
                name: "Replacement Provider",
                baseUrl: "http://127.0.0.1:43121/v1",
                api: "openai-completions",
                authMode: "none",
                models: [
                  {
                    id: "replacement-model",
                    name: "Replacement Model",
                    reasoning: false,
                    input: ["text"],
                  },
                ],
              },
            },
          }),
        );

        await worker.configure({
          provider: "replacement",
          model: "replacement-model",
          thinkingLevel: "medium",
          wikiPromptEnabled: true,
        });

        await worker.shutdown();
      } finally {
        restoreEnv();
      }
    },
    30_000,
  );
});
