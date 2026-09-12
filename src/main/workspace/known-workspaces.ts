/**
 * Durable Known Workspace collection: one small JSON document
 * (`workspaces.json`) in Wikilot-owned Agent data, following
 * `WIKILOT_AGENT_DIR`. Entries order by recent successful use with no
 * automatic eviction; the launch-restoration hint is a canonical path,
 * never an opaque id.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { defaultAgentDir, resolveWorkspacesPath } from "../models";

export type StoredKnownWorkspace = {
  /** Canonical absolute Workspace path (the durable identity). */
  cwd: string;
  /** ISO time of the most recent successful open. */
  lastOpenedAt: string;
  /** The Workspace's remembered Selected Session, if any. */
  selectedSessionId?: string;
};

export type KnownWorkspacesSnapshot = {
  /** Recent successful use first. */
  workspaces: StoredKnownWorkspace[];
  /** Launch-restoration hint: the last successfully selected Workspace. */
  launchCwd: string | null;
  /** One-time warning after a malformed document was backed up. */
  warning: string | null;
};

export type KnownWorkspaceStore = {
  read(): KnownWorkspacesSnapshot;
  /** Add or refresh one entry after a successful open; sets the launch target. */
  recordOpen(cwd: string): void;
  /** Remember the Workspace's Selected Session (no recency/launch change). */
  recordSessionSelection(cwd: string, sessionId: string): void;
  /** Forget a remembered Session (e.g. it was deleted). */
  clearSessionSelection(cwd: string, sessionId: string): void;
  /** Forget the Workspace itself; never touches its directory or Sessions. */
  remove(cwd: string): void;
};

type WorkspacesDocument = {
  version: 1;
  launchCwd: string | null;
  workspaces: StoredKnownWorkspace[];
};

const EMPTY_DOCUMENT: WorkspacesDocument = {
  version: 1,
  launchCwd: null,
  workspaces: [],
};

function isStoredWorkspace(value: unknown): value is StoredKnownWorkspace {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.cwd === "string" &&
    typeof entry.lastOpenedAt === "string" &&
    (entry.selectedSessionId === undefined ||
      typeof entry.selectedSessionId === "string")
  );
}

function parseDocument(raw: string): WorkspacesDocument {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (
    parsed.version !== 1 ||
    !(parsed.launchCwd === null || typeof parsed.launchCwd === "string") ||
    !Array.isArray(parsed.workspaces) ||
    !parsed.workspaces.every(isStoredWorkspace)
  ) {
    throw new Error("Malformed Known Workspace document");
  }
  return {
    version: 1,
    launchCwd: parsed.launchCwd,
    workspaces: parsed.workspaces.map((entry) => ({ ...entry })),
  };
}

function byRecency(
  a: StoredKnownWorkspace,
  b: StoredKnownWorkspace,
): number {
  return b.lastOpenedAt.localeCompare(a.lastOpenedAt);
}

export function createKnownWorkspaceStore(options: {
  agentDir?: string;
  /** Injectable clock (tests). */
  now?: () => Date;
}): KnownWorkspaceStore {
  const workspacesPath = resolveWorkspacesPath(
    options.agentDir ?? defaultAgentDir(),
  );
  const now = options.now ?? (() => new Date());
  let pendingWarning: string | null = null;

  function backupMalformed(): void {
    const stamp = now()
      .toISOString()
      .replace(/[:.]/g, "-");
    renameSync(workspacesPath, `${workspacesPath}.${stamp}.corrupt`);
    pendingWarning =
      "Known Workspace data was malformed; it was backed up and reset.";
  }

  function loadDocument(): WorkspacesDocument {
    let raw: string;
    try {
      raw = readFileSync(workspacesPath, "utf8");
    } catch {
      return { ...EMPTY_DOCUMENT, workspaces: [] };
    }
    try {
      return parseDocument(raw);
    } catch {
      backupMalformed();
      return { ...EMPTY_DOCUMENT, workspaces: [] };
    }
  }

  function saveDocument(document: WorkspacesDocument): void {
    mkdirSync(dirname(workspacesPath), { recursive: true });
    const temporary = `${workspacesPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temporary, workspacesPath);
  }

  // Every mutation re-reads the document before writing, so interleaved
  // Renderer/Host updates merge instead of clobbering each other.
  function mutate(
    change: (document: WorkspacesDocument) => void,
  ): void {
    const document = loadDocument();
    change(document);
    document.workspaces.sort(byRecency);
    saveDocument(document);
  }

  return {
    read() {
      const document = loadDocument();
      document.workspaces.sort(byRecency);
      const warning = pendingWarning;
      pendingWarning = null;
      return {
        workspaces: document.workspaces,
        launchCwd: document.launchCwd,
        warning,
      };
    },

    recordOpen(cwd) {
      mutate((document) => {
        const at = now().toISOString();
        const existing = document.workspaces.find((entry) => entry.cwd === cwd);
        // Re-insert at the head so recency order is exact even when two
        // opens land within the same clock tick.
        document.workspaces = document.workspaces.filter(
          (entry) => entry.cwd !== cwd,
        );
        document.workspaces.unshift({ ...existing, cwd, lastOpenedAt: at });
        document.launchCwd = cwd;
      });
    },

    recordSessionSelection(cwd, sessionId) {
      mutate((document) => {
        const existing = document.workspaces.find((entry) => entry.cwd === cwd);
        if (existing) {
          existing.selectedSessionId = sessionId;
        }
      });
    },

    clearSessionSelection(cwd, sessionId) {
      mutate((document) => {
        const existing = document.workspaces.find((entry) => entry.cwd === cwd);
        if (existing?.selectedSessionId === sessionId) {
          delete existing.selectedSessionId;
        }
      });
    },

    remove(cwd) {
      mutate((document) => {
        document.workspaces = document.workspaces.filter(
          (entry) => entry.cwd !== cwd,
        );
        if (document.launchCwd === cwd) document.launchCwd = null;
      });
    },
  };
}
