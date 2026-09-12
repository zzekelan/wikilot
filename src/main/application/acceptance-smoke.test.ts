import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
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
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionSwitchResult } from "../../shared/workspace";
import { createBrowserHostMiddleware } from "../host";
import { initHostTelemetry, shutdownHostTelemetry } from "../telemetry";
import { encodeAbsoluteCwd } from "../workspace";
import { createWikilotApplication } from "./wikilot-application";

function fakeJsonRequest(
  method: string,
  url: string,
  body: unknown,
): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  queueMicrotask(() => {
    req.emit("data", payload);
    req.emit("end");
  });
  return req;
}

function fakeOpenRequest(cwd: string): IncomingMessage {
  return fakeJsonRequest("POST", "/api/workspace/open", { cwd });
}

function fakeResponse(): ServerResponse & { json(): unknown } {
  let body = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    flushHeaders() {},
    write() {
      return true;
    },
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) {
        body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      }
    },
    json: () => JSON.parse(body) as unknown,
  };
  return res as unknown as ServerResponse & { json(): unknown };
}

describe("assembled acceptance: Browser Host → Application → telemetry", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await shutdownHostTelemetry();
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("workspace.open through the real host middleware returns an opaque identity and traces no Session internals", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });
    const root = mkdtempSync(join(tmpdir(), "wikilot-acc-"));
    roots.push(root);
    const cwd = join(root, "notes");
    mkdirSync(cwd, { recursive: true });

    const app = createWikilotApplication({
      sessionsRoot: join(root, "sessions"),
      agentDir: join(root, "agent"),
    });
    const middleware = createBrowserHostMiddleware(app);
    const res = fakeResponse();
    await middleware(fakeOpenRequest(cwd), res, () => {
      throw new Error("next must not run");
    });

    // Host → Application: opaque Workspace identity crosses the wire.
    const body = res.json() as { id: string; cwd: string };
    expect(body.id).toBeTruthy();
    expect(Object.keys(body).sort()).toEqual(["cwd", "id"]);

    // The workspace.open span proves the opaque identity without paths or Session internals.
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("workspace.open");
    expect(spans[0]?.attributes["wikilot.gesture"]).toBe("workspace.open");
    expect(spans[0]?.attributes["wikilot.workspace.id"]).toBe(
      createHash("sha256").update(body.id).digest("hex").slice(0, 32),
    );
    expect(spans[0]?.attributes["wikilot.workspace.id"]).not.toContain("notes");
    expect(spans[0]?.attributes["wikilot.workspace.cwd"]).toBeUndefined();
    for (const key of Object.keys(spans[0]?.attributes ?? {})) {
      expect(key.startsWith("wikilot.session.")).toBe(false);
    }
  });

  it("session.create/open through the real host middleware prove creation and restoration with telemetry and disk evidence", async () => {
    const exporter = new InMemorySpanExporter();
    initHostTelemetry({
      enabled: true,
      spanProcessor: new SimpleSpanProcessor(exporter),
    });
    const root = mkdtempSync(join(tmpdir(), "wikilot-acc-"));
    roots.push(root);
    const cwd = join(root, "notes");
    mkdirSync(cwd, { recursive: true });
    const canonicalCwd = realpathSync(cwd);
    const sessionsRoot = join(root, "sessions");

    const app = createWikilotApplication({
      sessionsRoot,
      agentDir: join(root, "agent"),
    });
    const middleware = createBrowserHostMiddleware(app);
    const next = () => {
      throw new Error("next must not run");
    };

    const openRes = fakeResponse();
    await middleware(fakeOpenRequest(cwd), openRes, next);
    const workspace = openRes.json() as { id: string };

    // Create through the user path: the DTO stays opaque and the Session is
    // durable immediately (header + Wikilot-namespaced configuration entry).
    const createRes = fakeResponse();
    await middleware(
      fakeJsonRequest("POST", "/api/session/create", {
        workspaceId: workspace.id,
      }),
      createRes,
      next,
    );
    const created = createRes.json() as SessionSwitchResult;
    expect(Object.keys(created).sort()).toEqual([
      "action",
      "sessionId",
      "timelineItems",
      "workspaceId",
    ]);
    expect(created.action).toBe("create");
    expect(created.timelineItems).toEqual([]);

    const sessionDir = join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd));
    // The exact filename carries a creation timestamp; locate it by id.
    const files = readdirSync(sessionDir).filter(
      (name) => name.includes(created.sessionId) && name.endsWith(".jsonl"),
    );
    expect(files).toHaveLength(1);
    const diskLines = readFileSync(join(sessionDir, files[0]!), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(diskLines[0]).toMatchObject({
      type: "session",
      id: created.sessionId,
      cwd: canonicalCwd,
    });
    expect(
      diskLines.some(
        (line) => line.type === "custom" && line.customType === "wikilot.session",
      ),
    ).toBe(true);

    // Seed a historical Session on disk (as a prior turn would have left it)
    // and open it through the user path: the Timeline restores persisted text.
    const historicalId = "77777777-7777-7777-7777-777777777777";
    writeFileSync(
      join(sessionDir, `2026-01-01T00-00-00-000Z_${historicalId}.jsonl`),
      `${[
        {
          type: "session",
          version: 3,
          id: historicalId,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: canonicalCwd,
        },
        {
          type: "message",
          id: "msg-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "hello from history", timestamp: 1000 },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );
    const openSessionRes = fakeResponse();
    await middleware(
      fakeJsonRequest("POST", "/api/session/open", {
        workspaceId: workspace.id,
        sessionId: historicalId,
      }),
      openSessionRes,
      next,
    );
    const opened = openSessionRes.json() as SessionSwitchResult;
    expect(opened.action).toBe("open");
    expect(opened.sessionId).toBe(historicalId);
    expect(opened.timelineItems).toEqual([
      { kind: "user", text: "hello from history", at: 1000 },
    ]);

    // Telemetry evidence for both gestures.
    const spans = exporter.getFinishedSpans();
    const createSpan = spans.find((span) => span.name === "session.create");
    const openSpan = spans.find((span) => span.name === "session.open");
    expect(createSpan?.attributes["wikilot.session.id"]).toBe(created.sessionId);
    expect(createSpan?.attributes["wikilot.session.action"]).toBe("create");
    expect(openSpan?.attributes["wikilot.session.id"]).toBe(historicalId);
    expect(openSpan?.attributes["wikilot.session.action"]).toBe("open");
    expect(existsSync(join(sessionDir, files[0]!))).toBe(true);
  });
});
