/// <reference lib="webworker" />
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import type {
  GraphLayoutCommand,
  GraphLayoutEvent,
  GraphPosition,
} from "./graph-layout-protocol";
import { graphSeedPosition } from "./graph-layout-seed";

type LayoutNode = SimulationNodeDatum & {
  id: string;
  degree: number;
  radius: number;
};
type LayoutLink = SimulationLinkDatum<LayoutNode>;

let simulation: Simulation<LayoutNode, LayoutLink> | null = null;
let nodes: LayoutNode[] = [];
let nodesByPath = new Map<string, LayoutNode>();
let reducedMotion = false;
let neighborsByPath = new Map<string, Set<string>>();
let lastPost = 0;
let postInterval = 32;
let cooperativeLayout = false;
let cooperativeTimer: ReturnType<typeof setTimeout> | null = null;

function layoutProfile(nodeCount: number): {
  alphaDecay: number;
  velocityDecay: number;
  postInterval: number;
  chargeStrength: number;
  chargeDistance: number;
  linkDistance: number;
  linkStrength: number;
  centeringStrength: number;
  collisionIterations: number;
} {
  if (nodeCount <= 120) {
    return {
      alphaDecay: 0.012,
      velocityDecay: 0.28,
      postInterval: 16,
      chargeStrength: -90,
      chargeDistance: 320,
      linkDistance: 84,
      linkStrength: 0.16,
      centeringStrength: 0.018,
      collisionIterations: 3,
    };
  }
  if (nodeCount <= 1_000) {
    return {
      alphaDecay: 0.022,
      velocityDecay: 0.32,
      postInterval: 24,
      chargeStrength: -80,
      chargeDistance: 290,
      linkDistance: 50,
      linkStrength: 0.17,
      centeringStrength: 0.022,
      collisionIterations: 2,
    };
  }
  return {
    alphaDecay: 0.035,
    velocityDecay: 0.35,
    postInterval: 32,
    chargeStrength: 0,
    chargeDistance: 260,
    linkDistance: 48,
    linkStrength: 0.08,
    centeringStrength: 0.006,
    collisionIterations: 0,
  };
}

function layoutEdges<T>(edges: T[], nodeCount: number): T[] {
  if (nodeCount <= 1_000) return edges;
  const maximum = nodeCount;
  if (edges.length <= maximum) return edges;
  const stride = edges.length / maximum;
  return Array.from({ length: maximum }, (_unused, index) => edges[Math.floor(index * stride)]);
}

function emitPositions(layoutNodes: LayoutNode[], settled: boolean, reason?: "layout" | "clear-pins" | "stop" | "drag"): void {
  postMessage({
    type: "positions",
    positions: layoutNodes.map((node) => ({ path: node.id, x: node.x ?? 0, y: node.y ?? 0 })),
    settled,
    ...(reason ? { reason } : {}),
  } satisfies GraphLayoutEvent);
}

function emit(settled: boolean, reason?: "layout" | "clear-pins" | "stop"): void {
  emitPositions(nodes, settled, reason);
}

function stopCooperativeLayout(): void {
  if (cooperativeTimer !== null) clearTimeout(cooperativeTimer);
  cooperativeTimer = null;
}

function separateRemainingOverlaps(): void {
  const minimumDistance = 22.01;
  const cells = new Map<string, LayoutNode[]>();
  const keyFor = (x: number, y: number) =>
    `${Math.floor(x / minimumDistance)}:${Math.floor(y / minimumDistance)}`;
  const fits = (x: number, y: number): boolean => {
    const cellX = Math.floor(x / minimumDistance);
    const cellY = Math.floor(y / minimumDistance);
    for (let neighborX = cellX - 1; neighborX <= cellX + 1; neighborX += 1) {
      for (let neighborY = cellY - 1; neighborY <= cellY + 1; neighborY += 1) {
        for (const other of cells.get(`${neighborX}:${neighborY}`) ?? []) {
          if (Math.hypot(x - (other.x ?? 0), y - (other.y ?? 0)) < minimumDistance) return false;
        }
      }
    }
    return true;
  };
  const ordered = [...nodes].sort((left, right) =>
    Number(left.fx == null) - Number(right.fx == null) || left.id.localeCompare(right.id),
  );
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (const node of ordered) {
    const originX = node.x ?? 0;
    const originY = node.y ?? 0;
    if (node.fx == null && !fits(originX, originY)) {
      const seed = graphSeedPosition(node.id, 0, 1);
      const angleOffset = Math.atan2(seed.y, seed.x);
      let placed = false;
      for (let attempt = 1; attempt <= nodes.length * 2; attempt += 1) {
        const radius = minimumDistance * Math.sqrt(attempt);
        const angle = angleOffset + attempt * goldenAngle;
        const x = originX + Math.cos(angle) * radius;
        const y = originY + Math.sin(angle) * radius;
        if (!fits(x, y)) continue;
        node.x = x;
        node.y = y;
        placed = true;
        break;
      }
      if (!placed) {
        let x = originX;
        while (!fits(x, originY)) x += minimumDistance;
        node.x = x;
      }
    }
    const key = keyFor(node.x ?? 0, node.y ?? 0);
    cells.set(key, [...(cells.get(key) ?? []), node]);
  }
}

function settleImmediately(reason: "layout" | "clear-pins"): void {
  stopCooperativeLayout();
  simulation?.stop();
  simulation?.alpha(1);
  for (let index = 0; index < 800; index += 1) simulation?.tick();
  separateRemainingOverlaps();
  emit(true, reason);
}

function scheduleCooperativeLayout(): void {
  if (!cooperativeLayout || cooperativeTimer !== null || !simulation) return;
  cooperativeTimer = setTimeout(() => {
    cooperativeTimer = null;
    if (!simulation) return;
    simulation.tick();
    const now = performance.now();
    if (now - lastPost >= postInterval) {
      lastPost = now;
      emit(false);
    }
    if (simulation.alpha() < simulation.alphaMin()) {
      emit(true);
      return;
    }
    scheduleCooperativeLayout();
  }, 8);
}

function start(command: Extract<GraphLayoutCommand, { type: "layout" }>): void {
  stopCooperativeLayout();
  simulation?.stop();
  reducedMotion = command.reducedMotion;
  cooperativeLayout = command.nodes.length > 1_000;
  const profile = layoutProfile(command.nodes.length);
  const previous = new Map(command.positions.map((position) => [position.path, position]));
  const pins = new Map(command.pins.map((position) => [position.path, position]));
  const neighbors = new Map<string, GraphPosition[]>();
  for (const edge of command.edges) {
    const source = previous.get(edge.source);
    const target = previous.get(edge.target);
    if (source && !target) neighbors.set(edge.target, [...(neighbors.get(edge.target) ?? []), source]);
    if (target && !source) neighbors.set(edge.source, [...(neighbors.get(edge.source) ?? []), target]);
  }
  nodes = command.nodes.map((node, index) => {
    const nearby = neighbors.get(node.path);
    const seeded = previous.get(node.path) ?? (nearby?.length
      ? {
          x: nearby.reduce((sum, value) => sum + value.x, 0) / nearby.length + 8,
          y: nearby.reduce((sum, value) => sum + value.y, 0) / nearby.length + 8,
        }
      : graphSeedPosition(node.path, index, command.nodes.length));
    const pin = pins.get(node.path);
    return {
      id: node.path,
      degree: node.degree,
      radius: 5 + Math.min(7, Math.sqrt(node.degree) * 1.6),
      x: seeded.x,
      y: seeded.y,
      ...(pin ? { fx: pin.x, fy: pin.y } : {}),
    };
  });
  nodesByPath = new Map(nodes.map((node) => [node.id, node]));
  postInterval = profile.postInterval;
  lastPost = 0;
  neighborsByPath = new Map(command.nodes.map((node) => [node.path, new Set<string>()]));
  for (const edge of command.edges) {
    neighborsByPath.get(edge.source)?.add(edge.target);
    neighborsByPath.get(edge.target)?.add(edge.source);
  }
  const links: LayoutLink[] = layoutEdges(command.edges, command.nodes.length).map((edge) => ({
    source: edge.source,
    target: edge.target,
  }));
  const centeringStrength = (node: LayoutNode) =>
    command.nodes.length <= 120 && node.degree === 0
      ? profile.centeringStrength * 5
      : profile.centeringStrength;
  simulation = forceSimulation<LayoutNode>(nodes)
    .alphaDecay(profile.alphaDecay)
    .velocityDecay(profile.velocityDecay)
    .force("link", forceLink<LayoutNode, LayoutLink>(links).id((node) => node.id).distance(profile.linkDistance).strength(profile.linkStrength))
    .force("x", forceX<LayoutNode>(0).strength(centeringStrength))
    .force("y", forceY<LayoutNode>(0).strength(centeringStrength))
    .on("tick", () => {
      const now = performance.now();
      if (now - lastPost >= postInterval) {
        lastPost = now;
        emit(false);
      }
    })
    .on("end", () => {
      if (!cooperativeLayout) separateRemainingOverlaps();
      emit(true);
    });
  if (profile.collisionIterations > 0) {
    simulation.force("collide", forceCollide<LayoutNode>().radius((node) => node.radius + 3).iterations(profile.collisionIterations));
  }
  if (profile.chargeStrength !== 0) {
    simulation.force("charge", forceManyBody<LayoutNode>().strength(profile.chargeStrength).distanceMax(profile.chargeDistance));
  }
  if (reducedMotion) settleImmediately("layout");
  else if (cooperativeLayout) {
    simulation.stop();
    scheduleCooperativeLayout();
  }
}

self.onmessage = (event: MessageEvent<GraphLayoutCommand>) => {
  try {
    const command = event.data;
    if (command.type === "layout") {
      start(command);
      return;
    }
    if (command.type === "pause") {
      stopCooperativeLayout();
      simulation?.stop();
      return;
    }
    if (command.type === "resume") {
      simulation?.alphaTarget(0);
      if (cooperativeLayout) scheduleCooperativeLayout();
      else simulation?.restart();
      return;
    }
    if (command.type === "stop") {
      stopCooperativeLayout();
      simulation?.alphaTarget(0).stop();
      separateRemainingOverlaps();
      emit(true, "stop");
      return;
    }
    if (command.type === "clear-pins") {
      for (const node of nodes) {
        node.fx = null;
        node.fy = null;
      }
      if (command.reducedMotion) settleImmediately("clear-pins");
      else if (cooperativeLayout) {
        simulation?.alphaTarget(0).alpha(1).stop();
        scheduleCooperativeLayout();
      } else simulation?.alpha(1).restart();
      return;
    }
    if (command.type !== "drag" && command.type !== "pin") return;
    const node = nodesByPath.get(command.position.path);
    if (!node) return;
    node.x = command.position.x;
    node.y = command.position.y;
    node.fx = command.position.x;
    node.fy = command.position.y;
    if (command.type === "drag" && command.reducedMotion) return;
    if (command.type === "drag") {
      const neighborhood = neighborsByPath.get(node.id) ?? new Set<string>();
      const affected = [node];
      for (const path of neighborhood) {
        const neighbor = nodesByPath.get(path);
        if (!neighbor || neighbor.fx != null) continue;
        const deltaX = (node.x ?? 0) - (neighbor.x ?? 0);
        const deltaY = (node.y ?? 0) - (neighbor.y ?? 0);
        const distance = Math.max(1, Math.hypot(deltaX, deltaY));
        const shift = Math.min(4, Math.max(0.5, distance * 0.04));
        const offsetX = (deltaX / distance) * shift;
        const offsetY = (deltaY / distance) * shift;
        neighbor.x = (neighbor.x ?? 0) + offsetX;
        neighbor.y = (neighbor.y ?? 0) + offsetY;
        neighbor.vx = (neighbor.vx ?? 0) + offsetX * 0.25;
        neighbor.vy = (neighbor.vy ?? 0) + offsetY * 0.25;
        affected.push(neighbor);
      }
      emitPositions(affected, false, "drag");
      if (cooperativeLayout) simulation?.alphaTarget(0.3).stop();
      else simulation?.alphaTarget(0.3).restart();
      return;
    }
    emit(command.reducedMotion);
    if (command.type === "pin" && !command.reducedMotion) {
      if (cooperativeLayout) {
        simulation?.alphaTarget(0).alpha(0.2).stop();
        scheduleCooperativeLayout();
      } else simulation?.alphaTarget(0).alpha(0.2).restart();
    }
  } catch (error) {
    postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    } satisfies GraphLayoutEvent);
  }
};
