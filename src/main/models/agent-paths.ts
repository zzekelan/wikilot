import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Wikilot-owned user Agent data root (never `~/.pi`). Auth, models, and App
 * Defaults persist here so Pi's file-backed stores stay App-scoped.
 * `WIKILOT_AGENT_DIR` overrides the root (acceptance runs, sandboxed hosts).
 */
export function defaultAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WIKILOT_AGENT_DIR?.trim();
  return override ? resolve(override) : join(homedir(), ".wikilot", "agent");
}

/** Pi CredentialStore backing file (auth.json, file-locked by Pi). */
export function resolveAuthPath(agentDir: string = defaultAgentDir()): string {
  return join(agentDir, "auth.json");
}

/** Pi user model configuration (models.json) feeding the Base Model Catalog. */
export function resolveModelsPath(agentDir: string = defaultAgentDir()): string {
  return join(agentDir, "models.json");
}

/** Wikilot App Defaults file (Defaults are a Wikilot concern, not Pi's). */
export function resolveDefaultsPath(agentDir: string = defaultAgentDir()): string {
  return join(agentDir, "defaults.json");
}

/** Durable Known Workspace collection (owned by Wikilot, never Pi). */
export function resolveWorkspacesPath(
  agentDir: string = defaultAgentDir(),
): string {
  return join(agentDir, "workspaces.json");
}

/** Durable Workspace Pane snapshots (owned by Wikilot, never Pi). */
export function resolvePaneStatePath(
  agentDir: string = defaultAgentDir(),
): string {
  return join(agentDir, "pane-state.json");
}
