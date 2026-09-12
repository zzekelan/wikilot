import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { WorkspaceSummary } from "../../shared/workspace";
import { encodeAbsoluteCwd } from "./workspace-identity";

/** A Workspace registered by open; persistence internals stay host-side. */
export type RegisteredWorkspace = {
  /** Opaque Workspace identity (derived from the canonical cwd). */
  id: string;
  cwd: string;
};

export type WorkspaceRegistry = {
  /**
   * Validate and register a local Workspace, returning its opaque identity.
   * Opening never creates, continues, or selects a Session.
   */
  open(cwd: string): WorkspaceSummary;
  /** Resolve a previously opened Workspace by opaque id (throws otherwise). */
  require(workspaceId: string): RegisteredWorkspace;
};

function assertWorkspaceDirectory(cwd: string): string {
  const resolved = resolve(cwd);
  if (!existsSync(resolved)) {
    throw new Error(`Workspace path does not exist: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  // Canonicalize so `/var/...` and `/private/var/...` share one identity.
  return realpathSync(resolved);
}

export function createWorkspaceRegistry(): WorkspaceRegistry {
  const registered = new Map<string, RegisteredWorkspace>();

  return {
    open(cwd) {
      const canonical = assertWorkspaceDirectory(cwd);
      const id = encodeAbsoluteCwd(canonical);
      let workspace = registered.get(id);
      if (!workspace) {
        workspace = {
          id,
          cwd: canonical,
        };
        registered.set(id, workspace);
      }
      return { id: workspace.id, cwd: workspace.cwd };
    },
    require(workspaceId) {
      const workspace = registered.get(workspaceId);
      if (!workspace) {
        throw new Error("Open the Workspace before using it");
      }
      return workspace;
    },
  };
}
