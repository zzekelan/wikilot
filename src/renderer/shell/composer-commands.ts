import type { SessionSkill } from "../../shared/workspace";
import { PROMPT_COMMANDS, matchPromptCommand, type PromptCommandId } from "../../shared/session";

export type ComposerCommandId = "model" | "thinking" | "wiki" | "reload";

type ComposerActionCommand = {
  kind: "action";
  id: ComposerCommandId;
  label: string;
  description: string;
};

type ComposerSkillCommand = {
  kind: "skill";
  id: `skill:${string}`;
  skillName: string;
  label: string;
  description: string;
};

type ComposerPromptCommand = {
  kind: "prompt";
  id: PromptCommandId;
  label: string;
  description: string;
};

export type ComposerCommand = ComposerActionCommand | ComposerPromptCommand | ComposerSkillCommand;

export const COMPOSER_COMMANDS: readonly (ComposerActionCommand | ComposerPromptCommand)[] = [
  {
    kind: "prompt",
    id: "init",
    ...PROMPT_COMMANDS.init,
  },
  {
    kind: "action",
    id: "model",
    label: "/model",
    description: "Choose the Session Model",
  },
  {
    kind: "action",
    id: "thinking",
    label: "/thinking",
    description: "Choose the Session Thinking level",
  },
  {
    kind: "action",
    id: "wiki",
    label: "/wiki",
    description: "Toggle the Session Wiki Prompt",
  },
  {
    kind: "action",
    id: "reload",
    label: "/reload",
    description: "Reload Session resources",
  },
];

/** The command token exists only when slash is the first character. */
export function composerCommandQuery(text: string): string | null {
  if (matchPromptCommand(text) && /\s/u.test(text)) return null;
  if (/^\/skill:[^\s]+\s/u.test(text)) return null;
  const match = /^\/([^\s]*)/u.exec(text);
  return match ? match[1] ?? "" : null;
}

function isFuzzyMatch(query: string, candidate: string): boolean {
  let queryIndex = 0;
  const normalizedQuery = query.toLocaleLowerCase();
  const normalizedCandidate = candidate.toLocaleLowerCase();
  for (const character of normalizedCandidate) {
    if (character === normalizedQuery[queryIndex]) queryIndex += 1;
    if (queryIndex === normalizedQuery.length) return true;
  }
  return normalizedQuery.length === 0;
}

function skillCommand(skill: SessionSkill): ComposerSkillCommand {
  return {
    kind: "skill",
    id: `skill:${skill.name}`,
    skillName: skill.name,
    label: `/skill:${skill.name}`,
    description: skill.description,
  };
}

function commandMatchRank(query: string, command: ComposerCommand): number {
  if (isFuzzyMatch(query, command.id)) return 0;
  if (isFuzzyMatch(query, command.label)) return 1;
  return 2;
}

export function filterComposerCommands(
  query: string,
  skills: readonly SessionSkill[] = [],
): ComposerCommand[] {
  return [...COMPOSER_COMMANDS, ...skills.map(skillCommand)]
    .filter(
      (command) =>
        isFuzzyMatch(query, command.id) ||
        isFuzzyMatch(query, command.label) ||
        isFuzzyMatch(query, command.description),
    )
    .sort(
      (left, right) =>
        commandMatchRank(query, left) - commandMatchRank(query, right),
    );
}
