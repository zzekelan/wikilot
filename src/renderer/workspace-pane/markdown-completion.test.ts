import { CompletionContext } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import type { WorkspaceLinkIndexSnapshot } from "../../shared/workspace";
import { workspaceLinkCompletion } from "./markdown-completion";

const index: WorkspaceLinkIndexSnapshot = {
  status: "ready",
  revision: 9,
  propertyRegistry: [],
  targets: [
    { path: "Alpha.md", kind: "markdown" },
    { path: "Archive.md", kind: "markdown" },
    { path: "notes/Beta.md", kind: "markdown" },
    { path: "manual.pdf", kind: "pdf" },
    { path: "image.png", kind: "file" },
  ],
  records: [
    {
      path: "Alpha.md",
      headings: [
        { depth: 1, text: "Overview", slug: "overview", range: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 11, offset: 10 } } },
        { depth: 2, text: "Operations", slug: "operations", range: { start: { line: 2, column: 1, offset: 11 }, end: { line: 2, column: 14, offset: 24 } } },
      ],
      aliases: [],
      tags: [],
      references: [],
      parseStatus: "parsed",
      diagnostics: [],
    },
    {
      path: "Archive.md", headings: [], aliases: [], tags: [], references: [],
      parseStatus: "parsed", diagnostics: [],
    },
    {
      path: "notes/Beta.md", headings: [], aliases: ["Atlas"], tags: [], references: [],
      parseStatus: "parsed", diagnostics: [],
    },
  ],
};

function complete(text: string, mru: string[] = []) {
  const state = EditorState.create({ doc: text, extensions: [markdown()] });
  return workspaceLinkCompletion(new CompletionContext(state, text.length, false), index, mru);
}

describe("Workspace wikilink completion", () => {
  it("orders exact prefixes by open-tab MRU and then path", () => {
    const result = complete("[[A", ["Archive.md"]);
    expect(result?.options.slice(0, 3).map((option) => option.label)).toEqual([
      "Archive",
      "Alpha",
      "Atlas",
    ]);
    expect(result?.options.slice(0, 3).map((option) => option.detail)).toEqual([
      "markdown | Archive.md",
      "markdown | Alpha.md",
      "alias | notes/Beta.md",
    ]);
    expect(complete("[[Bet")?.options[0]?.label).toBe("notes/Beta");
  });

  it("provides canonical, alias, and PDF insertion actions", () => {
    expect(typeof complete("[[Al")?.options.find((option) => option.label === "Alpha")?.apply)
      .toBe("function");
    expect(typeof complete("[[Atl")?.options[0]?.apply).toBe("function");
    expect(typeof complete("[[man")?.options[0]?.apply).toBe("function");
    expect(complete("[[im")).toBeNull();
  });

  it("offers headings only after a canonical Markdown target and hash", () => {
    const result = complete("[[Alpha#Op");
    expect(result?.options.map((option) => option.label)).toEqual(["Operations"]);
    expect(typeof result?.options[0]?.apply).toBe("function");
  });

  it("does not complete wikilink examples inside Markdown code", () => {
    expect(complete("`[[A`")).toBeNull();
    expect(complete("```md\n[[A\n```")).toBeNull();
  });
});
