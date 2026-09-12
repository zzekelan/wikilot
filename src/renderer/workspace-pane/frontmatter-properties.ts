import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  stringify,
  type Pair,
  type Scalar,
  type YAMLMap,
} from "yaml";

import type { WorkspacePropertyType } from "../../shared/workspace";
import { inferWorkspacePropertyType } from "../../shared/workspace";

export type FrontmatterPropertyType = WorkspacePropertyType;
export type FrontmatterPropertyValue = string | number | boolean | null | Array<string | number | boolean | null>;

export type FrontmatterProperty = {
  name: string;
  type: FrontmatterPropertyType | "nested";
  value: FrontmatterPropertyValue;
  editable: boolean;
};

export type FrontmatterProperties =
  | { status: "absent"; properties: [] }
  | { status: "malformed"; properties: []; error: string }
  | { status: "ready"; properties: FrontmatterProperty[] };

type LocatedFrontmatter = {
  body: string;
  bodyStart: number;
  bodyEnd: number;
  contentStart: number;
  eol: "\n" | "\r\n";
};

type ParsedFrontmatter = LocatedFrontmatter & {
  pairs: Pair<unknown, unknown>[];
  properties: FrontmatterProperty[];
};

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}$/;

function locateFrontmatter(source: string): LocatedFrontmatter | null | "unclosed" {
  const opening = /^---(\r?\n)/.exec(source);
  if (!opening) return null;
  const eol = opening[1] as "\n" | "\r\n";
  const bodyStart = opening[0].length;
  const closing = /^---[ \t]*(?=\r?$)/gm;
  closing.lastIndex = bodyStart;
  const match = closing.exec(source);
  if (!match) return "unclosed";
  let bodyEnd = match.index;
  if (bodyEnd > bodyStart && source.slice(0, bodyEnd).endsWith(eol)) bodyEnd -= eol.length;
  const contentAfterDelimiter = match.index + match[0].length;
  const contentStart = source.startsWith(eol, contentAfterDelimiter)
    ? contentAfterDelimiter + eol.length
    : contentAfterDelimiter;
  return {
    body: source.slice(bodyStart, bodyEnd),
    bodyStart,
    bodyEnd,
    contentStart,
    eol,
  };
}

function scalarValue(node: Scalar<unknown>): string | number | boolean | null | undefined {
  const value = node.value;
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return undefined;
}

function propertyFromPair(pair: Pair<unknown, unknown>): FrontmatterProperty {
  const name = isScalar(pair.key) ? String(pair.key.value ?? "") : String(pair.key ?? "");
  const value = pair.value;
  if (isScalar(value)) {
    const scalar = scalarValue(value);
    if (scalar === undefined) {
      return { name, type: "nested", value: null, editable: false };
    }
    const inferred = inferWorkspacePropertyType(scalar);
    const type = inferred === "date" && value.type !== "PLAIN" ? "text" : inferred;
    if (!type) return { name, type: "nested", value: null, editable: false };
    return { name, type, value: scalar, editable: true };
  }
  if (isSeq(value) && value.items.every(isScalar)) {
    const items = value.items.map((item) => scalarValue(item as Scalar<unknown>));
    if (items.some((item) => item === undefined)) {
      return { name, type: "nested", value: null, editable: false };
    }
    const supportedItems = items as Array<string | number | boolean | null>;
    return {
      name,
      type: inferWorkspacePropertyType(supportedItems) ?? "nested",
      value: supportedItems,
      editable: true,
    };
  }
  return { name, type: "nested", value: null, editable: false };
}

function parseReadyFrontmatter(source: string): ParsedFrontmatter {
  const located = locateFrontmatter(source);
  if (!located || located === "unclosed") throw new Error("Frontmatter is not editable");
  const document = parseDocument(located.body, { keepSourceTokens: true, intAsBigInt: true });
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents))) {
    throw new Error("Frontmatter YAML is malformed");
  }
  const contents = document.contents as YAMLMap<unknown, unknown> | null;
  const pairs = contents?.items ?? [];
  return {
    ...located,
    pairs,
    properties: pairs.map(propertyFromPair),
  };
}

export function markdownBodyWithoutFrontmatter(source: string): string {
  const located = locateFrontmatter(source);
  return located && located !== "unclosed" ? source.slice(located.contentStart) : source;
}

export function parseFrontmatterProperties(source: string): FrontmatterProperties {
  const located = locateFrontmatter(source);
  if (!located) return { status: "absent", properties: [] };
  if (located === "unclosed") {
    return { status: "malformed", properties: [], error: "Frontmatter is not closed." };
  }
  const document = parseDocument(located.body, { keepSourceTokens: true, intAsBigInt: true });
  if (document.errors.length > 0 || (document.contents !== null && !isMap(document.contents))) {
    return { status: "malformed", properties: [], error: "Frontmatter YAML is malformed." };
  }
  const pairs = (document.contents as YAMLMap<unknown, unknown> | null)?.items ?? [];
  return { status: "ready", properties: pairs.map(propertyFromPair) };
}

function defaultValue(type: FrontmatterPropertyType): FrontmatterPropertyValue {
  switch (type) {
    case "text": return "";
    case "list": return [];
    case "number": return 0;
    case "date": return "1970-01-01";
    case "checkbox": return false;
  }
}

function convertValue(
  value: FrontmatterPropertyValue,
  type: FrontmatterPropertyType,
): FrontmatterPropertyValue {
  switch (type) {
    case "text":
      return Array.isArray(value) ? value.map((item) => item ?? "").join(", ") : String(value ?? "");
    case "list":
      if (Array.isArray(value)) return value;
      return value === null ? [] : [String(value)];
    case "number": {
      const candidate = Array.isArray(value) ? value[0] : value;
      const number = Number(candidate);
      return Number.isFinite(number) ? number : 0;
    }
    case "date":
      return typeof value === "string" && DATE_VALUE.test(value) ? value : "1970-01-01";
    case "checkbox": {
      const candidate = Array.isArray(value) ? value[0] : value;
      if (typeof candidate === "boolean") return candidate;
      if (typeof candidate === "number") return candidate !== 0;
      return typeof candidate === "string" && ["true", "1", "yes", "on"].includes(candidate.toLowerCase());
    }
  }
}

function serializeName(name: string): string {
  return stringify(name).trimEnd();
}

function serializeValue(
  value: FrontmatterPropertyValue,
  type?: FrontmatterPropertyType,
): string {
  if (type === "text" && typeof value === "string" && DATE_VALUE.test(value)) {
    return JSON.stringify(value);
  }
  return Array.isArray(value) ? JSON.stringify(value) : stringify(value).trimEnd();
}

function pairRange(parsed: ParsedFrontmatter, index: number): { start: number; end: number } {
  const pair = parsed.pairs[index];
  if (!pair || !isScalar(pair.key) || !pair.key.range) throw new Error("Property does not exist");
  const valueEnd = pair.value !== null
    && typeof pair.value === "object"
    && "range" in pair.value
    && Array.isArray(pair.value.range)
    ? pair.value.range[2]
    : undefined;
  if (typeof valueEnd !== "number") throw new Error("Property source range is unavailable");
  return { start: pair.key.range[0], end: valueEnd };
}

function replaceBodyRange(
  source: string,
  parsed: ParsedFrontmatter,
  start: number,
  end: number,
  replacement: string,
): string {
  const absoluteStart = parsed.bodyStart + start;
  const absoluteEnd = parsed.bodyStart + end;
  return source.slice(0, absoluteStart) + replacement + source.slice(absoluteEnd);
}

export function updateFrontmatterProperty(
  source: string,
  index: number,
  update: {
    name?: string;
    type?: FrontmatterPropertyType;
    value?: FrontmatterPropertyValue;
  },
): string {
  const parsed = parseReadyFrontmatter(source);
  const property = parsed.properties[index];
  if (!property) throw new Error("Property does not exist");
  const name = update.name?.trim() ?? property.name;
  if (!name) throw new Error("Property name is required");
  if (parsed.properties.some((candidate, candidateIndex) => candidateIndex !== index && candidate.name === name)) {
    throw new Error("Property name already exists");
  }
  if (!property.editable || property.type === "nested") {
    if (update.type !== undefined || update.value !== undefined) {
      throw new Error("Nested property values are read-only");
    }
    const pair = parsed.pairs[index];
    if (!pair || !isScalar(pair.key) || !pair.key.range) throw new Error("Property does not exist");
    return replaceBodyRange(source, parsed, pair.key.range[0], pair.key.range[1], serializeName(name));
  }
  const type = update.type ?? property.type;
  const value = update.value !== undefined
    ? update.value
    : update.type && update.type !== property.type
      ? convertValue(property.value, type)
      : property.value;
  const range = pairRange(parsed, index);
  const original = parsed.body.slice(range.start, range.end);
  const replacement = `${serializeName(name)}: ${serializeValue(value, type)}${original.endsWith(parsed.eol) ? parsed.eol : ""}`;
  return replaceBodyRange(source, parsed, range.start, range.end, replacement);
}

export function deleteFrontmatterProperty(source: string, index: number): string {
  const parsed = parseReadyFrontmatter(source);
  const property = parsed.properties[index];
  if (!property) throw new Error("Property does not exist");
  const range = pairRange(parsed, index);
  return replaceBodyRange(source, parsed, range.start, range.end, "");
}

export function addFrontmatterProperty(
  source: string,
  name: string,
  type: FrontmatterPropertyType,
): string {
  const normalizedName = name.trim();
  if (!normalizedName) throw new Error("Property name is required");
  const located = locateFrontmatter(source);
  const pair = `${serializeName(normalizedName)}: ${serializeValue(defaultValue(type), type)}`;
  if (!located) return `---\n${pair}\n---\n${source}`;
  const parsed = parseReadyFrontmatter(source);
  if (parsed.properties.some((property) => property.name === normalizedName)) {
    throw new Error("Property name already exists");
  }
  const prefix = parsed.body.length > 0 ? parsed.eol : "";
  const suffix = parsed.body.length === 0 ? parsed.eol : "";
  return source.slice(0, parsed.bodyEnd) + prefix + pair + suffix + source.slice(parsed.bodyEnd);
}
