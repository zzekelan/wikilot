import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createForkedSessionWorker } from "./worker-process";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function chunk(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-sidecar",
    object: "chat.completion.chunk",
    created: 1,
    model: "fast-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

describe("Context Clip sidecar persistence in a real Session Worker", () => {
  it("persists the user message after an asynchronous message_end Extension hook", async () => {
    const root = await mkdtemp(join(tmpdir(), "wikilot-sidecar-worker-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    const agentDir = join(root, "agent");
    const extensionDir = join(cwd, ".pi", "extensions");
    await Promise.all([sessionDir, agentDir, extensionDir].map((path) => mkdir(path, { recursive: true })));
    await writeFile(join(extensionDir, "delay-user-message.ts"), `
      export default (pi) => {
        pi.on("message_end", async (event) => {
          if (event.message.role === "user") {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        });
      };
    `);

    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(chunk({ role: "assistant", content: "ok" }, null));
        response.write(chunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("provider did not bind");

    const provider = "fast-provider";
    const model = "fast-model";
    const sessionId = "sidecar-worker-session";
    const sessionFile = join(sessionDir, `${sessionId}.jsonl`);
    await writeFile(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd })}\n`);
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      [provider]: {
        name: "Fast provider",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        authMode: "none",
        models: [{ id: model, name: model, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096 }],
      },
    } }));

    const worker = createForkedSessionWorker();
    try {
      await worker.start({
        sessionId, cwd, sessionDir, sessionFile, agentDir,
        config: { provider, model, thinkingLevel: "medium", wikiPromptEnabled: false },
        wikiPromptFragment: "# LLM Wiki\n", projectTrusted: true,
      });
      await expect(worker.prompt({ workspaceId: "workspace", sessionId, text: "hello", clips: [] })).resolves.toBeUndefined();
    } finally {
      await worker.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const entries = (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const sidecar = entries.find((entry) => entry.type === "custom" && entry.customType === "wikilot.context-clips");
    expect(entries.some((entry) => entry.parentId === sidecar?.id && entry.type === "message" && entry.message?.role === "user")).toBe(true);
  }, 30_000);
});
