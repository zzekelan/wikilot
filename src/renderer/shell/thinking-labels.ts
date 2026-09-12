import type { ThinkingLevel } from "../../shared/settings";

/**
 * Display labels for Pi thinking levels: the persisted tokens stay lowercase
 * (`high`, `xhigh`), but menus and selects present them as words.
 */
const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function thinkingLevelLabel(level: ThinkingLevel): string {
  return THINKING_LEVEL_LABELS[level];
}
