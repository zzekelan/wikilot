import { spawn } from "node:child_process";

/**
 * Native directory chooser capability. The Host shows the platform dialog and
 * resolves with the selected absolute path; user cancellation (and caller
 * cancellation) resolve to `null`. Only the path crosses back — the Browser
 * never sees a filesystem handle.
 */
export type DirectoryPicker = (options: {
  signal: AbortSignal;
}) => Promise<string | null>;

/** Minimal child-process surface the chooser adapter relies on. */
export type DirectoryPickerChild = {
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown };
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null) => void): unknown;
  kill(signal?: number | NodeJS.Signals): boolean;
};

export type DirectoryPickerSpawn = (
  command: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "pipe"] },
) => DirectoryPickerChild;

// `choose folder` is the macOS system directory chooser; AppleScript's POSIX
// path of a folder carries a trailing "/".
const CHOOSE_FOLDER_SCRIPT =
  'POSIX path of (choose folder with prompt "Choose a Workspace folder")';

// After caller cancellation, SIGTERM may be ignored; guarantee the dialog dies.
const KILL_ESCALATION_MS = 5_000;

function normalizePickedPath(stdout: string): string {
  const picked = stdout.trim();
  return picked.length > 1 && picked.endsWith("/") ? picked.slice(0, -1) : picked;
}

/**
 * Owned adapter around the macOS directory chooser: invokes `osascript`
 * directly (never through a shell), runs without any timeout so the dialog is
 * user-paced, and kills the child when the caller cancels.
 */
type PickerOptions = { platform?: NodeJS.Platform; spawnProcess?: DirectoryPickerSpawn };

export type ImportPicker = (options: { kind: "file" | "directory"; signal: AbortSignal }) => Promise<string[] | null>;

export function createMacOsDirectoryPicker(options?: PickerOptions): DirectoryPicker {
  const pick = createMacOsChooser(CHOOSE_FOLDER_SCRIPT, "directory chooser", options);
  return async request => {
    const result = await pick(request);
    return result === null ? null : normalizePickedPath(result);
  };
}

export function createMacOsImportPicker(options?: PickerOptions): ImportPicker {
  return async ({ kind, signal }) => {
    const selection = kind === "file"
      ? 'choose file with prompt "Choose files to import" with multiple selections allowed'
      : 'choose folder with prompt "Choose a folder to import"';
    // NUL separates paths unambiguously, including names containing commas or newlines.
    const script = `set picked to (${selection}) as list
set paths to {}
repeat with itemPath in picked
  set end of paths to POSIX path of itemPath
end repeat
set AppleScript's text item delimiters to character id 0
return paths as text`;
    const result = await createMacOsChooser(script, "import chooser", options)({ signal });
    if (result === null) return null;
    const paths = result.replace(/\r?\n$/, "").split("\0");
    if (paths.some(path => !path.startsWith("/"))) throw new Error("The system chooser returned an invalid selection. Try again.");
    return paths.map(path => path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
  };
}

function createMacOsChooser(script: string, label: string, options?: PickerOptions): DirectoryPicker {
  const platform = options?.platform ?? process.platform;
  const spawnProcess: DirectoryPickerSpawn =
    options?.spawnProcess ??
    ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
  return ({ signal }) =>
    new Promise<string | null>((resolve, reject) => {
      if (signal.aborted) {
        resolve(null);
        return;
      }
      if (platform !== "darwin") {
        reject(
          new Error(
            `The native ${label} is only available on macOS.`,
          ),
        );
        return;
      }
      const child = spawnProcess("osascript", ["-e", script], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        child.kill("SIGTERM");
        escalation = setTimeout(() => child.kill("SIGKILL"), KILL_ESCALATION_MS);
        escalation.unref?.();
        // The caller is gone; settle immediately rather than wait on a
        // possibly-stubborn dialog process.
        resolve(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        signal.removeEventListener("abort", onAbort);
        clearTimeout(escalation);
        reject(
          new Error(
            `Could not launch the macOS ${label}: ${error.message}`,
          ),
        );
      });
      child.on("close", (code) => {
        signal.removeEventListener("abort", onAbort);
        clearTimeout(escalation);
        if (signal.aborted) {
          resolve(null);
          return;
        }
        if (code === 0) {
          resolve(stdout);
          return;
        }
        // AppleScript cancellation uses -128 regardless of the system language.
        if (/\(-128\)\s*$/.test(stderr)) {
          resolve(null);
          return;
        }
        reject(
          new Error(
            `The macOS ${label} failed: ${
              stderr.trim() || `osascript exited with code ${code}`
            }. Try opening the chooser again.`,
          ),
        );
      });
    });
}
