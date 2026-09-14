import { useEffect, useState } from "react";
import type { ModelCatalogProvider, ThinkingLevel, UtilitySettings } from "../../shared/settings";
import { client } from "../client";
import { recordUiGesture } from "../telemetry";

/** One live model selection for auxiliary tasks, separate from Session Models. */
export function UtilityModelSetting() {
  const [catalog, setCatalog] = useState<ModelCatalogProvider[]>([]);
  const [settings, setSettings] = useState<UtilitySettings>({ model: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([client.getModelCatalog(), client.getUtilitySettings()])
      .then(([catalog, settings]) => {
        if (!cancelled) { setCatalog(catalog); setSettings(settings); }
      }).catch((error: unknown) => {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const selection = settings.model;
  const selected = catalog.find((provider) => provider.id === selection?.provider)?.models
    .find((model) => model.id === selection?.model);
  const value = selection ? JSON.stringify({ provider: selection.provider, model: selection.model }) : "";
  async function save(next: UtilitySettings) {
    setBusy(true); setError(null);
    try {
      setSettings(await client.updateUtilitySettings(next));
      recordUiGesture("utility.settings.save", { "wikilot.gesture": "utility.settings.save" });
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }
  function changeModel(value: string) {
    if (!value) { void save({ model: null }); return; }
    const choice = JSON.parse(value) as { provider: string; model: string };
    const model = catalog.find((provider) => provider.id === choice.provider)?.models.find((model) => model.id === choice.model);
    if (!model) return;
    const thinkingLevel = selection && model.thinkingLevels.includes(selection.thinkingLevel)
      ? selection.thinkingLevel : model.thinkingLevels.includes("off") ? "off" : model.thinkingLevels[0];
    void save({ model: { ...choice, thinkingLevel } });
  }
  return <div className="settings-utility-model">
    <div className="settings-preference-row">
      <label className="settings-preference-label" htmlFor="utility-model">Utility Model</label>
      <select id="utility-model" aria-label="Utility Model" className="workspace-input settings-select"
        value={value} disabled={loading || busy} onChange={(event) => changeModel(event.target.value)}>
        <option value="">Use Session Model</option>
        {selection && !selected ? <option value={value}>{selection.provider}/{selection.model} (unavailable)</option> : null}
        {catalog.map((provider) => <optgroup key={provider.id} label={provider.name}>
          {provider.models.map((model) => <option key={model.id}
            value={JSON.stringify({ provider: provider.id, model: model.id })}>{model.name}</option>)}
        </optgroup>)}
      </select>
    </div>
    {selection ? <div className="settings-preference-row">
      <label className="settings-preference-label" htmlFor="utility-thinking">Thinking Level</label>
      <select id="utility-thinking" aria-label="Utility Thinking Level" className="workspace-input settings-select"
        value={selection.thinkingLevel} disabled={loading || busy || !selected}
        onChange={(event) => void save({ model: { ...selection, thinkingLevel: event.target.value as ThinkingLevel } })}>
        {!selected?.thinkingLevels.includes(selection.thinkingLevel) ? <option value={selection.thinkingLevel}>{selection.thinkingLevel} (unavailable)</option> : null}
        {selected?.thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
      </select>
    </div> : null}
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
  </div>;
}
