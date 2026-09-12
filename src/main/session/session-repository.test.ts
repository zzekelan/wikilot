import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ContextClip } from "../../shared/session";
import { encodeAbsoluteCwd } from "../workspace";
import { mapSessionEvent } from "./runtime/map-events";
import { resolveAppSessionDir } from "./session-paths";
import { createTestWorkspaces } from "./test-workspaces";
import {
  createSessionRepository,
  readSessionTimelineItems,
  type SessionRepository,
} from "./session-repository";

describe("Session repository (create / list / open / delete)", () => {
  it.each([
    ["Inspect README.md and summarize the goal.", false, "Inspect README.md and summarize the goal."],
    ["比较这两份资料 📝", true, "比较这两份资料 📝"],
    ["", true, "About notes.md"],
  ])("lists the original human Prompt instead of model serialization: %s", async (text, withClip, expected) => {
    const { store, open } = setup();
    const workspaceId = open(tempWorkspace("human-title"));
    const { session } = await store.create(workspaceId);
    const clip: ContextClip = {
      source: { kind: "markdown", path: "notes.md" },
      text: "source excerpt", fingerprint: "sha256:test",
      locator: { kind: "markdown", mode: "reading", start: 0, end: 14, exact: "source excerpt", prefix: "", suffix: "" },
    };
    session.sessionManager.appendCustomEntry("wikilot.context-clips", { version: 1, text, clips: withClip ? [clip] : [] });
    session.sessionManager.appendMessage({ role: "user", content: "<request>model-only payload</request>", timestamp: 1000 });
    const [listed] = await store.list(workspaceId);
    expect(listed?.firstMessage).toBe(expected);
    const opened = await store.open(workspaceId, session.sessionId);
    expect(opened.result.timelineItems[0]).toMatchObject({ kind: "user", text });
  });
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "wikilot-sess-"));
    roots.push(root);
    return root;
  }

  function setup(): { store: SessionRepository; open: (cwd: string) => string } {
    const root = tempRoot();
    const sessionsRoot = join(root, "sessions");
    const workspaces = createTestWorkspaces();
    const store = createSessionRepository({
      resolveWorkspace: workspaces.resolve,
      resolveSessionDir: (cwd) => resolveAppSessionDir(cwd, sessionsRoot),
    });
    return {
      store,
      open: (cwd: string) => workspaces.open(cwd).id,
    };
  }

  function tempWorkspace(name: string): string {
    const cwd = join(tempRoot(), name);
    mkdirSync(cwd, { recursive: true });
    return cwd;
  }

  function seedSession(
    sessionDir: string,
    cwd: string,
    sessionId: string,
    messages: Array<{
      role: "user" | "assistant";
      text: string;
      failed?: boolean;
      errorMessage?: string;
    }> = [],
  ): string {
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    const lines: unknown[] = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd,
      },
    ];
    let parentId: string | null = null;
    messages.forEach((message, index) => {
      const id = `msg-${index + 1}`;
      lines.push({
        type: "message",
        id,
        parentId,
        timestamp: `2026-01-01T00:00:0${index + 1}.000Z`,
        message:
          message.role === "user"
            ? {
                role: "user",
                content: message.text,
                timestamp: (index + 1) * 1000,
              }
            : {
                role: "assistant",
                content: message.failed || message.errorMessage
                  ? []
                  : [{ type: "text", text: message.text }],
                timestamp: (index + 1) * 1000,
                stopReason:
                  message.failed || message.errorMessage ? "error" : "stop",
                ...(message.errorMessage
                  ? { errorMessage: message.errorMessage }
                  : {}),
                api: "openai-responses",
                provider: "openai",
                model: "gpt-4.1",
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    total: 0,
                  },
                },
              },
      });
      parentId = id;
    });
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    return file;
  }

  function seedSessionWithToolActivity(
    sessionDir: string,
    cwd: string,
    sessionId: string,
  ): string {
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    const usage = {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };
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
        message: { role: "user", content: "inspect README", timestamp: 1000 },
      },
      {
        type: "message",
        id: "msg-2",
        parentId: "msg-1",
        timestamp: "2026-01-01T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should read the file." },
            {
              type: "toolCall",
              id: "call-1",
              name: "read_pdf_page",
              arguments: { path: "papers/paper.pdf", page: 2 },
            },
          ],
          timestamp: 2000,
          stopReason: "toolUse",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-4.1",
          usage,
        },
      },
      {
        type: "message",
        id: "msg-3",
        parentId: "msg-2",
        timestamp: "2026-01-01T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read_pdf_page",
          content: [
            { type: "text", text: "# Read me" },
            { type: "image", data: "persisted-base64", mimeType: "image/png" },
          ],
          details: {
            path: "papers/paper.pdf",
            pageCount: 8, pages: [{ page: 2, width: 1224, height: 1584 }],
          },
          isError: false,
          timestamp: 3000,
        },
      },
      {
        type: "message",
        id: "msg-4",
        parentId: "msg-3",
        timestamp: "2026-01-01T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The file is a readme." }],
          timestamp: 4000,
          stopReason: "stop",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-4.1",
          usage,
        },
      },
    ];
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    return file;
  }

  it("creates a Session explicitly and includes it in the Workspace list", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("notes");
    const workspaceId = open(cwd);

    expect(await store.list(workspaceId)).toEqual([]);
    const created = await store.create(workspaceId);
    const listed = await store.list(workspaceId);

    expect(created.result.action).toBe("create");
    expect(created.result.workspaceId).toBe(workspaceId);
    expect(created.session.sessionId).toBe(created.result.sessionId);
    expect(listed.map((item) => item.id)).toContain(created.result.sessionId);
  });

  it("persists initial namespaced configuration at create so an empty Session is durable", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("notes");
    const workspaceId = open(cwd);

    const created = await store.create(workspaceId);
    const sessionFile = created.session.sessionFile;

    // Disk evidence: the .jsonl exists before any turn runs.
    expect(sessionFile).toBeDefined();
    expect(existsSync(sessionFile!)).toBe(true);
    const lines = readFileSync(sessionFile!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({
      type: "session",
      id: created.result.sessionId,
    });
    expect(
      lines.some(
        (line) => line.type === "custom" && line.customType === "wikilot.session",
      ),
    ).toBe(true);

    // The empty Session is listed from disk with no in-memory fallback.
    const listed = await store.list(workspaceId);
    const item = listed.find((entry) => entry.id === created.result.sessionId);
    expect(item).toBeDefined();
    expect(item?.messageCount).toBe(0);
  });

  it("keeps appending to the created file when the first Turn persists", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("notes");
    const workspaceId = open(cwd);

    const created = await store.create(workspaceId);
    const session = created.session;
    const sessionFile = session.sessionFile;

    // What the first Turn does through the Session Runtime: append user then
    // assistant messages. Pi's deferred first write must not collide with the
    // file persisted at create — the re-opened manager appends to it instead.
    type AppendedMessage = Parameters<SessionManager["appendMessage"]>[0];
    session.sessionManager.appendMessage({
      role: "user",
      content: "hi",
      timestamp: 1000,
    } as AppendedMessage);
    session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "pong" }],
      timestamp: 2000,
    } as AppendedMessage);

    const lines = readFileSync(sessionFile!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ type: "session" });
    // The initial namespaced entry survives the first Turn's writes.
    expect(
      lines.some(
        (line) => line.type === "custom" && line.customType === "wikilot.session",
      ),
    ).toBe(true);
    const roles = lines
      .filter((line) => line.type === "message")
      .map((line) => (line.message as { role: string }).role);
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("deletes an empty Session that never ran a turn", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("notes");
    const workspaceId = open(cwd);

    const empty = await store.create(workspaceId);
    const emptyFile = empty.session.sessionFile;

    await store.delete(workspaceId, empty.result.sessionId);

    expect(existsSync(emptyFile!)).toBe(false);
    const listed = await store.list(workspaceId);
    expect(listed.map((item) => item.id)).not.toContain(empty.result.sessionId);
  });

  it("opens a newly created empty Session without migration", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("notes");
    const workspaceId = open(cwd);

    const created = await store.create(workspaceId);
    const opened = await store.open(workspaceId, created.result.sessionId);

    expect(opened.result.action).toBe("open");
    expect(opened.result.sessionId).toBe(created.result.sessionId);
    expect(opened.result.timelineItems).toEqual([]);
  });

  it("lists only Sessions for the named Workspace", async () => {
    const { store, open } = setup();
    const cwdA = tempWorkspace("alpha");
    const cwdB = tempWorkspace("beta");
    const canonicalA = realpathSync(cwdA);
    const canonicalB = realpathSync(cwdB);
    const sessionsRoot = join(roots[0]!, "sessions");
    const idA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const idB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    seedSession(join(sessionsRoot, encodeAbsoluteCwd(canonicalA)), canonicalA, idA, [
      { role: "user", text: "alpha note" },
      { role: "assistant", text: "alpha reply" },
    ]);
    seedSession(join(sessionsRoot, encodeAbsoluteCwd(canonicalB)), canonicalB, idB, [
      { role: "user", text: "beta note" },
      { role: "assistant", text: "beta reply" },
    ]);

    const workspaceA = open(cwdA);
    const workspaceB = open(cwdB);
    const listed = await store.list(workspaceA);

    expect(listed.map((item) => item.id)).toContain(idA);
    expect(listed.map((item) => item.id)).not.toContain(idB);
    expect((await store.list(workspaceB)).map((item) => item.id)).toContain(idB);
  });

  it("opens a Session from the list and restores existing messages", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("notes");
    const canonicalCwd = realpathSync(cwd);
    const sessionsRoot = join(roots[0]!, "sessions");
    const existingId = "11111111-1111-1111-1111-111111111111";
    seedSession(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd)),
      canonicalCwd,
      existingId,
      [
        { role: "user", text: "remember this" },
        { role: "assistant", text: "I remember" },
      ],
    );

    const workspaceId = open(cwd);
    await store.create(workspaceId);
    const opened = await store.open(workspaceId, existingId);

    expect(opened.result.action).toBe("open");
    expect(opened.result.sessionId).toBe(existingId);
    expect(opened.result.timelineItems).toEqual([
      { kind: "user", text: "remember this", at: 1000 },
      {
        kind: "assistant",
        at: 2000,
        parts: [{ kind: "text", text: "I remember", at: 2000 }],
      },
    ]);
  });

  it("restores a persisted Provider failure as a Timeline error", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("provider-error");
    const canonicalCwd = realpathSync(cwd);
    const sessionsRoot = join(roots[0]!, "sessions");
    const existingId = "22222222-2222-2222-2222-222222222222";
    seedSession(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd)),
      canonicalCwd,
      existingId,
      [
        { role: "user", text: "hello" },
        {
          role: "assistant",
          text: "",
          errorMessage: "Provider rejected the request",
        },
      ],
    );

    const opened = await store.open(open(cwd), existingId);

    expect(opened.result.timelineItems).toEqual([
      { kind: "user", text: "hello", at: 1000 },
      { kind: "error", message: "Provider rejected the request", at: 2000 },
    ]);
  });

  it("uses a readable fallback for a persisted Provider failure without details", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("provider-error-without-details");
    const canonicalCwd = realpathSync(cwd);
    const sessionsRoot = join(roots[0]!, "sessions");
    const existingId = "33333333-3333-3333-3333-333333333333";
    seedSession(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd)),
      canonicalCwd,
      existingId,
      [
        { role: "user", text: "hello" },
        { role: "assistant", text: "", failed: true },
      ],
    );

    const opened = await store.open(open(cwd), existingId);

    expect(opened.result.timelineItems.at(-1)).toEqual({
      kind: "error",
      message: "Provider request failed",
      at: 2000,
    });
  });

  it("omits a Provider failure superseded by a successful retry", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("provider-retry-success");
    const canonicalCwd = realpathSync(cwd);
    const sessionsRoot = join(roots[0]!, "sessions");
    const existingId = "44444444-4444-4444-4444-444444444444";
    seedSession(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd)),
      canonicalCwd,
      existingId,
      [
        { role: "user", text: "hello" },
        {
          role: "assistant",
          text: "",
          errorMessage: "Temporary Provider failure",
        },
        { role: "assistant", text: "Recovered" },
      ],
    );

    const opened = await store.open(open(cwd), existingId);

    expect(opened.result.timelineItems).toEqual([
      { kind: "user", text: "hello", at: 1000 },
      {
        kind: "assistant",
        at: 3000,
        parts: [{ kind: "text", text: "Recovered", at: 3000 }],
      },
    ]);
  });

  it("restores only the final failure after exhausted Provider retries", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("provider-retries-exhausted");
    const canonicalCwd = realpathSync(cwd);
    const sessionsRoot = join(roots[0]!, "sessions");
    const existingId = "66666666-6666-6666-6666-666666666666";
    seedSession(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd)),
      canonicalCwd,
      existingId,
      [
        { role: "user", text: "hello" },
        {
          role: "assistant",
          text: "",
          errorMessage: "Temporary Provider failure",
        },
        {
          role: "assistant",
          text: "",
          errorMessage: "Final Provider failure",
        },
      ],
    );

    const opened = await store.open(open(cwd), existingId);

    expect(opened.result.timelineItems).toEqual([
      { kind: "user", text: "hello", at: 1000 },
      { kind: "error", message: "Final Provider failure", at: 3000 },
    ]);
  });

  it("restores Clips only from a direct-child sidecar on the current branch", () => {
    const cwd = tempWorkspace("clip-history");
    const sessionDir = join(tempRoot(), "sessions");
    const sessionId = "77777777-7777-7777-7777-777777777777";
    const file = join(sessionDir, `${sessionId}.jsonl`);
    mkdirSync(sessionDir, { recursive: true });
    const clip: ContextClip = {
      source: { kind: "markdown", path: "notes/plan.md" },
      text: "immutable excerpt",
      fingerprint: "sha256:original",
      locator: {
        kind: "markdown",
        mode: "reading",
        start: 0,
        end: 17,
        exact: "immutable excerpt",
        prefix: "",
        suffix: "",
      },
    };
    const pdfClip: ContextClip = {
      source: { kind: "pdf", path: "references/paper.pdf" },
      text: "first page\nsecond page",
      fingerprint: "pdf:original",
      locator: {
        kind: "pdf",
        spans: [
          { page: 2, start: 0, end: 10, exact: "first page", prefix: "", suffix: "", boxes: [{ left: 0.1, top: 0.2, width: 0.4, height: 0.04 }] },
          { page: 3, start: 0, end: 11, exact: "second page", prefix: "", suffix: "", boxes: [{ left: 0.1, top: 0.1, width: 0.4, height: 0.04 }] },
        ],
      },
    };
    const sidecar = (id: string, parentId: string | null, text: string, clips: ContextClip[] = [clip]) => ({
      type: "custom",
      id,
      parentId,
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "wikilot.context-clips",
      data: { version: 1, text, clips },
    });
    const lines = [
      { type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd },
      sidecar("off-sidecar", null, "off branch"),
      { type: "message", id: "off-user", parentId: "off-sidecar", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "serialized off branch", timestamp: 2000 } },
      sidecar("orphan", null, "orphan"),
      { type: "custom", id: "intervening", parentId: "orphan", timestamp: "2026-01-01T00:00:03.000Z", customType: "other", data: {} },
      { type: "message", id: "orphan-user", parentId: "intervening", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "user", content: "ordinary current message", timestamp: 4000 } },
      sidecar("paired", "orphan-user", "clean instruction", [clip, pdfClip]),
      { type: "message", id: "paired-user", parentId: "paired", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "user", content: "model serialization must stay hidden", timestamp: 5000 } },
      { ...sidecar("init", "paired-user", "/init", []), data: { version: 1, text: "/init", command: "init", clips: [] } },
      { type: "message", id: "init-user", parentId: "init", timestamp: "2026-01-01T00:00:06.000Z", message: { role: "user", content: "expanded initialization instructions", timestamp: 6000 } },
    ];
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

    expect(readSessionTimelineItems(SessionManager.open(file, sessionDir, cwd))).toEqual([
      { kind: "user", text: "ordinary current message", at: 4000 },
      { kind: "user", text: "clean instruction", clips: [clip, pdfClip], at: 5000 },
      { kind: "user", text: "/init", command: "init", at: 6000 },
    ]);
  });

  it("restores persisted thinking and completed tool activity", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("notes");
    const canonicalCwd = realpathSync(cwd);
    const sessionsRoot = join(roots[0]!, "sessions");
    const existingId = "55555555-5555-5555-5555-555555555555";
    seedSessionWithToolActivity(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd)),
      canonicalCwd,
      existingId,
    );

    const workspaceId = open(cwd);
    const opened = await store.open(workspaceId, existingId);

    expect(opened.result.timelineItems).toEqual([
      { kind: "user", text: "inspect README", at: 1000 },
      {
        kind: "assistant",
        at: 2000,
        parts: [
          {
            kind: "reasoning",
            text: "I should read the file.",
            at: 2000,
            endedAt: 4000,
          },
          {
            kind: "tool",
            toolCallId: "call-1",
            toolName: "read_pdf_page",
            status: "done",
            args: { path: "papers/paper.pdf", page: 2 },
            result: {
              text: "# Read me",
              images: [{
                imageRef: "timeline-image:v1:rabBA-7V04eeYNcAg_q9df8KEVtsxfdVK0RVh74qFUg",
                mimeType: "image/png",
              }],
              metadata: {
                kind: "pdf_pages",
                path: "papers/paper.pdf",
                pageCount: 8, pages: [{ page: 2, width: 1224, height: 1584 }],
              },
            },
            at: 2000,
            endedAt: 3000,
          },
          { kind: "text", text: "The file is a readme.", at: 4000 },
        ],
      },
    ]);
    const live = mapSessionEvent({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read_pdf_page",
      isError: false,
      result: {
        content: [
          { type: "text", text: "# Read me" },
          { type: "image", data: "persisted-base64", mimeType: "image/png" },
        ],
        details: {
          path: "papers/paper.pdf",
          pageCount: 8, pages: [{ page: 2, width: 1224, height: 1584 }],
        },
      },
    });
    const restoredTool = opened.result.timelineItems
      .flatMap((item) => item.kind === "assistant" ? item.parts : [])
      .find((part) => part.kind === "tool" && part.toolCallId === "call-1");
    expect(live?.type === "tool_end" ? live.result : undefined).toEqual(
      restoredTool?.kind === "tool" ? restoredTool.result : undefined,
    );
    expect(JSON.stringify({ live, snapshot: opened.result.timelineItems })).not.toMatch(
      /persisted-base64|copied|\"data\"|\"type\":\"Buffer\"/,
    );
  });

  it("restores persisted tool errors as error Timeline parts", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("notes");
    const canonicalCwd = realpathSync(cwd);
    const sessionsRoot = join(roots[0]!, "sessions");
    const existingId = "66666666-6666-6666-6666-666666666666";
    const sessionDir = join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd));
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, `2026-01-01T00-00-00-000Z_${existingId}.jsonl`),
      `${[
        {
          type: "session",
          version: 3,
          id: existingId,
          timestamp: "2026-01-01T00:00:00.000Z",
          cwd: canonicalCwd,
        },
        {
          type: "message",
          id: "msg-1",
          parentId: null,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-err",
                name: "bash",
                arguments: { command: "false" },
              },
            ],
            timestamp: 1000,
            stopReason: "toolUse",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4.1",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        },
        {
          type: "message",
          id: "msg-2",
          parentId: "msg-1",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: {
            role: "toolResult",
            toolCallId: "call-err",
            toolName: "bash",
            content: [{ type: "text", text: "exit code 1" }],
            isError: true,
            timestamp: 2000,
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n")}\n`,
    );

    const workspaceId = open(cwd);
    const opened = await store.open(workspaceId, existingId);

    expect(opened.result.timelineItems).toEqual([
      {
        kind: "assistant",
        at: 1000,
        parts: [
          {
            kind: "tool",
            toolCallId: "call-err",
            toolName: "bash",
            status: "error",
            args: { command: "false" },
            result: { text: "exit code 1" },
            at: 1000,
            endedAt: 2000,
          },
        ],
      },
    ]);
  });

  it("rejects operations for a Workspace that was never opened", async () => {
    const { store } = setup();
    await expect(store.list("--nowhere--")).rejects.toThrow(/Open the Workspace/i);
    await expect(store.create("--nowhere--")).rejects.toThrow(/Open the Workspace/i);
    await expect(
      store.open("--nowhere--", "11111111-1111-1111-1111-111111111111"),
    ).rejects.toThrow(/Open the Workspace/i);
    await expect(
      store.delete("--nowhere--", "44444444-4444-4444-4444-444444444444"),
    ).rejects.toThrow(/Open the Workspace/i);
  });

  it("deletes a Session file from the named Workspace", async () => {
    const { store, open } = setup();
    const cwd = tempWorkspace("notes");
    const canonicalCwd = realpathSync(cwd);
    const sessionsRoot = join(roots[0]!, "sessions");
    const existingId = "22222222-2222-2222-2222-222222222222";
    const file = seedSession(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalCwd)),
      canonicalCwd,
      existingId,
      [{ role: "user", text: "old note" }],
    );

    const workspaceId = open(cwd);
    await store.create(workspaceId);
    await store.delete(workspaceId, existingId);

    expect(existsSync(file)).toBe(false);
    const listed = await store.list(workspaceId);
    expect(listed.map((item) => item.id)).not.toContain(existingId);
  });

  it("refuses to delete Sessions outside the named Workspace", async () => {
    const { store, open } = setup();
    const cwdA = tempWorkspace("alpha");
    const cwdB = tempWorkspace("beta");
    const canonicalB = realpathSync(cwdB);
    const sessionsRoot = join(roots[0]!, "sessions");
    const idB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const fileB = seedSession(
      join(sessionsRoot, encodeAbsoluteCwd(canonicalB)),
      canonicalB,
      idB,
      [{ role: "user", text: "beta note" }],
    );

    const workspaceA = open(cwdA);

    await expect(store.delete(workspaceA, idB)).rejects.toThrow(/not found/i);
    expect(existsSync(fileB)).toBe(true);
  });

});
