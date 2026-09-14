import { watchFile, unwatchFile, type Stats } from "node:fs";
import { resolve } from "node:path";
import type { SimpleGit } from "simple-git";

/** Observe only Git state files, including the separate metadata of linked worktrees. */
export async function watchVersionMetadata(cwd: string, git: SimpleGit, onChange: () => void) {
  const listeners = new Map<string, (current: Stats, previous: Stats) => void>();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function reconcile() {
    let paths = [resolve(cwd, ".git")];
    if (await git.checkIsRepo()) {
      const ref = (await git.raw(["symbolic-ref", "--quiet", "HEAD"]).catch(() => "")).trim();
      const names = ["HEAD", "index", "packed-refs", "config", "info/exclude", ...(ref ? [ref] : [])];
      paths = await Promise.all(names.map(async name => resolve(cwd,
        (await git.revparse(["--git-path", name])).trim())));
    }
    if (stopped) return;
    const desired = new Set(paths);
    for (const [path, listener] of listeners) {
      if (!desired.has(path)) { unwatchFile(path, listener); listeners.delete(path); }
    }
    for (const path of desired) {
      if (listeners.has(path)) continue;
      const listener = (current: Stats, previous: Stats) => {
        if (current.mtimeMs === previous.mtimeMs && current.ino === previous.ino &&
            current.size === previous.size && current.nlink === previous.nlink) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          // HEAD may now refer to another branch. Keep that branch's ref observed.
          void reconcile().catch(() => {}).finally(() => { if (!stopped) onChange(); });
        }, 150);
      };
      listeners.set(path, listener);
      // watchFile survives atomic replacements and missing files; only a handful
      // of metadata files are checked, never the repository contents or history.
      watchFile(path, { persistent: false, interval: 1000 }, listener);
    }
  }
  await reconcile();
  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const [path, listener] of listeners) unwatchFile(path, listener);
    listeners.clear();
  };
}
