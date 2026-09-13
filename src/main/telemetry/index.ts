import { context, trace, type Span, type Tracer } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import type { TimelineSnapshot } from "../../shared/timeline";
import type { WorkspaceSummary } from "../../shared/workspace";
import { resolveCaptureContent } from "./capture-content.ts";
import {
  buildCredentialSaveSpanAttributes,
  buildDefaultsSaveSpanAttributes,
  buildToolCompletionSpanAttributes,
  buildToolSpanAttributes,
  buildTurnSpanAttributes,
  privacySafeWorkspaceId,
  type ReadPdfPageToolCompletionSpanInput,
} from "./span-attributes.ts";
import { formatTraceparent, parseTraceparent } from "./trace-context.ts";

export const DEFAULT_SERVICE_NAME = "wikilot";
export const DEFAULT_OTLP_URL = "http://127.0.0.1:14318/v1/traces";

export type InitHostTelemetryOptions = {
  enabled?: boolean;
  serviceName?: string;
  otlpUrl?: string;
  spanProcessor?: SpanProcessor;
};

let provider: BasicTracerProvider | undefined;
let tracer: Tracer | undefined;
let enabled = false;
let flushTail: Promise<void> = Promise.resolve();

function requestFlush(): void {
  const target = provider;
  if (!target) return;
  flushTail = flushTail
    .catch(() => {})
    .then(() => target.forceFlush())
    .catch(() => {});
}
const promptSpans = new Map<string, Span>();
let lastPromptSessionId: string | undefined;
let activeTurnSpan: Span | undefined;
type ReadPdfPageToolCompletion = ReadPdfPageToolCompletionSpanInput & {
  toolCallId: string;
};

const activeToolSpans = new Map<string, {
  span: Span;
  toolName: string;
  completion?: ReadPdfPageToolCompletionSpanInput;
}>();

function endAbandonedToolSpans(): void {
  for (const { span } of activeToolSpans.values()) span.end();
  activeToolSpans.clear();
}

/**
 * Host-side telemetry (browser-host Vite middleware / future Electron main).
 * Dev default on; disable with WIKILOT_OTEL_ENABLED=false.
 */
export function resolveHostTelemetryEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.WIKILOT_OTEL_ENABLED?.trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "off") return false;
  if (raw === "true" || raw === "1" || raw === "on") return true;
  return env.NODE_ENV !== "production";
}

export function initHostTelemetry(
  options: InitHostTelemetryOptions = {},
): { enabled: boolean } {
  if (provider) {
    return { enabled };
  }

  enabled = options.enabled ?? resolveHostTelemetryEnabled();
  if (!enabled) {
    return { enabled: false };
  }

  try {
    const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;
    const processor =
      options.spanProcessor ??
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: options.otlpUrl ?? process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? DEFAULT_OTLP_URL,
        }),
      );

    provider = new BasicTracerProvider({
      resource: new Resource({ [ATTR_SERVICE_NAME]: serviceName }),
      spanProcessors: [processor],
    });
    // Prefer the local provider's tracer so tests can shutdown/re-init with a
    // fresh exporter. Global register still helps non-test consumers.
    try {
      provider.register();
    } catch {
      // Global TracerProvider may already be set from a prior init.
    }
    tracer = provider.getTracer("wikilot-host");
    return { enabled: true };
  } catch (err) {
    enabled = false;
    provider = undefined;
    tracer = undefined;
    console.error("host telemetry init failed; continuing without export", err);
    return { enabled: false };
  }
}

function setAcceptanceRunId(span: Span): void {
  const acceptanceRunId = process.env.WIKILOT_ACCEPTANCE_RUN_ID?.trim();
  if (acceptanceRunId) {
    span.setAttribute("wikilot.acceptance.run_id", acceptanceRunId);
  }
}

function endSpan(
  name: string,
  attributes: Record<string, string>,
): void {
  if (!enabled || !tracer) return;
  const span = tracer.startSpan(name);
  setAcceptanceRunId(span);
  for (const [key, value] of Object.entries(attributes)) {
    span.setAttribute(key, value);
  }
  span.end();
  requestFlush();
}

/** Record Workspace open lifecycle for Jaeger acceptance (no paths or Session internals). */
export function recordWorkspaceOpen(workspace: WorkspaceSummary): void {
  endSpan("workspace.open", {
    "wikilot.gesture": "workspace.open",
    "wikilot.workspace.id": privacySafeWorkspaceId(workspace.id),
  });
}

/** Record a Graph projection query without paths, labels, or document content. */
export function recordWorkspaceGraphSnapshot(input: {
  workspaceId: string;
  status: "building" | "error" | "retrying" | "ready";
  revision?: number;
  nodeCount?: number;
  edgeCount?: number;
  durationMs: number;
}): void {
  endSpan("workspace.graph.snapshot", {
    "wikilot.workspace.id": privacySafeWorkspaceId(input.workspaceId),
    "wikilot.graph.status": input.status,
    "wikilot.graph.revision": String(input.revision ?? 0),
    "wikilot.graph.node_count": String(input.nodeCount ?? 0),
    "wikilot.graph.edge_count": String(input.edgeCount ?? 0),
    "wikilot.duration_ms": String(Math.round(input.durationMs)),
  });
}

/** Record one confirmed watcher batch without capturing file paths or content. */
export function recordWorkspaceFilesChanged(input: {
  workspaceId: string;
  pathCount: number;
}): void {
  endSpan("workspace.files_changed", {
    "wikilot.workspace.id": privacySafeWorkspaceId(input.workspaceId),
    "wikilot.workspace.path_count": String(input.pathCount),
  });
}

/** Record a trust prompt/decision without capturing project resource bodies. */
export function recordProjectTrust(input: {
  phase: "request" | "decision";
  workspaceId: string;
  sessionId: string;
  trusted?: boolean;
}): void {
  const attributes: Record<string, string> = {
    "wikilot.gesture": `project.trust.${input.phase}`,
    "wikilot.workspace.id": privacySafeWorkspaceId(input.workspaceId),
    "wikilot.session.id": input.sessionId,
  };
  if (input.trusted !== undefined) {
    attributes["wikilot.project.trusted"] = String(input.trusted);
  }
  endSpan(`project.trust.${input.phase}`, attributes);
}

/** Internal Session switch details for span attributes (never a shared DTO). */
export type SessionSwitchSpanInput = {
  action: "create" | "open";
  sessionId: string;
};

/** Record Session create / open for Jaeger acceptance. */
export function recordSessionSwitch(input: SessionSwitchSpanInput): void {
  const operation =
    input.action === "create" ? "session.create" : "session.open";
  const attributes: Record<string, string> = {
    "wikilot.gesture": operation,
    "wikilot.session.id": input.sessionId,
    "wikilot.session.action": input.action,
  };
  endSpan(operation, attributes);
}

/** Record a Session Runtime disposal with its lifecycle owner. */
export function recordSessionRuntimeDisposal(input: {
  workspaceId: string;
  sessionId: string;
  workerInstanceId: string;
  reason:
    | "background_idle"
    | "selection_release"
    | "worker_failure"
    | "host_shutdown";
}): void {
  endSpan("session.runtime.dispose", {
    "wikilot.gesture": "session.runtime.dispose",
    "wikilot.workspace.id": privacySafeWorkspaceId(input.workspaceId),
    "wikilot.session.id": input.sessionId,
    "wikilot.worker.instance_id": input.workerInstanceId,
    "wikilot.runtime.dispose_reason": input.reason,
  });
}

/** Record an authoritative Timeline recovery Snapshot request. */
export function recordTimelineRecovery(snapshot: TimelineSnapshot): void {
  endSpan("timeline.recover", {
    "wikilot.gesture": "timeline.recover",
    "wikilot.workspace.id": privacySafeWorkspaceId(snapshot.workspaceId),
    "wikilot.session.id": snapshot.sessionId,
    "wikilot.timeline.sequence": String(snapshot.sequence),
  });
}

/** Record a Credential save (provider id only — never the secret). */
export function recordCredentialSave(input: { providerId: string }): void {
  endSpan("credential.save", buildCredentialSaveSpanAttributes(input));
}

/** Record an App Defaults update for Jaeger acceptance. */
export function recordAppDefaultsSave(input: {
  sessionModel?: {
    provider: string;
    model: string;
    thinkingLevel: string;
  };
  wikiPromptEnabled: boolean;
}): void {
  endSpan("defaults.save", buildDefaultsSaveSpanAttributes(input));
}

/**
 * Begin a Composer prompt span that stays open for the turn duration.
 * Returns the span's W3C traceparent so the Session Worker can attach its
 * turn/tool spans to this trace across the process boundary.
 */
export function beginSessionPrompt(input: {
  sessionId: string;
  workspaceId?: string;
  cwd: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  wikiPromptEnabled: boolean;
  clipCount?: number;
  clipCharacters?: number;
}): string | undefined {
  if (!enabled || !tracer) return undefined;
  const span = tracer.startSpan("session.prompt");
  setAcceptanceRunId(span);
  for (const [key, value] of Object.entries(
    buildTurnSpanAttributes({
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      cwd: input.cwd,
      provider: input.provider,
      model: input.model,
      thinkingLevel: input.thinkingLevel,
      wikiPromptEnabled: input.wikiPromptEnabled,
      clipCount: input.clipCount,
      clipCharacters: input.clipCharacters,
    }),
  )) {
    span.setAttribute(key, value);
  }
  promptSpans.get(input.sessionId)?.end();
  promptSpans.set(input.sessionId, span);
  lastPromptSessionId = input.sessionId;
  return formatTraceparent(span.spanContext());
}

/**
 * Enrich the open prompt span with Worker-reported prompt content.
 * When WIKILOT_CAPTURE_CONTENT=full: includes the assembled system prompt,
 * plus the Wiki fragment body when the Worker confirms it was injected.
 */
export function setSessionPromptContent(input: {
  sessionId?: string;
  systemPrompt: string;
  wikiPromptFragment?: string;
}): void {
  const sessionId = input.sessionId ?? lastPromptSessionId;
  const span = sessionId ? promptSpans.get(sessionId) : undefined;
  if (!enabled || !span) return;
  if (resolveCaptureContent() !== "full") return;
  span.setAttribute("wikilot.llm.system_prompt", input.systemPrompt);
  if (input.wikiPromptFragment !== undefined) {
    span.setAttribute("wikilot.wiki.prompt", input.wikiPromptFragment);
  }
}

/** End the open prompt span (call on agent_settled / prompt failure). */
export function endSessionPrompt(sessionId?: string): void {
  const id = sessionId ?? lastPromptSessionId;
  const span = id ? promptSpans.get(id) : undefined;
  if (!span) return;
  span.end();
  promptSpans.delete(id!);
  if (lastPromptSessionId === id) lastPromptSessionId = undefined;
  requestFlush();
}

/**
 * Worker-side: begin a session.turn span as a child of the Main-side prompt
 * span (traceparent crosses the process boundary). No-op without a valid
 * traceparent — Worker spans never float outside the Prompt trace.
 */
export function beginWorkerTurn(input: {
  traceparent?: string;
  sessionId: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  accessMode?: "auto-review" | "full-access";
}): void {
  if (!enabled || !tracer) return;
  endAbandonedToolSpans();
  activeTurnSpan?.end();
  activeTurnSpan = undefined;
  const remote = input.traceparent
    ? parseTraceparent(input.traceparent)
    : undefined;
  if (!remote) return;
  const parentCtx = trace.setSpanContext(context.active(), remote);
  const span = tracer.startSpan("session.turn", undefined, parentCtx);
  setAcceptanceRunId(span);
  span.setAttribute("wikilot.session.id", input.sessionId);
  span.setAttribute("wikilot.llm.provider", input.provider);
  span.setAttribute("wikilot.llm.model", input.model);
  span.setAttribute("wikilot.llm.thinking", input.thinkingLevel);
  span.setAttribute("wikilot.access.mode", input.accessMode ?? "auto-review");
  activeTurnSpan = span;
}

/** Worker-side: end the open turn span (call on agent_settled / failure). */
export function endWorkerTurn(): void {
  endAbandonedToolSpans();
  if (!activeTurnSpan) return;
  activeTurnSpan.end();
  activeTurnSpan = undefined;
  requestFlush();
}

/** Begin one Tool lifecycle span under the active Worker Turn. */
/** Review evidence stays out of telemetry; only lifecycle and decision are recorded. */
export function beginAutomaticReview(toolName: string, toolCallId: string) {
  const parent = activeTurnSpan ? trace.setSpan(context.active(), activeTurnSpan) : context.active();
  const span = enabled ? tracer?.startSpan("session.automatic_review", undefined, parent) : undefined;
  if (span) {
    setAcceptanceRunId(span);
    span.setAttribute("wikilot.tool.name", toolName);
    span.setAttribute("wikilot.tool.call_id", toolCallId);
  }
  return (outcome: "allow" | "deny" | "error" | "cancelled") => {
    span?.setAttribute("wikilot.review.outcome", outcome);
    span?.end();
    requestFlush();
  };
}

export function beginToolExecution(input: {
  sessionId: string;
  toolName: string;
  toolCallId: string;
  timeoutSeconds?: number;
}): void {
  if (!enabled || !tracer || !activeTurnSpan) return;
  activeToolSpans.get(input.toolCallId)?.span.end();
  const parentCtx = trace.setSpan(context.active(), activeTurnSpan);
  const span = tracer.startSpan("session.tool", undefined, parentCtx);
  setAcceptanceRunId(span);
  for (const [key, value] of Object.entries(buildToolSpanAttributes(input))) {
    span.setAttribute(key, value);
  }
  activeToolSpans.set(input.toolCallId, { span, toolName: input.toolName });
}

/**
 * Stage typed read_pdf_page facts. The span remains open until Pi emits Tool
 * end, so adapter cleanup is part of the measured lifecycle.
 */
export function setReadPdfPageToolCompletion(
  input: ReadPdfPageToolCompletion,
): void {
  const active = activeToolSpans.get(input.toolCallId);
  if (!active || active.toolName !== "read_pdf_page") return;
  const { toolCallId: _toolCallId, ...completion } = input;
  active.completion = completion;
}

/** Finish the matching Tool span after Tool execution and cleanup have settled. */
export function endToolExecution(input: {
  toolCallId: string;
  outcome: "success" | "error";
}): void {
  const active = activeToolSpans.get(input.toolCallId);
  if (!active) return;
  const typedCompletion = active.completion ?? input;
  const completion = buildToolCompletionSpanAttributes(
    active.toolName === "read_pdf_page"
      ? typedCompletion
      : { outcome: typedCompletion.outcome },
  );
  for (const [key, value] of Object.entries(completion)) {
    active.span.setAttribute(key, value);
  }
  active.span.end();
  activeToolSpans.delete(input.toolCallId);
  requestFlush();
}

export async function shutdownHostTelemetry(): Promise<void> {
  for (const span of promptSpans.values()) span.end();
  promptSpans.clear();
  lastPromptSessionId = undefined;
  endAbandonedToolSpans();
  activeTurnSpan?.end();
  activeTurnSpan = undefined;
  const current = provider;
  requestFlush();
  await flushTail;
  provider = undefined;
  tracer = undefined;
  enabled = false;
  if (current) {
    await current.shutdown();
  }
}
