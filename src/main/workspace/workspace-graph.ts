import type {
  WorkspaceGraphEdge,
  WorkspaceGraphSnapshot,
  WorkspaceLinkIndexSnapshot,
} from "../../shared/workspace";

function basename(path: string): string {
  return path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path;
}

function graphLabels(paths: string[]): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const name = basename(path);
    const group = groups.get(name) ?? [];
    group.push(path);
    groups.set(name, group);
  }

  const labels = new Map<string, string>();
  for (const [name, group] of groups) {
    if (group.length === 1) {
      labels.set(group[0]!, name);
      continue;
    }
    for (const path of group) {
      const parents = path.split("/").slice(0, -1);
      let context = parents.at(-1) ?? "";
      for (let length = 1; length <= parents.length; length += 1) {
        const candidate = parents.slice(-length).join("/");
        const unique = group.every((other) => {
          if (other === path) return true;
          return other.split("/").slice(0, -1).slice(-length).join("/") !== candidate;
        });
        context = candidate;
        if (unique) break;
      }
      labels.set(path, `${name} · ${context}/`);
    }
  }
  return labels;
}

export function projectWorkspaceGraph(
  index: WorkspaceLinkIndexSnapshot,
): WorkspaceGraphSnapshot {
  if (index.status === "building") return { status: "building" };

  const paths = index.targets
    .filter((target) => target.kind === "markdown")
    .map((target) => target.path)
    .sort((a, b) => a.localeCompare(b));
  const markdown = new Set(paths);
  const aggregated = new Map<string, WorkspaceGraphEdge>();

  for (const record of index.records) {
    if (!markdown.has(record.path)) continue;
    for (const reference of record.references) {
      if (
        reference.target.status !== "resolved" ||
        reference.target.kind !== "markdown" ||
        reference.target.path === record.path ||
        !markdown.has(reference.target.path)
      ) continue;
      const key = `${record.path}\u0000${reference.target.path}`;
      const edge = aggregated.get(key) ?? {
        source: record.path,
        target: reference.target.path,
        occurrenceCount: 0,
        kindCounts: { link: 0, image: 0, embed: 0 },
      };
      edge.occurrenceCount += 1;
      edge.kindCounts[reference.kind] += 1;
      aggregated.set(key, edge);
    }
  }

  const edges = [...aggregated.values()].sort((a, b) =>
    a.source.localeCompare(b.source) || a.target.localeCompare(b.target)
  );
  const labels = graphLabels(paths);
  const degree = new Map(paths.map((path) => [path, 0]));
  const referenceCount = new Map(paths.map((path) => [path, 0]));
  for (const edge of edges) {
    degree.set(edge.source, degree.get(edge.source)! + 1);
    degree.set(edge.target, degree.get(edge.target)! + 1);
    referenceCount.set(edge.source, referenceCount.get(edge.source)! + edge.occurrenceCount);
    referenceCount.set(edge.target, referenceCount.get(edge.target)! + edge.occurrenceCount);
  }

  return {
    status: "ready",
    revision: index.revision,
    nodes: paths.map((path) => ({
      path,
      label: labels.get(path)!,
      degree: degree.get(path)!,
      referenceCount: referenceCount.get(path)!,
    })),
    edges,
  };
}
