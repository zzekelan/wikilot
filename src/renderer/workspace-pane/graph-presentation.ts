export type GraphNodeFocus = "idle" | "hovered" | "neighbor" | "background";
export type GraphEdgeFocus = "idle" | "focused" | "background";

type Rgba = [red: number, green: number, blue: number, alpha: number];

function parseGraphColor(value: string): Rgba | null {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (hex) {
    const channels = hex[1]!;
    return [
      Number.parseInt(channels.slice(0, 2), 16),
      Number.parseInt(channels.slice(2, 4), 16),
      Number.parseInt(channels.slice(4, 6), 16),
      hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1,
    ];
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(value);
  if (!rgba) return null;
  return [Number(rgba[1]), Number(rgba[2]), Number(rgba[3]), rgba[4] === undefined ? 1 : Number(rgba[4])];
}

export function mixGraphColor(from: string, to: string, progress: number): string {
  const start = parseGraphColor(from);
  const end = parseGraphColor(to);
  const amount = Math.max(0, Math.min(1, progress));
  if (!start || !end) return amount < 0.5 ? from : to;
  const channel = (index: 0 | 1 | 2) => Math.round(start[index] + (end[index] - start[index]) * amount);
  const alpha = start[3] + (end[3] - start[3]) * amount;
  return `rgba(${channel(0)}, ${channel(1)}, ${channel(2)}, ${alpha.toFixed(3)})`;
}

export function graphNodeFocus(
  path: string,
  hoveredPath: string | null,
  isNeighbor: boolean,
): GraphNodeFocus {
  if (!hoveredPath) return "idle";
  if (path === hoveredPath) return "hovered";
  return isNeighbor ? "neighbor" : "background";
}

export function graphEdgeFocus(
  hoveredPath: string | null,
  source: string,
  target: string,
): GraphEdgeFocus {
  if (!hoveredPath) return "idle";
  return source === hoveredPath || target === hoveredPath
    ? "focused"
    : "background";
}
