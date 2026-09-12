import { describe, expect, it } from "vitest";
import { workspaceLabels } from "./workspace-labels";

describe("workspaceLabels", () => {
  it("shows only the directory name when names are unique", () => {
    const labels = workspaceLabels(["/work/notes", "/work/code"]);
    expect(labels.get("/work/notes")).toBe("notes");
    expect(labels.get("/work/code")).toBe("code");
  });

  it("appends the shortest distinguishing parent context on collisions", () => {
    const labels = workspaceLabels([
      "/clients/foo/api",
      "/clients/bar/api",
      "/work/notes",
    ]);
    expect(labels.get("/clients/foo/api")).toBe("foo/api");
    expect(labels.get("/clients/bar/api")).toBe("bar/api");
    expect(labels.get("/work/notes")).toBe("notes");
  });

  it("walks further up until colliding paths are distinguishable", () => {
    const labels = workspaceLabels([
      "/a/shared/api",
      "/b/shared/api",
      "/b/other/api",
    ]);
    expect(labels.get("/a/shared/api")).toBe("a/shared/api");
    expect(labels.get("/b/shared/api")).toBe("b/shared/api");
    expect(labels.get("/b/other/api")).toBe("other/api");
  });

  it("distinguishes every colliding entry, not just the first", () => {
    const labels = workspaceLabels(["/x/same/api", "/y/same/api"]);
    expect(labels.get("/x/same/api")).toBe("x/same/api");
    expect(labels.get("/y/same/api")).toBe("y/same/api");
  });

  it("labels the filesystem root with the raw path", () => {
    const labels = workspaceLabels(["/"]);
    expect(labels.get("/")).toBe("/");
  });
});
