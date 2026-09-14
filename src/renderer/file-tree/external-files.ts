import type { WorkspaceFileReport } from "../../shared/workspace";
export const unsupportedDrop = "Cannot import this content because no readable files were provided. Right-click a folder or empty space and choose Import files… or Import folder….";

/** Capture entries synchronously while the browser's drop data store is readable. */
export function captureExternalFiles(transfer: DataTransfer): (signal: AbortSignal) => Promise<{ entries: Array<{ path: string; file?: File }>; failures: WorkspaceFileReport["failures"] }> {
  const items = Array.from(transfer.items ?? []).filter(item => item.kind === "file")
    .map(item => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  const files = Array.from(transfer.files ?? []);
  return async signal => {
    const failures: WorkspaceFileReport["failures"] = [];
    const result: Array<{ path: string; file?: File }> = [];
    async function visit(entry: FileSystemEntry, parent: string) {
      signal.throwIfAborted();
      if (!entry.name || entry.name === "." || entry.name === ".." || /[/\\\0]/.test(entry.name)) throw new Error("The dropped folder contains an invalid entry name.");
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        result.push({ path, file });
      } else if (entry.isDirectory) {
        result.push({ path });
        const reader = (entry as FileSystemDirectoryEntry).createReader();
        for (;;) {
          const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) await visit(child, path);
        }
      } else throw new Error(unsupportedDrop);
    }
    if (items.length) {
      for (const item of items) {
        signal.throwIfAborted();
        const start = result.length;
        try {
          if (item.entry) await visit(item.entry, "");
          else if (item.file) result.push({ path: item.file.name, file: item.file });
          else throw new Error(unsupportedDrop);
        } catch (error) {
          signal.throwIfAborted();
          result.splice(start);
          failures.push({ source: item.entry?.name ?? item.file?.name, code: "unavailable",
            message: error instanceof Error ? error.message : "Could not read this dropped item." });
        }
      }
    } else for (const file of files) result.push({ path: file.name, file });
    if (!result.length && !failures.length) throw new Error(unsupportedDrop);
    return { entries: result, failures };
  };
}
