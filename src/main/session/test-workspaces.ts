import { mkdirSync, realpathSync } from "node:fs";
import { encodeAbsoluteCwd } from "../workspace";

/** Session-test adapter for the Workspace identity dependency. */
export function createTestWorkspaces() {
  const workspaces = new Map<string, { id: string; cwd: string }>();
  return {
    open(cwd: string) {
      mkdirSync(cwd, { recursive: true });
      const canonicalCwd = realpathSync(cwd);
      const workspace = { id: encodeAbsoluteCwd(canonicalCwd), cwd: canonicalCwd };
      workspaces.set(workspace.id, workspace);
      return workspace;
    },
    resolve(workspaceId: string) {
      const workspace = workspaces.get(workspaceId);
      if (!workspace) throw new Error("Open the Workspace before using it");
      return workspace;
    },
  };
}
