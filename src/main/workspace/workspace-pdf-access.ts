import { constants, lstatSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import { resolveWorkspacePath } from "./workspace-path.ts";

const MAX_WORKSPACE_PDF_BYTES = 500 * 1024 * 1024;
const MAX_WORKSPACE_PDF_RANGE_BYTES = 4 * 1024 * 1024;

export type WorkspacePdfAccessErrorCode =
  | "not-found"
  | "not-file"
  | "not-pdf"
  | "unsafe-path"
  | "too-large"
  | "unavailable"
  | "source-changed";

export class WorkspacePdfAccessError extends Error {
  readonly code: WorkspacePdfAccessErrorCode;

  constructor(code: WorkspacePdfAccessErrorCode, message: string) {
    super(message);
    this.name = "WorkspacePdfAccessError";
    this.code = code;
  }
}

/** Inspected filesystem identity. Absolute paths never leave Node code. */
export type WorkspacePdfFile = {
  cwd: string;
  path: string;
  absolute: string;
  version: string;
  size: number;
};

export type WorkspacePdfFileRange = {
  start: number;
  end: number;
  bytes: Uint8Array;
};

type WorkspacePdfHandle = {
  stat(options: { bigint: true }): Promise<BigIntStats>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
};

type WorkspacePdfAccessAdapters = {
  openFile(path: string, flags: number): Promise<WorkspacePdfHandle>;
  beforeReadRange?(file: WorkspacePdfFile, signal: AbortSignal): Promise<void>;
  afterReadRange?(file: WorkspacePdfFile): Promise<void>;
};

const RANGE_READ_GATE_ADAPTER = Symbol.for(
  "wikilot.internal.workspacePdfRangeReadGateAdapter",
);

type WorkspacePdfRangeReadGateAdapter = {
  beforeReadRange(file: WorkspacePdfFile, signal: AbortSignal): Promise<void>;
  afterReadRange?(file: WorkspacePdfFile): Promise<void>;
};

function injectedRangeReadGate(): WorkspacePdfRangeReadGateAdapter | undefined {
  const candidate = (globalThis as Record<symbol, unknown>)[RANGE_READ_GATE_ADAPTER];
  if (
    typeof candidate !== "object"
    || candidate === null
    || typeof (candidate as WorkspacePdfRangeReadGateAdapter).beforeReadRange !== "function"
  ) {
    return undefined;
  }
  return candidate as WorkspacePdfRangeReadGateAdapter;
}

const DEFAULT_ADAPTERS: WorkspacePdfAccessAdapters = {
  openFile: (path, flags) => open(path, flags),
};

function accessError(
  error: unknown,
  fallback: WorkspacePdfAccessErrorCode = "unavailable",
): WorkspacePdfAccessError {
  if (error instanceof WorkspacePdfAccessError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT" || code === "ENOTDIR" || /path not found/i.test(message)) {
    return new WorkspacePdfAccessError("not-found", message);
  }
  if (
    code === "ELOOP"
    || /relative to the Workspace|escapes Workspace|excluded|symlink|control characters/i.test(message)
  ) {
    return new WorkspacePdfAccessError("unsafe-path", message);
  }
  return new WorkspacePdfAccessError(fallback, message);
}

function fileVersion(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

function resolvePdf(cwd: string, input: string): {
  path: string;
  absolute: string;
  stat: BigIntStats;
} {
  try {
    const resolved = resolveWorkspacePath(cwd, input);
    if (!resolved.path) {
      throw new WorkspacePdfAccessError("unsafe-path", "PDF path is required");
    }
    return {
      path: resolved.path,
      absolute: resolved.absolute,
      stat: lstatSync(resolved.absolute, { bigint: true }),
    };
  } catch (error) {
    throw accessError(error);
  }
}

export type WorkspacePdfAccess = {
  inspect(cwd: string, path: string): WorkspacePdfFile;
  validate(file: WorkspacePdfFile): WorkspacePdfFile;
  readRange(
    file: WorkspacePdfFile,
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<WorkspacePdfFileRange>;
};

export function createWorkspacePdfAccess(): WorkspacePdfAccess {
  const gate = injectedRangeReadGate();
  return createWorkspacePdfAccessWithAdapters({
    ...DEFAULT_ADAPTERS,
    ...(gate ? {
      beforeReadRange: gate.beforeReadRange.bind(gate),
      ...(gate.afterReadRange ? { afterReadRange: gate.afterReadRange.bind(gate) } : {}),
    } : {}),
  });
}

/** Internal construction seam for close/error tests in this module. */
export function createWorkspacePdfAccessWithAdapters(
  adapters: WorkspacePdfAccessAdapters,
): WorkspacePdfAccess {
  function inspect(cwd: string, input: string): WorkspacePdfFile {
    const resolved = resolvePdf(cwd, input);
    if (!resolved.stat.isFile()) {
      throw new WorkspacePdfAccessError("not-file", "PDF source is not an ordinary file");
    }
    if (extname(resolved.path).toLowerCase() !== ".pdf") {
      throw new WorkspacePdfAccessError("not-pdf", "Source is not a PDF file");
    }
    const size = Number(resolved.stat.size);
    if (!Number.isSafeInteger(size)) {
      throw new WorkspacePdfAccessError("unavailable", "PDF size is unavailable");
    }
    if (size > MAX_WORKSPACE_PDF_BYTES) {
      throw new WorkspacePdfAccessError(
        "too-large",
        `PDF is too large (${size} bytes; max ${MAX_WORKSPACE_PDF_BYTES})`,
      );
    }
    return {
      cwd,
      path: resolved.path,
      absolute: resolved.absolute,
      version: fileVersion(resolved.stat),
      size,
    };
  }

  function validate(file: WorkspacePdfFile): WorkspacePdfFile {
    const current = inspect(file.cwd, file.path);
    if (current.version !== file.version || current.size !== file.size) {
      throw new WorkspacePdfAccessError("source-changed", "PDF source changed");
    }
    return current;
  }

  async function readRange(
    file: WorkspacePdfFile,
    start: number,
    end: number,
    signal: AbortSignal,
  ): Promise<WorkspacePdfFileRange> {
    signal.throwIfAborted();
    const current = validate(file);
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end < start
      || end >= current.size
      || end - start + 1 > MAX_WORKSPACE_PDF_RANGE_BYTES
    ) {
      throw new WorkspacePdfAccessError("unavailable", "PDF byte range is invalid");
    }

    let handle: WorkspacePdfHandle;
    try {
      handle = await adapters.openFile(
        current.absolute,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      signal.throwIfAborted();
      throw accessError(error);
    }

    let operationFailed = false;
    try {
      signal.throwIfAborted();
      const opened = await handle.stat({ bigint: true });
      if (fileVersion(opened) !== file.version || Number(opened.size) !== file.size) {
        throw new WorkspacePdfAccessError("source-changed", "PDF source changed");
      }
      await adapters.beforeReadRange?.(file, signal);
      signal.throwIfAborted();
      const bytes = Buffer.allocUnsafe(end - start + 1);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const length = Math.min(64 * 1024, bytes.length - offset);
        const { bytesRead } = await handle.read(bytes, offset, length, start + offset);
        if (bytesRead === 0) {
          throw new WorkspacePdfAccessError(
            "source-changed",
            "PDF source changed while reading",
          );
        }
        offset += bytesRead;
      }
      signal.throwIfAborted();
      await adapters.afterReadRange?.(file);
      return { start, end, bytes: new Uint8Array(bytes) };
    } catch (error) {
      operationFailed = true;
      signal.throwIfAborted();
      throw accessError(error);
    } finally {
      try {
        await handle.close();
      } catch (error) {
        if (!operationFailed) throw accessError(error);
      }
    }
  }

  return { inspect, validate, readRange };
}
