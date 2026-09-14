import { Box } from "lucide-react";
import { PROMPT_COMMANDS, promptCommandText, type PromptCommandId } from "../../shared/session";

export type PendingPrompt = string | { command: PromptCommandId; text: string };

export function PromptCommandBadge({ command }: { command: PromptCommandId }) {
  const { label, title } = PROMPT_COMMANDS[command];
  return (
    <span className="prompt-command-badge" data-testid="prompt-command-badge" title={label}>
      <Box size={18} aria-hidden="true" />
      <span>{title}</span>
    </span>
  );
}

export function PromptCommandBubble({ command, text }: { command: PromptCommandId; text: string }) {
  const task = promptCommandText(text, command);
  return (
    <div className="msg-user-bubble msg-user-command">
      <PromptCommandBadge command={command} />
      {task ? <span className="msg-user-text">{task}</span> : null}
    </div>
  );
}
