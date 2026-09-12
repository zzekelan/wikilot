/**
 * Known Workspace display labels: normally just the directory name; on
 * collisions the shortest distinguishing parent context is appended. The
 * complete path always stays available through a tooltip in the UI.
 */
export function workspaceLabels(cwds: readonly string[]): Map<string, string> {
  const segments = new Map<string, string[]>();
  for (const cwd of cwds) {
    segments.set(
      cwd,
      cwd.split("/").filter(Boolean),
    );
  }

  const byName = new Map<string, string[]>();
  for (const cwd of cwds) {
    const parts = segments.get(cwd)!;
    const name = parts.at(-1) ?? cwd;
    const group = byName.get(name) ?? [];
    group.push(cwd);
    byName.set(name, group);
  }

  const labels = new Map<string, string>();
  for (const [name, group] of byName) {
    if (group.length === 1) {
      labels.set(group[0]!, name);
      continue;
    }
    for (const cwd of group) {
      const parts = segments.get(cwd)!;
      // Find the shortest suffix of segments that no sibling shares.
      let depth = 1;
      while (depth < parts.length) {
        const candidate = parts.slice(-depth - 1).join("/");
        const collides = group.some((other) => {
          if (other === cwd) return false;
          const otherParts = segments.get(other)!;
          return otherParts.slice(-depth - 1).join("/") === candidate;
        });
        if (!collides) {
          labels.set(cwd, candidate);
          break;
        }
        depth += 1;
      }
      if (!labels.has(cwd)) labels.set(cwd, parts.join("/"));
    }
  }
  return labels;
}
