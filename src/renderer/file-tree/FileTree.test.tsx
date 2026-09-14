// @vitest-environment jsdom
import type { ReactElement } from "react";
import { ToastProvider } from "../feedback";

import { act, cleanup, fireEvent, render as renderUI, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitWorkspaceFilesChanged } from "../client/workspace-file-events";
import { FileTree } from "./FileTree";

const render = (ui: ReactElement) => renderUI(<ToastProvider>{ui}</ToastProvider>);

const fake = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
  changeWorkspaceFiles: vi.fn(),
  uploadWorkspaceFiles: vi.fn(),
}));

vi.mock("../client", () => ({
  client: {
    listWorkspaceFiles: fake.listWorkspaceFiles,
    changeWorkspaceFiles: fake.changeWorkspaceFiles,
    uploadWorkspaceFiles: fake.uploadWorkspaceFiles,
  },
}));

describe("FileTree", () => {
  beforeEach(() => {
    fake.uploadWorkspaceFiles.mockReset();
    fake.uploadWorkspaceFiles.mockResolvedValue({ created: [], relocated: [], failures: [] });
    fake.changeWorkspaceFiles.mockReset();
    fake.changeWorkspaceFiles.mockResolvedValue({ created: [], relocated: [], failures: [] });
    fake.listWorkspaceFiles.mockReset();
    fake.listWorkspaceFiles.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("moves the right-clicked multi-selection to Trash and offers no root deletion", async () => {
    fake.listWorkspaceFiles.mockResolvedValue(["a.md", "b.md"].map(path => ({ path, name: path, kind: "file" })));
    const trash = vi.fn().mockResolvedValue({ status: "completed", report: { created: [], relocated: [], trashed: ["a.md", "b.md"], failures: [] } });
    render(<FileTree workspaceId="w" activePath={null} onOpenFile={vi.fn()} onTrash={trash} />);
    const first = await screen.findByRole("button", { name: "a.md" });
    fireEvent.click(first); fireEvent.click(screen.getByRole("button", { name: "b.md" }), { metaKey: true });
    fireEvent.contextMenu(first);
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to Trash" }));
    await waitFor(() => expect(trash).toHaveBeenCalledWith(["a.md", "b.md"]));
    expect((await screen.findByTestId("toast")).textContent).toBe("Moved 2 items to Trash");
    fireEvent.contextMenu(screen.getByTestId("file-tree"));
    expect(screen.queryByRole("menuitem", { name: "Move to Trash" })).toBeNull();
  });

  it("shows successful import feedback as a transient toast without leaving a File Tree status row", async () => {
    fake.uploadWorkspaceFiles.mockResolvedValue({ created: ["ok.txt"], relocated: [], failures: [] });
    render(<FileTree workspaceId="w" activePath={null} onOpenFile={vi.fn()} />);
    await screen.findByTestId("file-tree-empty");
    fireEvent.drop(document.querySelector(".file-tree-scroll")!, { dataTransfer: { items: [], files: [new File(["ok"], "ok.txt")] } });
    expect((await screen.findByTestId("toast")).textContent).toBe("Imported 1 item");
    expect(screen.getByTestId("file-tree").querySelector(".file-tree-move-report")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("toast")).toBeNull(), { timeout: 3500 });
  });

  it("continues with readable top-level items when another dropped source is unreadable", async () => {
    render(<FileTree workspaceId="w" activePath={null} onOpenFile={vi.fn()} />);
    await screen.findByTestId("file-tree-empty");
    const file = new File(["ok"], "ok.txt");
    fireEvent.drop(document.querySelector(".file-tree-scroll")!, { dataTransfer: { files: [], items: [
      { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => ({ name: "bad", isFile: true, file: (_: unknown, reject: (error: Error) => void) => reject(new Error("unreadable")) }) },
      { kind: "file", getAsFile: () => file },
    ] } });
    await waitFor(() => expect(fake.uploadWorkspaceFiles).toHaveBeenCalledWith("w", "", [{ path: "ok.txt", file }], expect.any(AbortSignal)));
    expect((await screen.findByRole("alert")).textContent).toContain("bad");
  });

  it("reads every browser directory batch, including empty directories", async () => {
    render(<FileTree workspaceId="w" activePath={null} onOpenFile={vi.fn()} />);
    await screen.findByTestId("file-tree-empty");
    const file = new File([new Uint8Array([0, 255])], "bytes.bin");
    const batches = [
      [{ name: "empty", isDirectory: true, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve([]) }) }],
      [{ name: "bytes.bin", isFile: true, file: (resolve: (file: File) => void) => resolve(file) }], [],
    ];
    const entry = { name: "bundle", isDirectory: true, createReader: () => ({ readEntries: (resolve: (entries: unknown[]) => void) => resolve(batches.shift()!) }) };
    fireEvent.drop(document.querySelector(".file-tree-scroll")!, { dataTransfer: { files: [], items: [
      { kind: "file", getAsFile: () => null, webkitGetAsEntry: () => entry },
    ] } });
    await waitFor(() => expect(fake.uploadWorkspaceFiles).toHaveBeenCalledWith("w", "", [
      { path: "bundle" }, { path: "bundle/empty" }, { path: "bundle/bytes.bin", file },
    ], expect.any(AbortSignal)));
  });

  it.each(["New file", "New folder"])("cancels an empty %s on blur without taking focus back", async action => {
    render(<><FileTree workspaceId="w" activePath={null} onOpenFile={vi.fn()} /><button>Outside</button></>);
    await screen.findByTestId("file-tree-empty");
    fireEvent.contextMenu(screen.getByTestId("file-tree"));
    fireEvent.click(screen.getByRole("menuitem", { name: action }));
    const input = screen.getByRole("textbox");
    act(() => screen.getByText("Outside").focus());
    await waitFor(() => expect(input.isConnected).toBe(false));
    expect(document.activeElement).toBe(screen.getByText("Outside"));
    expect(fake.changeWorkspaceFiles).not.toHaveBeenCalled();
  });

  it.each(["New file", "New folder"])("submits a nonempty %s on blur", async action => {
    render(<><FileTree workspaceId="w" activePath={null} onOpenFile={vi.fn()} /><button>Outside</button></>);
    await screen.findByTestId("file-tree-empty");
    fireEvent.contextMenu(screen.getByTestId("file-tree"));
    fireEvent.click(screen.getByRole("menuitem", { name: action }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "exact name" } });
    act(() => screen.getByText("Outside").focus());
    await waitFor(() => expect(fake.changeWorkspaceFiles).toHaveBeenCalledOnce());
    expect(fake.changeWorkspaceFiles).toHaveBeenCalledWith("w", { kind: "create", parent: "", name: "exact name", entryKind: action === "New file" ? "file" : "directory" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(document.activeElement).toBe(screen.getByText("Outside"));
  });

  it.each(["", "renamed.md"])("settles rename on blur with name %j", async name => {
    fake.listWorkspaceFiles.mockResolvedValue([{ path: "old.md", name: "old.md", kind: "file" }]);
    const rename = vi.fn().mockResolvedValue({ status: "completed", report: { created: [], relocated: [{ from: "old.md", to: "renamed.md" }], failures: [] } });
    render(<><FileTree workspaceId="w" activePath={null} onOpenFile={vi.fn()} onRename={rename} /><button>Outside</button></>);
    fireEvent.contextMenu(await screen.findByRole("button", { name: "old.md" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: name } });
    act(() => screen.getByText("Outside").focus());
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    if (name) expect(rename).toHaveBeenCalledWith("old.md", name);
    else expect(rename).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByText("Outside"));
  });

  it("keeps a failed blur submission editable without stealing outside focus", async () => {
    fake.changeWorkspaceFiles.mockResolvedValue({ created: [], relocated: [], failures: [{ code: "exists", message: "Already exists" }] });
    render(<><FileTree workspaceId="w" activePath={null} onOpenFile={vi.fn()} /><button>Outside</button></>);
    await screen.findByTestId("file-tree-empty");
    fireEvent.contextMenu(screen.getByTestId("file-tree"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New file" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "existing.md" } });
    act(() => screen.getByText("Outside").focus());
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox").getAttribute("value")).toBe("existing.md");
    expect(document.activeElement).toBe(screen.getByText("Outside"));
    expect(fake.changeWorkspaceFiles).toHaveBeenCalledOnce();
  });

  it("cancels a populated draft with Escape without submitting on the resulting blur", async () => {
    render(<FileTree workspaceId="w" activePath={null} onOpenFile={vi.fn()} />);
    await screen.findByTestId("file-tree-empty");
    fireEvent.contextMenu(screen.getByTestId("file-tree"));
    fireEvent.click(screen.getByRole("menuitem", { name: "New file" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "cancel.md" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(fake.changeWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("selects ranges without opening files and drags the whole selection", async () => {
    fake.listWorkspaceFiles.mockResolvedValue(["a.md", "b.md", "c.md"].map(path => ({ path, name: path, kind: "file" })));
    const open = vi.fn();
    const move = vi.fn().mockResolvedValue({ status: "completed", report: { created: [], relocated: [], failures: [] } });
    render(<FileTree workspaceId="w" activePath={null} onOpenFile={open} onMove={move} />);
    const a = await screen.findByRole("button", { name: "a.md" });
    const c = screen.getByRole("button", { name: "c.md" });
    fireEvent.click(a, { metaKey: true });
    fireEvent.click(c, { shiftKey: true });
    expect(open).not.toHaveBeenCalled();
    expect(screen.getAllByRole("treeitem").every(item => item.getAttribute("aria-selected") === "true")).toBe(true);
    const dataTransfer = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(a, { dataTransfer });
    fireEvent.dragOver(screen.getByTestId("file-tree").querySelector(".file-tree-scroll")!, { dataTransfer });
    fireEvent.drop(screen.getByTestId("file-tree").querySelector(".file-tree-scroll")!, { dataTransfer });
    await waitFor(() => expect(move).toHaveBeenCalledWith(["a.md", "b.md", "c.md"], ""));
  });

  it("refreshes automatically when Workspace files change", async () => {
    render(
      <FileTree workspaceId="workspace-a" activePath={null} onOpenFile={vi.fn()} />,
    );

    await waitFor(() => expect(fake.listWorkspaceFiles).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Refresh Files")).toBeNull();

    act(() => emitWorkspaceFilesChanged(["notes.md"]));

    await waitFor(() => expect(fake.listWorkspaceFiles).toHaveBeenCalledTimes(2));
  });
});
