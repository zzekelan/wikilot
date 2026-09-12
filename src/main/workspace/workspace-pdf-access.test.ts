import {
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { fork } from "node:child_process";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkspacePdfAccess,
  createWorkspacePdfAccessWithAdapters,
} from "./workspace-pdf-access";

const MAX_WORKSPACE_PDF_RANGE_BYTES = 4 * 1024 * 1024;

describe("Workspace PDF access", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "wikilot-pdf-access-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    return { root, cwd };
  }

  it("loads directly in a Node Session Worker process", async () => {
    const { root } = setup();
    const entry = join(root, "pdf-access-worker.ts");
    const moduleUrl = pathToFileURL(join(process.cwd(), "src/main/workspace/workspace-pdf-access.ts"));
    writeFileSync(entry, [
      `import { createWorkspacePdfAccess } from ${JSON.stringify(moduleUrl.href)};`,
      "if (typeof createWorkspacePdfAccess !== 'function') process.exit(2);",
      "process.send?.('loaded');",
    ].join("\n"));

    await new Promise<void>((resolve, reject) => {
      const child = fork(entry, [], {
        execArgv: [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("message", (message) => {
        if (message === "loaded") {
          child.disconnect();
          resolve();
        }
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) reject(new Error(stderr || `Worker exited with code ${code}`));
      });
    });
  });

  it("normalizes contained PDF paths and rejects escapes, symlinks, non-files, and other extensions", () => {
    const { root, cwd } = setup();
    mkdirSync(join(cwd, "docs"));
    writeFileSync(join(cwd, "docs", "paper.PDF"), "%PDF-1.4\n");
    writeFileSync(join(cwd, "notes.txt"), "not pdf");
    writeFileSync(join(root, "outside.pdf"), "%PDF-1.4\n");
    symlinkSync(join(root, "outside.pdf"), join(cwd, "linked.pdf"));
    const access = createWorkspacePdfAccess();

    expect(access.inspect(cwd, "docs/./paper.PDF")).toMatchObject({
      path: "docs/paper.PDF",
      size: 9,
    });
    expect(() => access.inspect(cwd, "../outside.pdf")).toThrow(
      expect.objectContaining({ code: "unsafe-path" }),
    );
    expect(() => access.inspect(cwd, "linked.pdf")).toThrow(
      expect.objectContaining({ code: "unsafe-path" }),
    );
    expect(() => access.inspect(cwd, "docs")).toThrow(
      expect.objectContaining({ code: "not-file" }),
    );
    expect(() => access.inspect(cwd, "notes.txt")).toThrow(
      expect.objectContaining({ code: "not-pdf" }),
    );
    expect(() => access.inspect(cwd, "missing.pdf")).toThrow(
      expect.objectContaining({ code: "not-found" }),
    );
  });

  it("enforces file and range limits and detects replacement between reads", async () => {
    const { cwd } = setup();
    const path = join(cwd, "paper.pdf");
    writeFileSync(path, Buffer.alloc(MAX_WORKSPACE_PDF_RANGE_BYTES + 2, 7));
    const access = createWorkspacePdfAccess();
    const file = access.inspect(cwd, "paper.pdf");

    await expect(access.readRange(
      file,
      1,
      4,
      new AbortController().signal,
    )).resolves.toEqual({
      start: 1,
      end: 4,
      bytes: new Uint8Array([7, 7, 7, 7]),
    });
    await expect(access.readRange(
      file,
      0,
      MAX_WORKSPACE_PDF_RANGE_BYTES,
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ code: "unavailable" }));
    await expect(access.readRange(
      file,
      -1,
      1,
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({ code: "unavailable" }));

    writeFileSync(path, "%PDF replacement\n");
    expect(() => access.validate(file)).toThrow(
      expect.objectContaining({ code: "source-changed" }),
    );

    const huge = join(cwd, "huge.pdf");
    writeFileSync(huge, "%PDF-1.4\n");
    truncateSync(huge, 500 * 1024 * 1024 + 1);
    expect(() => access.inspect(cwd, "huge.pdf")).toThrow(
      expect.objectContaining({ code: "too-large" }),
    );
  });

  it("checks cancellation and closes an opened handle in finally", async () => {
    const { cwd } = setup();
    const path = join(cwd, "paper.pdf");
    writeFileSync(path, Buffer.alloc(128 * 1024, 3));
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    const openFile = vi.fn(async (absolute: string, flags: number) => {
      const handle = await open(absolute, flags);
      return {
        stat: () => handle.stat({ bigint: true }),
        async read(buffer: Uint8Array, offset: number, length: number, position: number) {
          const result = await handle.read(buffer, offset, length, position);
          controller.abort(new Error("cancelled"));
          return { bytesRead: result.bytesRead };
        },
        async close() {
          await handle.close();
          await close();
        },
      };
    });
    const access = createWorkspacePdfAccessWithAdapters({ openFile });
    const file = access.inspect(cwd, "paper.pdf");

    await expect(access.readRange(file, 0, file.size - 1, controller.signal))
      .rejects.toThrow(/cancelled/);
    expect(openFile).toHaveBeenCalledWith(
      file.absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("pauses after opening the real access path and closes on cancellation", async () => {
    const { cwd } = setup();
    const path = join(cwd, "paper.pdf");
    writeFileSync(path, Buffer.alloc(128 * 1024, 3));
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    let enteredGate = false;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const access = createWorkspacePdfAccessWithAdapters({
      async openFile() {
        return {
          stat: () => handle.stat({ bigint: true }),
          read: (buffer, offset, length, position) =>
            handle.read(buffer, offset, length, position),
          async close() {
            await handle.close();
            await close();
          },
        };
      },
      async beforeReadRange(_file, signal) {
        enteredGate = true;
        await Promise.race([
          gate,
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
        ]);
      },
    });
    const file = access.inspect(cwd, "paper.pdf");
    const reading = access.readRange(file, 0, file.size - 1, controller.signal);
    await vi.waitFor(() => expect(enteredGate).toBe(true));
    controller.abort(new Error("cancelled at range gate"));

    await expect(reading).rejects.toThrow("cancelled at range gate");
    expect(close).toHaveBeenCalledOnce();
    releaseGate?.();
  });

  it("does not open a pre-cancelled request and closes after an opened stat failure", async () => {
    const { cwd } = setup();
    writeFileSync(join(cwd, "paper.pdf"), "%PDF-1.4\n");
    const inspect = createWorkspacePdfAccess();
    const file = inspect.inspect(cwd, "paper.pdf");
    const close = vi.fn(async () => {});
    const openFile = vi.fn(async () => ({
      stat: async () => { throw new Error("stat failed"); },
      read: async () => ({ bytesRead: 0 }),
      close,
    }));
    const access = createWorkspacePdfAccessWithAdapters({ openFile });
    const cancelled = new AbortController();
    cancelled.abort(new Error("cancelled before open"));

    await expect(access.readRange(file, 0, 1, cancelled.signal))
      .rejects.toThrow(/cancelled before open/);
    expect(openFile).not.toHaveBeenCalled();

    await expect(access.readRange(file, 0, 1, new AbortController().signal))
      .rejects.toEqual(expect.objectContaining({ code: "unavailable" }));
    expect(close).toHaveBeenCalledOnce();
  });
});
