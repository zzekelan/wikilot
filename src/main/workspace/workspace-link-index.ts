import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import type {
  WorkspaceLinkDiagnostic,
  WorkspaceLinkReference,
  WorkspaceLinkResolveRequest,
  WorkspaceLinkSubpath,
  WorkspaceLinkTarget,
  WorkspaceMarkdownRecord,
  WorkspacePropertyRegistration,
  WorkspaceSourcePoint,
  WorkspaceSourceRange,
} from "../../shared/workspace";
import {
  findWikilinks,
  inferWorkspacePropertyType,
  splitWorkspaceLinkTarget,
  workspaceHeadingSlug,
} from "../../shared/workspace";
import { isExcludedWorkspacePath } from "./workspace-path";

const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;
const EXTERNAL_DESTINATION = /^[A-Za-z][A-Za-z\d+.-]*:/;

type Position = {
  start: { line: number; column: number; offset?: number };
  end: { line: number; column: number; offset?: number };
};

type MdNode = {
  type: string;
  value?: string;
  url?: string;
  alt?: string;
  depth?: number;
  position?: Position;
  children?: MdNode[];
};

export type TargetFile = { path: string; kind: "markdown" | "pdf" | "file" };

function point(value: Position["start"]): WorkspaceSourcePoint {
  return { line: value.line, column: value.column, offset: value.offset ?? 0 };
}

function range(position: Position): WorkspaceSourceRange {
  return { start: point(position.start), end: point(position.end) };
}

function pointAt(content: string, offset: number): WorkspaceSourcePoint {
  const before = content.slice(0, offset);
  const line = before.split("\n").length;
  const lastBreak = before.lastIndexOf("\n");
  return { line, column: offset - lastBreak, offset };
}

function offsetRange(content: string, start: number, end: number): WorkspaceSourceRange {
  return { start: pointAt(content, start), end: pointAt(content, end) };
}

function textOf(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  return node.children?.map(textOf).join("") ?? "";
}

function targetKind(path: string): TargetFile["kind"] {
  const extension = extname(path).toLowerCase();
  if (extension === ".md") return "markdown";
  if (extension === ".pdf") return "pdf";
  return "file";
}

function collectTargetFiles(cwd: string): TargetFile[] {
  const files: TargetFile[] = [];
  const directories = [cwd];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    for (const name of readdirSync(directory)) {
      const absolute = join(directory, name);
      const path = relative(cwd, absolute).split(sep).join("/");
      if (isExcludedWorkspacePath(path)) continue;
      let stat;
      try {
        stat = lstatSync(absolute);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) directories.push(absolute);
      else if (stat.isFile()) files.push({ path, kind: targetKind(path) });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeCandidate(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function resolveReference(
  reference: Omit<WorkspaceLinkReference, "target">,
  files: TargetFile[],
  records: WorkspaceMarkdownRecord[],
): WorkspaceLinkTarget {
  let decoded: string;
  let subpath = reference.subpath;
  try {
    decoded = reference.syntax === "markdown"
      ? decodeURIComponent(reference.authoredTarget)
      : reference.authoredTarget;
    if (reference.syntax === "markdown" && subpath) {
      subpath = { ...subpath, value: decodeURIComponent(subpath.value) };
    }
  } catch {
    return { status: "invalid", reason: "invalid-url-encoding" };
  }
  if (!decoded && subpath?.kind === "heading" && reference.sourcePath) {
    const source = files.find((file) => file.path === reference.sourcePath);
    return source
      ? resolvedTarget(source, subpath, records)
      : { status: "invalid", reason: "invalid-target" };
  }
  if (!decoded || decoded.includes("\0")) {
    return { status: "invalid", reason: "invalid-target" };
  }
  if (
    !reference.sourcePath &&
    (/^[\\/]/.test(decoded) || /^[A-Za-z]:[\\/]/.test(decoded))
  ) {
    return { status: "invalid", reason: "absolute-path" };
  }
  if (EXTERNAL_DESTINATION.test(decoded)) {
    return { status: "invalid", reason: "invalid-target" };
  }

  const sourceDirectory = dirname(reference.sourcePath).replace(/^\.$/, "");
  let candidate: string;
  if (reference.syntax === "markdown") {
    candidate = decoded.startsWith("/")
      ? decoded.slice(1)
      : [reference.sourcePath ? sourceDirectory : "", decoded].filter(Boolean).join("/");
  } else if (decoded.startsWith("./") || decoded.startsWith("../")) {
    candidate = [sourceDirectory, decoded].filter(Boolean).join("/");
  } else if (decoded.includes("/")) {
    candidate = decoded;
  } else {
    const extension = extname(decoded);
    const matches = files.filter((file) => {
      const name = basename(file.path);
      const stem = name.slice(0, name.length - extname(name).length);
      if (extension) return name.toLowerCase() === decoded.toLowerCase();
      return file.kind === "markdown" && stem.toLowerCase() === decoded.toLowerCase();
    });
    const exact = matches.filter((file) => {
      const name = basename(file.path);
      const stem = name.slice(0, name.length - extname(name).length);
      if (extension) return name === decoded;
      return stem === decoded;
    });
    const selected = exact.length > 0 ? exact : matches;
    if (selected.length > 1) {
      return { status: "ambiguous", candidates: selected.map((file) => file.path) };
    }
    if (selected.length === 1) return resolvedTarget(selected[0]!, subpath, records);
    candidate = decoded;
  }

  const normalized = normalizeCandidate(candidate);
  if (normalized === null) return { status: "invalid", reason: "workspace-escape" };
  const explicitExtension = Boolean(extname(normalized));
  const wanted = explicitExtension ? normalized : `${normalized}.md`;
  const exact = files.filter((file) => file.path === wanted);
  const insensitive = files.filter((file) => file.path.toLowerCase() === wanted.toLowerCase());
  const matches = exact.length > 0 ? exact : insensitive;
  if (matches.length > 1) {
    return { status: "ambiguous", candidates: matches.map((file) => file.path) };
  }
  if (matches.length === 1) return resolvedTarget(matches[0]!, subpath, records);

  const markdownMissing = !explicitExtension || extname(normalized).toLowerCase() === ".md";
  return {
    status: "missing",
    ...(markdownMissing ? { creationSuggestion: { path: wanted } } : {}),
  };
}

function resolvedTarget(
  file: TargetFile,
  subpath?: WorkspaceLinkSubpath,
  records: WorkspaceMarkdownRecord[] = [],
): WorkspaceLinkTarget {
  const heading = subpath?.kind === "heading"
    && records.find((record) => record.path === file.path)?.headings.some(
      (candidate) => candidate.slug === workspaceHeadingSlug(subpath.value),
    )
      ? subpath.value
      : undefined;
  return {
    status: "resolved",
    path: file.path,
    kind: file.kind,
    ...(file.kind === "pdf" && subpath?.kind === "pdf-page"
      ? { page: Number(subpath.value) }
      : {}),
    ...(heading ? { heading } : {}),
  };
}

function frontmatterFacts(content: string): {
  aliases: string[];
  tags: string[];
  diagnostics: WorkspaceLinkDiagnostic[];
  propertyRegistrations: WorkspacePropertyRegistration[];
} {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) {
    return { aliases: [], tags: [], diagnostics: [], propertyRegistrations: [] };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) {
    return {
      aliases: [],
      tags: [],
      diagnostics: [{
        code: "frontmatter-unclosed",
        stage: "frontmatter",
        severity: "error",
        message: "Frontmatter is not closed",
      }],
      propertyRegistrations: [],
    };
  }
  const document = parseDocument(match[1], { intAsBigInt: true });
  if (document.errors.length > 0) {
    return {
      aliases: [],
      tags: [],
      diagnostics: [{
        code: "frontmatter-invalid-yaml",
        stage: "frontmatter",
        severity: "error",
        message: "Frontmatter YAML is malformed",
      }],
      propertyRegistrations: [],
    };
  }
  const value = document.toJS() as Record<string, unknown> | null;
  const strings = (field: unknown): string[] => {
    const values = Array.isArray(field) ? field : field == null ? [] : [field];
    return values.filter((item): item is string => typeof item === "string").map((item) => item.replace(/^#/, ""));
  };
  const propertyRegistrations: WorkspacePropertyRegistration[] = [];
  const scalarPropertyValue = (node: unknown): unknown => {
    if (!isScalar(node)) return undefined;
    if (typeof node.value !== "bigint") return node.value;
    const number = Number(node.value);
    return Number.isSafeInteger(number) ? number : node.value;
  };
  if (isMap(document.contents)) {
    for (const pair of document.contents.items) {
      if (!isScalar(pair.key)) continue;
      const propertyValue = isScalar(pair.value)
        ? scalarPropertyValue(pair.value)
        : isSeq(pair.value) && pair.value.items.every(isScalar)
          ? pair.value.items.map(scalarPropertyValue)
          : undefined;
      let type = inferWorkspacePropertyType(propertyValue);
      if (type === "date" && isScalar(pair.value) && pair.value.type !== "PLAIN") type = "text";
      if (type) propertyRegistrations.push({ name: String(pair.key.value ?? ""), type });
    }
  }
  return {
    aliases: strings(value?.aliases ?? value?.alias),
    tags: strings(value?.tags),
    diagnostics: [],
    propertyRegistrations,
  };
}

function maskFrontmatter(content: string): string {
  if (!content.startsWith("---\n") && !content.startsWith("---\r\n")) return content;
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!match) return content;
  return match[0].replace(/[^\r\n]/g, " ") + content.slice(match[0].length);
}

function markdownDestinationRange(originalText: string): { start: number; end: number } {
  const opener = originalText.lastIndexOf("](");
  if (opener < 0) return { start: 0, end: originalText.length };
  let start = opener + 2;
  while (/\s/.test(originalText[start] ?? "")) start += 1;
  const angleWrapped = originalText[start] === "<";
  if (angleWrapped) start += 1;
  let end = start;
  let depth = 0;
  while (end < originalText.length) {
    const character = originalText[end]!;
    if (character === "\\" && end + 1 < originalText.length) {
      end += 2;
      continue;
    }
    if (angleWrapped && character === ">") break;
    if (!angleWrapped && character === "(") depth += 1;
    else if (!angleWrapped && character === ")") {
      if (depth === 0) break;
      depth -= 1;
    } else if (!angleWrapped && depth === 0 && /\s/.test(character)) break;
    end += 1;
  }
  for (let index = start; index < end; index += 1) {
    if (originalText[index] === "\\") index += 1;
    else if (originalText[index] === "#") return { start, end: index };
  }
  return { start, end };
}

type IndexedMarkdownRecord = WorkspaceMarkdownRecord & {
  propertyRegistrations: WorkspacePropertyRegistration[];
};

function parseMarkdown(path: string, content: string): IndexedMarkdownRecord {
  const root = unified().use(remarkParse).use(remarkGfm).parse(maskFrontmatter(content)) as MdNode;
  const headings: WorkspaceMarkdownRecord["headings"] = [];
  const bodyTags = new Set<string>();
  const pending: Array<Omit<WorkspaceLinkReference, "target">> = [];
  const excluded: Array<[number, number]> = [];

  visit(root as never, (node: MdNode) => {
    if ((node.type === "code" || node.type === "inlineCode" || node.type === "html") && node.position) {
      excluded.push([node.position.start.offset ?? 0, node.position.end.offset ?? 0]);
    }
    if ((node.type === "link" || node.type === "image") && node.position) {
      excluded.push([node.position.start.offset ?? 0, node.position.end.offset ?? 0]);
    }
    if (node.type === "heading" && node.position) {
      const text = textOf(node);
      headings.push({
        depth: node.depth ?? 1,
        text,
        slug: workspaceHeadingSlug(text),
        range: range(node.position),
      });
    }
    if (node.type === "text" && typeof node.value === "string") {
      for (const match of node.value.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) {
        bodyTags.add(match[1]!);
      }
    }
    if ((node.type !== "link" && node.type !== "image") || !node.position || !node.url) return;
    if (EXTERNAL_DESTINATION.test(node.url)) return;
    const wholeStart = node.position.start.offset ?? 0;
    const wholeEnd = node.position.end.offset ?? wholeStart;
    const originalText = content.slice(wholeStart, wholeEnd);
    const destination = markdownDestinationRange(originalText);
    const parsed = splitWorkspaceLinkTarget(node.url);
    pending.push({
      sourcePath: path,
      kind: node.type === "image" ? "image" : "link",
      syntax: "markdown",
      originalText,
      authoredTarget: parsed.authoredTarget,
      ...(node.type === "link" ? { displayText: textOf(node) } : { displayText: node.alt ?? "" }),
      ...(parsed.subpath ? { subpath: parsed.subpath } : {}),
      range: range(node.position),
      targetRange: offsetRange(
        content,
        wholeStart + destination.start,
        wholeStart + destination.end,
      ),
    });
  });

  for (const token of findWikilinks(content)) {
    const { start, end } = token;
    if (excluded.some(([from, to]) => start >= from && end <= to)) continue;
    pending.push({
      sourcePath: path,
      kind: token.embed ? "embed" : "link",
      syntax: "wikilink",
      originalText: token.originalText,
      authoredTarget: token.parsed.authoredTarget,
      ...(token.parsed.displayText !== undefined ? { displayText: token.parsed.displayText } : {}),
      ...(token.parsed.subpath ? { subpath: token.parsed.subpath } : {}),
      range: offsetRange(content, start, end),
      targetRange: offsetRange(
        content,
        token.targetStart,
        token.targetStart + token.parsed.authoredTarget.length,
      ),
    });
  }

  const facts = frontmatterFacts(content);
  return {
    path,
    headings,
    aliases: facts.aliases,
    tags: [...new Set([...facts.tags, ...bodyTags])],
    references: pending.sort((a, b) => a.range.start.offset - b.range.start.offset) as WorkspaceLinkReference[],
    parseStatus: "parsed",
    diagnostics: facts.diagnostics,
    propertyRegistrations: facts.propertyRegistrations,
  };
}

export function resolveWorkspaceLink(
  request: WorkspaceLinkResolveRequest,
  files: TargetFile[],
  records: WorkspaceMarkdownRecord[],
): WorkspaceLinkTarget {
  return resolveReference({
    sourcePath: request.sourcePath ?? "",
    kind: "link",
    syntax: request.syntax,
    originalText: request.authoredTarget,
    authoredTarget: request.authoredTarget,
    ...(request.subpath ? { subpath: request.subpath } : {}),
    range: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: 0 },
    },
    targetRange: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: 0 },
    },
  }, files, records);
}

export function buildWorkspaceLinkIndex(cwd: string): {
  records: WorkspaceMarkdownRecord[];
  targets: TargetFile[];
  propertyRegistry: WorkspacePropertyRegistration[];
} {
  const files = collectTargetFiles(cwd);
  const records = files
    .filter((file) => file.kind === "markdown")
    .map((file): IndexedMarkdownRecord => {
      const absolute = resolve(cwd, ...file.path.split("/"));
      const stat = lstatSync(absolute);
      if (stat.size > MAX_MARKDOWN_BYTES) {
        return {
          path: file.path,
          headings: [], aliases: [], tags: [], references: [],
          parseStatus: "too-large",
          diagnostics: [{
            code: "markdown-too-large", stage: "read", severity: "warning",
            message: "Markdown file exceeds the 10 MiB indexing limit",
          }],
          propertyRegistrations: [],
        };
      }
      try {
        const bytes = readFileSync(absolute);
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (content.includes("\0")) throw new TypeError("NUL is not valid Markdown text");
        return parseMarkdown(file.path, content);
      } catch (error) {
        const invalidUtf8 = error instanceof TypeError;
        return {
          path: file.path,
          headings: [], aliases: [], tags: [], references: [],
          parseStatus: "unreadable",
          diagnostics: [{
            code: invalidUtf8 ? "markdown-invalid-utf8" : "markdown-unreadable",
            stage: "read",
            severity: "error",
            message: invalidUtf8
              ? "Markdown file is not valid UTF-8"
              : "Markdown file could not be indexed",
          }],
          propertyRegistrations: [],
        };
      }
    });

  const propertyRegistry: WorkspacePropertyRegistration[] = [];
  const registeredNames = new Set<string>();
  for (const record of records) {
    record.references = record.references.map((reference) => ({
      ...reference,
      target: resolveReference(reference, files, records),
    }));
    for (const registration of record.propertyRegistrations) {
      if (registeredNames.has(registration.name)) continue;
      registeredNames.add(registration.name);
      propertyRegistry.push(registration);
    }
  }
  return {
    records: records.map(({ propertyRegistrations: _, ...record }) => record),
    targets: files,
    propertyRegistry,
  };
}
