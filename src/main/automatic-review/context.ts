import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { PROMPT_ENTRY_TYPE, readPromptRecord } from "../../shared/session/index.ts";

// Pi's context estimator uses characters / 4. Apply the same estimated-token
// budget independently to each tool result, including the omission marker.
const TOOL_RESULT_CHARS = 1000 * 4;
const OMITTED = "\n[Tool result truncated for review]\n";

function toolText(text: string): string {
  if (text.length <= TOOL_RESULT_CHARS) return text;
  const half = Math.floor((TOOL_RESULT_CHARS - OMITTED.length) / 2);
  return text.slice(0, half) + OMITTED + text.slice(-half);
}

function visibleContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter((block) => block.type !== "thinking").map((block) => {
    if (block.type === "image") {
      return { type: "text", text: "[Image unavailable in review context; do not infer its contents]" };
    }
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "toolCall") {
      return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
    }
    return block;
  });
}

/** Original ordered conversation, independent of the main model's compaction. */
export function reviewConversation(branch: SessionEntry[]): unknown[] {
  const starts = branch.flatMap((entry, index) =>
    entry.type === "custom" && entry.customType === PROMPT_ENTRY_TYPE ? [index] : [],
  );
  if (starts.length === 0) throw new Error("Automatic Review has no original user Prompt");
  const entries = branch.slice(starts[Math.max(0, starts.length - 3)]);
  const prompts = new Set<string>();
  const conversation: unknown[] = [];
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === PROMPT_ENTRY_TYPE) {
      const prompt = readPromptRecord(entry.data);
      if (!prompt) throw new Error("Automatic Review found an invalid user Prompt");
      prompts.add(entry.id);
      conversation.push({ role: "user", text: prompt.text, command: prompt.command, evidence: prompt.clips });
    } else if (entry.type === "message") {
      const message = entry.message;
      // The serialized model input is not the original user submission.
      if (message.role === "user" && entry.parentId && prompts.has(entry.parentId)) continue;
      if (message.role === "assistant") {
        conversation.push({ role: "assistant", content: visibleContent(message.content) });
      } else if (message.role === "toolResult") {
        conversation.push({ role: "toolResult", toolName: message.toolName,
          toolCallId: message.toolCallId, isError: message.isError,
          text: toolText(JSON.stringify(visibleContent(message.content))),
        });
      } else if (message.role === "user") {
        conversation.push({ role: "user", content: visibleContent(message.content),
          source: "model-context message; not an original user Prompt" });
      }
    }
  }
  return conversation;
}
