const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function pathPhase(path: string): number {
  let hash = 2166136261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0xffffffff) * 0.35;
}

export function graphSeedPosition(path: string, index: number, count: number): { x: number; y: number } {
  const safeCount = Math.max(1, count);
  const extent = Math.max(72, Math.sqrt(safeCount) * 18);
  const radius = Math.sqrt((index + 0.5) / safeCount) * extent;
  const angle = index * GOLDEN_ANGLE + pathPhase(path);
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}
