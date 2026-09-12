/**
 * Renderer fan-out for Workspace filesystem change notifications. The
 * DesktopShell routes `workspace_files_changed` events (current Workspace
 * only) here; the Workspace Pane and File Tree subscribe to refresh themselves.
 */
const listeners = new Set<(paths: string[]) => void>();

export function emitWorkspaceFilesChanged(paths: string[]): void {
  for (const listener of listeners) listener(paths);
}

export function onWorkspaceFilesChanged(
  listener: (paths: string[]) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
