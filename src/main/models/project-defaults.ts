import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  THINKING_LEVELS,
  type ThinkingLevel,
} from "../../shared/settings/index.ts";

export type TrustedProjectModelDefaults = {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
};

/** Read only the trusted project scope; App Defaults remain a separate layer. */
export function readTrustedProjectModelDefaults(
  cwd: string,
  agentDir: string,
): TrustedProjectModelDefaults {
  const project = SettingsManager.create(cwd, agentDir, {
    projectTrusted: true,
  }).getProjectSettings();
  const thinkingLevel = THINKING_LEVELS.find(
    (level) => level === project.defaultThinkingLevel,
  );
  return {
    ...(project.defaultProvider !== undefined
      ? { provider: project.defaultProvider }
      : {}),
    ...(project.defaultModel !== undefined ? { model: project.defaultModel } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  };
}
