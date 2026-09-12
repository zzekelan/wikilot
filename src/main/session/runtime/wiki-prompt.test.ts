import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadWikiPromptFragment,
  resolveWikiPromptEnabled,
} from "./wiki-prompt";

const assetPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "prompts",
  "llm-wiki.md",
);

describe("resolveWikiPromptEnabled", () => {
  it("defaults to on when omitted or undefined", () => {
    expect(resolveWikiPromptEnabled(undefined)).toBe(true);
  });

  it("honors an explicit boolean", () => {
    expect(resolveWikiPromptEnabled(true)).toBe(true);
    expect(resolveWikiPromptEnabled(false)).toBe(false);
  });
});

describe("loadWikiPromptFragment", () => {
  it("loads the shipped idea-file asset verbatim", () => {
    const expected = readFileSync(assetPath, "utf8");
    expect(expected.trim()).not.toBe("");
    expect(loadWikiPromptFragment()).toBe(expected);
  });
});
