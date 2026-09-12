import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineDelta } from "../../../shared/timeline";
import { onePageStandardFontPdf } from "../../agent-tools/pdf-test-fixture";
import { createForkedSessionWorker } from "./worker-process";

const SESSION_ID = "pdf-page-worker-session";
const PROVIDER = "pdf-page-loopback";
const MODEL = "pdf-page-model";
const TEXT_MODEL = "pdf-page-text-model";

function sseChunk(delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-pdf-page",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

describe("read_pdf_page in a real Session Worker", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("recovers from a page-bound failure, renders standard fonts, and persists the original image result", async () => {
    const root = mkdtempSync(join(tmpdir(), "wikilot-pdf-tool-worker-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    const sessionDir = join(root, "sessions");
    const agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(sessionDir);
    mkdirSync(agentDir);
    writeFileSync(join(cwd, "paper.pdf"), onePageStandardFontPdf());
    const sessionFile = join(sessionDir, `${SESSION_ID}.jsonl`);
    writeFileSync(sessionFile, `${JSON.stringify({
      type: "session",
      version: 3,
      id: SESSION_ID,
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd,
    })}\n`);

    let firstRequest = "";
    let pageBoundToolResult = "";
    let providerToolResult = "";
    let textOnlyProviderToolResult = "";
    let textOnlyPhase = false;
    let modelRequestCount = 0;
    const requestPaths: string[] = [];
    const modelServer = createServer((request, response) => {
      requestPaths.push(request.url ?? "");
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        modelRequestCount += 1;
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/event-stream");
        if (!textOnlyPhase && modelRequestCount === 1) firstRequest = body;
        if (!textOnlyPhase && modelRequestCount === 2) pageBoundToolResult = body;
        if (!textOnlyPhase && modelRequestCount === 3) providerToolResult = body;
        if (textOnlyPhase && modelRequestCount === 2) textOnlyProviderToolResult = body;
        const shouldCallTool = textOnlyPhase
          ? modelRequestCount === 1
          : modelRequestCount <= 2;
        if (shouldCallTool) {
          response.write(sseChunk({
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: textOnlyPhase
                ? "call_pdf_page_text_only"
                : `call_pdf_page_${modelRequestCount}`,
              type: "function",
              function: {
                name: "read_pdf_page",
                arguments: JSON.stringify({
                  path: "paper.pdf",
                  pages: [!textOnlyPhase && modelRequestCount === 1 ? 2 : 1],
                }),
              },
            }],
          }, null));
          response.write(sseChunk({}, "tool_calls"));
        } else {
          response.write(sseChunk({ role: "assistant", content: "page received" }, null));
          response.write(sseChunk({}, "stop"));
        }
        response.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
    const address = modelServer.address();
    if (!address || typeof address === "string") throw new Error("model server did not bind");
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
      [PROVIDER]: { type: "api_key", key: "pdf-page-test-key" },
    }));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({
      providers: {
        [PROVIDER]: {
          name: "PDF page loopback",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          authMode: "api_key",
          models: [
            {
              id: MODEL,
              name: "PDF page model",
              reasoning: false,
              input: ["text", "image"],
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
            {
              id: TEXT_MODEL,
              name: "PDF page text model",
              reasoning: false,
              input: ["text"],
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    }));

    const worker = createForkedSessionWorker();
    const timeline: TimelineDelta[] = [];
    worker.onTimelineEvent((event) => timeline.push(event));
    try {
      const prepared = await worker.start({
        sessionId: SESSION_ID,
        cwd,
        sessionDir,
        sessionFile,
        agentDir,
        config: {
          provider: PROVIDER,
          model: MODEL,
          thinkingLevel: "medium",
          wikiPromptEnabled: false,
        },
        wikiPromptFragment: "# LLM Wiki\n",
        projectTrusted: false,
      });
      expect(prepared.modelReady).toBe(true);
      try {
        await worker.prompt({
          workspaceId: "workspace-1",
          sessionId: SESSION_ID,
          text: "Read the PDF page.",
          clips: [],
        });
        textOnlyPhase = true;
        modelRequestCount = 0;
        await worker.configure({
          provider: PROVIDER,
          model: TEXT_MODEL,
          thinkingLevel: "medium",
          wikiPromptEnabled: false,
        });
        await worker.prompt({
          workspaceId: "workspace-1",
          sessionId: SESSION_ID,
          text: "Read the same PDF page with the text-only Model.",
          clips: [],
        });
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; requests=${requestPaths.join(",")}`);
      }
    } finally {
      await worker.shutdown();
      await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    }

    expect(firstRequest).toContain('"name":"read_pdf_page"');
    expect(pageBoundToolResult).toContain(
      "read_pdf_page error [page_out_of_range]: Requested page 2; valid pages are 1-1.",
    );
    expect(providerToolResult).toContain("Rendered paper.pdf page 1 of 1 at 1224×1584.");
    expect(providerToolResult).toContain("data:image/png;base64,iVBOR");
    expect(textOnlyProviderToolResult).toContain(
      "[Current model does not support images. The image will be omitted from this request.]",
    );
    expect(textOnlyProviderToolResult).not.toContain("data:image/png;base64");
    const history = await readFile(sessionFile, "utf8");
    expect(history).toContain('"mimeType":"image/png"');
    expect(history).toContain('"data":"iVBOR');
    const timelineJson = JSON.stringify(timeline);
    expect(timelineJson).toContain('"kind":"pdf_pages"');
    expect(timelineJson).toContain('"mimeType":"image/png"');
    expect(timelineJson).not.toContain('"data":"iVBOR');
  }, 30_000);
});
