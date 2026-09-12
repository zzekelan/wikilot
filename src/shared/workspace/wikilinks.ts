import type { WorkspaceLinkSubpath } from "./link-index";

export type ParsedWikilink = {
  authoredTarget: string;
  displayText?: string;
  subpath?: WorkspaceLinkSubpath;
};

export type WikilinkToken = {
  start: number;
  end: number;
  targetStart: number;
  originalText: string;
  embed: boolean;
  parsed: ParsedWikilink;
};

export function splitWorkspaceLinkTarget(raw: string): {
  authoredTarget: string;
  subpath?: WorkspaceLinkSubpath;
} {
  const marker = raw.indexOf("#");
  if (marker < 0) return { authoredTarget: raw };
  const authoredTarget = raw.slice(0, marker);
  const fragment = raw.slice(marker + 1);
  if (/^page=\d+$/i.test(fragment)) {
    return { authoredTarget, subpath: { kind: "pdf-page", value: fragment.slice(5) } };
  }
  if (fragment.startsWith("^")) {
    return { authoredTarget, subpath: { kind: "block", value: fragment.slice(1) } };
  }
  return { authoredTarget, subpath: { kind: "heading", value: fragment } };
}

export function parseWikilink(value: string): ParsedWikilink {
  const separator = value.indexOf("|");
  const target = separator < 0 ? value : value.slice(0, separator);
  return {
    ...splitWorkspaceLinkTarget(target),
    ...(separator >= 0 ? { displayText: value.slice(separator + 1) } : {}),
  };
}

export function findWikilinks(value: string): WikilinkToken[] {
  const tokens: WikilinkToken[] = [];
  for (const match of value.matchAll(/(!)?\[\[([^\]\n]+)\]\]/g)) {
    const start = match.index;
    const embed = Boolean(match[1]);
    tokens.push({
      start,
      end: start + match[0].length,
      targetStart: start + (embed ? 3 : 2),
      originalText: match[0],
      embed,
      parsed: parseWikilink(match[2]!),
    });
  }
  return tokens;
}

export function workspaceHeadingSlug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}
