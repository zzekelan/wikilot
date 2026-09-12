let nextEscapeLayerId = 0;
const escapeLayers = new Map<number, () => void>();

/** Register one transient surface; Escape always closes only the newest one. */
export function pushEscapeLayer(close: () => void): () => void {
  nextEscapeLayerId += 1;
  const id = nextEscapeLayerId;
  escapeLayers.set(id, close);
  return () => escapeLayers.delete(id);
}

export function closeTopEscapeLayer(): boolean {
  const top = Array.from(escapeLayers.values()).at(-1);
  if (!top) return false;
  top();
  return true;
}
