/**
 * Durable Workspace Pane snapshots, persisted separately from Known Workspace
 * metadata in one small JSON document (`pane-state.json`) under Wikilot-owned
 * Agent data, keyed by canonical Workspace cwd. Every write re-reads and
 * atomically replaces the document (tmp + rename); snapshots never contain
 * document bodies or Graph layout.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  WorkspacePaneRestoreResult,
  WorkspacePaneSnapshot,
  WorkspacePaneState,
} from "../../shared/workspace";
import {
  initialWorkspacePaneState,
  sanitizeWorkspacePaneSnapshot,
  toWorkspacePaneSnapshot,
} from "../../shared/workspace";
import { defaultAgentDir, resolvePaneStatePath } from "../models";

export type WorkspacePaneStateStore = {
  /** Restore one Workspace's Pane snapshot, validating item by item. */
  load(cwd: string): WorkspacePaneRestoreResult;
  /** Persist one Workspace's Pane snapshot (atomic replace). */
  save(cwd: string, state: WorkspacePaneState): void;
  /** Forget one Workspace's Pane snapshot; never touches its directory. */
  remove(cwd: string): void;
};

type PaneStateDocument = {
  version: 1;
  panes: Record<string, WorkspacePaneSnapshot>;
};

function emptyDocument(): PaneStateDocument {
  return { version: 1, panes: {} };
}

const CORRUPT_DOCUMENT_WARNING =
  "Workspace Pane data was malformed; it was backed up and reset.";
const CORRUPT_ENTRY_WARNING =
  "Workspace Pane data was malformed; it was reset.";

function cwdDocumentKey(cwd: string): string {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("cwd is required");
  }
  return cwd;
}

export function createWorkspacePaneStore(options: {
  agentDir?: string;
  /** Injectable clock for the corrupt-backup stamp (tests). */
  now?: () => Date;
}): WorkspacePaneStateStore {
  const paneStatePath = resolvePaneStatePath(
    options.agentDir ?? defaultAgentDir(),
  );
  const now = options.now ?? (() => new Date());
  let pendingWarning: string | null = null;

  function backupMalformed(): void {
    const stamp = now()
      .toISOString()
      .replace(/[:.]/g, "-");
    renameSync(paneStatePath, `${paneStatePath}.${stamp}.corrupt`);
    pendingWarning = CORRUPT_DOCUMENT_WARNING;
  }

  function loadDocument(): PaneStateDocument {
    let raw: string;
    try {
      raw = readFileSync(paneStatePath, "utf8");
    } catch {
      return emptyDocument();
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const panes = parsed.panes;
      if (
        parsed.version !== 1 ||
        typeof panes !== "object" ||
        panes === null ||
        Array.isArray(panes)
      ) {
        throw new Error("Malformed Workspace Pane document");
      }
      return { version: 1, panes: panes as Record<string, WorkspacePaneSnapshot> };
    } catch {
      backupMalformed();
      return emptyDocument();
    }
  }

  function saveDocument(document: PaneStateDocument): void {
    mkdirSync(dirname(paneStatePath), { recursive: true });
    const temporary = `${paneStatePath}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );
    renameSync(temporary, paneStatePath);
  }

  function takeWarning(): string | undefined {
    const warning = pendingWarning ?? undefined;
    pendingWarning = null;
    return warning;
  }

  return {
    load(cwd) {
      const key = cwdDocumentKey(cwd);
      const document = loadDocument();
      const raw = document.panes[key];
      if (!raw) {
        const warning = takeWarning();
        return {
          state: initialWorkspacePaneState(),
          skipped: 0,
          ...(warning ? { warning } : {}),
        };
      }
      const sanitized = sanitizeWorkspacePaneSnapshot(raw);
      if (!sanitized) {
        // Fully corrupt snapshot for one Workspace: the document stays valid,
        // so only this entry is dropped and the pane data is reset.
        delete document.panes[key];
        saveDocument(document);
        return {
          state: initialWorkspacePaneState(),
          skipped: 0,
          warning: CORRUPT_ENTRY_WARNING,
        };
      }
      // Drop and forget invalid items so the next load starts clean.
      if (sanitized.skipped > 0) {
        document.panes[key] = toWorkspacePaneSnapshot(sanitized.state);
        saveDocument(document);
      }
      const warning = takeWarning();
      return {
        state: sanitized.state,
        skipped: sanitized.skipped,
        ...(warning ? { warning } : {}),
      };
    },

    save(cwd, state) {
      const key = cwdDocumentKey(cwd);
      const sanitized = sanitizeWorkspacePaneSnapshot(
        toWorkspacePaneSnapshot(state),
      );
      if (!sanitized) {
        throw new Error("Workspace Pane state is invalid");
      }
      const document = loadDocument();
      // Interleaved loads/saves re-read and re-apply, so parallel Workspaces
      // merge instead of clobbering each other.
      document.panes[key] = toWorkspacePaneSnapshot(sanitized.state);
      saveDocument(document);
    },

    remove(cwd) {
      const key = cwdDocumentKey(cwd);
      const document = loadDocument();
      if (document.panes[key] !== undefined) {
        delete document.panes[key];
        saveDocument(document);
      }
    },
  };
}
