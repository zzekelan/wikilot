import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphLayoutCommand, GraphLayoutEvent } from "./graph-layout-protocol";
import { graphSeedPosition } from "./graph-layout-seed";
import { graphEdgeSize, graphNodeSize } from "./graph-visual-scale";

type WorkerScope = {
  onmessage: ((event: MessageEvent<GraphLayoutCommand>) => void) | null;
};

describe("graph layout seed", () => {
  it("spreads a large graph before the first force tick", () => {
    const positions = Array.from({ length: 5_000 }, (_unused, index) =>
      graphSeedPosition(`note-${index}.md`, index, 5_000));
    const radii = positions.map((position) => Math.hypot(position.x, position.y));
    const xs = positions.map((position) => position.x);
    const ys = positions.map((position) => position.y);

    expect(Math.max(...radii)).toBeGreaterThan(1_200);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(2_300);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(2_300);
    expect(radii.filter((radius) => radius < 120)).toHaveLength(44);
  });

  it("reduces canvas coverage as graph size grows", () => {
    expect(graphNodeSize(20, 120)).toBeGreaterThan(10);
    expect(graphNodeSize(20, 5_000)).toBeLessThan(1.5);
    expect(graphNodeSize(20, 5_000, true)).toBe(4);
    expect(graphEdgeSize(1, 5_000)).toBe(0.18);
  });
});

describe("graph layout worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("responds to a large-graph drag within one interaction frame and moves its neighborhood", async () => {
    const nodeCount = 5_000;
    const linksPerNode = 10;
    const events: GraphLayoutEvent[] = [];
    const scope: WorkerScope = { onmessage: null };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (event: GraphLayoutEvent) => events.push(event));
    await import("./graph-layout.worker");

    const nodes = Array.from({ length: nodeCount }, (_unused, index) => ({
      path: `note-${index}.md`,
      label: `Note ${index}`,
      degree: linksPerNode * 2,
      referenceCount: linksPerNode,
    }));
    const edges = nodes.flatMap((node, index) =>
      Array.from({ length: linksPerNode }, (_unused, offset) => ({
        source: node.path,
        target: `note-${(index + offset + 1) % nodeCount}.md`,
        occurrenceCount: 1,
        kindCounts: { link: 1, image: 0, embed: 0 },
      })),
    );
    const positions = nodes.map((node, index) => ({
      path: node.path,
      x: index % 100,
      y: Math.floor(index / 100),
    }));
    const send = scope.onmessage;
    const sendCommand = (command: GraphLayoutCommand) => {
      send?.({ data: command } as unknown as MessageEvent<GraphLayoutCommand>);
    };
    expect(send).toBeTypeOf("function");
    sendCommand({
      type: "layout",
      nodes,
      edges,
      positions,
      pins: [],
      reducedMotion: false,
    });

    const startedAt = performance.now();
    sendCommand({
      type: "drag",
      position: { path: "note-0.md", x: 240, y: 180 },
      reducedMotion: false,
    });
    const responseMs = performance.now() - startedAt;
    const response = events.at(-1);

    try {
      expect(responseMs).toBeLessThan(16.7);
      expect(response?.type).toBe("positions");
      if (response?.type === "positions") {
        expect(response.reason).toBe("drag");
        expect(response.positions.some((position) => position.path !== "note-0.md")).toBe(true);
        expect(response.positions.some((position) => {
          const previous = positions.find((candidate) => candidate.path === position.path);
          return previous && position.path !== "note-0.md" &&
            Math.hypot(position.x - previous.x, position.y - previous.y) > 0.01;
        })).toBe(true);
      }
    } finally {
      sendCommand({ type: "stop" });
    }
  });

  it("settles a dense reduced-motion layout without visual overlaps", async () => {
    const events: GraphLayoutEvent[] = [];
    const scope: WorkerScope = { onmessage: null };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (event: GraphLayoutEvent) => events.push(event));
    await import("./graph-layout.worker");
    const nodes = Array.from({ length: 300 }, (_unused, index) => ({
      path: `dense-${index}.md`,
      label: `Dense ${index}`,
      degree: 20,
      referenceCount: 10,
    }));

    scope.onmessage?.({ data: {
      type: "layout",
      nodes,
      edges: [],
      positions: nodes.map((node) => ({ path: node.path, x: 0, y: 0 })),
      pins: [],
      reducedMotion: true,
    }} as unknown as MessageEvent<GraphLayoutCommand>);

    const settled = [...events].reverse().find((event) => event.type === "positions" && event.settled);
    expect(settled?.type).toBe("positions");
    if (settled?.type !== "positions") return;
    for (let index = 0; index < settled.positions.length; index += 1) {
      for (let other = index + 1; other < settled.positions.length; other += 1) {
        expect(Math.hypot(
          settled.positions[index]!.x - settled.positions[other]!.x,
          settled.positions[index]!.y - settled.positions[other]!.y,
        )).toBeGreaterThanOrEqual(22);
      }
    }
  });

  it("settles the 5,001-node acceptance layout without overlaps", async () => {
    const events: GraphLayoutEvent[] = [];
    const scope: WorkerScope = { onmessage: null };
    vi.stubGlobal("self", scope);
    vi.stubGlobal("postMessage", (event: GraphLayoutEvent) => events.push(event));
    await import("./graph-layout.worker");
    const nodes = Array.from({ length: 5_001 }, (_unused, index) => ({
      path: `large-${index}.md`,
      label: `Large ${index}`,
      degree: 20,
      referenceCount: 10,
    }));

    scope.onmessage?.({ data: {
      type: "layout",
      nodes,
      edges: [],
      positions: nodes.map((node, index) => ({
        path: node.path,
        x: index % 100,
        y: Math.floor(index / 100),
      })),
      pins: [],
      reducedMotion: true,
    }} as unknown as MessageEvent<GraphLayoutCommand>);

    const settled = [...events].reverse().find((event) => event.type === "positions" && event.settled);
    expect(settled?.type).toBe("positions");
    if (settled?.type !== "positions") return;
    const cells = new Map<string, Array<{ x: number; y: number }>>();
    let overlaps = 0;
    for (const position of settled.positions) {
      const cellX = Math.floor(position.x / 22);
      const cellY = Math.floor(position.y / 22);
      for (let x = cellX - 1; x <= cellX + 1; x += 1) {
        for (let y = cellY - 1; y <= cellY + 1; y += 1) {
          for (const other of cells.get(`${x}:${y}`) ?? []) {
            if (Math.hypot(position.x - other.x, position.y - other.y) < 22) overlaps += 1;
          }
        }
      }
      const key = `${cellX}:${cellY}`;
      cells.set(key, [...(cells.get(key) ?? []), position]);
    }
    expect(overlaps).toBe(0);
  }, 20_000);
});
