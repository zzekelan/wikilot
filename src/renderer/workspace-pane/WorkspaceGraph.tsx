import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import {
  createEdgeArrowProgram,
  type NodeHoverDrawingFunction,
  type NodeLabelDrawingFunction,
} from "sigma/rendering";
import { Maximize2, RotateCcw, Square } from "lucide-react";
import type { WorkspaceGraphNode, WorkspaceGraphSnapshot } from "../../shared/workspace";
import type {
  GraphLayoutCommand,
  GraphLayoutEvent,
  GraphPosition,
} from "./graph-layout-protocol";
import { graphSeedPosition } from "./graph-layout-seed";
import { graphEdgeSize, graphNodeSize } from "./graph-visual-scale";
import { graphEdgeFocus, graphNodeFocus, mixGraphColor } from "./graph-presentation";

export type WorkspaceGraphViewState = {
  positions: Map<string, GraphPosition>;
  pins: Map<string, GraphPosition>;
  camera: { x: number; y: number; ratio: number; angle: number } | null;
};

type WorkspaceGraphProps = {
  active: boolean;
  viewState: MutableRefObject<WorkspaceGraphViewState>;
  snapshot: Extract<WorkspaceGraphSnapshot, { status: "ready" }>;
  originPath: string | null;
  onOpenNode(path: string): void;
};

type NodeAttributes = {
  x: number;
  y: number;
  size: number;
  label: string;
  labelColor: string;
  color: string;
  focusProgress?: number;
  forceLabel?: boolean;
  hidden?: boolean;
};

type EdgeAttributes = {
  size: number;
  color: string;
  type: "focus-arrow" | "line";
  hidden?: boolean;
};

type Tooltip = {
  node: WorkspaceGraphNode;
  x: number;
  y: number;
};

function prefersReducedMotion(): boolean {
  return document.documentElement.classList.contains("proto-rm") ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(prefersReducedMotion());
    media?.addEventListener("change", update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      media?.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  return reduced;
}

function useGraphTheme(): "light" | "dark" {
  const currentTheme = () => document.documentElement.classList.contains("dark") ? "dark" : "light";
  const [theme, setTheme] = useState<"light" | "dark">(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

const drawGraphNodeHover: NodeHoverDrawingFunction<NodeAttributes, EdgeAttributes> = (
  context,
  data,
  settings,
) => {
  const progress = (data as typeof data & { focusProgress?: number }).focusProgress ?? 1;
  context.save();
  context.globalAlpha = 0.15 + progress * 0.85;
  context.fillStyle = data.color;
  context.strokeStyle = data.color;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
  context.fill();
  context.beginPath();
  context.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
  context.stroke();
  drawGraphNodeLabel(context, data, settings);
  context.restore();
};

const drawGraphNodeLabel: NodeLabelDrawingFunction<NodeAttributes, EdgeAttributes> = (
  context,
  data,
  settings,
) => {
  if (!data.label) return;
  context.save();
  context.fillStyle = (data as typeof data & { labelColor?: string }).labelColor
    ?? settings.labelColor.color
    ?? "#292d2a";
  context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillText(data.label, data.x, data.y + data.size + 3);
  context.restore();
};

export function WorkspaceGraph({
  active,
  viewState,
  snapshot,
  originPath,
  onOpenNode,
}: WorkspaceGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const sigmaRef = useRef<Sigma<NodeAttributes, EdgeAttributes> | null>(null);
  const onOpenNodeRef = useRef(onOpenNode);
  onOpenNodeRef.current = onOpenNode;
  const positionsRef = useRef(viewState.current.positions);
  const pinsRef = useRef(viewState.current.pins);
  const cameraRef = useRef(viewState.current.camera);
  const [pinCount, setPinCount] = useState(viewState.current.pins.size);
  const [layoutRunning, setLayoutRunning] = useState(true);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const reducedMotion = useReducedMotion();
  const graphTheme = useGraphTheme();

  useLayoutEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const styles = getComputedStyle(container);
    const pine = styles.getPropertyValue("--color-highlight").trim() || "#466b57";
    const ink = styles.getPropertyValue("--color-ink").trim() || "#292d2a";
    const muted = styles.getPropertyValue("--color-muted").trim() || "#777b76";
    const border = styles.getPropertyValue("--color-border").trim() || "#c7c9c4";
    const paper = styles.getPropertyValue("--color-paper").trim() || "#faf9f6";
    const backgroundEdgeColor = mixGraphColor(border, paper, 0.35);
    const priorPositions = [...positionsRef.current.values()];
    let graph = new Graph<NodeAttributes, EdgeAttributes>({ type: "directed", multi: false });
    const displayNodes = [...snapshot.nodes].sort((a, b) =>
      Number(b.path === originPath) - Number(a.path === originPath),
    );
    const nodeAttributes = (node: WorkspaceGraphNode, index: number): NodeAttributes => {
      const previous = positionsRef.current.get(node.path);
      const seeded = previous ?? { ...graphSeedPosition(node.path, index, snapshot.nodes.length), path: node.path };
      positionsRef.current.set(node.path, seeded);
      return {
        x: seeded.x,
        y: seeded.y,
        size: graphNodeSize(node.degree, snapshot.nodes.length, node.path === originPath),
        label: node.label,
        labelColor: ink,
        color: node.path === originPath ? pine : node.degree === 0 ? muted : ink,
        focusProgress: 0,
        forceLabel: false,
      };
    };
    const initialNodeCount = Math.min(300, displayNodes.length);
    displayNodes.slice(0, initialNodeCount).forEach((node, index) => {
      graph.addNode(node.path, nodeAttributes(node, index));
    });
    let graphLoadTimer = 0;

    let hovered: string | null = null;
    let focused: string | null = null;
    let focusProgress = 0;
    let focusAnimationFrame = 0;
    const nodeFocusColors = new Map([ink, muted, pine].map((color) =>
      [color, { hovered: color, background: color }]));
    let backgroundLabelColor = ink;
    let focusedEdgeColor = border;
    let fadedEdgeColor = border;
    const updateFocusColors = () => {
      for (const [color, colors] of nodeFocusColors) {
        colors.hovered = mixGraphColor(color, pine, focusProgress);
        colors.background = mixGraphColor(color, `${muted}55`, focusProgress);
      }
      backgroundLabelColor = mixGraphColor(ink, `${muted}30`, focusProgress);
      focusedEdgeColor = mixGraphColor(border, pine, focusProgress);
      fadedEdgeColor = mixGraphColor(border, backgroundEdgeColor, focusProgress);
    };
    let dragged: string | null = null;
    let dragMoved = false;
    let restoreEdgesTimer = 0;
    let tooltipTimer = 0;
    container.dataset.nodeCount = String(initialNodeCount);
    container.dataset.edgeCount = "0";
    container.dataset.originPath = originPath ?? "";
    container.dataset.hoveredPath = "";
    container.dataset.focusProgress = "0";
    container.dataset.renderSequence = "0";
    const createRenderer = () => new Sigma<NodeAttributes, EdgeAttributes>(graph, container, {
      defaultEdgeType: "line",
      edgeProgramClasses: { "focus-arrow": createEdgeArrowProgram<NodeAttributes, EdgeAttributes>() },
      hideEdgesOnMove: snapshot.edges.length > 10_000,
      hideLabelsOnMove: snapshot.nodes.length > 1_000,
      inertiaDuration: reducedMotion ? 0 : 500,
      enableEdgeEvents: false,
      renderEdgeLabels: false,
      labelColor: { attribute: "labelColor", color: ink },
      labelFont: "Inter, sans-serif",
      labelSize: 11,
      labelWeight: "500",
      stagePadding: 40,
      defaultDrawNodeLabel: drawGraphNodeLabel,
      defaultDrawNodeHover: drawGraphNodeHover,
      ...(snapshot.nodes.length <= 120
        ? { labelDensity: 1, labelGridCellSize: 80, labelRenderedSizeThreshold: 4 }
        : { labelDensity: 0.3, labelGridCellSize: 140, labelRenderedSizeThreshold: 6 }),
      nodeReducer(node, attributes) {
        if (!focused || focusProgress <= 0) return attributes;
        const focus = graphNodeFocus(node, focused, graph.areNeighbors(node, focused));
        const background = focus === "background";
        const colors = nodeFocusColors.get(attributes.color)!;
        return {
          ...attributes,
          color: focus === "hovered" ? colors.hovered : background ? colors.background : attributes.color,
          labelColor: background ? backgroundLabelColor : ink,
          focusProgress: focus === "hovered" ? focusProgress : undefined,
          forceLabel: focus === "hovered" && focusProgress > 0.2,
        };
      },
      edgeReducer(edge, attributes) {
        if (dragged && snapshot.edges.length > 10_000) return { ...attributes, hidden: true };
        if (!focused || focusProgress <= 0) return attributes;
        const [source, target] = graph.extremities(edge);
        const focus = graphEdgeFocus(focused, source, target);
        return {
          ...attributes,
          color: focus === "focused" ? focusedEdgeColor : fadedEdgeColor,
        };
      },
    });
    let renderer = createRenderer();
    sigmaRef.current = renderer;
    if (cameraRef.current) renderer.getCamera().setState(cameraRef.current);
    const recordRenderState = () => {
      container.dataset.renderSequence = String(Number(container.dataset.renderSequence ?? "0") + 1);
      container.dataset.cameraState = JSON.stringify(renderer.getCamera().getState());
      container.dataset.pinCount = String(pinsRef.current.size);
    };
    renderer.on("afterRender", recordRenderState);
    const setFocusEdgeTypes = (node: string | null) => {
      if (graph.size === 0) return;
      graph.updateEachEdgeAttributes((edge, attributes) => {
        const [source, target] = graph.extremities(edge);
        const isFocused = node !== null && (source === node || target === node);
        return {
          ...attributes,
          type: isFocused ? "focus-arrow" : "line",
        };
      }, { attributes: ["type"] });
    };
    const animateFocus = (node: string | null) => {
      cancelAnimationFrame(focusAnimationFrame);
      focusAnimationFrame = 0;
      if (dragged) return;
      if (node && node !== focused) {
        setFocusEdgeTypes(node);
        focused = node;
        focusProgress = 0;
      }
      const from = focusProgress;
      const to = node ? 1 : 0;
      if (reducedMotion || from === to) {
        focusProgress = to;
        updateFocusColors();
        container.dataset.focusProgress = String(to);
        if (to === 0) {
          focused = null;
          setFocusEdgeTypes(null);
        }
        renderer.refresh();
        return;
      }
      const startedAt = performance.now();
      const duration = to > from ? 240 : 200;
      const tick = (now: number) => {
        const elapsed = Math.min(1, (now - startedAt) / duration);
        const eased = elapsed * elapsed * (3 - 2 * elapsed);
        focusProgress = from + (to - from) * eased;
        updateFocusColors();
        container.dataset.focusProgress = focusProgress.toFixed(3);
        // Already inside RAF: rebuild indices now so input events cannot
        // request a partial repaint between index invalidation and rendering.
        renderer.refresh();
        if (elapsed < 1) {
          focusAnimationFrame = requestAnimationFrame(tick);
          return;
        }
        focusAnimationFrame = 0;
        if (to === 0) {
          focused = null;
          setFocusEdgeTypes(null);
        }
      };
      focusAnimationFrame = requestAnimationFrame(tick);
    };
    graphLoadTimer = window.setTimeout(() => {
      const completeGraph = new Graph<NodeAttributes, EdgeAttributes>({ type: "directed", multi: false });
      displayNodes.forEach((node, index) => {
        completeGraph.addNode(node.path, nodeAttributes(node, index));
      });
      snapshot.edges.forEach((edge, index) => {
        completeGraph.addDirectedEdgeWithKey(`${index}:${edge.source}:${edge.target}`, edge.source, edge.target, {
          size: graphEdgeSize(edge.occurrenceCount, snapshot.nodes.length),
          color: border,
          type: "line",
        });
      });
      graph = completeGraph;
      const camera = renderer.getCamera().getState();
      renderer.off("afterRender", recordRenderState);
      renderer.kill();
      renderer = createRenderer();
      renderer.getCamera().setState(camera);
      sigmaRef.current = renderer;
      renderer.on("afterRender", recordRenderState);
      bindRendererEvents(renderer);
      if (focused) setFocusEdgeTypes(focused);
      container.dataset.nodeCount = String(graph.order);
      container.dataset.edgeCount = String(graph.size);
      renderer.refresh();
    }, 180);

    const worker = new Worker(new URL("./graph-layout.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    let pendingPositions: Extract<GraphLayoutEvent, { type: "positions" }> | null = null;
    let positionFrame = 0;
    const applyPositions = () => {
      positionFrame = 0;
      const update = pendingPositions;
      pendingPositions = null;
      if (!update) return;
      for (const position of update.positions) positionsRef.current.set(position.path, position);
      if (hovered && !dragged) {
        setLayoutRunning(!update.settled);
        return;
      }
      if (update.positions.length < graph.order) {
        for (const position of update.positions) {
          if (position.path !== hovered && graph.hasNode(position.path)) {
            graph.mergeNodeAttributes(position.path, { x: position.x, y: position.y });
          }
        }
      } else {
        const updates = new Map(update.positions.map((position) => [position.path, position]));
        graph.updateEachNodeAttributes((path, attributes) => {
          if (path === hovered) return attributes;
          const position = updates.get(path);
          return position ? { ...attributes, x: position.x, y: position.y } : attributes;
        }, { attributes: ["x", "y"] });
      }
      renderer.refresh();
      setLayoutRunning(!update.settled);
    };
    worker.onmessage = (event: MessageEvent<GraphLayoutEvent>) => {
      if (event.data.type === "error") {
        setLayoutError(event.data.message);
        setLayoutRunning(false);
        return;
      }
      pendingPositions = event.data;
      if (positionFrame === 0) positionFrame = requestAnimationFrame(applyPositions);
    };
    worker.onerror = (event) => {
      setLayoutError(event.message || "Graph layout failed");
      setLayoutRunning(false);
    };
    worker.postMessage({
      type: "layout",
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      positions: priorPositions,
      pins: [...pinsRef.current.values()],
      reducedMotion,
    } satisfies GraphLayoutCommand);

    function bindRendererEvents(target: Sigma<NodeAttributes, EdgeAttributes>): void {
      target.on("enterNode", ({ node, event }) => {
        hovered = node;
        animateFocus(node);
        target.getContainer().dataset.hoveredPath = node;
        clearTimeout(tooltipTimer);
        const data = snapshot.nodes.find((candidate) => candidate.path === node);
        if (data) {
          const { width, height } = target.getDimensions();
          tooltipTimer = window.setTimeout(() => setTooltip({
            node: data,
            x: Math.max(8, Math.min(event.x + 12, width - 300)),
            y: Math.max(8, Math.min(event.y + 12, height - 70)),
          }), 350);
        }
        target.refresh();
      });
      target.on("leaveNode", () => {
        hovered = null;
        animateFocus(null);
        target.getContainer().dataset.hoveredPath = "";
        clearTimeout(tooltipTimer);
        setTooltip(null);
        target.refresh();
      });
      target.on("clickNode", ({ node }) => {
        if (dragMoved) {
          dragMoved = false;
          return;
        }
        onOpenNodeRef.current(node);
      });
      target.on("downNode", ({ node, preventSigmaDefault }) => {
        dragged = node;
        dragMoved = false;
        cancelAnimationFrame(focusAnimationFrame);
        focusAnimationFrame = 0;
        worker.postMessage({ type: "pause" } satisfies GraphLayoutCommand);
        preventSigmaDefault();
      });
      const captor = target.getMouseCaptor();
      const setLargeEdgesHidden = (hidden: boolean) => {
        if (snapshot.edges.length <= 10_000 || graph.size === 0) return;
        graph.updateEachEdgeAttributes((_edge, attributes) => ({ ...attributes, hidden }), {
          attributes: ["hidden"],
        });
        target.refresh();
      };
      captor.on("mousedown", () => {
        clearTimeout(restoreEdgesTimer);
        setLargeEdgesHidden(true);
      });
      captor.on("mousemovebody", (event) => {
        if (!dragged) return;
        event.preventSigmaDefault();
        dragMoved = true;
        const point = target.viewportToGraph(event);
        graph.mergeNodeAttributes(dragged, point);
        const position = { path: dragged, x: point.x, y: point.y };
        positionsRef.current.set(dragged, position);
        worker.postMessage({ type: "drag", position, reducedMotion } satisfies GraphLayoutCommand);
        target.scheduleRefresh({ partialGraph: { nodes: [dragged] } });
      });
      captor.on("mouseup", (event) => {
        restoreEdgesTimer = window.setTimeout(() => setLargeEdgesHidden(false), 180);
        if (!dragged) return;
        if (!dragMoved) {
          worker.postMessage({ type: "resume" } satisfies GraphLayoutCommand);
          dragged = null;
          animateFocus(hovered);
          return;
        }
        const point = target.viewportToGraph(event);
        const pin = { path: dragged, x: point.x, y: point.y };
        pinsRef.current.set(dragged, pin);
        setPinCount(pinsRef.current.size);
        if (containerRef.current) containerRef.current.dataset.pinCount = String(pinsRef.current.size);
        positionsRef.current.set(dragged, pin);
        worker.postMessage({ type: "pin", position: pin, reducedMotion } satisfies GraphLayoutCommand);
        dragged = null;
        animateFocus(hovered);
      });
    }
    bindRendererEvents(renderer);

    return () => {
      cameraRef.current = renderer.getCamera().getState();
      viewState.current = {
        camera: cameraRef.current,
        positions: positionsRef.current,
        pins: pinsRef.current,
      };
      clearTimeout(graphLoadTimer);
      clearTimeout(restoreEdgesTimer);
      clearTimeout(tooltipTimer);
      cancelAnimationFrame(focusAnimationFrame);
      cancelAnimationFrame(positionFrame);
      worker.terminate();
      renderer.off("afterRender", recordRenderState);
      renderer.kill();
      workerRef.current = null;
      sigmaRef.current = null;
    };
  }, [active, graphTheme, originPath, reducedMotion, snapshot.revision]);

  function relayout(): void {
    pinsRef.current.clear();
    setPinCount(0);
    setLayoutRunning(true);
    workerRef.current?.postMessage({ type: "clear-pins", reducedMotion } satisfies GraphLayoutCommand);
  }

  function retryLayout(): void {
    setLayoutError(null);
    relayout();
  }

  function stop(): void {
    workerRef.current?.postMessage({ type: "stop" } satisfies GraphLayoutCommand);
  }

  function fit(): void {
    const camera = sigmaRef.current?.getCamera();
    if (!camera) return;
    if (reducedMotion) camera.setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
    else void camera.animatedReset({ duration: 260 });
  }

  return <div className="workspace-graph" data-testid="workspace-graph" data-pin-count={pinCount} data-reduced-motion={reducedMotion ? "true" : "false"}>
    <div
      ref={containerRef}
      className="workspace-graph-canvas"
      role="img"
      aria-label={`Workspace graph: ${snapshot.nodes.length} notes, ${snapshot.edges.length} links`}
    />
    {layoutError ? <div className="workspace-graph-layout-error" role="alert"><span>{layoutError}</span><button type="button" className="btn-secondary" onClick={retryLayout}>Retry</button></div> : null}
    <div className={layoutError ? "workspace-graph-pill workspace-graph-pill-error" : "workspace-graph-pill"} role="status">
      {layoutError ?? (layoutRunning ? "Laying out" : `${snapshot.nodes.length} notes · ${snapshot.edges.length} links`)}
    </div>
    {tooltip ? <div className="workspace-graph-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
      <strong>{tooltip.node.path}</strong>
      <span>Degree {tooltip.node.degree} · {tooltip.node.referenceCount} references</span>
    </div> : null}
    <div className="workspace-graph-controls" role="toolbar" aria-label="Graph controls">
      {layoutRunning ? <button type="button" className="icon-btn" title="Stop layout" aria-label="Stop layout" onClick={stop}><Square size={15} /></button>
      : <button type="button" className="icon-btn" title="Re-layout" aria-label="Re-layout" onClick={relayout}><RotateCcw size={15} /></button>}
      <button type="button" className="icon-btn" title="Fit to view" aria-label="Fit to view" onClick={fit}><Maximize2 size={15} /></button>
    </div>
  </div>;
}
