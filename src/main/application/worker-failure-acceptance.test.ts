import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TimelineDeltaEvent } from "../../shared/timeline";
import {
  isWorkspaceFilesChangedEvent,
  isWorkspaceLinkIndexChangedEvent,
} from "../../shared/workspace";
import { initHostTelemetry, shutdownHostTelemetry } from "../telemetry";
import { createWikilotApplication } from "./wikilot-application";

const PROVIDER = "failure-mock";
const MODEL = "failure-model";

function sseChunk(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-failure",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

describe("real Worker failure path", () => {
  const roots: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "verifies failure and shutdown behavior with end-to-end telemetry",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "wikilot-worker-failure-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      const agentDir = join(root, "agent");
      const sessionsRoot = join(root, "sessions");
      const toolMarker = join(root, "tool-runs");
      mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(workspace, ".pi", "extensions", "crash-probe.js"),
        `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.registerTool({
    name: "crash_probe",
    label: "Crash probe",
    description: "Terminate this acceptance Worker",
    parameters: { type: "object", properties: {} },
    async execute() {
      appendFileSync(${JSON.stringify(toolMarker)}, "run\\n");
      process.exit(42);
    }
  });
}
`,
      );

      let requestCount = 0;
      let sawCrashTool = false;
      let normalModelRequest = "";
      const mock = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          requestCount += 1;
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            tools?: Array<{ function?: { name?: string } }>;
            messages?: Array<{ role?: string; content?: unknown }>;
          };
          const completesNormally = body.messages?.some(
            (message) =>
              message.role === "user" &&
              JSON.stringify(message.content).includes("immutable worker evidence"),
          );
          if (completesNormally) normalModelRequest = JSON.stringify(body);
          sawCrashTool ||= Boolean(
            body.tools?.some((tool) => tool.function?.name === "crash_probe"),
          );
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/event-stream");
          if (completesNormally) {
            res.write(
              sseChunk(
                { role: "assistant", content: "normal turn complete" },
                null,
              ),
            );
            res.write(sseChunk({}, "stop"));
            res.end("data: [DONE]\n\n");
            return;
          }
          res.write(
            sseChunk(
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_crash_1",
                    type: "function",
                    function: { name: "crash_probe", arguments: "{}" },
                  },
                ],
              },
              null,
            ),
          );
          res.write(sseChunk({}, "tool_calls"));
          res.end("data: [DONE]\n\n");
        });
      });
      servers.push(mock);
      await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
      const address = mock.address();
      if (!address || typeof address === "string") throw new Error("mock did not bind");

      writeFileSync(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            [PROVIDER]: {
              name: "Failure Mock",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-completions",
              authMode: "api_key",
              models: [
                {
                  id: MODEL,
                  name: "Failure Model",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 128000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        }),
      );
      writeFileSync(
        join(agentDir, "auth.json"),
        JSON.stringify({ [PROVIDER]: { type: "api_key", key: "sk-local-only" } }),
      );

      const previousOffline = process.env.PI_OFFLINE;
      const previousOtel = process.env.WIKILOT_OTEL_ENABLED;
      process.env.PI_OFFLINE = "1";
      process.env.WIKILOT_OTEL_ENABLED = "false";
      const exporter = new InMemorySpanExporter();
      initHostTelemetry({
        enabled: true,
        spanProcessor: new SimpleSpanProcessor(exporter),
      });
      const app = createWikilotApplication({
        sessionsRoot,
        agentDir,
        projectTrust: {
          evaluate: () => ({
            requiresDecision: true,
            decision: "trusted",
            projectTrusted: true,
          }),
          set: () => {},
        },
      });
      const events: TimelineDeltaEvent[] = [];
      app.subscribeEvents((event) => {
        if (!isWorkspaceFilesChangedEvent(event) && !isWorkspaceLinkIndexChangedEvent(event)) {
          events.push(event);
        }
      });
      try {
        const opened = app.openWorkspace({ cwd: workspace });
        const session = await app.createSession(opened.id, {
          provider: PROVIDER,
          model: MODEL,
          thinkingLevel: "off",
        });

        await expect(
          app.prompt({ workspaceId: opened.id, sessionId: session.sessionId, text: "crash once", clips: [] }),
        ).rejects.toThrow(
          /Session Runtime exited/,
        );
        await vi.waitFor(async () => {
          expect((await app.listSessions(opened.id))[0]?.runtimeStatus).toBe(
            "unloaded",
          );
        });
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(requestCount).toBe(1);
        expect(sawCrashTool).toBe(true);
        expect(readFileSync(toolMarker, "utf8").trim().split("\n")).toEqual([
          "run",
        ]);
        expect(events).toContainEqual(
          expect.objectContaining({
            workspaceId: opened.id,
            sessionId: session.sessionId,
            delta: expect.objectContaining({ type: "error" }),
          }),
        );

        await app.updateSessionConfiguration(opened.id, session.sessionId, {
          thinkingLevel: "off",
        });
        const sessionDir = join(sessionsRoot, opened.id);
        const sessionFile = readdirSync(sessionDir).find((name) =>
          name.includes(session.sessionId),
        );
        expect(sessionFile).toBeTruthy();
        expect(readFileSync(join(sessionDir, sessionFile!), "utf8")).toContain(
          '"thinkingLevel":"off"',
        );

        await vi.waitFor(() => {
          expect(
            exporter
              .getFinishedSpans()
              .find(
                (span) =>
                  span.name === "session.runtime.dispose" &&
                  span.attributes["wikilot.runtime.dispose_reason"] ===
                    "worker_failure",
              )?.attributes,
          ).toMatchObject({
            "wikilot.workspace.id": createHash("sha256").update(opened.id).digest("hex").slice(0, 32),
            "wikilot.session.id": session.sessionId,
            "wikilot.worker.instance_id": expect.any(String),
            "wikilot.runtime.dispose_reason": "worker_failure",
          });
        });

        const normalSession = await app.createSession(opened.id, {
          provider: PROVIDER,
          model: MODEL,
          thinkingLevel: "off",
        });
        const contextClip = {
          source: { kind: "markdown" as const, path: "notes/evidence.md" },
          text: "immutable worker evidence",
          fingerprint: "must-not-reach-model",
          locator: {
            kind: "markdown" as const,
            mode: "reading" as const,
            start: 12,
            end: 37,
            exact: "immutable worker evidence",
            prefix: "private-prefix",
            suffix: "private-suffix",
          },
        };
        await app.prompt({
          workspaceId: opened.id,
          sessionId: normalSession.sessionId,
          text: "",
          clips: [contextClip],
        });
        expect(normalModelRequest).toContain("immutable worker evidence");
        expect(normalModelRequest).toContain("notes/evidence.md");
        expect(normalModelRequest).not.toContain("must-not-reach-model");
        expect(normalModelRequest).not.toContain("private-prefix");
        await vi.waitFor(() => {
          const promptSpan = exporter.getFinishedSpans().find(
            (span) =>
              span.name === "session.prompt" &&
              span.attributes["wikilot.session.id"] === normalSession.sessionId,
          );
          expect(promptSpan?.attributes).toMatchObject({
            "wikilot.workspace.id": createHash("sha256").update(opened.id).digest("hex").slice(0, 32),
            "wikilot.context_clip.count": "1",
            "wikilot.context_clip.characters": "25",
          });
          expect(JSON.stringify(promptSpan?.attributes)).not.toContain("notes/evidence.md");
          expect(JSON.stringify(promptSpan?.attributes)).not.toContain(opened.cwd);
        });

        const normalSessionFile = readdirSync(sessionDir).find((name) =>
          name.includes(normalSession.sessionId),
        );
        expect(normalSessionFile).toBeTruthy();
        const history = readFileSync(join(sessionDir, normalSessionFile!), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        const promptEntryIndex = history.findIndex(
          (entry) => entry.type === "custom" && entry.customType === "wikilot.prompt",
        );
        expect(promptEntryIndex).toBeGreaterThan(0);
        expect(history[promptEntryIndex]).toMatchObject({
          data: { version: 1, text: "", clips: [contextClip] },
        });
        expect(history[promptEntryIndex + 1]).toMatchObject({
          type: "message",
          parentId: history[promptEntryIndex]?.id,
          message: { role: "user" },
        });
        await vi.waitFor(async () => {
          const listed = await app.listSessions(opened.id);
          expect(
            listed.find((item) => item.id === normalSession.sessionId)
              ?.runtimeStatus,
          ).toBe("idle");
        });

        await app.shutdown();
        await vi.waitFor(() => {
          const disposalSpans = exporter
            .getFinishedSpans()
            .filter((span) => span.name === "session.runtime.dispose");
          const failure = disposalSpans.find(
            (span) =>
              span.attributes["wikilot.runtime.dispose_reason"] ===
              "worker_failure",
          );
          const shutdown = disposalSpans.find(
            (span) =>
              span.attributes["wikilot.runtime.dispose_reason"] ===
              "host_shutdown",
          );
          expect(shutdown?.attributes).toMatchObject({
            "wikilot.workspace.id": createHash("sha256").update(opened.id).digest("hex").slice(0, 32),
            "wikilot.session.id": normalSession.sessionId,
            "wikilot.worker.instance_id": expect.any(String),
            "wikilot.runtime.dispose_reason": "host_shutdown",
          });
          expect(shutdown?.attributes["wikilot.worker.instance_id"]).not.toBe(
            failure?.attributes["wikilot.worker.instance_id"],
          );
          for (const span of [failure, shutdown]) {
            expect(JSON.stringify(span?.attributes)).not.toContain(
              "sk-local-only",
            );
          }
        });
        const restoredApp = createWikilotApplication({ sessionsRoot, agentDir });
        try {
          const restoredWorkspace = restoredApp.openWorkspace({ cwd: workspace });
          const restored = await restoredApp.openSession(
            restoredWorkspace.id,
            normalSession.sessionId,
          );
          expect(restored.timelineItems).toEqual(expect.arrayContaining([
            expect.objectContaining({
              kind: "user",
              text: "",
              clips: [contextClip],
            }),
          ]));
          expect(JSON.stringify(restored.timelineItems)).not.toContain(
            "<context_clips>",
          );
        } finally {
          await restoredApp.shutdown();
        }
        expect(requestCount).toBe(2);
      } finally {
        await app.shutdown();
        await shutdownHostTelemetry();
        if (previousOffline === undefined) delete process.env.PI_OFFLINE;
        else process.env.PI_OFFLINE = previousOffline;
        if (previousOtel === undefined) delete process.env.WIKILOT_OTEL_ENABLED;
        else process.env.WIKILOT_OTEL_ENABLED = previousOtel;
      }
    },
    30_000,
  );
});
