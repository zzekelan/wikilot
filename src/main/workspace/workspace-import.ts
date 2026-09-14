import { constants } from "node:fs";
import { copyFile, cp, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type { WorkspaceFileReport } from "../../shared/workspace";
import { isExcludedWorkspacePath, normalizeWorkspacePath, resolveWorkspacePath } from "./workspace-path";

/** Sources come only from Host-owned adapters; destination and naming policy stay here. */
export async function importWorkspaceFiles(cwd: string, destination: string, sources: string[], signal?: AbortSignal): Promise<WorkspaceFileReport> {
  const report: WorkspaceFileReport = { created: [], relocated: [], failures: [] };
  let parent: ReturnType<typeof resolveWorkspacePath>;
  try {
    parent = resolveWorkspacePath(cwd, destination);
    if (!(await lstat(parent.absolute)).isDirectory()) throw new Error("Not a directory");
  } catch {
    report.failures.push({ code: "invalid-path", message: "The destination must be an available directory inside the Workspace, without symlinks or excluded paths." });
    return report;
  }
  for (const source of sources) {
    if (signal?.aborted) break;
    let ownedDirectory: string | undefined;
    try {
      if (!isAbsolute(source)) throw new Error("Select a local file or folder using the system chooser.");
      const info = await lstat(source);
      if (!info.isFile() && !info.isDirectory()) throw new Error("Only ordinary files and folders can be imported; symbolic links are not supported.");
      const canonical = await realpath(source);
      const inside = relative(canonical, parent.absolute);
      if (info.isDirectory() && (inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)))) {
        throw new Error("A folder cannot be imported into itself or its descendants.");
      }
      const original = basename(source);
      // Validate before allocation so an excluded name cannot be made acceptable by suffixing it.
      const validateName = (name: string) => {
        if (name.includes("\\") || normalizeWorkspacePath(name) !== name || isExcludedWorkspacePath(name)) {
          throw new Error("This item contains a name or path excluded from Workspace browsing.");
        }
      };
      validateName(original);
      const extension = info.isFile() ? extname(original) : "";
      const stem = original.slice(0, original.length - extension.length);
      for (let suffix = 0; ; suffix++) {
        const name = suffix ? `${stem} (${suffix})${extension}` : original;
        // Revalidate after async disk work before reserving an exclusive target.
        signal?.throwIfAborted();
        const current = resolveWorkspacePath(cwd, destination);
        if (current.absolute !== parent.absolute) throw new Error("The destination changed. Select it again.");
        const target = join(current.absolute, name);
        try {
          if (info.isDirectory()) {
            await mkdir(target);
            ownedDirectory = target;
          } else {
            await copyFile(source, target, constants.COPYFILE_EXCL);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        if (ownedDirectory) {
          for (const child of await readdir(source)) await cp(join(source, child), join(target, child), {
            recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_EXCL,
            filter: async path => {
              signal?.throwIfAborted();
              const entry = await lstat(path);
              if (!entry.isFile() && !entry.isDirectory()) throw new Error("The folder contains a symbolic link or special file, which cannot be imported.");
              if (path !== source) validateName(basename(path));
              return true;
            },
          });
        }
        report.created.push(parent.path ? `${parent.path}/${name}` : name);
        ownedDirectory = undefined;
        break;
      }
    } catch (error) {
      let cleanupFailed = false;
      if (ownedDirectory) {
        try { await rm(ownedDirectory, { recursive: true, force: true }); }
        catch { cleanupFailed = true; }
      }
      const code = (error as NodeJS.ErrnoException).code;
      // Native errors contain absolute paths; return only an item label and actionable feedback.
      const message = code ? "Could not copy this item. Check source availability, permissions and available disk space."
        : error instanceof Error ? error.message : "Could not import this item.";
      report.failures.push({ source: basename(source), code: code === "ENOENT" ? "unavailable" : code ? "io-error" : "invalid-path",
        message: message + (cleanupFailed ? " The unfinished copy could not be removed; check the destination folder." : "") });
    }
  }
  return report;
}
