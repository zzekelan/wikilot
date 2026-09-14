import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import type { TimelineDeltaEvent } from "../../shared/timeline";
import type {
  AppDefaultsUpdate,
  ProviderInput,
  ProviderSummary,
} from "../../shared/settings";
import type { WikilotApplication } from "../application";
import { createBrowserHostMiddleware } from "./browser-host";

type FakeResponse = ServerResponse & {
  headers: Record<string, string>;
  body(): string;
  json(): unknown;
};

function fakeResponse(): FakeResponse {
  let body = "";
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    writableEnded: false,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      res.headers[name.toLowerCase()] = value;
    },
    flushHeaders() {},
    write(chunk: string | Uint8Array) {
      body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    },
    end(chunk?: string | Uint8Array) {
      if (chunk !== undefined) {
        body += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      }
      res.writableEnded = true;
    },
    body: () => body,
    json: () => JSON.parse(body) as unknown,
  });
  return res as unknown as FakeResponse;
}

function fakeRequest(options: {
  method: string;
  url: string;
  body?: unknown;
  headers?: Record<string, string>;
  remoteAddress?: string;
}): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.method = options.method;
  req.url = options.url;
  req.aborted = false;
  req.headers = options.headers ?? {
    host: "localhost:5197",
    origin: "http://localhost:5197",
  };
  req.socket = {
    remoteAddress: options.remoteAddress ?? "127.0.0.1",
  } as IncomingMessage["socket"];
  req.setTimeout = vi.fn(() => req);
  if (options.body !== undefined) {
    const payload = Buffer.from(JSON.stringify(options.body), "utf8");
    queueMicrotask(() => {
      req.emit("data", payload);
      req.emit("end");
    });
  }
  return req;
}

function fakeApp(overrides: Partial<WikilotApplication>): WikilotApplication {
  const notImplemented = () => {
    throw new Error("not implemented");
  };
  return {
    openWorkspace: notImplemented,
    listKnownWorkspaces: notImplemented,
    removeKnownWorkspace: notImplemented,
    listSessions: notImplemented,
    prepareSession: notImplemented,
    releaseSession: notImplemented,
    createSession: notImplemented,
    openSession: notImplemented,
    deleteSession: notImplemented,
    getSessionConfiguration: notImplemented,
    updateSessionConfiguration: notImplemented,
    reloadSessionResources: notImplemented,
    listWorkspaceFiles: notImplemented,
    openWorkspacePdf: notImplemented,
    openMarkdownDocument: notImplemented,
    saveMarkdownDocument: notImplemented,
    getWorkspaceGraph: notImplemented,
    retryWorkspaceGraph: notImplemented,
    getWorkspaceLinkIndex: notImplemented,
    resolveWorkspaceLink: notImplemented,
    changeWorkspaceFiles: notImplemented,
    importWorkspaceFiles: notImplemented,
    createWorkspaceMarkdown: notImplemented,
    getWorkspacePdfSource: notImplemented,
    releaseWorkspacePdfSource: notImplemented,
    readWorkspacePdfRange: notImplemented,
    loadWorkspacePaneState: notImplemented,
    saveWorkspacePaneState: notImplemented,
    listProviders: notImplemented,
    createProvider: notImplemented,
    updateProvider: notImplemented,
    deleteProvider: notImplemented,
    getModelCatalog: notImplemented,
    listCredentials: notImplemented,
    setCredential: notImplemented,
    deleteCredential: notImplemented,
    getAppDefaults: notImplemented,
    getVersionChanges: notImplemented,
    getVersionFileDiff: notImplemented,
    getVersions: notImplemented,
    saveVersion: notImplemented,
    restoreVersion: notImplemented,
    getUtilitySettings: () => ({ model: null }),
    updateUtilitySettings: () => ({ model: null }),
    updateAppDefaults: notImplemented,
    prompt: notImplemented,
    abort: notImplemented,
    getTimelineSnapshot: notImplemented,
    getSessionImage: notImplemented,
    subscribeEvents: notImplemented,
    getProjectTrustRequest: notImplemented,
    resolveProjectTrust: notImplemented,
    shutdown: notImplemented,
    ...overrides,
  };
}

describe("browser host middleware (HTTP/SSE ↔ WikilotApplication)", () => {
  it("routes Project Trust requests and decisions through the facade", async () => {
    const request = {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      cwd: "/tmp/ws",
    };
    const getProjectTrustRequest = vi.fn(() => request);
    const resolveProjectTrust = vi.fn(async () => [
      { name: "trusted-skill", description: "Trust metadata" },
    ]);
    const middleware = createBrowserHostMiddleware(
      fakeApp({ getProjectTrustRequest, resolveProjectTrust }),
    );
    const getRes = fakeResponse();
    await middleware(
      fakeRequest({
        method: "GET",
        url: "/api/session/trust?workspaceId=workspace-1&sessionId=session-1",
      }),
      getRes,
      () => {
        throw new Error("next must not run");
      },
    );
    expect(getProjectTrustRequest).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
    );
    expect(getRes.json()).toEqual(request);

    const postRes = fakeResponse();
    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/session/trust",
        body: { ...request, trusted: false },
      }),
      postRes,
      () => {
        throw new Error("next must not run");
      },
    );
    expect(resolveProjectTrust).toHaveBeenCalledWith({ ...request, trusted: false });
    expect(postRes.json()).toEqual({
      skills: [{ name: "trusted-skill", description: "Trust metadata" }],
    });
  });

  it("translates workspace open into a facade command", async () => {
    const openWorkspace = vi.fn((command: { cwd: string }) => ({
      id: "--tmp-notes--",
      cwd: command.cwd,
    }));
    const middleware = createBrowserHostMiddleware(fakeApp({ openWorkspace }));
    const req = fakeRequest({
      method: "POST",
      url: "/api/workspace/open",
      body: { cwd: "/tmp/notes" },
    });
    const res = fakeResponse();

    await middleware(req, res, () => {
      throw new Error("next must not run");
    });

    expect(openWorkspace).toHaveBeenCalledWith({ cwd: "/tmp/notes" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: "--tmp-notes--", cwd: "/tmp/notes" });
  });

  it("rejects a workspace open without cwd", async () => {
    const middleware = createBrowserHostMiddleware(fakeApp({}));
    const req = fakeRequest({
      method: "POST",
      url: "/api/workspace/open",
      body: {},
    });
    const res = fakeResponse();

    await middleware(req, res, () => {
      throw new Error("next must not run");
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "cwd is required" });
  });

  it("routes the Known Workspace list and removal through the facade", async () => {
    const listKnownWorkspaces = vi.fn(async () => ({
      workspaces: [
        {
          id: "--tmp-notes--",
          cwd: "/tmp/notes",
          lastOpenedAt: "2026-08-18T00:00:00.000Z",
          hasActiveTurn: false,
        },
      ],
      launchCwd: "/tmp/notes",
    }));
    const removeKnownWorkspace = vi.fn(async () => {});
    const middleware = createBrowserHostMiddleware(
      fakeApp({ listKnownWorkspaces, removeKnownWorkspace }),
    );

    const listRes = fakeResponse();
    await middleware(
      fakeRequest({ method: "GET", url: "/api/workspace/known" }),
      listRes,
      () => {
        throw new Error("next must not run");
      },
    );
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json()).toEqual({
      workspaces: [
        {
          id: "--tmp-notes--",
          cwd: "/tmp/notes",
          lastOpenedAt: "2026-08-18T00:00:00.000Z",
          hasActiveTurn: false,
        },
      ],
      launchCwd: "/tmp/notes",
    });

    const removeRes = fakeResponse();
    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/workspace/remove",
        body: { workspaceId: "--tmp-notes--" },
      }),
      removeRes,
      () => {
        throw new Error("next must not run");
      },
    );
    expect(removeKnownWorkspace).toHaveBeenCalledWith("--tmp-notes--");
    expect(removeRes.statusCode).toBe(204);
  });

  it("maps an active-Turn removal rejection to a 400 JSON body", async () => {
    const middleware = createBrowserHostMiddleware(
      fakeApp({
        removeKnownWorkspace: async () => {
          throw new Error("Cannot remove a Workspace with an active Turn");
        },
      }),
    );
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/workspace/remove",
        body: { workspaceId: "--tmp-notes--" },
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "Cannot remove a Workspace with an active Turn",
    });
  });

  it("routes Workspace file listing by opaque identity", async () => {
    const listWorkspaceFiles = vi.fn(() => ({ entries: [] }));
    const middleware = createBrowserHostMiddleware(fakeApp({ listWorkspaceFiles }));
    const req = fakeRequest({
      method: "POST",
      url: "/api/workspace/files/list",
      body: { workspaceId: "--tmp-notes--", path: "docs" },
    });
    const res = fakeResponse();

    await middleware(req, res, () => {
      throw new Error("next must not run");
    });

    expect(listWorkspaceFiles).toHaveBeenCalledWith("--tmp-notes--", "docs");
    expect(res.statusCode).toBe(200);
  });

  it("routes Markdown open and complete-content save through the facade", async () => {
    const openMarkdownDocument = vi.fn(() => ({
      path: "notes.md",
      status: "ready" as const,
      version: "v1",
      size: 4,
      content: "one\n",
    }));
    const saveMarkdownDocument = vi.fn(async () => ({
      outcome: "saved" as const,
      snapshot: {
        path: "notes.md",
        status: "ready" as const,
        version: "v2",
        size: 4,
        content: "two\n",
      },
    }));
    const middleware = createBrowserHostMiddleware(
      fakeApp({ openMarkdownDocument, saveMarkdownDocument }),
    );

    const openRes = fakeResponse();
    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/workspace/markdown/open",
        body: { workspaceId: "w", path: "notes.md" },
      }),
      openRes,
      () => { throw new Error("next must not run"); },
    );
    expect(openMarkdownDocument).toHaveBeenCalledWith("w", "notes.md");
    expect(openRes.json()).toEqual(expect.objectContaining({ version: "v1" }));

    const saveRes = fakeResponse();
    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/workspace/markdown/save",
        body: { workspaceId: "w", path: "notes.md", version: "v1", content: "two\n" },
      }),
      saveRes,
      () => { throw new Error("next must not run"); },
    );
    expect(saveMarkdownDocument).toHaveBeenCalledWith("w", "notes.md", {
      version: "v1",
      content: "two\n",
    });
    expect(saveRes.json()).toEqual(expect.objectContaining({ outcome: "saved" }));
  });

  it("routes Link Index snapshot, resolution, and safe creation through the facade", async () => {
    const getWorkspaceLinkIndex = vi.fn(() => ({ status: "building" as const }));
    const resolveWorkspaceLink = vi.fn(() => ({
      status: "ready" as const,
      revision: 4,
      target: { status: "missing" as const, creationSuggestion: { path: "New.md" } },
    }));
    const createWorkspaceMarkdown = vi.fn(() => ({
      path: "New.md",
      status: "ready" as const,
      version: "v1",
      size: 0,
      content: "",
    }));
    const middleware = createBrowserHostMiddleware(fakeApp({
      getWorkspaceLinkIndex,
      resolveWorkspaceLink,
      createWorkspaceMarkdown,
    }));

    const indexRes = fakeResponse();
    await middleware(fakeRequest({
      method: "POST",
      url: "/api/workspace/links/index",
      body: { workspaceId: "workspace-1" },
    }), indexRes, () => { throw new Error("next must not run"); });
    expect(getWorkspaceLinkIndex).toHaveBeenCalledWith("workspace-1");
    expect(indexRes.json()).toEqual({ status: "building" });

    const resolveRes = fakeResponse();
    await middleware(fakeRequest({
      method: "POST",
      url: "/api/workspace/links/resolve",
      body: {
        workspaceId: "workspace-1",
        sourcePath: "notes/source.md",
        syntax: "wikilink",
        authoredTarget: "New",
        subpath: { kind: "heading", value: "Intro" },
      },
    }), resolveRes, () => { throw new Error("next must not run"); });
    expect(resolveWorkspaceLink).toHaveBeenCalledWith("workspace-1", {
      sourcePath: "notes/source.md",
      syntax: "wikilink",
      authoredTarget: "New",
      subpath: { kind: "heading", value: "Intro" },
    });

    const createRes = fakeResponse();
    await middleware(fakeRequest({
      method: "POST",
      url: "/api/workspace/links/create",
      body: { workspaceId: "workspace-1", path: "New.md" },
    }), createRes, () => { throw new Error("next must not run"); });
    expect(createWorkspaceMarkdown).toHaveBeenCalledWith("workspace-1", "New.md");
    expect(createRes.json()).toEqual({
      path: "New.md", status: "ready", version: "v1", size: 0, content: "",
    });
  });

  it("routes idempotent PDF source release through the Application", async () => {
    const releaseWorkspacePdfSource = vi.fn();
    const middleware = createBrowserHostMiddleware(fakeApp({ releaseWorkspacePdfSource }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = fakeResponse();
      await middleware(fakeRequest({
        method: "POST",
        url: "/api/workspace/pdf/release",
        body: { sourceId: "opaque-source" },
      }), res, () => { throw new Error("next must not run"); });
      expect(res.statusCode).toBe(204);
    }
    expect(releaseWorkspacePdfSource).toHaveBeenCalledTimes(2);
    expect(releaseWorkspacePdfSource).toHaveBeenCalledWith("opaque-source");
  });

  it("serves PDF metadata with HEAD and exactly one byte range without exposing paths", async () => {
    const source = {
      sourceId: "opaque-source",
      version: "version-1",
      size: 9,
      mediaType: "application/pdf" as const,
    };
    const getWorkspacePdfSource = vi.fn(() => source);
    const readWorkspacePdfRange = vi.fn(async () => ({
      ...source,
      start: 1,
      end: 4,
      bytes: new Uint8Array([80, 68, 70, 45]),
    }));
    const middleware = createBrowserHostMiddleware(
      fakeApp({ getWorkspacePdfSource, readWorkspacePdfRange }),
    );
    const url = "/api/workspace/files/pdf?source=opaque-source";

    const head = fakeResponse();
    await middleware(fakeRequest({ method: "HEAD", url }), head, () => {
      throw new Error("next must not run");
    });
    expect(head.statusCode).toBe(200);
    expect(head.body()).toBe("");
    expect(head.headers).toMatchObject({
      "accept-ranges": "bytes",
      "cache-control": "no-store",
      "content-length": "9",
      "content-type": "application/pdf",
      etag: '"version-1"',
    });

    const range = fakeResponse();
    await middleware(
      fakeRequest({ method: "GET", url, headers: { range: "bytes=1-4" } }),
      range,
      () => { throw new Error("next must not run"); },
    );
    expect(readWorkspacePdfRange).toHaveBeenCalledWith(
      "opaque-source",
      1,
      4,
      expect.any(AbortSignal),
    );
    expect(range.statusCode).toBe(206);
    expect(range.body()).toBe("PDF-");
    expect(range.headers).toMatchObject({
      "cache-control": "no-store",
      "content-length": "4",
      "content-range": "bytes 1-4/9",
    });
    expect(url).not.toContain("paper.pdf");
  });

  it("rejects missing or multiple PDF ranges and serializes source changes", async () => {
    const source = {
      sourceId: "opaque-source",
      version: "v1",
      size: 9,
      mediaType: "application/pdf" as const,
    };
    const changed = Object.assign(new Error("PDF source changed"), {
      code: "source-changed",
    });
    const middleware = createBrowserHostMiddleware(fakeApp({
      getWorkspacePdfSource: () => source,
      readWorkspacePdfRange: async () => { throw changed; },
    }));
    const url = "/api/workspace/files/pdf?source=opaque-source";

    for (const rangeHeader of [undefined, "bytes=0-1,4-5"]) {
      const res = fakeResponse();
      await middleware(
        fakeRequest({
          method: "GET",
          url,
          ...(rangeHeader ? { headers: { range: rangeHeader } } : {}),
        }),
        res,
        () => { throw new Error("next must not run"); },
      );
      expect(res.statusCode).toBe(416);
      expect(res.headers["cache-control"]).toBe("no-store");
    }

    const res = fakeResponse();
    await middleware(
      fakeRequest({ method: "GET", url, headers: { range: "bytes=0-1" } }),
      res,
      () => { throw new Error("next must not run"); },
    );
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "PDF source changed", code: "source-changed" });
  });

  it("aborts an in-flight PDF range read when the client disconnects", async () => {
    const source = {
      sourceId: "opaque-source",
      version: "v1",
      size: 9,
      mediaType: "application/pdf" as const,
    };
    let readSignal: AbortSignal | undefined;
    const readWorkspacePdfRange = vi.fn((
      _sourceId: string,
      _start: number,
      _end: number,
      signal: AbortSignal,
    ) => new Promise<never>((_resolve, reject) => {
      readSignal = signal;
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const middleware = createBrowserHostMiddleware(fakeApp({
      getWorkspacePdfSource: () => source,
      readWorkspacePdfRange,
    }));
    const req = fakeRequest({
      method: "GET",
      url: "/api/workspace/files/pdf?source=opaque-source",
      headers: { range: "bytes=0-1" },
    });
    const res = fakeResponse();

    const pending = middleware(req, res, () => {
      throw new Error("next must not run");
    });
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    req.aborted = true;
    req.emit("aborted");
    await pending;

    expect(readSignal?.aborted).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it("routes Pane snapshot load and save through the facade", async () => {
    const state = {
      version: 4,
      tabs: ["a.md"],
      activePath: "a.md",
      mru: ["a.md"],
      positions: { "a.md": 12 },
      modes: { "a.md": "reading" as const },
      editorSelections: {},
      pdfViews: {},
      visible: true,
      readingMode: "normal" as const,
      history: ["a.md"],
      historyIndex: 0,
    };
    const loadWorkspacePaneState = vi.fn(() => ({
      state,
      skipped: 0,
    }));
    const saveWorkspacePaneState = vi.fn();
    const middleware = createBrowserHostMiddleware(
      fakeApp({ loadWorkspacePaneState, saveWorkspacePaneState }),
    );

    const loadReq = fakeRequest({
      method: "POST",
      url: "/api/workspace/pane/load",
      body: { workspaceId: "--tmp-notes--" },
    });
    const loadRes = fakeResponse();
    await middleware(loadReq, loadRes, () => {
      throw new Error("next must not run");
    });
    expect(loadWorkspacePaneState).toHaveBeenCalledWith("--tmp-notes--");
    expect(JSON.parse(loadRes.body())).toEqual({ state, skipped: 0 });

    const saveReq = fakeRequest({
      method: "POST",
      url: "/api/workspace/pane/save",
      body: { workspaceId: "--tmp-notes--", state },
    });
    const saveRes = fakeResponse();
    await middleware(saveReq, saveRes, () => {
      throw new Error("next must not run");
    });
    expect(saveWorkspacePaneState).toHaveBeenCalledWith("--tmp-notes--", {
      tabs: ["a.md"],
      activePath: "a.md",
      mru: ["a.md"],
      positions: { "a.md": 12 },
      modes: { "a.md": "reading" },
      editorSelections: {},
      pdfViews: {},
      visible: true,
      readingMode: "normal",
      history: ["a.md"],
      historyIndex: 0,
    });
    expect(saveRes.statusCode).toBe(204);
  });

  it("rejects an invalid Pane snapshot payload before reaching the facade", async () => {
    const saveWorkspacePaneState = vi.fn();
    const middleware = createBrowserHostMiddleware(
      fakeApp({ saveWorkspacePaneState }),
    );
    const req = fakeRequest({
      method: "POST",
      url: "/api/workspace/pane/save",
      body: { workspaceId: "--tmp-notes--", state: { version: 99 } },
    });
    const res = fakeResponse();

    await middleware(req, res, () => {
      throw new Error("next must not run");
    });

    expect(saveWorkspacePaneState).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "state is invalid" });
  });

  it("routes Session list by opaque identity from the query string", async () => {
    const listSessions = vi.fn(async () => []);
    const middleware = createBrowserHostMiddleware(fakeApp({ listSessions }));
    const req = fakeRequest({
      method: "GET",
      url: "/api/session/list?workspaceId=--tmp-notes--",
    });
    const res = fakeResponse();

    await middleware(req, res, () => {
      throw new Error("next must not run");
    });

    expect(listSessions).toHaveBeenCalledWith("--tmp-notes--");
    expect(res.json()).toEqual({ sessions: [] });
  });

  it("prepares selected Session resources and returns Skill metadata", async () => {
    const prepareSession = vi.fn(async () => [
      { name: "research", description: "Investigate a question" },
    ]);
    const middleware = createBrowserHostMiddleware(
      fakeApp({ prepareSession }),
    );
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/session/prepare",
        body: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          selectionToken: { clientId: "test-renderer", sequence: 1 },
        },
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(prepareSession).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      { clientId: "test-renderer", sequence: 1 },
    );
    expect(res.json()).toEqual({
      skills: [{ name: "research", description: "Investigate a question" }],
    });
  });

  it("releases a Session Runtime by explicit identity", async () => {
    const releaseSession = vi.fn(async () => {});
    const middleware = createBrowserHostMiddleware(fakeApp({ releaseSession }));
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/session/release",
        body: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          selectionToken: { clientId: "test-renderer", sequence: 1 },
        },
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(releaseSession).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      { clientId: "test-renderer", sequence: 1 },
    );
    expect(res.statusCode).toBe(204);
  });

  it("routes a Timeline Snapshot query by Workspace and Session identity", async () => {
    const getTimelineSnapshot = vi.fn(() => ({
      context: { status: "unavailable" as const },
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sequence: 7,
      status: "running" as const,
      items: [{ kind: "user" as const, text: "question", at: 100 }],
    }));
    const middleware = createBrowserHostMiddleware(
      fakeApp({ getTimelineSnapshot }),
    );
    const req = fakeRequest({
      method: "GET",
      url: "/api/session/timeline/snapshot?workspaceId=workspace-1&sessionId=session-1",
    });
    const res = fakeResponse();

    await middleware(req, res, () => {
      throw new Error("next must not run");
    });

    expect(getTimelineSnapshot).toHaveBeenCalledWith("workspace-1", "session-1");
    expect(res.json()).toMatchObject({ sequence: 7, status: "running" });
  });

  it("serves a guarded Session image with recorded MIME and no-store security headers", async () => {
    const getSessionImage = vi.fn(async () => ({
      status: "ready" as const,
      bytes: new Uint8Array([137, 80, 78, 71]),
      mimeType: "image/png",
    }));
    const middleware = createBrowserHostMiddleware(fakeApp({ getSessionImage }));
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "GET",
        url: "/api/session/image?workspaceId=w&sessionId=s&imageRef=timeline-image:v1:rabBA-7V04eeYNcAg_q9df8KEVtsxfdVK0RVh74qFUg",
      }),
      res,
      () => { throw new Error("next must not run"); },
    );

    expect(getSessionImage).toHaveBeenCalledWith(
      "w",
      "s",
      "timeline-image:v1:rabBA-7V04eeYNcAg_q9df8KEVtsxfdVK0RVh74qFUg",
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({
      "content-type": "image/png",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    expect(res.body()).toContain("PNG");
  });

  it("maps a Session image append race to retryable HTTP 425", async () => {
    const middleware = createBrowserHostMiddleware(fakeApp({
      getSessionImage: async () => ({ status: "pending" as const }),
    }));
    const res = fakeResponse();
    await middleware(
      fakeRequest({ method: "GET", url: "/api/session/image?workspaceId=w&sessionId=s&imageRef=bad" }),
      res,
      () => { throw new Error("next must not run"); },
    );
    expect(res.statusCode).toBe(425);
    expect(res.json()).toEqual({ error: "Image is not available yet" });
  });

  it("routes Session configuration updates and preserves pending status", async () => {
    const updateSessionConfiguration = vi.fn(async () => ({
      status: "pending" as const,
      configuration: {
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "high" as const,
        wikiPromptEnabled: false,
      },
    }));
    const middleware = createBrowserHostMiddleware(
      fakeApp({ updateSessionConfiguration }),
    );
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/session/configuration",
        body: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          configuration: { thinkingLevel: "high", wikiPromptEnabled: false },
        },
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(updateSessionConfiguration).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
      { thinkingLevel: "high", wikiPromptEnabled: false },
    );
    expect(res.json()).toMatchObject({ status: "pending" });
  });

  it("awaits Session configuration queries before serializing them", async () => {
    const getSessionConfiguration = vi.fn(async () => ({
      status: "applied" as const,
      configuration: {
        provider: "openai",
        model: "gpt-4.1",
        thinkingLevel: "medium" as const,
        wikiPromptEnabled: true,
      },
    }));
    const middleware = createBrowserHostMiddleware(
      fakeApp({ getSessionConfiguration }),
    );
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "GET",
        url: "/api/session/configuration?workspaceId=workspace-1&sessionId=session-1",
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(getSessionConfiguration).toHaveBeenCalledWith(
      "workspace-1",
      "session-1",
    );
    expect(res.json()).toMatchObject({
      status: "applied",
      configuration: { provider: "openai", model: "gpt-4.1" },
    });
  });

  it("routes Abort to the explicitly addressed Session", async () => {
    const abort = vi.fn(async () => {});
    const middleware = createBrowserHostMiddleware(fakeApp({ abort }));
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/session/abort",
        body: { workspaceId: "workspace-1", sessionId: "session-1" },
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(abort).toHaveBeenCalledWith("workspace-1", "session-1");
    expect(res.json()).toEqual({ ok: true });
  });

  it("routes a structured Prompt with explicit Workspace and Session identity", async () => {
    const prompt = vi.fn(async () => {});
    const middleware = createBrowserHostMiddleware(fakeApp({ prompt }));
    const res = fakeResponse();
    const command = {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      text: "hello",
      clips: [],
    };

    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/session/prompt",
        body: command,
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(prompt).toHaveBeenCalledWith(command);
    expect(res.json()).toEqual({ ok: true });
  });

  it("streams only sequenced Delta envelopes over SSE", async () => {
    let listener: ((event: TimelineDeltaEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const shutdown = vi.fn(async () => {});
    const subscribeEvents = vi.fn((next: (event: TimelineDeltaEvent) => void) => {
      listener = next;
      return unsubscribe;
    });
    const middleware = createBrowserHostMiddleware(
      fakeApp({ subscribeEvents, shutdown }),
    );
    const req = fakeRequest({ method: "GET", url: "/api/session/events" });
    const res = fakeResponse();

    await middleware(req, res, () => {
      throw new Error("next must not run");
    });
    listener?.({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sequence: 1,
      at: 100,
      delta: { type: "assistant_text_delta", delta: "A" },
    });
    req.emit("close");
    listener?.({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      sequence: 2,
      at: 101,
      delta: {
        type: "tool_end",
        toolCallId: "call-1",
        toolName: "vision",
        isError: false,
        result: {
          text: "done",
          images: [{
            imageRef: "timeline-image:v1:rabBA-7V04eeYNcAg_q9df8KEVtsxfdVK0RVh74qFUg",
            mimeType: "image/png",
          }],
        },
      },
    });
    res.emit("close");

    expect(res.body()).toMatch(/^: connected\n\n/);
    expect(res.body()).toContain('"workspaceId":"workspace-1"');
    expect(res.body()).toContain('"sequence":1');
    expect(res.body()).toContain('"sequence":2');
    expect(res.body()).toContain("timeline-image:v1:");
    expect(res.body()).not.toMatch(/base64|\"data\"|\"details\"|\"type\":\"Buffer\"/);
    expect(res.body()).not.toContain("timeline_snapshot");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(shutdown).not.toHaveBeenCalled();
  });

  it("maps facade errors to a 400 JSON body", async () => {
    const middleware = createBrowserHostMiddleware(
      fakeApp({
        openWorkspace: () => {
          throw new Error("Workspace path does not exist: /nope");
        },
      }),
    );
    const req = fakeRequest({
      method: "POST",
      url: "/api/workspace/open",
      body: { cwd: "/nope" },
    });
    const res = fakeResponse();

    await middleware(req, res, () => {
      throw new Error("next must not run");
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "Workspace path does not exist: /nope" });
  });

  it("routes Credential set and returns metadata only", async () => {
    const setCredential = vi.fn(async () => ({
      providerId: "openai",
      type: "api_key" as const,
    }));
    const middleware = createBrowserHostMiddleware(fakeApp({ setCredential }));
    const req = fakeRequest({
      method: "POST",
      url: "/api/credentials/set",
      body: { providerId: "openai", apiKey: "sk-secret" },
    });
    const res = fakeResponse();

    await middleware(req, res, () => {
      throw new Error("next must not run");
    });

    expect(setCredential).toHaveBeenCalledWith({
      providerId: "openai",
      apiKey: "sk-secret",
    });
    expect(res.statusCode).toBe(200);
    // The response carries metadata only — never the plaintext key.
    expect(res.json()).toEqual({ providerId: "openai", type: "api_key" });
    expect(res.body()).not.toContain("sk-secret");
  });

  it("routes the unified Provider lifecycle without exposing Credentials", async () => {
    const summary: ProviderSummary = {
      providerId: "loopback",
      name: "Loopback",
      baseUrl: "http://127.0.0.1:43121/v1",
      protocol: "openai-completions" as const,
      authMode: "none" as const,
      models: [
        {
          id: "local-model",
          name: "Local Model",
          reasoning: false,
          input: ["text" as const],
        },
      ],
      source: "user" as const,
      authenticated: true,
      supportsApiKey: false,
    };
    const listProviders = vi.fn(async () => [summary]);
    const createProvider = vi.fn(async () => summary);
    const updateProvider = vi.fn(async () => summary);
    const deleteProvider = vi.fn(async () => {});
    const middleware = createBrowserHostMiddleware(
      fakeApp({ listProviders, createProvider, updateProvider, deleteProvider }),
    );
    const input = {
      providerId: "loopback",
      name: "Loopback",
      baseUrl: "http://127.0.0.1:43121/v1",
      protocol: "openai-completions",
      authMode: "none",
      models: [
        {
          id: "local-model",
          name: "Local Model",
          reasoning: false,
          input: ["text"],
        },
      ],
    };

    const listRes = fakeResponse();
    await middleware(fakeRequest({ method: "GET", url: "/api/providers/list" }), listRes, () => {
      throw new Error("next must not run");
    });
    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(listRes.json()).toEqual({ providers: [summary] });

    const createRes = fakeResponse();
    await middleware(fakeRequest({ method: "POST", url: "/api/providers/create", body: input }), createRes, () => {
      throw new Error("next must not run");
    });
    expect(createProvider).toHaveBeenCalledWith(input);
    expect(createRes.json()).toEqual(summary);

    const updateRes = fakeResponse();
    await middleware(fakeRequest({ method: "POST", url: "/api/providers/update", body: input }), updateRes, () => {
      throw new Error("next must not run");
    });
    expect(updateProvider).toHaveBeenCalledWith("loopback", input);
    expect(updateRes.json()).toEqual(summary);

    const deleteRes = fakeResponse();
    await middleware(fakeRequest({ method: "POST", url: "/api/providers/delete", body: { providerId: "loopback" } }), deleteRes, () => {
      throw new Error("next must not run");
    });
    expect(deleteProvider).toHaveBeenCalledWith("loopback");
    expect(deleteRes.statusCode).toBe(204);
  });

  it("rejects unsupported Provider fields before reaching the application", async () => {
    const createProvider = vi.fn(async (_input: ProviderInput) => {
      throw new Error("createProvider must not be called");
    });
    const middleware = createBrowserHostMiddleware(fakeApp({ createProvider }));
    const validModel = {
      id: "local-model",
      reasoning: false,
      input: ["text"],
    };
    const validInput = {
      providerId: "loopback",
      name: "Loopback",
      baseUrl: "http://127.0.0.1:43121/v1",
      protocol: "openai-completions",
      authMode: "none",
      models: [validModel],
    };

    for (const body of [
      { ...validInput, apiKey: "legacy-secret" },
      { ...validInput, models: [{ ...validModel, cost: { input: 1 } }] },
      {
        ...validInput,
        models: [{ id: "local-model", thinkingLevels: ["off"], input: ["text"] }],
      },
    ]) {
      const res = fakeResponse();
      await middleware(
        fakeRequest({ method: "POST", url: "/api/providers/create", body }),
        res,
        () => {
          throw new Error("next must not run");
        },
      );
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: expect.stringContaining("unsupported field"),
      });
    }
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("rejects unsupported Credential and delete request fields", async () => {
    const setCredential = vi.fn(async () => ({
      providerId: "openai",
      type: "api_key" as const,
    }));
    const deleteCredential = vi.fn(async () => {});
    const deleteProvider = vi.fn(async () => {});
    const middleware = createBrowserHostMiddleware(
      fakeApp({ setCredential, deleteCredential, deleteProvider }),
    );
    const requests = [
      {
        url: "/api/credentials/set",
        body: { providerId: "openai", apiKey: "secret", apiSecret: "old" },
      },
      {
        url: "/api/credentials/delete",
        body: { providerId: "openai", unexpected: true },
      },
      {
        url: "/api/providers/delete",
        body: { providerId: "loopback", unexpected: true },
      },
    ];

    for (const request of requests) {
      const res = fakeResponse();
      await middleware(
        fakeRequest({ method: "POST", url: request.url, body: request.body }),
        res,
        () => {
          throw new Error("next must not run");
        },
      );
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: expect.stringContaining("unsupported field"),
      });
    }
    expect(setCredential).not.toHaveBeenCalled();
    expect(deleteCredential).not.toHaveBeenCalled();
    expect(deleteProvider).not.toHaveBeenCalled();
  });

  it("rejects query parameters on Provider and Credential endpoints", async () => {
    const middleware = createBrowserHostMiddleware(fakeApp({}));
    const requests = [
      {
        method: "POST",
        url: "/api/credentials/set?apiKey=secret",
        body: { providerId: "openai", apiKey: "secret" },
      },
      {
        method: "GET",
        url: "/api/providers/list?token=secret",
      },
      {
        method: "GET",
        url: "/api/models/catalog?token=secret",
      },
    ] as const;

    for (const request of requests) {
      const res = fakeResponse();
      await middleware(fakeRequest(request), res, () => {
        throw new Error("next must not run");
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: "This endpoint does not accept query parameters",
      });
    }
  });

  it("routes raw Utility Model settings through the application and reports validation errors", async () => {
    const input = { model: { provider: "provider", model: "model" } };
    const updateUtilitySettings = vi.fn().mockReturnValueOnce(input)
      .mockImplementationOnce(() => { throw new Error("Invalid review selection"); });
    const middleware = createBrowserHostMiddleware(fakeApp({ updateUtilitySettings }));
    for (const [body, status] of [[input, 200], [{ model: {} }, 400]] as const) {
      const res = fakeResponse();
      await middleware(fakeRequest({ method: "POST", url: "/api/utility-model/settings", body }), res, () => {
        throw new Error("next must not run");
      });
      expect(updateUtilitySettings).toHaveBeenLastCalledWith(body);
      expect(res.statusCode).toBe(status);
      expect(res.json()).toEqual(status === 200 ? input : { error: "Invalid review selection" });
    }
  });

  it("routes App Defaults reads and updates", async () => {
    const sessionModel = {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      thinkingLevel: "max" as const,
    };
    const getAppDefaults = vi.fn(() => ({
      sessionModel,
      wikiPromptEnabled: true,
    }));
    const updateAppDefaults = vi.fn((patch: AppDefaultsUpdate) => ({
      ...(patch.sessionModel ? { sessionModel: patch.sessionModel } : {}),
      wikiPromptEnabled: patch.wikiPromptEnabled ?? true,
    }));
    const middleware = createBrowserHostMiddleware(
      fakeApp({ getAppDefaults, updateAppDefaults }),
    );

    const getRes = fakeResponse();
    await middleware(
      fakeRequest({ method: "GET", url: "/api/defaults" }),
      getRes,
      () => {
        throw new Error("next must not run");
      },
    );
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json()).toEqual({
      sessionModel,
      wikiPromptEnabled: true,
    });

    const updateRes = fakeResponse();
    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/defaults/update",
        body: { sessionModel },
      }),
      updateRes,
      () => {
        throw new Error("next must not run");
      },
    );
    expect(updateAppDefaults).toHaveBeenCalledWith({
      sessionModel,
    });
    expect(updateRes.statusCode).toBe(200);

    for (const body of [
      { provider: "openai" },
      { unexpected: true },
      { wikiPromptEnabled: "false" },
      { sessionModel: { ...sessionModel, thinkingLevel: 42 } },
    ]) {
      const invalidRes = fakeResponse();
      await middleware(
        fakeRequest({
          method: "POST",
          url: "/api/defaults/update",
          body,
        }),
        invalidRes,
        () => {
          throw new Error("next must not run");
        },
      );
      expect(invalidRes.statusCode).toBe(400);
      expect(invalidRes.json()).toEqual(
        expect.objectContaining({ error: expect.stringMatching(/unsupported field|must be/) }),
      );
    }
    expect(updateAppDefaults).toHaveBeenCalledTimes(1);
  });

  it("passes unmatched routes to the next middleware", async () => {
    const middleware = createBrowserHostMiddleware(fakeApp({}));
    const req = fakeRequest({ method: "GET", url: "/index.html" });
    const res = fakeResponse();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("returns the chooser's selected directory as a bare path", async () => {
    const pickDirectory = vi.fn(async () => "/tmp/picked");
    const middleware = createBrowserHostMiddleware(fakeApp({}), {
      pickDirectory,
    });
    const req = fakeRequest({
      method: "POST",
      url: "/api/workspace/pick-directory",
    });
    const res = fakeResponse();

    await middleware(req, res, () => {
      throw new Error("next must not run");
    });

    expect(pickDirectory).toHaveBeenCalledTimes(1);
    // A user-paced chooser must outlive the ordinary request timeout.
    expect(req.setTimeout).toHaveBeenCalledWith(0);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cwd: "/tmp/picked" });
  });

  it("reports chooser cancellation as a null path", async () => {
    const middleware = createBrowserHostMiddleware(fakeApp({}), {
      pickDirectory: async () => null,
    });
    const res = fakeResponse();

    await middleware(
      fakeRequest({ method: "POST", url: "/api/workspace/pick-directory" }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cwd: null });
  });

  it("surfaces chooser failures as actionable errors", async () => {
    const middleware = createBrowserHostMiddleware(fakeApp({}), {
      pickDirectory: async () => {
        throw new Error(
          "The native directory chooser is only available on macOS — type the absolute path instead.",
        );
      },
    });
    const res = fakeResponse();

    await middleware(
      fakeRequest({ method: "POST", url: "/api/workspace/pick-directory" }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error:
        "The native directory chooser is only available on macOS — type the absolute path instead.",
    });
  });

  it("cancels the chooser when the caller disconnects mid-choice", async () => {
    let captured: AbortSignal | undefined;
    const middleware = createBrowserHostMiddleware(fakeApp({}), {
      pickDirectory: ({ signal }) =>
        new Promise<string | null>((resolve) => {
          captured = signal;
          signal.addEventListener(
            "abort",
            () => {
              resolve(null);
            },
            { once: true },
          );
        }),
    });
    const res = fakeResponse();

    const pending = middleware(
      fakeRequest({ method: "POST", url: "/api/workspace/pick-directory" }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );
    await vi.waitFor(() => {
      expect(captured).toBeDefined();
    });
    expect(captured!.aborted).toBe(false);
    res.emit("close");
    await pending;

    expect(captured!.aborted).toBe(true);
  });

  it("rejects non-loopback callers before any chooser can open", async () => {
    const pickDirectory = vi.fn(async () => "/tmp/picked");
    const middleware = createBrowserHostMiddleware(fakeApp({}), {
      pickDirectory,
    });
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/workspace/pick-directory",
        remoteAddress: "192.168.1.20",
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(pickDirectory).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("rejects cross-origin pages before any chooser can open", async () => {
    const pickDirectory = vi.fn(async () => "/tmp/picked");
    const middleware = createBrowserHostMiddleware(fakeApp({}), {
      pickDirectory,
    });
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/workspace/pick-directory",
        headers: {
          host: "localhost:5197",
          origin: "https://evil.example",
        },
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(pickDirectory).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("rejects loopback callers without an Origin header (not a Browser page)", async () => {
    const pickDirectory = vi.fn(async () => "/tmp/picked");
    const middleware = createBrowserHostMiddleware(fakeApp({}), {
      pickDirectory,
    });
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/workspace/pick-directory",
        headers: { host: "localhost:5197" },
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(pickDirectory).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("accepts the same-origin local Browser page", async () => {
    const middleware = createBrowserHostMiddleware(fakeApp({}), {
      pickDirectory: async () => "/tmp/picked",
    });
    const res = fakeResponse();

    await middleware(
      fakeRequest({
        method: "POST",
        url: "/api/workspace/pick-directory",
        headers: {
          host: "localhost:5197",
          origin: "http://localhost:5197",
        },
        remoteAddress: "::1",
      }),
      res,
      () => {
        throw new Error("next must not run");
      },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cwd: "/tmp/picked" });
  });
});

describe("native imports", () => {
  it("passes only chooser-selected sources to the Application and returns its report", async () => {
    const report = { created: ["raw/photo.png"], relocated: [], failures: [] };
    const importWorkspaceFiles = vi.fn(async () => report);
    const pickImport = vi.fn(async () => ["/private/selected/photo.png"]);
    const host = createBrowserHostMiddleware(fakeApp({ importWorkspaceFiles }), { pickImport });
    const res = fakeResponse();
    await host(fakeRequest({ method: "POST", url: "/api/workspace/files/import", body: { workspaceId: "w", destination: "raw", kind: "file" } }), res, vi.fn());
    expect(importWorkspaceFiles).toHaveBeenCalledWith("w", "raw", ["/private/selected/photo.png"]);
    expect(res.json()).toEqual(report);
  });

  it("rejects caller-supplied source paths and untrusted callers before opening a window", async () => {
    const pickImport = vi.fn(async () => []);
    const importWorkspaceFiles = vi.fn();
    const host = createBrowserHostMiddleware(fakeApp({ importWorkspaceFiles }), { pickImport });
    const body = { workspaceId: "w", destination: "", kind: "directory" };
    for (const extra of [
      { body: { ...body, sourcePaths: ["/private/secret"] } },
      { headers: { host: "localhost:5197", origin: "https://evil.test" } },
      { remoteAddress: "192.168.1.2" },
    ]) {
      const res = fakeResponse();
      await host(fakeRequest({ method: "POST", url: "/api/workspace/files/import", body, ...extra }), res, vi.fn());
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(pickImport).not.toHaveBeenCalled();
    expect(importWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("cancels quietly without importing and aborts a disconnected caller's window", async () => {
    const importWorkspaceFiles = vi.fn();
    const res = fakeResponse();
    const host = createBrowserHostMiddleware(fakeApp({ importWorkspaceFiles }), {
      pickImport: async ({ signal }) => { res.emit("close"); expect(signal.aborted).toBe(true); return null; },
    });
    await host(fakeRequest({ method: "POST", url: "/api/workspace/files/import", body: { workspaceId: "w", destination: "", kind: "file" } }), res, vi.fn());
    expect(importWorkspaceFiles).not.toHaveBeenCalled();
    const cancelled = fakeResponse();
    await createBrowserHostMiddleware(fakeApp({ importWorkspaceFiles }), { pickImport: async () => null })(
      fakeRequest({ method: "POST", url: "/api/workspace/files/import", body: { workspaceId: "w", destination: "", kind: "directory" } }), cancelled, vi.fn());
    expect(cancelled.json()).toBeNull();
  });
});


describe("external file uploads", () => {
  function upload(entries: unknown[], chunks: Buffer[] = [], extra = {}) {
    const manifest = Buffer.from(JSON.stringify({ workspaceId: "w", destination: "raw", entries: entries.map(entry => ({ source: 0, ...(entry as object) })), ...extra }));
    const header = Buffer.alloc(4); header.writeUInt32BE(manifest.length);
    const req = fakeRequest({ method: "POST", url: "/api/workspace/files/upload" });
    req[Symbol.asyncIterator] = async function* () {
      // Split metadata and file bytes across arbitrary transport chunks.
      const body = Buffer.concat([header, manifest, ...chunks]);
      for (let offset = 0; offset < body.length; offset += 3) yield body.subarray(offset, offset + 3);
      return undefined;
    };
    return req;
  }

  it("streams binary and empty nested directories into owned sources and removes them after import", async () => {
    let root = "";
    const importWorkspaceFiles = vi.fn(async (id: string, destination: string, sources: string[]) => {
      expect([id, destination]).toEqual(["w", "raw"]);
      root = dirname(dirname(sources[0]!));
      expect(await readFile(sources[0]!)).toEqual(Buffer.from([0, 255, 10, 128]));
      expect(await readdir(join(sources[1]!, "empty"))).toEqual([]);
      expect(await readFile(join(sources[1]!, "note.txt"), "utf8")).toBe("ok");
      return { created: ["raw/photo.bin", "raw/bundle"], relocated: [], failures: [] };
    });
    const res = fakeResponse();
    await createBrowserHostMiddleware(fakeApp({ importWorkspaceFiles }))(upload([
      { path: "photo.bin", kind: "file", size: 4 }, { source: 1, path: "bundle", kind: "directory", size: 0 },
      { source: 1, path: "bundle/empty", kind: "directory", size: 0 }, { source: 1, path: "bundle/note.txt", kind: "file", size: 2 },
    ], [Buffer.from([0, 255, 10, 128]), Buffer.from("ok")]), res, vi.fn());
    expect(res.json()).toMatchObject({ created: ["raw/photo.bin", "raw/bundle"] });
    await expect(access(root)).rejects.toThrow();
  });

  it("rejects unsafe entries, local source paths and truncated or surplus bodies without importing", async () => {
    const importWorkspaceFiles = vi.fn();
    const host = createBrowserHostMiddleware(fakeApp({ importWorkspaceFiles }));
    for (const req of [
      upload([{ path: "../escape", kind: "file", size: 0 }]),
      upload([{ path: "/absolute", kind: "file", size: 0 }]),
      upload([{ path: "x", kind: "file", size: 0 }], [], { sourcePaths: ["/secret"] }),
      upload([{ path: "x", kind: "file", size: 4 }], [Buffer.from("x")]),
      upload([{ path: "x", kind: "file", size: 0 }], [Buffer.from("extra")]),
      upload([{ path: "x", kind: "file", size: 0 }, { path: "x", kind: "file", size: 0 }]),
    ]) {
      const res = fakeResponse(); await host(req, res, vi.fn());
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(importWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("does not import when the caller disconnects before the completed body is consumed", async () => {
    const res = fakeResponse();
    const req = upload([{ path: "x", kind: "file", size: 0 }]);
    const read = req[Symbol.asyncIterator].bind(req);
    req[Symbol.asyncIterator] = async function* () { yield* read(); res.emit("close"); return undefined; };
    const importWorkspaceFiles = vi.fn();
    await createBrowserHostMiddleware(fakeApp({ importWorkspaceFiles }))(req, res, vi.fn());
    expect(importWorkspaceFiles).not.toHaveBeenCalled();
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});
