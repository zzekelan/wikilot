/** Workspace-relative metadata command; the root parent is an empty string. */
export type WorkspaceFileChange = {
  kind: "create";
  parent: string;
  name: string;
  entryKind: "file" | "directory";
} | { kind: "rename"; path: string; name: string } | { kind: "move"; paths: string[]; destination: string } | { kind: "trash"; paths: string[] };

export type WorkspaceFileReport = {
  /** Present for trash operations; paths that successfully reached the system trash. */
  trashed?: string[];
  created: string[];
  relocated: Array<{ from: string; to: string }>;
  failures: Array<{
    source?: string;
    code: "exists" | "invalid-path" | "unavailable" | "io-error";
    message: string;
  }>;
};
