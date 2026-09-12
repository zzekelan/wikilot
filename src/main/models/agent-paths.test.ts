import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultAgentDir, resolveAuthPath } from "./agent-paths";

describe("Wikilot Agent data paths", () => {
  it("defaults to ~/.wikilot/agent", () => {
    expect(defaultAgentDir({})).toBe(join(homedir(), ".wikilot", "agent"));
  });

  it("honors the WIKILOT_AGENT_DIR override", () => {
    expect(defaultAgentDir({ WIKILOT_AGENT_DIR: "/tmp/wikilot-acc/agent" })).toBe(
      "/tmp/wikilot-acc/agent",
    );
    expect(
      resolveAuthPath(defaultAgentDir({ WIKILOT_AGENT_DIR: " /tmp/x " })),
    ).toBe("/tmp/x/auth.json");
  });
});
