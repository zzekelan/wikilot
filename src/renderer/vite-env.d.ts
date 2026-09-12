/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OTEL_ENABLED?: string;
  readonly VITE_OTEL_OTLP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
