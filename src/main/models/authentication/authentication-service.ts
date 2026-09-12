import { randomUUID } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AuthPrompt } from "@earendil-works/pi-ai";
import type { ProviderCredential } from "../../../shared/settings";
import type {
  AuthenticationRequest,
  AuthenticationSessionEvent,
} from "./authentication-types";

type Listener = (event: AuthenticationSessionEvent) => void;

type ActiveSession = {
  id: string;
  request: AuthenticationRequest;
  abort: AbortController;
  listeners: Set<Listener>;
  prompts: Map<string, { resolve: (value: string) => void; reject: (error: unknown) => void; abort: AbortController }>;
  values: Set<string>;
};

export type ProviderAuthentication = {
  start(request: AuthenticationRequest): Promise<{ sessionId: string }>;
  respond(sessionId: string, promptId: string, value: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  subscribe(sessionId: string, listener: Listener): () => void;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSupported(runtime: ModelRuntime, request: AuthenticationRequest): boolean {
  const provider = runtime.getProvider(request.providerId);
  return request.type === "oauth"
    ? provider?.auth.oauth !== undefined
    : provider?.auth.apiKey?.login !== undefined;
}

export function createProviderAuthentication(options: {
  getRuntime: () => Promise<ModelRuntime>;
  onCredentialChanged?: (credential: ProviderCredential) => void | Promise<void>;
}): ProviderAuthentication {
  let active: ActiveSession | undefined;

  function emit(session: ActiveSession, event: AuthenticationSessionEvent): void {
    for (const listener of session.listeners) listener(event);
  }

  function finish(session: ActiveSession): void {
    for (const prompt of session.prompts.values()) {
      prompt.abort.abort();
      prompt.reject(new Error("Authentication Session ended"));
    }
    session.prompts.clear();
    if (active?.id === session.id) active = undefined;
  }

  async function run(session: ActiveSession): Promise<void> {
    try {
      const runtime = await options.getRuntime();
      if (!isSupported(runtime, session.request)) {
        throw new Error(`${session.request.providerId} does not support ${session.request.type} login`);
      }
      await runtime.login(session.request.providerId, session.request.type, {
        signal: session.abort.signal,
        prompt: (request: AuthPrompt) => new Promise<string>((resolve, reject) => {
          if (session.abort.signal.aborted) {
            reject(new Error("Authentication Session cancelled"));
            return;
          }
          const promptId = randomUUID();
          const promptAbort = new AbortController();
          const onAbort = () => reject(new Error("Authentication Session cancelled"));
          request.signal?.addEventListener("abort", onAbort, { once: true });
          promptAbort.signal.addEventListener("abort", onAbort, { once: true });
          session.prompts.set(promptId, { resolve, reject, abort: promptAbort });
          const { signal: _signal, ...prompt } = request;
          void _signal;
          emit(session, { type: "prompt", promptId, prompt });
        }),
        notify: (event) => emit(session, { type: "event", event }),
      });
      const credential = { providerId: session.request.providerId, type: session.request.type } as ProviderCredential;
      await options.onCredentialChanged?.(credential);
      emit(session, { type: "completed", credential });
    } catch (error) {
      if (session.abort.signal.aborted) emit(session, { type: "cancelled" });
      else {
        let message = messageOf(error);
        for (const value of session.values) {
          if (value) message = message.replaceAll(value, "[redacted]");
        }
        emit(session, { type: "failed", message });
      }
    } finally {
      finish(session);
    }
  }

  return {
    async start(request) {
      if (active) throw new Error("Another Authentication Session is already active");
      const session: ActiveSession = {
        id: randomUUID(),
        request,
        abort: new AbortController(),
        listeners: new Set(),
        prompts: new Map(),
        values: new Set(),
      };
      active = session;
      queueMicrotask(() => void run(session));
      return { sessionId: session.id };
    },
    async respond(sessionId, promptId, value) {
      if (active?.id !== sessionId) throw new Error("Authentication Session not found");
      const prompt = active.prompts.get(promptId);
      if (!prompt) throw new Error("Authentication Prompt is no longer pending");
      active.prompts.delete(promptId);
      active.values.add(value);
      prompt.resolve(value);
    },
    async cancel(sessionId) {
      if (active?.id !== sessionId) return;
      active.abort.abort();
      for (const prompt of active.prompts.values()) prompt.abort.abort();
    },
    subscribe(sessionId, listener) {
      if (active?.id !== sessionId) throw new Error("Authentication Session not found");
      active.listeners.add(listener);
      return () => active?.listeners.delete(listener);
    },
  };
}
