import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeAbsoluteCwd } from "../workspace";
import { resolveAppSessionDir } from "./session-paths";

describe("encodeAbsoluteCwd", () => {
  it("encodes a macOS absolute path the same way Pi encodes cwd directory names", () => {
    expect(encodeAbsoluteCwd("/Users/alice/notes")).toBe("--Users-alice-notes--");
  });

  it("replaces path separators and colons with dashes", () => {
    expect(encodeAbsoluteCwd("/tmp/work:space/notes")).toBe(
      "--tmp-work-space-notes--",
    );
  });
});

describe("resolveAppSessionDir", () => {
  it("places the encoded cwd under ~/.wikilot/sessions by default", () => {
    expect(resolveAppSessionDir("/Users/alice/notes")).toBe(
      join(homedir(), ".wikilot", "sessions", "--Users-alice-notes--"),
    );
  });

  it("accepts an override sessions root for tests and custom installs", () => {
    expect(resolveAppSessionDir("/Users/alice/notes", "/tmp/wikilot-sessions")).toBe(
      join("/tmp/wikilot-sessions", "--Users-alice-notes--"),
    );
  });
});
