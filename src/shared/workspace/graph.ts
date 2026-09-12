export type WorkspaceGraphNode = {
  path: string;
  label: string;
  /** Number of unique incident directed edges. */
  degree: number;
  /** Total incoming and outgoing reference occurrences. */
  referenceCount: number;
};

export type WorkspaceGraphEdge = {
  source: string;
  target: string;
  occurrenceCount: number;
  kindCounts: {
    link: number;
    image: number;
    embed: number;
  };
};

export type WorkspaceGraphSnapshot =
  | { status: "building" }
  | { status: "retrying" }
  | { status: "error"; code: "index-build-failed" }
  | {
      status: "ready";
      revision: number;
      nodes: WorkspaceGraphNode[];
      edges: WorkspaceGraphEdge[];
    };

export type WorkspaceGraphRequest = { workspaceId: string };
