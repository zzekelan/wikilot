import type {
  BuildSystemPromptOptions,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { appendContextClipSystemPromptFragments } from "./context-clip-prompt.ts";

/** Keep Pi's tool guidance while replacing its coding-assistant identity. */
function toolInstructions(options: BuildSystemPromptOptions): string {
  const tools = options.selectedTools ?? [];
  const snippets = options.toolSnippets ?? {};
  const available = tools.filter((name) => snippets[name]);
  const guidelines = new Set<string>();
  if (!tools.some((name) => ["grep", "find", "ls"].includes(name))) {
    if (tools.includes("bash") && tools.includes("powershell")) {
      guidelines.add("Use bash or PowerShell for file operations like listing, searching, and finding files");
    } else if (tools.includes("powershell")) {
      guidelines.add("Use PowerShell for file operations like listing, searching, and finding files");
    } else if (tools.includes("bash")) {
      guidelines.add("Use bash for file operations like ls, rg, find");
    }
  }
  for (const guideline of options.promptGuidelines ?? []) {
    if (guideline.trim()) guidelines.add(guideline.trim());
  }
  guidelines.add("Be concise in your responses");
  guidelines.add("Show file paths clearly when working with files");
  return [
    "Available tools:",
    available.length ? available.map((name) => `- ${name}: ${snippets[name]}`).join("\n") : "(none)",
    "",
    "In addition to the tools above, you may have access to other custom tools depending on the project.",
    "",
    "Guidelines:",
    [...guidelines].map((guideline) => `- ${guideline}`).join("\n"),
  ].join("\n");
}

export function wikilotPromptOptions(
  wikiPrompt: () => string | undefined,
): Pick<ConstructorParameters<typeof DefaultResourceLoader>[0], "systemPromptOverride" | "appendSystemPromptOverride" | "extensionFactories"> {
  return {
    systemPromptOverride: () => wikiPrompt() ??
      "You are Wikilot, a helpful assistant for local knowledge work. Help users read, research, organize, and edit files in their Workspace.",
    appendSystemPromptOverride: appendContextClipSystemPromptFragments,
    extensionFactories: [(pi) => {
      pi.on("before_agent_start", (event) => ({
        systemPrompt: `${event.systemPrompt}\n\n${toolInstructions(event.systemPromptOptions)}`,
      }));
    }],
  };
}
