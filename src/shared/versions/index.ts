export type Version = {
  id: string;
  message: string;
  author: string;
  date: string;
  files: number;
};
export type VersionsSnapshot = {
  initialized: boolean;
  changedFiles: number | null;
  versions: Version[];
  nextOffset: number | null;
};
/** Omit message to generate one; a supplied message must be nonempty. */
export type SaveVersionRequest = { message?: string; sessionId?: string };
export type SaveVersionResult = { saved: boolean };

export type VersionsChangedEvent = { type: "workspace_versions_changed"; workspaceId: string };

export type RestoreVersionResult = { restored: boolean };

export type VersionChange = { path: string; kind: "Added" | "Modified" | "Deleted" };
export type VersionFileDiff = { patch: string; unavailable: string | null };
