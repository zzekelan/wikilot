import { describe, expect, it } from "vitest";
import type { AssistantPart, ToolPart } from "../../shared/timeline";
import {
  buildCompletedActivityLabel,
  buildRenderEntries,
  mergeToolOnlyAssistantItems,
} from "./timeline-activity";

function tool(name: string, status: ToolPart["status"] = "done", at = 1000): ToolPart {
  return {
    kind: "tool",
    toolCallId: `${name}-${at}`,
    toolName: name,
    status,
    at,
    endedAt: status === "running" ? undefined : at + 500,
  };
}

describe("buildRenderEntries", () => {
  it("renders parts in order without grouping singletons", () => {
    const parts: AssistantPart[] = [
      { kind: "text", text: "a", at: 0 },
      tool("read"),
    ];
    const entries = buildRenderEntries(parts);
    expect(entries.map((entry) => entry.kind)).toEqual(["part", "part"]);
  });

  it("groups two or more consecutive completed same-name tools", () => {
    const parts: AssistantPart[] = [tool("read", "done", 1), tool("read", "done", 2), tool("shell")];
    const entries = buildRenderEntries(parts);
    expect(entries.map((entry) => entry.kind)).toEqual(["group", "part"]);
    const [group] = entries;
    if (group.kind !== "group") throw new Error("expected group");
    expect(group.toolName).toBe("read");
    expect(group.label).toBe("Read");
    expect(group.parts).toHaveLength(2);
  });

  it("does not group running tools", () => {
    const parts: AssistantPart[] = [tool("read", "running", 1), tool("read", "done", 2)];
    const entries = buildRenderEntries(parts);
    expect(entries.map((entry) => entry.kind)).toEqual(["part", "part"]);
  });

  it("folds activity before the given index into a summary entry", () => {
    const parts: AssistantPart[] = [
      tool("read", "done", 1000),
      tool("shell", "done", 3000),
      { kind: "reasoning", text: "thinking", at: 5000 },
      { kind: "text", text: "answer", at: 6000 },
    ];
    const entries = buildRenderEntries(parts, { foldBeforeIndex: 2 });
    expect(entries.map((entry) => entry.kind)).toEqual(["folded", "part", "part"]);
    const [folded] = entries;
    if (folded.kind !== "folded") throw new Error("expected folded");
    expect(folded.parts).toHaveLength(2);
  });

  it("preserves the latest completed turn boundary inside a cumulative summary", () => {
    const parts: AssistantPart[] = [
      { kind: "reasoning", text: "first", at: 1000, endedAt: 2000 },
      tool("bash", "done", 2000),
      { kind: "reasoning", text: "final", at: 3000, endedAt: 4000 },
      { kind: "text", text: "answer", at: 4000 },
    ];

    const [folded] = buildRenderEntries(parts, { foldBeforeIndex: parts.length });
    if (folded.kind !== "folded") throw new Error("expected folded");
    const children = folded.children;
    expect(children.map((entry) => entry.kind)).toEqual(["folded", "part"]);
  });

  it("never folds the final text part or running tools", () => {
    const parts: AssistantPart[] = [
      tool("read", "running", 1000),
      { kind: "text", text: "answer", at: 2000 },
    ];
    const entries = buildRenderEntries(parts, { foldBeforeIndex: 2 });
    expect(entries.map((entry) => entry.kind)).toEqual(["part", "part"]);
  });
});

describe("buildCompletedActivityLabel", () => {
  it("summarizes duration and tool names", () => {
    const label = buildCompletedActivityLabel(
      [tool("read", "done", 1000), tool("shell", "done", 13000)],
      20000,
    );
    expect(label).toBe("Ran 12.5s · used Read, Shell");
  });

  it("falls back to reasoning duration when no tools ran", () => {
    const label = buildCompletedActivityLabel(
      [{ kind: "reasoning", text: "t", at: 1000, endedAt: 4000 }],
      5000,
    );
    expect(label).toBe("Thought for 3.0s");
  });
});

describe("mergeToolOnlyAssistantItems", () => {
  it("merges consecutive assistant items that only contain tools", () => {
    const merged = mergeToolOnlyAssistantItems([
      { kind: "user", text: "q", at: 0 },
      { kind: "assistant", at: 1, parts: [tool("read", "done", 1)] },
      { kind: "assistant", at: 2, parts: [tool("shell", "done", 2)] },
      { kind: "assistant", at: 3, parts: [{ kind: "text", text: "done", at: 3 }] },
    ]);
    expect(merged).toHaveLength(3);
    const [, tools] = merged;
    if (tools.kind !== "assistant") throw new Error("expected assistant");
    expect(tools.parts).toHaveLength(2);
  });
});
