import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialWorkspacePaneState,
  openWorkspacePaneTab,
  setWorkspacePanePosition,
} from "../../shared/workspace";
import { createWorkspaceModule, createWorkspaceModuleWithAdapters } from "./workspace-module";

describe("WorkspaceModule", () => {
  const roots: string[] = [];
  const stops: Array<ReturnType<typeof vi.fn>> = [];

  afterEach(() => {
    for (const stop of stops.splice(0)) expect(stop).toHaveBeenCalledOnce();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "wikilot-workspace-module-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    let notify: ((paths: string[]) => void) | undefined;
    let recover: (() => void) | undefined;
    const stop = vi.fn();
    const hasActiveTurn = vi.fn(async () => false);
    const workspace = createWorkspaceModuleWithAdapters(
      { agentDir: join(root, "agent"), hasActiveTurn },
      {
        trashEntry: async path => {
          if (path.endsWith("blocked.md")) throw new Error("denied");
          const bin = join(root, "trash"); mkdirSync(bin, { recursive: true });
          renameSync(path, join(bin, path.split("/").at(-1)!));
        },
        watchFiles(_cwd, listener, onRecovery) {
          stops.push(stop);
          notify = listener;
          recover = onRecovery;
          return stop;
        },
      },
    );
    return {
      root,
      cwd,
      workspace,
      hasActiveTurn,
      notify: (paths: string[]) => notify?.(paths),
      recover: () => recover?.(),
    };
  }

  it("trashes outermost selected entries, retains failed items and rejects unsafe paths", async () => {
    const { root, cwd, workspace } = setup(); const { id } = workspace.open(cwd);
    mkdirSync(join(cwd, "folder")); writeFileSync(join(cwd, "folder/note.md"), "keep recoverable");
    writeFileSync(join(cwd, "literal[1].md"), "literal name"); writeFileSync(join(cwd, "blocked.md"), "stay");
    symlinkSync(root, join(cwd, "escape"));
    try {
      const report = await workspace.changeFiles(id, { kind: "trash", paths: ["folder/note.md", "folder", "literal[1].md", "blocked.md", "", "../outside", "escape", ".git"] });
      expect(report.trashed).toEqual(["folder", "literal[1].md"]);
      expect(report.failures.map(item => item.source)).toEqual(expect.arrayContaining(["blocked.md", "", "../outside", "escape", ".git"]));
      expect(workspace.openMarkdownDocument(id, "blocked.md")).toMatchObject({ content: "stay" });
      expect(readFileSync(join(root, "trash/folder/note.md"), "utf8")).toBe("keep recoverable");
      expect(readFileSync(join(root, "trash/literal[1].md"), "utf8")).toBe("literal name");
      expect(workspace.listFiles(id, "").entries.map(entry => entry.path)).not.toContain("folder");
    } finally { await workspace.shutdown(); }
  });

  it("imports binary files and whole directories without changing originals or merging conflicts", async () => {
    const { root, cwd, workspace } = setup();
    const { id } = workspace.open(cwd);
    const source = join(root, "source");
    mkdirSync(join(source, "bundle/nested"), { recursive: true });
    const bytes = Buffer.from([0, 255, 128, 10, 42]);
    writeFileSync(join(source, "photo.png"), bytes);
    writeFileSync(join(source, "bundle/nested/paper.pdf"), bytes);
    mkdirSync(join(cwd, "raw/bundle"));
    writeFileSync(join(cwd, "raw/bundle/keep.md"), "keep");
    writeFileSync(join(cwd, "raw/photo.png"), "existing");
    try {
      const report = await workspace.importFiles(id, "raw", [join(source, "photo.png"), join(source, "bundle")]);
      expect(report).toEqual({ created: ["raw/photo (1).png", "raw/bundle (1)"], relocated: [], failures: [] });
      expect(readFileSync(join(cwd, "raw/photo (1).png"))).toEqual(bytes);
      expect(readFileSync(join(cwd, "raw/bundle (1)/nested/paper.pdf"))).toEqual(bytes);
      expect(readFileSync(join(source, "photo.png"))).toEqual(bytes);
      expect(readFileSync(join(source, "bundle/nested/paper.pdf"))).toEqual(bytes);
      expect(readFileSync(join(cwd, "raw/photo.png"), "utf8")).toBe("existing");
      expect(workspace.listFiles(id, "raw/bundle").entries.map(entry => entry.name)).toEqual(["keep.md"]);
    } finally { await workspace.shutdown(); }
  });

  it("cleans a failed imported folder and continues the batch without following links", async () => {
    const { root, cwd, workspace } = setup();
    const { id } = workspace.open(cwd);
    const source = join(root, "sources");
    mkdirSync(join(source, "broken"), { recursive: true });
    writeFileSync(join(source, "broken/a.md"), "copied before failure");
    writeFileSync(join(source, "good.md"), "good");
    symlinkSync(join(source, "good.md"), join(source, "broken/z-link"));
    symlinkSync(join(source, "good.md"), join(source, "link"));
    mkdirSync(join(cwd, "raw/broken"));
    writeFileSync(join(cwd, "raw/broken/keep.md"), "keep");
    try {
      const report = await workspace.importFiles(id, "raw", [join(source, "broken"), join(source, "missing"), join(source, "link"), join(source, "good.md")]);
      expect(report.created).toEqual(["raw/good.md"]);
      expect(report.failures).toMatchObject([{ source: "broken", code: "invalid-path" }, { source: "missing", code: "unavailable" }, { source: "link", code: "invalid-path" }]);
      expect(workspace.listFiles(id, "raw").entries.map(entry => entry.name)).toEqual(["broken", "good.md"]);
      expect(workspace.openMarkdownDocument(id, "raw/broken/keep.md")).toMatchObject({ content: "keep" });
      expect(readFileSync(join(source, "broken/a.md"), "utf8")).toBe("copied before failure");
      expect(readFileSync(join(source, "good.md"), "utf8")).toBe("good");
    } finally { await workspace.shutdown(); }
  });

  it("gates import destinations and rejects excluded contents and recursive self-copy", async () => {
    const { root, cwd, workspace } = setup();
    const { id } = workspace.open(cwd);
    const source = join(root, "source");
    mkdirSync(join(source, "bundle/.git"), { recursive: true });
    writeFileSync(join(source, "ok.md"), "ok");
    symlinkSync(source, join(cwd, "linked"));
    try {
      for (const target of ["../source", source, "linked", ".git", "missing", "AGENTS.md"]) {
        expect(await workspace.importFiles(id, target, [join(source, "ok.md")])).toMatchObject({ created: [], failures: [{ code: "invalid-path" }] });
      }
      expect(await workspace.importFiles(id, "raw", [cwd, join(source, "bundle"), join(source, "bundle/.git")])).toMatchObject({ created: [], failures: [{ code: "invalid-path" }, { code: "invalid-path" }, { code: "invalid-path" }] });
      expect(workspace.listFiles(id, "raw").entries).toEqual([]);
      const reports = await Promise.all([workspace.importFiles(id, "", [join(source, "ok.md")]), workspace.importFiles(id, "", [join(source, "ok.md")])]);
      expect(reports.map(report => report.created)).toEqual([["ok.md"], ["ok (1).md"]]);
    } finally { await workspace.shutdown(); }
  });

  it("does not start importing when the upload has been cancelled", async () => {
    const { root, cwd, workspace } = setup();
    const { id } = workspace.open(cwd);
    const source = join(root, "cancelled.bin");
    writeFileSync(source, Buffer.from([0, 255]));
    const controller = new AbortController(); controller.abort();
    try {
      expect(await workspace.importFiles(id, "raw", [source], controller.signal)).toEqual({ created: [], relocated: [], failures: [] });
      expect(workspace.listFiles(id, "raw").entries).toEqual([]);
      expect(readFileSync(source)).toEqual(Buffer.from([0, 255]));
    } finally { await workspace.shutdown(); }
  });

  it("moves outermost selections and retains conflicts while continuing the batch", async () => {
    const { cwd, workspace } = setup();
    const { id } = workspace.open(cwd);
    mkdirSync(join(cwd, "notes")); mkdirSync(join(cwd, "target"));
    writeFileSync(join(cwd, "notes/a.md"), "nested");
    writeFileSync(join(cwd, "keep.md"), "source");
    writeFileSync(join(cwd, "target/keep.md"), "target");
    writeFileSync(join(cwd, "last.md"), "last");
    const report = await workspace.changeFiles(id, { kind: "move", paths: ["notes/a.md", "keep.md", "missing", "notes", "last.md"], destination: "target" });
    expect(report.relocated).toEqual([{ from: "notes", to: "target/notes" }, { from: "last.md", to: "target/last.md" }]);
    expect(report.failures).toMatchObject([{ source: "keep.md", code: "exists" }, { source: "missing", code: "unavailable" }]);
    expect(workspace.openMarkdownDocument(id, "target/notes/a.md")).toMatchObject({ content: "nested" });
    expect(workspace.openMarkdownDocument(id, "keep.md")).toMatchObject({ content: "source" });
    expect(workspace.openMarkdownDocument(id, "target/keep.md")).toMatchObject({ content: "target" });
    await workspace.shutdown();
  });

  it("rejects invalid destinations before starting and enforces move containment and no-ops", async () => {
    const { cwd, root, workspace } = setup();
    const { id } = workspace.open(cwd);
    mkdirSync(join(cwd, "folder/child"), { recursive: true });
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(cwd, "linked"));
    writeFileSync(join(cwd, "a.md"), "a");
    for (const destination of ["missing", "a.md", "../outside", "linked", ".git"]) {
      expect(await workspace.changeFiles(id, { kind: "move", paths: ["a.md"], destination })).toMatchObject({ relocated: [], failures: [{ code: "invalid-path" }] });
      expect(workspace.openMarkdownDocument(id, "a.md")).toMatchObject({ content: "a" });
    }
    for (const destination of ["folder", "folder/child"]) {
      expect(await workspace.changeFiles(id, { kind: "move", paths: ["folder"], destination })).toMatchObject({ relocated: [], failures: [{ source: "folder", code: "invalid-path" }] });
    }
    expect(await workspace.changeFiles(id, { kind: "move", paths: ["", "../outside", "linked"], destination: "folder" })).toMatchObject({ relocated: [], failures: [{ code: "invalid-path" }, { code: "invalid-path" }, { code: "invalid-path" }] });
    expect(await workspace.changeFiles(id, { kind: "move", paths: ["a.md", "a.md"], destination: "" })).toEqual({ created: [], relocated: [], failures: [] });
    expect(await workspace.changeFiles(id, { kind: "move", paths: ["folder/child"], destination: "" })).toEqual({ created: [], relocated: [{ from: "folder/child", to: "child" }], failures: [] });
    await workspace.shutdown();
  });

  it("waits for descendant saves before renaming a directory and never writes its old path", async () => {
    const { cwd, workspace } = setup();
    const { id } = workspace.open(cwd);
    mkdirSync(join(cwd, "notes"));
    writeFileSync(join(cwd, "notes/a.md"), "original");
    const document = workspace.openMarkdownDocument(id, "notes/a.md");
    const save = workspace.saveMarkdownDocument(id, "notes/a.md", { version: document.version!, content: "draft" });
    const change = workspace.changeFiles(id, { kind: "rename", path: "notes", name: "renamed" });
    expect((await save).outcome).toBe("saved");
    expect(await change).toEqual({ created: [], relocated: [{ from: "notes", to: "renamed" }], failures: [] });
    expect(workspace.openMarkdownDocument(id, "renamed/a.md")).toMatchObject({ content: "draft" });
    expect((await workspace.saveMarkdownDocument(id, "notes/a.md", { version: document.version!, content: "late" })).outcome).toBe("conflict");
    expect(workspace.listFiles(id, "").entries.some(entry => entry.path === "notes")).toBe(false);
    await workspace.shutdown();
  });

  it("preserves entries on rename conflicts, no-ops, invalid paths and symlink traversal", async () => {
    const { root, cwd, workspace } = setup();
    const { id } = workspace.open(cwd);
    writeFileSync(join(cwd, "a.md"), "original");
    writeFileSync(join(cwd, "b.md"), "target");
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside/a.md"), "outside");
    symlinkSync(join(root, "outside"), join(cwd, "linked"));
    symlinkSync(join(root, "missing"), join(cwd, "dangling"));
    for (const [path, name, code] of [
      ["a.md", "b.md", "exists"], ["a.md", "dangling", "exists"],
      ["a.md", "", "invalid-path"], ["a.md", "../escape", "invalid-path"],
      ["a.md", ".git", "invalid-path"], ["", "renamed", "invalid-path"],
      ["../outside/a.md", "renamed", "invalid-path"], ["linked/a.md", "renamed", "invalid-path"],
      ["absent", "renamed", "unavailable"],
    ]) {
      expect(await workspace.changeFiles(id, { kind: "rename", path: path!, name: name! })).toMatchObject({ relocated: [], failures: [{ code }] });
    }
    expect(await workspace.changeFiles(id, { kind: "rename", path: "a.md", name: "a.md" })).toEqual({ created: [], relocated: [], failures: [] });
    expect(workspace.openMarkdownDocument(id, "a.md")).toMatchObject({ content: "original" });
    expect(workspace.openMarkdownDocument(id, "b.md")).toMatchObject({ content: "target" });
    expect(readFileSync(join(root, "outside/a.md"), "utf8")).toBe("outside");
    await workspace.shutdown();
  });

  it("creates exact filenames and empty directories through the Workspace interface", async () => {
    const { cwd, workspace } = setup();
    const { id } = workspace.open(cwd);
    expect(await workspace.changeFiles(id, { kind: "create", parent: "", name: "资料", entryKind: "directory" })).toEqual({ created: ["资料"], relocated: [], failures: [] });
    expect(await workspace.changeFiles(id, { kind: "create", parent: "资料", name: "LICENSE", entryKind: "file" })).toEqual({ created: ["资料/LICENSE"], relocated: [], failures: [] });
    expect(workspace.listFiles(id, "资料").entries).toEqual([{ name: "LICENSE", path: "资料/LICENSE", kind: "file" }]);
    expect(readFileSync(join(cwd, "资料/LICENSE"), "utf8")).toBe("");
    expect((await workspace.changeFiles(id, { kind: "create", parent: "", name: "a:b", entryKind: "file" })).created).toEqual(["a:b"]);
    await workspace.shutdown();
  });

  it("rejects conflicting names, invalid paths, symlinks, exclusions and missing parents without changing disk", async () => {
    const { root, cwd, workspace } = setup();
    const { id } = workspace.open(cwd);
    writeFileSync(join(cwd, "keep"), "original");
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(cwd, "linked"));
    symlinkSync(join(root, "missing"), join(cwd, "dangling"));
    for (const [parent, name, code] of [
      ["", "keep", "exists"], ["", "dangling", "exists"],
      ["", "", "invalid-path"], ["", "..", "invalid-path"],
      ["", "a/b", "invalid-path"], ["", "a\\b", "invalid-path"],
      ["", "bad\nname", "invalid-path"], ["", ".git", "invalid-path"],
      ["node_modules", "new", "invalid-path"], ["../outside", "new", "invalid-path"],
      [root, "new", "invalid-path"], ["linked", "new", "invalid-path"],
      ["absent/nested", "new", "unavailable"], ["keep", "new", "unavailable"],
    ]) {
      for (const entryKind of ["file", "directory"] as const) {
        expect(await workspace.changeFiles(id, { kind: "create", parent: parent!, name: name!, entryKind })).toMatchObject({ created: [], failures: [{ code }] });
      }
    }
    expect(readFileSync(join(cwd, "keep"), "utf8")).toBe("original");
    expect(readdirSync(join(root, "outside"))).toEqual([]);
    expect(workspace.listFiles(id, "").entries.some(entry => entry.name === "absent")).toBe(false);
    await workspace.shutdown();
  });

  it("opens, persists, resolves, and removes a Workspace through explicit identity", async () => {
    const { cwd, workspace, hasActiveTurn } = setup();
    const opened = workspace.open(cwd);

    expect(opened.cwd).toBe(realpathSync(cwd));
    expect(workspace.resolve(opened.id)).toEqual(opened);
    expect(await workspace.listKnown()).toEqual({
      workspaces: [
        expect.objectContaining({
          id: opened.id,
          cwd: opened.cwd,
          hasActiveTurn: false,
        }),
      ],
      launchCwd: opened.cwd,
    });

    workspace.rememberSession(opened.id, "session-1");
    expect((await workspace.listKnown()).workspaces[0]?.selectedSessionId).toBe("session-1");
    workspace.forgetSession(opened.id, "session-1");
    expect((await workspace.listKnown()).workspaces[0]?.selectedSessionId).toBeUndefined();

    await workspace.removeKnown(opened.id);
    expect(hasActiveTurn).toHaveBeenCalledWith(opened.id);
    expect((await workspace.listKnown()).workspaces).toEqual([]);
    expect(readdirSync(cwd).sort()).toEqual(["AGENTS.md", "raw", "wiki"]);
    await workspace.shutdown();
  });

  it("initializes an empty Workspace before listing files and building its index", async () => {
    const { cwd, workspace } = setup();
    const opened = workspace.open(cwd);
    expect(workspace.listFiles(opened.id, "").entries.map((entry) => entry.name).sort())
      .toEqual(["AGENTS.md", "raw", "wiki"]);
    expect(readdirSync(join(cwd, "raw"))).toEqual([]);
    expect(readdirSync(join(cwd, "wiki")).sort())
      .toEqual(["INDEX.md", "LOG.md", "concept", "entity", "source", "synthesis"]);
    for (const directory of ["source", "concept", "entity", "synthesis"]) {
      expect(readdirSync(join(cwd, "wiki", directory))).toEqual([]);
    }
    for (const path of ["AGENTS.md", "wiki/INDEX.md", "wiki/LOG.md"]) {
      expect(readFileSync(join(cwd, path))).toHaveLength(0);
    }
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id).status).toBe("ready"));
    expect(workspace.getGraph(opened.id)).toMatchObject({
      status: "ready",
      nodes: expect.arrayContaining([
        expect.objectContaining({ path: "AGENTS.md" }),
        expect.objectContaining({ path: "wiki/INDEX.md" }),
        expect.objectContaining({ path: "wiki/LOG.md" }),
      ]),
    });
    await workspace.shutdown();
  });

  it.each(["notes.md", "AGENTS.md", ".DS_Store", "raw"])(
    "adds missing structure while preserving existing %s",
    async (name) => {
      const { cwd, workspace } = setup();
      if (name === "raw") mkdirSync(join(cwd, name));
      else writeFileSync(join(cwd, name), "existing content");
      workspace.open(cwd);
      expect(readdirSync(cwd).sort()).toEqual([...new Set(["AGENTS.md", "raw", "wiki", name])].sort());
      expect(readFileSync(join(cwd, "wiki/INDEX.md"), "utf8")).toBe("");
      expect(readFileSync(join(cwd, "wiki/LOG.md"), "utf8")).toBe("");
      if (name !== "raw") expect(readFileSync(join(cwd, name), "utf8")).toBe("existing content");
      await workspace.shutdown();
    },
  );

  it("preserves edits and restores missing structure when reopening a Workspace", async () => {
    const { cwd, workspace } = setup();
    const opened = workspace.open(cwd);
    writeFileSync(join(cwd, "AGENTS.md"), "Workspace rules");
    writeFileSync(join(cwd, "wiki/INDEX.md"), "Existing index");
    unlinkSync(join(cwd, "wiki/LOG.md"));
    rmSync(join(cwd, "wiki/entity"), { recursive: true });
    expect(workspace.open(cwd)).toEqual(opened);
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toBe("Workspace rules");
    expect(readFileSync(join(cwd, "wiki/INDEX.md"), "utf8")).toBe("Existing index");
    expect(readFileSync(join(cwd, "wiki/LOG.md"), "utf8")).toBe("");
    writeFileSync(join(cwd, "wiki/LOG.md"), "Existing log");
    workspace.open(cwd);
    expect(readFileSync(join(cwd, "wiki/LOG.md"), "utf8")).toBe("Existing log");
    expect(readdirSync(join(cwd, "wiki")).sort())
      .toEqual(["INDEX.md", "LOG.md", "concept", "entity", "source", "synthesis"]);
    await workspace.shutdown();
  });

  it("guards Known Workspace removal while a Turn is active", async () => {
    const { cwd, workspace, hasActiveTurn } = setup();
    const opened = workspace.open(cwd);
    hasActiveTurn.mockResolvedValue(true);

    await expect(workspace.removeKnown(opened.id)).rejects.toThrow(/active Turn/i);
    expect((await workspace.listKnown()).workspaces).toHaveLength(1);
    await workspace.shutdown();
  });

  it.each(["raw", "wiki", "wiki/source", "AGENTS.md", "wiki/INDEX.md"])(
    "preserves a conflicting %s and can retry after it is moved aside",
    async (path) => {
      const { cwd, workspace } = setup();
      if (path.startsWith("wiki/")) mkdirSync(join(cwd, "wiki"));
      if (path.endsWith(".md")) mkdirSync(join(cwd, path));
      else writeFileSync(join(cwd, path), "keep this");
      expect(() => workspace.open(cwd)).toThrow(/Cannot initialize Workspace/);
      expect((await workspace.listKnown()).workspaces).toEqual([]);
      if (!path.endsWith(".md")) expect(readFileSync(join(cwd, path), "utf8")).toBe("keep this");
      renameSync(join(cwd, path), join(cwd, "preserved"));
      workspace.open(cwd);
      expect(readFileSync(join(cwd, "wiki/LOG.md"), "utf8")).toBe("");
      await workspace.shutdown();
    },
  );

  it("does not initialize through an existing wiki symlink", async () => {
    const { root, cwd, workspace } = setup();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(cwd, "wiki"));
    expect(() => workspace.open(cwd)).toThrow(/wiki.*not a directory/);
    expect(readdirSync(outside)).toEqual([]);
    expect((await workspace.listKnown()).workspaces).toEqual([]);
    await workspace.shutdown();
  });

  it("lists ordinary files while excluding noise and every symlink", async () => {
    const { root, cwd, workspace } = setup();
    mkdirSync(join(cwd, "notes"));
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, "node_modules"));
    writeFileSync(join(cwd, "notes", "page.md"), "# page\n");
    writeFileSync(join(cwd, ".DS_Store"), "noise");
    writeFileSync(join(cwd, ".git", "index"), "noise");
    writeFileSync(join(cwd, "node_modules", "package.js"), "noise");
    writeFileSync(join(root, "outside.md"), "secret");
    symlinkSync(join(root, "outside.md"), join(cwd, "outside-link.md"));
    symlinkSync(join(cwd, "notes"), join(cwd, "notes-link"));
    const opened = workspace.open(cwd);

    expect(workspace.listFiles(opened.id, "").entries).toEqual([
      { name: "notes", path: "notes", kind: "directory" },
      { name: "raw", path: "raw", kind: "directory" },
      { name: "wiki", path: "wiki", kind: "directory" },
      { name: "AGENTS.md", path: "AGENTS.md", kind: "file" },
    ]);
    expect(() => workspace.openMarkdownDocument(opened.id, "outside-link.md")).toThrow(/symlink/i);
    expect(() => workspace.listFiles(opened.id, "notes-link")).toThrow(/symlink/i);
    await workspace.shutdown();
  });

  it("opens only .md documents as complete versioned UTF-8 snapshots", async () => {
    const { cwd, workspace } = setup();
    writeFileSync(join(cwd, "notes.MD"), "# notes\n");
    writeFileSync(join(cwd, "legacy.markdown"), "# legacy\n");
    writeFileSync(join(cwd, "broken.md"), Buffer.from([0xc3, 0x28]));
    const opened = workspace.open(cwd);

    const snapshot = workspace.openMarkdownDocument(opened.id, "notes.MD");
    expect(snapshot).toEqual({
      path: "notes.MD",
      status: "ready",
      version: expect.any(String),
      size: 8,
      content: "# notes\n",
    });
    expect(snapshot.version).not.toContain("notes");
    expect(workspace.openMarkdownDocument(opened.id, "broken.md")).toEqual({
      path: "broken.md",
      status: "non-utf8",
      version: expect.any(String),
      size: 2,
    });
    expect(() => workspace.openMarkdownDocument(opened.id, "legacy.markdown")).toThrow(
      /\.md/i,
    );
    writeFileSync(join(cwd, "large.md"), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
    expect(workspace.openMarkdownDocument(opened.id, "large.md")).toEqual({
      path: "large.md",
      status: "too-large",
      version: expect.any(String),
      size: 2 * 1024 * 1024 + 1,
    });
    await workspace.shutdown();
  }, 10_000);

  it("atomically saves a complete Markdown document and rejects a stale version with disk wins", async () => {
    const { cwd, workspace } = setup();
    writeFileSync(join(cwd, "notes.md"), "first\n");
    const opened = workspace.open(cwd);
    const first = workspace.openMarkdownDocument(opened.id, "notes.md");
    if (first.status !== "ready") throw new Error("expected ready snapshot");

    const saved = await workspace.saveMarkdownDocument(opened.id, "notes.md", {
      version: first.version,
      content: "second\n",
    });
    expect(saved.outcome).toBe("saved");
    expect(saved.snapshot).toEqual(
      expect.objectContaining({ status: "ready", content: "second\n" }),
    );
    expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("second\n");
    expect(readdirSync(cwd).sort()).toEqual(["AGENTS.md", "notes.md", "raw", "wiki"]);
    if (saved.outcome !== "saved") throw new Error("expected saved result");

    writeFileSync(join(cwd, "notes.md"), "external\n");
    const conflict = await workspace.saveMarkdownDocument(opened.id, "notes.md", {
      version: saved.snapshot.version,
      content: "stale local\n",
    });
    expect(conflict).toEqual({
      outcome: "conflict",
      snapshot: expect.objectContaining({
        status: "ready",
        content: "external\n",
      }),
    });
    expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("external\n");
    await workspace.shutdown();
  });

  it("serializes concurrent saves for one Markdown path", async () => {
    const { cwd, workspace } = setup();
    writeFileSync(join(cwd, "notes.md"), "zero\n");
    const opened = workspace.open(cwd);
    const snapshot = workspace.openMarkdownDocument(opened.id, "notes.md");
    if (snapshot.status !== "ready") throw new Error("expected ready snapshot");

    const [first, second] = await Promise.all([
      workspace.saveMarkdownDocument(opened.id, "./notes.md", {
        version: snapshot.version,
        content: "one\n",
      }),
      workspace.saveMarkdownDocument(opened.id, "notes.md", {
        version: snapshot.version,
        content: "two\n",
      }),
    ]);

    expect(first.outcome).toBe("saved");
    expect(second.outcome).toBe("conflict");
    expect(readFileSync(join(cwd, "notes.md"), "utf8")).toBe("one\n");
    await workspace.shutdown();
  });

  it("observes stable final snapshots for self, external, and Agent-style real filesystem writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "wikilot-workspace-real-watch-"));
    roots.push(root);
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "notes.md"), "zero\n");
    const workspace = createWorkspaceModule({
      agentDir: join(root, "agent"),
      hasActiveTurn: async () => false,
    });
    const opened = workspace.open(cwd);

    function nextNotesChange(): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error("timed out waiting for notes.md watcher event"));
        }, 5_000);
        const unsubscribe = workspace.subscribe((event) => {
          if (event.type !== "workspace_files_changed" || !event.paths.includes("notes.md")) return;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        });
      });
    }

    try {
      const initial = workspace.openMarkdownDocument(opened.id, "notes.md");
      if (initial.status !== "ready") throw new Error("expected ready snapshot");
      const ownEcho = nextNotesChange();
      const ownSave = await workspace.saveMarkdownDocument(opened.id, "notes.md", {
        version: initial.version,
        content: "self\n",
      });
      await ownEcho;
      expect(workspace.openMarkdownDocument(opened.id, "notes.md")).toEqual(
        ownSave.snapshot,
      );

      const externalChange = nextNotesChange();
      writeFileSync(join(cwd, "notes.md"), "external\n");
      await externalChange;
      expect(workspace.openMarkdownDocument(opened.id, "notes.md")).toEqual(
        expect.objectContaining({ status: "ready", content: "external\n" }),
      );

      const agentChange = nextNotesChange();
      const temporary = join(cwd, ".notes.md.agent.tmp");
      writeFileSync(temporary, "agent final\n");
      renameSync(temporary, join(cwd, "notes.md"));
      await agentChange;
      expect(workspace.openMarkdownDocument(opened.id, "notes.md")).toEqual(
        expect.objectContaining({ status: "ready", content: "agent final\n" }),
      );
    } finally {
      await workspace.shutdown();
    }
  }, 15_000);

  it("recovers a real filesystem save after the document directory becomes writable", async () => {
    const { cwd, workspace } = setup();
    const directory = join(cwd, "locked");
    const path = join(directory, "notes.md");
    mkdirSync(directory);
    writeFileSync(path, "before\n");
    const opened = workspace.open(cwd);
    const snapshot = workspace.openMarkdownDocument(opened.id, "locked/notes.md");
    if (snapshot.status !== "ready") throw new Error("expected ready snapshot");

    chmodSync(directory, 0o500);
    try {
      await expect(workspace.saveMarkdownDocument(opened.id, "locked/notes.md", {
        version: snapshot.version,
        content: "after\n",
      })).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe("before\n");
    } finally {
      chmodSync(directory, 0o700);
    }

    const recovered = await workspace.saveMarkdownDocument(opened.id, "locked/notes.md", {
      version: snapshot.version,
      content: "after\n",
    });
    expect(recovered).toEqual(expect.objectContaining({ outcome: "saved" }));
    expect(readFileSync(path, "utf8")).toBe("after\n");
    await workspace.shutdown();
  });

  it("publishes one coherent Link Index revision with parsed Markdown facts", async () => {
    const { cwd, workspace } = setup();
    mkdirSync(join(cwd, "notes"));
    writeFileSync(join(cwd, "Target.md"), "# Heading\n\n## My Heading\n");
    writeFileSync(join(cwd, "foo(bar.md"), "# Escaped\n");
    writeFileSync(join(cwd, "manual.pdf"), "%PDF-1.7\n");
    writeFileSync(
      join(cwd, "notes", "source.md"),
      [
        "---",
        "aliases: [Source Alias]",
        "tags: [alpha, beta]",
        'nested: "[[Target]]"',
        "count: 2",
        "published: 2024-01-02",
        "featured: true",
        "details:",
        "  owner: Ada",
        "---",
        "# Intro",
        "[Standard](../Target.md#Heading)",
        "[Encoded](../Target.md#My%20Heading)",
        "[Escaped](../foo\\(bar.md)",
        "[Nested [[Ignored]]](../Target.md)",
        "[[Target|Label]]",
        "![[manual.pdf#page=3]]",
        "`[[ignored-inline]]`",
        "<!-- [[ignored-comment]] -->",
        "```md",
        "[[ignored-fence]]",
        "```",
        "Body #gamma",
      ].join("\n"),
    );

    const opened = workspace.open(cwd);
    expect(workspace.getLinkIndex(opened.id)).toEqual({ status: "building" });

    await vi.waitFor(() => {
      expect(workspace.getLinkIndex(opened.id).status).toBe("ready");
    });
    const snapshot = workspace.getLinkIndex(opened.id);
    expect(snapshot).toMatchObject({ status: "ready", revision: 1 });
    if (snapshot.status !== "ready") throw new Error("Link Index did not finish");

    const source = snapshot.records.find((record) => record.path === "notes/source.md");
    expect(snapshot.propertyRegistry).toEqual([
      { name: "aliases", type: "list" },
      { name: "tags", type: "list" },
      { name: "nested", type: "text" },
      { name: "count", type: "number" },
      { name: "published", type: "date" },
      { name: "featured", type: "checkbox" },
    ]);
    expect(source).toMatchObject({
      parseStatus: "parsed",
      headings: [{
        depth: 1,
        text: "Intro",
        slug: "intro",
        range: {
          start: { line: 11, column: 1, offset: 141 },
          end: { line: 11, column: 8, offset: 148 },
        },
      }],
      aliases: ["Source Alias"],
      tags: ["alpha", "beta", "gamma"],
      diagnostics: [],
    });
    expect(source?.references).toHaveLength(7);
    expect(source?.references.map((reference) => reference.authoredTarget)).toEqual([
      "Target",
      "../Target.md",
      "../Target.md",
      "../foo(bar.md",
      "../Target.md",
      "Target",
      "manual.pdf",
    ]);
    expect(source?.references[2]?.target).toEqual({
      status: "resolved",
      path: "Target.md",
      kind: "markdown",
      heading: "My Heading",
    });
    const escaped = source?.references[3];
    expect(escaped?.target).toMatchObject({ status: "resolved", path: "foo(bar.md" });
    expect(escaped && source).toBeTruthy();
    if (escaped) {
      const raw = readFileSync(join(cwd, "notes", "source.md"), "utf8");
      expect(raw.slice(escaped.targetRange.start.offset, escaped.targetRange.end.offset))
        .toBe("../foo\\(bar.md");
    }
    expect(source?.references.some((reference) => reference.authoredTarget === "Ignored")).toBe(false);
    expect(source?.references[5]).toMatchObject({
      kind: "link",
      syntax: "wikilink",
      originalText: "[[Target|Label]]",
      displayText: "Label",
      range: {
        start: { line: 16, column: 1 },
        end: { line: 16, column: 17 },
      },
      targetRange: {
        start: { line: 16, column: 3 },
        end: { line: 16, column: 9 },
      },
      target: { status: "resolved", path: "Target.md", kind: "markdown" },
    });
    expect(source?.references[6]).toMatchObject({
      kind: "embed",
      subpath: { kind: "pdf-page", value: "3" },
      target: { status: "resolved", path: "manual.pdf", kind: "pdf", page: 3 },
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    await workspace.shutdown();
  });

  it("projects the complete Markdown corpus into an aggregated directed Graph", async () => {
    const { cwd, workspace } = setup();
    mkdirSync(join(cwd, "one"));
    mkdirSync(join(cwd, "two"));
    writeFileSync(join(cwd, "one", "Same.md"), "# One\n");
    writeFileSync(join(cwd, "two", "Same.md"), "# Two\n");
    writeFileSync(join(cwd, "isolate.md"), "# Isolate\n");
    writeFileSync(join(cwd, "manual.pdf"), "%PDF-1.7\n");
    writeFileSync(
      join(cwd, "source.md"),
      [
        "[one](one/Same.md)",
        "![[one/Same]]",
        "[[two/Same]]",
        "[[source]]",
        "[[missing]]",
        "[[manual.pdf]]",
      ].join("\n"),
    );

    const opened = workspace.open(cwd);
    expect(workspace.getGraph(opened.id)).toEqual({ status: "building" });
    await vi.waitFor(() => expect(workspace.getGraph(opened.id).status).toBe("ready"));

    expect(workspace.getGraph(opened.id)).toEqual({
      status: "ready",
      revision: 1,
      nodes: [
        { path: "AGENTS.md", label: "AGENTS", degree: 0, referenceCount: 0 },
        { path: "isolate.md", label: "isolate", degree: 0, referenceCount: 0 },
        { path: "one/Same.md", label: "Same · one/", degree: 1, referenceCount: 2 },
        { path: "source.md", label: "source", degree: 2, referenceCount: 3 },
        { path: "two/Same.md", label: "Same · two/", degree: 1, referenceCount: 1 },
        { path: "wiki/INDEX.md", label: "INDEX", degree: 0, referenceCount: 0 },
        { path: "wiki/LOG.md", label: "LOG", degree: 0, referenceCount: 0 },
      ],
      edges: [
        {
          source: "source.md",
          target: "one/Same.md",
          occurrenceCount: 2,
          kindCounts: { link: 1, image: 0, embed: 1 },
        },
        {
          source: "source.md",
          target: "two/Same.md",
          occurrenceCount: 1,
          kindCounts: { link: 1, image: 0, embed: 0 },
        },
      ],
    });
    await workspace.shutdown();
  });

  it("surfaces Graph build failures and retries explicitly", async () => {
    const { cwd, workspace } = setup();
    writeFileSync(join(cwd, "note.md"), "# Note\n");
    const opened = workspace.open(cwd);
    rmSync(cwd, { recursive: true });

    await vi.waitFor(() => expect(workspace.getGraph(opened.id)).toEqual({
      status: "error",
      code: "index-build-failed",
    }));
    mkdirSync(cwd);
    writeFileSync(join(cwd, "recovered.md"), "# Recovered\n");
    workspace.retryGraph(opened.id);
    expect(workspace.getGraph(opened.id)).toEqual({ status: "retrying" });
    await vi.waitFor(() => expect(workspace.getGraph(opened.id)).toMatchObject({
      status: "ready",
      revision: 1,
      nodes: [expect.objectContaining({ path: "recovered.md" })],
    }));
    await workspace.shutdown();
  });

  it("isolates malformed frontmatter and unreadable Markdown by file", async () => {
    const { cwd, workspace } = setup();
    writeFileSync(join(cwd, "Target.md"), "# Target\n");
    writeFileSync(
      join(cwd, "bad-frontmatter.md"),
      "---\naliases: [broken\n---\n[Target](Target.md)\n",
    );
    writeFileSync(join(cwd, "invalid.md"), Buffer.from([0xff, 0xfe, 0x00]));
    const opened = workspace.open(cwd);
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id).status).toBe("ready"));
    const snapshot = workspace.getLinkIndex(opened.id);
    if (snapshot.status !== "ready") throw new Error("Link Index did not finish");

    const malformed = snapshot.records.find((record) => record.path === "bad-frontmatter.md");
    expect(malformed).toMatchObject({
      parseStatus: "parsed",
      aliases: [],
      diagnostics: [{ code: "frontmatter-invalid-yaml", stage: "frontmatter" }],
      references: [{ target: { status: "resolved", path: "Target.md" } }],
    });
    expect(snapshot.records.find((record) => record.path === "invalid.md")).toMatchObject({
      parseStatus: "unreadable",
      references: [],
      diagnostics: [{ code: "markdown-invalid-utf8", stage: "read" }],
    });
    await workspace.shutdown();
  });

  it("resolves every authored target deterministically without guessing", async () => {
    const { cwd, workspace } = setup();
    mkdirSync(join(cwd, "folder"));
    mkdirSync(join(cwd, "other"));
    writeFileSync(join(cwd, "Alpha.md"), "---\naliases: [Legacy Alpha]\n---\n# Known\n");
    writeFileSync(join(cwd, "other", "alpha.md"), "# Other\n");
    writeFileSync(join(cwd, "folder", "Relative.md"), "# Relative\n");
    writeFileSync(join(cwd, "manual.pdf"), "%PDF-1.7\n");
    writeFileSync(
      join(cwd, "folder", "source.md"),
      [
        "# Local",
        "[[Alpha]]",
        "[[Legacy Alpha]]",
        "[[ALPHA]]",
        "[relative](Relative.md)",
        "[root](/Alpha.md)",
        "[[#Local]]",
        "[[Alpha#Known]]",
        "[[Alpha#Missing]]",
        "[[Alpha#^block]]",
        "[[manual.pdf#page=2]]",
        "[[manual]]",
        "[[folder/New Note]]",
        "[[./Sibling]]",
        "[[../../escape]]",
        "[bad](%ZZ)",
      ].join("\n"),
    );

    const opened = workspace.open(cwd);
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id).status).toBe("ready"));
    const snapshot = workspace.getLinkIndex(opened.id);
    if (snapshot.status !== "ready") throw new Error("Link Index did not finish");
    const references = snapshot.records.find(
      (record) => record.path === "folder/source.md",
    )?.references;

    expect(references?.map(({ authoredTarget, target }) => [authoredTarget, target])).toEqual([
      ["Alpha", { status: "resolved", path: "Alpha.md", kind: "markdown" }],
      ["Legacy Alpha", { status: "missing", creationSuggestion: { path: "Legacy Alpha.md" } }],
      ["ALPHA", { status: "ambiguous", candidates: ["Alpha.md", "other/alpha.md"] }],
      ["Relative.md", { status: "resolved", path: "folder/Relative.md", kind: "markdown" }],
      ["/Alpha.md", { status: "resolved", path: "Alpha.md", kind: "markdown" }],
      ["", { status: "resolved", path: "folder/source.md", kind: "markdown", heading: "Local" }],
      ["Alpha", { status: "resolved", path: "Alpha.md", kind: "markdown", heading: "Known" }],
      ["Alpha", { status: "resolved", path: "Alpha.md", kind: "markdown" }],
      ["Alpha", { status: "resolved", path: "Alpha.md", kind: "markdown" }],
      ["manual.pdf", { status: "resolved", path: "manual.pdf", kind: "pdf", page: 2 }],
      ["manual", { status: "missing", creationSuggestion: { path: "manual.md" } }],
      ["folder/New Note", { status: "missing", creationSuggestion: { path: "folder/New Note.md" } }],
      ["./Sibling", { status: "missing", creationSuggestion: { path: "folder/Sibling.md" } }],
      ["../../escape", { status: "invalid", reason: "workspace-escape" }],
      ["%ZZ", { status: "invalid", reason: "invalid-url-encoding" }],
    ]);
    await workspace.shutdown();
  });

  it("publishes file batches as atomic Link Index revisions and retries after failure", async () => {
    const { cwd, workspace, notify } = setup();
    mkdirSync(join(cwd, "other"));
    writeFileSync(join(cwd, "source.md"), "[[Target]]\n");
    writeFileSync(join(cwd, "Target.md"), "# Target\n");
    const opened = workspace.open(cwd);
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({
      status: "ready",
      revision: 1,
    }));

    writeFileSync(join(cwd, "other", "Target.md"), "# Duplicate\n");
    notify(["other/Target.md"]);
    expect(workspace.getLinkIndex(opened.id)).toMatchObject({ status: "ready", revision: 1 });
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({
      status: "ready",
      revision: 2,
    }));
    let snapshot = workspace.getLinkIndex(opened.id);
    if (snapshot.status !== "ready") throw new Error("Link Index did not finish");
    expect(snapshot.records.find((record) => record.path === "source.md")?.references[0]?.target)
      .toEqual({ status: "ambiguous", candidates: ["other/Target.md", "Target.md"] });

    rmSync(join(cwd, "Target.md"));
    notify(["Target.md"]);
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({
      status: "ready",
      revision: 3,
    }));
    snapshot = workspace.getLinkIndex(opened.id);
    if (snapshot.status !== "ready") throw new Error("Link Index did not finish");
    expect(snapshot.records.find((record) => record.path === "source.md")?.references[0]?.target)
      .toEqual({ status: "resolved", path: "other/Target.md", kind: "markdown" });

    writeFileSync(join(cwd, "renamed.md"), "[[Target]]\n");
    rmSync(join(cwd, "source.md"));
    notify(["source.md", "renamed.md"]);
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({
      status: "ready",
      revision: 4,
    }));
    snapshot = workspace.getLinkIndex(opened.id);
    if (snapshot.status !== "ready") throw new Error("Link Index did not finish");
    expect(snapshot.records.map((record) => record.path)).toEqual([
      "AGENTS.md",
      "other/Target.md",
      "renamed.md",
      "wiki/INDEX.md",
      "wiki/LOG.md",
    ]);

    notify(["renamed.md"]);
    rmSync(cwd, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(workspace.getLinkIndex(opened.id)).toMatchObject({ status: "ready", revision: 4 });

    mkdirSync(cwd);
    writeFileSync(join(cwd, "recovered.md"), "# Recovered\n");
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({
      status: "ready",
      revision: 5,
      records: [expect.objectContaining({ path: "recovered.md" })],
    }));
    await workspace.shutdown();
  });

  it("serializes consecutive Link Index batches into monotonic revisions", async () => {
    const { cwd, workspace, notify } = setup();
    writeFileSync(join(cwd, "one.md"), "# One\n");
    const opened = workspace.open(cwd);
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({ revision: 1 }));

    writeFileSync(join(cwd, "two.md"), "# Two\n");
    notify(["two.md"]);
    writeFileSync(join(cwd, "three.md"), "# Three\n");
    notify(["three.md"]);

    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({
      status: "ready",
      revision: 3,
    }));
    await workspace.shutdown();
  });

  it("rebuilds the complete Link Index after watcher recovery", async () => {
    const { cwd, workspace, recover } = setup();
    writeFileSync(join(cwd, "before.md"), "# Before\n");
    const opened = workspace.open(cwd);
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({ revision: 1 }));

    rmSync(join(cwd, "before.md"));
    writeFileSync(join(cwd, "after.md"), "# After\n");
    recover();

    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({
      status: "ready",
      revision: 2,
      records: [
        expect.objectContaining({ path: "after.md" }),
        expect.objectContaining({ path: "AGENTS.md" }),
        expect.objectContaining({ path: "wiki/INDEX.md" }),
        expect.objectContaining({ path: "wiki/LOG.md" }),
      ],
    }));
    await workspace.shutdown();
  });

  it("resolves Timeline links from the Workspace root and creates only contained Markdown without overwrite", async () => {
    const { root, cwd, workspace } = setup();
    mkdirSync(join(cwd, "notes"));
    writeFileSync(join(cwd, "notes", "Target.md"), "# Target\n");
    const opened = workspace.open(cwd);
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({ revision: 1 }));

    expect(workspace.resolveLink(opened.id, {
      syntax: "markdown",
      authoredTarget: "notes/Target.md",
    })).toEqual({
      status: "ready",
      revision: 1,
      target: { status: "resolved", path: "notes/Target.md", kind: "markdown" },
    });
    for (const [syntax, authoredTarget] of [
      ["markdown", "/notes/Target.md"],
      ["wikilink", "/notes/Target"],
      ["wikilink", "C:\\notes\\Target.md"],
      ["wikilink", "\\\\server\\share\\Target.md"],
    ] as const) {
      expect(workspace.resolveLink(opened.id, { syntax, authoredTarget })).toMatchObject({
        target: { status: "invalid", reason: "absolute-path" },
      });
    }
    expect(workspace.resolveLink(opened.id, {
      syntax: "wikilink",
      authoredTarget: "../escape",
    })).toMatchObject({ target: { status: "invalid", reason: "workspace-escape" } });

    workspace.createMarkdown(opened.id, "notes/New.md");
    expect(workspace.openMarkdownDocument(opened.id, "notes/New.md")).toMatchObject({
      path: "notes/New.md",
      status: "ready",
      content: "",
    });
    expect(() => workspace.createMarkdown(opened.id, "notes/New.md")).toThrow(/exists/i);
    expect(readFileSync(join(cwd, "notes", "New.md"), "utf8")).toBe("");
    writeFileSync(join(cwd, "notes", "Conflict.md"), "keep me\n");
    expect(() => workspace.createMarkdown(opened.id, "notes/Conflict.md")).toThrow(/exists/i);
    expect(readFileSync(join(cwd, "notes", "Conflict.md"), "utf8")).toBe("keep me\n");
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(cwd, "linked"));
    expect(() => workspace.createMarkdown(opened.id, "linked/Escape.md")).toThrow(/symlink/i);
    expect(() => workspace.createMarkdown(opened.id, "../escape.md")).toThrow(/escape/i);
    await vi.waitFor(() => expect(workspace.getLinkIndex(opened.id)).toMatchObject({ revision: 2 }));
    await workspace.shutdown();
  });

  it.each([
    ["absolute", "/etc/passwd"],
    ["Windows absolute", "C:\\Windows\\system.ini"],
    ["UNC absolute", "\\\\server\\share\\file.md"],
    ["Windows rooted absolute", "\\Windows\\system.ini"],
    ["control character", "notes/line\nfeed.md"],
    ["traversal", "notes/../secret.md"],
  ])("rejects %s Renderer paths", async (_case, path) => {
    const { cwd, workspace } = setup();
    mkdirSync(join(cwd, "notes"));
    const opened = workspace.open(cwd);

    expect(() => workspace.openMarkdownDocument(opened.id, path)).toThrow(/path|Workspace|control/i);
    await workspace.shutdown();
  });

  it("filters watcher noise and symlink traversal before emitting JSON-safe events", async () => {
    const { root, cwd, workspace, notify } = setup();
    mkdirSync(join(cwd, "notes"));
    writeFileSync(join(cwd, "notes", "page.md"), "# page\n");
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "secret.md"), "secret");
    symlinkSync(join(root, "outside"), join(cwd, "linked"));
    const opened = workspace.open(cwd);
    const listener = vi.fn();
    const unsubscribe = workspace.subscribe(listener);

    notify([
      "notes/page.md",
      ".git/index",
      "node_modules/pkg/index.js",
      ".DS_Store",
      "linked/secret.md",
      "../outside/secret.md",
      "notes/bad\u0000name.md",
    ]);

    expect(listener).toHaveBeenCalledWith({
      type: "workspace_files_changed",
      workspaceId: opened.id,
      paths: ["notes/page.md"],
    });
    expect(() => JSON.stringify(listener.mock.calls[0]?.[0])).not.toThrow();

    listener.mockClear();
    rmSync(join(cwd, "linked"));
    notify(["linked", "linked/secret.md"]);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    await workspace.shutdown();
  });

  it("backs up malformed Known Workspace persistence and warns once", async () => {
    const { root, cwd, workspace } = setup();
    workspace.open(cwd);
    writeFileSync(join(root, "agent", "workspaces.json"), "{ broken", "utf8");

    expect((await workspace.listKnown()).warning).toMatch(/malformed/i);
    expect((await workspace.listKnown()).warning).toBeUndefined();
    expect(
      readdirSync(join(root, "agent")).some(
        (name) => name.startsWith("workspaces.json.") && name.endsWith(".corrupt"),
      ),
    ).toBe(true);
    await workspace.shutdown();
  });

  it("persists, restores, and drops Pane state separately from Known Workspace metadata", async () => {
    const { root, cwd, workspace } = setup();
    const opened = workspace.open(cwd);
    let state = initialWorkspacePaneState();
    state = openWorkspacePaneTab(state, "notes/page.md");
    state = setWorkspacePanePosition(state, "notes/page.md", 128);
    state = { ...state, visible: false };
    workspace.savePaneState(opened.id, state);

    expect(workspace.loadPaneState(opened.id)).toEqual({ state, skipped: 0 });
    // Pane snapshots live in their own document; Known Workspace metadata is untouched.
    expect(readdirSync(join(root, "agent"))).toEqual(["pane-state.json", "workspaces.json"]);
    expect((await workspace.listKnown()).workspaces[0]?.selectedSessionId).toBeUndefined();

    await workspace.removeKnown(opened.id);
    expect(workspace.loadPaneState(opened.id)).toEqual({
      state: initialWorkspacePaneState(),
      skipped: 0,
    });
    expect(readdirSync(cwd).sort()).toEqual(["AGENTS.md", "raw", "wiki"]);
    await workspace.shutdown();
  });

  it("restores Pane state for a Known Workspace that is not open in this process", async () => {
    const { root, cwd, workspace } = setup();
    const opened = workspace.open(cwd);
    let state = initialWorkspacePaneState();
    state = { ...openWorkspacePaneTab(state, "a.md"), visible: false };
    workspace.savePaneState(opened.id, state);
    await workspace.shutdown();

    const second = createWorkspaceModuleWithAdapters(
      { agentDir: join(root, "agent"), hasActiveTurn: async () => false },
      { watchFiles: () => () => {} },
    );
    expect(second.loadPaneState(opened.id).state).toEqual(state);
    await second.shutdown();
  });

  it("validates stored Pane items per item and self-heals the snapshot", async () => {
    const { root, cwd, workspace } = setup();
    const opened = workspace.open(cwd);
    writeFileSync(
      join(root, "agent", "pane-state.json"),
      JSON.stringify({
        version: 1,
        panes: {
          [opened.cwd]: {
            version: 4,
            tabs: ["a.md", "../escape.md"],
            activePath: "a.md",
            mru: ["a.md"],
            positions: { "a.md": 24 },
            modes: { "a.md": "editing" },
            editorSelections: { "a.md": { anchor: 4, head: 4 } },
            pdfViews: {},
            visible: true,
            readingMode: "normal",
            history: ["a.md"],
            historyIndex: 0,
          },
        },
      }),
      "utf8",
    );

    const result = workspace.loadPaneState(opened.id);
    expect(result.state).toEqual({
      tabs: ["a.md"],
      activePath: "a.md",
      mru: ["a.md"],
      positions: { "a.md": 24 },
      modes: { "a.md": "editing" },
      editorSelections: { "a.md": { anchor: 4, head: 4 } },
      pdfViews: {},
      visible: true,
      readingMode: "normal",
      history: ["a.md"],
      historyIndex: 0,
    });
    expect(result.skipped).toBe(1);
    // The cleaned snapshot is persisted back so a later load reports zero.
    expect(workspace.loadPaneState(opened.id).skipped).toBe(0);
    await workspace.shutdown();
  });

  it("backs up a fully corrupt Pane document, warns once, and resets", async () => {
    const { root, cwd, workspace } = setup();
    const opened = workspace.open(cwd);
    writeFileSync(join(root, "agent", "pane-state.json"), "{ broken", "utf8");

    expect(workspace.loadPaneState(opened.id).warning).toMatch(/malformed/i);
    expect(workspace.loadPaneState(opened.id).warning).toBeUndefined();
    expect(
      readdirSync(join(root, "agent")).some(
        (name) => name.startsWith("pane-state.json.") && name.endsWith(".corrupt"),
      ),
    ).toBe(true);
    await workspace.shutdown();
  });

  it("drops a per-Workspace corrupt Pane snapshot without touching its siblings", async () => {
    const { root, cwd, workspace } = setup();
    const opened = workspace.open(cwd);
    writeFileSync(
      join(root, "agent", "pane-state.json"),
      JSON.stringify({
        version: 1,
        panes: {
          [opened.cwd]: { version: 99, tabs: [] },
          "/work/other": {
            version: 4,
            tabs: ["ok.md"],
            activePath: "ok.md",
            mru: ["ok.md"],
            positions: {},
            modes: { "ok.md": "reading" },
            editorSelections: {},
            pdfViews: {},
            visible: true,
            readingMode: "normal",
            history: ["ok.md"],
            historyIndex: 0,
          },
        },
      }),
      "utf8",
    );

    expect(workspace.loadPaneState(opened.id)).toEqual({
      state: initialWorkspacePaneState(),
      skipped: 0,
      warning: expect.stringMatching(/malformed|reset/i),
    });
    expect(workspace.loadPaneState(opened.id).warning).toBeUndefined();
    expect(
      readdirSync(join(root, "agent")).some((name) => name.endsWith(".corrupt")),
    ).toBe(false);
    await workspace.shutdown();
  });

  it("serves a versioned PDF source in ranges and rejects stale or unsafe sources", async () => {
    const { cwd, workspace } = setup();
    const bytes = Buffer.from("%PDF-1.4\n");
    writeFileSync(join(cwd, "paper.pdf"), bytes);
    const opened = workspace.open(cwd);

    const source = workspace.openPdf(opened.id, "paper.pdf");
    expect(source).toEqual({
      sourceId: expect.not.stringContaining("paper.pdf"),
      version: expect.any(String),
      size: bytes.length,
      mediaType: "application/pdf",
    });
    await expect(workspace.readPdfRange(source.sourceId, 1, 4, new AbortController().signal)).resolves.toEqual({
      ...source,
      start: 1,
      end: 4,
      bytes: new Uint8Array(bytes.subarray(1, 5)),
    });

    workspace.releasePdfSource(source.sourceId);
    workspace.releasePdfSource(source.sourceId);
    expect(() => workspace.getPdfSource(source.sourceId)).toThrow(
      expect.objectContaining({ code: "unavailable" }),
    );
    await expect(workspace.readPdfRange(source.sourceId, 0, 1, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining({ code: "unavailable" }),
    );

    const changedSource = workspace.openPdf(opened.id, "paper.pdf");
    writeFileSync(join(cwd, "paper.pdf"), "%PDF-1.7\nchanged");
    await expect(workspace.readPdfRange(changedSource.sourceId, 0, 1, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining({ code: "source-changed" }),
    );

    const replacement = join(cwd, "outside.pdf");
    writeFileSync(replacement, bytes);
    unlinkSync(join(cwd, "paper.pdf"));
    expect(() => workspace.openPdf(opened.id, "paper.pdf")).toThrow(
      expect.objectContaining({ code: "deleted" }),
    );
    symlinkSync(replacement, join(cwd, "paper.pdf"));
    await expect(workspace.readPdfRange(changedSource.sourceId, 0, 1, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining({ code: "unavailable" }),
    );
    await workspace.shutdown();
  });

  it("rejects PDFs above the 500 MiB product limit before creating a source", async () => {
    const { cwd, workspace } = setup();
    const path = join(cwd, "huge.pdf");
    writeFileSync(path, "%PDF-1.4\n");
    truncateSync(path, 500 * 1024 * 1024 + 1);
    const opened = workspace.open(cwd);

    expect(() => workspace.openPdf(opened.id, "huge.pdf")).toThrow(
      expect.objectContaining({ code: "too-large" }),
    );
    await workspace.shutdown();
  });
});
