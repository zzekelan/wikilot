import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import type {
  MarkdownDocumentSaveRequest,
  MarkdownDocumentSaveResult,
  MarkdownDocumentSnapshot,
  WorkspaceFileEntry,
  WorkspaceFileListResponse,
} from "../../shared/workspace";
import {
  isExcludedWorkspacePath,
  normalizeWorkspacePath,
  resolveWorkspacePath,
} from "./workspace-path";

const MAX_MARKDOWN_DOCUMENT_BYTES = 2 * 1024 * 1024;

function toPosixRelative(cwd: string, absolutePath: string): string {
  return relative(cwd, absolutePath).split(sep).join("/");
}

/** List one directory under the Workspace root (non-recursive). */
export function listWorkspaceFiles(
  cwd: string,
  relativePath = "",
): WorkspaceFileListResponse {
  const resolved = resolveWorkspacePath(cwd, relativePath);
  const dir = resolved.absolute;
  if (!statSync(dir).isDirectory()) {
    throw new Error("Path is not a directory");
  }

  const entries: WorkspaceFileEntry[] = [];
  for (const name of readdirSync(dir)) {
    const path = relative(resolved.root, join(dir, name)).split(sep).join("/");
    if (isExcludedWorkspacePath(path)) continue;
    const absolute = join(dir, name);
    let st;
    try {
      st = lstatSync(absolute);
      if (st.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    const kind = st.isDirectory() ? "directory" : st.isFile() ? "file" : null;
    if (!kind) continue;
    entries.push({
      name,
      path: toPosixRelative(resolved.root, absolute),
      kind,
    });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { entries };
}

function resolveWorkspaceFile(
  cwd: string,
  relativePath: string,
): {
  absolute: string;
  path: string;
} {
  const resolved = resolveWorkspacePath(cwd, relativePath);
  if (!statSync(resolved.absolute).isFile()) {
    throw new Error("Path is not a file");
  }
  return { absolute: resolved.absolute, path: resolved.path };
}

function requireMarkdownPath(path: string): void {
  if (extname(path).toLowerCase() !== ".md") {
    throw new Error("Markdown editing is available only for .md files");
  }
}

function versionOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url");
}

/** Read one complete Markdown document and reject a changing snapshot. */
export function openMarkdownDocument(
  cwd: string,
  relativePath: string,
): MarkdownDocumentSnapshot {
  const requestedPath = normalizeWorkspacePath(relativePath);
  requireMarkdownPath(requestedPath);
  let resolved: ReturnType<typeof resolveWorkspaceFile>;
  try {
    resolved = resolveWorkspaceFile(cwd, relativePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found|does not exist|enoent|no such file/i.test(message)) {
      return {
        path: requestedPath,
        status: "deleted",
        version: null,
        size: null,
      };
    }
    throw error;
  }
  try {
    let bytes: Buffer | null = null;
    let observedSize = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = statSync(resolved.absolute);
      const first = readFileSync(resolved.absolute);
      const second = readFileSync(resolved.absolute);
      const after = statSync(resolved.absolute);
      observedSize = after.size;
      if (
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ino === after.ino &&
        first.byteLength === after.size &&
        first.equals(second)
      ) {
        bytes = second;
        break;
      }
    }
    if (!bytes) {
      return { path: resolved.path, status: "waiting", version: null, size: observedSize };
    }
    const version = versionOf(bytes);
    if (bytes.byteLength > MAX_MARKDOWN_DOCUMENT_BYTES) {
      return {
        path: resolved.path,
        status: "too-large",
        version,
        size: bytes.byteLength,
      };
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        path: resolved.path,
        status: "non-utf8",
        version,
        size: bytes.byteLength,
      };
    }
    return {
      path: resolved.path,
      status: "ready",
      version,
      size: bytes.byteLength,
      content,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        path: resolved.path,
        status: "deleted",
        version: null,
        size: null,
      };
    }
    return {
      path: resolved.path,
      status: "unavailable",
      version: null,
      size: null,
    };
  }
}

/** Version-check and atomically replace one complete Markdown document. */
export async function saveMarkdownDocument(
  cwd: string,
  relativePath: string,
  request: MarkdownDocumentSaveRequest,
): Promise<MarkdownDocumentSaveResult> {
  const current = openMarkdownDocument(cwd, relativePath);
  if (current.status !== "ready" || current.version !== request.version) {
    return { outcome: "conflict", snapshot: current };
  }

  const bytes = Buffer.from(request.content, "utf8");
  if (bytes.byteLength > MAX_MARKDOWN_DOCUMENT_BYTES) {
    throw new Error(
      `Markdown document is too large (${bytes.byteLength} bytes; max ${MAX_MARKDOWN_DOCUMENT_BYTES})`,
    );
  }
  const { absolute } = resolveWorkspaceFile(cwd, relativePath);
  const mode = (await stat(absolute)).mode;
  const temporary = join(
    dirname(absolute),
    `.${basename(absolute)}.wikilot-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    const latest = openMarkdownDocument(cwd, relativePath);
    if (latest.status !== "ready" || latest.version !== request.version) {
      await rm(temporary, { force: true });
      return { outcome: "conflict", snapshot: latest };
    }
    await rename(temporary, absolute);
    const directory = await open(dirname(absolute), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  const snapshot = openMarkdownDocument(cwd, relativePath);
  if (snapshot.status !== "ready") {
    throw new Error("Markdown document could not be read after saving");
  }
  return { outcome: "saved", snapshot };
}
