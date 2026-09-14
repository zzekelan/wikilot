import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createMacOsDirectoryPicker,
  createMacOsImportPicker,
  type DirectoryPickerChild,
  type DirectoryPickerSpawn,
} from "./directory-picker";

type FakeChild = DirectoryPickerChild & {
  succeed(stdout: string): void;
  fail(code: number, stderr: string): void;
};

/** ChildProcess stub driven manually; `kill` records the signal. */
function fakeChildProcess(): FakeChild {
  const lifecycle = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child: FakeChild = {
    stdout: { on: stdout.on.bind(stdout) },
    stderr: { on: stderr.on.bind(stderr) },
    on: lifecycle.on.bind(lifecycle) as FakeChild["on"],
    kill: vi.fn(() => true),
    succeed(picked: string) {
      stdout.emit("data", Buffer.from(picked, "utf8"));
      lifecycle.emit("close", 0);
    },
    fail(code: number, errorText: string) {
      stderr.emit("data", Buffer.from(errorText, "utf8"));
      lifecycle.emit("close", code);
    },
  };
  return child;
}

function fakeSpawn(child: FakeChild) {
  return vi.fn<DirectoryPickerSpawn>(() => child);
}

describe("macOS directory picker (owned osascript adapter)", () => {
  it("resolves the selected directory without the chooser's trailing slash", async () => {
    const child = fakeChildProcess();
    const spawnProcess = fakeSpawn(child);
    const pick = createMacOsDirectoryPicker({ spawnProcess });

    const result = pick({ signal: new AbortController().signal });
    expect(spawnProcess).toHaveBeenCalledWith(
      "osascript",
      ["-e", expect.stringContaining("choose folder")],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    child.succeed("/tmp/notes/\n");

    await expect(result).resolves.toBe("/tmp/notes");
  });

  it("keeps the filesystem root intact", async () => {
    const child = fakeChildProcess();
    const pick = createMacOsDirectoryPicker({ spawnProcess: fakeSpawn(child) });

    const result = pick({ signal: new AbortController().signal });
    child.succeed("/\n");

    await expect(result).resolves.toBe("/");
  });

  it.each(["User canceled.", "用户已取消。"])("resolves null on cancellation: %s", async (message) => {
    const child = fakeChildProcess();
    const pick = createMacOsDirectoryPicker({ spawnProcess: fakeSpawn(child) });

    const result = pick({ signal: new AbortController().signal });
    child.fail(1, `27:52: execution error: ${message} (-128)\n`);

    await expect(result).resolves.toBeNull();
  });

  it("rejects with actionable feedback when the chooser process fails", async () => {
    const child = fakeChildProcess();
    const pick = createMacOsDirectoryPicker({ spawnProcess: fakeSpawn(child) });

    const result = pick({ signal: new AbortController().signal });
    child.fail(1, "osascript: can't open scripts\n");

    await expect(result).rejects.toThrow(
      /directory chooser failed: osascript: can't open scripts/,
    );
  });

  it("kills the chooser and resolves null when the caller cancels", async () => {
    const child = fakeChildProcess();
    const pick = createMacOsDirectoryPicker({ spawnProcess: fakeSpawn(child) });
    const controller = new AbortController();

    const result = pick({ signal: controller.signal });
    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.fail(1, "");

    await expect(result).resolves.toBeNull();
  });

  it("resolves null immediately when already cancelled", async () => {
    const spawnProcess = fakeSpawn(fakeChildProcess());
    const pick = createMacOsDirectoryPicker({ spawnProcess });
    const controller = new AbortController();
    controller.abort();

    await expect(pick({ signal: controller.signal })).resolves.toBeNull();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects off macOS without suggesting a removed input", async () => {
    const spawnProcess = fakeSpawn(fakeChildProcess());
    const pick = createMacOsDirectoryPicker({ platform: "linux", spawnProcess });

    await expect(
      pick({ signal: new AbortController().signal }),
    ).rejects.toThrow(/^The native directory chooser is only available on macOS\.$/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

it("returns all native file selections without splitting whitespace or newlines in paths", async () => {
  const child = fakeChildProcess();
  const spawnProcess = fakeSpawn(child);
  const pick = createMacOsImportPicker({ spawnProcess });
  const result = pick({ kind: "file", signal: new AbortController().signal });
  expect(spawnProcess.mock.calls[0]?.[1].join(" ")).toContain("multiple selections allowed");
  child.succeed("/tmp/a,b.png\0/tmp/ spaced \nname.pdf\n");
  await expect(result).resolves.toEqual(["/tmp/a,b.png", "/tmp/ spaced \nname.pdf"]);
});

it("selects an import folder and preserves its path", async () => {
  const child = fakeChildProcess();
  const spawnProcess = fakeSpawn(child);
  const result = createMacOsImportPicker({ spawnProcess })({ kind: "directory", signal: new AbortController().signal });
  expect(spawnProcess.mock.calls[0]?.[1].join(" ")).toContain("choose folder");
  child.succeed("/tmp/资料/\n");
  await expect(result).resolves.toEqual(["/tmp/资料"]);
});

it("settles cancelled native imports quietly and kills a stubborn chooser after disconnect", async () => {
  const cancelled = fakeChildProcess();
  const selection = createMacOsImportPicker({ spawnProcess: fakeSpawn(cancelled) })({ kind: "file", signal: new AbortController().signal });
  cancelled.fail(1, "用户已取消。 (-128)\n");
  await expect(selection).resolves.toBeNull();
  vi.useFakeTimers();
  try {
    const child = fakeChildProcess();
    const controller = new AbortController();
    const result = createMacOsImportPicker({ spawnProcess: fakeSpawn(child) })({ kind: "directory", signal: controller.signal });
    controller.abort();
    await expect(result).resolves.toBeNull();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    child.fail(1, "");
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
