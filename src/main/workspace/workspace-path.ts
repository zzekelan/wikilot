import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const EXCLUDED_SEGMENTS = new Set([".git", "node_modules", ".DS_Store"]);

/** Normalize Renderer input to a Workspace-relative `/` path. */
export function normalizeWorkspacePath(input: string): string {
  if (CONTROL_CHARACTERS.test(input)) {
    throw new Error("Path contains control characters");
  }
  if (
    input.startsWith("/") ||
    input.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(input)
  ) {
    throw new Error("Path must be relative to the Workspace");
  }

  const replaced = input.replace(/\\/g, "/");
  if (!replaced || replaced === ".") return "";
  const parts = replaced.split("/").filter((part) => part && part !== ".");
  if (parts.some((part) => part === "..")) {
    throw new Error("Path escapes Workspace");
  }
  return parts.join("/");
}

export function isExcludedWorkspacePath(path: string): boolean {
  return path.split("/").some((part) => EXCLUDED_SEGMENTS.has(part));
}

function assertContained(root: string, candidate: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error("Path escapes Workspace");
  }
}

/** Resolve an existing Renderer path, rejecting every traversed symlink. */
export function resolveWorkspacePath(cwd: string, input: string): {
  root: string;
  path: string;
  absolute: string;
} {
  const path = normalizeWorkspacePath(input);
  if (isExcludedWorkspacePath(path)) throw new Error("Path is excluded from Workspace browsing");

  const root = realpathSync(cwd);
  const parts = path ? path.split("/") : [];
  let candidate = root;
  for (const part of parts) {
    candidate = resolve(candidate, part);
    assertContained(root, candidate);
    if (!existsSync(candidate)) throw new Error(`Path not found: ${path || "."}`);
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new Error("Workspace browsing does not follow symlinks");
    }
  }
  if (!existsSync(candidate)) throw new Error(`Path not found: ${path || "."}`);
  const real = realpathSync(candidate);
  assertContained(root, real);
  return { root, path, absolute: real };
}

/** Snapshot symlink paths without following them, for unlink-event filtering. */
export function collectWorkspaceSymlinkPaths(cwd: string): string[] {
  const root = realpathSync(cwd);
  const symlinks: string[] = [];
  const directories = [root];
  while (directories.length > 0) {
    const directory = directories.pop()!;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      if (isExcludedWorkspacePath(path)) continue;
      try {
        const stat = lstatSync(absolute);
        if (stat.isSymbolicLink()) symlinks.push(path);
        else if (stat.isDirectory()) directories.push(absolute);
      } catch {
        // A concurrent change will be handled by the watcher.
      }
    }
  }
  return symlinks;
}

/** Return the first existing symlink traversed by a watcher path. */
export function findWorkspaceSymlinkPrefix(cwd: string, input: string): string | null {
  const path = normalizeWorkspacePath(input);
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return null;
  }
  let candidate = root;
  const traversed: string[] = [];
  for (const part of path.split("/")) {
    traversed.push(part);
    candidate = resolve(candidate, part);
    try {
      if (!existsSync(candidate)) return null;
      if (lstatSync(candidate).isSymbolicLink()) return traversed.join("/");
    } catch {
      return null;
    }
  }
  return null;
}

/** A missing cached prefix stays excluded until replaced by an ordinary path. */
export function cachedSymlinkStillExcluded(cwd: string, prefix: string): boolean {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return true;
  }
  const absolute = resolve(root, ...prefix.split("/"));
  try {
    return !existsSync(absolute) || lstatSync(absolute).isSymbolicLink();
  } catch {
    return true;
  }
}

/** Validate a watcher hint. Missing leaves are allowed for delete events. */
export function normalizeWorkspaceEventPath(cwd: string, input: string): string | null {
  let path: string;
  try {
    path = normalizeWorkspacePath(input);
  } catch {
    return null;
  }
  if (!path || isExcludedWorkspacePath(path)) return null;

  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return null;
  }
  let candidate = root;
  for (const part of path.split("/")) {
    candidate = resolve(candidate, part);
    try {
      assertContained(root, candidate);
      if (!existsSync(candidate)) break;
      if (lstatSync(candidate).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }
  return path;
}
