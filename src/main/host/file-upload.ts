import type { IncomingMessage } from "node:http";
import { mkdtemp, mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A bounded JSON manifest followed by exact-length binary file bodies.
// The temporary root is owned exclusively by this request.
export async function receiveFileUpload<T>(req: IncomingMessage, signal: AbortSignal,
  consume: (workspaceId: string, destination: string, sources: string[]) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "wikilot-upload-"));
  const iterator = req[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  async function take(max: number): Promise<Buffer> {
    signal.throwIfAborted();
    if (!buffer.length) {
      const next = await iterator.next();
      if (next.done) throw new Error("Upload interrupted before all file contents arrived.");
      buffer = Buffer.from(next.value);
    }
    const result = buffer.subarray(0, max);
    buffer = buffer.subarray(result.length);
    return result;
  }
  async function exact(size: number) {
    const chunks: Buffer[] = [];
    while (size) { const chunk = await take(size); chunks.push(chunk); size -= chunk.length; }
    return Buffer.concat(chunks);
  }
  try {
    const size = (await exact(4)).readUInt32BE();
    if (size > 1024 * 1024 || size === 0) throw new Error("Invalid upload manifest size.");
    const manifest = JSON.parse((await exact(size)).toString("utf8"));
    if (!manifest || Object.keys(manifest).some(key => !["workspaceId", "destination", "entries"].includes(key)) ||
      typeof manifest.workspaceId !== "string" || typeof manifest.destination !== "string" || !Array.isArray(manifest.entries) || !manifest.entries.length) {
      throw new Error("Invalid upload manifest.");
    }
    const seen = new Set<string>();
    const roots = new Map<number, string>();
    for (const entry of manifest.entries) {
      if (!entry || Object.keys(entry).some(key => !["source", "path", "kind", "size"].includes(key)) || typeof entry.path !== "string" ||
        entry.path.split("/").some((part: string) => !part || part === "." || part === ".." || /[\\\0]/.test(part)) ||
        !Number.isSafeInteger(entry.source) || entry.source < 0 ||
        seen.has(`${entry.source}/${entry.path}`) || !["file", "directory"].includes(entry.kind) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        (entry.kind === "directory" && entry.size !== 0)) throw new Error("Invalid or duplicate directory entry in upload.");
      const top = entry.path.split("/")[0];
      if (!roots.has(entry.source)) {
        if (entry.path !== top || entry.source !== roots.size) throw new Error("Invalid top-level upload entry.");
        roots.set(entry.source, join(root, String(entry.source), top));
      } else if (roots.get(entry.source) !== join(root, String(entry.source), top)) throw new Error("Invalid upload source.");
      seen.add(`${entry.source}/${entry.path}`);
      const target = join(root, String(entry.source), entry.path);
      await mkdir(dirname(target), { recursive: true });
      if (entry.kind === "directory") await mkdir(target, { recursive: true });
      else {
        const file = await open(target, "wx");
        try {
          let remaining = entry.size;
          while (remaining) {
            const chunk = await take(remaining);
            let offset = 0;
            while (offset < chunk.length) offset += (await file.write(chunk, offset)).bytesWritten;
            remaining -= chunk.length;
          }
        } finally { await file.close(); }
      }
    }
    if (buffer.length || !(await iterator.next()).done) throw new Error("Unexpected data after upload.");
    signal.throwIfAborted();
    return await consume(manifest.workspaceId, manifest.destination, [...roots.values()]);
  } finally { await rm(root, { recursive: true, force: true }); }
}
