import { ArrowLeft, ChevronRight, MoreHorizontal, Plus, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  PROVIDER_AUTH_MODES,
  PROVIDER_MODEL_INPUTS,
  PROVIDER_PROTOCOLS,
  THINKING_LEVELS,
  type AuthenticationSessionEvent,
  type ProviderCredential,
  type ProviderInput,
  type ProviderModel,
  type ProviderSummary,
  type ThinkingLevel,
} from "../../shared/settings";
import { client } from "../client";
import { recordUiGesture } from "../telemetry";
import { Modal } from "./overlay";
import { pushEscapeLayer } from "../escape-stack";
import { thinkingLevelLabel } from "./thinking-labels";

type ProviderSettingsSectionProps = {
  providers: ProviderSummary[];
  credentials: ProviderCredential[];
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
  onToast: (message: string) => void;
};

type DraftModel = ProviderModel & { key: string };
type ProviderDraft = Omit<ProviderInput, "models"> & { models: DraftModel[] };

function draftModelKey(): string {
  return globalThis.crypto.randomUUID();
}

function generatedProviderId(name: string): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "provider";
  const suffix = globalThis.crypto.randomUUID().slice(0, 8);
  return `${base.slice(0, 48)}-${suffix}`;
}

function blankModel(): DraftModel {
  return {
    key: draftModelKey(),
    id: "",
    reasoning: false,
    input: ["text"],
  };
}

function blankProvider(): ProviderDraft {
  const name = "Local Provider";
  return {
    providerId: generatedProviderId(name),
    name,
    baseUrl: "http://127.0.0.1:43121/v1",
    protocol: "openai-completions",
    authMode: "api_key",
    models: [blankModel()],
  };
}

function parsePositiveInteger(raw: string): number | undefined {
  const digits = raw.replace(/\D+/gu, "");
  if (!digits) return undefined;
  const value = Number(digits);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function modelThinkingLevels(
  model: Pick<ProviderModel, "reasoning" | "thinkingLevelMap">,
): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function providerDraft(provider: ProviderSummary): ProviderDraft {
  return {
    providerId: provider.providerId,
    name: provider.name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol ?? "openai-completions",
    authMode: provider.authMode ?? "api_key",
    models: provider.models.map((model) => ({
      key: draftModelKey(),
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {}),
      ...(model.contextWindow !== undefined
        ? { contextWindow: model.contextWindow }
        : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
      reasoning: model.reasoning,
      ...(model.thinkingLevelMap !== undefined
        ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
        : {}),
      input: [...model.input],
    })),
  };
}

function toProviderInput(draft: ProviderDraft): ProviderInput {
  const missingModel = draft.models.findIndex((model) => !model.id.trim());
  if (missingModel !== -1) throw new Error(`Enter an ID for Model ${missingModel + 1}.`);
  return {
    ...draft,
    models: draft.models.map((model) => {
      const { key, ...persisted } = model;
      void key;
      return persisted;
    }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ProviderSettingsSection({
  providers,
  credentials,
  busy,
  setBusy,
  onChanged,
  onError,
  onToast,
}: ProviderSettingsSectionProps) {
  const authAttempt = useRef(0);
  const authStop = useRef<(() => void) | undefined>(undefined);
  const authId = useRef<string | undefined>(undefined);
  const [authStatus, setAuthStatus] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [authPrompt, setAuthPrompt] = useState<Extract<AuthenticationSessionEvent, { type: "authentication_prompt" }> | null>(null);
  const [authAnswer, setAuthAnswer] = useState("");
  const [manualInputOpen, setManualInputOpen] = useState(false);
  useEffect(() => () => {
    authAttempt.current += 1;
    authStop.current?.();
    if (authId.current) void client.cancelAuthentication({ sessionId: authId.current }).catch(() => {});
    if (authStop.current || authId.current) setBusy(false);
  }, [setBusy]);
  const [draft, setDraft] = useState<ProviderDraft>(() => blankProvider());
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdProviderId, setCreatedProviderId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [catalog, setCatalog] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [credentialRevision, setCredentialRevision] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pendingModelFocus = useRef<string | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!moreOpen) return;
    const close = () => { setMoreOpen(false); moreRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); };
    const pop = pushEscapeLayer(close);
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) setMoreOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => { pop(); document.removeEventListener("pointerdown", outside); };
  }, [moreOpen]);
  useEffect(() => { headingRef.current?.focus(); }, [selectedId, catalog, creating, editing]);
  const [query, setQuery] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);

  const selected = useMemo(
    () => providers.find((provider) => provider.providerId === selectedId) ?? null,
    [providers, selectedId],
  );
  const visibleProviders = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const configured = new Set(credentials.map((credential) => credential.providerId));
    return providers.filter((provider) => {
      const added = provider.source === "user" || configured.has(provider.providerId);
      return (catalog ? !added : added) &&
        (provider.name.toLowerCase().includes(needle) || provider.providerId.toLowerCase().includes(needle));
    }).sort((a, b) => a.name.localeCompare(b.name));
  }, [providers, credentials, query, catalog]);
  const selectedCredential = useMemo(
    () =>
      credentials.find((credential) => credential.providerId === selectedId),
    [credentials, selectedId],
  );
  function clearSelection() {
    setSelectedId(null);
    setMoreOpen(false);
    setEditing(false);
    setCreating(false);
    setCreatedProviderId(null);
    setDraft(blankProvider());
    setApiKey("");
    setDeleteConfirmationOpen(false);
    setQuery("");
    onError(null);
  }

  function startNew() {
    clearSelection();
    setCreating(true);
  }

  function selectProvider(provider: ProviderSummary) {
    setSelectedId(provider.providerId);
    setMoreOpen(false);
    setCreating(false);
    setCreatedProviderId(null);
    setApiKey("");
    onError(null);
    setEditing(false);
    setDraft(providerDraft(provider));
  }

  function updateModel(index: number, patch: Partial<ProviderModel>) {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model, modelIndex) =>
        modelIndex === index ? { ...model, ...patch } : model,
      ),
    }));
  }

  function toggleModelThinkingLevel(
    index: number,
    level: ThinkingLevel,
  ) {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model, modelIndex) => {
        if (modelIndex !== index) return model;
        const currentLevels = modelThinkingLevels(model);
        const selected = currentLevels.includes(level);
        if (selected && currentLevels.length === 1) return model;
        const nextLevels = THINKING_LEVELS.filter((entry) =>
          entry === level ? !selected : currentLevels.includes(entry),
        );
        const reasoning = nextLevels.some((entry) => entry !== "off");
        if (!reasoning) {
          return { ...model, reasoning: false, thinkingLevelMap: undefined };
        }
        return {
          ...model,
          reasoning: true,
          thinkingLevelMap: Object.fromEntries(
            THINKING_LEVELS.map((entry) => {
              if (!nextLevels.includes(entry)) return [entry, null];
              const mapped = model.thinkingLevelMap?.[entry];
              return [entry, mapped === undefined || mapped === null ? entry : mapped];
            }),
          ),
        };
      }),
    }));
  }

  function toggleModelInput(index: number, input: ProviderModel["input"][number]) {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model, modelIndex) => {
        if (modelIndex !== index) return model;
        const next = model.input.includes(input)
          ? model.input.filter((entry) => entry !== input)
          : [...model.input, input];
        return { ...model, input: next };
      }),
    }));
  }

  async function saveProvider() {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      const input = toProviderInput(draft);
      const saved = editing || createdProviderId
        ? await client.updateProvider(createdProviderId ?? draft.providerId, input)
        : await client.createProvider(input);
      // Configuration and Credentials have separate stores. Remember creation
      // so a failed key save or refresh can be retried without a second Provider.
      if (creating) setCreatedProviderId(saved.providerId);
      if (input.authMode === "api_key" && apiKey.trim()) {
        try {
          await client.setCredential({ providerId: saved.providerId, apiKey });
        } catch (error) {
          await onChanged();
          throw new Error(`Provider configuration saved, but the API key could not be saved. Try again. ${errorMessage(error)}`);
        }
        setApiKey("");
        recordUiGesture("credential.save", {
          "wikilot.gesture": "credential.save",
          "wikilot.llm.provider": saved.providerId,
        });
      }
      await onChanged();
      setSelectedId(saved.providerId);
      setCatalog(false);
      setQuery("");
      setEditing(false);
      setCreating(false);
      setCreatedProviderId(null);
      setDraft(providerDraft(saved));
      onToast(editing ? "Provider updated." : "Provider created.");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function requestDeleteProvider() {
    if (!selected || selected.source !== "user" || busy) return;
    setDeleteConfirmationOpen(true);
  }

  async function confirmDeleteProvider() {
    if (!selected || selected.source !== "user" || busy) return;
    setDeleteConfirmationOpen(false);
    setBusy(true);
    onError(null);
    try {
      await client.deleteProvider(selected.providerId);
      await onChanged();
      clearSelection();
      setCatalog(false);
      onToast("Provider deleted.");
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveCredential() {
    if (!selected?.supportsApiKey || !apiKey.trim() || busy) return;
    setBusy(true);
    onError(null);
    try {
      await client.setCredential({
        providerId: selected.providerId,
        apiKey,
      });
      setApiKey("");
      await onChanged();
      setCredentialRevision((revision) => revision + 1);
      setCatalog(false);
      setQuery("");
      onToast(`API key saved for ${selected.providerId}.`);
      recordUiGesture("credential.save", {
        "wikilot.gesture": "credential.save",
        "wikilot.llm.provider": selected.providerId,
      });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeCredential() {
    if (!selected || !selectedCredential || busy) return;
    setBusy(true);
    onError(null);
    try {
      await client.deleteCredential(selected.providerId);
      await onChanged();
      onToast(`Credential removed for ${selected.providerId}.`);
      recordUiGesture("credential.remove", { "wikilot.llm.provider": selected.providerId });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function startOAuth() {
    if (!selected?.supportsOAuth || busy) return;
    setBusy(true);
    onError(null);
    const attempt = ++authAttempt.current;
    setAuthStatus("Connecting…");
    setAuthUrl(null);
    setAuthPrompt(null);
    let sessionId: string | undefined;
    const pending: AuthenticationSessionEvent[] = [];
    const receive = (event: AuthenticationSessionEvent) => {
      if (attempt !== authAttempt.current) return;
      if (!sessionId) { pending.push(event); return; }
      if (event.sessionId !== sessionId) return;
      if (event.type === "authentication_event") {
        const detail = event.event;
        if (detail.type === "auth_url") {
          setAuthUrl(detail.url);
          setAuthStatus("Open the sign-in page to continue.");
        } else if (detail.type === "device_code") {
          setAuthUrl(detail.verificationUri);
          setAuthStatus(`Enter code: ${detail.userCode}`);
        } else setAuthStatus(detail.message);
      } else if (event.type === "authentication_prompt") {
        setAuthPrompt(event);
        setManualInputOpen(false);
        setAuthAnswer(event.prompt.type === "select" ? event.prompt.options[0]?.id ?? "" : "");
      } else {
        authStop.current?.();
        authStop.current = undefined;
        authId.current = undefined;
        setAuthStatus(null);
        setAuthPrompt(null);
        setAuthUrl(null);
        setBusy(false);
        recordUiGesture("credential.authenticate", {
          "wikilot.gesture": "credential.authenticate",
          "wikilot.llm.provider": selected.providerId,
          "wikilot.authentication.outcome": event.type,
        });
        if (event.type === "authentication_failed") onError(event.message);
        if (event.type === "authentication_completed") {
          void onChanged().then(() => {
            setCredentialRevision((revision) => revision + 1);
            setCatalog(false);
            setQuery("");
          }).catch((error: unknown) => onError(errorMessage(error)));
          onToast(`Signed in to ${selected.providerId}.`);
        }
      }
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Could not connect to sign-in. Please try again.")), 10000);
        const stop = client.subscribeAuthentication(receive, () => { clearTimeout(timeout); resolve(); });
        authStop.current = () => { clearTimeout(timeout); stop(); resolve(); };
      });
      if (attempt !== authAttempt.current) return;
      const started = await client.startAuthentication({ providerId: selected.providerId, type: "oauth" });
      if (attempt !== authAttempt.current) {
        await client.cancelAuthentication({ sessionId: started.sessionId });
        return;
      }
      sessionId = started.sessionId;
      authId.current = sessionId;
      setAuthStatus("Waiting for sign-in…");
      for (const event of pending) receive(event);
    } catch (error) {
      if (attempt !== authAttempt.current) return;
      authStop.current?.();
      authStop.current = undefined;
      setAuthStatus(null);
      onError(errorMessage(error));
      setBusy(false);
    }
  }

  const browserWithManualInput = Boolean(authUrl && authPrompt?.prompt.type === "manual_code");
  const authenticationField = authPrompt && (
    <div className="settings-form-field" key={authPrompt.promptId}>
      <label className="workspace-label" htmlFor="authentication-answer">{browserWithManualInput ? "Authorization code or redirect URL" : authPrompt.prompt.message}</label>
      {authPrompt.prompt.type === "select" ? (
        <select autoFocus id="authentication-answer" className="workspace-input settings-select" value={authAnswer}
          onChange={(event) => setAuthAnswer(event.target.value)}>
          {authPrompt.prompt.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      ) : (
        <input autoFocus id="authentication-answer" className="workspace-input" type={authPrompt.prompt.type === "secret" ? "password" : "text"}
          value={authAnswer} placeholder={authPrompt.prompt.placeholder} onChange={(event) => setAuthAnswer(event.target.value)} />
      )}
    </div>
  );

  return (
    <section aria-label="Provider settings" className="settings-providers-section">
      <div className="settings-page-header">
        <div className="settings-page-title-row">
        {(selected || creating || catalog) && (
          <button type="button" className="settings-back" data-testid="provider-back" disabled={busy}
            aria-label={`Back to ${editing ? selected?.name : catalog && (selected || creating) ? "Add Provider" : "Providers"}`}
            title={`Back to ${editing ? selected?.name : catalog && (selected || creating) ? "Add Provider" : "Providers"}`}
            onClick={() => {
              if (editing) { setEditing(false); setApiKey(""); onError(null); return; }
              if (selected || creating) clearSelection();
              else { setCatalog(false); setQuery(""); }
            }}>
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
        )}
        <div className="settings-section-heading">
          <div>
            <div className="settings-provider-title">
            <h3 ref={headingRef} tabIndex={-1} className="settings-section-title">
              {creating ? "Custom Provider" : editing ? "Edit Provider" : selected?.name ?? (catalog ? "Add Provider" : "Providers")}
            </h3>
            {selected && !editing && <span className="settings-provider-kind">{selected.source === "user" ? "Custom" : "Built-in"}</span>}
            </div>
            {(!selected || editing) && <p className="settings-hint">
              {creating || editing ? "Configure the service and the models it offers."
                : catalog ? "Choose a service or add your own endpoint." : "Manage the services you use with Wikilot."}
            </p>}
          </div>
          {!selected && !creating && !catalog && (
            <button type="button" className="btn-primary settings-icon-label" data-testid="provider-add"
              onClick={() => { setCatalog(true); setQuery(""); }}>
              <Plus size={14} aria-hidden="true" />Add Provider
            </button>
          )}
          {selected?.source === "user" && !editing && (
            <div className="settings-page-actions">
              <button type="button" className="btn-secondary" data-testid="provider-edit" disabled={busy}
                onClick={() => { setDraft(providerDraft(selected)); setApiKey(""); setEditing(true); setMoreOpen(false); }}>Edit configuration</button>
            <div className="settings-more" ref={moreRef}>
              <button type="button" className="icon-btn" aria-label="Provider actions" aria-expanded={moreOpen}
                onClick={() => setMoreOpen(!moreOpen)} disabled={busy}><MoreHorizontal size={18} /></button>
              {moreOpen && <div className="settings-more-actions">
                <button type="button" className="settings-danger-button" data-testid="provider-delete"
                  onClick={() => { setMoreOpen(false); requestDeleteProvider(); }}>Delete Provider</button>
              </div>}
            </div>
            </div>
          )}
        </div>
        </div>
      </div>

      {!selected && !creating ? (
        <div className="settings-provider-directory">
          {(catalog || visibleProviders.length > 0 || query) && <div className="settings-provider-filter">
            <Search size={14} aria-hidden="true" />
            <input type="search" className="settings-provider-filter-input" data-testid="provider-filter"
              placeholder={catalog ? "Search services…" : "Filter Providers…"} aria-label="Filter Providers"
              value={query} onChange={(event) => setQuery(event.target.value)} spellCheck={false} />
          </div>}
          {catalog && <button type="button" className="settings-provider-row settings-custom-row" data-testid="provider-new" onClick={startNew}>
            <Plus size={18} aria-hidden="true" />
            <span className="settings-provider-main"><strong>Custom Provider</strong><span className="settings-provider-row-meta">Use your own endpoint and models</span></span>
            <ChevronRight size={16} aria-hidden="true" />
          </button>}
          <div className="settings-provider-list" data-testid="provider-list">
            {visibleProviders.map((provider) => (
              <button type="button" key={provider.providerId} className="settings-provider-row"
                data-testid={`provider-row-${provider.providerId}`} onClick={() => selectProvider(provider)}>
                <span className="settings-provider-main">
                  <strong>{provider.name}</strong>
                  {!catalog && <span className="settings-provider-row-meta">
                    {provider.authMode === "none" ? "No authentication required" : credentials.some((credential) => credential.providerId === provider.providerId) ? "Credential saved" : "Needs credential"}
                    {provider.source === "user" && " · Custom"}
                  </span>}
                </span>
                <ChevronRight size={16} aria-hidden="true" />
              </button>
            ))}
            {visibleProviders.length === 0 && <div className="settings-provider-empty" data-testid="provider-empty">
              <h4>{query ? "No matching Providers" : catalog ? "All services have been added" : "Add your first Provider"}</h4>
              <p>{query ? "Try a different name or Provider ID." : catalog ? "You can still add a custom endpoint above." : "Connect a service to choose its models in your Sessions."}</p>
            </div>}
          </div>
        </div>
      ) : (
        <div className="settings-provider-detail-col" key={`${selectedId}:${creating}:${editing}`}>
          {selected && !editing && !creating ? (
        <div className="settings-provider-detail" data-testid="provider-detail" key={selected.providerId}>

          <section className="settings-detail-section" aria-label="Configuration">
            {selected.source === "user" && <h4 className="settings-subsection-title">Configuration</h4>}
            <dl className="settings-provider-facts">
              {selected.source === "user" && <><div><dt>Endpoint</dt><dd>{selected.baseUrl}</dd></div><div><dt>API protocol</dt><dd>{selected.protocol}</dd></div></>}
              <div><dt>Provider ID</dt><dd>{selected.providerId}</dd></div>
            </dl>
            {authStatus !== null ? (
              <section className="settings-auth-session" aria-label="Authentication">
                <h5 className="settings-config-label">Authentication</h5>
                <form className="settings-auth-session-form" onSubmit={(event) => {
                  event.preventDefault();
                  if (!authPrompt) return;
                  setAuthPrompt(null);
                  setAuthAnswer("");
                  void client.respondAuthentication({ sessionId: authPrompt.sessionId, promptId: authPrompt.promptId, value: authAnswer })
                    .catch((error: unknown) => onError(errorMessage(error)));
                }}>
                  {browserWithManualInput ? (
                    <p className="settings-hint">Complete sign-in in your browser. This page will update automatically.</p>
                  ) : authPrompt ? authenticationField : <p className="settings-hint" role="status">{authStatus}</p>}
                  <div className="settings-auth-actions">
                    {authPrompt && !browserWithManualInput && <button type="submit" className="btn-primary">Continue</button>}
                    {authUrl && <a className={browserWithManualInput || !authPrompt ? "btn-primary" : "btn-secondary"} href={authUrl} target="_blank" rel="noopener noreferrer">Open sign-in page</a>}
                    <button type="button" className="btn-secondary" onClick={() => {
                      if (authId.current) void client.cancelAuthentication({ sessionId: authId.current }).catch((error: unknown) => onError(errorMessage(error)));
                      else {
                        authAttempt.current += 1;
                        authStop.current?.();
                        setAuthStatus(null);
                        setBusy(false);
                      }
                    }}>Cancel sign-in</button>
                  </div>
                  {browserWithManualInput && (
                    <div className="settings-auth-manual">
                      <button type="button" className="settings-auth-manual-toggle" aria-expanded={manualInputOpen}
                        onClick={() => setManualInputOpen(!manualInputOpen)}>
                        <ChevronRight size={14} aria-hidden="true" />Use an authorization code or redirect URL
                      </button>
                      {manualInputOpen && <div className="settings-auth-manual-fields">
                        {authenticationField}
                        <div className="settings-auth-actions">
                          <button type="submit" className="btn-secondary" disabled={!authAnswer.trim()}>Continue</button>
                        </div>
                      </div>}
                    </div>
                  )}
                </form>
              </section>
            ) : (
              <ProviderCredentialControls
                key={`${selected.providerId}:${selectedCredential?.type ?? "none"}:${credentialRevision}`}
                provider={selected}
                credential={selectedCredential}
                apiKey={apiKey}
                setApiKey={setApiKey}
                busy={busy}
                onSave={() => void saveCredential()}
                onRemove={() => void removeCredential()}
                onAuthenticate={() => void startOAuth()}
              />
            )}
          </section>
          <details className="settings-provider-model-disclosure">
            <summary><ChevronRight size={14} aria-hidden="true" />Supported models <span>{selected.models.length}</span></summary>
            <div className="settings-provider-models" aria-label="Provider Models">
              {selected.models.map((model) => <code key={model.id} className="settings-provider-model-chip">{model.id}</code>)}
            </div>
          </details>
        </div>
      ) : creating || (editing && selected) ? (
        <div className="settings-provider-detail settings-provider-editor">
          <form
            className="settings-form settings-provider-form"
            data-testid="provider-form"
            onSubmit={(event) => {
              event.preventDefault();
              void saveProvider();
            }}
          >

            <div className="settings-editor-fields">
            <div className="settings-form-grid">
              <div className="settings-form-field">
                <label className="workspace-label" htmlFor="provider-name">
                  Display name
                </label>
                <input
                  id="provider-name"
                  className="workspace-input"
                  data-testid="provider-name"
                  value={draft.name}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, name: event.target.value }))
                  }
                  disabled={busy}
                />
              </div>

              <div className="settings-form-field">
                <label className="workspace-label" htmlFor="provider-id">
                  Provider ID
                </label>
                <input
                  id="provider-id"
                  className="workspace-input workspace-input-mono"
                  data-testid="provider-id"
                  value={draft.providerId}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, providerId: event.target.value }))
                  }
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy || editing || createdProviderId !== null}
                />
              </div>

              <div className="settings-form-field settings-form-field-span">
                <label className="workspace-label" htmlFor="provider-base-url">
                  Base URL
                </label>
                <input
                  id="provider-base-url"
                  className="workspace-input workspace-input-mono"
                  data-testid="provider-base-url"
                  value={draft.baseUrl}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, baseUrl: event.target.value }))
                  }
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy}
                />
              </div>

              <div className="settings-form-field">
                <label className="workspace-label" htmlFor="provider-protocol">
                  API protocol
                </label>
                <select
                  id="provider-protocol"
                  className="workspace-input settings-select"
                  data-testid="provider-protocol"
                  value={draft.protocol}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      protocol: event.target.value as ProviderInput["protocol"],
                    }))
                  }
                  disabled={busy}
                >
                  {PROVIDER_PROTOCOLS.map((protocol) => (
                    <option key={protocol} value={protocol}>
                      {protocol}
                    </option>
                  ))}
                </select>
              </div>

              <div className="settings-form-field">
                <label className="workspace-label" htmlFor="provider-auth-mode">
                  Authentication
                </label>
                <select
                  id="provider-auth-mode"
                  className="workspace-input settings-select"
                  data-testid="provider-auth-mode"
                  value={draft.authMode}
                  onChange={(event) => {
                    setApiKey("");
                    setDraft((current) => ({
                      ...current,
                      authMode: event.target.value as ProviderInput["authMode"],
                    }));
                  }}
                  disabled={busy}
                >
                  {PROVIDER_AUTH_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode === "api_key" ? "API key" : "No authentication"}
                    </option>
                  ))}
                </select>
              </div>
              {draft.authMode === "api_key" && (
                <div className="settings-form-field settings-form-field-span">
                  <label className="workspace-label" htmlFor="provider-draft-api-key">
                    API key
                  </label>
                  <input
                    id="provider-draft-api-key"
                    className="workspace-input workspace-input-mono"
                    data-testid="provider-draft-api-key"
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={selectedCredential ? "Enter a replacement key" : "Enter API key"}
                    aria-describedby="provider-draft-api-key-hint"
                    autoComplete="new-password"
                    spellCheck={false}
                    disabled={busy}
                  />
                  <p className="settings-hint" id="provider-draft-api-key-hint">
                    {selectedCredential
                      ? "Leave blank to keep the saved credential."
                      : "Optional. You can add it later."}
                  </p>
                </div>
              )}
            </div>

            <div className="settings-provider-model-heading">
              <h4>Models</h4>
              <button
                type="button"
                className="btn-secondary settings-icon-label"
                data-testid="provider-model-add"
                onClick={() => {
                  const model = blankModel();
                  pendingModelFocus.current = model.key;
                  setDraft((current) => ({ ...current, models: [...current.models, model] }));
                }}
                disabled={busy}
              >
                <Plus size={14} aria-hidden="true" />
                <span>Add Model</span>
              </button>
            </div>
            <div className="settings-model-editor-list">
              {draft.models.map((model, index) => (
                <ModelEditor key={model.key} model={model} index={index} actions={
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove Model ${index + 1}`}
                      title="Remove Model"
                      data-testid={`provider-model-remove-${index}`}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          models: current.models.filter((_, modelIndex) => modelIndex !== index),
                        }))
                      }
                      disabled={busy || draft.models.length <= 1}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  }>
                  <div className="settings-form-grid">
                    <div className="settings-form-field">
                      <label className="workspace-label" htmlFor={`provider-model-id-${index}`}>
                        Model ID
                      </label>
                      <input
                        id={`provider-model-id-${index}`}
                        ref={(element) => {
                          if (element && pendingModelFocus.current === model.key) {
                            element.focus();
                            pendingModelFocus.current = null;
                          }
                        }}
                        className="workspace-input workspace-input-mono"
                        data-testid={`provider-model-id-${index}`}
                        required
                        value={model.id}
                        onChange={(event) => updateModel(index, { id: event.target.value })}
                        disabled={busy}
                      />
                    </div>
                    <div className="settings-form-field">
                      <label className="workspace-label" htmlFor={`provider-model-name-${index}`}>
                        Display name
                      </label>
                      <input
                        id={`provider-model-name-${index}`}
                        className="workspace-input"
                        data-testid={`provider-model-name-${index}`}
                        value={model.name ?? ""}
                        onChange={(event) => updateModel(index, { name: event.target.value })}
                        disabled={busy}
                      />
                    </div>
                  </div>
                  <details
                    className="settings-model-advanced"
                    data-testid={`provider-model-advanced-${index}`}
                  >
                    <summary data-testid={`provider-model-advanced-toggle-${index}`}>
                      <ChevronRight size={14} aria-hidden="true" />Advanced
                    </summary>
                    <div className="settings-model-advanced-body">
                      <div className="settings-form-grid">
                        <div className="settings-form-field">
                          <label className="workspace-label" htmlFor={`provider-model-context-${index}`}>
                            Context window <span className="settings-field-unit">tokens</span>
                          </label>
                          <input
                            id={`provider-model-context-${index}`}
                            className="workspace-input workspace-input-mono"
                            data-testid={`provider-model-context-${index}`}
                            type="text"
                            inputMode="numeric"
                            placeholder="128000 (default)"
                            value={model.contextWindow ?? ""}
                            onChange={(event) =>
                              updateModel(index, {
                                contextWindow: parsePositiveInteger(event.target.value),
                              })
                            }
                            disabled={busy}
                          />
                        </div>
                        <div className="settings-form-field">
                          <label className="workspace-label" htmlFor={`provider-model-max-${index}`}>
                            Maximum output <span className="settings-field-unit">tokens</span>
                          </label>
                          <input
                            id={`provider-model-max-${index}`}
                            className="workspace-input workspace-input-mono"
                            data-testid={`provider-model-max-${index}`}
                            type="text"
                            inputMode="numeric"
                            placeholder="16384 (default)"
                            value={model.maxTokens ?? ""}
                            onChange={(event) =>
                              updateModel(index, {
                                maxTokens: parsePositiveInteger(event.target.value),
                              })
                            }
                            disabled={busy}
                          />
                        </div>
                      </div>
                      <fieldset className="settings-option-group">
                        <legend className="workspace-label">Thinking levels</legend>
                        <div className="settings-model-options">
                          {THINKING_LEVELS.map((level) => (
                            <label className="settings-toggle" key={level}>
                              <input
                                type="checkbox"
                                className="checkbox"
                                data-testid={`provider-model-thinking-${level}-${index}`}
                                checked={modelThinkingLevels(model).includes(level)}
                                onChange={() =>
                                  toggleModelThinkingLevel(index, level)
                                }
                                disabled={busy}
                              />
                              <span>{thinkingLevelLabel(level)}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      <fieldset className="settings-option-group">
                        <legend className="workspace-label">Input types</legend>
                        <div className="settings-model-options">
                        {PROVIDER_MODEL_INPUTS.map((input) => (
                          <label className="settings-toggle" key={input}>
                            <input
                              type="checkbox"
                              className="checkbox"
                              checked={model.input.includes(input)}
                              onChange={() => toggleModelInput(index, input)}
                              disabled={busy}
                            />
                            <span>{input === "text" ? "Text" : "Image"}</span>
                          </label>
                        ))}
                        </div>
                      </fieldset>
                    </div>
                  </details>
                </ModelEditor>
              ))}
            </div>

            </div>
            <div className="settings-editor-footer">
              <button
                type="submit"
                className="btn-primary settings-icon-label"
                data-testid="provider-save"
                disabled={busy}
              >
                <span>{busy ? "Saving…" : editing || createdProviderId ? "Save Changes" : "Create Provider"}</span>
              </button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => {
                setEditing(false);
                setCreating(false);
                setCreatedProviderId(null);
                setApiKey("");
                onError(null);
              }}>Cancel</button>
            </div>
          </form>

        </div>
      ) : null}
        </div>
      )}

      {deleteConfirmationOpen && selected ? (
        <Modal
          label={`Delete User Provider ${selected.providerId}`}
          onClose={() => { setDeleteConfirmationOpen(false); headingRef.current?.focus(); }}
        >
          <h2 className="modal-title">Delete User Provider?</h2>
          <p className="modal-copy">
            Delete <strong>{selected.name}</strong>? Session history will remain unchanged.
          </p>
          <div className="modal-actions">
            <button
              type="button"
              className="btn-secondary"
              data-testid="provider-delete-cancel"
              onClick={() => { setDeleteConfirmationOpen(false); headingRef.current?.focus(); }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              data-testid="provider-delete-confirm"
              onClick={() => void confirmDeleteProvider()}
            >
              Delete Provider
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}

function ModelEditor({ model, index, actions, children }: { model: DraftModel; index: number; actions: ReactNode; children: ReactNode }) {
  const [expanded, setExpanded] = useState(!model.id);
  return <div className="settings-model-editor">
    <div className="settings-model-summary-row">
    <button type="button" className="settings-model-summary" aria-expanded={expanded}
      data-testid={`provider-model-toggle-${index}`} onClick={() => setExpanded(!expanded)}>
      <span><strong>{model.name || model.id || `Model ${index + 1}`}</strong>
        {model.id && model.name && model.name !== model.id && <span className="settings-provider-row-meta">{model.id}</span>}
      </span>
      <ChevronRight size={16} aria-hidden="true" />
    </button>
    {actions}
    </div>
    {expanded && <div className="settings-model-fields">{children}</div>}
  </div>;
}

type CredentialControlsProps = {
  provider: ProviderSummary;
  credential?: ProviderCredential;
  apiKey: string;
  setApiKey: (value: string) => void;
  busy: boolean;
  onSave: () => void;
  onRemove: () => void;
  onAuthenticate: () => void;
};

function ProviderCredentialControls(props: CredentialControlsProps) {
  const { provider, credential, busy } = props;
  const [method, setMethod] = useState<"oauth" | "api_key">(
    credential?.type ?? (provider.supportsOAuth ? "oauth" : "api_key"),
  );
  const [changing, setChanging] = useState(!credential);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreChangeFocus = useRef(false);
  useEffect(() => {
    if (!changing && restoreChangeFocus.current) {
      changeButtonRef.current?.focus();
      restoreChangeFocus.current = false;
    }
  }, [changing]);
  const browserOnly = provider.supportsOAuth && !provider.supportsApiKey;
  const editingCredential = Boolean(credential && changing && !browserOnly);
  const discardChanges = editingCredential ? <button type="button" className="icon-btn" disabled={busy}
    aria-label="Discard credential changes" title="Discard credential changes"
    onClick={() => { restoreChangeFocus.current = true; setChanging(false); props.setApiKey(""); }}><X size={16} aria-hidden="true" /></button> : null;
  const signIn = <button type="button" className="btn-secondary" onClick={props.onAuthenticate} disabled={busy}>
    {credential?.type === "oauth" ? "Sign in again" : "Sign in"}
  </button>;
  return (
    <section className="settings-connection" aria-label="Authentication">
      <h5 className="settings-config-label">Authentication</h5>
      <div className="settings-connection-body">
        {!editingCredential && <div className="settings-connection-row">
          <p className="settings-connection-status">
              {provider.authMode === "none" ? "No authentication required"
                : credential ? `Credential saved · ${credential.type === "oauth" ? "Account" : "API key / token"}` : "No credential saved"}
          </p>
          {provider.authMode !== "none" && <div className="settings-connection-actions">
            {browserOnly ? signIn : credential && (provider.supportsApiKey || provider.supportsOAuth) && (
              <button ref={changeButtonRef} type="button" className="btn-secondary" disabled={busy}
                onClick={() => { setChanging(!changing); props.setApiKey(""); }}>
                Change credential
              </button>
            )}
            {credential && <button type="button" className="icon-btn settings-credential-remove" aria-label="Remove credential" title="Remove credential"
              data-testid={`provider-credential-remove-${provider.providerId}`} onClick={props.onRemove} disabled={busy}><Trash2 size={16} aria-hidden="true" /></button>}
          </div>}
        </div>}
        {provider.authMode !== "none" && !browserOnly && changing && <>
          {provider.supportsApiKey && provider.supportsOAuth && (
            <fieldset className="settings-auth-methods" aria-label="Authentication method" disabled={busy}>
              <label><input type="radio" name={`auth-method-${provider.providerId}`} checked={method === "oauth"} onChange={() => { setMethod("oauth"); props.setApiKey(""); }} />Account</label>
              <label><input type="radio" name={`auth-method-${provider.providerId}`} checked={method === "api_key"} onChange={() => setMethod("api_key")} />API key / token</label>
            </fieldset>
          )}
          {credential && credential.type !== method && <p className="settings-hint">Connecting will replace the credential saved for this Provider.</p>}
          {method === "oauth" && provider.supportsOAuth ? (
            <div className="settings-provider-actions">{signIn}{discardChanges}</div>
          ) : provider.supportsApiKey ? <CredentialForm {...props} discardChanges={discardChanges} /> : (
            <p className="settings-hint">Configure authentication in your environment to use this service.</p>
          )}
        </>}
      </div>
    </section>
  );
}

function CredentialForm({
  provider,
  credential,
  apiKey,
  setApiKey,
  busy,
  onSave,
  discardChanges,
}: CredentialControlsProps & { discardChanges: ReactNode }) {
  return (
    <form
      className="settings-credential-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="settings-credential-entry">
      <input
        className="workspace-input workspace-input-mono"
        id={`provider-key-${provider.providerId}`}
        data-testid={`provider-api-key-${provider.providerId}`}
        type="password"
        aria-label="API key / token"
        autoFocus
        value={apiKey}
        onChange={(event) => setApiKey(event.target.value)}
        placeholder={credential ? "Enter a replacement key" : "Enter API key"}
        autoComplete="new-password"
        spellCheck={false}
        disabled={busy}
      />
      <div className="settings-provider-actions">
        <button
          type="submit"
          className="btn-primary"
          aria-label="Save API key"
          data-testid={`provider-credential-save-${provider.providerId}`}
          disabled={busy || !apiKey.trim()}
        >
          Save
        </button>
        {discardChanges}
      </div>
      </div>
    </form>
  );
}
