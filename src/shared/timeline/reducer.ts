import type { TimelineDelta, TimelineItem, ToolPart } from "./types";

type AssistantItem = Extract<TimelineItem, { kind: "assistant" }>;

function lastAssistant(items: TimelineItem[]): AssistantItem | undefined {
  const last = items.at(-1);
  return last?.kind === "assistant" ? last : undefined;
}

function replaceLast(items: TimelineItem[], next: TimelineItem): TimelineItem[] {
  return [...items.slice(0, -1), next];
}

function appendDelta(
  items: TimelineItem[],
  kind: "text" | "reasoning",
  delta: string,
  at: number,
): TimelineItem[] {
  const current = lastAssistant(items);
  if (!current) {
    return [...items, { kind: "assistant", at, parts: [{ kind, text: delta, at }] }];
  }
  const lastPart = current.parts.at(-1);
  if (lastPart?.kind === kind) {
    return replaceLast(items, {
      ...current,
      parts: [...current.parts.slice(0, -1), { ...lastPart, text: lastPart.text + delta }],
    });
  }
  const parts = current.parts.map((part) =>
    part.kind === "reasoning" && part.endedAt === undefined
      ? { ...part, endedAt: at }
      : part,
  );
  return replaceLast(items, { ...current, parts: [...parts, { kind, text: delta, at }] });
}

function updateToolPart(
  items: TimelineItem[],
  toolCallId: string,
  update: (part: ToolPart) => ToolPart,
): TimelineItem[] {
  for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
    const item = items[itemIndex];
    if (item.kind !== "assistant") continue;
    const partIndex = item.parts.findIndex(
      (part) => part.kind === "tool" && part.toolCallId === toolCallId,
    );
    if (partIndex < 0) continue;
    const part = item.parts[partIndex] as ToolPart;
    const parts = [
      ...item.parts.slice(0, partIndex),
      update(part),
      ...item.parts.slice(partIndex + 1),
    ];
    return [...items.slice(0, itemIndex), { ...item, parts }, ...items.slice(itemIndex + 1)];
  }
  return items;
}

/** Fold one live Delta into renderable Timeline items. */
export function reduceTimelineDelta(
  items: TimelineItem[],
  delta: TimelineDelta,
  at: number,
): TimelineItem[] {
  switch (delta.type) {
    case "user_message":
      return [...items, {
        kind: "user",
        text: delta.text,
        ...(delta.command ? { command: delta.command } : {}),
        ...(delta.clips?.length ? { clips: delta.clips } : {}),
        at,
      }];
    case "assistant_text_delta":
      return appendDelta(items, "text", delta.delta, at);
    case "assistant_thinking_delta":
      return appendDelta(items, "reasoning", delta.delta, at);
    case "tool_start": {
      const part: ToolPart = {
        kind: "tool",
        toolCallId: delta.toolCallId,
        toolName: delta.toolName,
        status: "running",
        ...(delta.args !== undefined ? { args: delta.args } : {}),
        at,
      };
      const current = lastAssistant(items);
      if (!current) return [...items, { kind: "assistant", at, parts: [part] }];
      return replaceLast(items, { ...current, parts: [...current.parts, part] });
    }
    case "tool_update":
      return updateToolPart(items, delta.toolCallId, (part) =>
        delta.progress !== undefined
          ? { ...part, progress: delta.progress }
          : part,
      );
    case "tool_end":
      return updateToolPart(items, delta.toolCallId, (part) => ({
        ...part,
        status: delta.isError ? "error" : "done",
        endedAt: at,
        ...(delta.result !== undefined ? { result: delta.result } : {}),
      }));
    case "error":
      return [...items, { kind: "error", message: delta.message, at }];
    default:
      return items;
  }
}
