import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Moon, Sun, X } from "lucide-react";
import type {
  ProviderCredential,
  ProviderSummary,
} from "../../shared/settings";
import { recordUiGesture } from "../telemetry";
import { client } from "../client";
import { useFocusReturn, useFocusTrap } from "./overlay";
import "./SettingsPanel.css";
import { ProviderSettingsSection } from "./ProviderSettingsSection";
import { useTheme } from "./theme";
import { UtilityModelSetting } from "./UtilityModelSetting";

type SettingsPanelProps = {
  open: boolean;
  onClose: () => void;
  initialSection?: SettingsSection;
};

export type SettingsSection = "general" | "utility-model" | "providers";

const SECTIONS: Array<{
  id: SettingsSection;
  label: string;
}> = [
  { id: "general", label: "General" },
  { id: "utility-model", label: "Utility Model" },
  { id: "providers", label: "Providers" },
];

/** Application appearance, Utility Model, new-Session defaults, and Providers. */
export function SettingsPanel({
  open,
  onClose,
  initialSection = "general",
}: SettingsPanelProps) {
  const { theme, setTheme } = useTheme();
  const popoverRef = useRef<HTMLElement | null>(null);
  useFocusTrap(popoverRef, open);
  useFocusReturn(open);

  useEffect(() => {
    if (!open) return;
    popoverRef.current
      ?.querySelector<HTMLElement>("button:not([disabled])")
      ?.focus();
  }, [open]);

  const [section, setSection] = useState<SettingsSection>("general");
  const [providerPageKey, setProviderPageKey] = useState(0);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [credentials, setCredentials] = useState<ProviderCredential[]>([]);
  const [wikiPromptEnabled, setWikiPromptEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [defaultsLoading, setDefaultsLoading] = useState(true);

  async function refreshProviderSurface(): Promise<void> {
    const [nextProviders, nextCredentials] = await Promise.all([
      client.listProviders(),
      client.listCredentials(),
    ]);
    setProviders(nextProviders);
    setCredentials(nextCredentials);
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDefaultsLoading(true);
    setError(null);
    void refreshProviderSurface().catch((error: unknown) => {
      if (!cancelled) setError(error instanceof Error ? error.message : String(error));
    });
    void client
      .getAppDefaults()
      .then((defaults) => {
        if (cancelled) return;
        setWikiPromptEnabled(defaults.wikiPromptEnabled);
        setDefaultsLoading(false);
      })
      .catch((error: unknown) => {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (open) setSection(initialSection);
  }, [initialSection, open]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(id);
  }, [toast]);

  async function onSaveDefaults(enabled: boolean) {
    if (busy) return;
    setBusy(true);
    setWikiPromptEnabled(enabled);
    setError(null);
    try {
      const next = await client.updateAppDefaults({
        wikiPromptEnabled: enabled,
      });
      setToast("Defaults saved for new Sessions.");
      recordUiGesture("defaults.save", {
        "wikilot.gesture": "defaults.save",
        "wikilot.wiki.enabled": next.wikiPromptEnabled ? "true" : "false",
      });
    } catch (err) {
      setWikiPromptEnabled(!enabled);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(<>
    {open ? <div className="settings-backdrop" aria-hidden="true" onClick={onClose} /> : null}
    <section
      ref={popoverRef}
      className={
        open ? "settings-popover" : "settings-popover settings-popover-closed"
      }
      role="dialog"
      aria-modal="true"
      aria-hidden={!open}
      aria-label="Settings"
    >
      <header className="settings-header">
        <h2 className="settings-title">Settings</h2>
        <button type="button" className="icon-btn" aria-label="Close Settings" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </header>
      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                section === item.id
                  ? "settings-nav-item settings-nav-item-active"
                  : "settings-nav-item"
              }
              data-testid={`settings-section-${item.id}`}
              aria-current={section === item.id ? "true" : undefined}
              disabled={busy}
              onClick={() => {
                setSection(item.id);
                if (item.id === "providers") setProviderPageKey((key) => key + 1);
                setError(null);
              }}
            >
              <span className="settings-nav-label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === "general" ? (
            <section aria-label="General settings" className="settings-preferences-section">
              <div className="settings-preferences-inner">
                <h3 className="settings-section-title">General</h3>
                <p className="settings-hint">Appearance and defaults for new Sessions.</p>
                <div className="settings-preference-row">
                  <div>
                    <span className="settings-preference-label" id="settings-theme-label">Theme</span>
                    <p className="settings-hint">Choose your preferred appearance.</p>
                  </div>
                  <div
                    className="settings-segmented"
                    role="radiogroup"
                    aria-labelledby="settings-theme-label"
                    data-testid="settings-theme"
                  >
                    {(
                      [
                        { value: "light", label: "Light", Icon: Sun },
                        { value: "dark", label: "Dark", Icon: Moon },
                      ] as const
                    ).map(({ value, label, Icon }) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={theme === value}
                        className={
                          theme === value
                            ? "settings-segment settings-segment-active"
                            : "settings-segment"
                        }
                        data-testid={`settings-theme-${value}`}
                        onClick={() => setTheme(value)}
                      >
                        <Icon size={14} aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="settings-preference-row">
                  <div>
                    <label className="settings-preference-label" htmlFor="wiki-prompt-enabled">LLM Wiki Prompt</label>
                    <p className="settings-hint" id="wiki-prompt-description">Enable wiki conventions in new Sessions. Existing Sessions keep their own setting.</p>
                  </div>
                  <input
                    id="wiki-prompt-enabled"
                    data-testid="wiki-prompt-enabled"
                    type="checkbox"
                    role="switch"
                    className="settings-switch"
                    aria-describedby="wiki-prompt-description"
                    checked={wikiPromptEnabled}
                    onChange={(event) => void onSaveDefaults(event.target.checked)}
                    disabled={busy || defaultsLoading}
                  />
                </div>
                <p className="settings-save-hint" role="status">{busy ? "Saving…" : "Preferences save automatically."}</p>
              </div>
            </section>
          ) : section === "utility-model" ? (
            <section aria-label="Utility Model settings" className="settings-preferences-section">
              <div className="settings-preferences-inner">
                <h3 className="settings-section-title">Utility Model</h3>
                <p className="settings-hint">Model and Thinking Level for Automatic Review and version messages.</p>
                {open ? <UtilityModelSetting /> : null}
                <p className="settings-save-hint">Preferences save automatically.</p>
              </div>
            </section>
          ) : (
            <ProviderSettingsSection
              key={providerPageKey}
              providers={providers}
              credentials={credentials}
              busy={busy}
              setBusy={setBusy}
              onChanged={refreshProviderSurface}
              onError={setError}
              onToast={setToast}
            />
          )}
          {error ? (
            <p
              className="settings-error"
              data-testid="settings-error"
              role="alert"
            >
              {error}
            </p>
          ) : null}
        </div>
      </div>
      {toast ? (
        <div className="settings-toast" role="status">
          <p className="settings-toast-pill" data-testid="settings-toast">
            {toast}
          </p>
        </div>
      ) : null}
    </section>
  </>, document.body);
}
