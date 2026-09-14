import { createHash, randomUUID } from "node:crypto";
import { renameSync, lstatSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import type {
  MarkdownDocumentSaveRequest,
  MarkdownDocumentSaveResult,
  MarkdownDocumentSnapshot,
  WorkspaceFileEntry,
  WorkspaceFileChange,
  WorkspaceFileReport,
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

const INVALID_NAME_MESSAGE = "Enter a valid single filename without path separators or control characters.";
function validEntryName(name: unknown): name is string {
  return typeof name === "string" && Boolean(name) && name !== "." && name !== ".." && !/[/\\\u0000-\u001f\u007f-\u009f]/.test(name);
}

/** Exclusive creation shared by the File Tree and missing Markdown links. */
export function createWorkspaceEntry(cwd: string, change: Extract<WorkspaceFileChange, { kind: "create" }>): WorkspaceFileReport {
  const fail = (code: WorkspaceFileReport["failures"][number]["code"], message: string): WorkspaceFileReport => ({ created: [], relocated: [], failures: [{ code, message }] });
  if (!change || change.kind !== "create" || typeof change.parent !== "string" ||
      typeof change.name !== "string" || !["file", "directory"].includes(change.entryKind)) {
    return fail("invalid-path", "Invalid create operation.");
  }
  const { name } = change;
  if (!validEntryName(name)) {
    return fail("invalid-path", INVALID_NAME_MESSAGE);
  }
  let parent: ReturnType<typeof resolveWorkspacePath>;
  try {
    const path = normalizeWorkspacePath(change.parent);
    if (isExcludedWorkspacePath(path ? `${path}/${name}` : name)) {
      return fail("invalid-path", "This path is excluded from Workspace browsing.");
    }
    parent = resolveWorkspacePath(cwd, path);
    if (!statSync(parent.absolute).isDirectory()) return fail("unavailable", "The parent is not a directory.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return /not found|ENOENT|ENOTDIR/.test(message)
      ? fail("unavailable", "The parent directory is unavailable.")
      : fail("invalid-path", "The path must stay inside the Workspace and cannot traverse a symlink or excluded directory.");
  }
  const path = parent.path ? `${parent.path}/${name}` : name;
  try {
    const absolute = join(parent.absolute, name);
    if (change.entryKind === "directory") mkdirSync(absolute);
    else writeFileSync(absolute, "", { flag: "wx" });
    return { created: [path], relocated: [], failures: [] };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return fail("exists", "An entry with this name already exists.");
    if (code === "ENOENT" || code === "ENOTDIR") return fail("unavailable", "The parent directory is unavailable.");
    return fail("io-error", "Could not create the entry. Check directory permissions and available disk space.");
  }
}

/** Validate both paths before changing a name; own writes are serialized by WorkspaceModule. */
export function renameWorkspaceEntry(cwd: string, change: Extract<WorkspaceFileChange, { kind: "rename" }>): WorkspaceFileReport {
  const fail = (code: WorkspaceFileReport["failures"][number]["code"], message: string): WorkspaceFileReport => ({ created: [], relocated: [], failures: [{ code, message }] });
  if (typeof change.path !== "string" || !validEntryName(change.name)) {
    return fail("invalid-path", INVALID_NAME_MESSAGE);
  }
  let source: ReturnType<typeof resolveWorkspacePath>;
  try {
    source = resolveWorkspacePath(cwd, change.path);
    if (!source.path) return fail("invalid-path", "The Workspace root cannot be renamed.");
    if (isExcludedWorkspacePath(change.name)) return fail("invalid-path", "This name is excluded from Workspace browsing.");
  } catch (error) {
    return /not found|ENOENT|ENOTDIR/.test(String(error))
      ? fail("unavailable", "The entry is unavailable.")
      : fail("invalid-path", "The path must stay inside the Workspace and cannot traverse a symlink or excluded directory.");
  }
  if (basename(source.path) === change.name) return { created: [], relocated: [], failures: [] };
  const destination = join(dirname(source.absolute), change.name);
  try {
    if (lstatSync(destination, { throwIfNoEntry: false })) return fail("exists", "An entry with this name already exists.");
    renameSync(source.absolute, destination);
    return { created: [], relocated: [{ from: source.path, to: toPosixRelative(source.root, destination) }], failures: [] };
  } catch {
    return fail("io-error", "Could not rename the entry. Check its availability and directory permissions.");
  }
}

/** A validated destination gates the batch; individual failures never roll back successes. */
export function moveWorkspaceEntries(cwd: string, change: Extract<WorkspaceFileChange, { kind: "move" }>): WorkspaceFileReport {
  const report: WorkspaceFileReport = { created: [], relocated: [], failures: [] };
  const fail = (source: string, code: WorkspaceFileReport["failures"][number]["code"], message: string) => {
    report.failures.push({ source, code, message });
  };
  if (!Array.isArray(change.paths) || !change.paths.every(path => typeof path === "string") || typeof change.destination !== "string") {
    fail("", "invalid-path", "Invalid move operation.");
    return report;
  }
  let destination: ReturnType<typeof resolveWorkspacePath>;
  try {
    destination = resolveWorkspacePath(cwd, change.destination);
    if (!statSync(destination.absolute).isDirectory()) throw new Error("Not a directory");
  } catch {
    fail(change.destination, "invalid-path", "The destination must be an available directory inside the Workspace, without symlinks or excluded paths.");
    return report;
  }
  const paths: string[] = [];
  for (const input of change.paths) {
    try {
      const path = normalizeWorkspacePath(input);
      if (!path || isExcludedWorkspacePath(path)) throw new Error("Invalid source");
      if (!paths.includes(path)) paths.push(path);
    } catch { fail(input, "invalid-path", "The source must be an entry inside the Workspace."); }
  }
  for (const path of paths.filter(path => !paths.some(parent => path.startsWith(`${parent}/`)))) {
    try {
      const source = resolveWorkspacePath(cwd, path);
      if (destination.path === path || destination.path.startsWith(`${path}/`)) {
        fail(path, "invalid-path", "A folder cannot move into itself or its descendants.");
        continue;
      }
      const to = destination.path ? `${destination.path}/${basename(path)}` : basename(path);
      if (to === path) continue;
      const absolute = join(destination.absolute, basename(path));
      if (lstatSync(absolute, { throwIfNoEntry: false })) {
        fail(path, "exists", "An entry with this name already exists.");
        continue;
      }
      renameSync(source.absolute, absolute);
      report.relocated.push({ from: path, to });
    } catch (error) {
      const message = String(error);
      fail(path, /not found|ENOENT|ENOTDIR/.test(message) ? "unavailable" : /symlink|excluded|escapes/.test(message) ? "invalid-path" : "io-error",
        "Could not move the entry. Check its availability, path and directory permissions.");
    }
  }
  return report;
}


/** Resolve Workspace identities before invoking the system trash adapter; never permanently delete. */
export async function trashWorkspaceEntries(cwd: string, change: Extract<WorkspaceFileChange, { kind: "trash" }>,
  trashEntry: (absolutePath: string) => Promise<void>): Promise<WorkspaceFileReport> {
  const report: WorkspaceFileReport = { created: [], relocated: [], trashed: [], failures: [] };
  if (!Array.isArray(change.paths) || !change.paths.length || !change.paths.every(path => typeof path === "string")) {
    report.failures.push({ code: "invalid-path", message: "Select files or folders to move to Trash." });
    return report;
  }
  const paths: string[] = [];
  for (const input of change.paths) {
    try {
      const path = normalizeWorkspacePath(input);
      if (!path || isExcludedWorkspacePath(path)) throw new Error("Invalid path");
      if (!paths.includes(path)) paths.push(path);
    } catch { report.failures.push({ source: input, code: "invalid-path", message: "Only entries inside the Workspace can be moved to Trash." }); }
  }
  for (const path of paths.filter(path => !paths.some(parent => path.startsWith(`${parent}/`)))) {
    try {
      const source = resolveWorkspacePath(cwd, path);
      await trashEntry(source.absolute);
      report.trashed!.push(path);
    } catch {
      report.failures.push({ source: path, code: "io-error", message: "Could not move this item to Trash. Check its availability, path and permissions." });
    }
  }
  return report;
}
