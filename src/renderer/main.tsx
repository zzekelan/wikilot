import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import {
  DEFAULT_OTLP_PATH,
  DEFAULT_SERVICE_NAME,
  initTelemetry,
  resolveTelemetryEnabled,
} from "./telemetry";
import "./styles/tokens.css";
import "./styles/global.css";
import "./styles/controls.css";

const otelOn = resolveTelemetryEnabled(
  { VITE_OTEL_ENABLED: import.meta.env.VITE_OTEL_ENABLED },
  import.meta.env.MODE,
);

initTelemetry({
  enabled: otelOn,
  serviceName: DEFAULT_SERVICE_NAME,
  otlpUrl: import.meta.env.VITE_OTEL_OTLP_URL ?? DEFAULT_OTLP_PATH,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
