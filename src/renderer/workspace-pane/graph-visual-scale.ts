function visualScale(nodeCount: number): number {
  if (nodeCount <= 300) return 1;
  return Math.max(0.12, Math.sqrt(90 / nodeCount));
}

export function graphNodeSize(degree: number, nodeCount: number, emphasized = false): number {
  const smallGraphWeight = nodeCount <= 300 ? 1.2 : 1;
  const scaled = (4 + Math.min(7, Math.sqrt(degree) * 1.5)) * visualScale(nodeCount) * smallGraphWeight;
  return emphasized ? Math.max(4, scaled) : Math.max(1.1, scaled);
}

export function graphEdgeSize(occurrenceCount: number, nodeCount: number): number {
  const scaled = (0.6 + Math.sqrt(occurrenceCount) * 0.65) * visualScale(nodeCount);
  return Math.max(0.18, Math.min(4, scaled));
}
