import type { Connect, Plugin } from "vite";
import { createWikilotApplication } from "./src/main/application";
import {
  createBrowserHostMiddleware,
  createMacOsDirectoryPicker,
  type DirectoryPicker,
  type ImportPicker,
} from "./src/main/host";
import {
  initHostTelemetry,
  shutdownHostTelemetry,
} from "./src/main/telemetry";

/**
 * Real-UI acceptance seam: when WIKILOT_PICK_DIRECTORY_RESULT is set, the
 * directory chooser is replaced by an adapter resolving that absolute path —
 * a native dialog cannot be driven from headless Chromium. Unset in real use,
 * where the macOS chooser runs on the Host machine's local display.
 */
function createDirectoryPicker(): DirectoryPicker {
  const fixedResult = process.env.WIKILOT_PICK_DIRECTORY_RESULT;
  if (fixedResult) {
    return async () => fixedResult;
  }
  return createMacOsDirectoryPicker();
}

function mountApis(middlewares: Connect.Server): () => Promise<void> {
  initHostTelemetry();
  const app = createWikilotApplication();
  middlewares.use(
    createBrowserHostMiddleware(app, {
      pickDirectory: createDirectoryPicker(),
      // Isolated acceptance substitutes only the native selection, never the import operation.
      pickImport: process.env.WIKILOT_PICK_IMPORT_RESULT
        ? async ({ kind }) => (JSON.parse(process.env.WIKILOT_PICK_IMPORT_RESULT!) as Record<"file" | "directory", Awaited<ReturnType<ImportPicker>>>)[kind]
        : undefined,
    }),
  );
  let shutdown: Promise<void> | undefined;
  return () => {
    shutdown ??= (async () => {
      await app.shutdown();
      await shutdownHostTelemetry();
    })();
    return shutdown;
  };
}

function mountHost(server: {
  middlewares: Connect.Server;
  httpServer?: { once(event: "close", listener: () => void): unknown } | null;
}): void {
  const shutdown = mountApis(server.middlewares);
  server.httpServer?.once("close", () => {
    void shutdown();
  });
}

/** Mounts the Browser Host (HTTP + SSE) on Vite dev and preview servers. */
export function workspaceApiPlugin(): Plugin {
  return {
    name: "wikilot-workspace-api",
    configureServer(server) {
      mountHost(server);
    },
    configurePreviewServer(server) {
      mountHost(server);
    },
  };
}
