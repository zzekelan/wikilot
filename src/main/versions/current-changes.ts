import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { join } from "node:path";
import { execFile } from "node:child_process";
import type { SimpleGit } from "simple-git";
import type { VersionChange, VersionFileDiff } from "../../shared/versions/index.ts";

const runGit = promisify(execFile);

export async function currentChanges(git: SimpleGit): Promise<VersionChange[]> {
  // Disable rename folding so every path has one NUL-delimited status record.
  const status = await git.raw(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
  const files = new Map<string, VersionChange>();
  for (const record of status.split("\0").filter(Boolean)) {
    const path = record.slice(3);
    // A staged deletion followed by recreation has both D and ?? records.
    const kind = files.has(path) ? "Modified" : record.slice(0, 2).includes("D") ? "Deleted"
      : /[A?]/.test(record.slice(0, 2)) ? "Added" : "Modified";
    files.set(path, { path, kind });
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export async function currentFileDiff(cwd: string, git: SimpleGit, path: string): Promise<VersionFileDiff> {
  if (!(await currentChanges(git)).some(file => file.path === path)) throw new Error("This file is no longer changed.");
  const hasHead = Boolean((await git.raw(["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => "")).trim());
  const inHead = hasHead && Boolean(await git.raw(["--literal-pathspecs", "ls-tree", "-z", "HEAD", "--", path]));
  if (!inHead) {
    const present = await lstat(join(cwd, path)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (!present) return { patch: "", unavailable: null };
    if (present.isDirectory()) return { patch: "", unavailable: "This directory cannot be previewed." };
  }
  const common = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
  // Git also renders symlink targets and binary markers without reading through links.
  const args = inHead
    ? ["--literal-pathspecs", "diff", ...common, "HEAD", "--", path]
    : ["diff", "--no-index", ...common, "--", "/dev/null", path];
  const temporary = inHead ? await mkdtemp(join(tmpdir(), "wikilot-diff-")) : null;
  try {
    // Compare HEAD directly with disk, independent of staged deletions or renames.
    // The temporary index never touches the Workspace's staging area.
    const env = temporary ? { ...process.env, GIT_INDEX_FILE: join(temporary, "index") } : process.env;
    if (temporary) await runGit("git", ["read-tree", "HEAD"], { cwd, env, timeout: 15_000 });
    return await new Promise<VersionFileDiff>((resolve, reject) => {
      execFile("git", args, { cwd, env, encoding: "utf8", maxBuffer: 256 * 1024, timeout: 15_000 }, (error, stdout) => {
        if (error && "code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          resolve({ patch: "", unavailable: "Diff is too large to preview." });
        } else if (error && !(error.code === 1 && !inHead && stdout.startsWith("diff --git "))) reject(error);
        else resolve({ patch: stdout, unavailable: null });
      });
    });
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
}
