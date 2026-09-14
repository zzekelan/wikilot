/** App-owned Prompt commands; instruction bodies belong to the Session Runtime. */
export const PROMPT_COMMANDS = {
  init: {
    label: "/init",
    title: "Initialize Workspace",
    description: "Establish Workspace purpose, preferences, and schema",
  },
} as const;

export type PromptCommandId = keyof typeof PROMPT_COMMANDS;

export function matchPromptCommand(text: string): PromptCommandId | undefined {
  return (Object.keys(PROMPT_COMMANDS) as PromptCommandId[]).find((id) => {
    const { label } = PROMPT_COMMANDS[id];
    return text === label || (text.startsWith(label) && /^\s/u.test(text.slice(label.length)));
  });
}

export function promptCommandText(text: string, command: PromptCommandId): string {
  return text.slice(PROMPT_COMMANDS[command].label.length).trim();
}
