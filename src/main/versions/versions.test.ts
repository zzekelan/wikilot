import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createVersionsModule, type VersionModelContext } from "./index";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function setup() {
  const cwd = mkdtempSync(join(tmpdir(), "wikilot-versions-")); roots.push(cwd);
  const git = simpleGit(cwd);
  await git.init(); await git.addConfig("user.name", "Version User"); await git.addConfig("user.email", "versions@example.test");
  const getModelContext = vi.fn(async (): Promise<VersionModelContext> => { throw new Error("Model must not be called"); });
  const versions = createVersionsModule({ resolveWorkspace: () => ({ cwd }), getModelContext });
  return { cwd, git, versions, getModelContext };
}
it("saves all changes with a manual message and lists persistent versions without calling a model", async () => {
  const test = await setup();
  writeFileSync(join(test.cwd, "note.md"), "First note");
  writeFileSync(join(test.cwd, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(test.cwd, "ignored.txt"), "Excluded");
  expect((await test.versions.status("workspace")).changedFiles).toBe(2);
  const saved = await test.versions.save("workspace", { message: "Record the first note" });
  expect(saved.saved).toBe(true);
  expect(test.getModelContext).not.toHaveBeenCalled();
  const snapshot = await test.versions.status("workspace");
  expect(snapshot.changedFiles).toBe(0);
  expect(snapshot.versions).toMatchObject([{ message: "Record the first note", author: "Version User", files: 2 }]);
  expect((await test.git.show(["HEAD:note.md"]))).toBe("First note");
  expect(await test.versions.save("workspace", { message: "Nothing changed" })).toEqual({ saved: false });
});
it("summarizes the staged diff with the chosen model and retains changes when generation fails", async () => {
  const test = await setup();
  const runtime = await ModelRuntime.create({ authPath: join(test.cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const model = runtime.getModels().find((model) => model.api === "openai-completions" && !model.reasoning)!;
  test.getModelContext.mockResolvedValue({ runtime, settings: { model: { provider: model.provider, model: model.id, thinkingLevel: "off" } } });
  const complete = vi.spyOn(runtime, "completeSimple").mockImplementation(async (_model, _context, options) => {
    const payload = await options?.onPayload?.({}, model);
    expect(payload).toMatchObject({ response_format: { type: "json_schema", json_schema: {
      name: "version_message", strict: true, schema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
    } } });
    return { role: "assistant", api: model.api,
    provider: model.provider, model: model.id, content: [{ type: "text", text: '{"message":"Add the reading note"}' }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; });
  writeFileSync(join(test.cwd, "note.md"), "An idea worth keeping");
  await test.versions.save("workspace", { sessionId: "selected" });
  expect(test.getModelContext).toHaveBeenCalledWith("workspace", "selected");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0][1].messages[0].content).toContain("+An idea worth keeping");
  expect((await test.versions.status("workspace")).versions[0].message).toBe("Add the reading note");
  writeFileSync(join(test.cwd, "note.md"), "A second idea");
  complete.mockRejectedValueOnce(new Error("Provider unavailable"));
  await expect(test.versions.save("workspace", {})).rejects.toThrow("Provider unavailable");
  const state = await test.versions.status("workspace");
  expect(state.versions).toHaveLength(1);
  expect(state.changedFiles).toBe(1);
});
it("rejects a Workspace inside another repository and keeps outside changes untouched", async () => {
  const test = await setup();
  const { mkdirSync } = await import("node:fs");
  const child = join(test.cwd, "nested"); mkdirSync(child);
  writeFileSync(join(test.cwd, "outside.md"), "Unrelated changes");
  const versions = createVersionsModule({ resolveWorkspace: () => ({ cwd: child }), getModelContext: test.getModelContext });
  await expect(versions.save("nested", { message: "Do not include parent" })).rejects.toThrow("repository root");
  expect((await test.git.status()).staged).toEqual([]);
});
it("lists history in pages, with complete multiline messages and initial file counts", async () => {
  const test = await setup();
  for (let n = 0; n < 22; n++) {
    writeFileSync(join(test.cwd, "note.md"), `Revision ${n}`);
    await test.versions.save("workspace", { message: `Revision ${n}\n\nA description.` });
  }
  const first = await test.versions.status("workspace");
  expect(first.versions).toHaveLength(20);
  expect(first.versions[0].message).toBe("Revision 21\n\nA description.");
  expect(first.nextOffset).toBe(20);
  const last = await test.versions.status("workspace", first.nextOffset!);
  expect(last.versions).toHaveLength(2);
  expect(last.versions[1]).toMatchObject({ message: "Revision 0\n\nA description.", files: 1 });
  expect(last.nextOffset).toBeNull();
}, 15000);

it("initializes a new repository only on explicit save", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "wikilot-new-versions-")); roots.push(cwd);
  const versions = createVersionsModule({ resolveWorkspace: () => ({ cwd }),
    getModelContext: async () => { throw new Error("No model needed"); } });
  expect(await versions.status("workspace")).toEqual({ initialized: false, changedFiles: null, versions: [], nextOffset: null });
  expect(existsSync(join(cwd, ".git"))).toBe(false);
  expect(await versions.save("workspace", { message: "Nothing yet" })).toEqual({ saved: false });
  expect(existsSync(join(cwd, ".git"))).toBe(true);
  const git = simpleGit(cwd);
  await git.addConfig("user.name", "Version User"); await git.addConfig("user.email", "versions@example.test");
  writeFileSync(join(cwd, "first.md"), "First saved file");
  await versions.save("workspace", { message: "First version" });
  expect((await versions.status("workspace")).versions[0]).toMatchObject({ message: "First version", files: 1 });
});

it("notifies when Git changes its index without changing Workspace files", async () => {
  const test = await setup();
  writeFileSync(join(test.cwd, "note.md"), "First"); await test.versions.save("workspace", { message: "First" });
  writeFileSync(join(test.cwd, "note.md"), "Second"); await test.versions.save("workspace", { message: "Second" });
  const onChange = vi.fn();
  const versions = createVersionsModule({ resolveWorkspace: () => ({ cwd: test.cwd }), getModelContext: test.getModelContext, onChange });
  try {
    expect((await versions.status("workspace")).changedFiles).toBe(0);
    await test.git.reset(["--soft", "HEAD~1"]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith("workspace"), { timeout: 3500 });
    expect((await versions.status("workspace")).changedFiles).toBe(1);
  } finally { await versions.shutdown(); }
});

it("observes the separate Git metadata of a linked worktree", async () => {
  const test = await setup();
  writeFileSync(join(test.cwd, "note.md"), "First"); await test.versions.save("workspace", { message: "First" });
  writeFileSync(join(test.cwd, "note.md"), "Second"); await test.versions.save("workspace", { message: "Second" });
  const linked = mkdtempSync(join(tmpdir(), "wikilot-linked-versions-")); roots.push(linked);
  await test.git.raw(["worktree", "add", "-b", "linked-preview", linked]);
  const onChange = vi.fn();
  const versions = createVersionsModule({ resolveWorkspace: () => ({ cwd: linked }), getModelContext: test.getModelContext, onChange });
  try {
    expect((await versions.status("linked")).changedFiles).toBe(0);
    await simpleGit(linked).reset(["--soft", "HEAD~1"]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith("linked"), { timeout: 3500 });
    expect((await versions.status("linked")).changedFiles).toBe(1);
    expect((await test.git.status()).files).toHaveLength(0);
  } finally { await versions.shutdown(); }
});

it("restores an older version as a new commit while retaining subsequent history", async () => {
  const test = await setup();
  writeFileSync(join(test.cwd, "note.md"), "First");
  writeFileSync(join(test.cwd, "old.md"), "Earlier file");
  await test.versions.save("workspace", { message: "First version" });
  const target = (await test.git.revparse(["HEAD"])).trim();
  rmSync(join(test.cwd, "old.md"));
  writeFileSync(join(test.cwd, "later.md"), "Later file");
  writeFileSync(join(test.cwd, "note.md"), "Second");
  await test.versions.save("workspace", { message: "Second version" });
  const previous = (await test.git.revparse(["HEAD"])).trim();
  expect(await test.versions.restore("workspace", target)).toEqual({ restored: true });
  expect((await test.git.revparse(["HEAD^1"])).trim()).toBe(previous);
  expect(await test.git.revparse(["HEAD^{tree}"])).toBe(await test.git.revparse([`${target}^{tree}`]));
  expect(existsSync(join(test.cwd, "old.md"))).toBe(true);
  expect(existsSync(join(test.cwd, "later.md"))).toBe(false);
  expect((await test.versions.status("workspace")).versions).toHaveLength(3);
  expect(test.getModelContext).not.toHaveBeenCalled();
  expect(await test.versions.restore("workspace", target)).toEqual({ restored: false });
});
it("blocks restore for pending changes and protects ignored files that an old version would overwrite", async () => {
  const test = await setup();
  writeFileSync(join(test.cwd, "note.md"), "First");
  await test.versions.save("workspace", { message: "First" });
  const target = (await test.git.revparse(["HEAD"])).trim();
  writeFileSync(join(test.cwd, "note.md"), "Unsaved");
  await expect(test.versions.restore("workspace", target)).rejects.toThrow("Save your changes");
  await test.git.rm(["-f", "note.md"]);
  writeFileSync(join(test.cwd, ".gitignore"), "note.md\n");
  await test.versions.save("workspace", { message: "Remove the note" });
  writeFileSync(join(test.cwd, "note.md"), "Ignored local content");
  const before = (await test.git.revparse(["HEAD"])).trim();
  await expect(test.versions.restore("workspace", target)).rejects.toThrow();
  expect((await test.git.revparse(["HEAD"])).trim()).toBe(before);
  expect((await test.git.status()).files).toHaveLength(0);
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(join(test.cwd, "note.md"), "utf8")).toBe("Ignored local content");
});

it("rejects invalid restore targets and reports a failed commit without discarding history", async () => {
  const test = await setup();
  writeFileSync(join(test.cwd, "note.md"), "First"); await test.versions.save("workspace", { message: "First" });
  const target = (await test.git.revparse(["HEAD"])).trim();
  writeFileSync(join(test.cwd, "note.md"), "Second"); await test.versions.save("workspace", { message: "Second" });
  const previous = (await test.git.revparse(["HEAD"])).trim();
  await expect(test.versions.restore("workspace", "--all")).rejects.toThrow("Invalid version");
  await expect(test.versions.restore("workspace", "0".repeat(40))).rejects.toThrow("current history");
  await test.git.addConfig("user.name", "");
  await expect(test.versions.restore("workspace", target)).rejects.toThrow("Files restored, but the version could not be saved");
  expect((await test.git.revparse(["HEAD"])).trim()).toBe(previous);
  expect(await test.git.show([":note.md"])).toBe("First");
  expect((await test.git.log()).all).toHaveLength(2);
});

it.each(["note ", " note", "line\nbreak", "back\\slash"])("protects ignored local content with exact filename %j", async name => {
  const test = await setup();
  writeFileSync(join(test.cwd, name), "Old");
  await test.versions.save("workspace", { message: "Old version" });
  const target = (await test.git.revparse(["HEAD"])).trim();
  await test.git.rm(["--", name]);
  await test.versions.save("workspace", { message: "Remove the old file" });
  writeFileSync(join(test.cwd, ".gitignore"), "*\n");
  writeFileSync(join(test.cwd, name), "Local content that must remain");
  const head = await test.git.revparse(["HEAD"]);
  await expect(test.versions.restore("workspace", target)).rejects.toThrow("ignored files");
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(join(test.cwd, name), "utf8")).toBe("Local content that must remain");
  expect(await test.git.revparse(["HEAD"])).toBe(head);
});
it("browses current staged, unstaged and new file changes without changing the index or history", async () => {
  const { cwd, git, versions, getModelContext } = await setup();
  writeFileSync(join(cwd, "note.md"), "original\n");
  writeFileSync(join(cwd, "removed.md"), "remove me\n");
  await versions.save("workspace", { message: "Initial" });
  writeFileSync(join(cwd, "note.md"), "staged\n"); await git.add("note.md");
  writeFileSync(join(cwd, "note.md"), "current\n");
  rmSync(join(cwd, "removed.md"));
  writeFileSync(join(cwd, "new name .md"), "new content\n");
  const index = await git.diff(["--cached"]);
  const head = await git.revparse("HEAD");
  expect(await versions.changes("workspace")).toEqual([
    { path: "new name .md", kind: "Added" }, { path: "note.md", kind: "Modified" }, { path: "removed.md", kind: "Deleted" },
  ]);
  const note = await versions.fileDiff("workspace", "note.md");
  expect(note.patch).toContain("-original\n+current"); expect(note.patch).not.toContain("+staged");
  expect((await versions.fileDiff("workspace", "new name .md")).patch).toContain("+new content");
  expect((await versions.fileDiff("workspace", "removed.md")).patch).toContain("-remove me");
  await expect(versions.fileDiff("workspace", "../outside")).rejects.toThrow("no longer changed");
  expect(await git.diff(["--cached"])).toBe(index); expect(await git.revparse("HEAD")).toBe(head);
  expect(getModelContext).not.toHaveBeenCalled();
});
it("previews initial files, binary markers, exact paths and symlinks with bounded output", async () => {
  const { symlinkSync } = await import("node:fs");
  const { cwd, git, versions } = await setup();
  const name = ":(glob)* .md ";
  writeFileSync(join(cwd, name), "exact path\n");
  writeFileSync(join(cwd, "binary"), Buffer.from([0, 1, 2]));
  writeFileSync(join(cwd, "large"), "x".repeat(300_000));
  symlinkSync("/etc/passwd", join(cwd, "link"));
  expect((await versions.fileDiff("workspace", name)).patch).toContain("+exact path");
  expect((await versions.fileDiff("workspace", "binary")).patch).toContain("Binary files");
  expect((await versions.fileDiff("workspace", "large")).unavailable).toContain("too large");
  const link = await versions.fileDiff("workspace", "link");
  expect(link.patch).toContain("+/etc/passwd"); expect(link.patch).not.toContain("root:");
  expect((await git.status()).staged).toEqual([]);
});
it("counts renamed paths consistently and does not preview content removed before the first save", async () => {
  const { cwd, git, versions } = await setup();
  writeFileSync(join(cwd, "gone"), "temporary\n"); await git.add("gone"); rmSync(join(cwd, "gone"));
  expect((await versions.fileDiff("workspace", "gone")).patch).toBe("");
  writeFileSync(join(cwd, "old"), "same content\n"); await versions.save("workspace", { message: "Initial" });
  await git.mv("old", "new");
  expect((await versions.status("workspace")).changedFiles).toBe((await versions.changes("workspace")).length);
});
it("does not expand an untracked embedded repository as a directory diff", async () => {
  const { mkdirSync } = await import("node:fs");
  const { cwd, versions } = await setup();
  const nested = join(cwd, "nested"); mkdirSync(nested); await simpleGit(nested).init();
  writeFileSync(join(nested, "private.txt"), "Nested content");
  const [file] = await versions.changes("workspace");
  const preview = await versions.fileDiff("workspace", file.path);
  expect(preview.unavailable).toContain("directory"); expect(preview.patch).toBe("");
});
it("compares a recreated staged deletion with the saved file as one current change", async () => {
  const { cwd, git, versions } = await setup();
  writeFileSync(join(cwd, "note.md"), "original\n"); await versions.save("workspace", { message: "Initial" });
  await git.rm("note.md"); writeFileSync(join(cwd, "note.md"), "replacement\n");
  expect(await versions.changes("workspace")).toEqual([{ path: "note.md", kind: "Modified" }]);
  const patch = await versions.fileDiff("workspace", "note.md");
  expect(patch.patch).toContain("-original\n+replacement");
  expect(await git.show(["HEAD:note.md"])).toBe("original\n");
  expect((await git.status()).deleted).toContain("note.md");
});
it.each([
  "Plain text", '{"message":""}', '{"message":"  "}', '{"message":42}',
  '{"message":"Valid","extra":true}', '{"title":"Wrong field"}', '[]', 'null',
])("retains changes and history when schema output is invalid: %s", async (text) => {
  const { cwd, git, versions, getModelContext } = await setup();
  writeFileSync(join(cwd, "note.md"), "Initial"); await versions.save("workspace", { message: "Initial version" });
  const head = await git.revparse("HEAD"); writeFileSync(join(cwd, "note.md"), "Pending");
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const model = runtime.getModels().find(model => model.api === "openai-completions" && !model.reasoning)!;
  getModelContext.mockResolvedValue({ runtime, settings: { model: { provider: model.provider, model: model.id, thinkingLevel: "off" } } });
  const complete = vi.spyOn(runtime, "completeSimple").mockImplementation(async (_model, _context, options) => {
    await options?.onPayload?.({}, model);
    return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  });
  await expect(versions.save("workspace", {})).rejects.toThrow("invalid version message");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(await git.revparse("HEAD")).toBe(head); expect(await git.show([":note.md"])).toBe("Pending");
});
it.each(["unconstrained", "truncated", "unsupported"])("does not commit %s model output", async mode => {
  const { cwd, git, versions, getModelContext } = await setup();
  writeFileSync(join(cwd, "note.md"), "Pending");
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const model = runtime.getModels().find(model => model.api === "openai-completions" && !model.reasoning)!;
  getModelContext.mockResolvedValue({ runtime, settings: { model: { provider: model.provider, model: model.id, thinkingLevel: "off" } } });
  if (mode === "unsupported") vi.spyOn(runtime, "getModel").mockReturnValue({ ...model, api: "unknown-api" });
  const complete = vi.spyOn(runtime, "completeSimple").mockImplementation(async (_model, _context, options) => {
    if (mode !== "unconstrained") await options?.onPayload?.({}, model);
    return { role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text: '{"message":"Complete JSON"}' }], stopReason: mode === "truncated" ? "length" : "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  });
  await expect(versions.save("workspace", {})).rejects.toThrow(mode === "unsupported" ? "unsupported protocol" : "schema-constrained");
  expect(complete).toHaveBeenCalledTimes(mode === "unsupported" ? 0 : 1);
  expect((await versions.status("workspace")).versions).toEqual([]); expect(await git.show([":note.md"])).toBe("Pending");
});
