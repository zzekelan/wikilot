// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitWorkspaceFilesChanged } from "../client/workspace-file-events";
import { FileTree } from "./FileTree";

const fake = vi.hoisted(() => ({
  listWorkspaceFiles: vi.fn(),
}));

vi.mock("../client", () => ({
  client: {
    listWorkspaceFiles: fake.listWorkspaceFiles,
  },
}));

describe("FileTree", () => {
  beforeEach(() => {
    fake.listWorkspaceFiles.mockReset();
    fake.listWorkspaceFiles.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
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
