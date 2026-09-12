import { lstatSync, watch, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";
import { isExcludedWorkspacePath } from "./workspace-path";

/** Listener receives debounced Workspace-relative changed paths (`/` form). */
export type WorkspaceFilesListener = (paths: string[]) => void;

const DEBOUNCE_MS = 150;
const CONFIRM_MS = 150;
const WATCH_RETRY_MS = 1_000;

/**
 * Injectable timed task scheduling (tests use a fake clock; production uses
 * timers). Returns a cancel function.
 */
export type TimedTaskScheduler = (
  fn: () => void,
  ms: number,
) => () => void;

export type StableChangeNotifier = {
  /** Note filesystem activity on one Workspace-relative `/` path. */
  touch(path: string): void;
  /** Stop timers without emitting. */
  dispose(): void;
};

/**
 * Stability gate for filesystem notifications: bursts coalesce during a
 * debounce window, and a path is only reported once its state is stable.
 * A path that vanished at flush time waits one confirmation window, so a
 * delete → recreate pair (atomic saves, renames) is never reported as a
 * phantom deletion — it is reported once, with its final state.
 */
export function createStableChangeNotifier(options: {
  /** Current existence check for one relative path (must not throw). */
  exists(path: string): boolean;
  /** Confirmed batch of changed paths (final state: exists or deleted). */
  emit(paths: string[]): void;
  debounceMs?: number;
  confirmMs?: number;
  schedule?: TimedTaskScheduler;
}): StableChangeNotifier {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const confirmMs = options.confirmMs ?? CONFIRM_MS;
  const schedule =
    options.schedule ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const pending = new Set<string>();
  const deleting = new Set<string>();
  let debounceTask: (() => void) | null = null;
  let confirmTask: (() => void) | null = null;

  function cancelDebounce(): void {
    debounceTask?.();
    debounceTask = null;
  }

  function isPresent(path: string): boolean {
    try {
      return options.exists(path);
    } catch {
      return false;
    }
  }

  function armConfirmation(): void {
    if (confirmTask || deleting.size === 0) return;
    confirmTask = schedule(confirmDeletions, confirmMs);
  }

  function flush(): void {
    debounceTask = null;
    const paths = [...pending];
    pending.clear();
    const changed: string[] = [];
    for (const path of paths) {
      // Only stable state is reported: present paths emit now, absent paths
      // move to confirmation so a fast recreate never looks like a delete.
      if (isPresent(path)) changed.push(path);
      else deleting.add(path);
    }
    if (changed.length > 0) options.emit(changed);
    armConfirmation();
  }

  function confirmDeletions(): void {
    confirmTask = null;
    const candidates = [...deleting];
    deleting.clear();
    const changed: string[] = [];
    const deleted: string[] = [];
    for (const path of candidates) {
      if (isPresent(path)) changed.push(path);
      else deleted.push(path);
    }
    if (changed.length > 0) options.emit(changed);
    if (deleted.length > 0) options.emit(deleted);
    armConfirmation();
  }

  return {
    touch(path) {
      // Activity at a path cancels any pending deletion confirmation.
      deleting.delete(path);
      pending.add(path);
      cancelDebounce();
      debounceTask = schedule(flush, debounceMs);
    },
    dispose() {
      cancelDebounce();
      confirmTask?.();
      confirmTask = null;
      pending.clear();
      deleting.clear();
    },
  };
}

/**
 * Recursively watch a Workspace root and report stable, batched file changes.
 * Watch loss schedules a retry and requests a complete consumer rebuild both
 * when observation is lost and once it is restored. Returns an unwatch function.
 */
export function watchWorkspaceFiles(
  cwd: string,
  listener: WorkspaceFilesListener,
  onRecovery: () => void,
): () => void {
  const notifier = createStableChangeNotifier({
    exists: (path) => {
      lstatSync(join(cwd, path));
      return true;
    },
    emit: listener,
  });

  let watcher: FSWatcher | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let recovering = false;

  function scheduleRetry(): void {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      start();
    }, WATCH_RETRY_MS);
    retryTimer.unref();
  }

  function lose(candidate: FSWatcher): void {
    if (stopped || watcher !== candidate) return;
    watcher = null;
    recovering = true;
    try {
      candidate.close();
    } catch {
      // The watcher may already be closed by the platform error.
    }
    onRecovery();
    scheduleRetry();
  }

  function start(): void {
    if (stopped) return;
    try {
      const candidate = watch(cwd, { recursive: true }, (_eventType, filename) => {
        if (!filename) return;
        const relativePath = String(filename).split(sep).join("/");
        if (isExcludedWorkspacePath(relativePath)) return;
        notifier.touch(relativePath);
      });
      watcher = candidate;
      candidate.once("error", () => lose(candidate));
      if (recovering) {
        recovering = false;
        onRecovery();
      }
    } catch {
      if (!recovering) {
        recovering = true;
        onRecovery();
      }
      scheduleRetry();
    }
  }

  start();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    notifier.dispose();
    try {
      watcher?.close();
    } catch {
      // Shutdown is best-effort after a watcher failure.
    }
    watcher = null;
  };
}
