export type WorkspaceSourcePoint = {
  /** One-based line. */
  line: number;
  /** One-based UTF-16 column. */
  column: number;
  /** Zero-based UTF-16 offset. */
  offset: number;
};

export type WorkspaceSourceRange = {
  start: WorkspaceSourcePoint;
  end: WorkspaceSourcePoint;
};

export type WorkspaceLinkDiagnosticCode =
  | "frontmatter-unclosed"
  | "frontmatter-invalid-yaml"
  | "markdown-too-large"
  | "markdown-invalid-utf8"
  | "markdown-unreadable";

export type WorkspaceLinkInvalidReason =
  | "absolute-path"
  | "creation-failed"
  | "invalid-target"
  | "invalid-url-encoding"
  | "resolver-error"
  | "workspace-escape";

export type WorkspaceLinkDiagnostic = {
  code: WorkspaceLinkDiagnosticCode;
  stage: "frontmatter" | "markdown" | "read";
  severity: "warning" | "error";
  message: string;
  range?: WorkspaceSourceRange;
};

export type WorkspaceLinkSubpath =
  | { kind: "heading"; value: string }
  | { kind: "pdf-page"; value: string }
  | { kind: "block"; value: string };

export type WorkspaceLinkTarget =
  | {
      status: "resolved";
      path: string;
      kind: "markdown" | "pdf" | "file";
      heading?: string;
      page?: number;
    }
  | {
      status: "missing";
      creationSuggestion?: { path: string };
    }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "invalid"; reason: WorkspaceLinkInvalidReason };

export type WorkspaceLinkReference = {
  sourcePath: string;
  kind: "link" | "image" | "embed";
  syntax: "markdown" | "wikilink";
  originalText: string;
  authoredTarget: string;
  displayText?: string;
  subpath?: WorkspaceLinkSubpath;
  range: WorkspaceSourceRange;
  targetRange: WorkspaceSourceRange;
  target: WorkspaceLinkTarget;
};

export type WorkspaceMarkdownRecord = {
  path: string;
  headings: Array<{
    depth: number;
    text: string;
    slug: string;
    range: WorkspaceSourceRange;
  }>;
  aliases: string[];
  tags: string[];
  references: WorkspaceLinkReference[];
  parseStatus: "parsed" | "too-large" | "unreadable";
  diagnostics: WorkspaceLinkDiagnostic[];
};

export type WorkspaceLinkTargetFile = {
  path: string;
  kind: "markdown" | "pdf" | "file";
};

export type WorkspaceLinkResolveRequest = {
  /** Omitted for Timeline links, which resolve relative paths from Workspace root. */
  sourcePath?: string;
  syntax: "markdown" | "wikilink";
  authoredTarget: string;
  subpath?: WorkspaceLinkSubpath;
};

export type WorkspaceLinkIndexRequest = { workspaceId: string };
export type WorkspaceLinkResolveCommand = WorkspaceLinkResolveRequest & {
  workspaceId: string;
};
export type WorkspaceMarkdownCreateRequest = {
  workspaceId: string;
  path: string;
};

export type WorkspaceLinkResolution =
  | { status: "building" }
  | { status: "ready"; revision: number; target: WorkspaceLinkTarget };

export type WorkspacePropertyType = "text" | "list" | "number" | "date" | "checkbox";

export type WorkspacePropertyRegistration = {
  name: string;
  type: WorkspacePropertyType;
};

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month! - 1
    && date.getUTCDate() === day;
}

export function inferWorkspacePropertyType(value: unknown): WorkspacePropertyType | null {
  if (value === null || typeof value === "string") {
    return typeof value === "string" && isCalendarDate(value) ? "date" : "text";
  }
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "checkbox";
  if (
    Array.isArray(value)
    && value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))
  ) return "list";
  return null;
}

export type WorkspaceLinkIndexSnapshot =
  | { status: "building" }
  | {
      status: "ready";
      revision: number;
      targets: WorkspaceLinkTargetFile[];
      records: WorkspaceMarkdownRecord[];
      propertyRegistry: WorkspacePropertyRegistration[];
    };
