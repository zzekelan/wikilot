import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Add missing structure without replacing existing entries or following symlinks. */
export function initializeWorkspace(cwd: string): void {
  for (const directory of ["raw", "wiki", "wiki/source", "wiki/concept", "wiki/entity", "wiki/synthesis"]) {
    const path = join(cwd, directory);
    try {
      mkdirSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(path).isDirectory()) {
        throw new Error(`Cannot initialize Workspace: ${directory} already exists and is not a directory`);
      }
    }
  }
  for (const file of ["AGENTS.md", "wiki/INDEX.md", "wiki/LOG.md"]) {
    const path = join(cwd, file);
    try {
      writeFileSync(path, "", { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(path).isFile()) {
        throw new Error(`Cannot initialize Workspace: ${file} already exists and is not a regular file`);
      }
    }
  }
}
