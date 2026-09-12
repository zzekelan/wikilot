/** Labels for Timeline tool activity rows (English-only for v1; i18n deferred). */

export function normalizeToolName(toolName: string): string {
  return toolName.toLowerCase().replace(/[-_\s]/g, "");
}

export function formatToolDisplayName(toolName: string): string {
  return toolName.trim().split(/[-_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/** Shorten an absolute path the neo-coworker way: anchor on src/docs/test, else last 2 segments. */
export function compactPath(path: string): string {
  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.length === 0) return path;
  const anchors = new Set(["src", "docs", "test", "tests"]);
  const anchorIndex = segments.findIndex((segment) => anchors.has(segment));
  if (anchorIndex >= 0 && segments.length - anchorIndex <= 4) {
    return segments.slice(anchorIndex).join("/");
  }
  if (segments.length <= 2) return segments.join("/");
  return segments.slice(-2).join("/");
}

function truncate(value: string, max: number): string {
  const clean = value.trim().replace(/\s+/g, " ");
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Compact primary detail (path / command / query / url) for a tool call. */
export function toolPrimaryDetail(toolName: string, args: unknown): string | undefined {
  const record = asRecord(args);
  if (!record) return undefined;
  const path = readString(record, "path");
  const command = readString(record, "command");
  const query = readString(record, "query");
  const pattern = readString(record, "pattern");
  const url = readString(record, "url");
  switch (normalizeToolName(toolName)) {
    case "read":
    case "write":
    case "edit":
      return path ? compactPath(path) : undefined;
    case "shell":
    case "bash":
      return command ? truncate(command, 60) : undefined;
    case "websearch":
    case "codesearch":
      return query;
    case "webfetch":
      return url ? truncate(url, 50) : undefined;
    case "grep":
      return pattern ?? query;
    case "glob":
      return pattern;
    default:
      return path
        ? compactPath(path)
        : (query ?? pattern ?? (url ? truncate(url, 50) : undefined) ??
          (command ? truncate(command, 60) : undefined));
  }
}
