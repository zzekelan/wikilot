import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { pdfjsAssetsPlugin } from "./vite-plugin-pdfjs-assets";
import { workspaceApiPlugin } from "./vite-plugin-workspace-api";

// OTLP HTTP collector (docker compose maps host 14318 → container 4318)
const otlpTarget =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:14318";

const otlpProxy = {
  "/otlp": {
    target: otlpTarget,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/otlp/, ""),
  },
};

export default defineConfig({
  plugins: [react(), workspaceApiPlugin(), pdfjsAssetsPlugin()],
  // The Graph Worker is first requested on open, after the initial dependency
  // scan. Pre-bundle its dependency to avoid a cold-open full-page reload.
  optimizeDeps: {
    include: ["d3-force"],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: otlpProxy,
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: otlpProxy,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
