/** App-owned Prompt commands; instruction bodies belong to the Session Runtime. */
export const PROMPT_COMMANDS = {
  init: {
    label: "/init",
    title: "Initialize Workspace",
    description: "Establish Workspace purpose, preferences, and schema",
  },
} as const;

export type PromptCommandId = keyof typeof PROMPT_COMMANDS;
