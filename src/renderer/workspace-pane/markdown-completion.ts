import {
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type {
  WorkspaceLinkIndexSnapshot,
  WorkspaceMarkdownRecord,
} from "../../shared/workspace";

type ReadyLinkIndex = Extract<WorkspaceLinkIndexSnapshot, { status: "ready" }>;

type RankedCompletion = {
  label: string;
  detail: string;
  type: "text" | "keyword";
  apply: Completion["apply"];
  rank: number;
  mru: number;
  path: string;
};

function applyWikilink(value: string, cursorInside = false): NonNullable<Completion["apply"]> {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const end = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
    const insert = `[[${value}]]`;
    view.dispatch({
      changes: { from, to: end, insert },
      selection: { anchor: from + (cursorInside ? insert.length - 2 : insert.length) },
      annotations: pickedCompletion.of(completion),
    });
  };
}

function completionIsExcluded(context: CompletionContext): boolean {
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  while (node) {
    const name = node.name.toLocaleLowerCase();
    if (name.includes("code") || name.includes("html") || name.includes("comment")) return true;
    node = node.parent!;
  }
  return false;
}

function canonicalTarget(path: string, kind: "markdown" | "pdf" | "file"): string {
  return kind === "markdown" ? path.replace(/\.md$/i, "") : path;
}

function subsequence(query: string, value: string): boolean {
  let queryIndex = 0;
  for (const character of value) {
    if (character === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return queryIndex === query.length;
}

function matchRank(query: string, value: string): number | null {
  const normalizedQuery = query.toLocaleLowerCase();
  const normalizedValue = value.toLocaleLowerCase();
  if (normalizedValue.startsWith(normalizedQuery)) return 0;
  if (subsequence(normalizedQuery, normalizedValue)) return 1;
  return null;
}

function bestMatchRank(query: string, values: string[]): number | null {
  const ranks = values.map((value) => matchRank(query, value)).filter(
    (rank): rank is number => rank !== null,
  );
  return ranks.length > 0 ? Math.min(...ranks) : null;
}

function sortCompletions(left: RankedCompletion, right: RankedCompletion): number {
  return left.rank - right.rank
    || left.mru - right.mru
    || left.path.localeCompare(right.path)
    || left.label.localeCompare(right.label);
}

function recordForTarget(index: ReadyLinkIndex, target: string): WorkspaceMarkdownRecord | undefined {
  const wanted = target.toLocaleLowerCase();
  return index.records.find((record) => {
    const canonical = canonicalTarget(record.path, "markdown").toLocaleLowerCase();
    return canonical === wanted || record.path.toLocaleLowerCase() === wanted;
  });
}

function headingCompletions(
  index: ReadyLinkIndex,
  target: string,
  query: string,
  mruPaths: string[],
): RankedCompletion[] {
  const record = recordForTarget(index, target);
  if (!record) return [];
  const mru = mruPaths.indexOf(record.path);
  return record.headings.flatMap((heading) => {
    const rank = matchRank(query, heading.text);
    if (rank === null) return [];
    return [{
      label: heading.text,
      detail: `heading | ${record.path}`,
      type: "keyword" as const,
      apply: applyWikilink(`${target}#${heading.text}`),
      rank,
      mru: mru < 0 ? Number.MAX_SAFE_INTEGER : mru,
      path: record.path,
    }];
  }).sort(sortCompletions);
}

function targetCompletions(
  index: ReadyLinkIndex,
  query: string,
  mruPaths: string[],
): RankedCompletion[] {
  const records = new Map(index.records.map((record) => [record.path, record]));
  const ranked: RankedCompletion[] = [];
  for (const target of index.targets) {
    if (target.kind !== "markdown" && target.kind !== "pdf") continue;
    const canonical = canonicalTarget(target.path, target.kind);
    const mru = mruPaths.indexOf(target.path);
    const mruRank = mru < 0 ? Number.MAX_SAFE_INTEGER : mru;
    const rank = bestMatchRank(query, [canonical, canonical.split("/").at(-1)!]);
    if (rank !== null) {
      ranked.push({
        label: canonical,
        detail: `${target.kind} | ${target.path}`,
        type: "text",
        apply: applyWikilink(canonical, target.kind === "markdown"),
        rank,
        mru: mruRank,
        path: target.path,
      });
    }
    if (target.kind !== "markdown") continue;
    for (const alias of records.get(target.path)?.aliases ?? []) {
      const aliasRank = matchRank(query, alias);
      if (aliasRank === null) continue;
      ranked.push({
        label: alias,
        detail: `alias | ${target.path}`,
        type: "keyword",
        apply: applyWikilink(`${canonical}|${alias}`),
        rank: aliasRank,
        mru: mruRank,
        path: target.path,
      });
    }
  }
  return ranked.sort(sortCompletions);
}

export function workspaceLinkCompletion(
  context: CompletionContext,
  index: WorkspaceLinkIndexSnapshot,
  mruPaths: string[],
): CompletionResult | null {
  if (index.status !== "ready" || completionIsExcluded(context)) return null;
  const before = context.state.sliceDoc(0, context.pos);
  const opener = before.lastIndexOf("[[");
  if (opener < 0 || before.lastIndexOf("]]", context.pos) > opener) return null;
  const authored = before.slice(opener + 2);
  if (authored.includes("\n") || authored.includes("|")) return null;

  const headingMarker = authored.indexOf("#");
  const options = headingMarker >= 0
    ? headingCompletions(
        index,
        authored.slice(0, headingMarker),
        authored.slice(headingMarker + 1),
        mruPaths,
      )
    : targetCompletions(index, authored, mruPaths);
  if (!context.explicit && options.length === 0) return null;
  return {
    from: opener,
    to: context.pos,
    filter: false,
    options: options.map(({ rank: _rank, mru: _mru, path: _path, ...option }) => option),
  };
}
