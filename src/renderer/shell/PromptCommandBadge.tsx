import { Box } from "lucide-react";
import { PROMPT_COMMANDS, type PromptCommandId } from "../../shared/session";

export type PendingPrompt = string | { command: PromptCommandId };

export function PromptCommandBadge({ command }: { command: PromptCommandId }) {
  const { label, title } = PROMPT_COMMANDS[command];
  return (
    <span className="prompt-command-badge" data-testid="prompt-command-badge" title={label}>
      <Box size={18} aria-hidden="true" />
      <span>{title}</span>
    </span>
  );
}
