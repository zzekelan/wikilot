import { useEffect, useState } from "react";
import type { ModelCatalogProvider, ReviewSettings } from "../../shared/settings";
import { client } from "../client";
import { recordUiGesture } from "../telemetry";

/** Live Review Model preference; never changes any Session Model. */
export function ReviewModelSetting() {
  const [catalog, setCatalog] = useState<ModelCatalogProvider[]>([]);
  const [settings, setSettings] = useState<ReviewSettings>({ model: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([client.getModelCatalog(), client.getReviewSettings()])
      .then(([catalog, settings]) => {
        if (!cancelled) { setCatalog(catalog); setSettings(settings); setLoading(false); }
      }).catch((error: unknown) => {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, []);

  const value = settings.model ? JSON.stringify(settings.model) : "";
  const available = !settings.model || catalog.some((provider) => provider.id === settings.model?.provider &&
    provider.models.some((model) => model.id === settings.model?.model));
  async function save(value: string) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await client.updateReviewSettings({ model: value ? JSON.parse(value) : null }));
      recordUiGesture("review.settings.save", { "wikilot.gesture": "review.settings.save" });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }
  return <div className="settings-review-model">
    <div className="settings-preference-row">
      <div>
        <label className="settings-preference-label" htmlFor="review-model">Automatic Review</label>
        <p className="settings-hint" id="review-model-description">Review tool actions before execution. Known read-only tools run directly. Model changes apply to the next review.</p>
      </div>
      <select id="review-model" aria-label="Review Model" className="workspace-input settings-select"
        aria-describedby="review-model-description" value={value} disabled={loading || busy}
        onChange={(event) => void save(event.target.value)}>
        <option value="">Use Session Model</option>
        {!available ? <option value={value}>{settings.model!.provider}/{settings.model!.model} (unavailable)</option> : null}
        {catalog.map((provider) => <optgroup key={provider.id} label={provider.name}>
          {provider.models.map((model) => <option key={model.id}
            value={JSON.stringify({ provider: provider.id, model: model.id })}>{model.name}</option>)}
        </optgroup>)}
      </select>
    </div>
    {!available ? <p className="settings-hint">The selected Review Model is unavailable. Choose an available model to continue reviewed actions.</p> : null}
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
  </div>;
}
