import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { SessionModelDefault, UtilitySettings } from "../../shared/settings/index.ts";
export { createUtilitySettingsStore } from "./settings.ts";

/** Absence chooses the next source; an unusable selection never does. */
export function resolveUtilityModel(
  runtime: Pick<ModelRuntime, "getModel">,
  settings: UtilitySettings,
  session?: SessionModelDefault,
  defaults?: SessionModelDefault,
) {
  const selected = settings.model ?? session ?? defaults;
  if (!selected) throw new Error("Select a model in Settings before running this action.");
  const model = runtime.getModel(selected.provider, selected.model);
  if (!model) throw new Error("Utility Model is unavailable. Select an available model in Settings.");
  if (!getSupportedThinkingLevels(model).includes(selected.thinkingLevel)) {
    throw new Error("The selected Thinking Level is unavailable for this model.");
  }
  return { model, thinkingLevel: selected.thinkingLevel };
}
