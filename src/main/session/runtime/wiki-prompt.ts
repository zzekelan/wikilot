import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WIKI_PROMPT_ASSET = join(
  dirname(fileURLToPath(import.meta.url)),
  "prompts",
  "llm-wiki.md",
);

let cachedFragment: string | undefined;

/**
 * Resolve Settings LLM Wiki Prompt toggle.
 * Omitted / undefined → default on (product lock).
 */
export function resolveWikiPromptEnabled(value: boolean | undefined): boolean {
  return value !== false;
}

/** Load the App-owned idea-file text shipped beside Runtime prompt assets. */
export function loadWikiPromptFragment(): string {
  if (cachedFragment === undefined) {
    cachedFragment = readFileSync(WIKI_PROMPT_ASSET, "utf8");
  }
  return cachedFragment;
}
