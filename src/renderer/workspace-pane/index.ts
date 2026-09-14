export { WorkspacePane } from "./WorkspacePane";
export type { ProtectedFileChangeResult, WorkspacePaneSaveController } from "./useWorkspaceDocuments";
export {
  activateWorkspacePaneTab,
  backWorkspacePaneHistory,
  closeWorkspacePaneTab,
  forwardWorkspacePaneHistory,
  initialWorkspacePaneState,
  openWorkspacePaneTab,
  paneCanGoBack,
  paneCanGoForward,
  reorderWorkspacePaneTabs,
  setWorkspacePanePosition,
  setWorkspacePaneEditorSelection,
  setWorkspacePaneMode,
  toWorkspacePaneSnapshot,
} from "../../shared/workspace";
export type {
  WorkspacePaneRestoreResult,
  WorkspacePaneSnapshot,
  WorkspacePaneState,
  WorkspaceEditorSelection,
  WorkspaceTabMode,
} from "../../shared/workspace";
