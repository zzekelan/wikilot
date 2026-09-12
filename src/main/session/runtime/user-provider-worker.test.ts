import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineDelta } from "../../../shared/timeline";
import { createForkedSessionWorker } from "./worker-process";

const roots: string[] = [];
afterEach(async () => Promise.all(
  roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
));

function chunk(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-user-provider",
    object: "chat.completion.chunk",
    created: 1,
    model: "reasoning-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function successfulResponse(response: ServerResponse): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(chunk({ role: "assistant", content: "ok" }, null));
  response.write(chunk({}, "stop"));
  response.end("data: [DONE]\n\n");
}

function failedResponse(response: ServerResponse): void {
  response.writeHead(400, { "Content-Type": "application/json" });
  response.end(JSON.stringify({
    error: {
      type: "invalid_request_error",
      message: "Provider rejected the request",
    },
  }));
}

async function startHarness(
  respond: (response: ServerResponse) => void,
): Promise<{
  requestBodies: unknown[];
  timeline: TimelineDelta[];
  sessionFile: string;
  prompt(): Promise<void>;
  stop(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "wikilot-user-provider-worker-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  const agentDir = join(root, "agent");
  await Promise.all([cwd, sessionDir, agentDir].map((path) =>
    mkdir(path, { recursive: true }),
  ));

  const requestBodies: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (value: Buffer) => chunks.push(value));
    request.on("end", () => {
      requestBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      respond(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const closeServer = () => new Promise<void>((resolve) =>
    server.close(() => resolve()),
  );
  if (!address || typeof address === "string") {
    await closeServer();
    throw new Error("provider did not bind");
  }

  const provider = "user-provider";
  const model = "reasoning-model";
  const sessionId = "user-provider-session";
  const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
  const worker = createForkedSessionWorker();
  const timeline: TimelineDelta[] = [];
  try {
    await writeFile(sessionFile, `${JSON.stringify({
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd,
    })}\n`);
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({
      [provider]: { type: "api_key", key: "test-key" },
    }));
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      [provider]: {
        name: "User Provider",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        authMode: "api_key",
        models: [{
          id: model,
          name: "Reasoning Model",
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 4_096,
        }],
      },
    } }));

    worker.onTimelineEvent((event) => timeline.push(event));
    const previousTelemetry = process.env.WIKILOT_OTEL_ENABLED;
    process.env.WIKILOT_OTEL_ENABLED = "false";
    try {
      await worker.start({
        sessionId,
        cwd,
        sessionDir,
        sessionFile,
        agentDir,
        config: {
          provider,
          model,
          thinkingLevel: "high",
          wikiPromptEnabled: false,
        },
        wikiPromptFragment: "# LLM Wiki\n",
        projectTrusted: false,
      });
    } finally {
      if (previousTelemetry === undefined) {
        delete process.env.WIKILOT_OTEL_ENABLED;
      } else {
        process.env.WIKILOT_OTEL_ENABLED = previousTelemetry;
      }
    }
  } catch (error) {
    await worker.shutdown().catch(() => {});
    await closeServer();
    throw error;
  }

  return {
    requestBodies,
    timeline,
    sessionFile,
    prompt: () => worker.prompt({
      workspaceId: "workspace",
      sessionId,
      text: "hello",
      clips: [],
    }),
    async stop() {
      try {
        await worker.shutdown();
      } finally {
        await closeServer();
      }
    },
  };
}

describe("User Provider requests in a real Session Worker", () => {
  it("sends the system prompt with the broadly supported system role", async () => {
    const harness = await startHarness(successfulResponse);
    try {
      await harness.prompt();
    } finally {
      await harness.stop();
    }

    const body = harness.requestBodies[0] as {
      messages?: Array<{ role?: string }>;
    };
    expect(body.messages?.[0]?.role).toBe("system");
    const entries = (await readFile(harness.sessionFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toContainEqual(expect.objectContaining({
      type: "message",
      message: expect.objectContaining({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "ok" }],
      }),
    }));
  }, 30_000);

  it("surfaces a Provider rejection as a Timeline error", async () => {
    const harness = await startHarness(failedResponse);
    try {
      await harness.prompt();
    } finally {
      await harness.stop();
    }

    expect(harness.timeline).toContainEqual({
      type: "error",
      message: expect.stringContaining("Provider rejected the request"),
    });
  }, 30_000);
});
