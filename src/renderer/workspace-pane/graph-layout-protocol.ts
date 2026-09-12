import type { WorkspaceGraphEdge, WorkspaceGraphNode } from "../../shared/workspace";

export type GraphPosition = {
  path: string;
  x: number;
  y: number;
};

export type GraphLayoutCommand =
  | {
      type: "layout";
      nodes: WorkspaceGraphNode[];
      edges: WorkspaceGraphEdge[];
      positions: GraphPosition[];
      pins: GraphPosition[];
      reducedMotion: boolean;
    }
  | { type: "drag"; position: GraphPosition; reducedMotion: boolean }
  | { type: "pin"; position: GraphPosition; reducedMotion: boolean }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "clear-pins"; reducedMotion: boolean }
  | { type: "stop" };

export type GraphLayoutEvent =
  | { type: "positions"; positions: GraphPosition[]; settled: boolean; reason?: "layout" | "clear-pins" | "stop" | "drag" }
  | { type: "error"; message: string };
