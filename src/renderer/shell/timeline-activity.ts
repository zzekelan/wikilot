import type {
  AssistantPart,
  TimelineItem,
  ToolPart,
} from "../../shared/timeline";
import { normalizeToolName, formatToolDisplayName } from "./tool-labels";

/** Render model for one assistant message: parts, tool groups, or a folded activity summary. */
export type RenderEntry =
  | { kind: "part"; part: AssistantPart; index: number }
  | { kind: "group"; toolName: string; label: string; parts: ToolPart[] }
  | {
      kind: "folded";
      label: string;
      parts: AssistantPart[];
      index: number;
      children: RenderEntry[];
    };

function isGroupable(part: AssistantPart): part is ToolPart {
  return part.kind === "tool" && part.status !== "running";
}

/** "Ran 12.5s · used Read, Shell" / "Thought for 3.0s". */
export function buildCompletedActivityLabel(
  parts: AssistantPart[],
  now: number = Date.now(),
): string {
  const tools = parts.filter((part): part is ToolPart => part.kind === "tool");
  const starts = parts.map((part) => part.at);
  const ends = parts.map((part) =>
    part.kind === "text" ? part.at : (part.endedAt ?? now),
  );
  const duration =
    starts.length > 0
      ? Math.max(0, Math.max(...ends) - Math.min(...starts)) / 1000
      : 0;
  const seconds = duration.toFixed(1);
  if (tools.length === 0) return `Thought for ${seconds}s`;
  const names = [...new Map(tools.map((part) => [
    normalizeToolName(part.toolName), formatToolDisplayName(part.toolName),
  ])).values()];
  return `Ran ${seconds}s · used ${names.join(", ")}`;
}

/**
 * Project assistant parts into render entries: fold completed activity before
 * `foldBeforeIndex` into a summary row, and group ≥2 consecutive completed
 * same-name tools. The final text part and running tools never fold.
 */
export function buildRenderEntries(
  parts: AssistantPart[],
  options: { foldBeforeIndex?: number; now?: number } = {},
): RenderEntry[] {
  const { foldBeforeIndex = -1, now = Date.now() } = options;
  const folded: AssistantPart[] = [];
  const rest: { part: AssistantPart; index: number }[] = [];

  parts.forEach((part, index) => {
    const isFinalText = index === parts.length - 1 && part.kind === "text";
    const isRunningTool = part.kind === "tool" && part.status === "running";
    if (index < foldBeforeIndex && !isFinalText && !isRunningTool) {
      folded.push(part);
    } else {
      rest.push({ part, index });
    }
  });

  const entries: RenderEntry[] = [];
  if (folded.length > 0) {
    // Each reasoning starts a new activity round. Only the final-answer fold
    // wraps those sibling rounds; a round never contains earlier rounds.
    const rounds: AssistantPart[][] = [];
    for (const part of folded) {
      if (rounds.length === 0 || part.kind === "reasoning") rounds.push([]);
      rounds[rounds.length - 1].push(part);
    }
    const finalFold = foldBeforeIndex >= parts.length && parts.at(-1)?.kind === "text";
    let index = 0;
    const children: RenderEntry[] = rounds.flatMap((round, roundIndex) => {
      const start = index;
      index += round.length;
      const contents = buildRenderEntries(round, { now });
      // The last round's reasoning remains alongside the completed rounds.
      if (finalFold && roundIndex === rounds.length - 1) return contents;
      return [{
        kind: "folded" as const,
        label: buildCompletedActivityLabel(round, now),
        parts: round,
        index: start,
        children: contents,
      }];
    });
    if (finalFold) {
      entries.push({
        kind: "folded",
        label: buildCompletedActivityLabel(folded, now),
        parts: folded,
        index: -1,
        children,
      });
    } else {
      entries.push(...children);
    }
  }

  let cursor = 0;
  while (cursor < rest.length) {
    const current = rest[cursor];
    if (isGroupable(current.part)) {
      const group: ToolPart[] = [current.part];
      const name = normalizeToolName(current.part.toolName);
      let lookahead = cursor + 1;
      while (
        lookahead < rest.length &&
        isGroupable(rest[lookahead].part) &&
        normalizeToolName((rest[lookahead].part as ToolPart).toolName) === name
      ) {
        group.push(rest[lookahead].part as ToolPart);
        lookahead += 1;
      }
      if (group.length >= 2) {
        entries.push({
          kind: "group",
          toolName: current.part.toolName,
          label: formatToolDisplayName(current.part.toolName),
          parts: group,
        });
        cursor = lookahead;
        continue;
      }
    }
    entries.push({ kind: "part", part: current.part, index: current.index });
    cursor += 1;
  }
  return entries;
}

/** Merge consecutive assistant messages that only contain tool activity (D9). */
export function mergeToolOnlyAssistantItems(items: TimelineItem[]): TimelineItem[] {
  const merged: TimelineItem[] = [];
  for (const item of items) {
    const previous = merged.at(-1);
    const toolOnly =
      item.kind === "assistant" &&
      item.parts.length > 0 &&
      item.parts.every((part) => part.kind === "tool");
    if (
      toolOnly &&
      previous?.kind === "assistant" &&
      previous.parts.length > 0 &&
      previous.parts.every((part) => part.kind === "tool")
    ) {
      merged[merged.length - 1] = {
        ...previous,
        parts: [...previous.parts, ...(item.kind === "assistant" ? item.parts : [])],
      };
      continue;
    }
    merged.push(item);
  }
  return merged;
}
