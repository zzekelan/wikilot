import { describe, expect, it } from "vitest";
import type { SessionSkill } from "../../shared/workspace";
import {
  composerCommandQuery,
  filterComposerCommands,
} from "./composer-commands";

describe("composer commands", () => {
  it("recognizes a command only at the start of the draft", () => {
    expect(composerCommandQuery("/model")).toBe("model");
    expect(composerCommandQuery("/skill:research ")).toBeNull();
    expect(composerCommandQuery("  /wiki")).toBeNull();
    expect(composerCommandQuery("read /model later")).toBeNull();
  });

  it("filters commands with subsequence matching", () => {
    expect(filterComposerCommands("md").map((command) => command.id)).toEqual([
      "model",
    ]);
    expect(filterComposerCommands("thg").map((command) => command.id)).toEqual([
      "thinking",
    ]);
  });

  it("prioritizes an identifier match over a description-only match", () => {
    expect(filterComposerCommands("th")[0]?.id).toBe("thinking");
  });

  it("includes the resource reload command and discovered Skills", () => {
    const skills: SessionSkill[] = [
      { name: "research", description: "Investigate a question" },
    ];

    expect(filterComposerCommands("rel").map((command) => command.id)).toEqual([
      "reload",
    ]);
    expect(filterComposerCommands("research", skills)).toEqual([
      expect.objectContaining({
        id: "skill:research",
        kind: "skill",
        label: "/skill:research",
      }),
    ]);
  });
});
